import {test,expect} from 'bun:test';
import {deflateSync} from 'node:zlib';
import {generateImage,imageGenerationCapability,ImageGenerationError,DEFAULT_IMAGE_MODEL,OPENAI_SUBSCRIPTION_IMAGE_MODEL,type ImageGenerationModel} from '../src/image-generation';

const model:ImageGenerationModel={id:'gpt-6-astra',provider:'synthetic-openai',qualifiedId:'synthetic-openai::gpt-6-astra',api:'openai-responses',baseUrl:'https://api.openai.com/v1',input:['text','image'],requestTimeoutMs:1000};
const secret='synthetic-image-api-secret';
const subscriptionModel:ImageGenerationModel={...model,provider:'synthetic-chatgpt',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'};
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}return(crc^0xffffffff)>>>0;}
function chunk(name:string,bytes:Buffer){const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(bytes.length);tail.writeUInt32BE(crc32(Buffer.concat([type,bytes])));return Buffer.concat([head,type,bytes,tail]);}
function png(width=1,height=1){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*3+1)*height))),chunk('IEND',Buffer.alloc(0))]);}
const image=png(),b64=image.toString('base64');
const call=(result:any=b64,extra:any={})=>({id:'ig_synthetic',type:'image_generation_call',status:'completed',result,...extra});
const response=(output:any[]=[call()],extra:any={})=>({id:'resp_synthetic',status:'completed',output,usage:{input_tokens:2,output_tokens:3,total_tokens:5},...extra});
const sse=(events:any[])=>new Response(events.map(event=>'event: '+event.type+'\r\ndata: '+JSON.stringify(event)+'\r\n\r\n').join(''),{headers:{'content-type':'text/event-stream'}});
function deps(handler:(url:string,init:RequestInit)=>Response|Promise<Response>){const seen:any[]=[];let authCalls=0;return {seen,get authCalls(){return authCalls},resolveAuth:async(selected:ImageGenerationModel)=>{authCalls++;expect(selected).toBe(model);return {apiKey:secret}},fetch:(async(input:any,init:any)=>{seen.push({url:String(input),init});return handler(String(input),init)}) as typeof fetch};}

test('Generation and image-input capabilities remain separate with explicit billing and unverified account access',()=>{
  expect(imageGenerationCapability(model)).toMatchObject({available:true,status:'available',verified:false,inputImages:true,route:'responses',billing:'api'});
  expect(imageGenerationCapability({...model,input:['text']})).toMatchObject({available:true,inputImages:false});
  expect(imageGenerationCapability(subscriptionModel)).toMatchObject({available:true,status:'available',verified:false,route:'subscription',billing:'subscription'});
  expect(imageGenerationCapability({...model,id:DEFAULT_IMAGE_MODEL})).toMatchObject({route:'images'});
  expect(imageGenerationCapability({...model,id:'gpt-image-1'}).available).toBe(false);
});

test('JSON Responses generation forces the image tool and returns exact validated bytes',async()=>{
  const d=deps((url,init)=>{expect(url).toBe('https://api.openai.com/v1/responses');expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+secret);expect(init.redirect).toBe('error');const body=JSON.parse(init.body as string);expect(body).toMatchObject({model:model.id,input:'Synthetic red square',stream:true,store:false,tool_choice:{type:'image_generation'},tools:[{type:'image_generation',model:DEFAULT_IMAGE_MODEL,action:'generate',partial_images:0,output_format:'png'}]});return Response.json(response([call(b64,{revised_prompt:'A red square'})]));});
  const result=await generateImage({model,prompt:'Synthetic red square'},d);
  expect(result).toMatchObject({provider:model.provider,model:model.id,imageModel:DEFAULT_IMAGE_MODEL,route:'responses',billing:'api',responseId:'resp_synthetic'});
  expect(result.images[0]).toMatchObject({mimeType:'image/png',extension:'png',width:1,height:1,revisedPrompt:'A red square'});expect(Buffer.from(result.images[0].bytes)).toEqual(image);expect(d.authCalls).toBe(1);expect(d.seen).toHaveLength(1);
});

