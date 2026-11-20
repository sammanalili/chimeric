import {test,expect} from 'bun:test';
import {stream as streamAntigravityHttp,ANTIGRAVITY_HTTP_USER_AGENT} from '../src/antigravity-http-provider';

const BASE='https://daily-cloudcode-pa.googleapis.com';
const model:any={id:'gemini-4-argon-medium',name:'Gemini 4 Argon (Medium)',api:'antigravity-http',provider:'antigravity-http',baseUrl:BASE,input:['text','image'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},reasoning:true,contextWindow:1000000,maxTokens:65536};
const context=(messages:any[])=>({messages} as any);
const usage0={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function sse(frames:any[]){return frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')}
function frame(parts:any[],finishReason?:string,usageMetadata?:any){
 return {response:{candidates:[{content:{role:'model',parts},...finishReason?{finishReason}:{}}],...usageMetadata?{usageMetadata}:{}}};
}
function sseResponse(frames:any[]){return new Response(sse(frames),{status:200,headers:{'content-type':'text/event-stream'}})};
function fixture(response:Response){
 const seen:any[]=[];
 const fetch=async (url:any,init:any)=>{seen.push({url:String(url),init});return response};
 return {seen,fetch};
}
async function collect(events:any){const list:any[]=[];for await(const event of events)list.push(event);return list}
const turn=(content:any)=>[{role:'user',content,timestamp:1}];

test('text fragments concatenate into one text block and final done text',async()=>{
 const f=fixture(sseResponse([frame([{text:'The temperature is 1'}]),frame([{text:'8'},{text:'°C.'}],'STOP',{promptTokenCount:5,candidatesTokenCount:3,thoughtsTokenCount:2,totalTokenCount:8})]));
 const events=streamAntigravityHttp(model,context(turn('What is the weather?')),{apiKey:'ya29.test',fetch:f.fetch});
 const list=await collect(events),final=await events.result();
 expect(list.map(event=>event.type)).toEqual(['start','text_start','text_delta','text_delta','text_delta','text_end','done']);
 expect(list.filter(event=>event.type==='text_delta').map(event=>event.delta)).toEqual(['The temperature is 1','8','°C.']);
 expect(final.stopReason).toBe('stop');
 expect(final.content).toEqual([{type:'text',text:'The temperature is 18°C.'}]);
 expect(final.usage).toMatchObject({input:5,output:3,reasoning:2,totalTokens:8,cacheRead:0,cacheWrite:0});
});

test('thinking parts produce thinking events and stay out of the answer text',async()=>{
 const f=fixture(sseResponse([frame([{text:'Thinking about it',thought:true}]),frame([{thoughtSignature:'THINK_SIG'}]),frame([{text:'Answer'}],'STOP')]));
 const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:f.fetch});
 const list=await collect(events),final=await events.result();
 expect(list.map(event=>event.type)).toEqual(['start','thinking_start','thinking_delta','text_start','text_delta','thinking_end','text_end','done']);
 expect(list.filter(event=>event.type==='text_delta').map(event=>event.delta)).toEqual(['Answer']);
 expect(list.find(event=>event.type==='thinking_delta').delta).toBe('Thinking about it');
 expect(final.content).toEqual([{type:'thinking',thinking:'Thinking about it',thinkingSignature:'THINK_SIG'},{type:'text',text:'Answer'}]);
});

test('functionCall yields a complete toolcall_end and stopReason toolUse',async()=>{
 const f=fixture(sseResponse([frame([{thoughtSignature:'TOOL_SIG',functionCall:{name:'get_weather',args:{city:'Tokyo'},id:'call_1'}}],'STOP')]));
 const events=streamAntigravityHttp(model,context(turn('What is the weather in Tokyo? Use the tool.')),{apiKey:'ya29.test',fetch:f.fetch});
 const list=await collect(events),final=await events.result();
 expect(list.map(event=>event.type)).toEqual(['start','toolcall_start','toolcall_delta','toolcall_end','done']);
 const end=list.find(event=>event.type==='toolcall_end');
 expect(end.toolCall).toMatchObject({type:'toolCall',id:'call_1',name:'get_weather',arguments:{city:'Tokyo'},thoughtSignature:'TOOL_SIG'});
 expect(JSON.parse(list.find(event=>event.type==='toolcall_delta').delta)).toEqual({city:'Tokyo'});
 expect(final.stopReason).toBe('toolUse');
 expect(final.content).toEqual([{type:'toolCall',id:'call_1',name:'get_weather',arguments:{city:'Tokyo'},thoughtSignature:'TOOL_SIG'}]);
 expect(list[list.length-1].reason).toBe('toolUse');
});

