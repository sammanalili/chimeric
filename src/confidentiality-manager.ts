import {createHash,randomUUID} from 'node:crypto';
import {Registry} from './registry';
import {lookupFrame} from './native-frame-context';
import {NativeSessionScope} from './native-scope';
import {SessionPolicyStore,SessionPolicyError,connectionBindingDigest,type ConnectionBinding,type SessionContext,type ModelTarget,type PolicyLane} from './session-policy';
import {OutboundBroker,type BrokerResponse,type BrokerWireRequest,type OutboundIntent} from './outbound-broker';
import type {BridgeAuthorization} from './bridge';
import type {Class2Snapshot,Class2ConnectionSnapshot} from './class2-http';

const executableApis=new Set(['openai-completions','openai-responses','anthropic-messages']);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export type ConfidentialityDependencies={
 owner:{userId:string;organizationId:string};
 lookupFrame?:typeof lookupFrame;
 transport:(request:BrokerWireRequest)=>Promise<BrokerResponse>;
 /** Set only after actual platform-specific native wrapper verification. */
 offlineExecution?:{verified:true;platform:NodeJS.Platform;overrides:Readonly<Record<string,unknown>>};
 changed?:()=>void;
 /** Real app-wide file, browser and execution evidence. A model flag or a
  * connection approval cannot establish this. Defaults to unavailable. */
 protectionEvidence?:()=>{verified:boolean;reason?:string};
 /** Daemon-only native execution boundary. The callbacks receive contexts
  * minted by SessionPolicyStore, never frame IDs supplied by a model. */
 nativeBoundary?:{
  transition:(context:SessionContext,target:'standard'|'class2',apply:()=>void|Promise<void>)=>Promise<void>;
  noteExecution:(kind:string,context:SessionContext)=>void;
  assertHostContext:(owner:unknown)=>void;
  beginModel:(context:SessionContext)=>Readonly<{signal:AbortSignal;assertCurrent:()=>void;close:()=>void}>;
 };
};
/** Coordinates existing native ownership, model routing and the human-only
 * review API. Provider branding and model-written flags confer no permission. */