test('Explicit Images route stays on the selected OpenAI API credential and requested image model',async()=>{
  const d=deps((url,init)=>{expect(url).toBe('https://api.openai.com/v1/images/generations');expect(JSON.parse(init.body as string)).toMatchObject({model:'gpt-image-2.5-sunburst',prompt:'Synthetic blue circle',n:1,size:'1024x1024',quality:'low',output_format:'png',background:'transparent'});return Response.json({data:[{b64_json:b64}],output_format:'png'});});
  const result=await generateImage({model,prompt:'Synthetic blue circle',route:'images',imageModel:'gpt-image-2.5-sunburst',size:'1024x1024',quality:'low',background:'transparent'},d);expect(result.images).toHaveLength(1);expect(result.route).toBe('images');
});

test('Subscription generation rejects an API route before resolving credentials or switching billing',async()=>{
  let auth=0,fetches=0;await expect(generateImage({model:subscriptionModel,route:'images',prompt:'Synthetic square'},{resolveAuth:async()=>{auth++;return{apiKey:secret}},fetch:(async()=>{fetches++;return Response.json({})})as typeof fetch})).rejects.toMatchObject({code:'unsupported'});expect(auth).toBe(0);expect(fetches).toBe(0);
});

for(const baseUrl of ['https://api.openai.com.evil.example/v1','https://api.openai.com/v1?target=x','https://api.openai.com:8443/v1','http://api.openai.com/v1','https://key@api.openai.com/v1','https://chatgpt.com/backend-api','http://127.0.0.1/v1'])test('Destination binding rejects '+baseUrl+' before credential resolution',async()=>{
  let auth=0;await expect(generateImage({model:{...model,baseUrl},prompt:'Synthetic square'},{resolveAuth:async()=>{auth++;return{apiKey:secret}}})).rejects.toMatchObject({code:'unsupported'});expect(auth).toBe(0);
});

test('Responses streaming ignores previews and item-done outputs until terminal completion',async()=>{
  const d=deps(()=>sse([{type:'response.created',response:{status:'in_progress'}},{type:'response.image_generation_call.partial_image',partial_image_b64:'not-valid-base64'},{type:'response.output_item.done',item:call('not-final')},{type:'response.completed',response:response()}]));const result=await generateImage({model,prompt:'Synthetic square'},d);expect(result.images).toHaveLength(1);expect(Buffer.from(result.images[0].bytes)).toEqual(image);
});

test('Images streaming returns a final image after previews',async()=>{
  const d=deps(()=>sse([{type:'image_generation.partial_image',b64_json:'incomplete'},{type:'image_generation.completed',b64_json:b64,output_format:'png',usage:{total_tokens:5}}]));const result=await generateImage({model,prompt:'Synthetic square',route:'images'},d);expect(result.images[0].width).toBe(1);expect(result.usage).toMatchObject({total_tokens:5});
});

test('Real loopback HTTP transport exercises fragmented UTF8/SSE and endpoint-selected authorization',async()=>{
  let received:any;const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){received={path:new URL(request.url).pathname,authorization:request.headers.get('authorization'),body:await request.json()};const bytes=new TextEncoder().encode('event: response.completed\r\ndata: '+JSON.stringify({type:'response.completed',response:response([call(b64,{revised_prompt:'赤い円'})])})+'\r\n\r\n');return new Response(new ReadableStream({async start(controller){for(let offset=0;offset<bytes.length;offset+=7){controller.enqueue(bytes.subarray(offset,offset+7));await Bun.sleep(1)}controller.close();}}),{headers:{'content-type':'text/event-stream'}})}});
  try{const result=await generateImage({model,prompt:'Synthetic red circle'},{resolveAuth:async()=>({apiKey:secret}),fetch:(async(input:any,init:any)=>{expect(String(input)).toBe('https://api.openai.com/v1/responses');return fetch(new URL('/v1/responses',server.url),init)})as typeof fetch});expect(received.path).toBe('/v1/responses');expect(received.authorization).toBe('Bearer '+secret);expect(received.body.tools[0].type).toBe('image_generation');expect(result.images[0].revisedPrompt).toBe('赤い円');}finally{server.stop(true)}
});

for(const events of [
  [{type:'response.image_generation_call.partial_image',partial_image_b64:b64}],
  [{type:'response.output_item.done',item:call()}],
  [{type:'response.completed',response:response([call(b64,{status:'in_progress'})])}],
  [{type:'response.completed',response:response([])}],
  [{type:'response.completed',response:response([call()],{status:'incomplete'})}],
  [{type:'response.completed',response:response()},{type:'response.completed',response:response()}],
])test('Incomplete or ambiguous Responses stream yields no final artifact: '+JSON.stringify(events).slice(0,100),async()=>{
  await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>sse(events)))).rejects.toBeInstanceOf(ImageGenerationError);
});

