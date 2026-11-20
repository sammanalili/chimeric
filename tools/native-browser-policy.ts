import {createHash} from 'node:crypto';
import * as t from '@babel/types';
export type NativeBrowserEdit={start:number;end:number;text:string;label:string};
const imports='import{ProtectedResourceView as ChimericResourceView,ProtectedMarkdown as ChimericMarkdown,StandardResourceOnly as ChimericStandardOnly,assertNativeResourceLease as ChimericAssertResource,nativeResourceLeaseKey as ChimericResourceKey,nativeResourceTask as ChimericResourceTask}from"/api/local/resources/component.js";\n';
const hashes:Record<string,string>={
 xo:'86ba67c6779c69458e991f3d5f4700af2cf4f745e2ff7210a429b3e9b2fafa9e',bt:'384d57f4085f38dfe4aabff2d06cf04e8b6c6c13107a784a71d2f26532650a6b',gt:'4f1c9fce9fa28dc8a9d04a760615ca950ed9eb2bd7d28efc926c707656865d0d',ue:'3f99a5fe89a9a8d3f6f0c0278d4920739d66b6ce430358cbf0dc167ae4545e30',dt:'bb7d5d80f3c59d4d7b3c8f5169b1b77d23927ae4e9d7b6480f3a0470c52dec15',lt:'8f16d9fef31d014a77249cd5c89d475b1c55a6188a6e73d59822dc36c429dc1f',Se:'70c3d480605ba9cb11b735694002a8b3d9c8da061bffb5782c7ef7e8c9b3e183',kan:'6355a4d2ff4e599906d57c0627e5f9c5eef8b45685941e3452f2d552596ddf71',Tse:'ea02048f9530f6efbcf9fb3824f7c5350805504eacc7f0cf4f6e207dc4bd8480',ha:'e578d82360595ec9b4b6096f5d7f11b0ca83e29ec011910bbf6627d43ce96fe7',Pzt:'08be5f69ce326fb0e4f8716ba1c1579968874723dc4a7eb546d464a999ec6962',Orn:'fe128ba67a2901fa8b19328e6997b817e1e88766d01ec49515c42b40fc8a4560','$a':'f79e69c11f41e685fe869015ffbe73fab922e2878c83acc2edb09cbbac891627',rn:'3254d73d87ec0ee778c5d9ab4e30aaadfe36ddddc9cba44dd6bf03a604f1c80c',ae:'605cee74756f743dfcf8c4a6c167b15057e084d62e15463508de8e6d63764941',ee:'8a8cf7e324c00c584e90eefd23cc4029184b37c26b1d868c52534cc66f045f35',v:'ab7710918b9fce811cd4141097aa20902bc741b96fdd28e70b2381334c4b9e8c',getVersionAsTextBounded:'a6a433e11b75c80e2f474f5df92ab503ee6af440012c0c5fa1bce2a2c35f992d','M$t':'7f0a64c7ec55c8493ad058caba5c22674231730555c35f83066964fc442c2940',
};
const fail=(name:string):never=>{throw Error('Native browser policy boundary changed: '+name)};
function all<T extends t.Node>(root:t.Node,predicate:(node:t.Node)=>node is T):T[]{const out:T[]=[];t.traverseFast(root,node=>{if(predicate(node))out.push(node)});return out}
function only<T>(values:T[],name:string):T{if(values.length!==1)fail(name);return values[0]}
function bounds(node:t.Node){if(node.start==null||node.end==null)fail('source bounds');return {start:node.start!,end:node.end!}}
function original(source:string,node:t.Node){const b=bounds(node);return source.slice(b.start,b.end)}
function checked<T extends t.Node>(source:string,node:T,name:string):T{if(createHash('sha256').update(original(source,node)).digest('hex')!==hashes[name])fail(name+' integrity');return node}
function fn(ast:t.Node,source:string,name:string){return checked(source,only(all(ast,(node):node is t.FunctionDeclaration=>t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name})),name),name)}
function once(source:string,from:string,to:string,name:string){if(source.split(from).length!==2)fail(name);return source.replace(from,to)}
function occurrences(source:string,from:string,to:string,count:number,name:string){if(source.split(from).length!==count+1)fail(name);return source.split(from).join(to)}
function renamed(source:string,name:string,next:string){return once(source,'function '+name+'(','function '+next+'(',name+' wrapper')}

