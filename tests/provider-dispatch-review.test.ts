import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync} from 'node:zlib';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import {dispatchModel} from '../src/model-dispatch';
import {anthropicProviderFetch} from '../src/provider-transport';
import {guardFetch} from '../src/network-policy';
import {Registry} from '../src/registry';
import {probeImage,IMAGE_PROBE_GLYPHS} from '../src/model-probe';
import {ANTIGRAVITY_HTTP_BASE_URL,ANTIGRAVITY_HTTP_PROVIDER_ID} from '../src/antigravity-http-models';

const cleanup:Array<()=>void>=[];afterEach(()=>{for(const close of cleanup.splice(0).reverse())close()});
const model:any={id:'synthetic-claude',qualifiedId:'configured-claude::synthetic-claude',provider:'configured-claude',providerName:'Synthetic API',api:'anthropic-messages',baseUrl:'https://api.anthropic.com',input:['text'],reasoning:true,efforts:['low','medium','high'],contextWindow:128000,maxTokens:8192,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},mode:'chat',compat:{forceAdaptiveThinking:true}};
const context=normalizeContext({messages:[{role:'user',content:'Synthetic request.',timestamp:1}]});
const usage={input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function ocr(base64:string){
 const png=Buffer.from(base64,'base64'),chunks:Buffer[]=[];
 for(let offset=8;offset<png.length;){const n=png.readUInt32BE(offset);if(png.subarray(offset+4,offset+8).toString()==='IDAT')chunks.push(png.subarray(offset+8,offset+8+n));offset+=n+12}
 const bytes=inflateSync(Buffer.concat(chunks)),stride=1+png.readUInt32BE(16)*3;
 return Array.from({length:6},(_,index)=>{
  const glyph=Array.from({length:7},(_,gy)=>Array.from({length:5},(_,gx)=>bytes[(12+gy*6)*stride+1+(12+index*36+gx*6)*3]===0?'1':'0').join('')).join('');
  const digit=Object.keys(IMAGE_PROBE_GLYPHS).find(key=>IMAGE_PROBE_GLYPHS[key].join('')===glyph);if(!digit)throw Error('Synthetic PNG did not decode');return digit;
 }).join('');
}
function anthropicResponse(answer:string){
 const events=[{type:'message_start',message:{id:'synthetic-message',type:'message',role:'assistant',model:'synthetic-claude',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:answer}},{type:'content_block_stop',index:0},
  {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}},{type:'message_stop'}];
 return new Response(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}

test('Scoped Anthropic sender cannot unlock telemetry, other paths, origins or redirect following',async()=>{
 const calls:any[]=[],raw=(async(input:any,init:any)=>{calls.push({input,init});return Response.json({ok:true})}) as typeof fetch;
 const ordinary=guardFetch(raw),inference=anthropicProviderFetch('https://api.anthropic.com/proxy',raw);
 await expect(ordinary('https://api.anthropic.com/v1/messages')).rejects.toThrow('blocked');
 for(const url of ['https://api.anthropic.com/proxyx/v1/messages','https://api.anthropic.com/proxy/v1/messages/feedback','https://api.anthropic.com/proxy/api/event_logging/v2/batch','https://claude.ai/proxy/v1/messages','https://example.org/proxy/v1/messages'])await expect(inference(url)).rejects.toThrow('left its configured');
 expect(calls).toHaveLength(0);
 await inference('https://api.anthropic.com/proxy/v1/messages',{method:'POST',redirect:'follow',body:'synthetic'});
 expect(calls).toHaveLength(1);expect(calls[0].init.redirect).toBe('error');
});

test('Only the Anthropic API protocol may register the vendor inference host',()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-vendor-review-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const config=(baseUrl:string,api:string)=>({providers:{configured:{name:'Synthetic',baseUrl,api,models:[{id:'fixture'}]}},defaultModel:'configured::fixture'});
 expect(()=>new Registry(config('https://api.anthropic.com','anthropic-messages'),dir)).not.toThrow();
 for(const [host,api]of [['https://api.anthropic.com','openai-completions'],['https://claude.ai','anthropic-messages']]){
  expect(()=>new Registry(config(host,api),dir)).toThrow('vendor product');
 }
});

test('Anthropic dispatch translates the selected reasoning effort into actual Anthropic thinking options',async()=>{
 const captured:any[]=[];
 const fetchStub=(async(input:any,init:any)=>{captured.push(await new Request(input,init).json());return new Response('{"type":"error","error":{"type":"invalid_request_error","message":"Synthetic request capture only"}}',{status:400,headers:{'content-type':'application/json'}})}) as typeof fetch;
 await dispatchModel(model,context,{apiKey:'sk-ant-api03-SYNTHETIC',reasoningEffort:'high',maxTokens:4096,fetch:fetchStub}).result();
 expect(captured).toHaveLength(1);expect(captured[0].thinking?.type).toBe('adaptive');expect(captured[0].output_config?.effort).toBe('high');
});

