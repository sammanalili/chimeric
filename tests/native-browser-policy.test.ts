import {expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {nativeBrowserPolicyEdits,type NativeBrowserEdit} from '../tools/native-browser-policy';

const archive=resolve(import.meta.dir,'../../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz'),nativeTest=existsSync(archive)?test:test.skip;
const files=['ArtifactTile-CFbnK3VR.js','HtmlPreview-CXBwtfOG.js','index-BgpYmw3d.js','HostMcpAppTile-DsGRshgh.js','McpAppTile-Bud9Ahpu.js','RightPaneTabContent-CNO7IanA.js'];
const chunks=new Map<string,{original:string,patched:string,ast:t.File}>();
function apply(source:string,edits:NativeBrowserEdit[]){const sorted=[...edits].sort((a,b)=>b.start-a.start);for(let i=1;i<sorted.length;i++)expect(sorted[i].end).toBeLessThanOrEqual(sorted[i-1].start);for(const edit of sorted)source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);return source}
function fixture(file:string){if(chunks.has(file))return chunks.get(file)!;const result=Bun.spawnSync(['/usr/bin/tar','-xOf',archive,'./web-dist/assets/'+file],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode).toBe(0);const original=result.stdout.toString(),patched=apply(original,nativeBrowserPolicyEdits(parse(original,{sourceType:'module'}),original,file)),ast=parse(patched,{sourceType:'module'}),value={original,patched,ast};chunks.set(file,value);return value}
function text(file:string,name:string){const {patched,ast}=fixture(file),nodes:t.FunctionDeclaration[]=[];t.traverseFast(ast,node=>{if(t.isFunctionDeclaration(node)&&node.id?.name===name)nodes.push(node)});expect(nodes).toHaveLength(1);return patched.slice(nodes[0].start!,nodes[0].end!)}
function compile(file:string,names:string[],globals:Record<string,unknown>={}){return Function(...Object.keys(globals),names.map(name=>text(file,name)).join(';')+';return {'+names.join(',')+'}')(...Object.values(globals))}
function policy(){const source=readFileSync(new URL('../src/protected-resource-view.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function ').replaceAll('export async function ','async function ');return runInNewContext(source+';({makeLease,revoke,assertNativeResourceLease,nativeResourceLeaseKey,nativeResourceTask})',{React:{createContext:()=>({})},jsx:{},AbortController,DOMException,setTimeout,clearTimeout})}
const standard=(extra:any={})=>({decision:'standard',artifactId:'artifact-a',versionId:'version-a',checksum:'a'.repeat(64),sourceRootFrameId:'root-a',consumerRootFrameId:'root-b',policyRevision:1,...extra});
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));

