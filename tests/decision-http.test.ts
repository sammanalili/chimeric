import {test,expect} from 'bun:test';
import {EventEmitter} from 'node:events';
import {z} from 'zod';
import {DecisionSettingsError,type DecisionManager} from '../src/decision-manager';
import {installDecisionHttp} from '../src/decision-http';

function fixture(overrides:Record<string,any>={}){
 const routes=new Map<string,Function>(),hooks=new Map<string,Function>(),calls:any[]=[];
 const value={revision:4,selectedId:null,connections:[]};
 const manager={snapshot:()=>{calls.push(['snapshot']);return value},upsert:(body:any)=>{calls.push(['upsert',body]);return value},select:(body:any)=>{calls.push(['select',body]);return value},remove:(body:any)=>{calls.push(['remove',body]);return value},test:(body:any,signal:AbortSignal)=>{calls.push(['test',body,signal]);return {ok:true,message:'Synthetic fixture response.'}},safeError:(error:Error)=>{calls.push(['safeError',error]);return error.message.replaceAll('synthetic-key','[redacted]')},close:()=>calls.push(['close']),...overrides};
 const app:any={addHook:(name:string,handler:Function)=>hooks.set(name,handler)};
 for(const method of ['get','post','put','delete'])app[method]=(path:string,handler:Function)=>routes.set(method.toUpperCase()+' '+path,handler);
 installDecisionHttp(app,manager as unknown as DecisionManager,'?chimeric=synthetic-version');
 const reply=()=>({raw:Object.assign(new EventEmitter(),{writableEnded:false}),headers:{} as Record<string,string>,status:200,payload:undefined as any,contentType:'',header(name:string,value:string){this.headers[name]=value;return this},code(status:number){this.status=status;return this},send(value:any){this.payload=value;return this},type(value:string){this.contentType=value;return this}});
 const request=async(key:string,body?:any,raw?:any)=>{const response=reply();const result=await routes.get(key)!({body,raw},response);return {reply:response,result}};
 return {routes,hooks,calls,manager,value,reply,request};
}

test('classifier HTTP adapter registers only the separate settings, selection, synthetic-test and component routes',async()=>{
 const f=fixture();expect([...f.routes.keys()]).toEqual(['GET /api/local/classifiers','POST /api/local/classifiers','PUT /api/local/classifiers','DELETE /api/local/classifiers','POST /api/local/classifiers/test','GET /api/local/classifiers/component.js']);
 const body={expectedRevision:4,id:'synthetic-classifier',name:'Synthetic fixture'};
 for(const [method,called] of [['GET','snapshot'],['POST','upsert'],['PUT','select'],['DELETE','remove']]){
  const {result,reply}=await f.request(method+' /api/local/classifiers',body);expect(result).toBe(f.value);expect(reply.headers['cache-control']).toBe('no-store');
  const call=f.calls.at(-1);expect(call[0]).toBe(called);if(method!=='GET')expect(call[1]).toBe(body);
 }
 expect(f.routes.has('POST /api/local/classifiers/evaluate')).toBe(false);
});

test('classifier synthetic-test adapter forwards the original revisioned body and a real cancellation signal',async()=>{
 const f=fixture();const body={id:'synthetic-classifier',expectedRevision:4};const raw=new EventEmitter();
 const {reply,result}=await f.request('POST /api/local/classifiers/test',body,raw);const call=f.calls[0];
 expect(call[0]).toBe('test');expect(call[1]).toBe(body);expect(call[2]).toBeInstanceOf(AbortSignal);expect(call[2].aborted).toBe(false);expect(reply.headers['cache-control']).toBe('no-store');expect(result).toEqual({ok:true,message:'Synthetic fixture response.'});
 expect(raw.listenerCount('aborted')).toBe(0);expect(reply.raw.listenerCount('close')).toBe(0);raw.emit('aborted');expect(call[2].aborted).toBe(false);
});

