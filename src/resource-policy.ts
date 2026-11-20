import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import type {ArtifactLookup,NativeArtifactContext} from './native-artifact-context';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/),digest=z.string().regex(/^[a-f0-9]{64}$/);
const contextSchema=z.object({frameId:id,rootFrameId:id,projectId:id,ownerId:id,organizationId:id,mode:z.enum(['standard','class2']),revision:z.number().int().nonnegative(),readOnly:z.boolean().default(false)}).strict();
export type ResourceContext=Readonly<z.infer<typeof contextSchema>>;
export type ResourceClass='unclassified'|'standard'|'class2';
const purpose=z.enum(['metadata','model-input','inert-text','inert-image','raw-bytes','thumbnail','archive','active-preview']);
export type ResourcePurpose=z.infer<typeof purpose>;
const rootRecord=z.object({rootFrameId:id,projectId:id,ownerId:id,organizationId:id,dataClass:z.enum(['standard','class2'])}).strict();
const resourceRecord=z.object({versionId:id,artifactId:id,projectId:id,ownerId:id,organizationId:id,checksum:digest,binding:digest,dataClass:z.enum(['standard','class2']),sourceRoots:z.array(id).max(256),sourceVersions:z.array(id).max(256),classifiedAt:z.number().int().nonnegative()}).strict();
const destinationSchema=z.object({kind:z.enum(['frame','model','export']),id,revision:z.string().min(1).max(255),binding:digest}).strict();
export type ResourceDestination=Readonly<z.infer<typeof destinationSchema>>;
const releaseSchema=z.object({id,versionId:id,checksum:digest,binding:digest,consumerFrameId:id,consumerRootFrameId:id,consumerRevision:z.number().int().nonnegative(),purpose,destination:destinationSchema,expiresAt:z.number().int().nonnegative(),receiptId:id,used:z.boolean()}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),revision:z.number().int().nonnegative(),roots:z.array(rootRecord).max(16384),resources:z.array(resourceRecord).max(65536),releases:z.array(releaseSchema).max(4096)}).strict();
type State=z.infer<typeof stateSchema>;
export type ResourceReleaseDraft=Readonly<{versionId:string;checksum:string;binding:string;consumerFrameId:string;consumerRootFrameId:string;consumerRevision:number;purpose:ResourcePurpose;destination:ResourceDestination;expiresAt:number;revision:number}>;
export type ResourceLease=Readonly<{versionId:string;artifactId:string;dataClass:ResourceClass;purpose:ResourcePurpose;binding:string}>;
type LeaseState={resource:NativeArtifactContext;context?:ResourceContext;purpose:ResourcePurpose;release?:z.infer<typeof releaseSchema>;materialized?:boolean};
export type ResourcePolicyDependencies={
 owner:{userId:string;organizationId:string};
 resolveVersion:(lookup:ArtifactLookup)=>NativeArtifactContext|undefined|Promise<NativeArtifactContext|undefined>;
 /** Resolve native ownership/ancestry/current mode. Never deserialize authority. */
 resolveContext:(frameId:string)=>ResourceContext|Promise<ResourceContext>;
 resolveDestination?:(context:ResourceContext,purpose:ResourcePurpose)=>ResourceDestination|Promise<ResourceDestination>;
 /** Install only behind a native human action and CSRF boundary. */
 approveRelease?:(draft:ResourceReleaseDraft)=>Promise<{decision:'approve';receiptId:string}|{decision:'deny'}>;
 approveLegacyClassification?:(resource:NativeArtifactContext,classification:'standard'|'class2')=>Promise<{decision:'approve';receiptId:string}|{decision:'deny'}>;
 /** Explicit compatibility, without inventing a durable standard label. This
  * stops applying permanently once any protected history exists in this store. */
 legacyRule?:'deny'|'ordinary-while-disabled';protectionEnabled?:()=>boolean;
 now?:()=>number;writeJson?:(path:string,value:unknown)=>void;onChange?:(revision:number)=>void;
};
export class ResourcePolicyError extends Error{constructor(readonly code:string,message:string,readonly status=403){super(message);this.name='ResourcePolicyError'}}
const fail=(code:string,message:string,status=403):never=>{throw new ResourcePolicyError(code,message,status)};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const key=(v:{organizationId:string;versionId:string})=>v.organizationId+'::'+v.versionId;
const rootKey=(v:{organizationId:string;rootFrameId:string})=>v.organizationId+'::'+v.rootFrameId;
const sourceRoots=(v:NativeArtifactContext)=>[...new Set(v.sourceFrames.map(f=>f.rootFrameId??f.frameId))].sort();
/** Binds native identity, ancestry and exact bytes; paths are never exported. */
export const resourceBinding=(v:NativeArtifactContext)=>hash([v.organizationId,v.ownerId,v.projectId,v.artifactId,v.versionId,v.rootFrameId,v.creatingFrameId,v.producingFrameId,sourceRoots(v),v.checksum,v.sizeBytes,v.contentType,v.storagePath,v.parentVersionId,v.isUserUpload]);
function atomic(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});renameSync(temporary,file);chmodSync(file,0o600)}finally{try{unlinkSync(temporary)}catch{}}}

