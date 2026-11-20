import {afterEach,expect,test} from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Database} from 'bun:sqlite';
import {clearBridgeReplay,startBridge} from '../src/bridge';
import {anthropicApiModelMetadata,FABLE_5_2_ID} from '../src/anthropic-compat';
import {ReplayStore,zeroUsage} from '../src/protocol';

const cleanup:Array<()=>void>=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close()});
const tools=[{name:'offline_value',description:'Synthetic offline lookup',input_schema:{type:'object',properties:{index:{type:'number'}},required:['index']}}];
const calls=[{type:'tool_use',id:'toolu_fixture_a',name:'offline_value',input:{index:1}},{type:'tool_use',id:'toolu_fixture_b',name:'offline_value',input:{index:2}}];
const thought={type:'thinking',thinking:'Synthetic thought.',signature:'SYNTHETIC_COMPLETE_SIGNATURE'};
const opaque={type:'redacted_thinking',data:'SYNTHETIC_OPAQUE_THINKING'};
const firstUser={role:'user',content:[{type:'text',text:'Use the synthetic offline tool.'}]};
const results={role:'user',content:calls.map((call,index)=>({type:'tool_result',tool_use_id:call.id,content:[{type:'text',text:'Synthetic result '+(index+1)}]}))};
const stripCache=(value:any):any=>Array.isArray(value)?value.map(stripCache):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>key!=='cache_control').map(([key,item])=>[key,stripCache(item)])):value;

