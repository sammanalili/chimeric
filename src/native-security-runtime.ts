import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {lookupFrame} from './native-frame-context';
import {lookupNativeArtifact} from './native-artifact-context';
import {NativeKernelEnforcement} from './native-kernel-enforcement';
import {ProtectedStorage,type ProtectedStorageScope} from './protected-storage';
import {ResourcePolicyStore,type ResourceContext} from './resource-policy';
import {NativeResourceService} from './native-resource-service';
import {ResourceViews,type ResourceViewReader} from './resource-views';
import {NativeResourceReader} from './native-resource-reader';
import {CLASS2_OFFLINE_OVERRIDES,type NativeBuildEvidence} from './native-execution-attestation';
import type {ConfidentialityManager} from './confidentiality-manager';
import type {SessionContext} from './session-policy';
import type {NativeKernelScope} from '../tools/native-kernel-policy';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

type ExecutionAttestation={
 evidence:()=>NativeBuildEvidence;
 assertNoUnconfinedHistory:(scope:NativeKernelScope,rootCreatedAt:number|undefined)=>void;
 noteExecution:(kind:string,scope:NativeKernelScope,rootCreatedAt:number|undefined,overrides?:Readonly<Record<string,unknown>>)=>void;
 allowProtectedKernel:(scope:NativeKernelScope,environment:string,Constructor:unknown,overrides?:Readonly<Record<string,unknown>>)=>boolean;
};

/** Installs the daemon half of the checked native hooks. Protected compute is
 * enabled only when a sealed package attestation is supplied. Source builds
 * and unverified packages keep the same fail-closed behavior. */