nativeTest('all six exact native chunks accept checked edits, remain parseable, and reject duplicate/drifted application',()=>{
 for(const file of files){const f=fixture(file);expect(f.patched).toContain('from"/api/local/resources/component.js"');expect(()=>nativeBrowserPolicyEdits(f.ast,f.patched,file)).toThrow('already applied')}
 const f=fixture('HtmlPreview-CXBwtfOG.js'),changed=f.original.replace('function ue(t){','function ue(t){void 0;');expect(changed).not.toBe(f.original);expect(()=>nativeBrowserPolicyEdits(parse(changed,{sourceType:'module'}),changed,'HtmlPreview-CXBwtfOG.js')).toThrow('integrity');
 expect(nativeBrowserPolicyEdits(parse('const unchanged=1'), 'const unchanged=1','unrelated.js')).toEqual([]);
 const pane=text('index-BgpYmw3d.js','Orn');expect(pane.split('bindings:chimericBindings')).toHaveLength(6);expect(pane).not.toContain('bindings:t');const right=fixture('RightPaneTabContent-CNO7IanA.js').patched;expect(right).toContain('chimericAllowUnboundStandard:!0,bindings:chimericBindings');expect(right).toContain('slotChrome:o,bindings:n');
},30000);
nativeTest('full-screen artifact links expose Back while retaining in-app history and direct-link fallback behavior',()=>{
 const overlay=text('index-BgpYmw3d.js','M$t'),route=text('index-BgpYmw3d.js','Xln');
 expect(overlay).toContain('"data-testid":e.kind==="artifact"?"artifact-overlay-back":"overlay-close"');
 expect(overlay).toContain('"aria-label":e.kind==="artifact"?"Back":"Close"');
 expect(overlay).toContain('e.kind==="artifact"?"justify-start":"justify-end"');
 expect(overlay).not.toContain('flex md:hidden');
 // openInPage marks an in-app transition. Close uses history only for that
 // state; a copied URL has no marker and returns to its owning project.
 expect(route).toContain('state:{overlayReturn:!0}');
 expect(route).toContain('T?s(-1):s(`/projects/${d}`,{replace:!0})');
},30000);
nativeTest('central and direct wrappers defer every native effect/fetch until their guard selects a verified standard view',()=>{
 const element=(type:any,props:any)=>({type,props}),jsx={jsx:element},guard=()=>{};
 const a=compile(files[0],['xo'],{e:jsx,ChimericResourceView:guard,ChimericNativeArtifactPreview(){throw Error('No native body before approval')}}).xo({source:{kind:'version',versionId:'version-a'},artifact:{id:'artifact-a'},consumerFrameId:'child-a',previewType:'html'});
 expect(a.type).toBe(guard);expect(a.props).toMatchObject({artifactId:'artifact-a',versionId:'version-a',consumerFrameId:'child-a'});
 const arbitrary=compile(files[0],['xo'],{e:jsx,ChimericResourceView:guard}).xo({source:{kind:'url',url:'https://remote.invalid/a.html'},artifact:{id:'artifact-a'}});expect(arbitrary.props.allowUnboundStandard).toBe(false);
 const file=compile(files[0],['xo'],{e:jsx,ChimericResourceView:guard}).xo({source:{kind:'url',url:'/api/compute/local/download?path=x'},chimericAllowUnboundStandard:true,bindings:{chimericConsumerFrameId:'child-b'},artifact:{id:'artifact-a'}});expect(file.props).toMatchObject({allowUnboundStandard:true,consumerFrameId:'child-b'});expect(file.props.artifactId).toBeUndefined();expect(file.props.versionId).toBeUndefined();
 for(const [file,name,runtime]of [[files[1],'bt','o'],[files[1],'gt','o'],[files[3],'ae','w'],[files[4],'v','r']] as const){const result=compile(file,[name],{[runtime]:jsx,ChimericResourceView:guard})[name]({artifactId:'artifact-a',versionId:'version-a'});expect(result.type).toBe(guard);if(name==='ae'||name==='v')expect(result.props.kind).toBe('mcp')}
 for(const [name,protectedName]of [['Pzt','ChimericStandardOnly'],['ha','ChimericMarkdown']] as const){const result=compile(files[2],[name],{a:jsx,[protectedName]:guard})[name]({content:'![image](https://remote.invalid)'});expect(result.type).toBe(guard)}
});
nativeTest('direct HTML cache/fetch/create/acquire calls reject missing or forged bindings before DOM or byte access',()=>{
 const p=policy();let io=0;const globals={ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceKey:p.nativeResourceLeaseKey,P:new Map,H:{getVersionAsTextBounded(){io++;throw Error('No bytes')}},document:{createElement(){io++;throw Error('No DOM')}},k:new Map};
 const native=compile(files[1],['ue','dt','lt'],globals);
 for(const lease of [undefined,{},Object.freeze({signal:new AbortController().signal})])for(const call of [()=>native.ue('version-a',lease),()=>native.dt('artifact-a',{},lease),()=>native.lt('artifact-a',lease)])expect(call).toThrow('binding');expect(io).toBe(0);
});
nativeTest('actual native HTML pool destroys its iframe/bridge immediately on revoke and cannot reuse a same-artifact older version',()=>{
 const p=policy(),lease=p.makeLease(standard()),next=p.makeLease(standard({versionId:'version-b',policyRevision:2})),key=p.nativeResourceLeaseKey(lease);let removed=0,closed=0,cleaned=0,timers=0;
 const slot={},entry:any={reaper:null,claimants:[],activeSlots:new Set,wrapper:{style:{},appendChild(){},remove(){removed++}},bridge:{close(){closed++}},zoomListeners:new Set,sizeReportTimer:null,zoomRequestCleanup(){cleaned++}},pool=new Map([[key,entry]]);
 const globals:any={ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceKey:p.nativeResourceLeaseKey,k:pool,lt:()=>{throw Error('A new version cannot reuse the old pool')},ct(){},W(){},it(){},_(){},we(){},performance:{now:()=>1},document:{createElement:()=>({style:{},remove(){}})},setTimeout(){timers++;return 1},clearTimeout(){}};
 const native=compile(files[1],['Se','dt'],globals),handle=native.dt('artifact-a',slot,lease);expect(entry.activeSlots.has(slot)).toBe(true);p.revoke(lease);expect(removed).toBe(1);expect(closed).toBe(1);expect(cleaned).toBe(1);expect(pool.size).toBe(0);expect(timers).toBe(0);handle.release();expect(removed).toBe(1);expect(()=>native.dt('artifact-a',{},next)).toThrow('new version');
});
nativeTest('actual native pool release also destroys a standard view immediately instead of hiding a live iframe for a reaper',()=>{
 const p=policy(),lease=p.makeLease(standard()),key=p.nativeResourceLeaseKey(lease);let removed=0,closed=0;
 const entry:any={reaper:null,claimants:[],activeSlots:new Set,wrapper:{style:{},appendChild(){},remove(){removed++}},bridge:{close(){closed++}},zoomListeners:new Set,sizeReportTimer:null},pool=new Map([[key,entry]]),globals={ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceKey:p.nativeResourceLeaseKey,k:pool,lt(){throw Error('No create')},ct(){},W(){},it(){},_(){},we(){},performance:{now:()=>1},document:{createElement:()=>({style:{},remove(){}})},clearTimeout(){}};
 const native=compile(files[1],['Se','dt'],globals),handle=native.dt('artifact-a',{},lease);handle.release();expect(removed).toBe(1);expect(closed).toBe(1);expect(pool.size).toBe(0);p.revoke(lease);expect(removed).toBe(1);
});
nativeTest('HTML fetch passes the bound abort signal through native auth fetch and does not reuse a revoked cache',async()=>{
 const p=policy(),lease=p.makeLease(standard()),calls:any[]=[],cache=new Map;let transform=0;
 const native=compile(files[1],['ue'],{ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceKey:p.nativeResourceLeaseKey,ChimericResourceTask:p.nativeResourceTask,P:cache,H:{async getVersionAsTextBounded(...args:any[]){calls.push(args);return {text:'<b>standard</b>'}}},te:1024,ft:10,Blob,mt:async(value:string)=>{transform++;return value}});
 expect(await native.ue('version-a',lease)).toBe('<b>standard</b>');expect(calls).toEqual([['version-a',1024,lease.signal]]);expect(transform).toBe(1);expect(await native.ue('version-a',lease)).toBe('<b>standard</b>');expect(calls).toHaveLength(1);
 p.revoke(lease);expect(()=>native.ue('version-a',lease)).toThrow('binding');expect(calls).toHaveLength(1);
 const {patched,ast}=fixture(files[2]);let method:any;t.traverseFast(ast,node=>{if((t.isObjectMethod(node)||t.isClassMethod(node))&&t.isIdentifier(node.key,{name:'getVersionAsTextBounded'}))method=node});const requests:any[]=[],object=Function('fetch','ls','as','wi','return new class{'+patched.slice(method.start,method.end)+'}')((...args:any[])=>{requests.push(args);return Promise.resolve({ok:true})},()=>({'x-native-auth':'synthetic'}),{isEipc:true,readTextBounded:()=>({text:'ok'})},()=>{});object.getVersionUrl=()=>'/api/artifacts/versions/version-a';
 await object.getVersionAsTextBounded('version-a',1024,lease.signal);expect(requests[0][1]).toMatchObject({credentials:'include',headers:{'x-native-auth':'synthetic'},signal:lease.signal,redirect:'error',cache:'no-store'});
});
nativeTest('late text/transform completions cannot reach a preview after its exact resource binding is revoked',async()=>{
 const p=policy(),lease=p.makeLease(standard());let complete:any,started=0;
 const native=compile(files[1],['ue'],{ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceKey:p.nativeResourceLeaseKey,ChimericResourceTask:p.nativeResourceTask,P:new Map,H:{async getVersionAsTextBounded(){return {text:'<b>standard</b>'}}},te:1024,ft:10,Blob,mt:()=>{started++;return new Promise(resolve=>complete=resolve)}});
 const pending=native.ue('version-a',lease);await settle();expect(started).toBe(1);p.revoke(lease);await expect(pending).rejects.toMatchObject({name:'AbortError'});complete('<img src="https://remote.invalid">');await settle();expect(()=>native.ue('version-a',lease)).toThrow('binding');
});
nativeTest('a failed bridge close cannot leave its actual iframe alive during revocation',()=>{
 const p=policy(),lease=p.makeLease(standard()),key=p.nativeResourceLeaseKey(lease);let removed=0;
 const entry={wrapper:{remove(){removed++}},bridge:{close(){throw Error('Synthetic close failure')}},sizeReportTimer:null},pool=new Map([[key,entry]]);
 const native=compile(files[1],['Se'],{k:pool,we(){throw Error('Synthetic animation failure')},clearTimeout(){}});expect(()=>native.Se(key)).not.toThrow();expect(removed).toBe(1);expect(pool.size).toBe(0);
});
nativeTest('an aborted proxy readiness cannot construct a late AppBridge or deliver queued widget content',async()=>{
 const p=policy(),lease=p.makeLease(standard());let finish:any,bridges=0,removed=0;
 const ready=new Promise(resolve=>finish=resolve),iframe={contentWindow:{},remove(){removed++}},wrapper={style:{},setAttribute(){},appendChild(){},remove(){removed++}};
 const native=compile(files[1],['lt'],{ChimericAssertResource:p.assertNativeResourceLease,ChimericResourceTask:p.nativeResourceTask,document:{createElement:()=>wrapper,body:{appendChild(){}}},performance:{now:()=>1},fe:{},be:()=>({}),Pe:()=>({url:new URL('https://sandbox.invalid'),hostKind:'synthetic'}),De:()=>({iframe,onReady:ready}),window:{addEventListener(){},removeEventListener(){}},le:1000,setTimeout:()=>1,He:class{constructor(){bridges++}},ee(){}});
 const entry=native.lt('artifact-a',lease);p.revoke(lease);finish();await expect(entry.bridgeReady).rejects.toThrow('binding');await settle();expect(bridges).toBe(0);expect(entry.bridge).toBeNull();
});
nativeTest('direct MCP pool and connector resource helpers fail before any bridge, resource request, host settings or tools execute',()=>{
 let io=0;const globals={fetch(){io++;throw Error('No fetch')},QS:{get(){io++;throw Error('No pool')}},document:{createElement(){io++;throw Error('No DOM')}}};
 expect(()=>compile(files[2],['kan'],globals).kan({},{})).toThrow('server-owned');expect(()=>compile(files[3],['ee'],globals).ee('connector','ui://resource')).toThrow('server-owned');expect(io).toBe(0);
 let destroyed=0,cleared=0;const entry={reaper:1,destroy(){destroyed++}};compile(files[2],['Tse'],{QS:new Map([['mount',entry]]),clearTimeout(){cleared++}}).Tse('mount',{});expect(destroyed).toBe(1);expect(cleared).toBe(1);
});
