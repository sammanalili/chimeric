import {expect,test} from 'bun:test';
import {requestDecisions,validateDecisionInput,validateDecisionEndpoint,DecisionProviderError,decisionLimits,type DecisionRequest} from '../src/decision-provider';

const questions={
 urgent:{type:'noul',instructions:'Needs attention within one hour?'},
 route:{type:'choice',instructions:'Choose a queue.',criteria:{engineering:'Product defects',billing:'Invoice questions'}},
 severity:{type:'score',instructions:'Rate the disruption.',criteria:['Normal','Minor disruption','Service unavailable']},
};
const answers={urgent:{type:'noul',noul:.8},route:{type:'choice',choice:'engineering',confidence:.7,probabilities:{engineering:.8,billing:.2}},severity:{type:'score',score:1.6,confidence:.55,legend:{'0':'Normal','1':'Minor disruption','2':'Service unavailable'},probabilities:{'0':.1,'1':.2,'2':.7}}};
const request=(overrides:Partial<DecisionRequest>={}):DecisionRequest=>({endpointUrl:'https://example.test/api/v1/systemone',connectionBaseUrl:'https://example.test/api/v1',model:'decision-alias',apiKey:'synthetic-key',state:{ticket:'Synthetic service failure'},questions,...overrides});
const reply=(value:any={model:'resolved-decision-model',answers,usage:{input_tokens:100,output_tokens:12}})=>Response.json(value);
const fetcher=(handler:(url:any,init:any)=>Response|Promise<Response>)=>(async(url:any,init:any)=>handler(url,init)) as typeof fetch;
async function rejection(pending:Promise<unknown>){try{await pending;throw Error('Expected rejection')}catch(error){expect(error).toBeInstanceOf(DecisionProviderError);return error as DecisionProviderError}}

test('flat SystemOne sends exactly the typed request and keeps only typed answers and bounded usage',async()=>{
 let calls=0,wire:any,init:any;
 const result=await requestDecisions(request(),{fetch:fetcher((url,options)=>{
  calls++;expect(url).toBe('https://example.test/api/v1/systemone');wire=JSON.parse(options.body);init=options;
  return reply({model:'resolved-decision-model',answers,usage:{input_tokens:100,output_tokens:12,total_tokens:112,raw_prompt:'private',invalid:2,cached_tokens:-1},diagnostics:{chunk_prompt:'private source text'}});
 })});
 expect(calls).toBe(1);expect(wire).toEqual({model:'decision-alias',state:request().state,questions});
 expect(init.redirect).toBe('error');expect(init.credentials).toBe('omit');expect(init.headers.authorization).toBe('Bearer synthetic-key');
 expect(result.model).toBe('resolved-decision-model');expect(result.answers.urgent).toEqual({type:'noul',noul:.8});
 expect(result.answers.route).toEqual(answers.route);expect(result.answers.severity).toEqual({type:'score',score:1.6,confidence:.55,probabilities:{'0':.1,'1':.2,'2':.7}});
 expect(result.usage).toEqual({input_tokens:100,output_tokens:12,total_tokens:112});expect(JSON.stringify(result)).not.toMatch(/private|diagnostics|chunk_prompt|legend|calibrated/);
});

test('self-hosted flat route keeps its complete caller-provided prefix and needs no API key',async()=>{
 const input=request({endpointUrl:'http://127.0.0.1:8765/custom/typesafe/v1/systemone',connectionBaseUrl:'http://127.0.0.1:8765/custom',apiKey:undefined});
 const result=await requestDecisions(input,{fetch:fetcher((url,init)=>{expect(url).toBe(input.endpointUrl);expect(init.headers.authorization).toBeUndefined();expect(JSON.parse(init.body).questions).toEqual(questions);return reply()})});
 expect(result.answers.route.type).toBe('choice');
});

test('documented chat envelope has two JSON messages, choice options and preserved descriptions',async()=>{
 const input=request({format:'chat-envelope',endpointUrl:'https://example.test/chat/completions',connectionBaseUrl:'https://example.test',questions:{route:questions.route}});
 await requestDecisions(input,{fetch:fetcher((_url,init)=>{
  const body=JSON.parse(init.body);expect(Object.keys(body).sort()).toEqual(['max_tokens','messages','model']);expect(body.max_tokens).toBe(512);expect(body.messages).toHaveLength(2);
  expect(body.messages.map((message:any)=>message.role)).toEqual(['system','user']);
  const system=JSON.parse(body.messages[0].content);expect(system.questions).toHaveLength(1);
  expect(system.questions[0]).toEqual({id:'route',type:'choice',instructions:'Choose a queue.\n\nOption criteria (JSON): '+JSON.stringify(questions.route.criteria),options:['engineering','billing']});
  expect(JSON.parse(body.messages[1].content)).toEqual({state:input.state});
  return reply({answers:{route:{...answers.route,label:'A',stderr:.1,agreement:.75}}});
 })});
});

