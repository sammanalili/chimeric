import {AsyncLocalStorage} from 'node:async_hooks';
import {ResourcePolicyError,ResourcePolicyStore,type ResourceContext,type ResourceMaterialization,type ResourcePurpose} from './resource-policy';
import type {NativeArtifactContext} from './native-artifact-context';
import {SessionPolicyError} from './session-policy';
import type {ArtifactLookup} from './native-artifact-context';
import type {NativeResourceCallbacks} from '../tools/native-resource-policy';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const id=(value:unknown):value is string=>typeof value==='string'&&ID.test(value);
type Scope={context:ResourceContext};
const lookup=(value:any,artifact=false):ArtifactLookup|undefined=>{
 const candidate=artifact?value?.artifact_id??value?.artifactId??value?.id:value?.version_id??value?.versionId??value?.latest_version_id??value?.latestVersion?.id??value?.id??(typeof value==='string'?value:undefined);
 return id(candidate)?artifact?{artifactId:candidate}:{versionId:candidate}:undefined;
};
function versionIds(value:unknown){
 const ids=new Set<string>(),pending=[value],seen=new Set<object>();let visited=0;
 while(pending.length){const item:any=pending.pop();if(!item||typeof item!=='object'||seen.has(item))continue;if(++visited>10_000)throw new ResourcePolicyError('resource_limit','The native save result exceeded its inspection limit.',413);seen.add(item);
  for(const [key,nested] of Object.entries(item)){if(['version_id','versionId'].includes(key)&&id(nested))ids.add(nested);else if(nested&&typeof nested==='object')pending.push(nested)}
 }
 return [...ids];
}
const nativeUserId=(value:any)=>value?.user_id??value?.userId??value?.id;

/** Adapts checked native store hooks to ResourcePolicyStore. Native objects are
 * used only as operation metadata. They never grant ownership or classification.
 * Missing scope is tolerated solely by the explicit feature-off/no-history
 * compatibility rule, so adding the first protected label closes that route.
 */