test('classifier adapter forwards abort while a synthetic request is pending and returns the manager error status',async()=>{
 let signal!:AbortSignal;
 const f=fixture({test:(_body:any,value:AbortSignal)=>{signal=value;return new Promise((_resolve,reject)=>value.addEventListener('abort',()=>reject(new DecisionSettingsError('Synthetic test cancelled.',499)),{once:true}))}});
 const raw=new EventEmitter(),reply=f.reply(),running=f.routes.get('POST /api/local/classifiers/test')!({body:{id:'synthetic-classifier',expectedRevision:4},raw},reply);
 expect(signal.aborted).toBe(false);raw.emit('aborted');await running;expect(signal.aborted).toBe(true);expect(reply.status).toBe(499);expect(reply.payload).toEqual({detail:'Synthetic test cancelled.'});expect(reply.headers['cache-control']).toBe('no-store');
});

test('classifier adapter cancels an unfinished response when its close event arrives after the request body',async()=>{
 let signal!:AbortSignal;
 const f=fixture({test:(_body:any,value:AbortSignal)=>{signal=value;return new Promise((_resolve,reject)=>value.addEventListener('abort',()=>reject(new DecisionSettingsError('Synthetic response disconnected.',499)),{once:true}))}});
 const requestRaw=new EventEmitter(),reply=f.reply(),running=f.routes.get('POST /api/local/classifiers/test')!({body:{id:'synthetic-classifier',expectedRevision:4},raw:requestRaw},reply);
 reply.raw.emit('close');await running;expect(signal.aborted).toBe(true);expect(reply.status).toBe(499);expect(requestRaw.listenerCount('aborted')).toBe(0);expect(reply.raw.listenerCount('close')).toBe(0);
});

test('classifier adapter keeps a completed response close from cancelling its test signal',async()=>{
 let signal!:AbortSignal,finish!:(value:any)=>void;
 const f=fixture({test:(_body:any,value:AbortSignal)=>{signal=value;return new Promise(resolve=>finish=resolve)}});
 const raw=new EventEmitter(),reply=f.reply(),running=f.routes.get('POST /api/local/classifiers/test')!({body:{id:'synthetic-classifier',expectedRevision:4},raw},reply);
 reply.raw.writableEnded=true;reply.raw.emit('close');expect(signal.aborted).toBe(false);finish({ok:true});await running;expect(signal.aborted).toBe(false);expect(raw.listenerCount('aborted')).toBe(0);
});

test('classifier adapter preserves conflict statuses and routes public messages through manager redaction',async()=>{
 const f=fixture({upsert:()=>{throw new DecisionSettingsError('Changed synthetic-key configuration.',409)}});
 const {reply}=await f.request('POST /api/local/classifiers',{expectedRevision:1});expect(reply.status).toBe(409);expect(reply.payload).toEqual({detail:'Changed [redacted] configuration.'});expect(reply.headers['cache-control']).toBe('no-store');expect(f.calls.filter(call=>call[0]==='safeError')).toHaveLength(1);
});

test('classifier adapter reports schema failures without including rejected field values',async()=>{
 const f=fixture({select:()=>z.object({expectedRevision:z.number()}).parse({expectedRevision:'synthetic-key'})});
 const {reply}=await f.request('PUT /api/local/classifiers',{});expect(reply.status).toBe(400);expect(reply.payload).toEqual({detail:'Choose valid classifier settings and reload if the connections changed.'});expect(JSON.stringify(reply.payload)).not.toContain('synthetic-key');expect(f.calls.some(call=>call[0]==='safeError')).toBe(false);
});

test('classifier browser component is served without caching using the current native module version',async()=>{
 const f=fixture();const {reply}=await f.request('GET /api/local/classifiers/component.js');expect(reply.contentType).toBe('text/javascript; charset=utf-8');expect(reply.headers['cache-control']).toBe('no-store');expect(reply.payload).toContain("from '/assets/vendor-CED4rDjN.js?chimeric=synthetic-version'");expect(reply.payload).not.toContain('?science_local=chatgpt-v1');expect(reply.payload).toContain('export function DecisionSettings()');expect(f.calls).toHaveLength(0);
});

test('classifier HTTP lifecycle closes the owned manager',async()=>{
 const f=fixture();expect([...f.hooks.keys()]).toEqual(['onClose']);await f.hooks.get('onClose')!();expect(f.calls).toEqual([['close']]);
});
