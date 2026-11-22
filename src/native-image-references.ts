import {createHash} from 'node:crypto';
import {z} from 'zod';
import {lookupNativeArtifact,type NativeArtifactContext} from './native-artifact-context';
import {resourceBinding,type ResourceLease} from './resource-policy';
import type {NativeSecurityRuntime} from './native-security-runtime';
import type {ImageReferenceInput} from './image-generation';

export const imageReferenceVersionIdsSchema=z.array(z.string().uuid()).min(1).max(4).refine(ids=>new Set(ids).size===ids.length,'Reference image version IDs must be unique.');
export type NativeImageReferenceHost=Readonly<{frameId:string;rootFrameId:string;projectId:string}>;
export type ImageReferenceReceipt=Readonly<{artifact_id:string;version_id:string;checksum:string}>;
export type ResolvedImageReferences=Readonly<{
 images:readonly ImageReferenceInput[];
 references:readonly ImageReferenceReceipt[];
 assertCurrent:()=>Promise<void>;
 /** Synchronous guard for the transport's final pre-fetch boundary. */
 assertDispatchCurrent?:()=>void;
}>;
export type ImageReferenceResolver=(host:NativeImageReferenceHost,input:{versionIds:readonly string[];signal?:AbortSignal})=>Promise<ResolvedImageReferences>;
type SecurityRuntime=Pick<NativeSecurityRuntime,'scopeForFrame'|'resources'|'resourceViews'>;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const MAX_BYTES=8*1024*1024;
const allowedMime=(mime:string):mime is ImageReferenceInput['mimeType']=>['image/png','image/jpeg','image/webp'].includes(mime);
const unavailable=()=>new Error('The reference image is unavailable or has no verified standard permission in this research chat.');

/** Reference inputs are exact native versions. A model cannot grant access by
 * supplying a path, URL, owner tag or an apparent standard classification. */
export function createNativeImageReferenceResolver(profileDir:string,getRuntime:()=>SecurityRuntime):ImageReferenceResolver{
 return async(host,input)=>{
  const versionIds=imageReferenceVersionIdsSchema.parse(input.versionIds),signal=input.signal??new AbortController().signal;
  signal.throwIfAborted();
  const runtime=getRuntime(),scope=runtime.scopeForFrame(host.frameId);
  const assertScope=()=>{
   signal.throwIfAborted();
   if(getRuntime()!==runtime)throw unavailable();
   const current=runtime.scopeForFrame(host.frameId);
   if(scope.mode!=='standard'||current.mode!=='standard'||current.executionBinding!==scope.executionBinding||
    ['frameId','rootFrameId','projectId','ownerId','organizationId','revision'].some(key=>(current as any)[key]!==(scope as any)[key])||
    current.frameId!==host.frameId||current.rootFrameId!==host.rootFrameId||current.projectId!==host.projectId)throw unavailable();
  };
  assertScope();
  const exact=(versionId:string)=>{
   const resource=lookupNativeArtifact(profileDir,{versionId});
   if(!resource||resource.versionId!==versionId||resource.ownerId!==scope.ownerId||resource.organizationId!==scope.organizationId||resource.projectId!==scope.projectId||!resource.isUserUpload&&resource.rootFrameId!==scope.rootFrameId||
    resource.sourceFrames.length<1||resource.sourceFrames.some(frame=>frame.ownerId!==scope.ownerId||frame.organizationId!==scope.organizationId||frame.projectId!==scope.projectId||!resource.isUserUpload&&(frame.rootFrameId??frame.frameId)!==scope.rootFrameId)||
    !allowedMime(resource.contentType.trim().toLowerCase())||resource.sizeBytes<1||resource.sizeBytes>MAX_BYTES)throw unavailable();
   return resource;
  };
  const checkDecision=async(resource:NativeArtifactContext)=>{
   const decision=await runtime.resources.renderDecision({versionId:resource.versionId,consumerFrameId:scope.frameId});
   assertScope();
   if(decision.decision!=='standard'||!decision.resource||decision.resource.dataClass!=='standard'||decision.resource.versionId!==resource.versionId||decision.resource.artifactId!==resource.artifactId||decision.resource.checksum!==resource.checksum||decision.resource.consumerRootFrameId!==scope.rootFrameId||decision.resource.consumerPolicyRevision!==scope.revision)throw unavailable();
   const roots=decision.resource.sourceRootFrameIds;
   if(resource.isUserUpload){
    // Native uploads live under the project's shared UPLOADS root. The save
    // broker records the authenticated composer root separately; that durable
    // classification must bind this exact upload to the current consumer.
    const nativeRoots=new Set(resource.sourceFrames.map(frame=>frame.rootFrameId??frame.frameId));
    if(!roots.includes(scope.rootFrameId)||roots.some(root=>root!==scope.rootFrameId&&!nativeRoots.has(root)))throw unavailable();
   }else if(roots.length!==1||roots[0]!==scope.rootFrameId)throw unavailable();
  };
  const records:Array<{resource:NativeArtifactContext;binding:string;lease:ResourceLease;image:ImageReferenceInput}>=[];
  for(const versionId of versionIds){
   assertScope();const resource=exact(versionId);await checkDecision(resource);
   const lease=await runtime.resources.authorize({versionId},scope.frameId,'raw-bytes');
   if(lease.dataClass!=='standard')throw unavailable();
   const image=await runtime.resourceViews.image({versionId,consumerFrameId:scope.frameId},signal);
   assertScope();
   if(!allowedMime(image.contentType)||image.contentType!==resource.contentType.trim().toLowerCase()||image.bytes.length!==resource.sizeBytes||hash(image.bytes)!==resource.checksum)throw unavailable();
   records.push({resource,binding:resourceBinding(resource),lease,image:{bytes:Buffer.from(image.bytes),mimeType:image.contentType}});
  }
  let checkedRevision=-1;
  const assertCurrent=async()=>{
   assertScope();const revision=runtime.resources.snapshot().revision;
   for(const record of records){
    const current=exact(record.resource.versionId);
    if(resourceBinding(current)!==record.binding||hash(record.image.bytes)!==current.checksum)throw unavailable();
    await checkDecision(current);await runtime.resources.assertCurrent(record.lease);
    // The lease binds metadata. Re-reading through the native reader also
    // catches deleted, replaced or modified files after the initial read.
    const image=await runtime.resourceViews.image({versionId:current.versionId,consumerFrameId:scope.frameId},signal);
    if(image.contentType!==record.image.mimeType||image.bytes.length!==current.sizeBytes||hash(image.bytes)!==current.checksum)throw unavailable();
    assertScope();
   }
   if(runtime.resources.snapshot().revision!==revision)throw unavailable();
   checkedRevision=revision;
  };
  const assertDispatchCurrent=()=>{
   assertScope();
   if(runtime.resources.snapshot().revision!==checkedRevision)throw unavailable();
   for(const record of records)if(resourceBinding(exact(record.resource.versionId))!==record.binding||hash(record.image.bytes)!==record.resource.checksum)throw unavailable();
  };
  await assertCurrent();
  return Object.freeze({images:Object.freeze(records.map(record=>record.image)),references:Object.freeze(records.map(({resource})=>Object.freeze({artifact_id:resource.artifactId,version_id:resource.versionId,checksum:resource.checksum}))),assertCurrent,assertDispatchCurrent});
 };
}
