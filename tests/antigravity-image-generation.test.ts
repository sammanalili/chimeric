import {afterEach,test,expect} from 'bun:test';
import {generateAntigravityImage} from '../src/antigravity-image-generation';
import {bridgeTest,closeBridge} from '../src/antigravity-http-bridge';
import type {ImageGenerationDependencies,ImageGenerationRequest} from '../src/image-generation';

const model={id:'gemini-4-carbon',provider:'antigravity-http',api:'antigravity-http',baseUrl:'https://daily-cloudcode-pa.googleapis.com',requestTimeoutMs:1000};
const secret='synthetic-agy-image-secret';
// A real 2x3 RGB JPEG already used by the shared image-validator tests.
const jpeg='/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z';
const request:ImageGenerationRequest={model,prompt:'Synthetic blue atom icon',imageModel:'gemini-3.1-flash-image',route:'antigravity'};
const candidate=(parts:any[]=[{inlineData:{mimeType:'image/jpeg',data:jpeg}}],finishReason:any='STOP')=>({response:{responseId:'synthetic-image-response',candidates:[{content:{role:'model',parts},...finishReason?{finishReason}:{}}],usageMetadata:{promptTokenCount:5,candidatesTokenCount:10,totalTokenCount:15}}});
const sse=(frames:any[])=>new Response(frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
function fixture(handler:(url:string,init:any)=>Response|Promise<Response>=()=>sse([candidate()])){
 const seen:any[]=[];let authCalls=0,assertions=0;
 const deps:ImageGenerationDependencies={resolveAuth:async bound=>{expect(bound).toBe(model);authCalls++;return {apiKey:secret,project:'synthetic-project',assertCurrent(){assertions++}}},fetch:(async(url:any,init:any)=>{seen.push({url:String(url),init});return handler(String(url),init)}) as typeof fetch};
 return {deps,seen,get authCalls(){return authCalls},get assertions(){return assertions}};
}
const initialTransport=process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT,initialBinary=process.env.CHIMERIC_ANTIGRAVITY_BRIDGE;
afterEach(()=>{bridgeTest.factory=undefined;closeBridge();if(initialTransport===undefined)delete process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT;else process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT=initialTransport;if(initialBinary===undefined)delete process.env.CHIMERIC_ANTIGRAVITY_BRIDGE;else process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=initialBinary;});

test('Antigravity generation uses its selected image model and returns validated provider-native JPEG',async()=>{
 const f=fixture((url,init)=>{
  expect(url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
  expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+secret);expect(init.redirect).toBe('error');
  const body=JSON.parse(init.body);
  expect(body).toMatchObject({model:'gemini-3.1-flash-image',project:'synthetic-project',request:{contents:[{role:'user',parts:[{text:request.prompt}]}],generationConfig:{maxOutputTokens:65536,responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'1:1',imageSize:'1K'}}}});
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);expect(body.request.generationConfig.thinkingConfig).toBeUndefined();
  return sse([candidate()]);
 });
 const result=await generateAntigravityImage(request,f.deps);
 expect(result).toMatchObject({provider:'antigravity-http',model:'gemini-4-carbon',imageModel:'gemini-3.1-flash-image',route:'antigravity',billing:'subscription',responseId:'synthetic-image-response',usage:{totalTokenCount:15}});
 expect(result.images[0]).toMatchObject({mimeType:'image/jpeg',extension:'jpg',width:2,height:3});
 expect(Buffer.from(result.images[0].bytes)).toEqual(Buffer.from(jpeg,'base64'));
 expect(f.seen).toHaveLength(1);expect(f.authCalls).toBe(1);expect(f.assertions).toBe(2);
});

test('thought-image previews are ignored until exactly one completed final image',async()=>{
 const f=fixture(()=>sse([candidate([{thought:true,inlineData:{mimeType:'image/png',data:'not-final-base64'}}],null),candidate()]));
 expect((await generateAntigravityImage(request,f.deps)).images).toHaveLength(1);
});

for(const [size,ratio] of [['1536x1024','3:2'],['1024x1536','2:3'],['1024x1024','1:1']] as const)test('requested '+size+' maps to supported aspect ratio '+ratio,async()=>{
 const f=fixture((_url,init)=>{expect(JSON.parse(init.body).request.generationConfig.imageConfig.aspectRatio).toBe(ratio);return sse([candidate()])});
 await generateAntigravityImage({...request,size},f.deps);expect(f.seen).toHaveLength(1);
});

