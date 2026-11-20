import {Database} from 'bun:sqlite';
import {isAbsolute,join,relative} from 'node:path';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import type {FrameIdentity} from './session-policy';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const validId=(v:unknown):v is string=>typeof v==='string'&&ID.test(v);
const nullableId=(v:unknown)=>v===null||validId(v);
export type ArtifactLookup={versionId:string;artifactId?:never}|{artifactId:string;versionId?:never};
/** Server-only native identity metadata. Storage paths never grant read access. */
export type NativeArtifactContext=Readonly<{
 artifactId:string;versionId:string;projectId:string;ownerId:string;organizationId:string;
 rootFrameId:string|null;creatingFrameId:string|null;producingFrameId:string|null;
 sourceFrames:ReadonlyArray<Readonly<FrameIdentity>>;checksum:string;sizeBytes:number;
 contentType:string;storagePath:string;isUserUpload:boolean;parentVersionId:string|null;
}>;
function contained(root:string,path:string){const r=relative(root,path);return r!==''&&!r.startsWith('..')&&!isAbsolute(r)}
function directory(path:string){const s=lstatSync(path);return s.isDirectory()&&!s.isSymbolicLink()}
function file(path:string){const s=lstatSync(path);return s.isFile()&&!s.isSymbolicLink()}
function columns(db:Database,name:string,required:string[]){
 const rows=db.query('PRAGMA table_info("'+name+'")').all() as Array<{name:string;pk:number}>;
 if(rows.length>256||!rows.some(r=>r.name==='id'&&r.pk===1)||rows.some(r=>r.name!=='id'&&r.pk!==0)||required.some(c=>!rows.some(r=>r.name===c)))throw Error('unsupported-resource-schema');
 return new Set(rows.map(r=>r.name));
}
function schema(db:Database){
 const tables=db.query('PRAGMA table_list').all() as Array<{schema:string;name:string;type:string}>;
 if(tables.length>2048||['projects','frames','artifacts','artifact_versions'].some(name=>!tables.some(t=>t.schema==='main'&&t.name===name&&t.type==='table')))throw Error('unsupported-resource-schema');
 const projects=columns(db,'projects',['user_id']);columns(db,'frames',['parent_frame_id','root_frame_id','project_id']);
 columns(db,'artifacts',['project_id','root_frame_id','frame_id','latest_version_id','is_user_upload']);
 const versions=columns(db,'artifact_versions',['artifact_id','frame_id','checksum','size_bytes','content_type','storage_path']);
 const fks=db.query('PRAGMA foreign_key_list("artifact_versions")').all() as Array<{table:string;from:string;to:string}>;
 if(!fks.some(k=>k.table==='artifacts'&&k.from==='artifact_id'&&k.to==='id'))throw Error('unsupported-resource-schema');
 const frameKeys=db.query('PRAGMA foreign_key_list("frames")').all() as Array<{table:string;from:string;to:string}>;
 for(const [from,table] of [['project_id','projects'],['parent_frame_id','frames'],['root_frame_id','frames']])if(!frameKeys.some(k=>k.from===from&&k.table===table&&k.to==='id'))throw Error('unsupported-resource-schema');
 const artifactKeys=db.query('PRAGMA foreign_key_list("artifacts")').all() as Array<{table:string;from:string;to:string}>;if(!artifactKeys.some(k=>k.from==='project_id'&&k.table==='projects'&&k.to==='id'))throw Error('unsupported-resource-schema');
 return {archived:projects.has('archived_at'),parentVersion:versions.has('parent_version_id')};
}
function frameInSnapshot(db:Database,id:string,projectId:string,ownerId:string,organizationId:string):FrameIdentity{
 type Row={id:string;parent_frame_id:string|null;root_frame_id:string|null;project_id:string|null};
 const read=(id:string)=>{const rows=db.query('SELECT id,parent_frame_id,root_frame_id,project_id FROM frames WHERE id=? LIMIT 2').all(id) as Row[];if(rows.length!==1||rows[0].id!==id||![rows[0].parent_frame_id,rows[0].root_frame_id,rows[0].project_id].every(nullableId))throw Error('invalid-resource-frame');return rows[0]};
 const initial=read(id),ancestry:Row[]=[],seen=new Set<string>();let current=initial;
 for(;;){if(seen.has(current.id)||ancestry.length>=256)throw Error('invalid-resource-ancestry');seen.add(current.id);ancestry.push(current);if(current.parent_frame_id===null)break;current=read(current.parent_frame_id)}
 const root=ancestry.at(-1)!;
 if(root.project_id!==projectId||root.root_frame_id!==null&&root.root_frame_id!==root.id||ancestry.some(f=>f.project_id!==null&&f.project_id!==projectId||f.root_frame_id!==null&&f.root_frame_id!==root.id))throw Error('resource-frame-project-mismatch');
 return {frameId:id,rootFrameId:id===root.id?root.root_frame_id:root.id,parentFrameId:initial.parent_frame_id,projectId,ownerId,organizationId};
}
function resolveSnapshot(db:Database,lookup:ArtifactLookup,organizationId:string):NativeArtifactContext|undefined{
 const shape=schema(db),where='versionId'in lookup?'v.id=?':'a.id=? AND a.latest_version_id=v.id';
 const rows=db.query('SELECT a.id AS artifact_id,v.id AS version_id,a.project_id,a.root_frame_id,a.frame_id AS creating_frame_id,v.frame_id AS producing_frame_id,a.is_user_upload,v.checksum,v.size_bytes,v.content_type,v.storage_path,'+(shape.parentVersion?'v.parent_version_id':'NULL')+' AS parent_version_id,p.user_id'+(shape.archived?',p.archived_at':'')+' FROM artifact_versions v JOIN artifacts a ON a.id=v.artifact_id JOIN projects p ON p.id=a.project_id WHERE '+where+' LIMIT 2').all(lookup.versionId??lookup.artifactId) as any[];
 if(rows.length===0)return;
 if(rows.length!==1)throw Error('ambiguous-resource');const r=rows[0];
 if(![r.artifact_id,r.version_id,r.project_id,r.user_id].every(validId)||![r.root_frame_id,r.creating_frame_id,r.producing_frame_id,r.parent_version_id].every(nullableId)||shape.archived&&r.archived_at!==null||typeof r.checksum!=='string'||!/^[a-f0-9]{64}$/.test(r.checksum)||!Number.isSafeInteger(r.size_bytes)||r.size_bytes<0||typeof r.content_type!=='string'||r.content_type.length<1||r.content_type.length>255||/[\r\n\0]/.test(r.content_type)||typeof r.storage_path!=='string'||r.storage_path.length<1||r.storage_path.length>8192||r.storage_path.includes('\0')||![0,1].includes(r.is_user_upload))throw Error('invalid-resource-metadata');
 if('versionId'in lookup?r.version_id!==lookup.versionId:r.artifact_id!==lookup.artifactId)throw Error('resource-id-mismatch');
 const sourceIds=[...new Set([r.root_frame_id,r.creating_frame_id,r.producing_frame_id].filter(validId))];
 const sourceFrames=sourceIds.map(id=>Object.freeze(frameInSnapshot(db,id,r.project_id,r.user_id,organizationId)));
 return Object.freeze({artifactId:r.artifact_id,versionId:r.version_id,projectId:r.project_id,ownerId:r.user_id,organizationId,rootFrameId:r.root_frame_id,creatingFrameId:r.creating_frame_id,producingFrameId:r.producing_frame_id,sourceFrames:Object.freeze(sourceFrames),checksum:r.checksum,sizeBytes:r.size_bytes,contentType:r.content_type,storagePath:r.storage_path,isUserUpload:r.is_user_upload===1,parentVersionId:r.parent_version_id});
}
/** Exact version lookup, or explicitly pinned latest version for an artifact ID.
 * One read-only transaction covers resource, project and frame ancestry. No file
 * bytes, prompts, context, names, credentials or model-written tags are read. */
