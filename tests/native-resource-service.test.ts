import {afterEach,expect,test} from 'bun:test';
import {NativeResourceService} from '../src/native-resource-service';
import {SessionPolicyError} from '../src/session-policy';
import type {ResourcePolicyDependencies} from '../src/resource-policy';
import {artifactFixture} from './helpers/native-artifact-fixture';
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const done of cleanups.splice(0).reverse())done()});
const unavailableFrame=():never=>{throw new SessionPolicyError('frame_unavailable','The research session is unavailable.',404)};
function fixture(overrides:Partial<ResourcePolicyDependencies>={},protectionEnabled=()=>false,withProtectedWrite?:<T>(frameId:string,kind:'artifact'|'upload',operation:()=>Promise<T>)=>Promise<T>){const f=artifactFixture();cleanups.push(f.cleanup);let frame:string|undefined;const policy=f.store({legacyRule:'ordinary-while-disabled',protectionEnabled,...overrides}),service=new NativeResourceService(policy,{currentFrame:()=>frame,protectionEnabled,ownerUserId:'owner-a',withProtectedWrite});cleanups.push(()=>service.close());return {f,policy,service,setFrame:(value?:string)=>frame=value}}

test('Explicit feature-off compatibility preserves an ordinary legacy metadata read without classifying it',async()=>{
 const {f,policy,service}=fixture(),v=f.add('legacy');let reads=0;
 const result=await service.metadata({}, {method:'get_version_metadata_lite',args:[v.versionId]},async()=>{reads++;return {id:v.versionId}});
 expect(result).toEqual({id:v.versionId});expect(reads).toBe(1);expect(policy.snapshot().resources).toEqual([]);
});
test('Protected version blocks an ordinary sibling before native metadata or byte work',async()=>{
 const {f,policy,service,setFrame}=fixture(),v=f.add('secret',{root:'protected'});await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});setFrame('ordinary');let reads=0;
 await expect(service.metadata({}, {method:'get_version_metadata_lite',args:[v.versionId]},async()=>{reads++;return {}})).rejects.toThrow('not approved');
 await expect(service.materialize({}, {method:'_readVersionContent',args:[{id:v.versionId}]},async()=>{reads++;return v.bytes})).rejects.toThrow('not approved');expect(reads).toBe(0);
});
test('Protected materialization carries the durable storage root into the physical read boundary',async()=>{
 let seen:any;const f=artifactFixture();cleanups.push(f.cleanup);const policy=f.store(),v=f.add('protected-read',{root:'protected'});await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});
 const service=new NativeResourceService(policy,{currentFrame:()=> 'protected',protectionEnabled:()=>true,ownerUserId:'owner-a',withProtectedRead:async(resource,evidence,operation)=>{seen={resource,evidence};return await operation()}});cleanups.push(()=>service.close());
 expect(await service.materialize({}, {method:'_readVersionContent',args:[{id:v.versionId}]},async()=>v.bytes)).toEqual(v.bytes);expect(seen.resource.versionId).toBe(v.versionId);expect(seen.evidence.storageRootFrameIds).toEqual(['protected']);
});
test('Consumer scope filters project uploads before mapping their names or metadata',async()=>{
 const {f,policy,service}=fixture(),secret=f.add('secret-upload',{root:'uploads',creating:null,producing:null,upload:true}),ordinary=f.add('ordinary-upload',{root:'uploads',creating:null,producing:null,upload:true});
 await policy.recordCreated(await policy.captureFrame('protected'),{versionId:secret.versionId});await policy.recordCreated(await policy.captureFrame('ordinary'),{versionId:ordinary.versionId});
 const rows=[{version_id:secret.versionId,filename:'protected filename'},{version_id:ordinary.versionId,filename:'ordinary filename'}];
 const result=await service.withConsumer({}, {frameId:'ordinary',user:{user_id:'owner-a'}},()=>service.filter({}, {method:'list_uploads_for_project',args:['project-a']},rows));
 expect(result).toEqual([rows[1]]);expect(JSON.stringify(result)).not.toContain('protected');
});
test('Save captures the trusted context before commit and classifies the exact returned version before release',async()=>{
 const {f,policy,service}=fixture(),v=f.add('new-version');let writes=0;
 const result=await service.save({}, {frame_id:'ordinary'},async()=>{writes++;return {artifact_id:v.artifactId,version_id:v.versionId}});
 expect(result).toEqual({artifact_id:v.artifactId,version_id:v.versionId});expect(writes).toBe(1);expect(policy.snapshot().resources[0]).toMatchObject({artifactId:v.artifactId,versionId:v.versionId,dataClass:'standard'});
});
test('Protected staging does not finish until exact classification has committed',async()=>{
 let policy:any,classifiedInside=false,entered='';const setup=fixture({},()=>false,async(frameId,kind,operation)=>{entered=`${frameId}:${kind}`;const value=await operation();classifiedInside=policy.snapshot().resources.some((row:any)=>row.versionId==='classified-version');return value});policy=setup.policy;
 const v=setup.f.add('classified-version');await setup.service.save({}, {frame_id:'ordinary',project_id:'project-a'},async()=>({artifact_id:v.artifactId,version_id:v.versionId}));
 expect(entered).toBe('ordinary:artifact');expect(classifiedInside).toBe(true);
});
test('An ordinary bundled seed may save before its frame row exists, but only for the exact unavailable-frame error',async()=>{
 let resolve:(frameId:string)=>any;
 const setup=fixture({resolveContext:frameId=>resolve(frameId)}),{f,policy,service}=setup;resolve=frameId=>frameId==='new-seed'?unavailableFrame():f.resolveContext(frameId);
 const v=f.add('seed-version',{root:'new-seed',creating:'new-seed',producing:'new-seed'});let writes=0;
 expect(await service.save({}, {frame_id:'new-seed'},async()=>{writes++;return {version_id:v.versionId}})).toEqual({version_id:v.versionId});
 expect(writes).toBe(1);expect(policy.snapshot().resources).toEqual([]);
});
test('A missing seed frame cannot use ordinary compatibility after protected history exists',async()=>{
 let resolve:(frameId:string)=>any;
 const setup=fixture({resolveContext:frameId=>resolve(frameId)}),{f,policy,service}=setup;resolve=frameId=>frameId==='new-seed'?unavailableFrame():f.resolveContext(frameId);
 const secret=f.add('protected-history',{root:'protected'});await policy.recordCreated(await policy.captureFrame('protected'),{versionId:secret.versionId});let writes=0;
 await expect(service.save({}, {frame_id:'new-seed'},async()=>{writes++;return {version_id:'seed-version'}})).rejects.toThrow('unavailable');
 expect(writes).toBe(0);
});
test('An active protected session closes pre-frame seed compatibility before the first write',async()=>{
 const {service}=fixture({resolveContext:unavailableFrame},()=>true);let writes=0;
 await expect(service.save({}, {frame_id:'new-seed'},async()=>{writes++;return {version_id:'seed-version'}})).rejects.toThrow('unavailable');
 expect(writes).toBe(0);
});
test('A seed save never swallows an invalid native frame scope',async()=>{
 const {service}=fixture({resolveContext:()=>{throw new SessionPolicyError('invalid_frame_scope','The research session scope could not be verified.')}});let writes=0;
 await expect(service.save({}, {frame_id:'new-seed'},async()=>{writes++;return {version_id:'seed-version'}})).rejects.toThrow('could not be verified');
 expect(writes).toBe(0);
});
test('A committed save without an exact version stays unclassified and returns an explicit failure',async()=>{
 const {f,policy,service}=fixture();f.add('missing-result');let writes=0;
 await expect(service.save({}, {frame_id:'ordinary'},async()=>{writes++;return {artifact_id:'artifact-missing-result'}})).rejects.toThrow('exact version ID');
 expect(writes).toBe(1);expect(policy.snapshot().resources).toEqual([]);
});
test('Upload request authenticates owner and captures a supplied composer frame before multipart work',async()=>{
 const {service}=fixture();let ran=0;
 await expect(service.withUploadRequest({getUser:()=>({user_id:'other'})},{query:{frameId:'ordinary'}},async()=>ran++)).rejects.toThrow('owner');
 const value=await service.withUploadRequest({getUser:()=>({user_id:'owner-a'})},{query:{frameId:'ordinary'}},async()=>{ran++;return 'ok'});expect(value).toBe('ok');expect(ran).toBe(1);
});
test('Upload storage uses the authenticated composer frame instead of the shared uploads root',async()=>{
 const routed:string[]=[];const {f,service}=fixture({},()=>false,async(frameId,kind,operation)=>{routed.push(`${frameId}:${kind}`);return await operation()}),v=f.add('scoped-upload',{root:'ordinary',upload:true});
 await service.withUploadRequest({getUser:()=>({user_id:'owner-a'})},{query:{frameId:'ordinary'}},()=>service.saveUpload({}, {root_frame_id:'uploads',project_id:'project-a'},async()=>({artifact_id:v.artifactId,version_id:v.versionId})));
 expect(routed).toEqual(['ordinary:upload']);
});
test('First protected history closes every ambiguous compatibility path',async()=>{
 const {f,policy,service}=fixture(),v=f.add('secret',{root:'protected'});await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});let calls=0;
 await expect(service.materialize({}, {method:'resolve_storage_path_contained',args:['project/file']},async()=>{calls++;return '/unused'})).rejects.toThrow('exact version');
 await expect(service.withUploadRequest({getUser:()=>({user_id:'owner-a'})},{query:{}},async()=>{calls++;return null})).rejects.toThrow('research chat');
 expect(service.visible({version_id:v.versionId},'ordinary',new Set())).toBe(false);expect(calls).toBe(0);
});
test('HTTP read requires owner and exact policy authorization before raw bytes',async()=>{
 const {f,policy,service,setFrame}=fixture(),v=f.add('secret',{root:'protected'});await policy.recordCreated(await policy.captureFrame('protected'),{versionId:v.versionId});setFrame('ordinary');
 await expect(service.httpRead({}, {user:{user_id:'other'},metadata:{version_id:v.versionId},id:v.versionId,label:'file'})).rejects.toThrow('verified');
 await expect(service.httpRead({}, {user:{user_id:'owner-a'},metadata:{version_id:v.versionId},id:v.versionId,label:'file'})).rejects.toThrow('not approved');
});