/** Durable taint survives Off and copies. This is not a filesystem sandbox,
 * migration, browser permit or external model/connector authorization. */
export class ResourcePolicyStore{
 private state:State={schemaVersion:1,revision:0,roots:[],resources:[],releases:[]};private file:string;private witness:string;private protectedHistory=false;private closed=false;
 private contexts=new WeakSet<object>();private leases=new WeakMap<object,LeaseState>();private drafts=new WeakSet<object>();
 constructor(readonly profileDir:string,private deps:ResourcePolicyDependencies){
  id.parse(deps.owner.userId);id.parse(deps.owner.organizationId);
  const directory=join(profileDir,'local-auth');mkdirSync(directory,{recursive:true,mode:0o700});if(lstatSync(directory).isSymbolicLink())fail('unsafe_store','The resource policy directory is unavailable.',503);chmodSync(directory,0o700);this.file=join(directory,'resource-policy.json');this.witness=join(directory,'resource-policy-protected-history.json');
  if(existsSync(this.witness))try{const info=lstatSync(this.witness);if(!info.isFile()||info.isSymbolicLink()||info.size>1024||!same(JSON.parse(readFileSync(this.witness,'utf8')),{schemaVersion:1,protectedHistory:true})||!existsSync(this.file))throw Error('missing-policy');this.protectedHistory=true}catch{fail('policy_unreadable','Protected resource history needs to be restored before reading resources.',503)}
  if(existsSync(this.file))try{const info=lstatSync(this.file);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw Error('invalid-store');this.state=stateSchema.parse(JSON.parse(readFileSync(this.file,'utf8')));
   if(new Set(this.state.resources.map(key)).size!==this.state.resources.length||new Set(this.state.roots.map(rootKey)).size!==this.state.roots.length||new Set(this.state.releases.map(r=>r.id)).size!==this.state.releases.length)throw Error('duplicate');
  }catch{fail('policy_unreadable','Resource classifications could not be read. No unclassified resource was released.',503)}
  if(this.state.roots.some(r=>r.dataClass==='class2')||this.state.resources.some(r=>r.dataClass==='class2'))this.markProtectedHistory();
 }
 private now(){return this.deps.now?.()??Date.now()}
 private open(){if(this.closed)fail('closed','Resource policy is closed.',503)}
 private markProtectedHistory(){if(this.protectedHistory)return;if(existsSync(this.witness)&&lstatSync(this.witness).isSymbolicLink())fail('unsafe_store','The protected history witness is unavailable.',503);(this.deps.writeJson??atomic)(this.witness,{schemaVersion:1,protectedHistory:true});this.protectedHistory=true}
 private commit(next:State){this.open();const checked=stateSchema.parse(next);if(existsSync(this.file)&&lstatSync(this.file).isSymbolicLink())fail('unsafe_store','The resource policy file is unavailable.',503);if(checked.roots.some(r=>r.dataClass==='class2')||checked.resources.some(r=>r.dataClass==='class2'))this.markProtectedHistory();(this.deps.writeJson??atomic)(this.file,checked);this.state=checked;try{this.deps.onChange?.(checked.revision)}catch{}}
 private owned(v:{ownerId:string;organizationId:string}){if(v.ownerId!==this.deps.owner.userId||v.organizationId!==this.deps.owner.organizationId)fail('resource_unavailable','The resource is unavailable.',404)}
 private async resolve(lookup:ArtifactLookup){this.open();const v=await this.deps.resolveVersion(lookup);if(!v)fail('resource_unavailable','The exact resource version is unavailable.',404);this.owned(v);id.parse(v.versionId);digest.parse(v.checksum);for(const frame of v.sourceFrames){const context=await this.captureFrame(frame.frameId);if(context.projectId!==v.projectId||context.rootFrameId!==(frame.rootFrameId??frame.frameId))fail('scope_changed','The source resource ancestry changed.',409)}return v}
 async captureFrame(frameId:string):Promise<ResourceContext>{
  this.open();id.parse(frameId);const context=Object.freeze(contextSchema.parse(await this.deps.resolveContext(frameId)));this.owned(context);if(context.frameId!==frameId)fail('scope_changed','The native resource context changed.',409);this.contexts.add(context);if(context.mode==='class2')this.recordRoot(context,'class2');return context;
 }
 private async current(context:ResourceContext){if(!this.contexts.has(context))fail('untrusted_context','A trusted native resource context is required.');const fresh=contextSchema.parse(await this.deps.resolveContext(context.frameId));this.owned(fresh);if(!same(fresh,context))fail('scope_changed','The native resource context changed.',409);return fresh}
 private recordRoot(context:ResourceContext,classification:'standard'|'class2'){
  const previous=this.state.roots.find(r=>rootKey(r)===rootKey(context));if(previous&&['projectId','ownerId','organizationId'].some(k=>(previous as any)[k]!==(context as any)[k]))fail('scope_changed','The resource root identity changed.',409);
  if(previous&&(previous.dataClass==='class2'||previous.dataClass===classification))return;const next=structuredClone(this.state);next.roots=next.roots.filter(r=>rootKey(r)!==rootKey(context));next.roots.push({rootFrameId:context.rootFrameId,projectId:context.projectId,ownerId:context.ownerId,organizationId:context.organizationId,dataClass:classification});next.revision++;this.commit(next);
 }
 /** Invoke only from a checked native NEW-root lifecycle. */
 async recordNewRoot(context:ResourceContext){await this.current(context);if(context.readOnly)fail('read_only','Read-only frames cannot classify resources.');this.recordRoot(context,context.mode==='class2'?'class2':'standard')}
 rootClass(context:ResourceContext):ResourceClass{if(!this.contexts.has(context))fail('untrusted_context','A trusted native resource context is required.');return this.state.roots.find(r=>rootKey(r)===rootKey(context))?.dataClass??'unclassified'}
 private record(v:NativeArtifactContext){const record=this.state.resources.find(r=>key(r)===key(v));if(record&&record.binding!==resourceBinding(v))fail('resource_changed','The resource version binding changed.',409);return record}
 private classification(v:NativeArtifactContext):ResourceClass{
  const record=this.record(v);if(!record)return 'unclassified';return record.dataClass==='class2'||this.protectedEvidence(v)?'class2':'standard';
 }
 private protectedEvidence(v:NativeArtifactContext){const tainted=this.state.roots.filter(r=>r.dataClass==='class2'&&r.organizationId===v.organizationId).map(r=>r.rootFrameId),record=this.record(v);return [...sourceRoots(v),...record?.sourceRoots??[]].some(root=>tainted.includes(root))||this.state.resources.some(r=>r.organizationId===v.organizationId&&r.ownerId===v.ownerId&&r.checksum===v.checksum&&(r.dataClass==='class2'||r.sourceRoots.some(root=>tainted.includes(root))))}
 private compatibility(context?:ResourceContext){return this.deps.legacyRule==='ordinary-while-disabled'&&this.deps.protectionEnabled?.()===false&&context?.mode!=='class2'&&!this.protectedHistory&&!this.state.roots.some(r=>r.dataClass==='class2')&&!this.state.resources.some(r=>r.dataClass==='class2')}
 private storeRecord(v:NativeArtifactContext,context:ResourceContext,classification:'standard'|'class2',parents:string[]){
  const previous=this.record(v),record={versionId:v.versionId,artifactId:v.artifactId,projectId:v.projectId,ownerId:v.ownerId,organizationId:v.organizationId,checksum:v.checksum,binding:resourceBinding(v),dataClass:previous?.dataClass==='class2'?'class2' as const:classification,sourceRoots:[...new Set([...sourceRoots(v),context.rootFrameId,...previous?.sourceRoots??[]])].sort(),sourceVersions:[...new Set([...previous?.sourceVersions??[],...parents])].sort(),classifiedAt:previous?.classifiedAt??this.now()};
  const next=structuredClone(this.state);next.resources=next.resources.filter(r=>key(r)!==key(v));next.resources.push(record);next.revision++;this.commit(next);if(record.dataClass==='class2')this.recordRoot(context,'class2');return record;
 }
 /** Publish native save results only after this commit succeeds. Untagged
  * partially committed versions remain unclassified. The caller supplies the
  * real creating context, including for a project-shared UPLOADS record. */
 async recordCreated(context:ResourceContext,lookup:ArtifactLookup,options:{sourceVersionIds?:ReadonlyArray<string>}={}){
  await this.current(context);if(context.readOnly)fail('read_only','Read-only frames cannot classify resources.');const resource=await this.resolve(lookup);if(resource.projectId!==context.projectId)fail('scope_changed','The resource belongs to another project.');
  const parents=[...new Set([resource.parentVersionId,...options.sourceVersionIds??[]].filter((v):v is string=>v!==null))];if(parents.length>256)fail('resource_limit','Too many source versions.');
  let classification:'standard'|'class2'=context.mode==='class2'||this.rootClass(context)==='class2'||this.protectedEvidence(resource)?'class2':'standard';
  for(const parent of parents){id.parse(parent);if(parent===resource.versionId)fail('invalid_lineage','A version cannot be its own source.');const source=await this.resolve({versionId:parent}),kind=this.classification(source);if(kind==='unclassified')fail('unclassified','A source version has no verified classification.');if(kind==='class2')classification='class2'}
  for(const source of resource.sourceFrames){const sourceContext=await this.captureFrame(source.frameId);if(sourceContext.mode==='class2'||this.rootClass(sourceContext)==='class2')classification='class2'}
  if(this.state.resources.some(r=>r.ownerId===resource.ownerId&&r.organizationId===resource.organizationId&&r.checksum===resource.checksum&&r.dataClass==='class2'))classification='class2';
  await this.current(context);const fresh=await this.resolve({versionId:resource.versionId});if(resourceBinding(fresh)!==resourceBinding(resource))fail('resource_changed','The resource changed before classification.',409);return this.storeRecord(fresh,context,classification,parents);
 }
 /** Explicit native human classification adopts legacy data. It never erases
  * existing taint and cannot be invoked with an approval boolean from a model. */
 async classifyLegacy(context:ResourceContext,lookup:ArtifactLookup,classification:'standard'|'class2'){
  await this.current(context);if(context.readOnly||!this.deps.approveLegacyClassification)fail('legacy_unclassified','Legacy resources require an explicit native classification action.');
  const resource=await this.resolve(lookup);if(resource.projectId!==context.projectId)fail('scope_changed','The resource belongs to another project.');const revision=this.state.revision,answer=await this.deps.approveLegacyClassification(resource,classification);
  if(answer.decision!=='approve')fail('release_denied','The legacy classification was not approved.');id.parse(answer.receiptId);await this.current(context);if(this.state.revision!==revision||resourceBinding(await this.resolve({versionId:resource.versionId}))!==resourceBinding(resource))fail('scope_changed','The resource policy changed during review.',409);
  const knownParent=resource.parentVersionId?await this.resolve({versionId:resource.parentVersionId}):undefined;
  if(classification==='standard'&&(this.protectedEvidence(resource)||context.mode==='class2'||this.rootClass(context)==='class2'||knownParent&&this.classification(knownParent)!=='standard'))fail('taint_preserved','Protected or unclassified lineage cannot be relabelled standard.');
  return this.storeRecord(resource,context,classification,resource.parentVersionId?[resource.parentVersionId]:[]);
 }
 private allowed(resource:NativeArtifactContext,classification:ResourceClass,context:ResourceContext|undefined,requested:ResourcePurpose){
  if(context&&resource.projectId!==context.projectId)return false;
  if(requested==='inert-image'&&!['image/png','image/jpeg','image/webp','image/gif'].includes(resource.contentType.toLowerCase()))return false;
  if(context?.mode==='class2'&&!['metadata','model-input','inert-text','inert-image'].includes(requested))return false;
  if(classification==='unclassified')return this.compatibility(context);
  if(classification==='standard')return requested!=='active-preview'||context?.mode!=='class2';
  return context?.mode==='class2'&&['metadata','model-input','inert-text','inert-image'].includes(requested);
 }
 async authorize(lookup:ArtifactLookup,consumerFrameId:string|undefined,requested:ResourcePurpose,releaseId?:string):Promise<ResourceLease>{
  purpose.parse(requested);const resource=await this.resolve(lookup),context=consumerFrameId?await this.captureFrame(consumerFrameId):undefined,classification=this.classification(resource);let release:z.infer<typeof releaseSchema>|undefined;
  if(!this.allowed(resource,classification,context,requested)){
   if(['active-preview','thumbnail'].includes(requested))fail('unverified_renderer','This protected renderer or converter is not verified.');
   if(!releaseId||!context||classification==='unclassified'||!this.deps.resolveDestination)fail(classification==='unclassified'?'unclassified':'protected_resource','This resource is not approved for that research chat or read purpose.');
   const destination=destinationSchema.parse(await this.deps.resolveDestination(context,requested));release=this.state.releases.find(r=>r.id===releaseId);
   if(!release||release.used||release.expiresAt<=this.now()||release.versionId!==resource.versionId||release.checksum!==resource.checksum||release.binding!==resourceBinding(resource)||release.consumerFrameId!==context.frameId||release.consumerRootFrameId!==context.rootFrameId||release.consumerRevision!==context.revision||release.purpose!==requested||!same(release.destination,destination))fail('release_unavailable','The exact reviewed resource release is unavailable.');
   await this.current(context);const latest=this.state.releases.find(r=>r.id===releaseId);if(!latest||latest.used)fail('release_unavailable','The resource release was already used.');const next=structuredClone(this.state);next.releases.find(r=>r.id===releaseId)!.used=true;next.revision++;this.commit(next);
  }
  const lease=Object.freeze({versionId:resource.versionId,artifactId:resource.artifactId,dataClass:classification,purpose:requested,binding:resourceBinding(resource)});this.leases.set(lease,{resource,context,purpose:requested,...release?{release}:{}});await this.assertCurrent(lease);return lease;
 }
 async assertCurrent(lease:ResourceLease){
  this.open();const state=this.leases.get(lease);if(!state)fail('untrusted_lease','A native resource read lease is required.');if(state.context)await this.current(state.context);
  const resource=await this.resolve({versionId:state.resource.versionId}),classification=this.classification(resource);if(resourceBinding(resource)!==lease.binding)fail('resource_changed','The resource changed before reading.',409);
  if(classification!==lease.dataClass)fail('resource_changed','The resource classification changed before reading.',409);
  if(state.release){const r=state.release,stored=this.state.releases.find(value=>value.id===r.id);if(!stored||!stored.used||!same({...stored,used:false},{...r,used:false})||r.expiresAt<=this.now()||!this.deps.resolveDestination||!state.context||!same(destinationSchema.parse(await this.deps.resolveDestination(state.context,state.purpose)),r.destination))fail('release_unavailable','The reviewed resource destination changed.');}
  else if(!this.allowed(resource,classification,state.context,state.purpose))fail('protected_resource','The resource permission changed before reading.');
 }
 /** reader is a trusted local materializer; this does not authorize networking. */
 async materialize<T>(lease:ResourceLease,reader:(resource:NativeArtifactContext)=>T|Promise<T>):Promise<T>{const state=this.leases.get(lease);if(!state)fail('untrusted_lease','A native resource read lease is required.');if(state.release&&state.materialized)fail('release_unavailable','The reviewed resource read was already used.');state.materialized=true;await this.assertCurrent(lease);const value=await reader(state.resource);await this.assertCurrent(lease);return value}
 async filterMetadata<T>(rows:ReadonlyArray<T>,consumerFrameId:string|undefined,lookup:(row:T)=>ArtifactLookup):Promise<T[]>{if(rows.length>65536)fail('resource_limit','Too many resource rows.');const result:T[]=[];for(const row of rows)try{await this.authorize(lookup(row),consumerFrameId,'metadata');result.push(row)}catch(error){if(!(error instanceof ResourcePolicyError))throw error}return result}
 async renderDecision(input:ArtifactLookup&{consumerFrameId?:string}){
  try{const lookup:ArtifactLookup=input.versionId?{versionId:input.versionId}:{artifactId:input.artifactId!},resource=await this.resolve(lookup),context=input.consumerFrameId?await this.captureFrame(input.consumerFrameId):undefined;
   const roots=this.record(resource)?.sourceRoots??sourceRoots(resource),revisions=await Promise.all(roots.map(async root=>{const source=await this.captureFrame(root);return {rootFrameId:source.rootFrameId,revision:source.revision}}));if(context)await this.current(context);
   const classification=this.classification(resource),allowed=this.allowed(resource,classification,context,'metadata'),decision=allowed&&(classification==='standard'||this.compatibility(context))&&context?.mode!=='class2'?'standard':allowed?'inert':'blocked';
   return {revision:this.state.revision,decision,resource:{artifactId:resource.artifactId,versionId:resource.versionId,checksum:resource.checksum,dataClass:classification,sourceRootFrameIds:roots,sourcePolicyRevisions:revisions,consumerRootFrameId:context?.rootFrameId,consumerPolicyRevision:context?.revision},binding:hash([resourceBinding(resource),this.state.revision,context??null]),...(decision==='blocked'?{reason:'This source has no verified permission for the current research chat.'}:{})};
  }catch(error){if(!(error instanceof ResourcePolicyError))throw error;return {revision:this.state.revision,decision:'blocked',reason:error.message}}
 }
 /** Compatibility for native file-backed previews that have no artifact
  * version identity. This grants no bytes, path, renderer or network access.
  * It stops permanently after any Class 2 history is recorded. */
 async unboundStandardDecision(consumerFrameId?:string){
  try{this.open();const context=consumerFrameId?await this.captureFrame(consumerFrameId):undefined;if(context)await this.current(context);
   return this.compatibility(context)?{revision:this.state.revision,decision:'standard-unbound' as const,consumerRootFrameId:context?.rootFrameId}:{revision:this.state.revision,decision:'blocked' as const,reason:'Unbound file previews are unavailable after protected research has been used.'};
  }catch(error){if(!(error instanceof ResourcePolicyError))throw error;return {revision:this.state.revision,decision:'blocked' as const,reason:error.message}}
 }
 async frameRenderDecision(sourceFrameId:string,consumerFrameId?:string){const source=await this.captureFrame(sourceFrameId),consumer=consumerFrameId?await this.captureFrame(consumerFrameId):source,classification=this.rootClass(source),sameProject=source.projectId===consumer.projectId,ordinary=classification==='standard'||classification==='unclassified'&&this.compatibility(consumer);return {revision:this.state.revision,decision:ordinary&&source.mode==='standard'&&consumer.mode==='standard'&&sameProject?'standard':classification!=='unclassified'&&consumer.mode==='class2'&&sameProject?'inert':'blocked',dataClass:classification,binding:hash([source,consumer,this.state.revision])}}
 async prepareRelease(lookup:ArtifactLookup,consumerFrameId:string,requested:ResourcePurpose,expiresInMs=300000):Promise<ResourceReleaseDraft>{
  if(!this.deps.approveRelease||!this.deps.resolveDestination)fail('release_unavailable','Resource release is not available.');purpose.parse(requested);if(['active-preview','thumbnail'].includes(requested))fail('unverified_renderer','Human release cannot verify an active renderer.');if(!Number.isSafeInteger(expiresInMs)||expiresInMs<1||expiresInMs>300000)fail('invalid_release','Choose a release expiry of at most five minutes.');
  const resource=await this.resolve(lookup),context=await this.captureFrame(consumerFrameId);if(context.readOnly||this.classification(resource)==='unclassified')fail('release_unavailable','The resource cannot be released before its source is classified.');
  const destination=Object.freeze(destinationSchema.parse(await this.deps.resolveDestination(context,requested))),draft=Object.freeze({versionId:resource.versionId,checksum:resource.checksum,binding:resourceBinding(resource),consumerFrameId:context.frameId,consumerRootFrameId:context.rootFrameId,consumerRevision:context.revision,purpose:requested,destination,expiresAt:this.now()+expiresInMs,revision:this.state.revision});this.drafts.add(draft);return draft;
 }
 async approveRelease(draft:ResourceReleaseDraft){
  this.open();if(!this.drafts.has(draft)||!this.deps.approveRelease||!this.deps.resolveDestination)fail('untrusted_release','A native reviewed resource release is required.');this.drafts.delete(draft);
  const current=async()=>{const resource=await this.resolve({versionId:draft.versionId}),context=await this.captureFrame(draft.consumerFrameId);if(this.state.revision!==draft.revision||this.now()>=draft.expiresAt||resourceBinding(resource)!==draft.binding||context.rootFrameId!==draft.consumerRootFrameId||context.revision!==draft.consumerRevision||!same(destinationSchema.parse(await this.deps.resolveDestination!(context,draft.purpose)),draft.destination))fail('scope_changed','The resource or destination changed during review.',409)};
  await current();const answer=await this.deps.approveRelease(draft);if(answer.decision!=='approve')fail('release_denied','The resource release was not approved.');id.parse(answer.receiptId);await current();
  const release={id:randomUUID(),versionId:draft.versionId,checksum:draft.checksum,binding:draft.binding,consumerFrameId:draft.consumerFrameId,consumerRootFrameId:draft.consumerRootFrameId,consumerRevision:draft.consumerRevision,purpose:draft.purpose,destination:draft.destination,expiresAt:draft.expiresAt,receiptId:answer.receiptId,used:false};const next=structuredClone(this.state);next.releases.push(release);next.revision++;this.commit(next);return Object.freeze({id:release.id,expiresAt:release.expiresAt});
 }
 revokeRelease(releaseId:string){this.open();const next=structuredClone(this.state);next.releases=next.releases.filter(r=>r.id!==releaseId);next.revision++;this.commit(next)}
 snapshot(){this.open();return {...structuredClone(this.state),protectedHistory:this.protectedHistory}}
 close(){this.closed=true;this.contexts=new WeakSet;this.leases=new WeakMap;this.drafts=new WeakSet}
}
