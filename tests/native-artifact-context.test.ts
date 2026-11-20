import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,readFileSync,readdirSync,renameSync,symlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {lookupNativeArtifact} from '../src/native-artifact-context';
import {artifactFixture} from './helpers/native-artifact-fixture';
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const done of cleanups.splice(0).reverse())done()});
function fixture(){const f=artifactFixture();cleanups.push(f.cleanup);return f}
test('exact native version identity retains separate producer/creator/root and immutable checksum',()=>{
 const f=fixture(),v=f.add('v1',{root:'protected',producing:'protected-child'}),before=readFileSync(f.path),files=readdirSync(f.directory).sort();
 const resource=lookupNativeArtifact(f.profile,{versionId:v.versionId});expect(resource).toMatchObject({versionId:'v1',artifactId:v.artifactId,ownerId:'owner-a',organizationId:'org-a',projectId:'project-a',rootFrameId:'protected',creatingFrameId:'protected',producingFrameId:'protected-child',checksum:v.checksum,sizeBytes:v.bytes.length});
 expect(resource?.sourceFrames.map(f=>f.frameId)).toEqual(['protected','protected-child']);expect(Object.isFrozen(resource)).toBe(true);expect(JSON.stringify(resource)).not.toContain('synthetic private');expect(JSON.stringify(resource)).not.toContain('synthetic payload');expect(readFileSync(f.path)).toEqual(before);expect(readdirSync(f.directory).sort()).toEqual(files);
});
test('artifact latest lookup is explicit and version lookup never falls back to an artifact ID',()=>{
 const f=fixture(),v=f.add('v1'),newer=f.add('v2',{artifactId:v.artifactId});expect(lookupNativeArtifact(f.profile,{artifactId:v.artifactId})?.versionId).toBe(newer.versionId);expect(lookupNativeArtifact(f.profile,{versionId:v.versionId})?.versionId).toBe(v.versionId);expect(lookupNativeArtifact(f.profile,{versionId:v.artifactId})).toBeUndefined();expect(lookupNativeArtifact(f.profile,{versionId:v.versionId,artifactId:v.artifactId} as any)).toBeUndefined();
 f.edit('UPDATE artifacts SET latest_version_id=? WHERE id=?','missing',v.artifactId);expect(lookupNativeArtifact(f.profile,{artifactId:v.artifactId})).toBeUndefined();
});
test('shared uploads resolve owner but do not fabricate a producing research frame',()=>{
 const f=fixture(),v=f.add('upload',{root:'uploads',creating:null,producing:null,upload:true});expect(lookupNativeArtifact(f.profile,{versionId:v.versionId})).toMatchObject({rootFrameId:'uploads',creatingFrameId:null,producingFrameId:null,isUserUpload:true});
});
test('cross-project, missing and cyclic source ancestry fails closed',()=>{
 for(const sql of ["UPDATE artifact_versions SET frame_id='foreign'","UPDATE artifact_versions SET frame_id='missing'","UPDATE frames SET parent_frame_id='protected-child' WHERE id='protected-child'"]){const f=fixture(),v=f.add('v',{root:'protected',producing:'protected-child'});f.edit(sql);expect(lookupNativeArtifact(f.profile,{versionId:v.versionId})).toBeUndefined()}
});
test('missing owner, archived project, invalid checksum and view replacement fail closed',()=>{
 for(const sql of ["UPDATE projects SET user_id=NULL WHERE id='project-a'","UPDATE projects SET archived_at=1 WHERE id='project-a'","UPDATE artifact_versions SET checksum='not-a-digest'","view"]){const f=fixture(),v=f.add('v');if(sql==='view'){f.edit('ALTER TABLE artifacts RENAME TO old_artifacts');f.edit('CREATE VIEW artifacts AS SELECT * FROM old_artifacts')}else f.edit(sql);expect(lookupNativeArtifact(f.profile,{versionId:v.versionId})).toBeUndefined()}
});
test('duplicate organizational version IDs and symlinked databases are not trusted',()=>{
 const f=fixture(),v=f.add('v'),second=join(f.profile,'orgs','org-b');mkdirSync(second);writeFileSync(join(second,'operon-cli.db'),readFileSync(f.path));expect(lookupNativeArtifact(f.profile,{versionId:v.versionId})).toBeUndefined();
 const g=fixture(),w=g.add('w'),original=g.path+'.original';renameSync(g.path,original);symlinkSync(original,g.path);expect(lookupNativeArtifact(g.profile,{versionId:w.versionId})).toBeUndefined();
});
