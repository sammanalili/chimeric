import {afterEach,expect,test} from 'bun:test';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {ResourcePolicyStore} from '../src/resource-policy';
import {artifactFixture} from './helpers/native-artifact-fixture';
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const done of cleanups.splice(0).reverse())done()});
function fixture(){const f=artifactFixture();cleanups.push(f.cleanup);return f}
const destination={kind:'model' as const,id:'synthetic-model',revision:'1',binding:'b'.repeat(64)};
test('legacy defaults to unclassified deny; explicit disabled compatibility writes no standard label',async()=>{
 const f=fixture(),v=f.add('legacy'),strict=f.store();await expect(strict.authorize({versionId:v.versionId},'ordinary','raw-bytes')).rejects.toThrow('not approved');
 let enabled=false;const compatible=f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>enabled});expect((await compatible.renderDecision({versionId:v.versionId,consumerFrameId:'ordinary'})).decision).toBe('standard');expect(compatible.snapshot().resources).toEqual([]);
 enabled=true;await expect(compatible.authorize({versionId:v.versionId},'ordinary','raw-bytes')).rejects.toThrow('not approved');enabled=false;
 await compatible.captureFrame('protected');f.modes.set('protected',{mode:'standard',revision:2});await expect(compatible.authorize({versionId:v.versionId},'ordinary','raw-bytes')).rejects.toThrow('not approved');expect(compatible.snapshot().roots[0].dataClass).toBe('class2');
});
test('unbound compatibility is temporary, records no resource identity, and never reopens after protected history',async()=>{
 const f=fixture(),published:number[]=[],store=f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false,onChange:revision=>published.push(revision)});expect(await store.unboundStandardDecision('ordinary')).toMatchObject({decision:'standard-unbound',consumerRootFrameId:'ordinary'});expect(store.snapshot().resources).toEqual([]);expect(published).toEqual([]);
 await store.captureFrame('protected');expect(published).toEqual([1]);expect((await store.unboundStandardDecision('ordinary')).decision).toBe('blocked');store.close();expect((await f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false}).unboundStandardDecision()).decision).toBe('blocked');expect((await store.unboundStandardDecision()).decision).toBe('blocked');
});
test('verified new standard bytes retain native data and protected active rendering stays unavailable',async()=>{
 const f=fixture(),v=f.add('ordinary-v'),store=f.store(),context=await store.captureFrame('ordinary');await store.recordNewRoot(context);await store.recordCreated(context,{versionId:v.versionId});
 const lease=await store.authorize({versionId:v.versionId},'ordinary','raw-bytes');expect(await store.materialize(lease,resource=>f.read(resource.storagePath))).toEqual(v.bytes);expect((await store.renderDecision({artifactId:v.artifactId,consumerFrameId:'ordinary'})).decision).toBe('standard');
 await expect(store.authorize({versionId:v.versionId},'protected','active-preview')).rejects.toThrow('not verified');
});
test('actual composer context taints shared UPLOADS before ordinary sibling metadata or bytes are visible',async()=>{
 const f=fixture(),upload=f.add('upload',{root:'uploads',creating:null,producing:null,upload:true}),standard=f.add('ordinary-v'),store=f.store();
 await store.recordCreated(await store.captureFrame('ordinary'),{versionId:standard.versionId});await store.recordCreated(await store.captureFrame('protected-child'),{versionId:upload.versionId});
 const rows=[{version_id:upload.versionId,filename:'protected synthetic filename'},{version_id:standard.versionId,filename:'ordinary synthetic filename'}];
 expect(await store.filterMetadata(rows,'ordinary',row=>({versionId:row.version_id}))).toEqual([rows[1]]);
 let reads=0;await expect((async()=>{const lease=await store.authorize({versionId:upload.versionId},'ordinary','model-input');return store.materialize(lease,()=>{reads++;return upload.bytes})})()).rejects.toThrow('not approved');expect(reads).toBe(0);
 const snapshot=await store.renderDecision({versionId:upload.versionId,consumerFrameId:'protected'});expect(snapshot.decision).toBe('inert');expect(snapshot.resource?.sourceRootFrameIds).toEqual(['protected','uploads']);expect(snapshot.resource?.checksum).toBe(upload.checksum);expect(snapshot.resource?.consumerPolicyRevision).toBe(1);
 for(const requested of ['raw-bytes','thumbnail','archive','active-preview'] as const)await expect(store.authorize({versionId:upload.versionId},'protected',requested)).rejects.toThrow();
});
test('Off and restart preserve taint, including identical copies and explicit transformed lineage',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected',text:'synthetic classified bytes'}),store=f.store();await store.recordCreated(await store.captureFrame('protected'),{versionId:v.versionId});
 f.modes.set('protected',{mode:'standard',revision:2});store.close();const reopened=f.store();expect((await reopened.renderDecision({versionId:v.versionId,consumerFrameId:'ordinary'})).decision).toBe('blocked');
 const exact=f.add('exact-copy',{text:'synthetic classified bytes'}),derived=f.add('derived',{parent:v.versionId,text:'synthetic transformed output'}),ordinary=await reopened.captureFrame('ordinary');
 expect((await reopened.recordCreated(ordinary,{versionId:exact.versionId})).dataClass).toBe('class2');expect((await reopened.recordCreated(ordinary,{versionId:derived.versionId})).dataClass).toBe('class2');expect(reopened.rootClass(ordinary)).toBe('class2');
 const later=f.add('after-off',{root:'protected'});expect((await reopened.recordCreated(await reopened.captureFrame('protected'),{versionId:later.versionId})).dataClass).toBe('class2');
});
test('unclassified lineage and public context-shaped objects cannot create a standard classification',async()=>{
 const f=fixture(),parent=f.add('legacy-parent'),derived=f.add('derived',{parent:parent.versionId}),store=f.store(),context=await store.captureFrame('ordinary');
 await expect(store.recordCreated(context,{versionId:derived.versionId})).rejects.toThrow('no verified classification');await expect(store.recordCreated({...context},{versionId:parent.versionId})).rejects.toThrow('trusted native');expect(store.snapshot().resources).toEqual([]);
});
test('native owner and checksum changes abort before bytes; post-read mode changes discard the result',async()=>{
 const f=fixture(),v=f.add('v'),store=f.store();await store.recordCreated(await store.captureFrame('ordinary'),{versionId:v.versionId});
 const lease=await store.authorize({versionId:v.versionId},'ordinary','raw-bytes');f.edit('UPDATE artifact_versions SET checksum=? WHERE id=?','c'.repeat(64),v.versionId);let reads=0;
 await expect(store.materialize(lease,()=>{reads++;return v.bytes})).rejects.toThrow('binding changed');expect(reads).toBe(0);f.edit('UPDATE artifact_versions SET checksum=? WHERE id=?',v.checksum,v.versionId);
 const current=await store.authorize({versionId:v.versionId},'ordinary','raw-bytes');await expect(store.materialize(current,()=>{f.modes.set('ordinary',{mode:'class2',revision:1});return v.bytes})).rejects.toThrow('context changed');
 f.modes.set('ordinary',{mode:'standard',revision:2});f.edit('UPDATE projects SET user_id=? WHERE id=?','other-owner','project-a');await expect(store.authorize({versionId:v.versionId},'ordinary','metadata')).rejects.toThrow('unavailable');
});
test('legacy classification requires explicit human authority and cannot downgrade source taint',async()=>{
 const f=fixture(),v=f.add('legacy'),store=f.store({approveLegacyClassification:async()=>({decision:'approve',receiptId:'native-human-receipt'})});
 await store.classifyLegacy(await store.captureFrame('ordinary'),{versionId:v.versionId},'standard');expect((await store.authorize({versionId:v.versionId},'ordinary','raw-bytes')).dataClass).toBe('standard');
 const secret=f.add('legacy-secret',{root:'protected'});await expect(store.classifyLegacy(await store.captureFrame('ordinary'),{versionId:secret.versionId},'standard')).rejects.toThrow('cannot be relabelled');
});
test('human release is exact, one-use, revocable and never removes durable classification',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected'}),store=f.store({resolveDestination:()=>destination,approveRelease:async()=>({decision:'approve',receiptId:'native-human-receipt'})});await store.recordCreated(await store.captureFrame('protected'),{versionId:v.versionId});
 const draft=await store.prepareRelease({versionId:v.versionId},'ordinary','model-input');expect(Object.isFrozen(draft)).toBe(true);expect(Object.isFrozen(draft.destination)).toBe(true);await expect(store.approveRelease({...draft})).rejects.toThrow('native reviewed');const permit=await store.approveRelease(draft);
 const results=await Promise.allSettled([store.authorize({versionId:v.versionId},'ordinary','model-input',permit.id),store.authorize({versionId:v.versionId},'ordinary','model-input',permit.id)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const lease=(results.find(r=>r.status==='fulfilled') as PromiseFulfilledResult<any>).value;expect(await store.materialize(lease,()=>v.bytes)).toEqual(v.bytes);await expect(store.materialize(lease,()=>v.bytes)).rejects.toThrow('already used');expect(store.snapshot().resources[0].dataClass).toBe('class2');
 const second=await store.approveRelease(await store.prepareRelease({versionId:v.versionId},'ordinary','model-input')),revoked=await store.authorize({versionId:v.versionId},'ordinary','model-input',second.id);store.revokeRelease(second.id);await expect(store.materialize(revoked,()=>v.bytes)).rejects.toThrow('destination changed');
});
test('release destination changes, policy changes and expiry invalidate review before use',async()=>{
 const f=fixture(),v=f.add('secret',{root:'protected'});let current={...destination},now=1000;const store=f.store({resolveDestination:()=>current,approveRelease:async()=>({decision:'approve',receiptId:'native-human-receipt'}),now:()=>now});await store.recordCreated(await store.captureFrame('protected'),{versionId:v.versionId});
 const changed=await store.prepareRelease({versionId:v.versionId},'ordinary','model-input');current={...current,revision:'2'};await expect(store.approveRelease(changed)).rejects.toThrow('changed during review');
 const expiring=await store.approveRelease(await store.prepareRelease({versionId:v.versionId},'ordinary','model-input',10));now=1011;await expect(store.authorize({versionId:v.versionId},'ordinary','model-input',expiring.id)).rejects.toThrow('unavailable');
 await expect(store.prepareRelease({versionId:v.versionId},'ordinary','active-preview')).rejects.toThrow('cannot verify');
});
test('unreadable policy is preserved and never converted into permissive defaults',()=>{
 const f=fixture();f.store();const path=join(f.profile,'local-auth','resource-policy.json');writeFileSync(path,'broken synthetic policy');expect(()=>f.store()).toThrow('could not be read');expect(readFileSync(path,'utf8')).toBe('broken synthetic policy');
});

test('a missing classified policy cannot reactivate disabled-feature compatibility',async()=>{
 const f=fixture(),store=f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false});await store.captureFrame('protected');expect(store.snapshot().protectedHistory).toBe(true);store.close();
 unlinkSync(join(f.profile,'local-auth','resource-policy.json'));expect(()=>f.store({legacyRule:'ordinary-while-disabled',protectionEnabled:()=>false})).toThrow('history needs to be restored');
});

test('inert-image leases read only declared raster types without authorizing a converter or active preview',async()=>{
 const f=fixture(),png=f.add('png',{root:'protected',type:'image/png',text:'synthetic raster bytes must still be validated by renderer'}),svg=f.add('svg',{root:'protected',type:'image/svg+xml'}),store=f.store(),context=await store.captureFrame('protected');
 await store.recordCreated(context,{versionId:png.versionId});await store.recordCreated(context,{versionId:svg.versionId});expect((await store.authorize({versionId:png.versionId},'protected','inert-image')).purpose).toBe('inert-image');await expect(store.authorize({versionId:svg.versionId},'protected','inert-image')).rejects.toThrow('not approved');await expect(store.authorize({versionId:png.versionId},'protected','thumbnail')).rejects.toThrow('not verified');
});