test('nonstreaming wrapped JSON retains the same final-image contract',async()=>{
 const f=fixture(()=>Response.json(candidate()));expect((await generateAntigravityImage(request,f.deps)).images[0].extension).toBe('jpg');
});

for(const baseUrl of ['https://daily-cloudcode-pa.googleapis.com.evil.example','https://daily-cloudcode-pa.googleapis.com:8443','http://daily-cloudcode-pa.googleapis.com','https://key@daily-cloudcode-pa.googleapis.com','https://daily-cloudcode-pa.googleapis.com?target=x','https://api.openai.com/v1'])test('foreign destination rejected before auth: '+baseUrl,async()=>{
 const f=fixture();await expect(generateAntigravityImage({...request,model:{...model,baseUrl}},f.deps)).rejects.toMatchObject({code:'unsupported'});expect(f.authCalls).toBe(0);expect(f.seen).toHaveLength(0);
});

test('wrong API, route, unsupported options and raised limits fail before credentials or quota are used',async()=>{
 for(const extra of [{model:{...model,api:'openai-responses'}},{route:'subscription'},{prompt:''},{imageModel:'../image'},{count:2},{format:'png'},{format:'jpeg'},{quality:'high'},{background:'transparent'},{background:'opaque'},{size:'17x17'},{timeoutMs:0}]){
  const f=fixture();await expect(generateAntigravityImage({...request,...extra} as any,f.deps)).rejects.toBeInstanceOf(Error);expect(f.authCalls).toBe(0);expect(f.seen).toHaveLength(0);
 }
 const f=fixture();await expect(generateAntigravityImage(request,{...f.deps,limits:{imageBytes:64*1024*1024}})).rejects.toMatchObject({code:'invalid_request'});expect(f.authCalls).toBe(0);
});

for(const status of [401,403,429])test('HTTP '+status+' stops after one attempt and redacts its credential',async()=>{
 const f=fixture(()=>Response.json({error:{message:'Failure '+secret}},{status,headers:{'retry-after':'42'}}));
 let caught:any;try{await generateAntigravityImage(request,f.deps)}catch(error){caught=error}
 expect(caught.status).toBe(status);expect(caught.message).not.toContain(secret);expect(caught.message).toContain('[redacted]');
 if(status===429)expect(caught.message).toContain('42 seconds');expect(f.seen).toHaveLength(1);expect(f.authCalls).toBe(1);
});

test('HTTP error detail redacts a credential crossing the display boundary',async()=>{
 const f=fixture(()=>new Response('x'.repeat(1990)+secret+' trailing',{status:503}));
 let caught:any;try{await generateAntigravityImage(request,f.deps)}catch(error){caught=error}
 expect(caught.status).toBe(503);
 expect(caught.message).toContain('[redacted]');
 expect(caught.message).not.toContain('synthetic-agy');
 expect(f.seen).toHaveLength(1);
});

test('blocked image diagnostics redact before the reason display boundary',async()=>{
 const f=fixture(()=>sse([{response:{promptFeedback:{blockReason:'X'.repeat(90)+secret}}}]));
 let caught:any;try{await generateAntigravityImage(request,f.deps)}catch(error){caught=error}
 expect(caught.code).toBe('provider_error');
 expect(caught.message).toContain('[redacted]');
 expect(caught.message).not.toContain('synthetic-agy');
 expect(f.seen).toHaveLength(1);
});

test('malformed, incomplete, mismatched and extra image outputs never return successful artifacts',async()=>{
 const outputs=[
  new Response('data: {broken}\n\n',{headers:{'content-type':'text/event-stream'}}),
  sse([candidate(undefined,null)]),sse([candidate([])]),sse([candidate([{inlineData:{mimeType:'image/jpeg',data:'bad'}}])]),
  sse([candidate([{inlineData:{mimeType:'image/png',data:jpeg}}])]),
  sse([candidate([{inlineData:{mimeType:'image/jpeg',data:jpeg}},{inlineData:{mimeType:'image/jpeg',data:jpeg}}])]),
  sse([candidate([{inlineData:{mimeType:'image/jpeg',data:jpeg}}],'MAX_TOKENS')]),
  sse([{response:{candidates:[{content:{parts:[]},finishReason:'STOP'},{content:{parts:[{inlineData:{mimeType:'image/jpeg',data:jpeg}}]}}]}}]),
  sse([candidate([]),candidate(undefined,null)]),
  sse([{response:{promptFeedback:{blockReason:'SAFETY'}}}]),
 ];
 for(const output of outputs){const f=fixture(()=>output);await expect(generateAntigravityImage(request,f.deps)).rejects.toBeInstanceOf(Error);expect(f.seen).toHaveLength(1)}
});