test('request envelope carries system, image, replayed thinking/toolCall, toolResult, tools and tool choice',async()=>{
 const messages:any[]=[
  {role:'system',content:'You are terse.',timestamp:1,toolsAdded:[{name:'get_weather',description:'Weather by city',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}]},
  {role:'user',content:[{type:'text',text:'What is the weather?'},{type:'image',data:'aGVsbG8=',mimeType:'image/png'}],timestamp:2},
  {role:'assistant',content:[{type:'thinking',thinking:'Need the tool',thinkingSignature:'THINK_SIG'},{type:'text',text:'Checking.'},{type:'toolCall',id:'call_1',name:'get_weather',arguments:{city:'Tokyo'},thoughtSignature:'TOOL_SIG'}],api:'antigravity-http',provider:'antigravity-http',model:'gemini-4-argon-medium',usage:usage0,stopReason:'toolUse',timestamp:3},
  {role:'toolResult',toolCallId:'call_1',toolName:'get_weather',content:[{type:'text',text:'18C'}],isError:false,timestamp:4},
  {role:'toolResult',toolCallId:'call_2',toolName:'get_weather',content:[{type:'text',text:'denied'}],isError:true,timestamp:5},
 ];
 const f=fixture(sseResponse([frame([{text:'ok'}],'STOP')]));
 const events=streamAntigravityHttp(model,context(messages),{apiKey:'ya29.test',fetch:f.fetch,project:'my-project',toolChoice:'required',maxTokens:512,temperature:0.2,reasoningEffort:'high'});
 await collect(events);await events.result();
 expect(f.seen).toHaveLength(1);
 const {url,init}=f.seen[0];
 expect(url).toBe(BASE+'/v1internal:streamGenerateContent?alt=sse');
 expect(init.method).toBe('POST');
 expect(init.redirect).toBe('error');
 expect(init.headers.authorization).toBe('Bearer ya29.test');
 expect(init.headers.accept).toBe('text/event-stream');
 expect(init.headers['user-agent']).toBe(ANTIGRAVITY_HTTP_USER_AGENT);
 const body=JSON.parse(init.body);
 expect(body.model).toBe('gemini-4-argon-medium');
 expect(body.project).toBe('my-project');
 expect(body.request.systemInstruction).toEqual({parts:[{text:'You are terse.'}]});
 expect(body.request.contents[0]).toEqual({role:'user',parts:[{text:'What is the weather?'},{inlineData:{mimeType:'image/png',data:'aGVsbG8='}}]});
 expect(body.request.contents[1]).toEqual({role:'model',parts:[{text:'Need the tool',thought:true,thoughtSignature:'THINK_SIG'},{text:'Checking.'},{functionCall:{name:'get_weather',args:{city:'Tokyo'},id:'call_1'},thoughtSignature:'TOOL_SIG'}]});
 expect(body.request.contents[2]).toEqual({role:'user',parts:[{functionResponse:{name:'get_weather',id:'call_1',response:{result:'18C'}}},{functionResponse:{name:'get_weather',id:'call_2',response:{error:'denied'}}}]});
 expect(body.request.tools).toEqual([{functionDeclarations:[{name:'get_weather',description:'Weather by city',parameters:{type:'object',properties:{city:{type:'string'}},required:['city']}}]}]);
 expect(body.request.toolConfig).toEqual({functionCallingConfig:{mode:'ANY'}});
 // Live probes showed thinkingConfig suppresses thoughtsTokenCount and never streams
 // thought parts, so effort selects the model id and no thinkingConfig is sent.
 expect(body.request.generationConfig).toEqual({maxOutputTokens:512,temperature:0.2});
 expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
 expect(body.request.generationConfig.thinkingConfig).toBeUndefined();
});

