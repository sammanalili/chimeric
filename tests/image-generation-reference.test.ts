import {test,expect} from 'bun:test';
import {deflateSync} from 'node:zlib';
import {generateImage,type ImageGenerationModel,type ImageReferenceInput} from '../src/image-generation';
const model:ImageGenerationModel={id:'synthetic-edit-model',provider:'synthetic',api:'openai-completions',baseUrl:'https://images.example.invalid/v1',imageGenerationCandidate:true,imageGenerationAdvertised:true,input:['text','image']};
function crc(b:Buffer){let c=0xffffffff;for(const x of b){c^=x;for(let n=0;n<8;n++)c=c>>>1^((c&1)?0xedb88320:0)}return(c^0xffffffff)>>>0}
function chunk(n:string,b:Buffer){const t=Buffer.from(n),h=Buffer.alloc(4),e=Buffer.alloc(4);h.writeUInt32BE(b.length);e.writeUInt32BE(crc(Buffer.concat([t,b])));return Buffer.concat([h,t,b,e])}
function png(){const h=Buffer.alloc(13);h.writeUInt32BE(1);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,0,0,255]))),chunk('IEND',Buffer.alloc(0))])}
const bytes=png(),ref:ImageReferenceInput={bytes,mimeType:'image/png'},secret='synthetic-reference-secret';
const result=()=>Response.json({data:[{b64_json:bytes.toString('base64')}],output_format:'png'});

test('Real HTTP sends one reference as multipart to the pinned edits endpoint',async()=>{
 let received:any,auth=0,calls=0;
 const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(r){const f=await r.formData(),file=f.get('image') as File;received={path:new URL(r.url).pathname,authorization:r.headers.get('authorization'),type:r.headers.get('content-type'),model:f.get('model'),prompt:f.get('prompt'),n:f.get('n'),format:f.get('response_format'),size:f.get('size'),filename:file.name,mime:file.type,bytes:Buffer.from(await file.arrayBuffer())};return result()}});
 try{
  const r=await generateImage({model,prompt:'Redraw this public guide',size:'1024x1024',referenceImages:[ref]},{resolveAuth:async selected=>{auth++;expect(selected).toBe(model);return {apiKey:secret}},fetch:(async(u,i)=>{calls++;expect(String(u)).toBe('https://images.example.invalid/v1/images/edits');expect(i?.redirect).toBe('error');return fetch(new URL('/v1/images/edits',server.url),i)})as typeof fetch});
  expect(received).toMatchObject({path:'/v1/images/edits',authorization:'Bearer '+secret,model:model.id,prompt:'Redraw this public guide',n:'1',format:'b64_json',size:'1024x1024',filename:'reference-1.png',mime:'image/png'});expect(received.type).toStartWith('multipart/form-data; boundary=');expect(received.bytes).toEqual(bytes);expect(r).toMatchObject({provider:'synthetic',operation:'edit',referenceImageCount:1,route:'images',billing:'api'});expect(auth).toBe(1);expect(calls).toBe(1);
 }finally{server.stop(true)}
});

test('Malformed or oversized references fail before authentication',async()=>{
 const sparse:any[]=[];sparse.length=1;
 for(const bad of [[],sparse,[null],[{bytes:Buffer.from('not an image'),mimeType:'image/png'}],[{bytes,mimeType:'image/jpeg'}],[{bytes:bytes.subarray(0,bytes.length-3),mimeType:'image/png'}],Array(5).fill(ref),[{bytes:Buffer.alloc(16*1024*1024+1),mimeType:'image/png'}]]){
  let auth=0,calls=0;await expect(generateImage({model,prompt:'Guide',referenceImages:bad as any},{resolveAuth:async()=>{auth++;return{apiKey:secret}},fetch:(async()=>{calls++;return result()})as typeof fetch})).rejects.toMatchObject({code:'invalid_request'});expect(auth).toBe(0);expect(calls).toBe(0);
 }
});

test('Unsupported routes reject references without changing connection or billing',async()=>{
 for(const wrong of [{...model,api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api'},{...model,id:'gpt-image-2.5-flare',baseUrl:'https://api.openai.com/v1'},{...model,id:'chat',imageGenerationCandidate:false,api:'openai-responses',baseUrl:'https://api.openai.com/v1'}]){
  let auth=0,calls=0;await expect(generateImage({model:wrong,prompt:'Guide',referenceImages:[ref]},{resolveAuth:async()=>{auth++;return{apiKey:secret}},fetch:(async()=>{calls++;return result()})as typeof fetch})).rejects.toMatchObject({code:'unsupported'});expect(auth).toBe(0);expect(calls).toBe(0);
 }
});

test('Ordered multi-image form contains exact reference bytes and safe filenames',async()=>{
 let calls=0;await generateImage({model,prompt:'Combine guides',referenceImages:[ref,ref]},{resolveAuth:async()=>({apiKey:secret}),fetch:(async(u,i)=>{calls++;expect(String(u)).toBe('https://images.example.invalid/v1/images/edits');const f=i!.body as FormData;expect(f.get('image')).toBeNull();const files=f.getAll('image[]')as File[];expect(files.map(x=>x.name)).toEqual(['reference-1.png','reference-2.png']);for(const file of files)expect(Buffer.from(await file.arrayBuffer())).toEqual(bytes);expect(new Headers(i!.headers).has('content-type')).toBe(false);return result()})as typeof fetch});expect(calls).toBe(1);
});

test('Reference bytes are pinned before an asynchronous auth refresh',async()=>{
 const mutable=Uint8Array.from(bytes);let release!:()=>void;const waiting=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
 const pending=generateImage({model,prompt:'Keep guide',referenceImages:[{bytes:mutable,mimeType:'image/png'}]},{resolveAuth:async()=>{entered();await waiting;return {apiKey:secret}},fetch:(async(_u,i)=>{const f=i!.body as FormData;expect(Buffer.from(await(f.get('image')as File).arrayBuffer())).toEqual(bytes);return result()})as typeof fetch});
 await ready;mutable.fill(0);release();expect((await pending).operation).toBe('edit');
});

test('An edit failure never silently falls back to text generation or leaks its key',async()=>{
 let calls=0;let error:unknown;
 try{await generateImage({model,prompt:'Guide',referenceImages:[ref]},{resolveAuth:async()=>({apiKey:secret}),fetch:(async(u)=>{calls++;expect(String(u)).toEndWith('/images/edits');return Response.json({error:{message:'Synthetic edit unavailable '+secret}},{status:404})})as typeof fetch})}catch(e){error=e}
 expect(calls).toBe(1);expect(String(error)).not.toContain(secret);expect(error).toMatchObject({code:'provider_error'});
});