test('unsupported chat-envelope question types fail before any request',async()=>{
 let calls=0;
 for(const question of [questions.urgent,questions.severity]){
  const error=await rejection(requestDecisions(request({format:'chat-envelope',questions:{question}}),{fetch:fetcher(()=>{calls++;return reply()})}));
  expect(error.code).toBe('invalid_request');
 }
 expect(calls).toBe(0);
});

test('preflight rejects cycles, non-JSON state, accessors, invalid questions and excessive bytes',()=>{
 const circular:any={};circular.self=circular;let accessed=false;const accessor=Object.defineProperty({},'secret',{enumerable:true,get(){accessed=true;return 'never'}});
 for(const state of [circular,{x:NaN},{x:undefined},new Date(),accessor,Array(3),{x:()=>1},'x'.repeat(decisionLimits.requestBytes+1)])expect(()=>validateDecisionInput({state,questions})).toThrow();
 expect(accessed).toBe(false);
 for(const bad of [{},{q:{type:'box'}},{q:{type:'choice',criteria:{}}},{q:{type:'score',criteria:['one']}},{q:{type:'noul',criteria:{maybe:'Unknown'}}},JSON.parse('{"__proto__":{"type":"noul"}}')])expect(()=>validateDecisionInput({state:'text',questions:bad})).toThrow();
});

test('preflight copies structured JSON so later caller mutations cannot change a request',()=>{
 const state={items:[{value:1}]},input={q:{type:'choice',criteria:{yes:{when:'Explicit approval'},no:null}}};
 const checked=validateDecisionInput({state,questions:input});state.items[0].value=2;input.q.criteria.yes.when='Changed';
 expect(checked.state).toEqual({items:[{value:1}]});expect(checked.questions.q).toEqual({type:'choice',criteria:{yes:{when:'Explicit approval'},no:null}});
});

test('destination binding rejects origin and API-prefix escape before attaching credentials',async()=>{
 let calls=0;
 for(const endpointUrl of ['https://foreign.test/api/v1/systemone','https://example.test/api/v10/systemone','https://example.test/systemone','https://user:pass@example.test/api/v1/systemone','https://example.test/api/v1/systemone?key=x','https://example.test/api/v1/%2f..%2fsecret','file:///api/v1/systemone']){
  const error=await rejection(requestDecisions(request({endpointUrl}),{fetch:fetcher(()=>{calls++;return reply()})}));expect(error.code).toBe('invalid_request');
 }
 expect(calls).toBe(0);expect(validateDecisionEndpoint('https://EXAMPLE.test:443/api/v1/systemone','https://example.test/api/v1/')).toBe('https://example.test/api/v1/systemone');
});

test('wrong question IDs, types, choices and incomplete probability maps are rejected',async()=>{
 const cases=[{...answers,extra:{type:'noul',noul:.1}},{urgent:answers.urgent}, {...answers,urgent:{type:'score',score:1}}, {...answers,route:{...answers.route,choice:'unlisted'}},{...answers,route:{...answers.route,probabilities:{engineering:.8}}},{...answers,route:{...answers.route,probabilities:{engineering:.8,billing:.1,unlisted:.1}}}];
 for(const candidate of cases){const error=await rejection(requestDecisions(request(),{fetch:fetcher(()=>reply({answers:candidate}))}));expect(error.code).toBe('invalid_response')}
});

test('probabilities and confidence must be finite numbers within zero and one',async()=>{
 for(const invalid of [-.01,1.01,'0.9',null]){
  for(const candidate of [{...answers,urgent:{type:'noul',noul:invalid}},{...answers,route:{...answers.route,confidence:invalid}},{...answers,route:{...answers.route,probabilities:{engineering:invalid,billing:.2}}}]){
   const error=await rejection(requestDecisions(request(),{fetch:fetcher(()=>reply({answers:candidate}))}));expect(error.code).toBe('invalid_response');
  }
 }
 const serialized=JSON.stringify({answers}).replace('"noul":0.8','"noul":1e999');
 expect((await rejection(requestDecisions(request(),{fetch:fetcher(()=>new Response(serialized))}))).code).toBe('invalid_response');
});

