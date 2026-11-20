import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SessionPolicyStore} from '../src/session-policy';
import {NativeSessionScope} from '../src/native-scope';
const temporary:string[]=[];afterEach(()=>{for(const p of temporary.splice(0))rmSync(p,{recursive:true,force:true})});
function fixture(options:any={}){
 const directory=mkdtempSync(join(tmpdir(),'chimeric-scope-'));temporary.push(directory);
 const identities:any={root:{frameId:'root',rootFrameId:'root',projectId:'p',ownerId:'owner',organizationId:'org'},child:{frameId:'child',rootFrameId:'root',parentFrameId:'root',projectId:'p',ownerId:'owner',organizationId:'org'}};
 const policy=new SessionPolicyStore(directory,{lookupFrame:id=>identities[id],currentConnection:()=>undefined});
 const scope=new NativeSessionScope(policy,options);return {scope,policy,identities};
}
function request(headers:any={}){return new Request('http://127.0.0.1/messages',{method:'POST',headers})}
test('native options preserve SDK options and require actual ownership',async()=>{
 const {scope}=fixture();const controller=new AbortController();const result=scope.requestOptions({frameId:'child',callSite:'reviewer'},{},{headers:{native:'yes'},timeout:12,signal:controller.signal});
 expect(result.timeout).toBe(12);expect(result.signal).toBe(controller.signal);expect(result.headers.native).toBe('yes');
 const verified=await scope.verify(request(result.headers),{});expect(verified?.context.frameId).toBe('child');expect(verified?.context.rootFrameId).toBe('root');expect(verified?.role).toBe('reviewer');
 const missing=scope.requestOptions({frameId:'missing'},{},{});await expect(scope.verify(request(missing.headers),{})).rejects.toThrow('unavailable');
});
test('unsigned, tampered, cross-process and expired proofs never establish context',async()=>{
 let now=10000;const {scope}=fixture({now:()=>now,ttlMs:100});const proof=scope.requestOptions({frameId:'root'},{},{}).headers['x-chimeric-session-scope'];
 expect(await scope.verify(request(),{metadata:{user_id:'{"frame_id":"root"}'},class2:true})).toBeUndefined();
 for(const value of ['root',proof+'x',proof.replace(/^./,proof[0]==='a'?'b':'a')])await expect(scope.verify(request({'x-chimeric-session-scope':value}),{})).rejects.toThrow('verified native');
 await expect(fixture().scope.verify(request({'x-chimeric-session-scope':proof}),{})).rejects.toThrow();now+=101;await expect(scope.verify(request({'x-chimeric-session-scope':proof}),{})).rejects.toThrow();
});
test('metadata proof is removed and cannot contradict the request scope',async()=>{
 const {scope}=fixture();const metadata=scope.nativeMetadata({frameId:'root'},{user_id:'native',__chimeric_scope:'forged'});
 const body={metadata};expect((await scope.verify(request(),body))?.context.frameId).toBe('root');expect(body.metadata).toEqual({user_id:'native'});
 const headers=scope.requestOptions({frameId:'child'},{},{}).headers;
 await expect(scope.verify(request(headers),{metadata:scope.nativeMetadata({frameId:'root'},{})})).rejects.toThrow('disagree');
});
test('the actual native reviewer callSite overrides generic agent metadata for the same frame',async()=>{
 const {scope}=fixture();const metadata=scope.nativeMetadata({frameId:'child',lane:'agent'},{}),headers=scope.requestOptions({frameId:'child',callSite:'reviewer'},{},{}).headers;
 const result=await scope.verify(request(headers),{metadata});expect(result?.role).toBe('reviewer');
});
test('ALS follows awaited native work without bleeding into another chat',async()=>{
 const {scope}=fixture();const seen:any[]=[];const fetcher=scope.scopeFetch((async(_input:any,init:any)=>{seen.push(Object.fromEntries(init.headers));return new Response('ok')}) as any,'http://127.0.0.1:1234');
 await Promise.all(['root','child'].map(frame=>scope.withFrame(frame,async()=>{await Promise.resolve();await fetcher('http://127.0.0.1:1234/messages')})));
 const frames=await Promise.all(seen.map(async headers=>(await scope.verify(request(headers),{}))?.context.frameId));expect(frames.sort()).toEqual(['child','root']);expect(scope.currentFrame()).toBeUndefined();
 await expect(fetcher('https://example.org/')).rejects.toThrow('cannot leave');expect(seen).toHaveLength(2);
 await expect(fetcher('https://example.org/',{headers:seen[0]})).rejects.toThrow('cannot leave');
});
test('owner assertion runs before lifecycle work and bridge verification',async()=>{
 const {scope}=fixture({assertOwner:()=>{throw Error('wrong owner')}});let ran=false;
 await expect(scope.withFrame('root',()=>{ran=true})).rejects.toThrow('wrong owner');expect(ran).toBe(false);
 await expect(scope.verify(request(scope.requestOptions({frameId:'root'},{},{}).headers),{})).rejects.toThrow('wrong owner');
});
test('new standard request authority exists only inside its authenticated native handler',async()=>{
 const {scope}=fixture();let captured:any;
 await scope.withNewStandardRequest(async()=>{captured=scope.requestOptions({}, {},{}).headers;expect(await scope.verify(request(captured),{})).toMatchObject({standardRequest:true,role:'main',replayNamespace:expect.stringMatching(/^[a-f0-9]{64}$/)})});
 await expect(scope.verify(request(captured),{})).rejects.toThrow();
 const calls:any[]=[];const send=scope.scopeFetch((async(_url:any,init:any)=>{calls.push(init);return new Response('ok')}) as any,'http://127.0.0.1');
 await scope.withFrame('child',async()=>{const body=JSON.stringify({metadata:scope.nativeMetadata({frameId:'child',lane:'reviewer'},{})});await send('http://127.0.0.1/messages',{method:'POST',body})});
 expect(calls[0].headers.has('x-chimeric-session-scope')).toBe(true);
 expect((await scope.verify(request(calls[0].headers),JSON.parse(calls[0].body)))?.role).toBe('reviewer');
});
test('a not-yet-durable native frame receives temporary standard authority and never protected authority',async()=>{
 const {scope,policy}=fixture();let ran=0;
 await scope.withFrame('new-root',async()=>{
  ran++;const headers=scope.requestOptions({}, {},{}).headers;
  expect(await scope.verify(request(headers),{})).toMatchObject({standardRequest:true,role:'main'});
 });
 expect(ran).toBe(1);
 (policy as any).snapshot=()=>({sessions:[{mode:'class2'}]});
 await expect(scope.withFrame('another-new-root',()=>{ran++})).rejects.toThrow('unavailable');
 expect(ran).toBe(1);
});
test('only the checked local fetch hook can renew expired native metadata during later turns',async()=>{
 let now=1000;const {scope}=fixture({now:()=>now,ttlMs:100});const metadata=scope.nativeMetadata({frameId:'root',lane:'reviewer'},{});now+=101;
 await expect(scope.verify(request(),{metadata:{...metadata}})).rejects.toThrow();let sent:any;
 const send=scope.scopeFetch((async(_url:any,init:any)=>{sent=init;return new Response('ok')}) as any,'http://127.0.0.1');await send('http://127.0.0.1/messages',{method:'POST',body:JSON.stringify({metadata})});
 const verified=await scope.verify(request(sent.headers),JSON.parse(sent.body));expect(verified&&'context' in verified?verified.context.rootFrameId:undefined).toBe('root');expect(verified?.role).toBe('reviewer');
});
