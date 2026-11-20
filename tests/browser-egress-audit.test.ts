import {expect,test} from 'bun:test';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

// These tests pin the inspected ORIGINAL revision and exercise its pure policy
// builders. They do not execute artifact scripts or claim browser confinement.
const original=resolve(import.meta.dir,'../../../work/runtime-recovery/original');
const corePath=resolve(original,'claude-science'),archive=resolve(original,'assets.tar-j2zctwzf.gz');
const auditTest=existsSync(corePath)&&existsSync(archive)?test:test.skip;
type Fixture={source:string;functions:Map<string,t.FunctionDeclaration>;values:Map<string,t.Expression>;methods:Map<string,t.ClassMethod>};
let cached:Fixture|undefined;
function fixture(){
 if(cached)return cached;
 const source=readFileSync(corePath,'utf8');
 expect(createHash('sha256').update(source).digest('hex')).toBe('e3674e221f9079520f014eb2ef93d0ba151934a47fd561594efcb23a86809e0b');
 const ast=parse(source,{sourceType:'unambiguous'}),functions=new Map<string,t.FunctionDeclaration>(),values=new Map<string,t.Expression>(),methods=new Map<string,t.ClassMethod>();
 t.traverseFast(ast,node=>{if(t.isFunctionDeclaration(node)&&node.id)functions.set(node.id.name,node);if(t.isAssignmentExpression(node)&&t.isIdentifier(node.left)&&t.isExpression(node.right))values.set(node.left.name,node.right);if(t.isVariableDeclarator(node)&&t.isIdentifier(node.id)&&node.init&&t.isExpression(node.init))values.set(node.id.name,node.init);if(t.isClassMethod(node)&&t.isIdentifier(node.key))methods.set(node.key.name,node)});
 return cached={source,functions,values,methods};
}
function text(name:string){const f=fixture(),node=f.functions.get(name);if(!node)throw Error('Original audit boundary missing: '+name);return f.source.slice(node.start!,node.end!)}
function value(name:string){const f=fixture(),node=f.values.get(name);if(!node)throw Error('Original audit value missing: '+name);return f.source.slice(node.start!,node.end!)}
function compile(name:string,globals:Record<string,unknown>={}){return Function(...Object.keys(globals),text(name)+';return '+name)(...Object.values(globals))}
function evaluate(source:string,globals:Record<string,unknown>={}){return Function(...Object.keys(globals),'return ('+source+')')(...Object.values(globals))}
function method(name:string,globals:Record<string,unknown>={}){const f=fixture(),node=f.methods.get(name);if(!node)throw Error('Original audit method missing');return Function(...Object.keys(globals),'return new class{'+f.source.slice(node.start!,node.end!)+'}')(...Object.values(globals))}
const chunks=new Map<string,string>();
function chunk(name:string){if(chunks.has(name))return chunks.get(name)!;const result=Bun.spawnSync(['/usr/bin/tar','-xOf',archive,'./web-dist/assets/'+name],{stdout:'pipe',stderr:'pipe'});expect(result.exitCode).toBe(0);const source=result.stdout.toString();chunks.set(name,source);return source}
function frontendFunction(file:string,name:string){const source=chunk(file),ast=parse(source,{sourceType:'unambiguous'});let found:t.FunctionDeclaration|undefined;t.traverseFast(ast,node=>{if(t.isFunctionDeclaration(node)&&node.id?.name===name){if(found)throw Error('Ambiguous original frontend boundary');found=node}});if(!found)throw Error('Missing original frontend boundary');return source.slice(found.start!,found.end!)}

auditTest('original artifact metadata binds a version to its actual producing frame, artifact root and project',()=>{
 const metadata=compile('Bg')({id:'synthetic-artifact',projectId:'synthetic-project',rootFrameId:'synthetic-root',frameId:'synthetic-creator',filename:'synthetic.html',isUserUpload:false},{id:'synthetic-version',frameId:'synthetic-producer',versionNumber:2,contentType:'text/html'},null);
 expect(metadata).toMatchObject({artifact_id:'synthetic-artifact',version_id:'synthetic-version',project_id:'synthetic-project',root_frame_id:'synthetic-root',frame_id:'synthetic-producer',creating_frame_id:'synthetic-creator'});
 const lite=text('Zfs');expect(lite).toContain('get_version_metadata_lite');expect(lite).toContain('get_artifact_metadata_lite');
 expect(text('Hfs')).toContain('await lS(e.db,t,n,e.dbRo)');expect(text('lS')).toContain('ee(Qt.userId,t.user_id)');
 // The public download metadata intentionally omits this authority. It cannot
 // be used as a trusted version-to-frame lookup by a browser component.
 const publicMetadata=compile('tKe')({...metadata,created_at:new Date(0)});
 expect(publicMetadata.frame_id).toBeUndefined();expect(publicMetadata.root_frame_id).toBeUndefined();expect(publicMetadata.project_id).toBeUndefined();
});

