import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';

const id=z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const bindingSchema=z.object({id,endpoint:z.string().max(8192),api:id,revision:z.string().min(1).max(255),
  // Opaque digest or explicit keyless marker. Never pass a key or token here.
  credentialRevision:z.string().regex(/^(?:[a-f0-9]{64}|keyless)$/)}).strict();
export type ConnectionBinding=z.infer<typeof bindingSchema>;
export type ConnectionPurpose='model'|'stt';
export type ModelRole='main'|'reviewer'|'small'|'medium'|'large'|'memory'|'classifier'|'compaction'|'lineage';
export type PolicyLane='model'|'stt'|'brokered-http'|'local-compute'|'mcp'|'remote-compute'|'uncontrolled-network';
export type FrameIdentity={frameId:string;rootFrameId:string|null;projectId:string;ownerId:string;organizationId:string;parentFrameId?:string|null;readOnly?:boolean};
export type SessionContext=Readonly<{frameId:string;rootFrameId:string;projectId:string;ownerId:string;organizationId:string;readOnly:boolean}>;
export type ModelTarget={connection:ConnectionBinding;modelId:string};
const targetSchema=z.object({connection:bindingSchema,modelId:z.string().min(1).max(512)}).strict();
const sessionSchema=z.object({rootFrameId:id,projectId:id,ownerId:id,organizationId:id,revision:z.number().int().nonnegative(),mode:z.enum(['standard','class2']),main:targetSchema.optional(),reviewer:targetSchema.optional()}).strict();
export type SessionPolicy=z.infer<typeof sessionSchema>;
const approvalSchema=z.object({binding:bindingSchema,purposes:z.array(z.enum(['model','stt'])).max(2),approvedAt:z.number().int().nonnegative(),source:z.enum(['user','stt-selection']),autoStt:z.boolean().optional()}).strict();
const stateSchema=z.object({schemaVersion:z.literal(1),revision:z.number().int().nonnegative(),approvals:z.array(approvalSchema).max(1024),selectedStt:bindingSchema.nullable(),sessions:z.array(sessionSchema).max(4096)}).strict();
type State=z.infer<typeof stateSchema>;
export type PolicyChange={kind:'session';rootFrameId:string}|{kind:'connection';connectionId:string}|{kind:'stt'}|{kind:'closed'};
export class SessionPolicyError extends Error {
  constructor(readonly code:string,message:string,readonly status=403){super(message);this.name='SessionPolicyError'}
}
export const policyDigest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function normalizeConnectionBinding(raw:ConnectionBinding):ConnectionBinding {
  const binding=bindingSchema.parse(raw),url=new URL(binding.endpoint);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)
    throw new SessionPolicyError('invalid_connection','Connection URLs must be HTTP(S) base URLs without credentials, query strings or fragments.',400);
  url.pathname=url.pathname.replace(/\/+$/,'')||'/';
  return {...binding,endpoint:url.href.replace(/\/$/,'')};
}
export const connectionBindingDigest=(binding:ConnectionBinding)=>policyDigest(normalizeConnectionBinding(binding));
export function writePolicyJson(file:string,value:unknown){
  const temporary=file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(value),{mode:0o600,flag:'wx'});renameSync(temporary,file);chmodSync(file,0o600);
}
const copy=<T>(value:T):T=>structuredClone(value);

/** User mutation handlers must enforce native authentication/CSRF. This store
 * authorizes dispatches; it does not intercept sockets or prove OS confinement. */
