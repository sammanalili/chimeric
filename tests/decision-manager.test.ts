import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DecisionManager} from '../src/decision-manager';
import {ProviderSecrets} from '../src/provider-secrets';
import {requestDecisions,type DecisionRequest,type DecisionResult} from '../src/decision-provider';

const cleanups:Array<()=>void>=[];
test('an unreadable optional classifier store cannot prevent app service construction or overwrite its files',async()=>{
 for(const target of ['settings','credentials']){
  const f=fixture((async()=>answer) as typeof requestDecisions);add(f.manager);
  const path=target==='settings'?join(f.profile,'classifiers/settings.json'):join(f.profile,'local-auth/classifiers/providers.enc.json');
  writeFileSync(path,'{invalid-store');
  const isolated=new DecisionManager(f.profile);cleanups.push(()=>isolated.close());
  expect(()=>isolated.snapshot()).toThrow('could not be read');
  expect(()=>isolated.upsert({expectedRevision:0,name:'Replacement',kind:'custom-system-one',endpointUrl:'https://example.test/v1/systemone',model:'synthetic'})).toThrow('could not be read');
  await denied(isolated.evaluate(evaluation,{dataClass:'standard'}),503);
  expect(readFileSync(path,'utf8')).toBe('{invalid-store');
 }
});
afterEach(()=>{for(const cleanup of cleanups.reverse())cleanup();cleanups.length=0});
const question={route:{type:'choice',instructions:'Choose a queue.',criteria:{science:'Research question',other:'Other question'}}};
const evaluation={state:{text:'A synthetic research question'},questions:question};
const answer:DecisionResult={model:'resolved-decision-model',answers:{route:{type:'choice',choice:'science',probabilities:{science:.8,other:.2},confidence:.8}},usage:{input_tokens:8,output_tokens:1}};
function fixture(request?:typeof requestDecisions){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-decision-manager-'));
 let changes=0;const manager=new DecisionManager(profile,{request,changed:()=>{changes++}});
 cleanups.push(()=>{manager.close();rmSync(profile,{recursive:true,force:true})});
 return {profile,manager,changes:()=>changes};
}
function add(manager:DecisionManager,overrides:Record<string,unknown>={}){
 const before=manager.snapshot();
 const result=manager.upsert({expectedRevision:before.revision,name:'Synthetic decision provider',kind:'typesafe-hosted',endpointUrl:'https://decision.example/v1/systemone',model:'decision-alias',apiKey:'synthetic-classifier-key',...overrides});
 return result.connections.find(connection=>!before.connections.some(old=>old.id===connection.id))!;
}
function update(manager:DecisionManager,id:string,changes:Record<string,unknown>={}){
 const snapshot=manager.snapshot(),old=snapshot.connections.find(connection=>connection.id===id)!;
 const keys=['id','name','kind','endpointUrl','model','format','enabled','timeoutMs','class2Approved','policyEvidence'];
 return manager.upsert({expectedRevision:snapshot.revision,...Object.fromEntries(keys.map(key=>[key,(old as any)[key]])),...changes});
}
async function denied(pending:Promise<unknown>,status?:number){
 try{await pending}catch(error){if(status!==undefined)expect((error as any).status).toBe(status);return error as Error}
 throw Error('Expected rejection');
}
function observeCredentials(manager:DecisionManager){
 const secrets=(manager as any).secrets as ProviderSecrets,get=secrets.get.bind(secrets);let calls=0;
 secrets.get=(ref,destination)=>{calls++;return get(ref,destination)};
 return ()=>calls;
}