auditTest('original raw artifact routes authorize the native owner before sending file bytes',()=>{
 const routes=text('Mor');expect(routes).toContain('"/api/artifacts/:id"');expect(routes).toContain('"/api/artifacts/versions/:vid"');
 for(const name of ['Qfs','Jfs']){const source=text(name);expect(source.indexOf('await Hfs(')).toBeLessThan(source.indexOf('resolve_storage_path_safe('))}
 expect(routes).toContain('user:e.getUser(t)');expect(text('ydi')).toContain('"Content-Disposition"');expect(text('ydi')).toContain('e.headers.range');
 const token=evaluate(value('Bfs')),inline=evaluate(value('K7l'),{Bfs:token}),disposition=compile('Yle',{K7l:inline});
 expect(disposition('text/html')).toBe('attachment');expect(disposition('image/svg+xml')).toBe('attachment');expect(disposition('application/pdf')).toBe('inline');expect(disposition('image/png')).toBe('inline');
});

auditTest('original renderer isolates its inner origin while still explicitly allowing active scripts',()=>{
 const html=compile('JJc')(['https://synthetic-app.invalid']);
 expect(html).toContain("inner.setAttribute('sandbox', 'allow-scripts allow-forms')");
 const tokens=html.match(/const SAFE_SANDBOX_TOKENS = (\[[^;]+\]);/)?.[1];expect(tokens).toBeDefined();
 const allowed=evaluate(tokens!);expect(allowed).toContain('allow-scripts');expect(allowed).toContain('allow-forms');expect(allowed).toContain('allow-popups');expect(allowed).not.toContain('allow-same-origin');expect(allowed).not.toContain('allow-top-navigation');
 expect(html).toContain('inner.srcdoc = html');expect(html).toContain('event.source === inner.contentWindow');
 const route=text('klr');expect(route).toContain('l["resource-src"]');expect(route).toContain('l["connect-src"]');expect(route).not.toContain('frameId');
});

auditTest('original renderer CSP restricts named resource channels but is not a navigation firewall',()=>{
 const cdns=evaluate(value('zbi')),build=compile('QJc',{zbi:cdns,Ibi:()=>[]});
 const policy=build({frameAncestors:['https://synthetic-app.invalid'],selfOrigin:true});
 expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'");expect(policy).toContain("connect-src 'self'");expect(policy).toContain('https://cdn.jsdelivr.net');
 expect(policy).toContain("frame-src 'none'");expect(policy).toContain("form-action 'none'");expect(policy).toContain("object-src 'none'");
 expect(policy).not.toContain('navigate-to');expect(policy).not.toContain('sandbox');
 const spa=compile('bmi',{q8c:/^[A-Za-z0-9+/_-]+={0,2}$/,U8c:/^[^\s;,]+$/,oZe:"frame-ancestors 'none'"})({nonce:'syntheticnonce'});
 expect(spa.enforced).toContain("img-src 'self' data: blob: https: http:");expect(spa.enforced).toContain("connect-src 'self' blob: data: ws: wss: https: http:");
});

auditTest('original MCP widget resource and call routes reach independent server I/O without a frame binding',()=>{
 const routes=text('Csr'),resource=text('BBl'),call=text('DBl');
 expect(routes).toContain('"/api/mcp-apps/:serverId/resource"');expect(routes).toContain('"/api/mcp-apps/:serverId/call"');
 expect(routes).toContain('serverId:t.params.serverId,toolName:t.body.tool,args:t.body.arguments??{}');
 expect(resource).toContain('Di().resolve(t)');expect(resource).toContain('a.readResource(n)');expect(call).toContain('m.listTools()');expect(call).toContain('m.callToolRaw(n,r??{})');
 expect(resource).not.toContain('frameId');expect(call).not.toContain('frameId');
 const browser=chunk('index-BgpYmw3d.js');expect(browser).toContain('c.oncalltool=async k=>await Se().call("mcpApps","callTool"');expect(browser).toContain('c.sendToolInput({arguments:t.tool_input})');expect(browser).toContain('c.sendToolResult(t.tool_result)');
});

auditTest('original Markdown has a host/session Load gate that cannot substitute for protected-session policy',()=>{
 const browser=chunk('index-BgpYmw3d.js');
 expect(browser).toContain('remoteImagePolicy:g="allowlist"');expect(browser).toContain('if(g==="block")return');
 expect(browser).toContain('Ce.kind==="remote"&&g!=="allow"');expect(browser).toContain('i===t||!c&&DQe(e)||u');
 expect(browser).toContain('operon-img-allow:v1');expect(browser).toContain('children:"Always allow this host"');
 expect(browser).toContain('target:"_blank",rel:"noopener noreferrer",children:ne');
});

auditTest('original artifact dispatcher reaches HTML, PDF and MCP viewers, while limited HTML fallback is separately inerted',()=>{
 const artifact=chunk('ArtifactTile-CFbnK3VR.js'),html=chunk('HtmlPreview-CXBwtfOG.js'),pdf=chunk('PdfPreview-C1RteAIw.js'),browser=chunk('index-BgpYmw3d.js');
 expect(artifact).toContain('case"html":');expect(artifact).toContain('case"pdf":');expect(artifact).toContain('case"mcp-app":');
 expect(html).toContain('sendSandboxResourceReady({html:F,sandbox:"allow-scripts allow-forms"');expect(html).toContain('sandbox:"",srcDoc:R');
 expect(browser).toContain("default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; form-action 'none'; frame-src 'none'");
 expect(pdf).toContain('disableStream:!0,disableAutoFetch:!0');expect(pdf).toContain('externalLinkTarget:"_blank"');expect(pdf).toContain('renderAnnotationLayer:!0');
});