test('an explicit thinkingBudget is the only path that sends thinkingConfig',async()=>{
 const f=fixture(sseResponse([frame([{text:'ok'}],'STOP')]));
 const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:f.fetch,thinkingBudget:4096});
 await collect(events);await events.result();
 const body=JSON.parse(f.seen[0].init.body);
 expect(body.request.generationConfig).toEqual({thinkingConfig:{thinkingBudget:4096,includeThoughts:true}});
});

test('tool-result images retain their exact bytes beside the matching function response',async()=>{
 const image={type:'image',mimeType:'image/png',data:'c3ludGhldGljLWltYWdl'};
 const messages:any[]=[
  ...turn('Inspect the returned image.'),
  {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'toolCall',id:'image-call',name:'read_image',arguments:{}}],usage:usage0,stopReason:'toolUse',timestamp:2},
  {role:'toolResult',toolCallId:'image-call',toolName:'read_image',content:[{type:'text',text:'Image from the tool.'},image],isError:false,timestamp:3},
 ];
 const f=fixture(sseResponse([frame([{text:'Inspected.'}],'STOP')]));
 const events=streamAntigravityHttp(model,context(messages),{apiKey:'ya29.test',fetch:f.fetch});
 expect((await events.result()).stopReason).toBe('stop');
 expect(JSON.parse(f.seen[0].init.body).request.contents.at(-1)).toEqual({role:'user',parts:[
  {functionResponse:{name:'read_image',id:'image-call',response:{result:'Image from the tool.'}}},
  {inlineData:{mimeType:image.mimeType,data:image.data}},
 ]});
});

test('streams reasoning usage from thoughtsTokenCount when the server reports it',async()=>{
 const frameWithThoughts=(parts:any[],finishReason?:string,thoughts?:number)=>({response:{candidates:[{content:{role:'model',parts},...(finishReason?{finishReason}:{})}],usageMetadata:{promptTokenCount:10,candidatesTokenCount:2,totalTokenCount:12,...(thoughts!==undefined?{thoughtsTokenCount:thoughts}:{})}}});
 const f=fixture(sseResponse([frameWithThoughts([{text:'ok'}],'STOP',56)]));
 const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:f.fetch});
 const done=await events.result();
 expect(done.stopReason).toBe('stop');
 expect(done.usage.input).toBe(10);
 expect(done.usage.output).toBe(2);
 expect((done.usage as any).reasoning).toBe(56);
});

test('a 200 version-gate response becomes an error instead of an answer',async()=>{
 const gate='This version of Antigravity is no longer supported. Please download and install the latest version at https://antigravity.google/download';
 const streamed=fixture(sseResponse([frame([{text:gate}])]));
 const first=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:streamed.fetch});
 expect((await first.result()).stopReason).toBe('error');
 expect((await first.result()).errorMessage).toContain('This version of Antigravity is no longer supported');
 const plain=fixture(new Response(gate,{status:200,headers:{'content-type':'text/plain; charset=utf-8'}}));
 const second=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:plain.fetch});
 const final=await second.result();
 expect(final.stopReason).toBe('error');
 expect(final.errorMessage).toContain('This version of Antigravity is no longer supported');
});

test('429 is never retried, names the wait, and refuses to switch accounts',async()=>{
 let calls=0;
 const fetchStub=(async()=>{calls++;return new Response('{"error":"quota"}',{status:429,headers:{'content-type':'application/json','retry-after':'37'}})}) as unknown as typeof fetch;
 const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.secret',fetch:fetchStub});
 const result=await events.result();
 expect(result.stopReason).toBe('error');
 expect(calls).toBe(1);
 expect(result.errorMessage).toContain('Stop and wait');
 expect(result.errorMessage).toContain('37 seconds');
 expect(result.errorMessage).not.toContain('ya29.secret');
});

test('401 and 403 produce stop-and-reconnect guidance instead of a retry',async()=>{
 for(const [status,expected] of [[401,'Sign in again'],[403,'official client']] as const){
  let calls=0;
  const fetchStub=(async()=>{calls++;return new Response('{}',{status,headers:{'content-type':'application/json'}})}) as unknown as typeof fetch;
  const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.secret',fetch:fetchStub});
  const result=await events.result();
  expect(calls).toBe(1);
  expect(result.stopReason).toBe('error');
  expect(result.errorMessage).toContain(expected);
 }
});