test('event, response and decoded pixel limits apply to the real output parser',async()=>{
 for(const limits of [{eventBytes:80},{responseBytes:80},{pixels:2}]){
  const f=fixture();await expect(generateAntigravityImage(request,{...f.deps,limits})).rejects.toMatchObject({code:'invalid_response'});expect(f.seen).toHaveLength(1);
 }
});

test('deadline covers stalled auth, response headers and a stalled response body',async()=>{
 const stalled=new Promise<any>(()=>{});
 await expect(generateAntigravityImage({...request,timeoutMs:20},{resolveAuth:()=>stalled})).rejects.toMatchObject({code:'timeout'});
 const headers=fixture(()=>stalled);await expect(generateAntigravityImage({...request,timeoutMs:20},headers.deps)).rejects.toMatchObject({code:'timeout'});expect(headers.seen).toHaveLength(1);
 let cancelled=false;const body=fixture(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': waiting\n\n'))},cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}));
 await expect(generateAntigravityImage({...request,timeoutMs:20},body.deps)).rejects.toMatchObject({code:'timeout'});expect(cancelled).toBe(true);expect(body.seen).toHaveLength(1);
});

test('user cancellation after headers cancels the body and forbids a later result',async()=>{
 let cancelled=false;const controller=new AbortController();
 const f=fixture(()=>new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode(': waiting\n\n'))},pull(){queueMicrotask(()=>controller.abort())},cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}));
 await expect(generateAntigravityImage({...request,signal:controller.signal},f.deps)).rejects.toMatchObject({code:'aborted'});expect(cancelled).toBe(true);expect(f.seen).toHaveLength(1);
});

