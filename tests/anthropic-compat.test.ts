import {expect,test} from 'bun:test';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import {dispatchModel} from '../src/model-dispatch';
import {anthropicApiModelMetadata,FABLE_5_2_ID,FABLE_5_2_EFFORTS} from '../src/anthropic-compat';

const model:any={id:FABLE_5_2_ID,provider:'configured-anthropic',api:'anthropic-messages',baseUrl:'https://api.anthropic.com',reasoning:true,input:['text','image'],contextWindow:1_000_000,maxTokens:128_000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{}};
const user:any={role:'user',content:'Synthetic request.',timestamp:1};
const tool:any={name:'get_data',description:'Synthetic offline data',parameters:{type:'object',properties:{value:{type:'number'}}}};
const context=(messages:any[]=[user],withTools=false)=>normalizeContext({systemPrompt:'Fixed operator instructions.',...(withTools?{tools:[tool]}:{}),messages});
function response(blocks:any[]=[{type:'text',text:'Synthetic answer.'}],extra:any={}){
 const events:any[]=[{type:'message_start',message:{id:'synthetic-fable-message',type:'message',role:'assistant',model:FABLE_5_2_ID,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0},...extra}}];
 blocks.forEach((block,index)=>{
  const initial=block.type==='tool_use'?{...block,input:{}}:block;events.push({type:'content_block_start',index,content_block:initial});
  if(block.type==='tool_use')events.push({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
  events.push({type:'content_block_stop',index});
 });
 events.push({type:'message_delta',delta:{stop_reason:blocks.some(block=>block.type==='tool_use')?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'});
 return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
function fixture(handler?:(body:any,index:number)=>Response){
 const requests:any[]=[],headers:Headers[]=[];
 const fetcher=(async(input:any,init:any)=>{const request=new Request(input,init),body=await request.json();requests.push(body);headers.push(request.headers);return handler?.(body,requests.length)??response()}) as typeof fetch;
 const run=(transcript:any=context(),options:any={})=>dispatchModel(model,transcript,{apiKey:'sk-ant-api03-SYNTHETIC',fetch:fetcher,maxTokens:4096,...options}).result();
 return {requests,headers,fetcher,run};
}

test('Fable metadata describes only the exact advertised API model and never invents entitlement',()=>{
 const value=anthropicApiModelMetadata(FABLE_5_2_ID)!;
 expect(value).toMatchObject({contextWindow:1_000_000,maxTokens:128_000,input:['text','image'],reasoning:true,defaultReasoningEffort:'high',compat:{forceAdaptiveThinking:true,supportsMidConvoSystemMessages:true,supportsMidConvoToolChanges:true,supportsMidConvoEffort:true}});
 expect(Object.keys(value.reasoningEfforts)).toEqual([...FABLE_5_2_EFFORTS]);expect(value.thinkingLevelMap.off).toBeNull();
 for(const id of ['claude-fable-5-2-latest','claude-fable-5-1','claude-mythos-5-2','global.anthropic.claude-fable-5-2'])expect(anthropicApiModelMetadata(id)).toBeUndefined();
 expect('available' in value).toBe(false);
});

for(const level of [...FABLE_5_2_EFFORTS,undefined])test('Fable serializes '+(level??'default high')+' effort with strict always-on adaptive thinking',async()=>{
 const f=fixture(),result=await f.run(context(),{...(level?{reasoningEffort:level}:{}),temperature:0.7,topP:0.9,top_k:10});
 expect(result.stopReason).toBe('stop');expect(f.requests).toHaveLength(1);const request=f.requests[0];
 expect(request.thinking).toMatchObject({type:'adaptive',block_binding:{prefix_mismatch_behavior:'error'}});expect(request.thinking.budget_tokens).toBeUndefined();
 expect(request.output_config.effort).toBe('high');expect(request.messages.at(-1)).toEqual({role:'system',content:[],output_config:{effort:level??'high'}});
 for(const key of ['temperature','top_p','top_k'])expect(request[key]).toBeUndefined();
 expect(f.headers[0].get('anthropic-beta')).toContain('mid-conversation-output-config-2026-07-01');expect(f.headers[0].get('anthropic-beta')).toContain('thinking-binding-controls-2026-08-01');
});

test('Fable thinking/tool round trip retains empty signed thoughts, prior effort and inline changes',async()=>{
 const returned=[{type:'thinking',thinking:'',signature:'SYNTHETIC_SIGNED_THOUGHT'},{type:'tool_use',id:'toolu_synthetic',name:'get_data',input:{value:1}}];
 const f=fixture((_body,index)=>index===1?response(returned):response()),first=await f.run(context([user],true),{reasoningEffort:'low'});
 expect(first.stopReason).toBe('toolUse');expect(first.providerThinkingLevel).toBe('low');
 const transcript=context([user,first,{role:'toolResult',toolCallId:'toolu_synthetic',toolName:'get_data',content:[{type:'text',text:'Synthetic value 2'}],isError:false,timestamp:3},
  {role:'system',content:'Operator added an offline helper.',toolsAdded:[{name:'new_helper',description:'Synthetic new tool',parameters:{type:'object',properties:{}}}],timestamp:4}],true),before=structuredClone(transcript);
 const result=await f.run(transcript,{reasoningEffort:'xhigh'});expect(result.stopReason).toBe('stop');expect(transcript).toEqual(before);
 expect(f.requests[1].messages.find((message:any)=>message.role==='assistant').content).toEqual(returned);
 expect(f.requests[1].system).toEqual(f.requests[0].system);expect(f.requests[1].tools).toEqual(f.requests[0].tools);
 expect(f.requests[1].messages.some((message:any)=>message.output_config?.effort==='low')).toBe(true);expect(f.requests[1].messages.at(-1).output_config.effort).toBe('xhigh');
 expect(f.requests[1].messages.some((message:any)=>message.role==='system'&&message.content.some((block:any)=>block.type==='tool_addition'&&block.tool.definition.name==='new_helper'))).toBe(true);
 expect(f.headers[1].get('anthropic-beta')).toContain('inline-tools-2026-09-15');
});

test('Fable rejects disabled/budget thinking, forced tools and impossible output caps before sending',()=>{
 const f=fixture();
 for(const options of [{reasoningEffort:'off'},{reasoningEffort:'minimal'},{thinkingEnabled:false},{thinkingBudgetTokens:1024},{thinking:{type:'enabled',budget_tokens:1024}},
  {toolChoice:'required'},{toolChoice:'any'},{toolChoice:'tool'},{toolChoice:{type:'function',function:{name:'get_data'}}},{maxTokens:128001},{maxTokens:0}])
  expect(()=>dispatchModel(model,context(),{apiKey:'sk-ant-api03-SYNTHETIC',fetch:f.fetcher,...options})).toThrow();
 expect(f.requests).toHaveLength(0);
});

test('Fable refuses a payload callback that rewrites history or enables silent thinking drops',async()=>{
 for(const mutate of [(body:any)=>{body.system='Rewritten prefix'},(body:any)=>{body.thinking.block_binding.prefix_mismatch_behavior='drop_block'}]){
  const f=fixture(),result=await f.run(context(),{onPayload:(body:any)=>{mutate(body);return body}});
  expect(result.stopReason).toBe('error');expect(result.httpStatus).toBe(400);expect(result.errorMessage).toContain('incompatible Fable');expect(f.requests).toHaveLength(0);
 }
});

test('Fable never synthesizes missing tool results or silently accepts assistant prefill',()=>{
 const f=fixture(),assistant:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'toolCall',id:'toolu_missing',name:'get_data',arguments:{}}],timestamp:2};
 expect(()=>dispatchModel(model,context([user,assistant]),{apiKey:'synthetic',fetch:f.fetcher})).toThrow('exact result');
 expect(()=>dispatchModel(model,context([user,{...assistant,content:[{type:'text',text:'Prefill'}]}]),{apiKey:'synthetic',fetch:f.fetcher})).toThrow('prefill');
 expect(()=>dispatchModel(model,context([user,{role:'system',content:'Added tool',toolsAdded:[tool]}]),{apiKey:'synthetic',fetch:f.fetcher})).toThrow('initial fixed tool');
 expect(f.requests).toHaveLength(0);
});

test('Fable prefix errors retain the server failure and never silently drop signed blocks or retry',async()=>{
 const f=fixture(()=>Response.json({type:'error',error:{type:'invalid_request_error',message:'The block is bound to a different conversation'}},{status:400})),result=await f.run();
 expect(result.stopReason).toBe('error');expect(result.httpStatus).toBe(400);expect(result.errorMessage).toContain('bound to a different conversation');expect(f.requests).toHaveLength(1);
});

test('Server-reported thinking transformations are explicit failures in a strict Fable session',async()=>{
 const f=fixture(()=>response(undefined,{input_transformations:[{type:'thinking_block_dropped',reason:'organization_binding_mismatch',path:'messages[1].content[0]'}]})),result=await f.run();
 expect(result.stopReason).toBe('error');expect(result.httpStatus).toBe(400);expect(result.errorMessage).toContain('instead of concealing');expect(f.requests).toHaveLength(1);
});

test('Generic manual-thinking Anthropic calls reject too-small caps and retain valid bounded budgets',async()=>{
 const f=fixture(),legacy={...model,id:'synthetic-legacy-claude',maxTokens:8192,compat:{}};
 expect(()=>dispatchModel(legacy,context(),{apiKey:'synthetic',fetch:f.fetcher,reasoningEffort:'low',maxTokens:1024})).toThrow('above 1024');expect(f.requests).toHaveLength(0);
 await dispatchModel(legacy,context(),{apiKey:'synthetic',fetch:f.fetcher,reasoningEffort:'high',maxTokens:2048}).result();
 expect(f.requests[0].max_tokens).toBe(2048);expect(f.requests[0].thinking).toMatchObject({type:'enabled',budget_tokens:1024});
});

test('Explicit generic Anthropic thinking budgets cannot exceed their output limit',()=>{
 const f=fixture(),legacy={...model,id:'synthetic-legacy-claude',maxTokens:8192,compat:{}};
 for(const budget of [1,1024,8192])expect(()=>dispatchModel(legacy,context(),{apiKey:'synthetic',fetch:f.fetcher,thinkingEnabled:true,thinkingBudgetTokens:budget,maxTokens:1024})).toThrow('thinking budget');
 expect(f.requests).toHaveLength(0);
});

test('Fable preserves opaque redacted thinking blocks exactly through a tool-result turn',async()=>{
 const returned=[{type:'redacted_thinking',data:'SYNTHETIC_OPAQUE_THOUGHT'},{type:'tool_use',id:'toolu_redacted',name:'get_data',input:{value:1}}];
 const f=fixture((_body,index)=>index===1?response(returned):response()),first=await f.run(context([user],true));
 const transcript=context([user,first,{role:'toolResult',toolCallId:'toolu_redacted',toolName:'get_data',content:[{type:'text',text:'Synthetic result'}],isError:false,timestamp:3}],true);
 expect((await f.run(transcript,{reasoningEffort:'max'})).stopReason).toBe('stop');
 expect(f.requests[1].messages.find((message:any)=>message.role==='assistant').content).toEqual(returned);
});