test('429 maps to quota wording and never leaks the apiKey',async()=>{
 const f=fixture(new Response(JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',message:'Resource has been exhausted'}}),{status:429,headers:{'content-type':'application/json'}}));
 const events=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'super-secret-token',fetch:f.fetch});
 const final=await events.result();
 expect(final.stopReason).toBe('error');
 expect(final.errorMessage).toContain('quota');
 expect(final.errorMessage).toContain('429');
 expect(final.errorMessage).toContain('Resource has been exhausted');
 expect(final.errorMessage).not.toContain('super-secret-token');
 const missing=fixture(new Response('Requested entity was not found.',{status:404,headers:{'content-type':'text/plain'}}));
 const notFound=streamAntigravityHttp(model,context(turn('hi')),{apiKey:'ya29.test',fetch:missing.fetch});
 const notFoundFinal=await notFound.result();
 expect(notFoundFinal.stopReason).toBe('error');
 expect(notFoundFinal.errorMessage).toContain('effort suffix');
});

test('streamed service errors and blocked prompts never become empty successful answers',async()=>{
 for(const response of [
  {error:{code:429,message:'Quota unavailable for ya29.synthetic-secret'}},
  {response:{error:{code:503,message:'Backend unavailable'}}},
  {response:{promptFeedback:{blockReason:'SAFETY'}}},
  {response:{candidates:[{finishReason:'SAFETY'}]}},
 ]){
  const f=fixture(sseResponse([response]));
  const events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'ya29.synthetic-secret',fetch:f.fetch});
  const list=await collect(events),final=await events.result();
  expect(final.stopReason).toBe('error');
  expect(final.errorMessage).toBeTruthy();
  expect(final.errorMessage).not.toContain('ya29.synthetic-secret');
  expect(list.some(event=>event.type==='done')).toBe(false);
  expect(f.seen).toHaveLength(1);
 }
});

test('empty or interrupted streams fail rather than committing a complete answer',async()=>{
 for(const frames of [[],[frame([{text:'Partial answer'}])],[frame([],'STOP')]]){
  const f=fixture(sseResponse(frames));
  const events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'ya29.test',fetch:f.fetch});
  const list=await collect(events),final=await events.result();
  expect(final.stopReason).toBe('error');
  expect(list.some(event=>event.type==='done')).toBe(false);
 }
});

test('MAX_TOKENS remains a completed length-limited answer',async()=>{
 const f=fixture(sseResponse([frame([{text:'Partial but valid'}],'MAX_TOKENS')]));
 const events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'ya29.test',fetch:f.fetch});
 expect((await events.result()).stopReason).toBe('length');
});

test('a service error cancels the remaining response stream without retrying',async()=>{
 let cancelled=false;
 const body=new ReadableStream({
  start(controller){controller.enqueue(new TextEncoder().encode(sse([{error:{code:503,message:'Synthetic unavailable'}}])))},
  cancel(){cancelled=true},
 });
 const f=fixture(new Response(body,{headers:{'content-type':'text/event-stream'}}));
 const events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'ya29.test',fetch:f.fetch});
 expect((await events.result()).stopReason).toBe('error');
 expect(cancelled).toBe(true);
 expect(f.seen).toHaveLength(1);
});

test('a version rejection split across text chunks remains an error',async()=>{
 const f=fixture(sseResponse([frame([{text:'This version of Antigravity is '}]),frame([{text:'no longer supported. Update the official client.'}],'STOP')]));
 const events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'ya29.test',fetch:f.fetch});
 const result=await events.result();
 expect(result.stopReason).toBe('error');
 expect(result.errorMessage).toContain('This version of Antigravity is no longer supported');
 expect(f.seen).toHaveLength(1);
});

