import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../src/protected-resource-view.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function ').replaceAll('export async function ','async function ');
const standard=(extra:any={})=>({decision:'standard',artifactId:'artifact-a',versionId:'version-a',checksum:'a'.repeat(64),sourceRootFrameId:'root-source',consumerRootFrameId:'root-consumer',policyRevision:1,...extra});
function fixture(extra:any={}){
 const callbacks:Function[]=[],timers:any[]=[],changes:any[]=[],revocations:any[]=[];let context:any=null;
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const React={createContext:()=>({Provider:'standard-provider'}),useContext:()=>context,useRef:(value:any)=>({current:value}),useState:(value:any)=>[typeof value==='function'?value():value,()=>{}],useLayoutEffect(){}};
 const api=runInNewContext(source+';({lookupOf,normalizeSnapshot,raster,loadPolicy,createController,makeLease,revoke,InertView,ProtectedResourceView,ProtectedMarkdown,StandardResourceOnly,assertNativeResourceLease,nativeResourceLeaseKey,nativeResourceTask,invalidateProtectedResources})',{React,jsx,TextEncoder,TextDecoder,URLSearchParams,AbortController,DOMException,Uint8Array,DataView,atob,btoa,fetch,subscribeProviderEvents:()=>()=>{},setTimeout,clearTimeout,...extra});
 const controller=(read:Function,lookup:any=api.lookupOf({artifactId:'artifact-a',versionId:'version-a',consumerFrameId:'child-consumer'}))=>api.createController(lookup,{read,onChange:(...value:any[])=>changes.push(value),onRevoke:(lease:any)=>revocations.push(lease),watch:(callback:Function)=>{callbacks.push(callback);return()=>callbacks.splice(callbacks.indexOf(callback),1)},schedule:(callback:Function,delay:number)=>{const timer={callback,delay,cleared:false};timers.push(timer);return timer},unschedule:(timer:any)=>{if(timer)timer.cleared=true}});
 return {...api,controller,callbacks,timers,changes,revocations,context(value:any){context=value}};
}
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
test('unknown, missing or conflicting exact source bindings never become standard',()=>{
 const f=fixture(),lookup=f.lookupOf({artifactId:'artifact-a',versionId:'version-a',consumerFrameId:'child-consumer'});
 expect(lookup).toEqual({versionId:'version-a',artifactHint:'artifact-a',consumerFrameId:'child-consumer'});
 for(const props of [{},{versionId:'../secret'},{artifactId:'valid',consumerFrameId:'x/y'},{versionId:42}])expect(f.lookupOf(props)).toBeNull();
 for(const value of [null,{},standard({artifactId:'wrong'}),standard({versionId:'wrong'}),standard({sourceRootFrameId:null}),standard({checksum:'sha256:guess'}),standard({consumerRootFrameId:null}),standard({policyRevision:-1}),standard({policyRevision:NaN}),standard({decision:'inert'})])expect(f.normalizeSnapshot(value,lookup).decision).toBe('blocked');
 expect(f.normalizeSnapshot(standard(),lookup)).toEqual(standard());
 expect(f.normalizeSnapshot(standard({consumerRootFrameId:undefined}),f.lookupOf({versionId:'version-a'}))).toEqual(standard({consumerRootFrameId:null}));
 const unbound=f.lookupOf({allowUnboundStandard:true,consumerFrameId:'child-consumer'});expect(unbound).toEqual({unbound:true,consumerFrameId:'child-consumer'});expect(f.lookupOf({consumerFrameId:'child-consumer'})).toBeNull();
 expect(f.normalizeSnapshot({decision:'standard-unbound',policyRevision:2,consumerRootFrameId:'root-consumer'},unbound)).toMatchObject({decision:'standard',unbound:true,artifactId:null,versionId:null,consumerRootFrameId:'root-consumer'});
 for(const value of [{decision:'standard-unbound',policyRevision:-1},{decision:'standard-unbound',policyRevision:2},{decision:'standard',policyRevision:2,consumerRootFrameId:'root-consumer'}])expect(f.normalizeSnapshot(value,unbound).decision).toBe('blocked');
});
test('controller stays blocked before a verified reply and synchronously revokes before policy refresh',async()=>{
 const f=fixture();let complete:any;const c=f.controller(()=>new Promise(resolve=>complete=resolve));const pending=c.refresh();expect(c.getSnapshot().decision).toBe('blocked');expect(c.getLease()).toBeNull();complete(standard());await pending;
 const lease=c.getLease(),key=f.nativeResourceLeaseKey(lease);expect(f.assertNativeResourceLease(lease,{artifactId:'artifact-a',versionId:'version-a'})).toEqual(standard());f.callbacks[0]();
 expect(c.getSnapshot().decision).toBe('blocked');expect(lease.signal.aborted).toBe(true);expect(f.revocations).toEqual([lease]);expect(()=>f.assertNativeResourceLease(lease)).toThrow();expect(f.nativeResourceLeaseKey(lease)).toBe(key);c.dispose();expect(f.callbacks).toHaveLength(0);
});
test('stale reads resolving after another revision or disposal cannot restore a lease',async()=>{
 const f=fixture(),pending:any[]=[],c=f.controller((_lookup:any,signal:AbortSignal)=>new Promise(resolve=>pending.push({resolve,signal})));const first=c.refresh();f.callbacks[0]();expect(pending[0].signal.aborted).toBe(true);
 pending[1].resolve(standard({decision:'inert-text',text:'protected'}));await settle();expect(c.getSnapshot().decision).toBe('inert-text');pending[0].resolve(standard());await first;expect(c.getSnapshot().decision).toBe('inert-text');expect(c.getLease()).toBeNull();
 const third=c.refresh();c.dispose();expect(pending[2].signal.aborted).toBe(true);pending[2].resolve(standard());await third;expect(c.getLease()).toBeNull();
});
test('forged, cloned, wrong-version and revoked leases fail, and tasks cancel pending work without late authority',async()=>{
 const f=fixture(),lease=f.makeLease(standard());for(const value of [undefined,null,{},Object.freeze({signal:lease.signal}),{...lease}])expect(()=>f.assertNativeResourceLease(value)).toThrow();
 expect(()=>f.assertNativeResourceLease(lease,{versionId:'other'})).toThrow();let finish:any,cleaned=0,started=0;
 const task=f.nativeResourceTask(lease,()=>{started++;return new Promise(resolve=>finish=resolve)},()=>cleaned++);await settle();expect(started).toBe(1);f.revoke(lease);await expect(task).rejects.toMatchObject({name:'AbortError'});expect(cleaned).toBe(1);finish('late');await settle();expect(()=>f.assertNativeResourceLease(lease)).toThrow();
 let calls=0;await expect(f.nativeResourceTask(lease,()=>calls++)).rejects.toThrow();expect(calls).toBe(0);
 const cleanupFailure=f.makeLease(standard()),cancelled=f.nativeResourceTask(cleanupFailure,()=>new Promise(()=>{}),()=>{throw Error('Broken bridge cleanup')});await settle();f.revoke(cleanupFailure);await expect(cancelled).rejects.toMatchObject({name:'AbortError'});
 const unbound=f.makeLease({decision:'standard',unbound:true,artifactId:null,versionId:null,checksum:null,sourceRootFrameId:null,consumerRootFrameId:'root-consumer',policyRevision:2});expect(f.assertNativeResourceLease(unbound).unbound).toBe(true);expect(()=>f.assertNativeResourceLease(unbound,{artifactId:'artifact-a'})).toThrow();expect(()=>f.assertNativeResourceLease(unbound,{versionId:'version-a'})).toThrow();
});
test('leases expire and root-wide precommit invalidation cancels all currently mounted bindings',async()=>{
 const f=fixture(),a=f.controller(async()=>standard()),b=f.controller(async()=>standard());await a.refresh();await b.refresh();const left=a.getLease(),right=b.getLease();f.invalidateProtectedResources();expect(left.signal.aborted).toBe(true);expect(right.signal.aborted).toBe(true);expect(a.getSnapshot().decision).toBe('blocked');expect(b.getSnapshot().decision).toBe('blocked');await settle();
 const fresh=a.getLease();const timer=f.timers.filter(value=>!value.cleared&&value.delay===15000).at(-2);expect(timer).toBeDefined();timer.callback();expect(fresh.signal.aborted).toBe(true);a.dispose();b.dispose();
});
test('policy fetch uses a single lookup key, no cache/redirect, and bounds bytes before JSON parsing',async()=>{
 const calls:any[]=[],f=fixture({fetch:async(...args:any[])=>{calls.push(args);return new Response(JSON.stringify(standard()),{headers:{'content-type':'application/json'}})}}),signal=new AbortController().signal;
 expect(await f.loadPolicy(f.lookupOf({artifactId:'artifact-a',versionId:'version-a',consumerFrameId:'consumer-child'}),signal)).toEqual(standard());const [url,options]=calls[0],query=new URL(url,'https://local.example').searchParams;expect([...query.keys()]).toEqual(['versionId','consumerFrameId']);expect(query.get('consumerFrameId')).toBe('consumer-child');expect(options).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error',signal});
 let reads=0;const tooLarge=fixture({fetch:async()=>({ok:true,headers:new Headers({'content-length':String(7*1024*1024)}),body:{getReader(){reads++;throw Error('Must not read')}}})});await expect(tooLarge.loadPolicy({versionId:'version-a'},signal)).rejects.toThrow('too large');expect(reads).toBe(0);
 let cancelled=0,step=0;const streamed=fixture({fetch:async()=>({ok:true,headers:new Headers(),body:{getReader:()=>({async read(){step++;return {done:false,value:new Uint8Array(4*1024*1024)}},async cancel(){cancelled++}})}})});await expect(streamed.loadPolicy({versionId:'version-a'},signal)).rejects.toThrow('too large');expect(step).toBe(2);expect(cancelled).toBe(1);
 calls.length=0;await f.loadPolicy(f.lookupOf({allowUnboundStandard:true,consumerFrameId:'consumer-child'}),signal);expect(calls[0][0]).toBe('/api/local/resources/unbound?consumerFrameId=consumer-child');
});
test('inert content is escaped React text; Markdown, plugins, remote hosts and inline slots never mount without a live standard binding',()=>{
 const f=fixture(),content='<svg onload="fetch(secret)"></svg> ![image](https://remote.invalid/a) [link](https://remote.invalid/b)';let mounts=0;
 const inert=f.InertView({snapshot:{decision:'inert-text',text:content}});expect(inert.type).toBe('pre');expect(inert.props.children).toBe(content);expect(inert.props.dangerouslySetInnerHTML).toBeUndefined();expect(inert.props.href).toBeUndefined();expect(inert.props.src).toBeUndefined();
 const raw=f.ProtectedMarkdown({content,renderStandard:()=>{mounts++;throw Error('No rich mount')}});expect(raw.type).toBe('pre');expect(raw.props.children).toBe(content);const host=f.StandardResourceOnly({renderStandard:()=>mounts++});expect(host.props.snapshot.decision).toBe('blocked');expect(mounts).toBe(0);
 const lease=f.makeLease(standard());f.context(lease);expect(f.ProtectedMarkdown({content,renderStandard:()=>++mounts})).toBe(1);expect(f.StandardResourceOnly({renderStandard:()=>++mounts})).toBe(2);f.revoke(lease);expect(f.ProtectedMarkdown({content,renderStandard:()=>++mounts}).type).toBe('pre');expect(mounts).toBe(2);
});
test('inert image support accepts only bounded static PNG bytes, never URLs, SVG, animated PNG or appended content',()=>{
 const f=fixture(),png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ZkAAAAASUVORK5CYII=';expect(f.raster(png)).toBe(png);
 for(const value of ['https://remote.invalid/a.png','blob:local','data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',png+'AAAA','data:image/png;base64,AA=='])expect(f.raster(value)).toBeNull();
 const raw=Buffer.from(png.slice(22),'base64'),animation=Buffer.alloc(20);animation.writeUInt32BE(8);animation.write('acTL',4);const animated='data:image/png;base64,'+Buffer.concat([raw.subarray(0,33),animation,raw.subarray(33)]).toString('base64');expect(f.raster(animated)).toBeNull();
 const lookup=f.lookupOf({versionId:'version-a'});expect(f.normalizeSnapshot(standard({decision:'inert-image',imageData:png}),lookup).decision).toBe('inert-image');expect(f.normalizeSnapshot(standard({decision:'inert-text',text:'x'.repeat(256*1024+1)}),lookup).decision).toBe('blocked');
 const image=f.InertView({snapshot:{decision:'inert-image',imageData:png}});expect(image.type).toBe('img');expect(image.props.src).toBe(png);expect(image.props.referrerPolicy).toBe('no-referrer');
});
test('interactive MCP has no native fallback even with standard context and does not start a policy fetch',()=>{
 let reads=0,effects=0;const f=fixture({fetch:()=>{reads++;throw Error('No resource fetch')},React:{createContext:()=>({Provider:'context'}),useContext:()=>null,useRef:(value:any)=>({current:value}),useState:(value:any)=>[value,()=>{}],useLayoutEffect:(callback:Function)=>{effects++;callback()}}});let mounted=0;
 const tree=f.ProtectedResourceView({kind:'mcp',artifactId:'artifact-a',versionId:'version-a',renderStandard:()=>mounted++});expect(tree.props.snapshot.decision).toBe('blocked');expect(mounted).toBe(0);expect(reads).toBe(0);expect(effects).toBe(1);
});