/** Compose with other edits against the same ORIGINAL AST. Do not install
 * until native scope and server byte/storage controls are verified. A standard
 * artifact decision never authorizes an MCP mount. */
export function nativeBrowserPolicyEdits(ast:t.Node,source:string,fileName:string):NativeBrowserEdit[]{
 const file=fileName.split('/').at(-1),edits:NativeBrowserEdit[]=[];
 const replace=(node:t.Node,text:string,label:string)=>edits.push({...bounds(node),text,label});
 const add=(at:number,text:string,label:string)=>edits.push({start:at,end:at,text,label});
 if(!['ArtifactTile-CFbnK3VR.js','RightPaneTabContent-CNO7IanA.js','HtmlPreview-CXBwtfOG.js','index-BgpYmw3d.js','HostMcpAppTile-DsGRshgh.js','McpAppTile-Bud9Ahpu.js'].includes(file??''))return edits;
 if(source.includes('ChimericResourceView')||source.includes('ChimericNativeMarkdown'))fail('already applied');
 add(0,imports,'protected-resource-imports');
 if(file==='ArtifactTile-CFbnK3VR.js'){
  const node=fn(ast,source,'xo');replace(node,renamed(original(source,node),'xo','ChimericNativeArtifactPreview')+'\nfunction xo(chimericProps){const chimericPinned=chimericProps.source?.kind==="version",chimericConsumerFrameId=chimericProps.consumerFrameId??chimericProps.bindings?.chimericConsumerFrameId??chimericProps.viewerBindings?.chimericConsumerFrameId;return e.jsx(ChimericResourceView,{artifactId:chimericPinned?chimericProps.artifact?.id:void 0,versionId:chimericPinned?chimericProps.source.versionId:void 0,consumerFrameId:chimericConsumerFrameId,allowUnboundStandard:chimericProps.chimericAllowUnboundStandard===true&&chimericProps.source?.kind==="url",kind:chimericProps.previewType==="mcp-app"?"mcp":void 0,renderStandard:()=>e.jsx(ChimericNativeArtifactPreview,chimericProps)})}','protected-artifact-dispatch');
 }else if(file==='RightPaneTabContent-CNO7IanA.js'){
  const tile=checked(source,only(all(ast,(node):node is t.VariableDeclarator=>t.isVariableDeclarator(node)&&t.isIdentifier(node.id,{name:'$a'})),'$a'),'$a');let value=original(source,tile);value=once(value,'function({tab:t,projectId:n,slotChrome:o=!1})','function({tab:t,projectId:n,slotChrome:o=!1,bindings:chimericBindings})','file preview binding prop');value=once(value,'previewType:F.previewType,source:q,filename:m','previewType:F.previewType,source:q,chimericAllowUnboundStandard:!0,bindings:chimericBindings,filename:m','file preview compatibility tag');replace(tile,value,'protected-file-preview-tag');
  const render=fn(ast,source,'rn');value=once(original(source,render),'e.jsx($a,{tab:a,projectId:t,slotChrome:o})','e.jsx($a,{tab:a,projectId:t,slotChrome:o,bindings:n})','file preview binding propagation');replace(render,value,'protected-file-viewer-binding');
 }else if(file==='HtmlPreview-CXBwtfOG.js'){
  const destroy=fn(ast,source,'Se');replace(destroy.body,'{const chimericEntry=k.get(t);if(!chimericEntry)return;k.delete(t);try{we(chimericEntry)}catch{}try{chimericEntry.zoomRequestCleanup?.()}catch{}if(chimericEntry.sizeReportTimer!==null)clearTimeout(chimericEntry.sizeReportTimer);try{chimericEntry.bridge?.close()}catch{}finally{chimericEntry.wrapper.remove()}}','protected-html-destroy-finally');
  const html=fn(ast,source,'bt');let value=renamed(original(source,html),'bt','ChimericNativeHtmlPreview');
  value=once(value,'overlay:s})','overlay:s,chimericResourceLease})','HTML lease prop');
  value=occurrences(value,'ue(n)','ue(n,chimericResourceLease)',2,'HTML fetch lease');
  value=once(value,'()=>{ue(n,chimericResourceLease)}','()=>{ue(n,chimericResourceLease).catch(()=>{})}','HTML prefetch rejection');
  value=once(value,'dt(t,y)','dt(t,y,chimericResourceLease)','HTML acquire lease');
  value=once(value,'if(y)return;const E=','if(y)return;ChimericAssertResource(chimericResourceLease,{artifactId:t,versionId:n});const E=','HTML postfetch guard');
  value=once(value,'await((q=a.current)==null?void 0:q.sendSandboxResourceReady({html:F,sandbox:"allow-scripts allow-forms",permissions:{clipboardWrite:{}}}))','await ChimericResourceTask(chimericResourceLease,()=>((q=a.current)==null?void 0:q.sendSandboxResourceReady({html:F,sandbox:"allow-scripts allow-forms",permissions:{clipboardWrite:{}}})))','HTML bridge notification');
  value+='\nfunction bt(chimericProps){return o.jsx(ChimericResourceView,{artifactId:chimericProps.artifactId,versionId:chimericProps.versionId,consumerFrameId:chimericProps.consumerFrameId,onRevoke:chimericLease=>{const chimericKey=ChimericResourceKey(chimericLease);Se(chimericKey);P.delete(chimericKey)},renderStandard:chimericLease=>o.jsx(ChimericNativeHtmlPreview,{...chimericProps,chimericResourceLease:chimericLease})})}';replace(html,value,'protected-html-component');
  const refine=fn(ast,source,'gt');replace(refine,renamed(original(source,refine),'gt','ChimericNativeHtmlRefinement')+'\nfunction gt(chimericProps){return o.jsx(ChimericResourceView,{artifactId:chimericProps.artifactId,versionId:chimericProps.versionId,consumerFrameId:chimericProps.consumerFrameId,renderStandard:()=>o.jsx(ChimericNativeHtmlRefinement,chimericProps)})}','protected-html-refinement');
  const fetcher=fn(ast,source,'ue');value=original(source,fetcher);
  value=once(value,'function ue(t){','function ue(t,chimericLease){ChimericAssertResource(chimericLease,{versionId:t});const chimericKey=ChimericResourceKey(chimericLease);','HTML fetch entry');
  value=once(value,'P.get(t)','P.get(chimericKey)','HTML cache read');value=once(value,'if(n)return n;','if(n)return ChimericResourceTask(chimericLease,()=>n);','HTML cache guard');
  value=once(value,'H.getVersionAsTextBounded(t,te)','ChimericResourceTask(chimericLease,()=>H.getVersionAsTextBounded(t,te,chimericLease.signal))','HTML bounded fetch');
  value=once(value,'await mt(r.text)','await ChimericResourceTask(chimericLease,()=>mt(r.text))','HTML transform guard');
  value=once(value,'P.delete(t)','P.delete(chimericKey)','HTML cache delete');value=once(value,'P.set(t,s)','P.set(chimericKey,s)','HTML cache write');replace(fetcher,value,'protected-html-fetch');
  const pool=fn(ast,source,'dt');value=original(source,pool);
  value=once(value,'function dt(t,n){','function dt(t,n,chimericLease){ChimericAssertResource(chimericLease,{artifactId:t});const chimericKey=ChimericResourceKey(chimericLease);','HTML acquire entry');
  value=once(value,'k.get(t)','k.get(chimericKey)','HTML pool lookup');value=once(value,'lt(t),k.set(t,e)','lt(t,chimericLease),k.set(chimericKey,e)','HTML pool creation');
  value=once(value,'e.lastTouch=performance.now(),ct()','e.lastTouch=performance.now(),chimericLease.signal.addEventListener("abort",()=>Se(chimericKey),{once:true}),ct()','HTML immediate revoke');
  value=once(value,'(we(e),e.wrapper.style.display="none",e.reaper=setTimeout(()=>Se(t),nt))','Se(chimericKey)','HTML immediate release');replace(pool,value,'protected-html-pool');
  const create=fn(ast,source,'lt');value=original(source,create);value=once(value,'function lt(t){','function lt(t,chimericLease){ChimericAssertResource(chimericLease,{artifactId:t});','HTML create entry');
  value=once(value,'if(h!=="ready")','ChimericAssertResource(chimericLease,{artifactId:t});if(h!=="ready")','HTML proxy readiness');
  value=once(value,'async({content:w})=>{','async({content:w})=>{ChimericAssertResource(chimericLease,{artifactId:t});','HTML update entry');
  value=once(value,'try{await f;const S=','try{await f;ChimericAssertResource(chimericLease,{artifactId:t});const S=','HTML queued update');
  value=once(value,'await d.connect(new Ie(i.iframe.contentWindow,i.iframe.contentWindow))','await ChimericResourceTask(chimericLease,()=>d.connect(new Ie(i.iframe.contentWindow,i.iframe.contentWindow)),()=>d.close())','HTML connect guard');replace(create,value,'protected-html-create');
 }else if(file==='index-BgpYmw3d.js'){
  // The artifact route already distinguishes an in-app overlay from a direct
  // link: its close callback goes back for the former and replaces the URL
  // with the owning project for the latter. The desktop overlay hid the only
  // route-level control, however, which stranded full-screen image viewers.
  // Expose that existing callback without changing its history semantics.
  const overlay=fn(ast,source,'M$t');let overlayValue=original(source,overlay);
  overlayValue=once(overlayValue,'className:`items-center justify-end px-3 h-11 md:h-9 border-b border-border-300 shrink-0 ${e.kind==="artifact"?"flex md:hidden":"flex"}`','className:`items-center ${e.kind==="artifact"?"justify-start":"justify-end"} px-3 h-11 md:h-9 border-b border-border-300 shrink-0 flex`','artifact overlay navigation visibility');
  overlayValue=once(overlayValue,'className:"h-11 w-11 md:h-auto md:w-auto flex items-center justify-center md:p-1.5 rounded-lg text-text-300 hover:text-text-000 hover:bg-bg-300 transition-colors","aria-label":"Close",children:a.jsx(Ul,{size:16})','className:e.kind==="artifact"?"h-9 px-3 flex items-center justify-center rounded-lg text-sm font-medium text-text-300 hover:text-text-000 hover:bg-bg-300 transition-colors":"h-11 w-11 md:h-auto md:w-auto flex items-center justify-center md:p-1.5 rounded-lg text-text-300 hover:text-text-000 hover:bg-bg-300 transition-colors","aria-label":e.kind==="artifact"?"Back":"Close",title:e.kind==="artifact"?"Back":"Close","data-testid":e.kind==="artifact"?"artifact-overlay-back":"overlay-close",children:e.kind==="artifact"?"← "+(globalThis.ChimericI18n?.t?.("Back")??"Back"):a.jsx(Ul,{size:16})','artifact overlay navigation control');
  replace(overlay,overlayValue,'artifact-overlay-navigation');
  const pane=fn(ast,source,'Orn');let paneValue=original(source,pane);paneValue=once(paneValue,'c=f.useMemo(()=>n.find(oe=>oe.kind==="session")??null,[n]),u=','c=f.useMemo(()=>n.find(oe=>oe.kind==="session")??null,[n]),chimericBindings=f.useMemo(()=>({...t,...(c?.rootFrameId?{chimericConsumerFrameId:c.rootFrameId}:{})}),[t,c?.rootFrameId]),u=','viewer frame binding');paneValue=occurrences(paneValue,'bindings:t','bindings:chimericBindings',5,'viewer binding propagation');replace(pane,paneValue,'protected-viewer-frame-binding');
  const gate=fn(ast,source,'Pzt');replace(gate,renamed(original(source,gate),'Pzt','ChimericNativeRemoteImage')+'\nfunction Pzt(chimericProps){return a.jsx(ChimericStandardOnly,{renderStandard:()=>a.jsx(ChimericNativeRemoteImage,chimericProps)})}','protected-markdown-host-gate');
  const markdown=checked(source,only(all(ast,(node):node is t.VariableDeclarator=>t.isVariableDeclarator(node)&&t.isIdentifier(node.id,{name:'ha'})),'ha'),'ha');
  replace(markdown.id,'ChimericNativeMarkdown','protected-markdown-original');
  const declaration=only(all(ast,(node):node is t.VariableDeclaration=>t.isVariableDeclaration(node)&&node.declarations.includes(markdown)),'ha declaration');
  add(declaration.end!,'\nfunction ha(chimericProps){return a.jsx(ChimericMarkdown,{content:chimericProps.content,renderStandard:()=>a.jsx(ChimericNativeMarkdown,chimericProps)})}\n','protected-markdown-dispatch');
  const mount=fn(ast,source,'kan');replace(mount.body,'{throw new Error("Interactive connector previews require a verified server-owned widget binding.")}','protected-mcp-pool-acquire');
  const release=fn(ast,source,'Tse');replace(release.body,'{const chimericEntry=QS.get(e);if(chimericEntry){if(chimericEntry.reaper)clearTimeout(chimericEntry.reaper);chimericEntry.destroy()}}','protected-mcp-immediate-destroy');
  const method=checked(source,only(all(ast,(node):node is t.ObjectMethod|t.ClassMethod=>(t.isObjectMethod(node)||t.isClassMethod(node))&&t.isIdentifier(node.key,{name:'getVersionAsTextBounded'})),'bounded version API'),'getVersionAsTextBounded');
  let value=original(source,method);value=once(value,'getVersionAsTextBounded(t,n)','getVersionAsTextBounded(t,n,chimericResourceSignal)','bounded version signal');
  value=once(value,'{credentials:"include",headers:ls()}','{credentials:"include",headers:ls(),...chimericResourceSignal?{signal:chimericResourceSignal,redirect:"error",cache:"no-store"}:{}}','bounded version fetch cancellation');replace(method,value,'protected-html-native-fetch-signal');
 }else if(file==='HostMcpAppTile-DsGRshgh.js'){
  const host=fn(ast,source,'ae');replace(host,renamed(original(source,host),'ae','ChimericNativeHostMcpApp')+'\nfunction ae(chimericProps){return w.jsx(ChimericResourceView,{kind:"mcp",renderStandard:()=>w.jsx(ChimericNativeHostMcpApp,chimericProps)})}','protected-mcp-host-component');
  const resource=fn(ast,source,'ee');replace(resource.body,'{throw new Error("Connector resources require a verified server-owned widget binding.")}','protected-mcp-resource-fetch');
 }else if(file==='McpAppTile-Bud9Ahpu.js'){
  const app=fn(ast,source,'v');replace(app,renamed(original(source,app),'v','ChimericNativeMcpApp')+'\nfunction v(chimericProps){return r.jsx(ChimericResourceView,{kind:"mcp",renderStandard:()=>r.jsx(ChimericNativeMcpApp,chimericProps)})}','protected-mcp-direct-component');
 }
 return edits;
}