test('hosted and self-hosted connections persist independently without changing chat state',async()=>{
 const f=fixture((async()=>answer) as typeof requestDecisions);
 const chatConfiguration='{"revision":7,"configuration":{"providers":{"chat":{"name":"Untouched"}}}}\n',chatSelection='{"model":"chat::model-a","effort":"high"}\n';
 writeFileSync(join(f.profile,'provider-config.json'),chatConfiguration);writeFileSync(join(f.profile,'model-selection.json'),chatSelection);
 const hosted=add(f.manager),self=add(f.manager,{name:'Local diffusion',kind:'self-hosted-diffusion',endpointUrl:'http://127.0.0.1:8011/custom/typesafe/v1/systemone',model:'local/decision',format:'chat-envelope',apiKey:'synthetic-local-key'});
 expect(f.manager.snapshot().selectedId).toBeNull();
 f.manager.select({expectedRevision:f.manager.snapshot().revision,selectedId:self.id});
 const reloaded=new DecisionManager(f.profile,{request:(async()=>answer) as typeof requestDecisions});cleanups.push(()=>reloaded.close());
 expect(reloaded.snapshot().connections).toHaveLength(2);expect(reloaded.snapshot().selectedId).toBe(self.id);
 expect(reloaded.snapshot().connections.map(connection=>[connection.id,connection.kind,connection.format])).toEqual([[hosted.id,'typesafe-hosted','flat'],[self.id,'self-hosted-diffusion','chat-envelope']]);
 expect(await reloaded.evaluate(evaluation,{dataClass:'standard'})).toEqual(answer);
 expect(readFileSync(join(f.profile,'provider-config.json'),'utf8')).toBe(chatConfiguration);expect(readFileSync(join(f.profile,'model-selection.json'),'utf8')).toBe(chatSelection);
});

test('classifiers remain optional after adding connections until selection is explicit',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions);
 expect(f.manager.snapshot()).toEqual({revision:0,selectedId:null,connections:[]});
 add(f.manager);const credentials=observeCredentials(f.manager);
 expect(f.manager.snapshot().selectedId).toBeNull();
 const error=await denied(f.manager.evaluate(evaluation,{dataClass:'standard'}));expect(error.message).toContain('Select an enabled classifier');
 expect(credentials()).toBe(0);expect(requests).toBe(0);
});

test('classifier keys are encrypted below local-auth and unaffected by chat-secret pruning',async()=>{
 let supplied:string|undefined;
 const f=fixture((async request=>{supplied=request.apiKey;return answer}) as typeof requestDecisions);
 const chatSecrets=new ProviderSecrets(join(f.profile,'local-auth'));chatSecrets.put('synthetic-chat-key','https://chat.example/v1');
 const connection=add(f.manager,{apiKey:'synthetic-classifier-private-key'});
 const auth=join(f.profile,'local-auth','classifiers'),settings=readFileSync(join(f.profile,'classifiers','settings.json'),'utf8'),encrypted=readFileSync(join(auth,'providers.enc.json'),'utf8');
 expect(settings).not.toContain('synthetic-classifier-private-key');expect(encrypted).not.toContain('synthetic-classifier-private-key');
 expect(statSync(auth).mode&0o777).toBe(0o700);expect(statSync(join(auth,'providers.key')).mode&0o777).toBe(0o600);expect(statSync(join(auth,'providers.enc.json')).mode&0o777).toBe(0o600);
 chatSecrets.prune(new Set());expect(readFileSync(join(auth,'providers.enc.json'),'utf8')).toBe(encrypted);
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'});expect(supplied).toBe('synthetic-classifier-private-key');
 const chatRef=chatSecrets.put('synthetic-new-chat-key','https://chat.example/v1');
 f.manager.remove({expectedRevision:f.manager.snapshot().revision,id:connection.id});
 expect(chatSecrets.get(chatRef,'https://chat.example/v1')).toBe('synthetic-new-chat-key');
 const reloaded=new DecisionManager(f.profile);cleanups.push(()=>reloaded.close());expect(reloaded.snapshot().connections).toHaveLength(0);
});

test('Class 2 is denied before credential access and network work unless this connection is approved',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions),connection=add(f.manager),credentials=observeCredentials(f.manager);
 expect(connection.class2Approved).toBe(false);
 const error=await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class2'}),403);
 expect(error.message).toContain('no matching Class 2 approval');expect(credentials()).toBe(0);expect(requests).toBe(0);
 update(f.manager,connection.id,{class2Approved:true,policyEvidence:'Synthetic operator approval for this exact endpoint and model.'});
 const beforeAllowed=credentials();
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class2',allowedConnectionIds:new Set([connection.id])});
 expect(credentials()).toBe(beforeAllowed+1);expect(requests).toBe(1);
});