test('a late response arriving after cancellation is cancelled without exposing image bytes',async()=>{
 const controller=new AbortController();let resolve!:(value:Response)=>void,cancelled=false;
 const f=fixture(()=>new Promise<Response>(done=>resolve=done));
 const result=generateAntigravityImage({...request,signal:controller.signal},f.deps);
 while(!f.seen.length)await Bun.sleep(0);
 controller.abort();await expect(result).rejects.toMatchObject({code:'aborted'});
 resolve(new Response(new ReadableStream({cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}));
 await Bun.sleep(0);expect(cancelled).toBe(true);expect(f.seen).toHaveLength(1);
});

test('connection changes after completion reject the result before it can be saved',async()=>{
 const f=fixture();let checks=0;
 await expect(generateAntigravityImage(request,{...f.deps,resolveAuth:async()=>({apiKey:secret,project:'synthetic-project',assertCurrent(){if(++checks>1)throw Error('Connection changed '+secret)}})})).rejects.toThrow('Connection changed [redacted]');expect(f.seen).toHaveLength(1);
});

test('default production transport uses the existing Go bridge without calling a fetch fallback',async()=>{
 process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT='bridge';let seen:any;let fallback=0;
 bridgeTest.factory=()=>({alive:true,close(){},async start(url,token,body,signal){seen={url,token,body:JSON.parse(body),signal};return sse([candidate()])}});
 const result=await generateAntigravityImage(request,{resolveAuth:async()=>({apiKey:secret,project:'synthetic-project',fetch:async()=>{fallback++;throw Error('Unexpected fallback')}})});
 expect(result.images).toHaveLength(1);expect(fallback).toBe(0);expect(seen.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');expect(seen.body.model).toBe('gemini-3.1-flash-image');expect(seen.token).toBe(secret);expect(seen.signal).toBeInstanceOf(AbortSignal);
});

test('missing production helper fails without falling back to JS or another provider',async()=>{
 process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT='bridge';process.env.CHIMERIC_ANTIGRAVITY_BRIDGE='/no-such-synthetic-helper';
 let fetches=0;await expect(generateAntigravityImage(request,{resolveAuth:async()=>({apiKey:secret,project:'synthetic-project',fetch:async()=>{fetches++;return sse([candidate()])}})})).rejects.toThrow('transport is unavailable');expect(fetches).toBe(0);
});

test('the client version gate remains an explicit failure',async()=>{
 const f=fixture(()=>new Response('This version of Antigravity is no longer supported',{headers:{'content-type':'text/plain'}}));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toThrow('no longer supported');expect(f.seen).toHaveLength(1);
});

test('a completed text-only response preserves the provider explanation without thought text or another attempt',async()=>{
 const f=fixture(()=>sse([candidate([{thought:true,text:'private internal deliberation'}],null),candidate([{text:'Image generation is temporarily unavailable. '},{text:'Please try again later.'}])]));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toMatchObject({code:'provider_error',message:'Antigravity completed without a final image. Provider response: Image generation is temporarily unavailable. Please try again later.'});
 expect(f.seen).toHaveLength(1);
});

test('a provider explanation is bounded after redacting a credential split across text chunks and the display limit',async()=>{
 const prefix='x'.repeat(1990),split=10;
 const f=fixture(()=>sse([candidate([{text:prefix+secret.slice(0,split)}],null),candidate([{text:secret.slice(split)+'z'.repeat(3000)}])]));
 let caught:any;try{await generateAntigravityImage(request,f.deps)}catch(error){caught=error}
 expect(caught.code).toBe('provider_error');expect(caught.message).not.toContain(secret);expect(caught.message).not.toContain(secret.slice(0,split));expect(caught.message).toEndWith('[redacted]');expect(caught.message.length).toBeLessThan(2100);
 expect(f.seen).toHaveLength(1);
});

for(const [error,status,code] of [
 [{code:401,status:'UNAUTHENTICATED',message:'Expired '+secret},401,'authentication'],
 [{status:'PERMISSION_DENIED',message:'Image access is unavailable.'},403,'provider_error'],
 [{code:429,status:'RESOURCE_EXHAUSTED',message:'Image quota is exhausted.'},429,'provider_error'],
 [{status:'RESOURCE_EXHAUSTED',message:'Image quota is exhausted.'},429,'provider_error'],
] as const)test('structured SSE error retains '+error.status+' status without retrying',async()=>{
 const f=fixture(()=>sse([{response:{error}}]));let caught:any;
 try{await generateAntigravityImage(request,f.deps)}catch(value){caught=value}
 expect(caught).toMatchObject({code,status});expect(caught.message).toContain(error.status);expect(caught.message).not.toContain(secret);expect(f.seen).toHaveLength(1);
});

test('an unknown structured error status does not acquire an invented HTTP status',async()=>{
 const f=fixture(()=>sse([{error:{code:8,status:'toString',message:'Synthetic provider error.'}}]));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toMatchObject({code:'provider_error',message:'Synthetic provider error.',status:undefined});expect(f.seen).toHaveLength(1);
});

test('a blocked completion includes its provider finish message and never returns its image',async()=>{
 const frame=candidate(undefined,'IMAGE_SAFETY');(frame.response.candidates[0] as any).finishMessage='The requested image was blocked. '+secret;
 const f=fixture(()=>sse([frame]));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toMatchObject({code:'provider_error',message:'Antigravity image generation ended with IMAGE_SAFETY. Provider response: The requested image was blocked. [redacted]'});expect(f.seen).toHaveLength(1);
});

test('the client version gate stays recognizable when split across SSE text chunks',async()=>{
 const f=fixture(()=>sse([candidate([{text:'This version of Antigravity is '}],null),candidate([{text:'no longer supported. Please update.'}])]));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toThrow('This version of Antigravity is no longer supported');expect(f.seen).toHaveLength(1);
});

test('malformed image parts produce a response error without leaking a JavaScript TypeError',async()=>{
 const f=fixture(()=>sse([candidate([null])]));
 await expect(generateAntigravityImage(request,f.deps)).rejects.toMatchObject({code:'invalid_response',message:'Antigravity returned an invalid image part.'});expect(f.seen).toHaveLength(1);
});