export class NativeResourceService implements NativeResourceCallbacks {
 private scope=new AsyncLocalStorage<Scope>();private closed=false;
 constructor(private policy:ResourcePolicyStore,private options:{
  currentFrame?:()=>string|undefined;
  protectionEnabled:()=>boolean;
  ownerUserId:string;
  withProtectedWrite?:<T>(frameId:string,kind:'artifact'|'upload',operation:()=>Promise<T>)=>Promise<T>;
  withProtectedRead?:<T>(resource:NativeArtifactContext,evidence:ResourceMaterialization,operation:()=>Promise<T>)=>Promise<T>;
 }){}
 private open(){if(this.closed)throw new ResourcePolicyError('closed','The native resource boundary is closed.',503)}
 private legacyOpen(){const state=this.policy.snapshot();return this.options.protectionEnabled()===false&&!state.protectedHistory&&!state.roots.some(row=>row.dataClass==='class2')&&!state.resources.some(row=>row.dataClass==='class2')}
 private frame(explicit?:unknown){return id(explicit)?explicit:this.scope.getStore()?.context.frameId??this.options.currentFrame?.()}
 private async context(explicit?:unknown){const frame=this.frame(explicit);if(!frame)return;const context=await this.policy.captureFrame(frame);if(context.frameId!==frame||context.ownerId!==this.options.ownerUserId)throw new ResourcePolicyError('scope_changed','The native resource owner changed.',409);return context}
 private exact(operation:{method:string;args:unknown[]}){
  const first:any=operation.args[0];if(operation.method.startsWith('get_artifact_'))return lookup(first,true);
  return lookup(first,false);
 }
 private row(row:any):ArtifactLookup|undefined{return lookup(row,false)??lookup(row?.latest_version,false)??lookup(row?.latestVersion,false)}
 private async read(operation:{method:string;args:unknown[]},purpose:ResourcePurpose,read:()=>Promise<unknown>){
  this.open();const exact=this.exact(operation),consumer=this.frame();
  if(!exact){if(this.legacyOpen())return await read();throw new ResourcePolicyError('unbound_resource','The native resource read has no exact version binding.')}
  const lease=await this.policy.authorize(exact,consumer,purpose);return await this.policy.materialize(lease,(resource,evidence)=>this.options.withProtectedRead?this.options.withProtectedRead(resource,evidence,read):read());
 }
 metadata(_owner:unknown,operation:{method:string;args:unknown[]},read:()=>Promise<unknown>){return this.read(operation,'metadata',read)}
 materialize(_owner:unknown,operation:{method:string;args:unknown[]},read:()=>Promise<unknown>){return this.read(operation,'model-input',read)}
 async filter(_owner:unknown,_operation:{method:string;args:unknown[]},rows:unknown){
  this.open();if(!Array.isArray(rows)){if(this.legacyOpen())return rows;throw new ResourcePolicyError('unbound_resource','The native resource list has no exact version bindings.')}
  const consumer=this.frame(),result=[];for(const row of rows){const exact=this.row(row);if(!exact){if(this.legacyOpen())result.push(row);continue}try{await this.policy.authorize(exact,consumer,'metadata');result.push(row)}catch(error){if(!(error instanceof ResourcePolicyError))throw error}}
  return result;
 }
 private async saved(input:any,write:()=>Promise<unknown>,kind:'artifact'|'upload'){
  this.open();let context:ResourceContext|undefined;
  try{
   // Multipart and chunked uploads inherit the authenticated composer context
   // captured by withUploadRequest. The upload store's root_frame_id is a shared uploads
   // container and must never replace that real producing chat.
   const scoped=kind==='upload'?this.scope.getStore()?.context:undefined;
   context=await this.context(scoped?.frameId??input?.frame_id??input?.frameId??input?.root_frame_id??input?.rootFrameId);
   if(context&&scoped&&[context.frameId,context.rootFrameId,context.projectId,context.ownerId].some((value,index)=>value!==[scoped.frameId,scoped.rootFrameId,scoped.projectId,scoped.ownerId][index]))throw new ResourcePolicyError('scope_changed','The authenticated upload scope changed before storage.',409);
   if(context&&typeof input?.project_id==='string'&&input.project_id!==context.projectId)throw new ResourcePolicyError('scope_changed','The native resource project does not match its authenticated chat.',409);
  }
  catch(error){
   // Bundled examples save their ordinary artifacts before committing the new
   // frame row. Preserve that startup order only while the explicit legacy
   // rule is open. Every other scope failure, and every protected history,
   // still fails before native bytes are written.
   if(!(error instanceof SessionPolicyError&&error.code==='frame_unavailable'&&this.legacyOpen()))throw error;
  }
  if(!context&&!this.legacyOpen())throw new ResourcePolicyError('missing_resource_scope','The native save has no authenticated research chat.');
  const commit=async()=>{
   const value=await write();if(!context)return value;
   const ids=versionIds(value);if(!ids.length)throw new ResourcePolicyError('unclassified_write','The committed native resource did not return an exact version ID.',503);
   const sources=[...(Array.isArray(input?.source_version_ids)?input.source_version_ids:[]),input?.parent_version_id,input?.parentVersionId].filter(id) as string[];
   for(const versionId of ids)await this.policy.recordCreated(context,{versionId},{sourceVersionIds:sources});return value;
  };
  return context&&this.options.withProtectedWrite?await this.options.withProtectedWrite(context.frameId,kind,commit):await commit();
 }
 save(_owner:unknown,input:unknown,write:()=>Promise<unknown>){return this.saved(input,write,'artifact')}
 saveUpload(_owner:unknown,input:unknown,write:()=>Promise<unknown>){return this.saved(input,write,'upload')}
 async withUploadRequest(app:any,request:any,operation:()=>Promise<unknown>){
  this.open();const user=app?.getUser?.(request),userId=nativeUserId(user);if(userId!==this.options.ownerUserId)throw new ResourcePolicyError('not_owner','The native upload owner could not be verified.');
  const explicit=request?.query?.frameId??request?.query?.frame_id??request?.headers?.['x-chimeric-frame-id'];const context=await this.context(explicit);
  if(!context){if(this.legacyOpen())return await operation();throw new ResourcePolicyError('missing_resource_scope','Choose the research chat that owns this upload.')}
  return await this.scope.run({context},operation);
 }
 async withConsumer(_owner:unknown,input:{frameId:string|null;user:unknown},operation:()=>Promise<unknown>){
  this.open();if(nativeUserId(input.user)!==this.options.ownerUserId)throw new ResourcePolicyError('not_owner','The native resource consumer could not be verified.');
  const context=await this.context(input.frameId);if(!context){if(this.legacyOpen())return await operation();throw new ResourcePolicyError('missing_resource_scope','The native resource consumer has no authenticated chat.')}
  return await this.scope.run({context},operation);
 }
 async httpRead(_owner:unknown,input:{user:unknown;metadata:unknown;id:unknown;label:unknown}){
  this.open();if(nativeUserId(input.user)!==this.options.ownerUserId)throw new ResourcePolicyError('not_owner','The native resource reader could not be verified.');
  const exact=lookup(input.metadata,false)??lookup(input.id,false)??lookup(input.id,true);if(!exact){if(this.legacyOpen())return;throw new ResourcePolicyError('unbound_resource','The HTTP resource read has no exact version binding.')}
  await this.policy.authorize(exact,this.frame(),'raw-bytes');
 }
 visible(row:unknown,_rootId:unknown,_referencedArtifacts:unknown){
  this.open();const exact=this.row(row);if(!exact)return this.legacyOpen();
  // This native predicate is synchronous. It can preserve the explicit
  // feature-off compatibility path, but it can never mint an async permit.
  return this.legacyOpen();
 }
 callbacks(){return {metadata:this.metadata.bind(this),materialize:this.materialize.bind(this),filter:this.filter.bind(this),save:this.save.bind(this),saveUpload:this.saveUpload.bind(this),withUploadRequest:this.withUploadRequest.bind(this),withConsumer:this.withConsumer.bind(this),httpRead:this.httpRead.bind(this),visible:this.visible.bind(this)}}
 close(){this.closed=true;this.scope.disable()}
}