test('Images stream ending with only a preview is rejected',async()=>{await expect(generateImage({model,prompt:'Synthetic square',route:'images'},deps(()=>sse([{type:'image_generation.partial_image',b64_json:b64}])))).rejects.toMatchObject({code:'invalid_response'});});

for(const value of ['!!!!',b64+'=',b64.slice(0,-1),Buffer.from('not an image').toString('base64'),'AB=='])test('Malformed, noncanonical, and non-image base64 is rejected: '+value.slice(0,15),async()=>{
  await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>Response.json(response([call(value)]))))).rejects.toMatchObject({code:'invalid_response'});
});

test('Truncated PNG, checksum corruption, format mismatch, and oversized dimensions are rejected',async()=>{
  const corrupt=Buffer.from(image);corrupt[45]^=1;
  for(const [bytes,extra]of [[image.subarray(0,image.length-1),{}],[corrupt,{}],[image,{output_format:'jpeg'}],[png(3,3),{}]] as Array<[Buffer,any]>){await expect(generateImage({model,prompt:'Synthetic square'},{...deps(()=>Response.json(response([call(bytes.toString('base64'),extra)]))),limits:{pixels:4}})).rejects.toMatchObject({code:'invalid_response'});}
});

test('Truncated PNG compressed image data remains invalid after valid chunk checksums',async()=>{
  const header=image.subarray(8,33),compressed=deflateSync(Buffer.alloc(4));const bad=Buffer.concat([image.subarray(0,8),header,chunk('IDAT',compressed.subarray(0,compressed.length-2)),chunk('IEND',Buffer.alloc(0))]);await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>Response.json(response([call(bad.toString('base64'))]))))).rejects.toMatchObject({code:'invalid_response'});
});

test('Image URLs never trigger authenticated or unauthenticated secondary requests',async()=>{
  const d=deps(()=>Response.json({data:[{url:'https://untrusted.example/image.png'}]}));await expect(generateImage({model,prompt:'Synthetic square',route:'images'},d)).rejects.toMatchObject({code:'invalid_response'});expect(d.seen).toHaveLength(1);
});

test('Provider quota, refusal, and transport errors propagate with credential redaction and no retries',async()=>{
  const d=deps(()=>Response.json({error:{message:'Quota denied '+secret+' Bearer other-secret sk-test-sensitive'}},{status:429}));await expect(generateImage({model,prompt:'Synthetic square'},d)).rejects.toMatchObject({code:'provider_error',status:429,message:'OpenAI image generation (HTTP 429): Quota denied [redacted] [redacted] [redacted]'});expect(d.seen).toHaveLength(1);
  await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>sse([{type:'response.failed',response:{error:{message:'Content policy refusal'}}}])))).rejects.toThrow('Content policy refusal');
  await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>{throw Error('Failed '+secret)}))).rejects.toThrow('Failed [redacted]');
  await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>new Response('too large',{status:503,headers:{'content-length':'999999'}})))).rejects.toMatchObject({code:'provider_error',status:503});
});

test('Timeout covers stalled authentication, headers, and a stalled response body',async()=>{
  await expect(generateImage({model,prompt:'Synthetic square',timeoutMs:20},{resolveAuth:()=>new Promise(()=>{})})).rejects.toMatchObject({code:'timeout'});
  await expect(generateImage({model,prompt:'Synthetic square',timeoutMs:20},deps(()=>new Promise(()=>{})))).rejects.toMatchObject({code:'timeout'});
  let cancelled=false;const stalled=deps(()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {}\n\n'))},cancel(){cancelled=true}}),{headers:{'content-type':'text/event-stream'}}));await expect(generateImage({model,prompt:'Synthetic square',timeoutMs:20},stalled)).rejects.toMatchObject({code:'timeout'});expect(cancelled).toBe(true);
});

test('Cancellation before authentication and during streaming cannot return a partial result',async()=>{
  const before=new AbortController();before.abort();const d=deps(()=>Response.json(response()));await expect(generateImage({model,prompt:'Synthetic square',signal:before.signal},d)).rejects.toMatchObject({code:'aborted'});expect(d.authCalls).toBe(0);
  const controller=new AbortController();let closed=false;const during=deps(()=>new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('event: response.image_generation_call.partial_image\ndata: '+JSON.stringify({type:'response.image_generation_call.partial_image',partial_image_b64:b64})+'\n\n'));setTimeout(()=>controller.abort(),10)},cancel(){closed=true}}),{headers:{'content-type':'text/event-stream'}}));await expect(generateImage({model,prompt:'Synthetic square',signal:controller.signal},during)).rejects.toMatchObject({code:'aborted'});expect(closed).toBe(true);
});

