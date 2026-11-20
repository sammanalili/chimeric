import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConfidentialityManager} from '../src/confidentiality-manager';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn()});
function fixture(protectedBuild=true,nativeBoundary?:any){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-confidentiality-'));
 const models=['inside::main','inside::review','outside::other'].map(qualifiedId=>{const [provider,id]=qualifiedId.split('::');return {provider,id,qualifiedId,name:id,mode:'chat',api:'openai-completions'}});
 const registry:any={profileDir:dir,config:{providers:Object.fromEntries(['inside','outside','cli'].map(id=>[id,{name:id,api:id==='cli'?'claude-code':'openai-completions',baseUrl:'https://'+id+'.example/v1',revision:'a',enabled:true}]))},state:{model:'inside::main'},statuses:Object.fromEntries(['inside','outside','cli'].map(id=>[id,{ready:true}])),models:new Map(models.map(m=>[m.qualifiedId,m])),getPrivateCredential:()=>undefined,resolve:(id:string)=>{const model=models.find(m=>m.qualifiedId===id);if(!model)throw Error('unknown model');return model}};
 const manager=new ConfidentialityManager(registry, {protectionEvidence:()=>({verified:protectedBuild}),owner:{userId:'owner',organizationId:'org'},lookupFrame:(_p,id)=>({frameId:id,rootFrameId:id==='child'?'root':id,parentFrameId:id==='child'?'root':null,projectId:'p',ownerId:id==='foreign'?'someone-else':'owner',organizationId:'org'}),transport:async()=>({status:200,headers:{'content-type':'text/plain'},bodyBase64:'b2s='}),nativeBoundary});
 cleanup.push(()=>{manager.close();rmSync(dir,{recursive:true,force:true})});return {manager,registry};
}
async function enable(m:ConfidentialityManager){await m.approveConnection({connectionId:'inside',expectedRevision:0,purposes:['model']});await m.setMode({frameId:'root',mode:'class2',expectedRevision:0,main:'inside::main',reviewer:'inside::review'})}
function request(m:ConfidentialityManager,frameId:string,callSite='main'){return new Request('http://127.0.0.1/messages',{headers:m.scope.requestOptions({frameId,callSite},{},{}).headers})}
test('missing build-wide protection evidence blocks activation and cannot be bypassed by a low-level policy mutation',async()=>{
 const {manager:m}=fixture(false);await m.approveConnection({connectionId:'inside',expectedRevision:0,purposes:['model']});const state:any=await m.snapshot({frameId:'root'});expect(state.ready).toBe(false);expect(state.reason).toContain('cross-chat file isolation');
 await expect(m.setMode({frameId:'root',mode:'class2',expectedRevision:0,main:'inside::main'})).rejects.toThrow('unavailable');expect((await m.snapshot({frameId:'root'}) as any).mode).toBe('standard');
 const context=await m.ownedContext('root');m.policy.setMode(context,{mode:'class2',expectedRevision:0,main:{connection:m.binding('inside')!,modelId:'main'}});
 await expect(m.authorize(request(m,'root'),{model:'inside::main',protectionEvidence:{verified:true}})).rejects.toThrow('unavailable');
});
test('eligibility is generic, initially Off, and does not claim ZDR',async()=>{
 const {manager:m}=fixture();expect((await m.snapshot({frameId:'root'}) as any).ready).toBe(false);
 await expect(m.setMode({frameId:'root',mode:'class2',expectedRevision:0})).rejects.toThrow('Choose');
 await m.approveConnection({connectionId:'inside',expectedRevision:0,purposes:['model']});
 const state:any=await m.snapshot({connectionId:'inside'});expect(state.allowedPurposes).toEqual(['model']);expect(state.evidence.zdr).toBe('unknown');
 await expect(m.approveConnection({connectionId:'cli',expectedRevision:1,purposes:['model']})).rejects.toThrow('not been confined');
});
test('descendants route all roles to approved models and other chats keep their model',async()=>{
 const {manager:m}=fixture();await enable(m);
 for(const site of ['main','memory_repair','compaction','lineage','classifier','reviewer']){const a=await m.authorize(request(m,'child',site),{model:'outside::other'});expect(a.modelId).toBe(site==='reviewer'?'inside::review':'inside::main');await a.assertCurrent();a.close()}
 const a=await m.authorize(request(m,'other'),{model:'outside::other'});expect(a.modelId).toBe('outside::other');a.close();
});
test('wrong owner, missing scope, credential and policy changes stop protected requests',async()=>{
 const {manager:m,registry:r}=fixture();await enable(m);
 await expect(m.snapshot({frameId:'foreign'})).rejects.toThrow('different local');
 await expect(m.authorize(new Request('http://127.0.0.1/messages'),{model:'inside::main',class2:false})).rejects.toThrow('no verified chat');
 const a=await m.authorize(request(m,'root'),{model:'outside::other'});r.config.providers.inside.revision='b';await expect(a.assertCurrent()).rejects.toThrow('no longer approved');a.close();r.config.providers.inside.revision='a';
 const b=await m.authorize(request(m,'root'),{model:'outside::other'});await m.setMode({frameId:'root',mode:'standard',expectedRevision:1});expect(b.signal?.aborted).toBe(true);b.close();
});
test('unverified tools cannot reach external execution',async()=>{
 const {manager:m}=fixture();await enable(m);
 for(const kind of ['kernel','process','host-call','network-grant','shell','tool'])await expect(m.guardNativeExecution(kind,{frameId:'child'},{})).rejects.toThrow('not yet verified');
 const a=await m.authorize(request(m,'root'),{model:'inside::main'});await expect(a.executeServerTool!('web_search',{},undefined)).rejects.toThrow('reviewed outgoing');a.close();
 await expect(m.guardNativeExecution('kernel',{frameId:'other'},{})).resolves.toBeUndefined();
});
test('model prepares review; owned human action sends exactly once',async()=>{
 const {manager:m}=fixture();await enable(m);const v=await m.prepareOutgoing('child',{intentId:'request1',rationale:'Read public material properties',privacy:{kind:'decontextualized',summary:'Only a public material name'},request:{method:'GET',url:'https://science.example/?q=water',payload:{kind:'none'}}});
 expect(v.status).toBe('pending');await expect(m.sendOnce({frameId:'other',reviewId:v.id,digest:v.digest})).rejects.toThrow('unavailable');
 expect((await m.sendOnce({frameId:'root',reviewId:v.id,digest:v.digest})).status).toBe(200);await expect(m.sendOnce({frameId:'root',reviewId:v.id,digest:v.digest})).rejects.toThrow('already decided');
});
test('Connections edits preserve selected-STT automatic permission without promoting it',async()=>{
 const {manager:m}=fixture(),binding=m.binding('inside')!;m.policy.selectStt(binding,0);
 let s:any=await m.snapshot({connectionId:'inside'});expect(s.allowedPurposes).toEqual([]);expect(s.automaticPurposes).toEqual(['stt']);
 await m.approveConnection({connectionId:'inside',expectedRevision:1,purposes:['model']});s=await m.snapshot({connectionId:'inside'});expect(s.allowedPurposes).toEqual(['model']);expect(s.automaticPurposes).toEqual(['stt']);
 m.policy.selectStt(null,2);s=await m.snapshot({connectionId:'inside'});expect(s.allowedPurposes).toEqual(['model']);expect(s.automaticPurposes).toEqual([]);
});
test('provider edit notification invalidates an earlier human approval revision',async()=>{
 const {manager:m,registry:r}=fixture();const before:any=await m.snapshot({connectionId:'inside'});r.config.providers.inside.baseUrl='https://changed.example/v1';r.config.providers.inside.revision='new';m.connectionChanged('inside');
 await expect(m.approveConnection({connectionId:'inside',expectedRevision:before.revision,purposes:['model']})).rejects.toThrow('changed');const after:any=await m.snapshot({connectionId:'inside'});expect(after.revision).toBeGreaterThan(before.revision);expect(after.allowedPurposes).toEqual([]);
});
test('binding drift invalidates old approval even without a provider notification',async()=>{
 const {manager:m,registry:r}=fixture();const before:any=await m.snapshot({connectionId:'inside'});r.config.providers.inside.baseUrl='https://changed.example/v1';
 await expect(m.approveConnection({connectionId:'inside',expectedRevision:before.revision,purposes:['model']})).rejects.toThrow('changed');expect((await m.snapshot({connectionId:'inside'}) as any).allowedPurposes).toEqual([]);
});
test('native external-access tool waits for human review and resumes only with approved result',async()=>{
 const {manager:m}=fixture();await enable(m);let finished=false;
 const promise=m.executeOutgoing({frameId:'child',rootFrameId:'root',projectId:'p',agentName:'research'},{id:'native1'},{rationale:'Look up public data',privacy:{kind:'decontextualized',summary:'A public material name'},request:{method:'GET',url:'https://science.example/?q=water',payload:{kind:'none'}}}).then(result=>{finished=true;return result});
 let review:any;for(let i=0;i<30&&!review;i++){await new Promise(resolve=>setTimeout(resolve,1));const s:any=await m.snapshot({frameId:'root'});review=s.reviews[0]}
 expect(review.status).toBe('pending');expect(finished).toBe(false);await m.sendOnce({frameId:'root',reviewId:review.id,digest:review.digest});expect((await promise as any).status).toBe('success');
});
test('native transition, execution and model leases cover the authenticated frame lifecycle',async()=>{
 const events:string[]=[],modelAbort=new AbortController();let leases=0;
 const boundary={
  async transition(context:any,target:string,apply:()=>void|Promise<void>){events.push('transition:'+context.rootFrameId+':'+target);await apply()},
  noteExecution(kind:string,context:any){events.push('execution:'+context.rootFrameId+':'+kind)},
  assertHostContext(){events.push('host-context')},
  beginModel(context:any){events.push('model:'+context.rootFrameId);leases++;let closed=false;return {signal:modelAbort.signal,assertCurrent:()=>events.push('model-current'),close:()=>{if(!closed){closed=true;leases--;events.push('model-close')}}}},
 };
 const {manager:m}=fixture(true,boundary);await enable(m);
 const authorization=await m.authorize(request(m,'child','reviewer'),{model:'outside::other'});expect(authorization.modelId).toBe('inside::review');expect(leases).toBe(1);await authorization.assertCurrent();authorization.close();authorization.close();expect(leases).toBe(0);
 await m.guardNativeExecution('process',{frameId:'other'},{});await m.guardNativeExecution('host-call',{frameId:'other'},{});
 await m.setMode({frameId:'root',mode:'standard',expectedRevision:1});
 expect(events).toContain('transition:root:class2');expect(events).toContain('transition:root:standard');expect(events).toContain('execution:other:process');expect(events).toContain('host-context');expect(events.filter(value=>value==='model-close')).toHaveLength(1);
});