test('trusted allowed-connection IDs and data class are enforced before credential access',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions),connection=add(f.manager,{class2Approved:true,policyEvidence:'Synthetic approval'}),credentials=observeCredentials(f.manager);
 for(const dataClass of ['standard','class2'] as const)await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass,allowedConnectionIds:new Set()}),403);
 await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class3'} as any),403);
 await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},undefined as any),403);
 expect(credentials()).toBe(0);expect(requests).toBe(0);
});

test('malformed or unsupported envelope input is rejected before credential access',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions),connection=add(f.manager,{format:'chat-envelope'}),credentials=observeCredentials(f.manager);
 const circular:any={};circular.self=circular;
 await denied(f.manager.evaluate({connectionId:connection.id,state:circular,questions:question},{dataClass:'standard'}));
 await denied(f.manager.evaluate({connectionId:connection.id,state:'text',questions:{q:{type:'noul',instructions:'Is it true?'}}},{dataClass:'standard'}));
 await denied(f.manager.evaluate({...evaluation,connectionId:connection.id,class2Approved:true} as any,{dataClass:'standard'}));
 expect(credentials()).toBe(0);expect(requests).toBe(0);
});

test('Class 2 approval requires evidence and is bound to endpoint, model, format and backend kind',async()=>{
 const f=fixture();expect(()=>add(f.manager,{class2Approved:true,policyEvidence:''})).toThrow(/approval evidence/);expect(f.manager.snapshot().connections).toHaveLength(0);
 for(const changes of [{endpointUrl:'https://decision.example/v2/systemone',confirmDestinationChange:true},{model:'new-model'},{format:'chat-envelope'},{kind:'custom-system-one'}]){
  const connection=add(f.manager,{class2Approved:true,policyEvidence:'Synthetic approval'}),before=f.manager.snapshot();
  expect(()=>update(f.manager,connection.id,changes)).toThrow(/reconfirm/);expect(f.manager.snapshot()).toEqual(before);
  update(f.manager,connection.id,{...changes,confirmPolicyChange:true});expect(f.manager.snapshot().connections.find(current=>current.id===connection.id)!.class2Approved).toBe(true);
 }
});

test('changing destination never reuses a saved key without explicit confirmation or replacement',async()=>{
 const seen:Array<[string,string|undefined]>=[];const f=fixture((async request=>{seen.push([request.endpointUrl,request.apiKey]);return answer}) as typeof requestDecisions),connection=add(f.manager,{apiKey:'synthetic-original-key'}),before=f.manager.snapshot();
 expect(()=>update(f.manager,connection.id,{endpointUrl:'https://another.example/typesafe/v1/systemone'})).toThrow(/explicitly confirm/);expect(f.manager.snapshot()).toEqual(before);
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'});
 update(f.manager,connection.id,{endpointUrl:'https://another.example/typesafe/v1/systemone',confirmDestinationChange:true});
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'});
 update(f.manager,connection.id,{endpointUrl:'https://third.example/v1/systemone',apiKey:'synthetic-replacement-key'});
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'});
 update(f.manager,connection.id,{endpointUrl:'https://fourth.example/systemone',clearCredential:true});
 await f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'});
 expect(seen).toEqual([['https://decision.example/v1/systemone','synthetic-original-key'],['https://another.example/typesafe/v1/systemone','synthetic-original-key'],['https://third.example/v1/systemone','synthetic-replacement-key'],['https://fourth.example/systemone',undefined]]);
});