test('Anthropic image probing uses the real adapter and reads only the serialized synthetic image',async()=>{
 let calls=0;
 const fetchStub=(async(input:any,init:any)=>{
  calls++;const request=new Request(input,init),body:any=await request.json();expect(new URL(request.url).pathname).toBe('/v1/messages');expect(request.headers.get('x-api-key')).toBe('sk-ant-api03-SYNTHETIC');
  const content=body.messages[0].content,image=content.find((block:any)=>block.type==='image');expect(image.source.media_type).toBe('image/png');
  expect(content.filter((b:any)=>b.type==='text').map((b:any)=>b.text).join(' ')).not.toMatch(/\d{6}/);
  return anthropicResponse(ocr(image.source.data));
 }) as typeof fetch;
 const evidence=await probeImage({...model,reasoning:false},{apiKey:'sk-ant-api03-SYNTHETIC',fetch:fetchStub},new AbortController().signal,String);
 expect(evidence.status).toBe('supported');expect(calls).toBe(1);
});

test('An Anthropic budget-thinking image probe never sends a thinking budget larger than its output cap',async()=>{
 const captured:any[]=[];
 const fetchStub=(async(input:any,init:any)=>{
  const body:any=await new Request(input,init).json();captured.push(body);
  if(body.thinking?.type==='enabled'&&(body.thinking.budget_tokens<1024||body.thinking.budget_tokens>=body.max_tokens))return Response.json({type:'error',error:{type:'invalid_request_error',message:'Synthetic validation: thinking budget must be at least 1024 and smaller than max_tokens'}},{status:400});
  const image=body.messages[0].content.find((block:any)=>block.type==='image');return anthropicResponse(ocr(image.source.data));
 }) as typeof fetch;
 const evidence=await probeImage({...model,compat:{}},{apiKey:'sk-ant-api03-SYNTHETIC',fetch:fetchStub},new AbortController().signal,String);
 expect(evidence.status).toBe('supported');expect(captured).toHaveLength(1);
 if(captured[0].thinking?.type==='enabled')expect(captured[0].thinking.budget_tokens).toBeLessThan(captured[0].max_tokens);
});

test('Google image probing uses the managed driver rather than an OpenAI adapter',async()=>{
 let calls=0;
 const driver={stream(target:any,transcript:any,options:any){
  calls++;expect(target.api).toBe('antigravity-http');expect(options.reasoningEffort).toBe('low');
  const blocks=transcript.messages.find((message:any)=>message.role==='user').content,image=blocks.find((block:any)=>block.type==='image');expect(image.mimeType).toBe('image/png');
  const events=new AssistantMessageEventStream(),message:any={role:'assistant',api:target.api,provider:target.provider,model:target.id,content:[{type:'text',text:ocr(image.data)}],usage,stopReason:'stop',timestamp:1};
  queueMicrotask(()=>{events.push({type:'done',reason:'stop',message});events.end(message)});return events;
 }};
 const evidence=await probeImage({...model,api:'antigravity-http',provider:'antigravity-http',id:'gemini-synthetic'},{apiKey:'SYNTHETIC'},new AbortController().signal,String,{antigravityHttp:driver});
 expect(evidence.status).toBe('supported');expect(calls).toBe(1);
});

test('Google account/session changes invalidate persisted image probe evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-agy-probe-review-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 let session='synthetic-account-session-a',access='synthetic-access-a';
 const registry=new Registry({providers:{[ANTIGRAVITY_HTTP_PROVIDER_ID]:{name:'Synthetic Google',api:'antigravity-http',baseUrl:ANTIGRAVITY_HTTP_BASE_URL}},defaultModel:ANTIGRAVITY_HTTP_PROVIDER_ID+'::synthetic'},dir);
 registry.antigravityHttp={catalog:()=>[{id:'synthetic',name:'Synthetic',input:['text'],reasoningEfforts:{low:'low'}}],available:()=>true,project:()=> 'synthetic-project',auth:{vault:{read:()=>({session,credential:{access}})}}} as any;
 await registry.refresh(false);const qualifiedId=ANTIGRAVITY_HTTP_PROVIDER_ID+'::synthetic',target=registry.resolve(qualifiedId),first=registry.probeFingerprint(target);
 registry.recordImageProbe(qualifiedId,first,{status:'supported',testedAt:1,detail:'Synthetic proof',probeVersion:'image-v1'});expect(registry.resolve(qualifiedId).imageProbe?.status).toBe('supported');
 access='synthetic-refreshed-access';expect(registry.probeFingerprint(registry.resolve(qualifiedId))).toBe(first);
 session='synthetic-account-session-b';registry.revalidateImageProbes();
 expect(registry.probeFingerprint(registry.resolve(qualifiedId))).not.toBe(first);expect(registry.resolve(qualifiedId).imageProbe).toBeUndefined();expect(registry.resolve(qualifiedId).input).toEqual(['text']);
});
