import {Database} from 'bun:sqlite';
import {lstatSync,readdirSync,realpathSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import type {FrameIdentity} from './session-policy';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const validId=(value:unknown):value is string=>typeof value==='string'&&ID.test(value);
const nullableId=(value:unknown)=>value===null||validId(value);
type NativeFrame={id:string;parent_frame_id:string|null;root_frame_id:string|null;project_id:string|null};

function contained(root:string,path:string){const value=relative(root,path);return value!==''&&!value.startsWith('..')&&!isAbsolute(value)}
function plainDirectory(path:string){const info=lstatSync(path);return info.isDirectory()&&!info.isSymbolicLink()}
function plainFile(path:string){const info=lstatSync(path);return info.isFile()&&!info.isSymbolicLink()}
function tableColumns(db:Database,name:'frames'|'projects'){
 const rows=db.query('PRAGMA table_info("'+name+'")').all() as Array<{name:string;pk:number}>;
 if(rows.length>256||!rows.some(row=>row.name==='id'&&row.pk===1)||rows.some(row=>row.name!=='id'&&row.pk!==0))return undefined;
 return new Set(rows.map(row=>row.name));
}
function inspectSchema(db:Database){
 const tables=db.query('PRAGMA table_list').all() as Array<{schema:string;name:string;type:string}>;
 if(tables.length>2048||!['frames','projects'].every(name=>tables.some(table=>table.schema==='main'&&table.name===name&&table.type==='table')))return undefined;
 const frames=tableColumns(db,'frames'),projects=tableColumns(db,'projects');
 if(!frames||!projects||!['id','parent_frame_id','root_frame_id','project_id'].every(name=>frames.has(name))||!projects.has('user_id'))return undefined;
 const keys=db.query('PRAGMA foreign_key_list("frames")').all() as Array<{table:string;from:string;to:string}>;
 for(const [column,table] of [['project_id','projects'],['parent_frame_id','frames'],['root_frame_id','frames']])if(!keys.some(key=>key.from===column&&key.table===table&&key.to==='id'))return undefined;
 return {archived:projects.has('archived_at')};
}
function resolveInDatabase(db:Database,frameId:string,organizationId:string):FrameIdentity|undefined{
 const schema=inspectSchema(db);if(!schema)throw Error('unsupported-frame-schema');
 // Query only identity/ancestry metadata. Payload, context, prompts, transcripts,
 // model instructions and credential tables are never selected.
 const selectFrame=db.query('SELECT id, parent_frame_id, root_frame_id, project_id FROM frames WHERE id = ? LIMIT 2');
 const read=(id:string):NativeFrame|undefined=>{
  const rows=selectFrame.all(id) as NativeFrame[];if(rows.length===0)return undefined;if(rows.length!==1)throw Error('ambiguous-frame');
  const row=rows[0];if(row.id!==id||!nullableId(row.parent_frame_id)||!nullableId(row.root_frame_id)||!nullableId(row.project_id))throw Error('invalid-frame-identity');return row;
 };
 const frame=read(frameId);if(!frame)return undefined;
 const ancestry:NativeFrame[]=[],seen=new Set<string>();let current:NativeFrame|undefined=frame;
 while(current){
  if(seen.has(current.id)||ancestry.length>=256)throw Error('invalid-frame-ancestry');
  seen.add(current.id);ancestry.push(current);
  if(current.parent_frame_id===null)break;
  current=read(current.parent_frame_id);if(!current)throw Error('missing-frame-parent');
 }
 const root=ancestry[ancestry.length-1];
 if(!root||root.parent_frame_id!==null||root.root_frame_id!==null&&root.root_frame_id!==root.id||!validId(root.project_id))throw Error('invalid-frame-root');
 for(const entry of ancestry){
  if(entry.root_frame_id!==null&&entry.root_frame_id!==root.id||entry.project_id!==null&&entry.project_id!==root.project_id)throw Error('frame-scope-mismatch');
 }
 const query='SELECT id, user_id'+(schema.archived?', archived_at':'')+' FROM projects WHERE id = ? LIMIT 2';
 const projects=db.query(query).all(root.project_id) as Array<{id:string;user_id:string|null;archived_at?:number|null}>;
 if(projects.length!==1||projects[0].id!==root.project_id||!validId(projects[0].user_id)||schema.archived&&projects[0].archived_at!==null)throw Error('unowned-or-unavailable-project');
 return {frameId:frame.id,rootFrameId:frame.id===root.id?root.root_frame_id:root.id,parentFrameId:frame.parent_frame_id,
  projectId:root.project_id,ownerId:projects[0].user_id,organizationId};
}

/**
 * Native tenant layout is profile/orgs/<organizationId>/operon-cli.db. The
 * native repository authorizes projects by projects.id and projects.user_id.
 * Missing ownership has no local-user or directory-name fallback.
 *
 * Fresh read-only snapshots make policy revalidation see project ownership
 * changes. Ambiguous, unsafe or unsupported stores return no identity without
 * exposing database errors or identity values. No readOnly role is invented.
 */
export function lookupFrame(profileDir:string,frameId:string):FrameIdentity|undefined{
 if(!validId(frameId))return undefined;
 try{
  if(!plainDirectory(profileDir))return undefined;
  const profile=realpathSync(profileDir),orgs=join(profile,'orgs');if(!plainDirectory(orgs))return undefined;
  const entries=readdirSync(orgs,{withFileTypes:true}).filter(entry=>!entry.name.startsWith('.'));
  if(entries.length>256)return undefined;
  let identity:FrameIdentity|undefined;
  for(const entry of entries){
   if(!validId(entry.name))return undefined;
   const directory=join(orgs,entry.name);if(!plainDirectory(directory)||!contained(profile,realpathSync(directory)))return undefined;
   const path=join(directory,'operon-cli.db');if(!plainFile(path)||!contained(directory,realpathSync(path)))return undefined;
   const before=lstatSync(path);let db:Database|undefined;
   try{
    db=new Database(path,{readonly:true,create:false});
    const opened=lstatSync(path);if(opened.dev!==before.dev||opened.ino!==before.ino||opened.isSymbolicLink())return undefined;
    db.exec('PRAGMA query_only = ON');db.exec('PRAGMA trusted_schema = OFF');db.exec('PRAGMA busy_timeout = 200');db.exec('BEGIN DEFERRED');
    const found=resolveInDatabase(db,frameId,entry.name);
    if(found){if(identity)return undefined;identity=found}
   }finally{if(db){try{db.exec('ROLLBACK')}catch{/* Connection may have failed before BEGIN. */}db.close()}}
  }
  return identity;
 }catch{return undefined}
}