test('Response, event, image-byte, and count limits are enforced before returning artifacts',async()=>{
  const tooLarge=deps(()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'999999999'}}));await expect(generateImage({model,prompt:'Synthetic square'},tooLarge)).rejects.toMatchObject({code:'invalid_response'});
  await expect(generateImage({model,prompt:'Synthetic square'},{...deps(()=>sse([{type:'response.created',padding:'x'.repeat(300)}])),limits:{eventBytes:100}})).rejects.toMatchObject({code:'invalid_response'});
  await expect(generateImage({model,prompt:'Synthetic square'},{...deps(()=>Response.json(response())),limits:{imageBytes:10}})).rejects.toMatchObject({code:'invalid_response'});
  await expect(generateImage({model,prompt:'Synthetic square'},{...deps(()=>Response.json(response(Array.from({length:5},()=>call()))))})).rejects.toMatchObject({code:'invalid_response'});
});

test('Malformed SSE and unexpected content types do not produce artifacts',async()=>{
  for(const value of [new Response('data: {broken}\n\n',{headers:{'content-type':'text/event-stream'}}),new Response('event: response.failed\ndata: '+JSON.stringify({type:'response.completed',response:response()})+'\n\n',{headers:{'content-type':'text/event-stream'}}),new Response('<html>Sign in</html>',{headers:{'content-type':'text/html'}})])await expect(generateImage({model,prompt:'Synthetic square'},deps(()=>value))).rejects.toMatchObject({code:'invalid_response'});
});

test('Invalid request options fail before credential use',async()=>{
  for(const options of [{prompt:''},{format:'svg'},{background:'transparent',format:'jpeg'},{size:'99999x99999'},{count:2},{imageModel:'gpt-image-1'},{timeoutMs:0}]){const d=deps(()=>Response.json(response()));await expect(generateImage({model,prompt:'Synthetic square',...options}as any,d)).rejects.toMatchObject({code:'invalid_request'});expect(d.authCalls).toBe(0);}
});

// Real 2x3 RGB images encoded by libjpeg/libwebp, preserved as standalone fixtures.
const jpeg='/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z';
const webp='UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAMAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=';
for(const [format,encoded]of [['jpeg',jpeg],['webp',webp]]as const)test('Valid '+format+' output retains MIME, extension, bytes, and dimensions',async()=>{
  const result=await generateImage({model,prompt:'Synthetic square',format},deps(()=>Response.json(response([call(encoded,{output_format:format})]))));expect(result.images[0]).toMatchObject({mimeType:'image/'+format,extension:format==='jpeg'?'jpg':'webp',width:2,height:3});expect(Buffer.from(result.images[0].bytes)).toEqual(Buffer.from(encoded,'base64'));
  const truncated=Buffer.from(encoded,'base64').subarray(0,-2).toString('base64');await expect(generateImage({model,prompt:'Synthetic square',format},deps(()=>Response.json(response([call(truncated,{output_format:format})]))))).rejects.toMatchObject({code:'invalid_response'});
});

