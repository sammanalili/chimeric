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
import type {ConfidentialityManager} from './confidentiality-manager';
import type {SessionContext} from './session-policy';
import type {NativeKernelScope} from '../tools/native-kernel-policy';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Installs the daemon half of the checked native hooks. This class does not
 * make Class 2 available. In particular, it deliberately supplies neither a
 * historical-compute attestation nor a protected-kernel allowlist. */
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
 }){
  this.kernels=new NativeKernelEnforcement({
   resolveScope:frameId=>this.scopeForFrame(frameId),
   assertScope:scope=>this.assertScope(scope),
   // No assertNoUnconfinedHistory and no allowProtectedKernel. A future
   // release must provide real durable evidence before either is added.
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
  try{const scope=this.scopeForFrame(frameId);return scope.mode==='class2'?scope:undefined}
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
 noteExecution(kind:string,context:SessionContext){this.kernels.noteNativeExecution(kind,this.scopeForContext(context))}
 assertHostContext(owner:unknown){this.kernels.kernels.assertHostContext(owner)}
 beginModel(context:SessionContext){return this.kernels.beginModel(this.scopeForContext(context))}
 callbacks(){return {...this.kernels.callbacks(),...this.storage.callbacks(),resourcePolicy:this.resourceService.callbacks()}}
 close(){if(this.closed)return;this.resourceService.close();this.resources.close();this.kernels.close();this.closed=true}
}
