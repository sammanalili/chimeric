import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createNativeImageReferenceResolver} from '../src/native-image-references';
import {NativeResourceReader} from '../src/native-resource-reader';
import {NativeResourceService} from '../src/native-resource-service';
import {ResourceViews} from '../src/resource-views';
import {artifactFixture} from './helpers/native-artifact-fixture';

// All authorization comes from actual native rows and the real resource policy.
// The runtime scope adapter only replaces the confidentiality manager in these
// local tests. The bytes still pass through the normal O_NOFOLLOW reader.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC','base64');
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const done of cleanup.splice(0).reverse())done()});
const host={frameId:'ordinary',rootFrameId:'ordinary',projectId:'project-a'};
function fixture(){
 const native=artifactFixture();cleanup.push(native.cleanup);
 const policy=native.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false});
 const service=new NativeResourceService(policy,{protectionEnabled:()=>false,ownerUserId:'owner-a'});cleanup.push(()=>service.close());
 const reader=new NativeResourceReader(native.profile,{protectedRoot:join(native.profile,'protected'),authorizeProtected:()=>{throw Error('Protected images must not reach the reader')}});
 let reads=0,reading:(()=>void)|undefined;
 const views=new ResourceViews(policy,async(resource,options)=>{reads++;reading?.();return reader.read(resource,options)});
 const runtime={resources:policy,resourceViews:views,scopeForFrame:(frameId:string)=>{
  const {readOnly:_,...scope}=native.resolveContext(frameId);
  return {...scope,executionBinding:createHash('sha256').update(JSON.stringify(scope)).digest('hex')};
 }};
 const resolve=createNativeImageReferenceResolver(native.profile,()=>runtime as any);
 const add=async(options:{versionId?:string;root?:string;project?:string;classify?:boolean;bytes?:Buffer;type?:string;artifactId?:string;upload?:boolean;creating?:string|null;producing?:string|null}={})=>{
  const versionId=options.versionId??randomUUID(),root=options.root??'ordinary';
  const added=native.add(versionId,{root,project:options.project,type:options.type??'image/png',artifactId:options.artifactId,upload:options.upload,creating:options.creating,producing:options.producing});
  const bytes=options.bytes??png,checksum=createHash('sha256').update(bytes).digest('hex');
  const absolute=join(native.profile,'orgs','org-a','artifacts',added.relative);
  mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,bytes);
  native.edit('UPDATE artifact_versions SET checksum=?,size_bytes=? WHERE id=?',checksum,bytes.length,versionId);
  if(options.classify!==false&&options.project!=='project-b')await policy.recordCreated(await policy.captureFrame(root),{versionId});
  return {...added,bytes,checksum,absolute};
 };
 const upload=async(frameId='ordinary',options:{project?:string;root?:string;bytes?:Buffer}={})=>{
  let saved!:Awaited<ReturnType<typeof add>>;
  await service.withUploadRequest({getUser:()=>({user_id:'owner-a'})},{query:{frameId}},()=>service.saveUpload({}, {root_frame_id:options.root??'uploads',project_id:options.project??'project-a'},async()=>{
   saved=await add({...options,root:options.root??'uploads',upload:true,creating:null,producing:null,classify:false});
   return {artifact_id:saved.artifactId,version_id:saved.versionId};
  }));
  return saved;
 };
 return {...native,policy,runtime,resolve,add,upload,reads:()=>reads,onRead:(action:()=>void)=>{reading=action}};
}

test('Reference bytes come from the exact pinned native version and return IDs and checksum only',async()=>{
 const f=fixture(),old=await f.add(),latest=await f.add({artifactId:old.artifactId});
 const result=await f.resolve(host,{versionIds:[old.versionId]});
 expect(result.images).toEqual([{bytes:png,mimeType:'image/png'}]);
 expect(result.references).toEqual([{artifact_id:old.artifactId,version_id:old.versionId,checksum:old.checksum}]);
 expect(result.references[0].version_id).not.toBe(latest.versionId);
 expect(JSON.stringify(result.references)).not.toContain(f.profile);
 expect(JSON.stringify(result.references)).not.toContain('synthetic private');
 await result.assertCurrent();expect(f.reads()).toBeGreaterThanOrEqual(1);
});

