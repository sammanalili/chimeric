import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {atomicJson} from './registry';
import {ProviderSecrets} from './provider-secrets';
import {requestDecisions,validateDecisionInput} from './decision-provider';

const revision=z.number().int().nonnegative();
const identifier=z.string().regex(/^classifier_[a-f0-9]{32}$/);
const fields={name:z.string().trim().min(1).max(120),kind:z.enum(['typesafe-hosted','self-hosted-diffusion','custom-system-one']),endpointUrl:z.string().trim().url().max(2048),model:z.string().trim().min(1).max(512),format:z.enum(['flat','chat-envelope']).default('flat'),enabled:z.boolean().default(true),timeoutMs:z.number().int().min(1000).max(120000).default(15000),class2Approved:z.boolean().default(false),policyEvidence:z.string().trim().max(4000).default('')};
const savedConnection=z.object({id:identifier,...fields,connectionRevision:z.string().uuid(),secretRef:z.string().optional(),policyBinding:z.string().optional()});
type Connection=z.infer<typeof savedConnection>;
const document=z.object({schemaVersion:z.literal(1),revision,selectedId:identifier.nullable(),connections:z.array(savedConnection).max(64)});
const saveInput=z.object({expectedRevision:revision,id:identifier.optional(),...fields,apiKey:z.string().max(16384).optional(),clearCredential:z.boolean().default(false),confirmDestinationChange:z.boolean().default(false),confirmPolicyChange:z.boolean().default(false)}).strict();
export type DecisionExecutionPolicy={dataClass:'standard'|'class2';allowedConnectionIds?:ReadonlySet<string>};
export class DecisionSettingsError extends Error{constructor(message:string,readonly status=400){super(message)}}
function endpoint(value:string){
 const url=new URL(value);
 if(url.username||url.password||url.search||url.hash)throw new DecisionSettingsError('Use a classifier endpoint URL without credentials, query parameters or a fragment.');
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw new DecisionSettingsError('Classifier endpoints require HTTPS, except on loopback.');
 return url.href;
}
function binding(value:Pick<Connection,'endpointUrl'|'model'|'kind'|'format'>){return createHash('sha256').update(JSON.stringify([value.endpointUrl,value.model,value.kind,value.format])).digest('hex')}

