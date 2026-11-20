import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,writeFileSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {NativeResourceReader} from '../src/native-resource-reader';
import type {NativeArtifactContext} from '../src/native-artifact-context';

const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'chimeric-resource-reader-')));roots.push(root);const profile=join(root,'profile'),protectedRoot=join(profile,'protected');mkdirSync(protectedRoot,{recursive:true});
 const bytes=Buffer.from('synthetic exact bytes'),relative='project-a/artifact-a/version-a/file.txt',absolute=join(profile,'orgs','org-a','artifacts',relative);mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,bytes);
 const resource:NativeArtifactContext=Object.freeze({artifactId:'artifact-a',versionId:'version-a',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',rootFrameId:'root-a',creatingFrameId:'root-a',producingFrameId:'root-a',sourceFrames:Object.freeze([]),checksum:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,contentType:'text/plain',storagePath:relative,isUserUpload:false,parentVersionId:null});
 let protectedChecks=0;const reader=new NativeResourceReader(profile,{protectedRoot,authorizeProtected:()=>{protectedChecks++}});return {root,profile,protectedRoot,bytes,relative,absolute,resource,reader,protectedChecks:()=>protectedChecks};
}
const signal=()=>new AbortController().signal;

test('reader opens the exact org artifact path and returns bounded bytes',async()=>{
 const f=fixture();expect(Buffer.from(await f.reader.read(f.resource,{maxBytes:1024,signal:signal()}))).toEqual(f.bytes);expect(f.protectedChecks()).toBe(0);
});
test('reader rejects traversal, identity mismatch, oversized metadata and aborted work before bytes',async()=>{
 const f=fixture();
 for(const storagePath of ['../outside','project-a/other-artifact/version-a/file.txt','project-a/artifact-a/../../outside'])await expect(f.reader.read({...f.resource,storagePath},{maxBytes:1024,signal:signal()})).rejects.toThrow();
 await expect(f.reader.read({...f.resource,sizeBytes:f.bytes.length+1},{maxBytes:1024,signal:signal()})).rejects.toThrow('changed');
 await expect(f.reader.read(f.resource,{maxBytes:1,signal:signal()})).rejects.toThrow('limit');
 const controller=new AbortController();controller.abort();await expect(f.reader.read(f.resource,{maxBytes:1024,signal:controller.signal})).rejects.toThrow();
});
test('reader rejects linked final files and linked ancestor directories',async()=>{
 const f=fixture(),outside=join(f.root,'outside.txt');writeFileSync(outside,f.bytes);rmSync(f.absolute);symlinkSync(outside,f.absolute);
 await expect(f.reader.read(f.resource,{maxBytes:1024,signal:signal()})).rejects.toThrow();
 const g=fixture(),versionDir=dirname(g.absolute),real=join(g.root,'real-version');mkdirSync(real);writeFileSync(join(real,'file.txt'),g.bytes);rmSync(versionDir,{recursive:true});symlinkSync(real,versionDir);
 await expect(g.reader.read(g.resource,{maxBytes:1024,signal:signal()})).rejects.toThrow();
});
test('absolute protected resources require the protected-store authorization callback',async()=>{
 const f=fixture(),path=join(f.protectedRoot,'roots','root-a','artifacts','file.txt');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,f.bytes);
 const resource={...f.resource,storagePath:path};expect(Buffer.from(await f.reader.read(resource,{maxBytes:1024,signal:signal()}))).toEqual(f.bytes);expect(f.protectedChecks()).toBe(1);
 const denied=new NativeResourceReader(f.profile,{protectedRoot:f.protectedRoot,authorizeProtected:()=>{throw Error('scope denied')}});await expect(denied.read(resource,{maxBytes:1024,signal:signal()})).rejects.toThrow('scope denied');
});
