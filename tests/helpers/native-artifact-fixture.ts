import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {lookupNativeArtifact} from '../../src/native-artifact-context';
import {lookupFrame} from '../../src/native-frame-context';
import {ResourcePolicyStore,type ResourcePolicyDependencies} from '../../src/resource-policy';

export function artifactFixture(){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-resource-policy-')),directory=join(profile,'orgs','org-a'),storage=join(profile,'storage');mkdirSync(directory,{recursive:true});mkdirSync(storage);
 const path=join(directory,'operon-cli.db'),db=new Database(path,{create:true});
 db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY,user_id TEXT,archived_at INTEGER,name TEXT);'+
  'CREATE TABLE frames(id TEXT PRIMARY KEY,parent_frame_id TEXT REFERENCES frames(id),root_frame_id TEXT REFERENCES frames(id),project_id TEXT REFERENCES projects(id));'+
  'CREATE TABLE artifacts(id TEXT PRIMARY KEY,project_id TEXT REFERENCES projects(id),root_frame_id TEXT,frame_id TEXT,latest_version_id TEXT,is_user_upload INTEGER,filename TEXT);'+
  'CREATE TABLE artifact_versions(id TEXT PRIMARY KEY,artifact_id TEXT REFERENCES artifacts(id),frame_id TEXT,parent_version_id TEXT,checksum TEXT,size_bytes INTEGER,content_type TEXT,storage_path TEXT,payload TEXT);');
 db.query('INSERT INTO projects VALUES(?,?,NULL,?)').run('project-a','owner-a','synthetic private project title');db.query('INSERT INTO projects VALUES(?,?,NULL,?)').run('project-b','owner-b','synthetic other-owner project');
 for(const root of ['ordinary','protected','uploads'])db.query('INSERT INTO frames VALUES(?,NULL,?,?)').run(root,root,'project-a');db.query('INSERT INTO frames VALUES(?,?,?,NULL)').run('protected-child','protected','protected');db.query('INSERT INTO frames VALUES(?,NULL,?,?)').run('foreign','foreign','project-b');db.close();
 const modes=new Map<string,{mode:'standard'|'class2';revision:number}>([['ordinary',{mode:'standard',revision:0}],['protected',{mode:'class2',revision:1}],['uploads',{mode:'standard',revision:0}]]);
 const edit=(sql:string,...args:any[])=>{const db=new Database(path);try{db.query(sql).run(...args)}finally{db.close()}};
 const add=(versionId:string,options:{artifactId?:string;root?:string|null;creating?:string|null;producing?:string|null;project?:string;upload?:boolean;parent?:string|null;text?:string;type?:string}={})=>{
  const artifactId=options.artifactId??'artifact-'+versionId,project=options.project??'project-a',root=options.root===undefined?'ordinary':options.root,creating=options.creating===undefined?root:options.creating,producing=options.producing===undefined?root:options.producing,text=options.text??'synthetic bytes '+versionId,bytes=Buffer.from(text),checksum=createHash('sha256').update(bytes).digest('hex'),relative=project+'/'+artifactId+'/'+versionId+'/file.bin',absolute=join(storage,relative);
  mkdirSync(dirname(absolute),{recursive:true});writeFileSync(absolute,bytes);
  const connection=new Database(path);try{connection.query('INSERT OR IGNORE INTO artifacts VALUES(?,?,?,?,?,?,?)').run(artifactId,project,root,creating,versionId,options.upload?1:0,'synthetic private filename '+versionId);connection.query('INSERT INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?)').run(versionId,artifactId,producing,options.parent??null,checksum,bytes.length,options.type??'text/plain',relative,'synthetic payload never selected');connection.query('UPDATE artifacts SET latest_version_id=? WHERE id=?').run(versionId,artifactId)}finally{connection.close()}
  return {versionId,artifactId,checksum,relative,absolute,bytes};
 };
 const resolveContext=(frameId:string)=>{const frame=lookupFrame(profile,frameId);if(!frame)throw Error('Synthetic native frame unavailable');const root=frame.rootFrameId??frame.frameId,policy=modes.get(root)??{mode:'standard' as const,revision:0};return {frameId,rootFrameId:root,projectId:frame.projectId,ownerId:frame.ownerId,organizationId:frame.organizationId,...policy,readOnly:false}};
 const stores:ResourcePolicyStore[]=[];
 const store=(overrides:Partial<ResourcePolicyDependencies>={})=>{const result=new ResourcePolicyStore(profile,{owner:{userId:'owner-a',organizationId:'org-a'},resolveVersion:lookup=>lookupNativeArtifact(profile,lookup),resolveContext,...overrides});stores.push(result);return result};
 return {profile,directory,path,storage,modes,edit,add,resolveContext,store,read:(relative:string)=>readFileSync(join(storage,relative)),cleanup:()=>{for(const store of stores)store.close();rmSync(profile,{recursive:true,force:true})}};
}
