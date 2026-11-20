import {afterEach,expect,test} from 'bun:test';
import {writeFileSync} from 'node:fs';
import {ResourceViews} from '../src/resource-views';
import {artifactFixture} from './helpers/native-artifact-fixture';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const done of cleanup.splice(0).reverse())done()});
function fixture(){const f=artifactFixture();cleanup.push(f.cleanup);return f}
const signal=()=>new AbortController().signal;
test('Unbound compatibility never reads bytes and is cut off by protected history',async()=>{
 const f=fixture(),policy=f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false});let reads=0;const views=new ResourceViews(policy,async()=>{reads++;return new Uint8Array});
 expect(await views.unbound({consumerFrameId:'ordinary'},signal())).toEqual({decision:'standard-unbound',policyRevision:0,consumerRootFrameId:'ordinary'});expect(reads).toBe(0);await policy.captureFrame('protected');expect((await views.unbound({},signal())).decision).toBe('blocked');expect(reads).toBe(0);
});
test('Standard verified previews return identity without reading artifact bytes',async()=>{
 const f=fixture(),v=f.add('ordinary'),policy=f.store();await policy.recordCreated(await policy.captureFrame('ordinary'),{versionId:v.versionId});let reads=0;
 const views=new ResourceViews(policy,async()=>{reads++;throw Error('must not read')});
 const result=await views.view({artifactId:v.artifactId,consumerFrameId:'ordinary'},signal());expect(result.decision).toBe('standard');expect(result.artifactId).toBe(v.artifactId);expect(reads).toBe(0);
});
test('Protected HTML is returned only as inert text with exact source, version and checksum',async()=>{
 const f=fixture(),v=f.add('protected-html',{root:'protected',text:'<img src="https://outside.example/leak">',type:'text/html'}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});let options:any;
 const views=new ResourceViews(policy,async(exact,limits)=>{options=limits;return f.read(exact.storagePath)}),result=await views.view({versionId:v.versionId,consumerFrameId:'protected-child'},signal());
 expect(result).toMatchObject({decision:'inert-text',text:v.bytes.toString(),artifactId:v.artifactId,versionId:v.versionId,checksum:v.checksum,sourceRootFrameId:'protected',consumerRootFrameId:'protected'});expect(options.maxBytes).toBe(262144);
});
test('Ordinary sibling cannot fetch a protected preview or leak metadata into the reader',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected'}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});let reads=0;
 const result=await new ResourceViews(policy,async()=>{reads++;return v.bytes}).view({versionId:v.versionId,consumerFrameId:'ordinary'},signal());expect(result.decision).toBe('blocked');expect('checksum'in result).toBe(false);expect(reads).toBe(0);
});
test('PDF, binary and oversized protected documents never invoke a reader or converter',async()=>{
 for(const [name,type,text]of [['pdf','application/pdf','%PDF-synthetic'],['binary','application/octet-stream','synthetic'],['large','text/plain','x'.repeat(262145)]]){
  const f=fixture(),v=f.add(name,{root:'protected',type,text}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});let reads=0;
  const result=await new ResourceViews(policy,async()=>{reads++;return v.bytes}).view({versionId:v.versionId,consumerFrameId:'protected'},signal());expect(result.decision).toBe('blocked');expect(reads).toBe(0);
 }
});
test('Forged raster metadata and changed storage bytes cannot become an image preview',async()=>{
 const f=fixture(),v=f.add('fake-png',{root:'protected',type:'image/png',text:'<svg xmlns="http://www.w3.org/2000/svg"/>'}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});
 const views=new ResourceViews(policy,async exact=>f.read(exact.storagePath));expect((await views.view({versionId:v.versionId,consumerFrameId:'protected'},signal())).decision).toBe('blocked');
 writeFileSync(v.absolute,'different bytes');expect((await views.view({versionId:v.versionId,consumerFrameId:'protected'},signal())).decision).toBe('blocked');
});
test('Policy changes during actual reading invalidate the result before browser delivery',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected'}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});
 const views=new ResourceViews(policy,async()=>{f.modes.set('protected',{mode:'standard',revision:2});return v.bytes});
 await expect(views.view({versionId:v.versionId,consumerFrameId:'protected'},signal())).rejects.toThrow('changed');
});
test('Aborted preview never reads bytes or returns a late materialized payload',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected'}),policy=f.store();await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});let reads=0;
 const controller=new AbortController();controller.abort();await expect(new ResourceViews(policy,async()=>{reads++;return v.bytes}).view({versionId:v.versionId,consumerFrameId:'protected'},controller.signal)).rejects.toThrow();expect(reads).toBe(0);
 const active=new AbortController();await expect(new ResourceViews(policy,async()=>{active.abort();return v.bytes}).view({versionId:v.versionId,consumerFrameId:'protected'},active.signal)).rejects.toThrow();
});