test('reloaded approval is checked against the actual saved destination binding',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions),connection=add(f.manager,{class2Approved:true,policyEvidence:'Synthetic approval'});
 const file=join(f.profile,'classifiers','settings.json'),saved=JSON.parse(readFileSync(file,'utf8'));saved.connections[0].model='changed-outside-approval';writeFileSync(file,JSON.stringify(saved));
 const reloaded=new DecisionManager(f.profile,{request:(async()=>{requests++;return answer}) as typeof requestDecisions});cleanups.push(()=>reloaded.close());
 expect(reloaded.snapshot().connections[0].class2Approved).toBe(false);const credentials=observeCredentials(reloaded);
 await denied(reloaded.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class2'}),403);expect(credentials()).toBe(0);expect(requests).toBe(0);
});

test('updating or removing a connection aborts active work and rejects a late result',async()=>{
 for(const action of ['update','remove'] as const){
  let started!:(request:DecisionRequest)=>void,finish!:(result:DecisionResult)=>void;
  const ready=new Promise<DecisionRequest>(resolve=>{started=resolve});
  const f=fixture((async request=>{started(request);return new Promise<DecisionResult>(resolve=>{finish=resolve})}) as typeof requestDecisions),connection=add(f.manager);
  f.manager.select({expectedRevision:f.manager.snapshot().revision,selectedId:connection.id});
  const pending=f.manager.evaluate(evaluation,{dataClass:'standard'}),request=await ready;
  if(action==='update')update(f.manager,connection.id,{name:'Changed while running'});else f.manager.remove({expectedRevision:f.manager.snapshot().revision,id:connection.id});
  expect(request.signal!.aborted).toBe(true);finish(answer);const error=await denied(pending);expect(error.message).toContain('changed or was removed');
  if(action==='remove')expect(f.manager.snapshot().selectedId).toBeNull();
 }
});

test('revoking Class 2 approval cancels an in-flight Class 2 evaluation',async()=>{
 let started!:(request:DecisionRequest)=>void,finish!:(result:DecisionResult)=>void;const ready=new Promise<DecisionRequest>(resolve=>{started=resolve});
 const f=fixture((async request=>{started(request);return new Promise<DecisionResult>(resolve=>{finish=resolve})}) as typeof requestDecisions),connection=add(f.manager,{class2Approved:true,policyEvidence:'Synthetic approval'});
 const pending=f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class2'}),request=await ready;
 update(f.manager,connection.id,{class2Approved:false});expect(request.signal!.aborted).toBe(true);finish(answer);await denied(pending);
 await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'class2'}),403);
});

test('caller cancellation and manager close are propagated to active requests',async()=>{
 for(const action of ['caller','close'] as const){
  let started!:(request:DecisionRequest)=>void,finish!:(result:DecisionResult)=>void;const ready=new Promise<DecisionRequest>(resolve=>{started=resolve});
  const f=fixture((async request=>{started(request);return new Promise<DecisionResult>(resolve=>{finish=resolve})}) as typeof requestDecisions),connection=add(f.manager),controller=new AbortController();
  const pending=f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'},controller.signal),request=await ready;
  if(action==='caller')controller.abort(new Error('Cancelled synthetic request'));else f.manager.close();
  expect(request.signal!.aborted).toBe(true);finish(answer);await denied(pending);
  if(action==='close')await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'}),503);
 }
});

test('stale revisions cannot mutate settings, selection, deletion or dispatch a test',async()=>{
 let requests=0;const f=fixture((async()=>{requests++;return answer}) as typeof requestDecisions),stale=f.manager.snapshot().revision,connection=add(f.manager),before=f.manager.snapshot();
 expect(()=>update(f.manager,connection.id,{expectedRevision:stale,name:'Stale update'})).toThrow(/another window/);
 expect(()=>f.manager.select({expectedRevision:stale,selectedId:connection.id})).toThrow(/another window/);
 expect(()=>f.manager.remove({expectedRevision:stale,id:connection.id})).toThrow(/another window/);
 await denied(f.manager.test({expectedRevision:stale,id:connection.id}),409);expect(f.manager.snapshot()).toEqual(before);expect(requests).toBe(0);
});