export class NativeSecurityRuntime {
 readonly kernels:NativeKernelEnforcement;
 readonly storage:ProtectedStorage;
 readonly resources:ResourcePolicyStore;
 readonly resourceService:NativeResourceService;
 readonly resourceViews:ResourceViews;
 private closed=false;
 constructor(private options:{
  profileDir:string;
  authDir:string;
  assetsRoot:string;
  owner:{userId:string;organizationId:string};
  confidentiality:ConfidentialityManager;
  lookupFrame?:typeof lookupFrame;
  lookupArtifact?:typeof lookupNativeArtifact;
  readResource?:ResourceViewReader;
  onResourcePolicyChange?:(revision:number)=>void;
  executionAttestation?:ExecutionAttestation;
 }){
  this.kernels=new NativeKernelEnforcement({
   resolveScope:frameId=>this.scopeForFrame(frameId),
   assertScope:scope=>this.assertScope(scope),
   assertNoUnconfinedHistory:options.executionAttestation
    ?scope=>options.executionAttestation!.assertNoUnconfinedHistory(scope,this.rootCreatedAt(scope.frameId))
    :undefined,
   allowProtectedKernel:options.executionAttestation
    ?(scope,environment,Constructor)=>{this.assertProtectedHistory(scope);return options.executionAttestation!.allowProtectedKernel(scope,environment,Constructor,CLASS2_OFFLINE_OVERRIDES)}
    :undefined,
  });
  this.storage=new ProtectedStorage(options.profileDir,{
   authDir:options.authDir,
   safeReadRoots:[options.assetsRoot,join(options.profileDir,'conda')],
   scopeForFrame:frameId=>this.protectedScope(frameId),
   assertCurrent:scope=>this.assertScope(scope),
  });
  const protectionEnabled=()=>options.confidentiality.policy.snapshot().sessions.some(session=>session.mode==='class2');
  this.resources=new ResourcePolicyStore(options.profileDir,{
   owner:options.owner,
   resolveVersion:lookup=>(options.lookupArtifact??lookupNativeArtifact)(options.profileDir,lookup),
   resolveContext:frameId=>this.resourceContext(frameId),
   legacyRule:'ordinary-while-disabled',
   protectionEnabled,
   onChange:options.onResourcePolicyChange,
  });
  this.resourceService=new NativeResourceService(this.resources,{
   currentFrame:()=>options.confidentiality.scope.currentFrame(),
   protectionEnabled,
   ownerUserId:options.owner.userId,
   withProtectedWrite:(frameId,kind,operation)=>this.storage.withResourceWrite(frameId,kind,operation),
   // Ordinary artifacts are already authenticated and policy-checked by
   // ResourcePolicyStore. Only Class 2 lineage is stored under the private
   // reserve and therefore needs a protected-storage read lease.
   withProtectedRead:(resource,evidence,operation)=>evidence.storageRootFrameIds.length
    ?Promise.resolve(this.storage.withResourceRead(resource,evidence.storageRootFrameIds,operation))
    :operation(),
  });
  const reader=new NativeResourceReader(options.profileDir,{
   protectedRoot:this.storage.reserve,
   authorizeProtected:(resource,path)=>{
    const frameId=resource.producingFrameId??resource.creatingFrameId??resource.rootFrameId;
    if(!frameId)throw new Error('A protected resource has no verified research frame.');
    this.storage.assertHostPath(frameId,path,'read');
   },
  });
  this.resourceViews=new ResourceViews(this.resources,options.readResource??reader.read.bind(reader));
 }
 private assertOpen(){if(this.closed)throw new Error('The native security boundary is closed.')}
 private identity(frameId:string){
  this.assertOpen();const value=(this.options.lookupFrame??lookupFrame)(this.options.profileDir,frameId);
  if(!value||value.ownerId!==this.options.owner.userId||value.organizationId!==this.options.owner.organizationId)throw new Error('The native research scope could not be verified.');
  return value;
 }
 private rootCreatedAt(frameId:string){return this.identity(frameId).rootCreatedAt}
 private assertProtectedHistory(scope:NativeKernelScope){
  if(scope.mode!=='class2')return;
  if(!this.options.executionAttestation)throw new Error('Protected execution evidence is unavailable.');
  this.options.executionAttestation.assertNoUnconfinedHistory(scope,this.rootCreatedAt(scope.frameId));
 }
 scopeForFrame(frameId:string):NativeKernelScope{
  const frame=this.identity(frameId),rootFrameId=frame.rootFrameId??frame.frameId,state=this.options.confidentiality.policy.snapshot();
  const policy=state.sessions.find(session=>session.rootFrameId===rootFrameId);
  if(policy&&[policy.projectId,policy.ownerId,policy.organizationId].some((value,index)=>value!==[frame.projectId,frame.ownerId,frame.organizationId][index]))throw new Error('The native research policy belongs to another scope.');
  const mode=policy?.mode??'standard',revision=policy?.revision??0;
  const base={frameId:frame.frameId,rootFrameId,projectId:frame.projectId,ownerId:frame.ownerId,organizationId:frame.organizationId,mode,revision} as const;
  return Object.freeze({...base,executionBinding:hash([base.organizationId,base.ownerId,base.projectId,base.rootFrameId,base.frameId,base.mode,base.revision])});
 }
 private scopeForContext(context:SessionContext){
  const scope=this.scopeForFrame(context.frameId);
  if(scope.rootFrameId!==context.rootFrameId||scope.projectId!==context.projectId||scope.ownerId!==context.ownerId||scope.organizationId!==context.organizationId)throw new Error('The native research context changed.');
  return scope;
 }
 private protectedScope(frameId:string):ProtectedStorageScope|undefined{
  try{const scope=this.scopeForFrame(frameId);if(scope.mode!=='class2')return undefined;this.assertProtectedHistory(scope);return scope}
  catch(error){if(this.options.confidentiality.policy.snapshot().sessions.some(session=>session.mode==='class2'))throw error;return undefined}
 }
 private assertScope(scope:NativeKernelScope|ProtectedStorageScope){
  const current=this.scopeForFrame(scope.frameId);
  if(JSON.stringify(current)!==JSON.stringify(scope))throw new Error('The native research scope changed.');
 }
 private async resourceContext(frameId:string):Promise<ResourceContext>{
  const context=await this.options.confidentiality.ownedContext(frameId),policy=this.options.confidentiality.policy.policy(context);
  return Object.freeze({...context,mode:policy.mode,revision:policy.revision});
 }
 async transition(context:SessionContext,target:'standard'|'class2',apply:()=>void|Promise<void>){await this.kernels.transition(this.scopeForContext(context),target,apply);if(target==='class2')await this.resources.captureFrame(context.frameId)}
 noteExecution(kind:string,context:SessionContext){
  const scope=this.scopeForContext(context);
  this.options.executionAttestation?.noteExecution(kind,scope,this.rootCreatedAt(context.frameId),scope.mode==='class2'?CLASS2_OFFLINE_OVERRIDES:undefined);
  this.kernels.noteNativeExecution(kind,scope);
 }
 assertHostContext(owner:unknown){this.kernels.kernels.assertHostContext(owner)}
 beginModel(context:SessionContext){const scope=this.scopeForContext(context);this.assertProtectedHistory(scope);return this.kernels.beginModel(scope)}
 callbacks(){return {...this.kernels.callbacks(),...this.storage.callbacks(),resourcePolicy:this.resourceService.callbacks()}}
 close(){if(this.closed)return;this.resourceService.close();this.resources.close();this.kernels.close();this.closed=true}
}
