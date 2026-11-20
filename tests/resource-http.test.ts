import {expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {installResourceHttp} from '../src/resource-http';

const valid={decision:'standard',artifactId:'artifact',versionId:'version',checksum:'a'.repeat(64),sourceRootFrameId:'source',consumerRootFrameId:'consumer',policyRevision:3};
function fixture(view:(input:any,signal:AbortSignal)=>Promise<unknown>,unbound:(input:any,signal:AbortSignal)=>Promise<unknown>=async()=>({decision:'blocked'})){
 const routes=new Map<string,Function>(),calls:any[]=[],unboundCalls:any[]=[],app={get:(path:string,callback:Function)=>routes.set(path,callback),getUser:(request:any)=>request.user};
 installResourceHttp(app,{view:async(input,signal)=>{calls.push(input);return view(input,signal)},unbound:async(input,signal)=>{unboundCalls.push(input);return unbound(input,signal)}},{ownerUserId:'owner',moduleVersion:'?fixture=1'});
 const invoke=async(path:string,query:any,options:any={})=>{
  const request:any={query,user:{user_id:'owner'},raw:new EventEmitter(),...options},reply:any={status:200,headers:{},raw:Object.assign(new EventEmitter(),{writableEnded:false}),header(name:string,value:string){this.headers[name]=value;return this},type(value:string){return this.header('content-type',value)},code(status:number){this.status=status;return this},send(body:any){this.body=body;return body}};
  await routes.get(path)!(request,reply);return {request,reply};
 };
 return {call:(query:any,options:any={})=>invoke('/api/local/resources/policy',query,options),callUnbound:(query:any,options:any={})=>invoke('/api/local/resources/unbound',query,options),calls,unboundCalls,routes};
}
test('Resource view requires native workspace principal before backend or query lookup',async()=>{
 const f=fixture(async()=>{throw Error('must not run')});
 for(const user of [undefined,{user_id:'other'}]){const {reply}=await f.call({versionId:'version'},{user});expect(reply.status).toBe(403)}
 expect(f.calls).toHaveLength(0);
});
test('Resource component requires the owner and is never cacheable',async()=>{
 const f=fixture(async()=>valid),handler=f.routes.get('/api/local/resources/component.js')!,reply:any={headers:{},header(name:string,value:string){this.headers[name]=value;return this},type(value:string){return this.header('content-type',value)},code(status:number){this.status=status;return this},send(body:any){this.body=body;return body}};
 await handler({user:{user_id:'other'}},reply);expect(reply.status).toBe(403);
 const allowed:any={headers:{},header:reply.header,type:reply.type,code:reply.code,send:reply.send};await handler({user:{user_id:'owner'}},allowed);expect(allowed.headers['cache-control']).toBe('no-store');expect(allowed.headers['content-type']).toContain('text/javascript');expect(allowed.body).toContain('export function ProtectedResourceView');
});
test('Only exact lookup keys are accepted; paths, URLs, release booleans and duplicate IDs are refused',async()=>{
 const f=fixture(async()=>valid);
 for(const input of [{},{versionId:'version',artifactId:'artifact'},{versionId:['a','b']},{versionId:'../private'},{versionId:'version',allow:true},{versionId:'version',url:'https://example.com'},{versionId:'version',path:'/private/key'}])expect((await f.call(input)).reply.status).toBe(400);
 expect(f.calls).toHaveLength(0);
});
test('Unbound compatibility is owner-only, accepts only a consuming frame, and projects no file identity',async()=>{
 const f=fixture(async()=>valid,async()=>({decision:'standard-unbound',policyRevision:4,consumerRootFrameId:'root',storagePath:'/private/secret',token:'DO_NOT_SEND'}));
 expect((await f.callUnbound({consumerFrameId:'child'})).reply.body).toEqual({decision:'standard-unbound',policyRevision:4,consumerRootFrameId:'root'});expect(f.unboundCalls).toEqual([{consumerFrameId:'child'}]);
 for(const query of [{url:'https://outside.example'},{path:'/private/file'},{consumerFrameId:'../bad'}])expect((await f.callUnbound(query)).reply.status).toBe(400);
 expect((await f.callUnbound({}, {user:{user_id:'other'}})).reply.status).toBe(403);
 const incomplete=fixture(async()=>valid,async()=>({decision:'standard-unbound',policyRevision:4}));expect((await incomplete.callUnbound({consumerFrameId:'child'})).reply.status).toBe(503);
});
test('Resource response projects only verified view fields and forbids shared caches',async()=>{
 const f=fixture(async()=>({...valid,privateToken:'DO_NOT_SERIALIZE',storagePath:'/private/data',lease:{permit:true}}));
 const {reply}=await f.call({artifactId:'artifact',consumerFrameId:'child'});
 expect(reply.status).toBe(200);expect(reply.body).toEqual(valid);expect(JSON.stringify(reply.body)).not.toContain('DO_NOT_SERIALIZE');
 expect(reply.headers['cache-control']).toBe('no-store, private');expect(reply.headers.vary).toBe('Cookie');expect(reply.headers['x-content-type-options']).toBe('nosniff');
});
test('Version and artifact mismatches fail closed even if backend reports standard',async()=>{
 for(const query of [{versionId:'other-version'},{artifactId:'other-artifact'}]){const {reply}=await fixture(async()=>valid).call(query);expect(reply.status).toBe(503);expect(reply.body.decision).toBe('blocked');expect(reply.body.versionId).toBeUndefined()}
});
test('A consuming chat requires an authenticated root binding, and incomplete standard decisions block',async()=>{
 for(const extra of [{consumerRootFrameId:undefined},{checksum:undefined},{sourceRootFrameId:undefined},{policyRevision:-1}]){
  const {reply}=await fixture(async()=>({...valid,...extra})).call({versionId:'version',consumerFrameId:'consumer'});expect(reply.status).toBe(503);expect(reply.body.decision).toBe('blocked');
 }
});
test('Inert text is a bounded JSON string; no HTML response is emitted',async()=>{
 const text='<img src="https://outside.example/leak"><script>fetch("/secret")</script>';
 const {reply}=await fixture(async()=>({...valid,decision:'inert-text',text})).call({versionId:'version'});
 expect(reply.body.text).toBe(text);expect(reply.body.decision).toBe('inert-text');expect(reply.headers['content-type']).toBeUndefined();
 expect((await fixture(async()=>({...valid,decision:'inert-text',text:'x'.repeat(262145)})).call({versionId:'version'})).reply.status).toBe(503);
});
test('External, SVG, HTML and oversized images never reach the browser view',async()=>{
 for(const imageData of ['https://outside.example/image.png','data:image/svg+xml;base64,PHN2Zz4=','data:text/html;base64,PGh0bWw+','data:image/png;base64,PHN2Zz4=','data:image/png;base64,'+'A'.repeat(4194304)]){
  const {reply}=await fixture(async()=>({...valid,decision:'inert-image',imageData})).call({versionId:'version'});expect(reply.status).toBe(503);expect(reply.body.imageData).toBeUndefined();
 }
});
test('A bounded local raster data URL retains its exact version and checksum binding',async()=>{
 const imageData='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4fQAAAAASUVORK5CYII=';
 const {reply}=await fixture(async()=>({...valid,decision:'inert-image',imageData})).call({versionId:'version'});
 expect(reply.status).toBe(200);expect(reply.body.imageData).toBe(imageData);expect(reply.body.versionId).toBe('version');expect(reply.body.checksum).toBe(valid.checksum);
});
test('Backend exceptions do not disclose diagnostics, paths or keys',async()=>{
 const {reply}=await fixture(async()=>{throw Error('/private/key=synthetic-secret')}).call({versionId:'version'});expect(reply.status).toBe(503);expect(JSON.stringify(reply.body)).not.toMatch(/private|synthetic-secret/);
});
test('A disconnected caller aborts the exact pending materialization and drops its late result',async()=>{
 const raw=new EventEmitter();let entered!:()=>void,finish!:(value:any)=>void,captured:AbortSignal|undefined;
 const ready=new Promise<void>(yes=>entered=yes),result=new Promise(yes=>finish=yes),f=fixture(async(_input,signal)=>{captured=signal;entered();return result});
 const pending=f.call({versionId:'version'},{raw});await ready;raw.emit('aborted');finish(valid);
 const {reply}=await pending;expect(captured?.aborted).toBe(true);expect(reply.status).toBe(409);expect(reply.body.decision).toBe('blocked');expect(raw.listenerCount('aborted')).toBe(0);
});