function response(blocks:any[],turn=1){
 const events:any[]=[{type:'message_start',message:{id:'synthetic-upstream-'+turn,type:'message',role:'assistant',model:FABLE_5_2_ID,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5+turn,output_tokens:0,cache_read_input_tokens:2,cache_creation_input_tokens:1}}}];
 blocks.forEach((block,index)=>{
  const start=block.type==='thinking'?{type:'thinking',thinking:'',signature:''}:block.type==='text'?{type:'text',text:''}:block.type==='tool_use'?{...block,input:{}}:block;
  events.push({type:'content_block_start',index,content_block:start});
  if(block.type==='thinking'){
   if(block.thinking)events.push({type:'content_block_delta',index,delta:{type:'thinking_delta',thinking:block.thinking}});
   for(const signature of [block.signature.slice(0,10),block.signature.slice(10)])events.push({type:'content_block_delta',index,delta:{type:'signature_delta',signature}});
  }else if(block.type==='text')events.push({type:'content_block_delta',index,delta:{type:'text_delta',text:block.text}});
  else if(block.type==='tool_use')events.push({type:'content_block_delta',index,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}});
  events.push({type:'content_block_stop',index});
 });
 events.push({type:'message_delta',delta:{stop_reason:blocks.some(block=>block.type==='tool_use')?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:3+turn}},{type:'message_stop'});
 return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream','x-synthetic-quota-observed':'passive-only'}});
}
function fixture(handler?:(body:any,turn:number)=>Response){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-fable-bridge-')),requests:any[]=[],observed:any[]=[],recorded:any[]=[];
 const model:any={...anthropicApiModelMetadata(FABLE_5_2_ID),id:FABLE_5_2_ID,qualifiedId:'synthetic::'+FABLE_5_2_ID,replayKey:'synthetic::'+FABLE_5_2_ID+'@credential-fixture',provider:'synthetic',api:'anthropic-messages',baseUrl:'https://api.anthropic.com',efforts:['low','medium','high','xhigh','max'],requestTimeoutMs:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
 const fetcher=(async(input:any,init:any)=>{
  const request=new Request(input,init),url=new URL(request.url);expect(url.origin).toBe('https://api.anthropic.com');expect(url.pathname).toBe('/v1/messages');
  const body=await request.json();requests.push(body);return handler?.(body,requests.length)??response(requests.length===1?[thought,...calls]:[{type:'text',text:'Synthetic completed.'}],requests.length);
 }) as typeof fetch;
 const registry:any={profileDir,config:{searchUrl:''},state:{model:model.qualifiedId},resolve:()=>model,requestAuth:async()=>({apiKey:'sk-ant-api03-SYNTHETIC',fetch:fetcher}),safeError:(error:any)=>String(error?.message??error),
  usage:{captureBinding:()=> 'synthetic-usage-binding',observeHeaders:(selected:any,headers:any,binding:any)=>observed.push({model:selected.id,headers:new Headers(headers),binding}),record:(selected:any,usage:any,id:any,binding:any)=>recorded.push({model:selected.id,usage,id,binding})}};
 const bridge=startBridge(registry,'synthetic-bridge-token'),client=new Anthropic({apiKey:'synthetic-bridge-token',baseURL:bridge.url.href,maxRetries:0});
 cleanup.push(()=>{bridge.stop(true);rmSync(profileDir,{recursive:true,force:true})});
 const body=(messages:any[],effort='low')=>({model:model.qualifiedId,max_tokens:4096,system:'Fixed synthetic operator instructions.',tools,messages,output_config:{effort}});
 const stream=async(messages:any[],effort='low')=>client.messages.stream(body(messages,effort) as any).finalMessage();
 const raw=async(extra:any={})=>fetch(new URL('v1/messages',bridge.url),{method:'POST',headers:{'x-api-key':'synthetic-bridge-token','content-type':'application/json'},body:JSON.stringify({...body([firstUser]),stream:true,...extra})});
 return {profileDir,model,requests,observed,recorded,bridge,stream,raw};
}

test('Fable native SSE saves exact signatures and ordered parallel tools for the next serialized API turn',async()=>{
 const f=fixture(),first=await f.stream([firstUser]);
 expect(first.content).toEqual([thought,...calls]);expect(first.stop_reason).toBe('tool_use');
 const saved=join(f.profileDir,'saved-native-history.json');writeFileSync(saved,JSON.stringify({role:first.role,content:first.content}),{mode:0o600});
 const history=JSON.parse(readFileSync(saved,'utf8')),second=await f.stream([firstUser,history,results],'xhigh');
 expect(second.content).toEqual([{type:'text',text:'Synthetic completed.'}]);expect(f.requests).toHaveLength(2);
 const request=f.requests[1],assistantIndex=request.messages.findIndex((message:any)=>message.role==='assistant');
 expect(request.messages[assistantIndex].content).toEqual([thought,...calls]);
 expect(stripCache(request.messages.slice(0,assistantIndex))).toEqual(stripCache(f.requests[0].messages));
 expect(request.messages[assistantIndex+1].content.filter((block:any)=>block.type==='tool_result').map((block:any)=>({id:block.tool_use_id,text:typeof block.content==='string'?block.content:block.content[0].text}))).toEqual([{id:calls[0].id,text:'Synthetic result 1'},{id:calls[1].id,text:'Synthetic result 2'}]);
 expect(request.messages.at(-1)).toMatchObject({role:'system',output_config:{effort:'xhigh'}});
 expect(request.thinking.block_binding.prefix_mismatch_behavior).toBe('error');
 expect(f.observed).toHaveLength(2);expect(f.observed.every(event=>event.headers.get('x-synthetic-quota-observed')==='passive-only'&&event.binding==='synthetic-usage-binding')).toBe(true);
 expect(f.recorded.map(event=>({input:event.usage.input,output:event.usage.output,cacheRead:event.usage.cacheRead,cacheWrite:event.usage.cacheWrite,binding:event.binding}))).toEqual([{input:6,output:4,cacheRead:2,cacheWrite:1,binding:'synthetic-usage-binding'},{input:7,output:5,cacheRead:2,cacheWrite:1,binding:'synthetic-usage-binding'}]);
 expect(new Set(f.recorded.map(event=>event.id)).size).toBe(2);
});

test('Fable bound effort metadata survives ordinary replay age and row-count retention',async()=>{
 const f=fixture(),first=await f.stream([firstUser]),saved=JSON.parse(JSON.stringify({role:first.role,content:first.content}));
 const path=join(f.profileDir,'provider/replay.db'),store=new ReplayStore(path);
 for(let index=0;index<1001;index++){
  const blocks=[{type:'text',text:'Synthetic ordinary reply '+index}],message:any={role:'assistant',api:'openai-completions',provider:'ordinary',model:'ordinary',content:blocks,usage:zeroUsage(),stopReason:'stop',timestamp:index};
  store.put(blocks,'ordinary::fixture',message);
 }
 const database=new Database(path);database.query('UPDATE replay SET created=?').run(Date.now()-8*24*60*60*1000);database.close();
 const restored=new ReplayStore(path),bound:any=restored.get(first.content,f.model.replayKey);
 expect(bound.providerThinkingLevel).toBe('low');
 const second=await f.stream([firstUser,saved,results],'xhigh');expect(second.stop_reason).toBe('end_turn');expect(f.requests).toHaveLength(2);
 const next=f.requests[1],assistantIndex=next.messages.findIndex((message:any)=>message.role==='assistant');
 expect(next.messages[assistantIndex].content).toEqual([thought,...calls]);
 expect(stripCache(next.messages.slice(0,assistantIndex))).toEqual(stripCache(f.requests[0].messages));
});

test('Fable encrypted thinking survives the actual native SSE consumer and next API request',async()=>{
 const f=fixture((_body,turn)=>response(turn===1?[opaque,...calls]:[{type:'text',text:'Synthetic completed.'}],turn));
 const first=await f.stream([firstUser]);expect(first.content).toEqual([opaque,...calls]);
 const saved=join(f.profileDir,'saved-redacted-history.json');writeFileSync(saved,JSON.stringify({role:first.role,content:first.content}),{mode:0o600});
 await f.stream([firstUser,JSON.parse(readFileSync(saved,'utf8')),results],'max');
 expect(f.requests).toHaveLength(2);expect(f.requests[1].messages.find((message:any)=>message.role==='assistant').content).toEqual([opaque,...calls]);
});

test('A real upstream Fable prefix HTTP 400 becomes the native terminal event category after one API attempt',async()=>{
 const f=fixture(()=>Response.json({type:'error',error:{type:'invalid_request_error',message:'Synthetic prefix binding mismatch'}},{status:400}));
 const result=await f.raw(),events=(await result.text()).split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6)));
 expect(result.status).toBe(200);expect(events.filter(event=>event.type==='error')).toEqual([{type:'error',error:{type:'invalid_request_error',message:expect.stringContaining('Synthetic prefix binding mismatch')}}]);
 expect(events.some(event=>event.type==='message_stop')).toBe(false);expect(f.requests).toHaveLength(1);expect(f.recorded).toHaveLength(0);
});

