import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {SubscriptionManager,SubscriptionVault} from '../src/subscription';
import {generateImage,type ImageGenerationModel} from '../src/image-generation';

const endpoint='https://chatgpt.com/backend-api/codex/images/generations';
const jwt=(suffix='old')=>'header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.'+suffix;
const renewed=()=>Response.json({access_token:jwt('renewed'),refresh_token:'synthetic-rotated-refresh',expires_in:3600});
const model:ImageGenerationModel={id:'gpt-6.1-sol',provider:'openai-codex',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api',requestTimeoutMs:1000};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
function fixture(fetcher:typeof fetch,expires=Date.now()+3600000){const dir=mkdtempSync(join(tmpdir(),'chimeric-subscription-images-')),vault=new SubscriptionVault(join(dir,'auth'));vault.write({session:randomUUID(),version:randomUUID(),credential:{type:'oauth',access:jwt(),refresh:'synthetic-refresh',expires}});const manager=new SubscriptionManager(vault,{fetch:fetcher});return{dir,vault,manager,close(){manager.close();rmSync(dir,{recursive:true,force:true})}};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>resolve=accept);return{resolve,promise};}

test('Image auth admits only the exact subscription image POST and pins its account headers',async()=>{
  const seen:any[]=[];const f=fixture((async(url:any,init:any)=>{seen.push({url:String(url),init});return Response.json({data:[]})})as typeof fetch);
  try{const auth=await f.manager.requestAuth(undefined,'images');await auth.fetch(endpoint,{method:'POST',headers:{'chatgpt-account-id':'wrong','authorization':'Bearer wrong'},body:'{}',redirect:'follow'});expect(seen).toHaveLength(1);expect(seen[0].init.redirect).toBe('error');expect(new Headers(seen[0].init.headers).get('authorization')).toBe('Bearer '+jwt());expect(new Headers(seen[0].init.headers).get('chatgpt-account-id')).toBe('synthetic-account');
    for(const url of ['https://api.openai.com/v1/images/generations','https://chatgpt.com/backend-api/codex/responses',endpoint+'?next=x','https://chatgpt.com.evil.invalid/backend-api/codex/images/generations'])await expect(auth.fetch(url,{method:'POST'})).rejects.toThrow('only be sent');
    await expect(auth.fetch(endpoint,{method:'GET'})).rejects.toThrow('only be sent');await expect(auth.fetch(endpoint,{method:'DELETE'})).rejects.toThrow('only be sent');const inference=await f.manager.requestAuth();await expect(inference.fetch(endpoint,{method:'POST'})).rejects.toThrow('only be sent');expect(seen).toHaveLength(1);
  }finally{f.close()}
});

test('Expired image credentials renew before a single generation dispatch',async()=>{
  let refreshes=0,images=0;const f=fixture((async(url:any,init:any)=>{if(String(url)==='https://auth.openai.com/oauth/token'){refreshes++;expect(new URLSearchParams(init.body).get('refresh_token')).toBe('synthetic-refresh');return renewed()}images++;expect(String(url)).toBe(endpoint);expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+jwt('renewed'));return Response.json({data:[{b64_json:png,generation_id:'gen_synthetic'}]})})as typeof fetch,0);
  try{const result=await generateImage({model,prompt:'Synthetic red square',route:'subscription'},{resolveAuth:(_model,signal)=>f.manager.requestAuth(signal,'images'),redact:message=>f.manager.redact(message)});expect(refreshes).toBe(1);expect(images).toBe(1);expect(result.billing).toBe('subscription');expect(result.images[0]).toMatchObject({generationId:'gen_synthetic',width:1,height:1});expect(f.vault.read()?.credential?.refresh).toBe('synthetic-rotated-refresh');}finally{f.close()}
});

test('A rejected image token renews for the next explicit request without replaying the failed POST',async()=>{
  let images=0,refreshes=0;const seen:string[]=[];const f=fixture((async(url:any,init:any)=>{if(String(url).includes('/oauth/token')){refreshes++;return renewed()}images++;seen.push(new Headers(init.headers).get('authorization')!);return images===1?Response.json({error:{message:'Synthetic unauthorized'}},{status:401}):Response.json({data:[{b64_json:png}]})})as typeof fetch);
  try{const auth=await f.manager.requestAuth(undefined,'images');const denied=await auth.fetch(endpoint,{method:'POST',body:'{}'});expect(denied.status).toBe(401);expect(await denied.json()).toMatchObject({error:{message:'Synthetic unauthorized'}});expect(images).toBe(1);expect(refreshes).toBe(1);expect((await auth.fetch(endpoint,{method:'POST',body:'{}'})).status).toBe(200);expect(images).toBe(2);expect(refreshes).toBe(1);expect(seen).toEqual(['Bearer '+jwt(),'Bearer '+jwt('renewed')]);}finally{f.close()}
});