test('synthetic connection tests use Choice on both wire formats and persist no prompt or answer',async()=>{
 const seen:DecisionRequest[]=[],bodies:any[]=[];
 const request=((input,deps)=>{seen.push(input);return requestDecisions(input,{...deps,fetch:(async(_url,init)=>{
  const body=JSON.parse(init!.body as string);bodies.push(body);return Response.json({answers:{greeting:{type:'choice',choice:'greeting',probabilities:{greeting:.9,other:.1},confidence:.9}},usage:{input_tokens:8,output_tokens:1},diagnostics:{chunk_prompt:'PRIVATE DIAGNOSTIC'}});
 }) as typeof fetch})}) as typeof requestDecisions;
 const f=fixture(request);
 for(const format of ['flat','chat-envelope']){
  const connection=add(f.manager,{format,kind:format==='flat'?'typesafe-hosted':'self-hosted-diffusion'});
  const result=await f.manager.test({id:connection.id,expectedRevision:f.manager.snapshot().revision});
  expect(result.ok).toBe(true);expect(result.answers.greeting.type).toBe('choice');
  const last=f.manager.snapshot().connections.find(value=>value.id===connection.id)!.lastTest;expect(Object.keys(last).sort()).toEqual(['durationMs','ok','testedAt']);
 }
 expect(seen.every(input=>JSON.stringify(input.state).includes('synthetic Chimeric connection check'))).toBe(true);
 expect(Object.keys(bodies[0]).sort()).toEqual(['model','questions','state']);expect(bodies[1].messages).toHaveLength(2);expect(JSON.parse(bodies[1].messages[0].content).questions[0].options).toEqual(['greeting','other']);
 const settings=readFileSync(join(f.profile,'classifiers','settings.json'),'utf8');expect(settings).not.toMatch(/synthetic Chimeric connection check|PRIVATE DIAGNOSTIC|"answers"|"lastTest"/);
});

test('a connection change or close between evaluation completion and test recording cannot report a stale success',async()=>{
 for(const action of ['update','remove','close'] as const){
  let finish!:(result:DecisionResult)=>void;
  const f=fixture((()=>new Promise<DecisionResult>(resolve=>{finish=resolve})) as typeof requestDecisions),connection=add(f.manager);
  const pending=f.manager.test({id:connection.id,expectedRevision:f.manager.snapshot().revision});
  finish(answer);
  // evaluate resumes first; this mutation runs before test's awaiting continuation.
  queueMicrotask(()=>{
   if(action==='update')update(f.manager,connection.id,{model:'replacement-model'});
   else if(action==='remove')f.manager.remove({id:connection.id,expectedRevision:f.manager.snapshot().revision});
   else f.manager.close();
  });
  await denied(pending,action==='close'?503:409);
  if(action==='close')expect(()=>f.manager.snapshot()).toThrow('closed');
  else expect(f.manager.snapshot().connections.find(value=>value.id===connection.id)?.lastTest).toBeUndefined();
 }
});

test('failed evaluations redact current and retired credentials before truncation',async()=>{
 let diagnostic='';const f=fixture((async()=>{throw new Error(diagnostic)}) as typeof requestDecisions),connection=add(f.manager,{apiKey:'synthetic-short-key'});
 update(f.manager,connection.id,{apiKey:'synthetic-short-key-LONGER-PRIVATE-SUFFIX'});
 diagnostic='x'.repeat(970)+'synthetic-short-key-LONGER-PRIVATE-SUFFIX'+' synthetic-short-key';
 const error=await denied(f.manager.evaluate({...evaluation,connectionId:connection.id},{dataClass:'standard'}));
 expect(error.message).not.toContain('synthetic-short-key');expect(error.message).not.toContain('LONGER-PRIVATE-SUFFIX');expect(error.message.length).toBeLessThanOrEqual(1000);
 const snapshot=JSON.stringify(f.manager.snapshot());expect(snapshot).not.toContain('synthetic-short-key');expect(snapshot).not.toContain('LONGER-PRIVATE-SUFFIX');
});