export class ConfidentialityManager {
 readonly policy:SessionPolicyStore;readonly scope:NativeSessionScope;readonly broker:OutboundBroker;
 private destinations=new Map<string,ConnectionBinding>();private unwatch:()=>void;
 private observedBindings=new Map<string,string>();
 private waiting=new Map<string,{rootFrameId:string;modelConnectionIds:string[];signal?:AbortSignal;resolve:(result:any)=>void;cleanup:()=>void}>();
 constructor(readonly registry:Registry,private deps:ConfidentialityDependencies){
  this.policy=new SessionPolicyStore(registry.profileDir,{
   lookupFrame:id=>(deps.lookupFrame??lookupFrame)(registry.profileDir,id),
   currentConnection:id=>this.binding(id),
   enforcement:(context,lane)=>this.enforcement(context,lane),
  });
  this.scope=new NativeSessionScope(this.policy,{assertOwner:context=>this.assertOwner(context)});
  this.broker=new OutboundBroker(this.policy,{transport:deps.transport});
  this.unwatch=this.policy.subscribe(change=>{for(const [id,pending]of this.waiting)if(change.kind==='closed'||change.kind==='session'&&change.rootFrameId===pending.rootFrameId||change.kind==='connection'&&pending.modelConnectionIds.includes(change.connectionId))this.finish(id,{status:'error',error:'The chat policy or model permission changed. Review the current request before continuing.'});deps.changed?.()});
  this.observedBindings=this.bindingStamps();
 }
 private bindingStamps(){return new Map(Object.keys(this.registry.config.providers).map(id=>{const binding=this.binding(id);return [id,JSON.stringify([binding?connectionBindingDigest(binding):null,this.registry.config.providers[id].enabled,this.registry.statuses[id]?.ready])] }))}
 private refreshBindings(){const previous=this.observedBindings,next=this.bindingStamps();this.observedBindings=next;for(const id of new Set([...previous.keys(),...next.keys()]))if(previous.get(id)!==next.get(id))this.policy.connectionsChanged(id)}
 private assertOwner(context:SessionContext){if(context.ownerId!==this.deps.owner.userId||context.organizationId!==this.deps.owner.organizationId)throw new SessionPolicyError('not_owner','This session belongs to a different local workspace owner.')}
 private async context(frameId?:string){if(!frameId)throw new SessionPolicyError('frame_required','Open a saved research chat to change its confidentiality setting.',400);const context=await this.policy.contextForFrame(frameId);this.assertOwner(context);return context}
 ownedContext(frameId:string){return this.context(frameId)}
 binding(id:string):ConnectionBinding|undefined{
  const p=this.registry.config.providers[id];if(!p)return this.destinations.get(id);
  try{
   const credential=this.registry.getPrivateCredential(id);
   return {id,endpoint:p.baseUrl,api:p.api,revision:p.revision,credentialRevision:credential?digest(credential):'keyless'};
  }catch{return undefined}
 }
 private eligibility(id:string){
  const p=this.registry.config.providers[id],binding=this.binding(id);let reason:string|undefined;
  if(!p||!binding||p.enabled===false||!this.registry.statuses[id]?.ready)reason='The connection is unavailable.';
  else if(!executableApis.has(p.api))reason='This subscription or subprocess transport has not been confined for Class 2.';
  else if(new URL(p.baseUrl).protocol!=='https:')reason='Class 2 model connections require HTTPS.';
  return {binding,ready:!reason,reason};
 }
 private enforcement(_context:SessionContext,lane:PolicyLane){
  const evidence=this.deps.protectionEvidence?.();if(evidence?.verified!==true)return {verified:false,reason:evidence?.reason??'Class 2 is unavailable until browser and cross-chat file isolation are verified for this build.'};
  if(['model','brokered-http','stt'].includes(lane))return {verified:true};
  if(lane==='local-compute'&&this.deps.offlineExecution?.verified&&this.deps.offlineExecution.platform===process.platform)return {verified:true};
  return {verified:false,reason:'This native execution path is not yet verified for protected sessions and is disabled. Use the reviewed outgoing-request tool for external access.'};
 }
 private target(qualifiedId:string|undefined):ModelTarget{
  if(!qualifiedId)throw new SessionPolicyError('model_required','Choose a Class 2 model.',400);
  const model=this.registry.resolve(qualifiedId),eligible=this.eligibility(model.provider);
  if(model.mode!=='chat'||model.available===false||model.subscriptionAvailable===false||!eligible.ready||!eligible.binding)throw new SessionPolicyError('model_unavailable',eligible.reason??'Choose an available chat model.',409);
  if(!this.policy.isApproved(eligible.binding,'model'))throw new SessionPolicyError('connection_not_approved','Approve this connection for Class 2 model data in Connections first.');
  return {connection:eligible.binding,modelId:model.id};
 }
 private connectionSnapshot(connectionId:string){
  const p=this.registry.config.providers[connectionId];if(!p)throw new SessionPolicyError('connection_unavailable','This model connection is unavailable.',404);
  const e=this.eligibility(connectionId),state=this.policy.snapshot(),approval=state.approvals.find(a=>a.binding.id===connectionId),automatic=approval?.autoStt===true||approval?.source==='stt-selection';
  const all=(['model','stt'] as const).filter(purpose=>e.binding&&this.policy.isApproved(e.binding,purpose)),automaticPurposes=all.filter(purpose=>purpose==='stt'&&automatic),allowedPurposes=all.filter(purpose=>!automaticPurposes.includes(purpose));
  return {revision:state.revision,connectionId,name:p.name,allowedPurposes,automaticPurposes,eligible:e.ready,ready:e.ready,reason:e.reason,
   evidence:{status:'not-verified',retention:'Provider policy has not been independently verified.',zdr:'unknown',summary:'Your approval permits this connection to receive protected data. It does not establish zero data retention or institutional authorization.'}};
 }
 async snapshot(input:{frameId?:string;connectionId?:string}):Promise<Class2Snapshot|Class2ConnectionSnapshot>{
  this.refreshBindings();
  if(input.connectionId)return this.connectionSnapshot(input.connectionId);
  const eligibility=new Map(Object.keys(this.registry.config.providers).map(id=>{const e=this.eligibility(id);return [id,{...e,approved:!!e.binding&&this.policy.isApproved(e.binding,'model')}]}));
  const models=[...this.registry.models.values()].filter(m=>m.mode==='chat').map(model=>{const e=eligibility.get(model.provider)??{binding:undefined,ready:false,approved:false,reason:'The model connection is unavailable.'};return {qualifiedId:model.qualifiedId,name:model.name,connectionId:model.provider,eligible:e.ready&&e.approved&&model.available!==false&&model.subscriptionAvailable!==false,reason:e.reason??(e.binding&&!e.approved?'Approve this connection for Class 2 in Connections.':undefined)}});
  if(!input.frameId)throw new SessionPolicyError('frame_required','Open a saved research chat to use Class 2.',400);
  const context=await this.context(input.frameId),policy=this.policy.policy(context);
  return {revision:policy.revision,frameId:context.frameId,rootFrameId:context.rootFrameId,mode:policy.mode,models,
   main:policy.main?policy.main.connection.id+'::'+policy.main.modelId:undefined,reviewer:policy.reviewer?policy.reviewer.connection.id+'::'+policy.reviewer.modelId:undefined,
   ready:this.deps.protectionEvidence?.().verified===true&&models.some(m=>m.eligible),reason:this.deps.protectionEvidence?.().verified!==true?'Class 2 is unavailable until browser and cross-chat file isolation are verified for this build.':models.some(m=>m.eligible)?undefined:'Approve an available HTTPS model connection for Class 2 in Connections.',
   reviews:this.broker.reviews(context)};
 }
 async setMode(input:{frameId:string;expectedRevision:number;mode:'standard'|'class2';main?:string;reviewer?:string}){
  const context=await this.context(input.frameId),eligible=[...this.registry.models.values()].filter(m=>m.mode==='chat'&&this.eligibility(m.provider).ready&&this.binding(m.provider)&&this.policy.isApproved(this.binding(m.provider)!,'model'));
  if(input.mode==='class2'&&this.deps.protectionEvidence?.().verified!==true)throw new SessionPolicyError('protection_unverified','Class 2 is unavailable until browser and cross-chat file isolation are verified for this build.',503);
  const current=this.policy.policy(context);
  if(input.expectedRevision!==current.revision)throw new SessionPolicyError('revision_conflict','The session confidentiality setting changed. Reload before saving.',409);
  const preferred=eligible.find(m=>m.qualifiedId===this.registry.state.model)??eligible[0];
  const main=input.mode==='class2'?this.target(input.main??preferred?.qualifiedId):undefined,reviewer=input.mode==='class2'?this.target(input.reviewer??input.main??preferred?.qualifiedId):undefined;
  const apply=()=>this.policy.setMode(context,{expectedRevision:input.expectedRevision,mode:input.mode,main,reviewer});
  if(this.deps.nativeBoundary&&(current.mode!==input.mode||input.mode==='class2'))await this.deps.nativeBoundary.transition(context,input.mode,apply);else apply();
  return this.snapshot({frameId:input.frameId});
 }
 async approveConnection(input:{connectionId:string;expectedRevision:number;purposes:Array<'model'|'stt'>}){
  this.refreshBindings();
  const e=this.eligibility(input.connectionId);if(input.purposes.length&&(!e.ready||!e.binding))throw new SessionPolicyError('connection_unavailable',e.reason??'The connection is unavailable.',409);
  if(!e.binding)throw new SessionPolicyError('connection_unavailable','The connection binding is unavailable.',409);
  this.policy.setUserConnectionPurposes(e.binding,input.purposes,input.expectedRevision);
  return this.connectionSnapshot(input.connectionId);
 }
 private finish(reviewId:string,result:any){const pending=this.waiting.get(reviewId);if(pending){this.waiting.delete(reviewId);pending.cleanup();pending.resolve(result)}}
 async sendOnce(input:{frameId:string;reviewId:string;digest:string},signal?:AbortSignal){
  const context=await this.context(input.frameId),permit=await this.broker.approve(context,input.reviewId,input.digest);
  const pending=this.waiting.get(input.reviewId);pending?.cleanup();const effective=AbortSignal.any([...signal?[signal]:[],...pending?.signal?[pending.signal]:[]]);
  try{const response=await this.broker.execute(permit,effective);this.finish(input.reviewId,{status:'success',result:response});return response}
  catch(error){this.finish(input.reviewId,{status:'error',error:'The approved request failed and was not retried.'});throw error}
 }
 async deny(input:{frameId:string;reviewId:string}){const context=await this.context(input.frameId);this.broker.deny(context,input.reviewId);this.finish(input.reviewId,{status:'error',error:'The user declined this external request. No request was sent.'});return this.snapshot({frameId:input.frameId})}
 /** Model tool can propose a request; only the authenticated review action can
  * approve it. This creates a keyless destination, never a model credential. */
 async prepareOutgoing(frameId:string,input:Omit<OutboundIntent,'connection'>){
  const context=await this.context(frameId),url=new URL(input.request.url);
  if(url.protocol!=='https:'||url.username||url.password)throw new SessionPolicyError('secure_destination_required','Reviewed external requests require an HTTPS destination without URL credentials.',400);
  const id='outbound-'+digest(url.origin),binding={id,endpoint:url.origin,api:'reviewed-http',revision:'1',credentialRevision:'keyless'};
  this.destinations.set(id,binding);const review=await this.broker.prepare(context,{...input,connection:binding});this.deps.changed?.();return review;
 }
 async authorize(request:Request,body:any):Promise<BridgeAuthorization>{
  const verified=await this.scope.verify(request,body);
  if(verified&&'standardRequest' in verified)return {modelId:body.model,replayNamespace:verified.replayNamespace,assertCurrent:()=>{},close:()=>{}};
  if(!verified){
   // Raw native calls without an ownership carrier cannot be assigned to a
   // protected root by guessing from their prompt or requested model.
   if(this.policy.snapshot().sessions.some(s=>s.mode==='class2'))throw new SessionPolicyError('missing_native_scope','This background model call has no verified chat scope and was blocked.');
   return {modelId:body.model,replayNamespace:digest(randomUUID()),assertCurrent:()=>{},close:()=>{}};
  }
  const {context,role}=verified,p=this.policy.policy(context),modelId=this.policy.chooseModel(context,role,body.model),model=this.registry.resolve(modelId),binding=this.binding(model.provider),controller=new AbortController();
  if(p.mode==='class2'){
   if(!binding||!this.eligibility(model.provider).ready)throw new SessionPolicyError('connection_unavailable','The protected model connection is unavailable.');
   this.policy.assertModel(context,{connection:binding,modelId:model.id},role);
   const pending=[body];let visited=0;
   while(pending.length){const value=pending.pop();if(!value||typeof value!=='object')continue;if(++visited>200_000)throw new SessionPolicyError('payload_limit','The protected request exceeds its inspection limit.',413);
    if(value.source?.type==='url')throw new SessionPolicyError('review_required','Remote attachment URLs require a reviewed outgoing request. Upload the file locally instead.');
    if(value.type==='document'&&value.source?.type!=='text')throw new SessionPolicyError('unverified_converter','Binary document conversion is disabled until its native isolation path is verified. Plain text and image inputs remain available.');
    for(const nested of Object.values(value))if(nested&&typeof nested==='object')pending.push(nested);
   }
  }
  const modelLease=this.deps.nativeBoundary?.beginModel(context);
  const unwatch=this.policy.subscribe(change=>{if(change.kind==='closed'||change.kind==='session'&&change.rootFrameId===context.rootFrameId||change.kind==='connection'&&change.connectionId===model.provider)controller.abort(new Error('Session permission changed'))});
  const replayNamespace=digest(JSON.stringify([context.organizationId,context.ownerId,context.projectId,context.rootFrameId]));
  let closed=false;const close=()=>{if(closed)return;closed=true;unwatch();modelLease?.close()};
  return {modelId,replayNamespace,signal:modelLease?AbortSignal.any([controller.signal,modelLease.signal]):controller.signal,close,assertCurrent:async()=>{
   controller.signal.throwIfAborted();modelLease?.assertCurrent();await this.policy.revalidateContext(context);this.assertOwner(context);modelLease?.assertCurrent();
   if(this.policy.policy(context).revision!==p.revision)throw new SessionPolicyError('policy_changed','The chat confidentiality policy changed.',409);
   if(p.mode==='class2'){
    if(!this.eligibility(model.provider).ready||this.registry.models.get(model.qualifiedId)?.available===false)throw new SessionPolicyError('connection_unavailable','The protected model connection became unavailable.',409);
    this.policy.assertModel(context,{connection:binding!,modelId:model.id},role);
   }
  },...p.mode==='class2'?{executeServerTool:async()=>{throw new SessionPolicyError('review_required','External search and fetching require a reviewed outgoing request. Prepare a transformed copy with its purpose and destination for the user to approve.')}}:{}};
 }
 outgoingTool(){return {name:'request_external_access',description:'For user-requested external access in Class 2, prepare the minimum redacted or decontextualized HTTPS request. Explain its purpose and removed information. The user reviews the exact outgoing copy and IP/location disclosures. This tool waits for Send once approval. You cannot grant permission. There are no redirects, retries or account credentials.',input_schema:{type:'object',properties:{rationale:{type:'string'},privacy:{type:'object',properties:{kind:{enum:['redacted','decontextualized']},summary:{type:'string'},limitations:{type:'array',items:{type:'string'}}},required:['kind','summary']},request:{type:'object',properties:{method:{enum:['GET','POST','PUT','PATCH','DELETE']},url:{type:'string'},headers:{type:'object',additionalProperties:{type:'string'}},payload:{type:'object',description:'Exact payload: {kind:"none"}, {kind:"text",contentType,text}, {kind:"json",value}, {kind:"bytes",contentType,base64,filename?}, or {kind:"multipart",fields:[{name,value}],files:[{fieldName,filename,contentType,base64}]}'}},required:['method','url','payload']}},required:['rationale','privacy','request']}}}
 async executeOutgoing(host:any,call:any,args:any,signal?:AbortSignal){
  if(host._isAside||['REVIEWER','AUDITOR','BOOKMARKER'].includes(String(host.agentName).toUpperCase()))return {status:'error',error:'Only the main research agent can request an external send.'};
  signal?.throwIfAborted();const context=await this.context(host.frameId);this.policy.assertWritable(context);
  if(context.projectId!==host.projectId||context.rootFrameId!==host.rootFrameId)throw new SessionPolicyError('scope_changed','The native tool owner does not match this chat.');
  const review=await this.prepareOutgoing(host.frameId,{...args,intentId:String(call.id)});
  if(this.waiting.has(review.id))throw new SessionPolicyError('request_waiting','This external request is already awaiting its review.',409);
  const outcome:any=await new Promise(resolve=>{
   const cancel=()=>{try{this.broker.deny(context,review.id)}catch{}this.finish(review.id,{status:'error',error:signal?.aborted?'The external request was cancelled.':'The outgoing review expired. No request was sent.'})};
   const timer=setTimeout(cancel,Math.max(1,review.expiresAt-Date.now()));timer.unref();
   const policy=this.policy.policy(context);
   this.waiting.set(review.id,{rootFrameId:context.rootFrameId,modelConnectionIds:[policy.main!.connection.id,policy.reviewer!.connection.id],signal,resolve,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel)}});signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
  });
  if(outcome.status!=='success')return outcome;
  signal?.throwIfAborted();await this.policy.revalidateContext(context);
  const response=outcome.result as BrokerResponse,bytes=Buffer.from(response.bodyBase64,'base64'),contentType=response.headers?.['content-type']??'application/octet-stream';
  if(/^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml))/i.test(contentType))return {status:'success',result:{httpStatus:response.status,url:review.destination.url,contentType,text:bytes.toString('utf8').slice(0,200_000),truncated:bytes.toString('utf8').length>200_000,bodyBytes:bytes.length}};
  if(!host._artifactSvcImpl?.save_artifact)return {status:'error',error:'The request completed, but this native session cannot save its binary response. It was not sent again.'};
  const saved=await host._artifactSvcImpl.save_artifact({project_id:context.projectId,root_frame_id:context.rootFrameId,frame_id:context.frameId,filename:'external-response-'+review.id+'.bin',content:bytes,content_type:'application/octet-stream',agent_name:host.agentName,is_user_upload:false});
  return {status:'success',result:{httpStatus:response.status,url:review.destination.url,contentType,bodyBytes:bytes.length,artifacts:[{...saved,artifact_ref:'{{artifact:'+saved.version_id+'}}'}]}};
 }
 async guardNativeExecution(kind:string,owner:any,details:any){
  const frameId=this.scope.currentFrame()??details?.frameId??owner?.frameId??owner?.frame_id??owner?.rootFrameId??owner?.root_frame_id;
  if(!frameId){if(this.policy.snapshot().sessions.some(s=>s.mode==='class2'))throw new SessionPolicyError('missing_native_scope','This tool has no verified chat scope and was blocked.');return}
  const context=await this.context(frameId);if(kind==='host-call')this.deps.nativeBoundary?.assertHostContext(owner);this.deps.nativeBoundary?.noteExecution(kind,context);if(this.policy.policy(context).mode!=='class2')return;
  if(kind==='tool'&&details?.tool?.name==='request_external_access'&&!details?.flattenedMcp)return;
  const lane:PolicyLane=kind==='kernel'||kind==='process'?'local-compute':kind==='network-grant'?'uncontrolled-network':kind==='host-call'?'mcp':'uncontrolled-network';
  this.policy.assertLane(context,lane);
  if(lane==='local-compute')return {...this.deps.offlineExecution!.overrides};
 }
 connectionChanged(id:string){this.observedBindings=this.bindingStamps();this.policy.connectionsChanged(id)}
 close(){for(const id of [...this.waiting.keys()])this.finish(id,{status:'error',error:'The application closed. The external request was not retried.'});this.unwatch();this.broker.close();this.scope.close();this.policy.close()}
}