for(const source of ['http-error','streamed-error','non-sse','blocked-prompt','finish-reason'] as const)test(source+' redacts credentials before truncating provider diagnostics',async()=>{
 const apiKey='SYNTHETIC_BOUNDARY_CREDENTIAL_abcdefghijklmnopqrstuvwxyz';
 const limit=source==='blocked-prompt'||source==='finish-reason'?100:2000;
 const body='.'.repeat(limit-12)+apiKey+' trailing provider detail';
 const response=source==='http-error'?new Response(body,{status:503}):
  source==='non-sse'?new Response(body,{headers:{'content-type':'text/plain'}}):
  sseResponse([source==='streamed-error'?{error:{code:503,message:body}}:
   source==='blocked-prompt'?{response:{promptFeedback:{blockReason:body}}}:
   {response:{candidates:[{finishReason:body}]}}]);
 const f=fixture(response);
 const events=streamAntigravityHttp(model,context(turn('Synthetic diagnostic request')),{apiKey,fetch:f.fetch});
 const result=await events.result();
 expect(result.stopReason).toBe('error');
 expect(result.errorMessage).not.toContain(apiKey.slice(0,12));
 expect(result.errorMessage).toContain('[redacted]');
 expect(result.errorMessage!.length).toBeLessThan(limit+300);
 expect(f.seen).toHaveLength(1);
});

test('same-model signed parallel tool calls retain their exact signatures and unsigned parallel siblings',async()=>{
 const messages:any[]=[...turn('Synthetic parallel calls'),{
  role:'assistant',api:model.api,provider:model.provider,model:model.id,usage:usage0,stopReason:'toolUse',timestamp:2,
  content:[{type:'toolCall',id:'first',name:'first_tool',arguments:{},thoughtSignature:'U1lOVEhFVElDX1NJR05BVFVSRQ=='},{type:'toolCall',id:'second',name:'second_tool',arguments:{}}],
 }];
 const f=fixture(sseResponse([frame([{text:'OK'}],'STOP')]));
 await streamAntigravityHttp(model,context(messages),{apiKey:'synthetic',fetch:f.fetch}).result();
 expect(JSON.parse(f.seen[0].init.body).request.contents[1].parts).toEqual([
  {functionCall:{name:'first_tool',args:{},id:'first'},thoughtSignature:'U1lOVEhFVElDX1NJR05BVFVSRQ=='},
  {functionCall:{name:'second_tool',args:{},id:'second'}},
 ]);
});

test('Gemini migration markers apply to imported calls without reusing another model private signatures',async()=>{
 const history:any={role:'assistant',api:'other-api',provider:'other-provider',model:'other-model',usage:usage0,stopReason:'toolUse',timestamp:2,content:[
  {type:'thinking',thinking:'Foreign private reasoning',thinkingSignature:'FOREIGN_THOUGHT'},
  {type:'toolCall',id:'foreign-call',name:'synthetic_tool',arguments:{},thoughtSignature:'FOREIGN_SIGNATURE'},
 ]};
 const before=structuredClone(history);
 for(const target of [model,{...model,id:'claude-sonnet-4-6'}]){
  const f=fixture(sseResponse([frame([{text:'OK'}],'STOP')]));
  await streamAntigravityHttp(target,context([...turn('Synthetic migrated history'),history]),{apiKey:'synthetic',fetch:f.fetch}).result();
  const parts=JSON.parse(f.seen[0].init.body).request.contents[1].parts;
  expect(parts).toEqual([{functionCall:{name:'synthetic_tool',args:{},id:'foreign-call'},...(target.id.startsWith('gemini-')?{thoughtSignature:'skip_thought_signature_validator'}:{})}]);
 }
 expect(history).toEqual(before);
});

test('empty legacy signatures receive a migration marker on the first parallel call only',async()=>{
 const message:any={role:'assistant',api:model.api,provider:model.provider,model:model.id,usage:usage0,stopReason:'toolUse',timestamp:2,content:[
  {type:'toolCall',id:'legacy-first',name:'first_tool',arguments:{},thoughtSignature:''},
  {type:'toolCall',id:'legacy-second',name:'second_tool',arguments:{}},
 ]};
 const f=fixture(sseResponse([frame([{text:'OK'}],'STOP')]));
 await streamAntigravityHttp(model,context([...turn('Synthetic legacy history'),message]),{apiKey:'synthetic',fetch:f.fetch}).result();
 const parts=JSON.parse(f.seen[0].init.body).request.contents[1].parts;
 expect(parts.map((part:any)=>part.thoughtSignature)).toEqual(['skip_thought_signature_validator',undefined]);
});

