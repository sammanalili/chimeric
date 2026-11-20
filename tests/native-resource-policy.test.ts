import {afterEach,expect,test} from 'bun:test';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {nativeResourcePolicyEdits,type NativeResourceEdit} from '../tools/native-resource-policy';
import {artifactFixture} from './helpers/native-artifact-fixture';

const originals={darwin:path.resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science'),linux:path.resolve(import.meta.dir,'../../../work/chimeric-linux-probe/recovered-production-reader/claude-science')};
const darwinNativeTest=fs.existsSync(originals.darwin)?test:test.skip;
type Native={source:string;ast:t.File;edits:NativeResourceEdit[];methods:Map<string,t.ClassMethod>};const cache=new Map<string,Native>();
function native(platform:keyof typeof originals='darwin'){if(cache.has(platform))return cache.get(platform)!;const source=fs.readFileSync(originals[platform],'utf8'),ast=parse(source,{sourceType:'unambiguous'}),edits=nativeResourcePolicyEdits(ast,source),methods=new Map<string,t.ClassMethod>();t.traverseFast(ast,node=>{if(t.isClassMethod(node)&&t.isIdentifier(node.key)&&edits.some(e=>e.start>=node.start!&&e.end<=node.end!))methods.set(node.key.name,node)});const result={source,ast,edits,methods};cache.set(platform,result);return result}
function patchedMethod(name:string){const f=native(),node=f.methods.get(name)!;let text=f.source.slice(node.start!,node.end!);for(const e of f.edits.filter(e=>e.start>=node.start!&&e.end<=node.end!).sort((a,b)=>b.start-a.start))text=text.slice(0,e.start-node.start!)+e.text+text.slice(e.end-node.start!);return text}
function compileMethod(name:string,globals:Record<string,unknown>={},privateFields=false){return Function(...Object.keys(globals),`return new class{${privateFields?'#t;#e;constructor(){this.#t=storage;this.#e=storage}':''}${patchedMethod(name)}}`)(...Object.values(globals))}
const previous=(globalThis as any).__scienceLocal,cleanup:Array<()=>void>=[];afterEach(()=>{for(const done of cleanup.splice(0).reverse())done();if(previous===undefined)delete(globalThis as any).__scienceLocal;else(globalThis as any).__scienceLocal=previous});
function fixture(){const f=artifactFixture();cleanup.push(f.cleanup);return f}

for(const platform of ['darwin','linux'] as const)(fs.existsSync(originals[platform])?test:test.skip)(platform+': 21 checked resource boundaries patch the actual original AST without overlaps',()=>{
 const f=native(platform);expect(f.edits).toHaveLength(21);let result=f.source;for(const e of [...f.edits].sort((a,b)=>b.start-a.start))result=result.slice(0,e.start)+e.text+result.slice(e.end);expect(()=>parse(result,{sourceType:'unambiguous'})).not.toThrow();
 const labels=f.edits.map(e=>e.label);expect(new Set(labels).size).toBe(21);expect(labels).toContain('native-resource-automatic-attachments');expect(labels).toContain('native-resource-upload-request');expect(()=>nativeResourcePolicyEdits(f.ast,f.source+'\n')).toThrow('Unsupported native runtime');
},20000);

darwinNativeTest('actual patched native byte materializer blocks an ordinary sibling before opening classified bytes',async()=>{
 const f=fixture(),v=f.add('classified',{root:'protected'}),store=f.store();await store.recordCreated(await store.captureFrame('protected'),{versionId:v.versionId});let consumer='ordinary',opens=0;
 (globalThis as any).__scienceLocal={resourcePolicy:{materialize:async(_owner:any,operation:any,read:any)=>{const lease=await store.authorize({versionId:operation.args[0].id},consumer,'model-input');return store.materialize(lease,read)}}};
 const reader=compileMethod('_readVersionContent',{storage:f.storage,_b:()=>false,Ui:path,ZR:(value:string)=>value,oy:(root:string,relative:string)=>{opens++;return fs.openSync(path.join(root,relative),'r')},Qs:fs,uLe:{CONTENT_READ_MAX_BYTES:1048576},B_e:createHash,Buffer},true);
 const version={id:v.versionId,storagePath:v.relative,checksum:v.checksum};await expect(reader._readVersionContent(version)).rejects.toThrow('not approved');expect(opens).toBe(0);
 consumer='protected';const result=await reader._readVersionContent(version);expect(result.kind).toBe('ok');expect(result.content).toEqual(v.bytes);expect(opens).toBe(1);
});

darwinNativeTest('actual patched metadata getter rejects before repository/path/cache work',async()=>{
 const f=fixture(),v=f.add('classified',{root:'protected'}),store=f.store();await store.recordCreated(await store.captureFrame('protected'),{versionId:v.versionId});let queries=0,paths=0;
 (globalThis as any).__scienceLocal={resourcePolicy:{metadata:async(_owner:any,operation:any,read:any)=>{const lease=await store.authorize({versionId:operation.args[0]},'ordinary','metadata');return store.materialize(lease,read)}}};
 const getter=compileMethod('get_version_metadata_lite');getter._repoFor=()=>({getVersion:async()=>{queries++;return null}});getter.resolve_storage_path=()=>{paths++;return '/unused'};
 await expect(getter.get_version_metadata_lite(v.versionId)).rejects.toThrow('not approved');expect(queries).toBe(0);expect(paths).toBe(0);
});

darwinNativeTest('native project uploads are filtered under the actual submit frame before autoattachment mapping',async()=>{
 const f=fixture(),secret=f.add('classified-upload',{root:'uploads',creating:null,producing:null,upload:true}),ordinary=f.add('ordinary-upload',{root:'uploads',creating:null,producing:null,upload:true}),store=f.store();
 await store.recordCreated(await store.captureFrame('ordinary'),{versionId:ordinary.versionId});await store.recordCreated(await store.captureFrame('protected'),{versionId:secret.versionId});const scope=new AsyncLocalStorage<string>();
 (globalThis as any).__scienceLocal={resourcePolicy:{withConsumer:async(_owner:any,input:any,operation:any)=>scope.run(input.frameId,operation),filter:async(_owner:any,_operation:any,rows:any[])=>store.filterMetadata(rows,scope.getStore(),row=>({versionId:row.version_id}))}};
 const uploads=compileMethod('list_uploads_for_project',{Bg:(_artifact:any,version:any)=>({version_id:version.id,filename:version.name})});uploads.repoRo={listUploadsForProject:async()=>[{latestVersion:{id:secret.versionId,name:'protected upload name'}},{latestVersion:{id:ordinary.versionId,name:'ordinary upload name'}}]};
 const expression=native().edits.find(e=>e.label==='native-resource-automatic-attachments')!.text,run=Function('e','s','r','return '+expression);
 const rows=await run({services:{store:uploads}},{frame_id:'ordinary',root_frame_id:'ordinary',project_id:'project-a'},{user_id:'owner-a'});expect(rows).toEqual([{version_id:ordinary.versionId,filename:'ordinary upload name'}]);expect(JSON.stringify(rows)).not.toContain('protected');expect(scope.getStore()).toBeUndefined();
});

darwinNativeTest('native upload capture precedes multipart iteration and preserves explicit feature-off draft behavior',async()=>{
 const f=native(),edit=f.edits.find(e=>e.label==='native-resource-upload-request')!;let node:t.ArrowFunctionExpression|undefined;t.traverseFast(f.ast,n=>{if(t.isArrowFunctionExpression(n)&&n.body.start===edit.start)node=n});expect(node).toBeDefined();
 const source=f.source.slice(node!.start!,edit.start)+edit.text+f.source.slice(edit.end,node!.end!),app={getUser:()=>({user_id:'owner-a'})};let files=0,seenRequest:any;
 const request={query:{},file:async()=>{files++;return null}},reply={status:0,code(status:number){this.status=status;return this},send(value:any){return value}};
 (globalThis as any).__scienceLocal={resourcePolicy:{withUploadRequest:async(_app:any,nativeRequest:any)=>{seenRequest=nativeRequest;throw Error('Actual composer context required')}}};const handler=Function('e','return '+source)(app);
 await expect(handler(request,reply)).rejects.toThrow('Actual composer context');expect(files).toBe(0);expect(seenRequest).toBe(request);
 (globalThis as any).__scienceLocal.resourcePolicy.withUploadRequest=async(_app:any,_request:any,operation:any)=>operation();expect(await handler(request,reply)).toEqual({detail:'No file uploaded'});expect(files).toBe(1);expect(reply.status).toBe(400);
});

darwinNativeTest('native conversation visibility accepts only a synchronous explicit true result',()=>{
 const f=native(),edit=f.edits.find(e=>e.label==='native-resource-conversation-predicate')!,row={is_user_upload:true,root_frame_id:'uploads',artifact_id:'secret'};
 (globalThis as any).__scienceLocal={resourcePolicy:{visible:()=>Promise.resolve(true)}};expect(Function('n','e','t','return '+edit.text)(row,'ordinary',new Set())).toBe(false);
 (globalThis as any).__scienceLocal.resourcePolicy.visible=()=>false;expect(Function('n','e','t','return '+edit.text)(row,'ordinary',new Set())).toBe(false);
 (globalThis as any).__scienceLocal.resourcePolicy.visible=()=>true;expect(Function('n','e','t','return '+edit.text)(row,'ordinary',new Set())).toBe(true);
});