auditTest('releasing the original HTML slot keeps the pooled iframe alive until its deferred reaper runs',()=>{
 const callbacks:Function[]=[],destroyed:string[]=[],slot={},entry:any={reaper:null,claimants:[],activeSlots:new Set,wrapper:{style:{},appendChild(){}},zoomListeners:new Set};
 const globals={k:new Map([['synthetic-artifact',entry]]),lt:()=>{throw Error('No new iframe should be created')},ct(){},W(){},it(){},_(){},we(){},nt:1000,Se:(id:string)=>destroyed.push(id),performance:{now:()=>1},document:{createElement:()=>({style:{},remove(){}})},setTimeout:(callback:Function)=>{callbacks.push(callback);return 1},clearTimeout(){}};
 const attach=Function(...Object.keys(globals),frontendFunction('HtmlPreview-CXBwtfOG.js','dt')+';return dt')(...Object.values(globals));
 const lease=attach('synthetic-artifact',slot);expect(entry.activeSlots.has(slot)).toBe(true);lease.release();
 expect(entry.activeSlots.size).toBe(0);expect(entry.wrapper.style.display).toBe('none');expect(destroyed).toEqual([]);expect(callbacks).toHaveLength(1);
 callbacks[0]();expect(destroyed).toEqual(['synthetic-artifact']);lease.release();expect(callbacks).toHaveLength(1);
});

auditTest('original project uploads have a shared UPLOADS root and remain visible across sibling roots',async()=>{
 const calls:any[]=[],repository=method('listUploadsForProject');repository.listForProject=async(...args:any[])=>{calls.push(args);return [{id:'protected-upload',rootFrameId:'project-uploads'}]};
 expect(await repository.listUploadsForProject('synthetic-project')).toHaveLength(1);expect(calls).toEqual([['synthetic-project',{isUserUpload:true}]]);
 const visible=compile('kot')('ordinary-sibling',new Set());expect(visible({artifact_id:'protected-upload',root_frame_id:'project-uploads',is_user_upload:true})).toBe(true);
 expect(visible({artifact_id:'protected-output',root_frame_id:'protected-root',is_user_upload:false})).toBe(false);
 expect(text('C3')).toContain('if(r.uploadsFrameId)return r.uploadsFrameId');expect(text('C3')).toContain('agentName:"UPLOADS"');
 expect(text('lms')).toContain('let u=await C3(e.db,r)');expect(text('lms')).toContain('root_frame_id:u');
 const submit=text('e2n');expect(submit).toContain('list_uploads_for_project(s.project_id)');expect(submit).toContain('l._attachments=g.map((y)=>({id:y.artifact_id,filename:y.filename,content_type:y.content_type,size_bytes:y.size_bytes}))');
});

auditTest('original standard macOS analysis read roots include the workspace base, independently of network denial',()=>{
 const pin=(path:string)=>'pinned:'+path,base=compile('mH',{Ns:{join:(...parts:string[])=>parts.join('/')},Rzt:{homedir:()=>'/synthetic/home'}});
 const roots=compile('Q4e',{mH:base,vu:pin})({workspaceBase:'/synthetic/workspaces',artifactsPath:'/synthetic/artifacts',toolResultsPath:'/synthetic/tool-results',userReadPaths:[],userWritePaths:[]},{swapProne:[]});
 const sandbox=method('_macosPinnedRootsForProfile',{vu:pin});
 Object.assign(sandbox,{_pinnedWriteRoots:[],_pinnedReadRoots:roots,_pinnedInternalReadRoots:[],_pinnedWriteGlobFaces:[],_operonPinnedWriteRoots:[],_operonPinnedInternalReadRoots:[],_operonPinnedWriteGlobFaces:[],_pinnedWorkspaceBase:'/synthetic/workspaces',_swapProneRoots:[]});
 expect(value('fv')).toContain('macosPinnedRoots:"init"');
 const ordinary=sandbox._macosPinnedRootsForProfile({macosPinnedRoots:'init'},['/synthetic/workspaces/ordinary']);
 expect(ordinary.read).toContain('pinned:/synthetic/workspaces');expect(ordinary.read).toContain('pinned:/synthetic/artifacts');expect(ordinary.read).toContain('pinned:/synthetic/tool-results');
 expect('pinned:/synthetic/workspaces/protected/new-file.txt'.startsWith(ordinary.read[0]+'/')).toBe(true);
 const restricted=sandbox._macosPinnedRootsForProfile({macosPinnedRoots:'profileReadList'},['/synthetic/workspaces/protected']);
 expect(restricted.read).toEqual(['pinned:/synthetic/workspaces/protected']);expect(text('D$l')).toContain('n.push("(allow file-read*)")');expect(text('D$l')).toContain('for(let f of e.homeReadReallows)');
});
