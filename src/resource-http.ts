import {readFileSync} from 'node:fs';
import {z} from 'zod';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/);
const checksum=z.string().regex(/^[a-f0-9]{64}$/);
export function isInertRasterData(value:string){
 const match=/^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);if(!match)return false;
 const bytes=Buffer.from(match[2],'base64');if(!bytes.length||bytes.length>3*1024*1024||bytes.toString('base64')!==match[2])return false;
 return match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
  match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:
  match[1]==='gif'?['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')):
  bytes.subarray(0,4).toString('ascii')==='RIFF'&&bytes.subarray(8,12).toString('ascii')==='WEBP';
}
const query=z.object({artifactId:id.optional(),versionId:id.optional(),consumerFrameId:id.optional()}).strict().refine(value=>(value.artifactId===undefined)!==(value.versionId===undefined));
const unboundQuery=z.object({consumerFrameId:id.optional()}).strict();
export type ResourceViewInput=z.infer<typeof query>;
const base=z.object({artifactId:id,versionId:id,checksum,sourceRootFrameId:id,consumerRootFrameId:id.optional(),policyRevision:z.number().int().nonnegative()});
const view=z.discriminatedUnion('decision',[
 base.extend({decision:z.literal('standard')}),
 base.extend({decision:z.literal('inert-text'),text:z.string().max(262144)}),
 base.extend({decision:z.literal('inert-image'),imageData:z.string().max(4194304).refine(isInertRasterData)}),
 z.object({decision:z.literal('blocked'),reason:z.string().max(1024).optional()}),
]);
export type ResourceView=z.infer<typeof view>;
const unboundView=z.discriminatedUnion('decision',[
 z.object({decision:z.literal('standard-unbound'),policyRevision:z.number().int().nonnegative(),consumerRootFrameId:id.optional()}),
 z.object({decision:z.literal('blocked'),reason:z.string().max(1024).optional()}),
]);
export type UnboundResourceView=z.infer<typeof unboundView>;
export interface ResourceViewBackend {
 /** IDs are lookup keys. The backend verifies source and consumer ownership,
  * classification, exact bytes and current policy before returning a view.
  * This DTO is never a permit for a later read, renderer, connector or MCP. */
 view(input:ResourceViewInput,signal:AbortSignal):Promise<unknown>;
 /** Compatibility decision only. It cannot read or identify a resource. */
 unbound(input:z.infer<typeof unboundQuery>,signal:AbortSignal):Promise<unknown>;
}
const blocked:ResourceView={decision:'blocked',reason:'This file has no verified preview permission for the current research chat.'};

/** Install behind native authentication. No approval mutation, arbitrary path,
 * URL, remote image or renderable HTML can enter through this endpoint. */
export function installResourceHttp(app:any,backend:ResourceViewBackend,options:{ownerUserId:string;moduleVersion:string}){
 const owner=(request:any,reply:any)=>{
  reply.header('cache-control','no-store, private').header('x-content-type-options','nosniff').header('vary','Cookie');
  if(!options.ownerUserId||app.getUser?.(request)?.user_id!==options.ownerUserId){reply.code(403).send({detail:'The native workspace owner could not be verified.'});return false}
  return true;
 };
 app.get('/api/local/resources/policy',async(request:any,reply:any)=>{
  if(!owner(request,reply))return;
  const parsed=query.safeParse(request.query);
  if(!parsed.success)return reply.code(400).send({detail:'Choose exactly one file or version, and an optional consuming chat.'});
  const controller=new AbortController(),aborted=()=>controller.abort(),closed=()=>{if(!reply.raw?.writableEnded)controller.abort()};
  request.raw?.once?.('aborted',aborted);reply.raw?.once?.('close',closed);
  if(request.raw?.aborted||reply.raw?.destroyed&&!reply.raw?.writableEnded)controller.abort();
  try{
   controller.signal.throwIfAborted();
   const result=view.safeParse(await backend.view(parsed.data,controller.signal));
   controller.signal.throwIfAborted();
   if(!result.success)return reply.code(503).send(blocked);
   const value=result.data;
   if(value.decision!=='blocked'&&(parsed.data.versionId&&parsed.data.versionId!==value.versionId||parsed.data.artifactId&&parsed.data.artifactId!==value.artifactId||parsed.data.consumerFrameId&&!value.consumerRootFrameId))return reply.code(503).send(blocked);
   // Explicit projection excludes storage paths, native scopes, tokens, read
   // leases and backend diagnostics from the browser response.
   return reply.send(value);
  }catch{return reply.code(controller.signal.aborted?409:503).send(blocked)}
  finally{request.raw?.removeListener?.('aborted',aborted);reply.raw?.removeListener?.('close',closed)}
 });
 app.get('/api/local/resources/unbound',async(request:any,reply:any)=>{
  if(!owner(request,reply))return;
  const parsed=unboundQuery.safeParse(request.query);if(!parsed.success)return reply.code(400).send({detail:'Choose only an optional consuming chat.'});
  const controller=new AbortController(),aborted=()=>controller.abort(),closed=()=>{if(!reply.raw?.writableEnded)controller.abort()};request.raw?.once?.('aborted',aborted);reply.raw?.once?.('close',closed);
  if(request.raw?.aborted||reply.raw?.destroyed&&!reply.raw?.writableEnded)controller.abort();
  try{controller.signal.throwIfAborted();const result=unboundView.safeParse(await backend.unbound(parsed.data,controller.signal));controller.signal.throwIfAborted();if(!result.success)return reply.code(503).send(blocked);const value=result.data;if(value.decision==='standard-unbound'&&parsed.data.consumerFrameId&&!value.consumerRootFrameId)return reply.code(503).send(blocked);return reply.send(value)}
  catch{return reply.code(controller.signal.aborted?409:503).send(blocked)}finally{request.raw?.removeListener?.('aborted',aborted);reply.raw?.removeListener?.('close',closed)}
 });
 app.get('/api/local/resources/component.js',async(request:any,reply:any)=>{
  if(!owner(request,reply))return;
  return reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(readFileSync(new URL('./protected-resource-view.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',options.moduleVersion));
 });
}
