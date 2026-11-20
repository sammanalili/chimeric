import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,readdirSync,symlinkSync,unlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {lookupFrame} from '../src/native-frame-context';
import {SessionPolicyStore} from '../src/session-policy';

const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()});
function fixture(){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-native-frame-'));cleanups.push(()=>rmSync(profile,{recursive:true,force:true}));mkdirSync(join(profile,'orgs'));
 const create=(organization='org-a',ownerColumn='user_id')=>{
  const directory=join(profile,'orgs',organization);mkdirSync(directory);const path=join(directory,'operon-cli.db'),db=new Database(path,{create:true});
  db.exec('CREATE TABLE projects(id TEXT PRIMARY KEY, '+ownerColumn+' TEXT, archived_at INTEGER, name TEXT, context TEXT);'+
   'CREATE TABLE frames(id TEXT PRIMARY KEY,parent_frame_id TEXT REFERENCES frames(id),root_frame_id TEXT REFERENCES frames(id),project_id TEXT REFERENCES projects(id),input_data TEXT,output_data TEXT,context_data TEXT);'+
   'CREATE TABLE frame_messages(frame_id TEXT, msg_json TEXT);');
  db.query('INSERT INTO projects(id,'+ownerColumn+',name,context) VALUES(?,?,?,?)').run('project-a','owner-a','synthetic private title','synthetic project payload must not be returned');
  db.query('INSERT INTO projects(id,'+ownerColumn+') VALUES(?,?)').run('project-b','owner-b');
  const insert=(id:string,parent:string|null,root:string|null,project:string|null)=>db.query('INSERT INTO frames(id,parent_frame_id,root_frame_id,project_id,input_data,output_data,context_data) VALUES(?,?,?,?,?,?,?)').run(id,parent,root,project,'synthetic input must not be returned','synthetic output must not be returned','synthetic context must not be returned');
  insert('root',null,null,'project-a');insert('child','root','root',null);insert('grandchild','child','root','project-a');
  db.query('INSERT INTO frame_messages VALUES(?,?)').run('root','synthetic transcript must not be returned');db.close();
  const edit=(sql:string,...args:any[])=>{const connection=new Database(path);try{connection.query(sql).run(...args)}finally{connection.close()}};
  return {path,directory,edit};
 };
 const database=create();return {profile,create,...database};
}
test('native root and descendants resolve only database-owned project identity without inventing readOnly roles',()=>{
 const f=fixture();
 expect(lookupFrame(f.profile,'root')).toEqual({frameId:'root',rootFrameId:null,parentFrameId:null,projectId:'project-a',ownerId:'owner-a',organizationId:'org-a'});
 expect(lookupFrame(f.profile,'child')).toEqual({frameId:'child',rootFrameId:'root',parentFrameId:'root',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a'});
 expect(lookupFrame(f.profile,'grandchild')?.parentFrameId).toBe('child');expect(lookupFrame(f.profile,'grandchild')).not.toHaveProperty('readOnly');
});
test('the adapter never returns research payload and leaves the native database bytes unchanged',()=>{
 const f=fixture(),before=readFileSync(f.path),entries=readdirSync(f.directory).sort();
 const identity=lookupFrame(f.profile,'grandchild');expect(identity).toBeDefined();expect(JSON.stringify(identity)).not.toContain('synthetic');
 expect(readFileSync(f.path)).toEqual(before);expect(readdirSync(f.directory).sort()).toEqual(entries);
});
test('a child with nullable legacy root/project fields inherits only through verified parent ancestry',()=>{
 const f=fixture();f.edit('UPDATE frames SET root_frame_id=NULL WHERE id=?','child');expect(lookupFrame(f.profile,'child')).toMatchObject({rootFrameId:'root',projectId:'project-a',ownerId:'owner-a'});
});
test('missing owners, unavailable projects, and archived projects have no fabricated local fallback',()=>{
 for(const [sql,args] of [
  ['UPDATE projects SET user_id=NULL WHERE id=?',['project-a']],
  ['UPDATE projects SET user_id=? WHERE id=?',['','project-a']],
  ['DELETE FROM projects WHERE id=?',['project-a']],
  ['UPDATE projects SET archived_at=1 WHERE id=?',['project-a']],
 ] as Array<[string,any[]]>){const f=fixture();f.edit(sql,...args);expect(lookupFrame(f.profile,'root')).toBeUndefined();expect(lookupFrame(f.profile,'child')).toBeUndefined()}
});
test('explicit project/root disagreements and a parent in another project fail closed',()=>{
 for(const [sql,args] of [
  ['UPDATE frames SET project_id=? WHERE id=?',['project-b','child']],
  ['UPDATE frames SET root_frame_id=? WHERE id=?',['grandchild','child']],
  ['UPDATE frames SET parent_frame_id=NULL WHERE id=?',['child']],
  ['UPDATE frames SET parent_frame_id=? WHERE id=?',['missing','child']],
 ] as Array<[string,any[]]>){const f=fixture();f.edit(sql,...args);expect(lookupFrame(f.profile,'child')).toBeUndefined()}
});
test('self-parenting and cycles cannot mint a trusted scope',()=>{
 const f=fixture();f.edit('UPDATE frames SET parent_frame_id=? WHERE id=?','child','child');expect(lookupFrame(f.profile,'child')).toBeUndefined();
 f.edit('UPDATE frames SET parent_frame_id=? WHERE id=?','grandchild','child');expect(lookupFrame(f.profile,'grandchild')).toBeUndefined();
});
test('the same frame ID in two organizational stores is ambiguous even if one owner matches',()=>{
 const f=fixture();f.create('org-b');expect(lookupFrame(f.profile,'root')).toBeUndefined();expect(lookupFrame(f.profile,'child')).toBeUndefined();
});
test('unknown schema, fabricated owner columns, and views cannot be treated as native identity tables',()=>{
 const f=fixture();f.create('org-b','owner_id');expect(lookupFrame(f.profile,'root')).toBeUndefined();
 const second=fixture();second.edit('ALTER TABLE frames RENAME TO original_frames');second.edit('CREATE VIEW frames AS SELECT * FROM original_frames');expect(lookupFrame(second.profile,'root')).toBeUndefined();
});
test('symlinked organization directories and database files cannot escape the configured profile',()=>{
 const f=fixture(),outside=mkdtempSync(join(tmpdir(),'chimeric-outside-org-'));cleanups.push(()=>rmSync(outside,{recursive:true,force:true}));
 renameSync(f.directory,join(outside,'org-a'));symlinkSync(join(outside,'org-a'),f.directory,'dir');expect(lookupFrame(f.profile,'root')).toBeUndefined();
 unlinkSync(f.directory);mkdirSync(f.directory);symlinkSync(join(outside,'org-a','operon-cli.db'),f.path);expect(lookupFrame(f.profile,'root')).toBeUndefined();
});
test('invalid frame IDs, missing stores, and corrupt databases produce no errors or new files',()=>{
 const f=fixture(),before=readdirSync(f.directory).sort();for(const value of ['','../root',"root' OR 1=1 --",'x'.repeat(256)])expect(lookupFrame(f.profile,value)).toBeUndefined();expect(readdirSync(f.directory).sort()).toEqual(before);
 expect(lookupFrame(join(f.profile,'missing-profile'),'root')).toBeUndefined();expect(lookupFrame(f.profile,'missing-frame')).toBeUndefined();writeFileSync(f.path,'not a SQLite database');expect(()=>lookupFrame(f.profile,'root')).not.toThrow();expect(lookupFrame(f.profile,'root')).toBeUndefined();
});
test('SessionPolicyStore revalidation observes authoritative owner and organization changes',async()=>{
 const f=fixture(),store=new SessionPolicyStore(f.profile,{lookupFrame:id=>lookupFrame(f.profile,id),currentConnection:()=>undefined});cleanups.push(()=>store.close());
 const context=await store.contextForFrame('child');expect(context).toMatchObject({rootFrameId:'root',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',readOnly:false});
 f.edit('UPDATE projects SET user_id=? WHERE id=?','replacement-owner','project-a');await expect(store.revalidateContext(context)).rejects.toThrow('scope changed');
 f.edit('UPDATE projects SET user_id=? WHERE id=?','owner-a','project-a');renameSync(f.directory,join(f.profile,'orgs','org-renamed'));await expect(store.revalidateContext(context)).rejects.toThrow('scope changed');
});