test('score is finite and stays inside the supplied ordered scale',async()=>{
 for(const score of [-.01,2.01,'1',null])expect((await rejection(requestDecisions(request(),{fetch:fetcher(()=>reply({answers:{...answers,severity:{...answers.severity,score}}}))}))).code).toBe('invalid_response');
});

test('redirects and HTTP failures make one attempt and never expose response diagnostics',async()=>{
 for(const status of [302,401,403,429,503]){
  let calls=0;
  const error=await rejection(requestDecisions(request(),{fetch:fetcher((_url,init)=>{calls++;expect(init.redirect).toBe('error');return new Response('synthetic-key PRIVATE STATE',{status,headers:{location:'https://foreign.test/capture'}})})}));
  expect(calls).toBe(1);expect(error.code).toBe('http');expect(error.status).toBe(status);expect(error.message).not.toMatch(/synthetic-key|PRIVATE|foreign/);
 }
});

test('byte limit handles both declared length and an unbounded chunked response',async()=>{
 for(const declared of [true,false]){
  let cancelled=false;
  const response=new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(201))},cancel(){cancelled=true}}),{headers:declared?{'content-length':'201'}:{}});
  const error=await rejection(requestDecisions(request({maxResponseBytes:200}),{fetch:fetcher(()=>response)}));
  expect(error.code).toBe('invalid_response');expect(error.message).toContain('byte limit');expect(cancelled).toBe(true);
 }
});

test('timeout rejects a fetch that ignores abort and cancels a late response body',async()=>{
 let release!:(value:Response)=>void,cancelled=false,calls=0;
 const pending=requestDecisions(request({timeoutMs:10}),{fetch:fetcher(()=>{calls++;return new Promise(resolve=>{release=resolve})})});
 expect((await rejection(pending)).code).toBe('timeout');
 release(new Response(new ReadableStream({cancel(){cancelled=true}})));await new Promise(resolve=>setTimeout(resolve,0));
 expect(calls).toBe(1);expect(cancelled).toBe(true);
});

test('timeout and user cancellation stop reading a response body',async()=>{
 for(const cause of ['timeout','cancelled'] as const){
  let started!:()=>void,cancelled=false;const bodyReady=new Promise<void>(resolve=>{started=resolve});const controller=new AbortController();
  const response=new Response(new ReadableStream({cancel(){cancelled=true}}));
  const getReader=response.body!.getReader.bind(response.body);
  Object.defineProperty(response.body,'getReader',{value:()=>{started();return getReader()}});
  const pending=requestDecisions(request({timeoutMs:cause==='timeout'?15:500,signal:controller.signal}),{fetch:fetcher(()=>response)});
  await bodyReady;if(cause==='cancelled')controller.abort(new Error('private cancellation detail'));
  const error=await rejection(pending);expect(error.code).toBe(cause);expect(error.message).not.toContain('private');expect(cancelled).toBe(true);
 }
});

test('already aborted requests and invalid credentials never dispatch',async()=>{
 let calls=0;const controller=new AbortController();controller.abort();
 const fetch=fetcher(()=>{calls++;return reply()});
 expect((await rejection(requestDecisions(request({signal:controller.signal}),{fetch}))).code).toBe('cancelled');
 expect((await rejection(requestDecisions(request({apiKey:'secret\r\nInjected: header'}),{fetch}))).code).toBe('invalid_request');expect(calls).toBe(0);
});

test('network and parser errors retain no raw state, prompts or keys',async()=>{
 for(const fetch of [fetcher(()=>{throw Error('synthetic-key PRIVATE STATE question prompt')}),fetcher(()=>new Response('synthetic-key PRIVATE STATE question prompt'))]){
  const error=await rejection(requestDecisions(request(),{fetch}));expect(error.message).not.toMatch(/synthetic-key|PRIVATE|prompt/);
 }
});

test('credential redaction happens before truncation even after a custom redactor',async()=>{
 const key='LONG-SYNTHETIC-KEY-DO-NOT-LEAK';
 const error=await rejection(requestDecisions(request({apiKey:key}),{fetch:fetcher(()=>new Response(null,{status:403})),redact:()=> 'x'.repeat(590)+key+'tail'}));
 expect(error.message).toBe('x'.repeat(590)+'[redacted]');expect(error.message).toHaveLength(600);
});