test('Local display compatibility never promotes an unclassified image into an external reference',async()=>{
 const f=fixture(),image=await f.add({classify:false});
 const visible=await f.policy.renderDecision({versionId:image.versionId,consumerFrameId:host.frameId});
 expect(visible.decision).toBe('standard');expect(visible.resource?.dataClass).toBe('unclassified');
 await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();expect(f.reads()).toBe(0);
});

test('Protected versions stay blocked after their root switches back to standard',async()=>{
 const f=fixture(),image=await f.add({root:'protected'});
 f.modes.set('protected',{mode:'standard',revision:2});
 await expect(f.resolve({frameId:'protected',rootFrameId:'protected',projectId:'project-a'},{versionIds:[image.versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('A Class 2 consumer cannot turn an ordinary same-project image into an external reference',async()=>{
 const f=fixture(),image=await f.add();
 await expect(f.resolve({frameId:'protected',rootFrameId:'protected',projectId:'project-a'},{versionIds:[image.versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('References reject another root and another owner before reading bytes',async()=>{
 const f=fixture(),sibling=await f.add({root:'uploads'}),foreign=await f.add({root:'foreign',project:'project-b',classify:false});
 for(const versionId of [sibling.versionId,foreign.versionId])await expect(f.resolve(host,{versionIds:[versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('Caller supplied root and project cannot override the native frame identity',async()=>{
 const f=fixture(),image=await f.add();
 for(const changed of [{...host,rootFrameId:'uploads'},{...host,projectId:'project-b'}])await expect(f.resolve(changed,{versionIds:[image.versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('Reference arguments require one to four unique exact UUIDs',async()=>{
 const f=fixture(),image=await f.add();
 for(const versionIds of [[],[image.versionId,image.versionId],[...Array(5)].map(()=>randomUUID()),['/tmp/image.png'],['https://example.test/guide.png'],['{{artifact:'+image.versionId+'}}'],['artifact-latest']]){
  await expect(f.resolve(host,{versionIds})).rejects.toThrow();
 }
 expect(f.reads()).toBe(0);
});

test('A symlink cannot replace a pinned native reference file, even with identical bytes',async()=>{
 const f=fixture(),image=await f.add(),outside=join(f.profile,'same-image.png');
 writeFileSync(outside,png);rmSync(image.absolute);symlinkSync(outside,image.absolute);
 await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();
});

test('Declared MIME types and stored checksums cannot make SVG content into a raster reference',async()=>{
 const f=fixture(),image=await f.add({bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')});
 await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();
 const svg=await f.add({type:'image/svg+xml'});
 await expect(f.resolve(host,{versionIds:[svg.versionId]})).rejects.toThrow();
});

test('A policy transition while native bytes are being read rejects the materialized reference',async()=>{
 const f=fixture(),image=await f.add();
 f.onRead(()=>f.modes.set('ordinary',{mode:'class2',revision:1}));
 await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();expect(f.reads()).toBe(1);
});

test('Reference authorization is revoked by a native scope change after resolution',async()=>{
 const f=fixture(),image=await f.add(),result=await f.resolve(host,{versionIds:[image.versionId]});
 f.modes.set('ordinary',{mode:'class2',revision:1});
 await expect(result.assertCurrent()).rejects.toThrow();
});

test('Reference authorization detects a changed native version binding after resolution',async()=>{
 const f=fixture(),image=await f.add(),result=await f.resolve(host,{versionIds:[image.versionId]});
 f.edit('UPDATE artifact_versions SET checksum=? WHERE id=?','0'.repeat(64),image.versionId);
 await expect(result.assertCurrent()).rejects.toThrow();
});

test('New protected lineage with the same checksum revokes an ordinary reference',async()=>{
 const f=fixture(),image=await f.add(),result=await f.resolve(host,{versionIds:[image.versionId]});
 await f.add({root:'protected'});
 await expect(result.assertCurrent()).rejects.toThrow();
});

test('An already cancelled reference resolution does not read bytes',async()=>{
 const f=fixture(),image=await f.add(),controller=new AbortController();controller.abort();
 await expect(f.resolve(host,{versionIds:[image.versionId],signal:controller.signal})).rejects.toThrow();expect(f.reads()).toBe(0);
});


test('Synchronous dispatch checks scope, version binding and policy revision after the last async check',async()=>{
 const f=fixture(),image=await f.add(),result=await f.resolve(host,{versionIds:[image.versionId]});
 expect(result.assertDispatchCurrent?.()).toBeUndefined();
 await f.add();
 expect(()=>result.assertDispatchCurrent?.()).toThrow();
 await result.assertCurrent();expect(result.assertDispatchCurrent?.()).toBeUndefined();
 f.edit('UPDATE artifact_versions SET storage_path=? WHERE id=?','project-a/changed/path.png',image.versionId);
 expect(()=>result.assertDispatchCurrent?.()).toThrow();
});


test('A real composer upload uses its broker classification even though native storage belongs to UPLOADS',async()=>{
 const f=fixture(),image=await f.upload();
 const decision=await f.policy.renderDecision({versionId:image.versionId,consumerFrameId:host.frameId});
 expect(decision).toMatchObject({decision:'standard',resource:{dataClass:'standard',consumerRootFrameId:'ordinary',consumerPolicyRevision:0,sourceRootFrameIds:['ordinary','uploads']}});
 const result=await f.resolve(host,{versionIds:[image.versionId]});
 expect(result.images).toEqual([{bytes:png,mimeType:'image/png'}]);expect(result.references[0].version_id).toBe(image.versionId);
 await result.assertCurrent();expect(result.assertDispatchCurrent?.()).toBeUndefined();
});

test('A native upload flag cannot grant another chat reference access without that chat in its broker provenance',async()=>{
 const f=fixture();f.edit('INSERT INTO frames VALUES(?,NULL,?,?)','sibling','sibling','project-a');
 const image=await f.upload();
 const sibling={frameId:'sibling',rootFrameId:'sibling',projectId:'project-a'};
 // The general project upload reader permits ordinary metadata. Image egress
 // still requires the actual uploading chat in the durable broker lineage.
 expect((await f.policy.renderDecision({versionId:image.versionId,consumerFrameId:sibling.frameId})).decision).toBe('standard');
 await expect(f.resolve(sibling,{versionIds:[image.versionId]})).rejects.toThrow();expect(f.reads()).toBe(0);
});

test('Uploads from another same-owner project or unknown upload provenance cannot become references',async()=>{
 const f=fixture();f.edit('INSERT INTO projects VALUES(?,?,NULL,?)','project-c','owner-a','other owned project');
 for(const frame of ['ordinary-c','uploads-c'])f.edit('INSERT INTO frames VALUES(?,NULL,?,?)',frame,frame,'project-c');
 const foreign=await f.upload('ordinary-c',{project:'project-c',root:'uploads-c'});
 const unknown=await f.add({root:'uploads',upload:true,creating:null,producing:null,classify:false});
 for(const image of [foreign,unknown])await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('An upload classified only under the shared container has no authenticated composer permission',async()=>{
 const f=fixture(),image=await f.add({root:'uploads',upload:true,creating:null,producing:null});
 expect((await f.policy.renderDecision({versionId:image.versionId,consumerFrameId:host.frameId})).resource?.dataClass).toBe('standard');
 await expect(f.resolve(host,{versionIds:[image.versionId]})).rejects.toThrow();expect(f.reads()).toBe(0);
});

test('A protected composer upload stays denied after its chat returns to standard mode',async()=>{
 const f=fixture(),image=await f.upload('protected');f.modes.set('protected',{mode:'standard',revision:2});
 for(const consumer of [host,{frameId:'protected',rootFrameId:'protected',projectId:'project-a'}])await expect(f.resolve(consumer,{versionIds:[image.versionId]})).rejects.toThrow();
 expect(f.reads()).toBe(0);
});

test('A standard composer upload remains denied for a Class 2 consumer',async()=>{
 const f=fixture(),image=await f.upload();
 await expect(f.resolve({frameId:'protected',rootFrameId:'protected',projectId:'project-a'},{versionIds:[image.versionId]})).rejects.toThrow();expect(f.reads()).toBe(0);
});
