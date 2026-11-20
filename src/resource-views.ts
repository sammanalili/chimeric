import {createHash} from 'node:crypto';
import type {NativeArtifactContext} from './native-artifact-context';
import {ResourcePolicyStore} from './resource-policy';
import type {ResourceView,ResourceViewBackend,ResourceViewInput,UnboundResourceView} from './resource-http';
import {isInertRasterData} from './resource-http';

const blocked=(reason='This file has no verified preview permission for the current research chat.'):ResourceView=>({decision:'blocked',reason});
const raster=/^image\/(?:png|jpeg|gif|webp)$/i;
const text=/^(?:text\/|application\/(?:json|[^;]+\+json|xml|[^;]+\+xml|javascript)(?:;|$)|image\/svg\+xml(?:;|$))/i;
export type ResourceViewReader=(resource:NativeArtifactContext,options:{maxBytes:number;signal:AbortSignal})=>Promise<Uint8Array>;

/** The policy decision controls mounting. Reading is independently authorized
 * against the exact version. The supplied native reader must cap bytes while
 * reading, never use a remote URL or an external converter, and never follow an
 * unverified storage alias. Returned text is displayed as text, including HTML.
 */
export class ResourceViews implements ResourceViewBackend {
 constructor(private policy:ResourcePolicyStore,private readExact:ResourceViewReader){}
 async unbound(input:{consumerFrameId?:string},signal:AbortSignal):Promise<UnboundResourceView>{signal.throwIfAborted();const decision=await this.policy.unboundStandardDecision(input.consumerFrameId);signal.throwIfAborted();return decision.decision==='standard-unbound'?{decision:'standard-unbound',policyRevision:decision.revision,...decision.consumerRootFrameId?{consumerRootFrameId:decision.consumerRootFrameId}:{}}:blocked(decision.reason)}
 async view(input:ResourceViewInput,signal:AbortSignal):Promise<ResourceView>{
  signal.throwIfAborted();const lookup=input.versionId?{versionId:input.versionId}:{artifactId:input.artifactId!};
  const decision=await this.policy.renderDecision({...lookup,consumerFrameId:input.consumerFrameId});signal.throwIfAborted();
  const resource=decision.resource;
  if(decision.decision==='blocked'||!resource||resource.sourceRootFrameIds.length!==1||input.consumerFrameId&&!resource.consumerRootFrameId)return blocked();
  const base={artifactId:resource.artifactId,versionId:resource.versionId,checksum:resource.checksum,sourceRootFrameId:resource.sourceRootFrameIds[0],consumerRootFrameId:resource.consumerRootFrameId,policyRevision:decision.revision};
  if(decision.decision==='standard')return {...base,decision:'standard'};
  // Each inert read is a new checked lease. The advisory response is never
  // accepted as authorization, and artifact IDs never select a newer version
  // between the decision and the read.
  const metadata=await this.policy.authorize({versionId:resource.versionId},input.consumerFrameId,'metadata');
  const info=await this.policy.materialize(metadata,exact=>exact),mime=info.contentType.split(';',1)[0].trim().toLowerCase(),isRaster=raster.test(mime),limit=isRaster?3*1024*1024:262144;
  if(info.checksum!==resource.checksum||info.sizeBytes>limit||!isRaster&&!text.test(info.contentType))return blocked('This file needs a verified inert preview. Active documents and converters are disabled in protected chats.');
  const lease=await this.policy.authorize({versionId:resource.versionId},input.consumerFrameId,isRaster?'inert-image':'inert-text');
  if(lease.artifactId!==resource.artifactId||lease.versionId!==resource.versionId)return blocked();
  return await this.policy.materialize(lease,async exact=>{
   signal.throwIfAborted();
   if(exact.checksum!==info.checksum||exact.contentType!==info.contentType||exact.sizeBytes!==info.sizeBytes)return blocked();
   const bytes=Buffer.from(await this.readExact(exact,{maxBytes:limit,signal}));signal.throwIfAborted();
   if(bytes.length!==exact.sizeBytes||bytes.length>limit||createHash('sha256').update(bytes).digest('hex')!==exact.checksum)return blocked('The file changed before its preview was ready. Reload it before continuing.');
   const current=await this.policy.renderDecision({versionId:exact.versionId,consumerFrameId:input.consumerFrameId});signal.throwIfAborted();
   if(current.binding!==decision.binding||current.decision!==decision.decision)return blocked();
   if(isRaster){const imageData='data:'+mime+';base64,'+bytes.toString('base64');return isInertRasterData(imageData)?{...base,decision:'inert-image',imageData}:blocked('This file does not match its declared raster image type.')}
   try{return {...base,decision:'inert-text',text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)}}catch{return blocked('This file is not UTF-8 text and needs a verified local converter.')}
  });
 }
}
