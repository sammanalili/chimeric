import {expect,test} from 'bun:test';
import {AntigravityHttpModels} from '../src/antigravity-http-models';

const tick=()=>Bun.sleep(0);
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
async function drain(events:AsyncIterable<any>){const result=[];for await(const event of events)result.push(event);return result}
function fixture(stream?:(model:any,context:any,options:any)=>AsyncIterable<any>){
 let allowed=true,policy=new AbortController(),starts=0,authStarts=0,catalogRequests=0;
 const auth:any={status:()=>({connected:true}),onChange:()=>()=>{},redact:(message:string)=>message,close(){},disconnect(){},
  async start(){authStarts++},async requestAuth(){return {apiKey:'synthetic',fetch:async()=>{catalogRequests++;return Response.json({models:{'synthetic-medium':{displayName:'Synthetic (Medium)',maxTokens:8192,maxOutputTokens:1024}}})}}},
  async profileInfo(){return {project:'synthetic-project'}}};
 const manager=new AntigravityHttpModels('/unused-synthetic-profile',{auth,
  assertAccess:()=>{if(!allowed)throw Error('Synthetic experimental connection is disabled')},accessSignal:()=>policy.signal,
  stream:((model:any,context:any,options:any)=>{starts++;return stream?stream(model,context,options):(async function*(){yield {type:'done'}})()}) as any});
 const model:any={id:'synthetic',api:'antigravity-http'},context:any={messages:[]};
 return {manager,model,context,get starts(){return starts},get authStarts(){return authStarts},get catalogRequests(){return catalogRequests},
  deny(){allowed=false},revoke(){allowed=false;policy.abort(new Error('Synthetic policy generation revoked'))},enable(){allowed=true;policy=new AbortController()}};
}

test('disabled direct access blocks chat and image entry points while discovery and sign-in stay usable',async()=>{
 const f=fixture();f.deny();
 try{
  await f.manager.refresh();await f.manager.connect();await f.manager.authenticate({method:'browser'});
  expect(f.catalogRequests).toBe(2);expect(f.authStarts).toBe(2);expect(f.manager.status().modelDiscovery.state).toBe('ready');
  expect(f.manager.available()).toBe(false);
  expect(()=>f.manager.stream(f.model,f.context)).toThrow('experimental connection is disabled');
  let images=0;await expect(f.manager.runRequest(async()=>{images++})).rejects.toThrow('experimental connection is disabled');
  expect(f.starts).toBe(0);expect(images).toBe(0);
  f.enable();expect(f.manager.available()).toBe(true);
 }finally{await f.manager.close()}
});

test('a direct chat queued under old access is checked again before constructing its provider',async()=>{
 const f=fixture(),gate=deferred();await f.manager.refresh();
 const active=Array.from({length:4},()=>f.manager.runRequest(async()=>gate.promise));
 const activeResults=Promise.allSettled(active);
 const queued=drain(f.manager.stream(f.model,f.context));
 try{
  await tick();expect(f.starts).toBe(0);f.deny();gate.resolve();
  await expect(queued).rejects.toThrow('experimental connection is disabled');
  expect((await activeResults).every(result=>result.status==='rejected')).toBe(true);expect(f.starts).toBe(0);
 }finally{gate.resolve();await Promise.allSettled([...active,queued]);await f.manager.close()}
});

test('revocation aborts active images and both queued image/chat work without reviving them on re-enable',async()=>{
 const f=fixture();await f.manager.refresh();let imageCalls=0;
 const active=Array.from({length:4},()=>f.manager.runRequest(async signal=>new Promise<void>((_resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
 })));
 // Attach the observers before revoking so all synthetic rejections are handled.
 const activeResults=Promise.allSettled(active),queuedImage=f.manager.runRequest(async()=>{imageCalls++});
 const queuedChat=drain(f.manager.stream(f.model,f.context)),queuedResults=Promise.allSettled([queuedImage,queuedChat]);
 try{
  await tick();f.revoke();f.enable();
  expect((await activeResults).every(result=>result.status==='rejected')).toBe(true);
  expect((await queuedResults).every(result=>result.status==='rejected')).toBe(true);
  expect(imageCalls).toBe(0);expect(f.starts).toBe(0);
  expect(await f.manager.runRequest(async()=>42)).toBe(42);
 }finally{await f.manager.close()}
});

test('policy cancellation reaches an active chat and prevents its cancelled provider event from escaping',async()=>{
 const entered=deferred(),f=fixture((_model,_context,options)=>(async function*(){
  yield {type:'start'};entered.resolve();
  await new Promise<void>(resolve=>options.signal.addEventListener('abort',()=>resolve(),{once:true}));
  expect(options.signal.aborted).toBe(true);yield {type:'error',reason:'aborted'};
 })());
 await f.manager.refresh();const events:any[]=[],pending=(async()=>{for await(const event of f.manager.stream(f.model,f.context))events.push(event)})();
 try{
  await entered.promise;f.revoke();f.enable();
  await expect(pending).rejects.toThrow('policy generation revoked');
  expect(events).toEqual([{type:'start'}]);expect(f.starts).toBe(1);
 }finally{await f.manager.close()}
});

test('a late image result cannot survive access revocation even if its callback ignores cancellation',async()=>{
 const f=fixture(),gate=deferred<string>(),entered=deferred();await f.manager.refresh();let captured:AbortSignal|undefined;
 const pending=f.manager.runRequest(async signal=>{captured=signal;entered.resolve();return gate.promise});
 try{
  await entered.promise;f.revoke();f.enable();gate.resolve('must not reach artifact persistence');
  await expect(pending).rejects.toThrow('policy generation revoked');expect(captured!.aborted).toBe(true);
 }finally{gate.resolve('cleanup');await Promise.allSettled([pending]);await f.manager.close()}
});