export function lookupNativeArtifact(profileDir:string,lookup:ArtifactLookup):NativeArtifactContext|undefined{
 if(!lookup||Object.keys(lookup).length!==1||!validId(lookup.versionId??lookup.artifactId))return;
 try{
  if(!directory(profileDir))return;const profile=realpathSync(profileDir),orgs=join(profile,'orgs');if(!directory(orgs))return;
  const entries=readdirSync(orgs,{withFileTypes:true}).filter(e=>!e.name.startsWith('.'));if(entries.length>256)return;
  let found:NativeArtifactContext|undefined;
  for(const entry of entries){
   if(!validId(entry.name))return;const org=join(orgs,entry.name);if(!directory(org)||!contained(profile,realpathSync(org)))return;
   const path=join(org,'operon-cli.db');if(!file(path)||!contained(org,realpathSync(path)))return;const before=lstatSync(path);let db:Database|undefined;
   try{db=new Database(path,{readonly:true,create:false});const after=lstatSync(path);if(after.dev!==before.dev||after.ino!==before.ino||after.isSymbolicLink())return;
    db.exec('PRAGMA query_only=ON');db.exec('PRAGMA trusted_schema=OFF');db.exec('PRAGMA busy_timeout=200');db.exec('BEGIN DEFERRED');
    const value=resolveSnapshot(db,lookup,entry.name);if(value){if(found)return;found=value}
   }finally{if(db){try{db.exec('ROLLBACK')}catch{}db.close()}}
  }
  return found;
 }catch{return undefined}
}