test('Fable placeholder history fails with HTTP 400 before invoking an API',async()=>{
 const f=fixture();clearBridgeReplay(f.bridge);
 const result=await f.raw({messages:[firstUser,{role:'assistant',content:[{type:'thinking',thinking:'',signature:'local-provider-replay'},...calls]},results]});
 expect(result.status).toBe(400);expect((await result.json() as any).error.type).toBe('invalid_request_error');expect(f.requests).toHaveLength(0);
});

test('Fable signed history without its bound replay metadata is refused before another API dispatch',async()=>{
 const f=fixture(),first=await f.stream([firstUser]),saved=JSON.parse(JSON.stringify({role:first.role,content:first.content}));
 clearBridgeReplay(f.bridge);
 const result=await f.raw({messages:[firstUser,saved,results],output_config:{effort:'max'}}),error=await result.json() as any;
 expect(result.status).toBe(400);expect(error.error.type).toBe('invalid_request_error');expect(f.requests).toHaveLength(1);
});

test('Fable native requests cannot silently turn unsupported disabled thinking into adaptive thinking',async()=>{
 const f=fixture(),result=await f.raw({thinking:{type:'disabled'}});
 if(result.status===200)await result.text();
 expect(result.status).toBe(400);expect(f.requests).toHaveLength(0);
});