test('Subscription route reproduces the official Codex request and returns validated PNG plus generation provenance',async()=>{
  let calls=0,assertions=0;
  const result=await generateImage({model:subscriptionModel,prompt:'Synthetic red square',route:'subscription',requestId:'synthetic-turn'}, {
    resolveAuth:async(bound)=>{expect(bound).toBe(subscriptionModel);return{apiKey:secret,assertCurrent:()=>{assertions++},fetch:(async(url:any,init:any)=>{calls++;expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/images/generations');expect(init.method).toBe('POST');expect(init.redirect).toBe('error');const headers=new Headers(init.headers);expect(headers.get('originator')).toBe('chimeric');expect(headers.get('user-agent')).toBe('Chimeric/0.1.0');expect(headers.get('x-codex-image-turn-id')).toBe('synthetic-turn');expect(JSON.parse(headers.get('x-codex-turn-metadata')!)).toEqual({turn_id:'synthetic-turn',model:model.id});expect(JSON.parse(init.body)).toEqual({prompt:'Synthetic red square',background:'opaque',model:'gpt-image-2',quality:'auto',size:'auto'});return Response.json({created:1,data:[{b64_json:b64,generation_id:'gen_synthetic'}]});})as typeof fetch}},
    fetch:(async()=>{throw Error('API fallback must not run')})as typeof fetch,
  });
  expect(result).toMatchObject({provider:subscriptionModel.provider,model:model.id,imageModel:OPENAI_SUBSCRIPTION_IMAGE_MODEL,route:'subscription',billing:'subscription'});expect(result.images[0]).toMatchObject({mimeType:'image/png',generationId:'gen_synthetic',width:1,height:1});expect(Buffer.from(result.images[0].bytes)).toEqual(image);expect(calls).toBe(1);expect(assertions).toBe(3);
});

for(const baseUrl of ['https://chatgpt.com/backend-api?next=x','https://chatgpt.com/backend-api/codex','https://chatgpt.com.evil.invalid/backend-api','http://chatgpt.com/backend-api','https://api.openai.com/v1','http://127.0.0.1/backend-api'])test('Subscription destination is checked before credential resolution: '+baseUrl,async()=>{
  let calls=0;await expect(generateImage({model:{...subscriptionModel,baseUrl},route:'subscription',prompt:'Synthetic square'},{resolveAuth:async()=>{calls++;return{apiKey:secret}}})).rejects.toMatchObject({code:'unsupported'});expect(calls).toBe(0);
});

test('Subscription route requires authenticated bound fetch and fixed supported PNG options',async()=>{
  let fallback=0;await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square'},{resolveAuth:async()=>({apiKey:secret}),fetch:(async()=>{fallback++;return Response.json({})})as typeof fetch})).rejects.toMatchObject({code:'authentication'});expect(fallback).toBe(0);
  for(const options of [{imageModel:'gpt-image-2.5-flare'},{format:'jpeg'},{format:'webp'},{quality:'max'},{count:2}]){let auth=0;await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square',...options}as any,{resolveAuth:async()=>{auth++;return{apiKey:secret}}})).rejects.toMatchObject({code:'invalid_request'});expect(auth).toBe(0);}
});

for(const status of [401,403,429,503])test('Subscription HTTP '+status+' propagates without a fallback or image retry',async()=>{
  let calls=0;const resolveAuth=async()=>({apiKey:secret,fetch:(async()=>{calls++;return Response.json({error:{message:'Synthetic subscription error '+secret}},{status})})as typeof fetch});await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square'},{resolveAuth})).rejects.toMatchObject({code:'provider_error',status,message:'OpenAI image generation (HTTP '+status+'): Synthetic subscription error [redacted]'});expect(calls).toBe(1);
});

test('Subscription JSON and PNG completion remain required',async()=>{
  for(const body of [{status:'in_progress',data:[{b64_json:b64}]},{data:[{status:'in_progress',b64_json:b64}]},{data:[{b64_json:b64.slice(0,-2)}]},{data:[]},{data:[{url:'https://untrusted.invalid/image.png'}]}])await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square'},{resolveAuth:async()=>({apiKey:secret,fetch:(async()=>Response.json(body))as typeof fetch})})).rejects.toMatchObject({code:'invalid_response'});
  await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square'},{resolveAuth:async()=>({apiKey:secret,fetch:(async()=>sse([{type:'image_generation.partial_image',b64_json:b64}]))as typeof fetch})})).rejects.toMatchObject({code:'invalid_response'});
});

test('Account invalidation while a subscription response is streaming cannot return an image',async()=>{
  const account=new AbortController();let cancelled=false;
  await expect(generateImage({model:subscriptionModel,prompt:'Synthetic square'},{resolveAuth:async()=>({apiKey:secret,signal:account.signal,fetch:(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":'));setTimeout(()=>account.abort(),5)},cancel(){cancelled=true}}),{headers:{'content-type':'application/json'}}))as typeof fetch})})).rejects.toMatchObject({code:'authentication'});expect(cancelled).toBe(true);
});