test('HTTP and structured stream failures preserve a serializable HTTP status for native retry classification',async()=>{
 for(const [status,streamed] of [[400,false],[400,true],[503,false],[429,true]] as const){
  const message='Synthetic request rejected for SYNTHETIC_STATUS_SECRET';
  const response=streamed?sseResponse([{error:{code:status,message}}]):new Response(message,{status});
  const f=fixture(response),events=streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'SYNTHETIC_STATUS_SECRET',fetch:f.fetch});
  const list=await collect(events),result:any=await events.result();
  expect(result.stopReason).toBe('error');
  expect(result.httpStatus).toBe(status);
  expect(JSON.parse(JSON.stringify(list.at(-1).error)).httpStatus).toBe(status);
  expect(result.errorMessage).not.toContain('SYNTHETIC_STATUS_SECRET');
  expect(f.seen).toHaveLength(1);
 }
 const f=fixture(sseResponse([{response:{promptFeedback:{blockReason:'SAFETY'}}}]));
 expect((await streamAntigravityHttp(model,context(turn('Synthetic request')),{apiKey:'synthetic',fetch:f.fetch}).result() as any).httpStatus).toBeUndefined();
});

for(const location of ['inline','signature-only'] as const)test(location+' text signature survives a complete two-turn round trip',async()=>{
 const signature='U1lOVEhFVElDX1RFWFRfU0lHTkFUVVJF';
 const frames=location==='inline'?[frame([{text:'Signed answer',thoughtSignature:signature}],'STOP')]:[
  frame([{text:'Signed answer'}]),frame([{text:'',thoughtSignature:signature}],'STOP'),
 ];
 const requests:any[]=[];
 const fetchStub=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return sseResponse(requests.length===1?frames:[frame([{text:'Continued'}],'STOP')])}) as typeof fetch;
 const first=await streamAntigravityHttp(model,context(turn('Synthetic first turn')),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(first.stopReason).toBe('stop');
 expect(first.content).toEqual([{type:'text',text:'Signed answer',textSignature:signature}]);
 const continued=await streamAntigravityHttp(model,context([...turn('Synthetic first turn'),first,{role:'user',content:'Continue',timestamp:3}]),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(continued.stopReason).toBe('stop');
 expect(requests[1].request.contents[1]).toEqual({role:'model',parts:[{text:'Signed answer',thoughtSignature:signature}]});
});

for(const type of ['text','thinking'] as const)test('separate signed '+type+' parts keep their original boundaries during replay',async()=>{
 const firstPart={text:'First signed part',...type==='thinking'?{thought:true}:{},thoughtSignature:'U0lHTkFUVVJFX09ORQ=='};
 const secondPart={text:'Second signed part',...type==='thinking'?{thought:true}:{},thoughtSignature:'U0lHTkFUVVJFX1RXTw=='};
 const parts=[firstPart,secondPart,...type==='thinking'?[{text:'Visible answer'}]:[]];
 const requests:any[]=[];
 const fetchStub=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return sseResponse(requests.length===1?[frame([firstPart]),frame(parts.slice(1),'STOP')]:[frame([{text:'Continued'}],'STOP')])}) as typeof fetch;
 const first=await streamAntigravityHttp(model,context(turn('Synthetic signed parts')),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(first.stopReason).toBe('stop');
 expect(first.content.filter(block=>block.type===type)).toHaveLength(2);
 await streamAntigravityHttp(model,context([...turn('Synthetic signed parts'),first,{role:'user',content:'Continue',timestamp:3}]),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(requests[1].request.contents[1].parts).toEqual(parts);
});

test('an initial empty signed text part remains present before the visible answer on replay',async()=>{
 const signature='RU1QVFlfVEVYVF9TSUdOQVRVUkU=';
 const requests:any[]=[];
 const fetchStub=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return sseResponse(requests.length===1?[frame([{text:'',thoughtSignature:signature}]),frame([{text:'Visible answer'}],'STOP')]:[frame([{text:'Continued'}],'STOP')])}) as typeof fetch;
 const first=await streamAntigravityHttp(model,context(turn('Synthetic empty signed part')),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(first.content).toEqual([{type:'text',text:'',textSignature:signature},{type:'text',text:'Visible answer'}]);
 await streamAntigravityHttp(model,context([...turn('Synthetic empty signed part'),first,{role:'user',content:'Continue',timestamp:3}]),{apiKey:'synthetic',fetch:fetchStub}).result();
 expect(requests[1].request.contents[1].parts).toEqual([{text:'',thoughtSignature:signature},{text:'Visible answer'}]);
});
