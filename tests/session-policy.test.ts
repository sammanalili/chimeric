import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionPolicyStore,connectionBindingDigest,type ConnectionBinding,type FrameIdentity,type PolicyLane} from '../src/session-policy';

const cleanups:Array<()=>void>=[];afterEach(()=>{for(const f of cleanups.splice(0).reverse())f()});
function fixture(verified=true){
 const directory=mkdtempSync(join(tmpdir(),'chimeric-session-policy-'));
 const connection:ConnectionBinding={id:'institution-models',endpoint:'https://institution.example/api/v1',api:'openai-completions',revision:'configuration-1',credentialRevision:'a'.repeat(64)};
 const connections=new Map([[connection.id,connection]]),frames=new Map<string,FrameIdentity>([
  ['root',{frameId:'root',rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org'}],
  ['child',{frameId:'child',rootFrameId:'root',parentFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org'}],
  ['reviewer',{frameId:'reviewer',rootFrameId:'root',parentFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org',readOnly:true}],
  ['other',{frameId:'other',rootFrameId:'other',projectId:'project',ownerId:'owner',organizationId:'org'}],
 ]);
 let blocked:PolicyLane|undefined;
 const options={lookupFrame:(id:string)=>frames.get(id),currentConnection:(id:string)=>connections.get(id),enforcement:(_scope:any,lane:PolicyLane)=>({verified:verified&&lane!==blocked})};
 const store=new SessionPolicyStore(directory,options);cleanups.push(()=>{store.close();rmSync(directory,{recursive:true,force:true})});
 const approve=()=>store.approveConnection(connection,['model'],store.snapshot().revision);
 return {directory,connection,connections,frames,store,options,approve,block:(lane:PolicyLane)=>{blocked=lane}};
}

test('Class 2 routes the current native chat and descendants without changing unrelated sessions',async()=>{
 const f=fixture(),root=await f.store.contextForFrame('root'),child=await f.store.contextForFrame('child'),other=await f.store.contextForFrame('other');f.approve();
 const target={connection:f.connection,modelId:'research-model'};
 expect(f.store.setMode(root,{expectedRevision:0,mode:'class2',main:target})).toMatchObject({revision:1,mode:'class2',main:target,reviewer:target});
 for(const role of ['main','reviewer','small','medium','large','memory','classifier','compaction','lineage'] as const)expect(f.store.chooseModel(child,role,'unapproved::model')).toBe('institution-models::research-model');
 expect(f.store.chooseModel(other,'reviewer','other::saved-reviewer')).toBe('other::saved-reviewer');
 expect(()=>f.store.assertModel(child,{connection:f.connection,modelId:'other-model'})).toThrow('does not match');
 expect(f.store.snapshot().sessions).toHaveLength(1);
});

test('Connection eligibility is generic and bound to endpoint, API, configuration and credential revision',async()=>{
 const f=fixture(),scope=await f.store.contextForFrame('root');f.approve();f.store.setMode(scope,{expectedRevision:0,mode:'class2',main:{connection:f.connection,modelId:'model'}});
 for(const edit of [{endpoint:'https://institution.example/other-api'},{api:'openai-responses'},{revision:'configuration-2'},{credentialRevision:'b'.repeat(64)}]){
  f.connections.set(f.connection.id,{...f.connection,...edit});expect(f.store.isApproved(f.connection,'model')).toBe(false);expect(()=>f.store.chooseModel(scope,'main','other')).toThrow();
 }
 f.connections.delete(f.connection.id);expect(()=>f.store.chooseModel(scope,'reviewer','other')).toThrow();
 expect(()=>connectionBindingDigest({...f.connection,endpoint:'https://credential:secret@institution.example/v1'})).toThrow();
 expect(()=>connectionBindingDigest({...f.connection,credentialRevision:'raw-api-key'})).toThrow();
});

test('STT selection auto-approves only speech and remains local outside Class 2',async()=>{
 const f=fixture(),scope=await f.store.contextForFrame('root'),standard=await f.store.contextForFrame('other');f.approve();
 const stt={...f.connection,id:'speech-service',endpoint:'https://speech.example/v1',api:'speech-http'};f.connections.set(stt.id,stt);
 f.store.selectStt(stt,f.store.snapshot().revision);expect(f.store.isApproved(stt,'stt')).toBe(true);expect(f.store.isApproved(stt,'model')).toBe(false);
 expect(f.store.sttFor(scope)).toEqual({kind:'local'});
 f.store.setMode(scope,{expectedRevision:0,mode:'class2',main:{connection:f.connection,modelId:'model'}});
 expect(f.store.sttFor(scope)).toEqual({kind:'connection',connection:stt});expect(f.store.sttFor(standard)).toEqual({kind:'local'});
 f.connections.set(stt.id,{...stt,credentialRevision:'c'.repeat(64)});expect(()=>f.store.sttFor(scope)).toThrow('changed');
});

test('switching speech connections or selecting Off revokes only automatic STT grants',()=>{
 const f=fixture(),speechA={...f.connection,id:'speech-a',api:'speech-http'},speechB={...f.connection,id:'speech-b',api:'speech-http'};f.connections.set(speechA.id,speechA);f.connections.set(speechB.id,speechB);
 f.store.selectStt(speechA,f.store.snapshot().revision);expect(f.store.snapshot().approvals.find(a=>a.binding.id===speechA.id)?.autoStt).toBe(true);
 f.store.selectStt(speechB,f.store.snapshot().revision);expect(f.store.isApproved(speechA,'stt')).toBe(false);expect(f.store.isApproved(speechB,'stt')).toBe(true);
 f.store.selectStt(null,f.store.snapshot().revision);expect(f.store.isApproved(speechB,'stt')).toBe(false);expect(f.store.snapshot().selectedStt).toBeNull();expect(f.store.snapshot().approvals).toEqual([]);
});

test('automatic STT on an explicit model connection never revokes its model approval',()=>{
 const f=fixture();f.approve();f.store.selectStt(f.connection,f.store.snapshot().revision);
 expect(f.store.snapshot().approvals[0]).toMatchObject({source:'user',autoStt:true,purposes:['model','stt']});
 f.store.selectStt(null,f.store.snapshot().revision);expect(f.store.isApproved(f.connection,'model')).toBe(true);expect(f.store.isApproved(f.connection,'stt')).toBe(false);expect(f.store.snapshot().approvals[0]).not.toHaveProperty('autoStt');
});

test('explicit speech approval survives switching and Off, including promotion of an automatic grant',()=>{
 const f=fixture(),other={...f.connection,id:'other-speech',api:'speech-http'};f.connections.set(other.id,other);
 f.store.selectStt(f.connection,f.store.snapshot().revision);f.store.approveConnection(f.connection,['model','stt'],f.store.snapshot().revision);
 expect(f.store.snapshot().approvals[0]).not.toHaveProperty('autoStt');
 f.store.selectStt(other,f.store.snapshot().revision);f.store.selectStt(null,f.store.snapshot().revision);
 expect(f.store.isApproved(f.connection,'model')).toBe(true);expect(f.store.isApproved(f.connection,'stt')).toBe(true);expect(f.store.isApproved(other,'stt')).toBe(false);
});

test('speech auto-grant tracking survives restart and cleans legacy selection-only approvals safely',()=>{
 const f=fixture();f.approve();f.store.selectStt(f.connection,f.store.snapshot().revision);
 const restarted=new SessionPolicyStore(f.directory,f.options);cleanups.push(()=>restarted.close());restarted.selectStt(null,restarted.snapshot().revision);expect(restarted.isApproved(f.connection,'model')).toBe(true);expect(restarted.isApproved(f.connection,'stt')).toBe(false);
 const file=join(f.directory,'local-auth/session-policy.json'),legacy=JSON.parse(readFileSync(file,'utf8'));
 legacy.approvals=[{binding:f.connection,purposes:['stt'],approvedAt:1,source:'stt-selection'}];legacy.selectedStt=f.connection;writeFileSync(file,JSON.stringify(legacy));
 const old=new SessionPolicyStore(f.directory,f.options);cleanups.push(()=>old.close());old.selectStt(null,old.snapshot().revision);expect(old.isApproved(f.connection,'stt')).toBe(false);expect(old.snapshot().approvals).toEqual([]);
});

test('Unverified lanes and read-only policy changes fail closed',async()=>{
 const f=fixture(false),scope=await f.store.contextForFrame('root'),reviewer=await f.store.contextForFrame('reviewer');f.approve();
 f.store.setMode(scope,{expectedRevision:0,mode:'class2',main:{connection:f.connection,modelId:'model'}});
 expect(()=>f.store.chooseModel(scope,'main','unapproved')).toThrow('not been verified');
 for(const lane of ['brokered-http','local-compute','mcp','remote-compute','uncontrolled-network'] as const)expect(()=>f.store.assertLane(scope,lane)).toThrow();
 expect(()=>f.store.setMode(reviewer,{expectedRevision:1,mode:'standard'})).toThrow('cannot change');
 expect(()=>f.store.policy({...scope})).toThrow('verified native');
});

test('Context minting verifies datastore root, project, owner and organization',async()=>{
 const f=fixture();
 for(const edit of [{projectId:'other-project'},{ownerId:'other-owner'},{organizationId:'other-org'},{rootFrameId:'missing-root'}]){
  f.frames.set('child',{frameId:'child',rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org',...edit});await expect(f.store.contextForFrame('child')).rejects.toThrow();
 }
 const scope=await f.store.contextForFrame('root');f.frames.delete('root');await expect(f.store.revalidateContext(scope)).rejects.toThrow('unavailable');
});

test('Policy persistence preserves approvals and scoped roles, uses private permissions and rejects corruption',async()=>{
 const f=fixture(),scope=await f.store.contextForFrame('root');f.approve();f.store.setMode(scope,{expectedRevision:0,mode:'class2',main:{connection:f.connection,modelId:'model'}});
 const restarted=new SessionPolicyStore(f.directory,f.options);cleanups.push(()=>restarted.close());
 expect(restarted.chooseModel(await restarted.contextForFrame('child'),'reviewer','other')).toBe('institution-models::model');
 expect(statSync(join(f.directory,'local-auth/session-policy.json')).mode&0o777).toBe(0o600);
 expect(statSync(join(f.directory,'local-auth')).mode&0o777).toBe(0o700);
 expect(readFileSync(join(f.directory,'local-auth/session-policy.json'),'utf8')).not.toContain('raw-api-key');
 writeFileSync(join(f.directory,'local-auth/session-policy.json'),'bad');expect(()=>new SessionPolicyStore(f.directory,f.options)).toThrow('could not be read');
});

test('CAS revisions and revoked model approval prevent stale configuration from resuming',async()=>{
 const f=fixture(),scope=await f.store.contextForFrame('root');f.approve();f.store.setMode(scope,{expectedRevision:0,mode:'class2',main:{connection:f.connection,modelId:'model'}});
 expect(()=>f.store.setMode(scope,{expectedRevision:0,mode:'standard'})).toThrow('changed');
 expect(()=>f.store.approveConnection(f.connection,['model'],0)).toThrow('changed');
 f.store.revokeConnection(f.connection.id,f.store.snapshot().revision);expect(()=>f.store.chooseModel(scope,'reviewer','other')).toThrow('no longer approved');
});