for(const status of [403,429,503])test('Subscription image HTTP '+status+' does not refresh, retry, or change billing',async()=>{
  let calls=0;const f=fixture((async(url:any)=>{calls++;expect(String(url)).toBe(endpoint);return Response.json({error:{message:'Synthetic limit '+jwt()}},{status})})as typeof fetch);
  try{await expect(generateImage({model,prompt:'Synthetic square'},{resolveAuth:(_model,signal)=>f.manager.requestAuth(signal,'images'),redact:message=>f.manager.redact(message)})).rejects.toMatchObject({code:'provider_error',status,message:'OpenAI image generation (HTTP '+status+'): Synthetic limit [redacted]'});expect(calls).toBe(1);expect(f.manager.status().connected).toBe(true);}finally{f.close()}
});

test('Disconnect rejects saved image auth before dispatch',async()=>{
  let calls=0;const f=fixture((async()=>{calls++;return Response.json({})})as typeof fetch);try{const auth=await f.manager.requestAuth(undefined,'images');f.manager.disconnect();await expect(auth.fetch(endpoint,{method:'POST'})).rejects.toThrow('connection changed');expect(()=>auth.assertCurrent?.()).toThrow('connection changed');expect(auth.signal?.aborted).toBe(true);expect(calls).toBe(0);}finally{f.close()}
});

test('Disconnect while awaiting image headers cancels and rejects a late response',async()=>{
  const arrived=deferred<void>(),release=deferred<Response>();let cancelled=false;const f=fixture((async()=>{arrived.resolve();return release.promise})as typeof fetch);
  try{const auth=await f.manager.requestAuth(undefined,'images');const pending=auth.fetch(endpoint,{method:'POST'});await arrived.promise;f.manager.disconnect();release.resolve(new Response(new ReadableStream({cancel(){cancelled=true}})));await expect(pending).rejects.toThrow('connection changed');expect(cancelled).toBe(true);expect(f.manager.status().connected).toBe(false);}finally{f.close()}
});

test('Disconnect during an image body prevents the completed image from escaping the backend',async()=>{
  const arrived=deferred<void>();let cancelled=false;const f=fixture((async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"data":'));arrived.resolve()},cancel(){cancelled=true}}),{headers:{'content-type':'application/json'}}))as typeof fetch);
  try{const pending=generateImage({model,prompt:'Synthetic square'},{resolveAuth:(_model,signal)=>f.manager.requestAuth(signal,'images')});await arrived.promise;f.manager.disconnect();await expect(pending).rejects.toMatchObject({code:'authentication'});expect(cancelled).toBe(true);}finally{f.close()}
});

test('External session replacement invalidates a completed response through the final account assertion',async()=>{
  const f=fixture((async()=>{const current=f.vault.read()!;f.vault.write({...current,session:randomUUID(),version:randomUUID()});return Response.json({data:[{b64_json:png}]})})as typeof fetch);try{await expect(generateImage({model,prompt:'Synthetic square'},{resolveAuth:(_model,signal)=>f.manager.requestAuth(signal,'images')})).rejects.toThrow('connection changed');}finally{f.close()}
});

test('Image auth requires an account claim and never forwards an unbound credential',async()=>{
  let calls=0;const f=fixture((async()=>{calls++;return Response.json({})})as typeof fetch);try{const current=f.vault.read()!;f.vault.write({...current,credential:{...current.credential!,access:'invalid-synthetic-token'}});const auth=await f.manager.requestAuth(undefined,'images');await expect(auth.fetch(endpoint,{method:'POST'})).rejects.toThrow('account information');expect(calls).toBe(0);}finally{f.close()}
});

test('Closing the subscription manager cancels a stalled image body',async()=>{
  const arrived=deferred<void>();const f=fixture((async()=>new Response(new ReadableStream({start(){arrived.resolve()}}),{headers:{'content-type':'application/json'}}))as typeof fetch);try{const pending=generateImage({model,prompt:'Synthetic square'},{resolveAuth:(_model,signal)=>f.manager.requestAuth(signal,'images')});await arrived.promise;f.manager.close();await expect(pending).rejects.toMatchObject({code:'authentication'});}finally{f.close()}
});