export class SessionPolicyStore {
  private state:State={schemaVersion:1,revision:0,approvals:[],selectedStt:null,sessions:[]};
  private file:string;private contexts=new WeakSet<object>();private listeners=new Set<(change:PolicyChange)=>void>();private closed=false;
  constructor(readonly profileDir:string,private options:{
    lookupFrame:(frameId:string)=>FrameIdentity|undefined|Promise<FrameIdentity|undefined>;
    currentConnection:(id:string)=>ConnectionBinding|undefined;
    enforcement?:(context:SessionContext,lane:PolicyLane)=>{verified:boolean;reason?:string};now?:()=>number;
  }){
    const directory=join(profileDir,'local-auth');mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);this.file=join(directory,'session-policy.json');
    if(existsSync(this.file))try{
      if(statSync(this.file).size>2*1024*1024)throw Error('oversize');this.state=stateSchema.parse(JSON.parse(readFileSync(this.file,'utf8')));
      for(const a of this.state.approvals)a.binding=normalizeConnectionBinding(a.binding);
      for(const s of this.state.sessions){if(s.mode==='class2'&&(!s.main||!s.reviewer))throw Error('missing model');if(s.main)s.main.connection=normalizeConnectionBinding(s.main.connection);if(s.reviewer)s.reviewer.connection=normalizeConnectionBinding(s.reviewer.connection)}
      if(new Set(this.state.sessions.map(v=>v.rootFrameId)).size!==this.state.sessions.length||new Set(this.state.approvals.map(v=>v.binding.id)).size!==this.state.approvals.length)throw Error('duplicate');
    }catch{throw new SessionPolicyError('policy_unreadable','The confidentiality policy could not be read. Restore it before resuming protected research.',503)}
  }
  private now(){return this.options.now?.()??Date.now()}
  private assertOpen(){if(this.closed)throw new SessionPolicyError('closed','The confidentiality policy is closed.',503)}
  private assertContext(context:SessionContext){this.assertOpen();if(!context||!this.contexts.has(context))throw new SessionPolicyError('untrusted_context','A verified native session context is required.')}
  assertWritable(context:SessionContext){this.assertContext(context);if(context.readOnly)throw new SessionPolicyError('read_only','This research frame cannot change permissions or send external tool requests.')}
  /** The native datastore must resolve ownership. Never trust a supplied root/project ID. */
  async contextForFrame(frameId:string):Promise<SessionContext>{
    this.assertOpen();id.parse(frameId);const frame=await this.options.lookupFrame(frameId);
    if(!frame||frame.frameId!==frameId)throw new SessionPolicyError('frame_unavailable','The research session is unavailable.',404);
    const rootId=frame.rootFrameId??frame.frameId,root=await this.options.lookupFrame(rootId);
    if(!root||root.frameId!==rootId||(root.rootFrameId??root.frameId)!==root.frameId||root.parentFrameId||root.projectId!==frame.projectId||root.ownerId!==frame.ownerId||root.organizationId!==frame.organizationId)
      throw new SessionPolicyError('invalid_frame_scope','The research session scope could not be verified.');
    for(const value of [rootId,frame.projectId,frame.ownerId,frame.organizationId])id.parse(value);
    const context=Object.freeze({frameId,rootFrameId:rootId,projectId:frame.projectId,ownerId:frame.ownerId,organizationId:frame.organizationId,readOnly:frame.readOnly===true});this.contexts.add(context);return context;
  }
  async revalidateContext(context:SessionContext){
    this.assertContext(context);const fresh=await this.contextForFrame(context.frameId);
    if(['rootFrameId','projectId','ownerId','organizationId','readOnly'].some(key=>fresh[key as keyof SessionContext]!==context[key as keyof SessionContext]))throw new SessionPolicyError('scope_changed','The research session scope changed. Review the request again.',409);
  }
  policy(context:SessionContext):SessionPolicy {
    this.assertContext(context);const found=this.state.sessions.find(v=>v.rootFrameId===context.rootFrameId);
    if(found&&['projectId','ownerId','organizationId'].some(k=>found[k as keyof SessionPolicy]!==context[k as keyof SessionContext]))throw new SessionPolicyError('scope_changed','The session policy belongs to another owner or project.');
    return copy(found??{rootFrameId:context.rootFrameId,projectId:context.projectId,ownerId:context.ownerId,organizationId:context.organizationId,revision:0,mode:'standard'});
  }
  snapshot(){this.assertOpen();return copy(this.state)}
  private save(next:State,change:PolicyChange){
    this.assertOpen();const checked=stateSchema.parse(next);writePolicyJson(this.file,checked);this.state=checked;
    for(const listener of this.listeners)try{listener(change)}catch{/* Policy was committed even if a watcher fails. */}
  }
  private expectRevision(expected:number){if(expected!==this.state.revision)throw new SessionPolicyError('revision_conflict','Connection permissions changed. Reload before saving.',409)}
  assertBindingCurrent(binding:ConnectionBinding){
    this.assertOpen();const expected=normalizeConnectionBinding(binding),current=this.options.currentConnection(expected.id);
    if(!current||connectionBindingDigest(current)!==connectionBindingDigest(expected))throw new SessionPolicyError('connection_changed','The connection URL, credential or configuration changed. Review the request again.',409);
  }
  isApproved(binding:ConnectionBinding,purpose:ConnectionPurpose){
    try{this.assertBindingCurrent(binding);const a=this.state.approvals.find(v=>v.binding.id===binding.id);return !!a&&connectionBindingDigest(a.binding)===connectionBindingDigest(binding)&&a.purposes.includes(purpose)}catch{return false}
  }
  approveConnection(binding:ConnectionBinding,purposes:ConnectionPurpose[],expectedRevision:number){
    this.expectRevision(expectedRevision);binding=normalizeConnectionBinding(binding);this.assertBindingCurrent(binding);
    const allowed=z.array(z.enum(['model','stt'])).min(1).max(2).parse(purposes),next=copy(this.state);next.approvals=next.approvals.filter(v=>v.binding.id!==binding.id);
    next.approvals.push({binding,purposes:[...new Set(allowed)],approvedAt:this.now(),source:'user'});next.revision++;this.save(next,{kind:'connection',connectionId:binding.id});return this.snapshot();
  }
  revokeConnection(connectionId:string,expectedRevision:number){
    this.expectRevision(expectedRevision);const next=copy(this.state);next.approvals=next.approvals.filter(v=>v.binding.id!==connectionId);next.revision++;this.save(next,{kind:'connection',connectionId});return this.snapshot();
  }
  /** The Connections UI edits explicit grants only. A selected transcription
   * model keeps its separate automatic speech grant without promoting it. */
  setUserConnectionPurposes(binding:ConnectionBinding,purposes:ConnectionPurpose[],expectedRevision:number){
    this.expectRevision(expectedRevision);binding=normalizeConnectionBinding(binding);this.assertBindingCurrent(binding);
    const explicit=[...new Set(z.array(z.enum(['model','stt'])).max(2).parse(purposes))],next=copy(this.state);
    const selected=next.selectedStt&&connectionBindingDigest(next.selectedStt)===connectionBindingDigest(binding),autoStt=!!selected&&!explicit.includes('stt');
    const allowed:ConnectionPurpose[]=[...explicit,...autoStt?['stt' as const]:[]];
    next.approvals=next.approvals.filter(v=>v.binding.id!==binding.id);
    if(allowed.length)next.approvals.push({binding,purposes:allowed,approvedAt:this.now(),source:explicit.length?'user':'stt-selection',...autoStt?{autoStt:true}:{}});
    next.revision++;this.save(next,{kind:'connection',connectionId:binding.id});return this.snapshot();
  }
  /** Only the authenticated user's selected STT is auto-approved, only for STT. */
  selectStt(binding:ConnectionBinding|null,expectedRevision:number){
    this.expectRevision(expectedRevision);const next=copy(this.state);
    // Revoke selection-only speech grants while preserving explicit purposes.
    // Legacy source:user records without a marker remain explicit because their
    // original STT approval cannot be reconstructed safely.
    next.approvals=next.approvals.flatMap(approval=>{
      if(approval.autoStt!==true&&approval.source!=='stt-selection')return [approval];
      const {autoStt,...remaining}=approval,purposes=approval.purposes.filter(purpose=>purpose!=='stt');
      return purposes.length?[{...remaining,purposes}]:[];
    });
    if(binding){binding=normalizeConnectionBinding(binding);this.assertBindingCurrent(binding);const prior=next.approvals.find(v=>v.binding.id===binding!.id),same=prior&&connectionBindingDigest(prior.binding)===connectionBindingDigest(binding);
      const explicitStt=same&&prior.purposes.includes('stt');
      next.approvals=next.approvals.filter(v=>v.binding.id!==binding!.id);next.approvals.push({binding,purposes:[...new Set<ConnectionPurpose>([...(same?prior.purposes:[]),'stt'])],approvedAt:this.now(),source:same&&prior.source==='user'?'user':'stt-selection',...explicitStt?{}:{autoStt:true}})}
    next.selectedStt=binding;next.revision++;this.save(next,{kind:'stt'});return this.snapshot();
  }
  setMode(context:SessionContext,input:{expectedRevision:number;mode:'standard'|'class2';main?:ModelTarget;reviewer?:ModelTarget}){
    this.assertWritable(context);const current=this.policy(context);if(input.expectedRevision!==current.revision)throw new SessionPolicyError('revision_conflict','The session confidentiality setting changed. Reload before saving.',409);
    const mode=z.enum(['standard','class2']).parse(input.mode),session:SessionPolicy={rootFrameId:context.rootFrameId,projectId:context.projectId,ownerId:context.ownerId,organizationId:context.organizationId,revision:current.revision+1,mode};
    if(mode==='class2'){
      if(!input.main)throw new SessionPolicyError('eligible_model_required','Choose an approved model connection before enabling Class 2.');
      const main=targetSchema.parse(input.main),reviewer=targetSchema.parse(input.reviewer??input.main);
      for(const target of [main,reviewer]){target.connection=normalizeConnectionBinding(target.connection);if(!this.isApproved(target.connection,'model'))throw new SessionPolicyError('connection_not_approved','Every Class 2 model role must use an approved connection.')}
      session.main=main;session.reviewer=reviewer;
    }
    const next=copy(this.state);next.sessions=next.sessions.filter(v=>v.rootFrameId!==context.rootFrameId);next.sessions.push(session);next.revision++;this.save(next,{kind:'session',rootFrameId:context.rootFrameId});return copy(session);
  }
  modelFor(context:SessionContext,role:ModelRole='main'):ModelTarget|undefined {
    const p=this.policy(context);if(p.mode!=='class2')return;const target=role==='reviewer'?p.reviewer:p.main;
    if(!target||!this.isApproved(target.connection,'model'))throw new SessionPolicyError('connection_not_approved','The protected model connection is unavailable or no longer approved.');
    this.assertLane(context,'model');return copy(target);
  }
  chooseModel(context:SessionContext,role:ModelRole,requestedModel:string){const target=this.modelFor(context,role);return target?target.connection.id+'::'+target.modelId:requestedModel}
  assertModel(context:SessionContext,target:ModelTarget,role:ModelRole='main'){
    const expected=this.modelFor(context,role);if(expected&&(expected.modelId!==target.modelId||connectionBindingDigest(expected.connection)!==connectionBindingDigest(target.connection)))throw new SessionPolicyError('model_policy_mismatch','This model does not match the session confidentiality policy.');
  }
  sttFor(context:SessionContext):{kind:'local'}|{kind:'connection';connection:ConnectionBinding}{
    if(this.policy(context).mode!=='class2'||!this.state.selectedStt)return {kind:'local'};const connection=this.state.selectedStt;
    if(!this.isApproved(connection,'stt'))throw new SessionPolicyError('stt_not_approved','The selected speech connection changed or is no longer approved.');this.assertLane(context,'stt');return {kind:'connection',connection:copy(connection)};
  }
  assertLane(context:SessionContext,lane:PolicyLane){
    if(this.policy(context).mode!=='class2')return;const proof=this.options.enforcement?.(context,lane);
    if(proof?.verified!==true)throw new SessionPolicyError('unverified_lane',proof?.reason??'This tool or transport has not been verified for protected sessions and is disabled.');
  }
  /** Provider edits invalidate human approval CAS as well as active sends.
   * Dispatch independently rechecks bindings, even without a notification. */
  connectionsChanged(connectionId:string){this.assertOpen();const next=copy(this.state);next.revision++;this.save(next,{kind:'connection',connectionId})}
  subscribe(listener:(change:PolicyChange)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  close(){if(this.closed)return;this.closed=true;for(const listener of this.listeners)try{listener({kind:'closed'})}catch{}this.listeners.clear()}
}