/** Classifier credentials and selection are independent of chat connections. */
export class DecisionManager{
 private state:z.infer<typeof document>={schemaVersion:1,revision:0,selectedId:null,connections:[]};
 private file:string;private secrets!:ProviderSecrets;private knownSecrets=new Set<string>();private initializationFailed=false;
 private active=new Map<string,Set<AbortController>>();private tests=new Map<string,any>();private closed=false;
 constructor(profile:string,private options:{changed?:()=>void;request?:typeof requestDecisions}={}){
  this.file=join(profile,'classifiers','settings.json');
  try{
  const directory=join(profile,'classifiers');mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
  this.secrets=new ProviderSecrets(join(profile,'local-auth','classifiers'));
  if(existsSync(this.file))this.state=document.parse(JSON.parse(readFileSync(this.file,'utf8')));
  const ids=new Set<string>();for(const connection of this.state.connections){
   if(ids.has(connection.id))throw new DecisionSettingsError('Duplicate saved classifier connection.');ids.add(connection.id);
   if(endpoint(connection.endpointUrl)!==connection.endpointUrl)throw new DecisionSettingsError('The saved classifier endpoint must be normalized.');
   if(connection.secretRef){const key=this.secrets.get(connection.secretRef,connection.endpointUrl);if(key)this.knownSecrets.add(key)}
  }
  if(this.state.selectedId&&!ids.has(this.state.selectedId))throw new DecisionSettingsError('The selected classifier connection no longer exists.');
  }catch{this.initializationFailed=true;this.state={schemaVersion:1,revision:0,selectedId:null,connections:[]}}
 }
 private available(){if(this.initializationFailed)throw new DecisionSettingsError('Saved classifier settings or credentials could not be read. Restore the classifier files before changing these connections.',503);if(this.closed)throw new DecisionSettingsError('Classifier connections are closed.',503)}
 private check(expected:number){this.available();if(expected!==this.state.revision)throw new DecisionSettingsError('Classifier connections changed in another window. Reload before saving.',409)}
 safeError(error:unknown){let message=error instanceof Error?error.message:'The classifier request could not complete.';for(const key of [...this.knownSecrets].sort((a,b)=>b.length-a.length))message=message.split(key).join('[redacted]');return message.slice(0,1000)}
 snapshot(){this.available();return {revision:this.state.revision,selectedId:this.state.selectedId,connections:this.state.connections.map(({secretRef,policyBinding,...connection})=>({...connection,hasCredential:!!secretRef,class2Approved:connection.class2Approved&&policyBinding===binding(connection),lastTest:this.tests.get(connection.id)}))}}
 private cancel(id:string){for(const controller of this.active.get(id)??[])controller.abort(new Error('The classifier connection changed or was removed.'));this.tests.delete(id)}
 private commit(next:typeof this.state){atomicJson(this.file,next);this.state=next;this.options.changed?.()}
 private prune(){this.secrets.prune(new Set(this.state.connections.flatMap(connection=>connection.secretRef?[connection.secretRef]:[])))}
 upsert(raw:unknown){
  const input=saveInput.parse(raw);this.check(input.expectedRevision);const old=input.id?this.state.connections.find(connection=>connection.id===input.id):undefined;
  if(input.id&&!old)throw new DecisionSettingsError('Classifier connection no longer exists.',404);
  if(!old&&this.state.connections.length>=64)throw new DecisionSettingsError('At most 64 classifier connections can be configured.');
  const endpointUrl=endpoint(input.endpointUrl),apiKey=input.apiKey?.trim()||undefined;
  if(apiKey&&/[\r\n\0]/.test(apiKey))throw new DecisionSettingsError('The API key cannot contain line breaks.');
  if(apiKey&&input.clearCredential)throw new DecisionSettingsError('Choose either entering a key or clearing the saved key.');
  if(old&&old.endpointUrl!==endpointUrl&&old.secretRef&&!apiKey&&!input.clearCredential&&!input.confirmDestinationChange)throw new DecisionSettingsError('The classifier URL changed. Enter a new key or explicitly confirm reusing the saved key at the new destination.',409);
  const next:Connection={id:old?.id??'classifier_'+randomUUID().replaceAll('-',''),name:input.name,kind:input.kind,endpointUrl,model:input.model,format:input.format,enabled:input.enabled,timeoutMs:input.timeoutMs,class2Approved:input.class2Approved,policyEvidence:input.policyEvidence,connectionRevision:randomUUID()};
  const policyBinding=binding(next);
  if(input.class2Approved){
   if(!input.policyEvidence)throw new DecisionSettingsError('Record the operator policy or approval evidence before marking a classifier connection eligible for Class 2.');
   if(old?.class2Approved&&old.policyBinding!==policyBinding&&!input.confirmPolicyChange)throw new DecisionSettingsError('The classifier destination, model or format changed. Explicitly reconfirm its Class 2 policy before saving.',409);
   next.policyBinding=policyBinding;
  }
  let key=apiKey;if(!input.clearCredential&&!key&&old?.secretRef)key=this.secrets.get(old.secretRef,old.endpointUrl);if(input.clearCredential)key=undefined;
  if(key){this.knownSecrets.add(key);next.secretRef=old?.endpointUrl===endpointUrl&&!apiKey&&!input.clearCredential?old.secretRef:this.secrets.put(key,endpointUrl)}
  const connections=old?this.state.connections.map(connection=>connection.id===old.id?next:connection):[...this.state.connections,next];
  try{this.commit({...this.state,revision:this.state.revision+1,connections})}catch(error){try{this.prune()}catch{}throw error}
  this.cancel(next.id);this.prune();return this.snapshot();
 }
 select(raw:unknown){const input=z.object({expectedRevision:revision,selectedId:identifier.nullable()}).strict().parse(raw);this.check(input.expectedRevision);if(input.selectedId&&!this.state.connections.some(connection=>connection.id===input.selectedId&&connection.enabled))throw new DecisionSettingsError('Choose an enabled classifier connection.');this.commit({...this.state,revision:this.state.revision+1,selectedId:input.selectedId});return this.snapshot()}
 remove(raw:unknown){const input=z.object({expectedRevision:revision,id:identifier}).strict().parse(raw);this.check(input.expectedRevision);if(!this.state.connections.some(connection=>connection.id===input.id))throw new DecisionSettingsError('Classifier connection no longer exists.',404);this.commit({...this.state,revision:this.state.revision+1,connections:this.state.connections.filter(connection=>connection.id!==input.id),selectedId:this.state.selectedId===input.id?null:this.state.selectedId});this.cancel(input.id);this.prune();return this.snapshot()}
 async evaluate(raw:unknown,policy:DecisionExecutionPolicy,signal?:AbortSignal){
  this.available();
  if(!policy||!['standard','class2'].includes(policy.dataClass))throw new DecisionSettingsError('A trusted data-handling policy is required.',403);
  const input=z.object({connectionId:identifier.optional(),state:z.unknown(),questions:z.unknown()}).strict().parse(raw),payload=validateDecisionInput({state:input.state,questions:input.questions});
  const id=input.connectionId??this.state.selectedId,connection=this.state.connections.find(value=>value.id===id);
  if(!connection?.enabled)throw new DecisionSettingsError('Select an enabled classifier connection.');
  if(connection.format==='chat-envelope'&&Object.values(payload.questions).some(question=>question.type!=='choice'))throw new DecisionSettingsError('The chat-envelope adapter supports Choice questions only. Use flat format for Noul or Score questions.');
  if(policy.allowedConnectionIds&&!policy.allowedConnectionIds.has(connection.id))throw new DecisionSettingsError('This classifier connection is not permitted by the session policy.',403);
  if(policy.dataClass==='class2'&&(!connection.class2Approved||connection.policyBinding!==binding(connection)))throw new DecisionSettingsError('This classifier connection has no matching Class 2 approval. Choose an approved connection.',403);
  if([...this.active.values()].reduce((count,requests)=>count+requests.size,0)>=4)throw new DecisionSettingsError('The classifier request limit is reached. Wait for an active request to finish.',429);
  signal?.throwIfAborted();const key=connection.secretRef?this.secrets.get(connection.secretRef,connection.endpointUrl):undefined;if(key)this.knownSecrets.add(key);
  const controller=new AbortController(),controllers=this.active.get(connection.id)??new Set<AbortController>();controllers.add(controller);this.active.set(connection.id,controllers);
  try{
   const result=await(this.options.request??requestDecisions)({endpointUrl:connection.endpointUrl,connectionBaseUrl:new URL(connection.endpointUrl).origin,model:connection.model,...payload,format:connection.format,apiKey:key,signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,timeoutMs:connection.timeoutMs},{redact:value=>this.safeError(new Error(value))});
   controller.signal.throwIfAborted();signal?.throwIfAborted();
   if(this.state.connections.find(value=>value.id===connection.id)?.connectionRevision!==connection.connectionRevision)throw new DecisionSettingsError('The classifier connection changed during the request.',409);
   return result;
  }catch(error){if(error instanceof DecisionSettingsError)throw error;const status=(error as any)?.status;throw new DecisionSettingsError(this.safeError(error),Number.isInteger(status)&&status>=400&&status<=599?status:400)}
  finally{controllers.delete(controller);if(!controllers.size)this.active.delete(connection.id)}
 }
 async test(raw:unknown,signal?:AbortSignal){
  const input=z.object({id:identifier,expectedRevision:revision}).strict().parse(raw);this.check(input.expectedRevision);const started=Date.now();
  const result=await this.evaluate({connectionId:input.id,state:{text:'Hello from a synthetic Chimeric connection check.'},questions:{greeting:{type:'choice',instructions:'What kind of text is this?',criteria:{greeting:'A greeting',other:'Other text'}}}},{dataClass:'standard'},signal);
  this.check(input.expectedRevision);signal?.throwIfAborted();
  const response={ok:true,message:'Classifier returned a valid structured response to the synthetic test.',testedAt:Date.now(),durationMs:Date.now()-started,...result};this.tests.set(input.id,{ok:true,testedAt:response.testedAt,durationMs:response.durationMs});this.options.changed?.();return response;
 }
 close(){this.closed=true;for(const id of this.active.keys())this.cancel(id);this.active.clear()}
}
