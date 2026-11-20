import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {SessionPolicyError} from './session-policy';
import {OutboundBrokerError,type OutboundReview} from './outbound-broker';

export type Class2Purpose='model'|'stt';
export type Class2ModelChoice={qualifiedId:string;name:string;connectionId:string;eligible:boolean;reason?:string};
export type Class2Review=Pick<OutboundReview,'id'|'digest'|'status'|'createdAt'|'expiresAt'|'rationale'|'privacy'|'destination'|'request'|'disclosures'>;
export type Class2Snapshot={revision:number;frameId:string;rootFrameId:string|null;mode:'standard'|'class2';
 main?:string;reviewer?:string;models:Class2ModelChoice[];ready:boolean;reason?:string;reviews:Class2Review[]};
export type Class2ConnectionSnapshot={revision:number;connectionId:string;name:string;allowedPurposes:Class2Purpose[];
 automaticPurposes?:Class2Purpose[];eligible:boolean;ready?:boolean;reason?:string;
 evidence?:{status:string;retention?:string;zdr?:string;summary?:string}};
export type Class2ModeInput={frameId:string;expectedRevision:number;mode:'standard'|'class2';main?:string;reviewer?:string};
export type Class2ConnectionInput={connectionId:string;expectedRevision:number;purposes:Class2Purpose[]};
export interface Class2Backend{
 /** These methods resolve native ownership/current bindings themselves. Body
  * IDs are lookup keys, never authority or a replacement for caller checks. */
 snapshot(input:{frameId?:string;connectionId?:string}):Class2Snapshot|Class2ConnectionSnapshot|Promise<Class2Snapshot|Class2ConnectionSnapshot>;
 setMode(input:Class2ModeInput):unknown|Promise<unknown>;
 approveConnection(input:Class2ConnectionInput):unknown|Promise<unknown>;
 /** Approve + execute the broker's in-memory one-use permit. Never return it. */
 sendOnce(input:{frameId:string;reviewId:string;digest:string},signal?:AbortSignal):unknown|Promise<unknown>;
 deny(input:{frameId:string;reviewId:string}):unknown|Promise<unknown>;
}
const id=z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const revision=z.number().int().nonnegative();
const qualified=z.string().min(4).max(1024).refine(value=>value.includes('::')&&!/[\u0000-\u001f\u007f]/.test(value));
const frameQuery=z.object({frameId:id}).strict();
const modeInput=z.object({frameId:id,expectedRevision:revision,mode:z.enum(['standard','class2']),main:qualified.optional(),reviewer:qualified.optional()}).strict().superRefine((value,context)=>{
 if(value.mode==='class2'&&!value.main)context.addIssue({code:'custom',message:'Choose an eligible model.'});
 if(value.mode==='standard'&&(value.main!==undefined||value.reviewer!==undefined))context.addIssue({code:'custom',message:'Standard mode does not change protected model roles.'});
});
const connectionParams=z.object({connectionId:id}).strict();
const permissionInput=z.object({expectedRevision:revision,purposes:z.array(z.enum(['model','stt'])).max(2).refine(values=>new Set(values).size===values.length)}).strict();
const reviewParams=z.object({id:z.string().uuid()}).strict();
const sendInput=z.object({frameId:id,digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const denyInput=z.object({frameId:id}).strict();

function projectSnapshot(value:Class2Snapshot|Class2ConnectionSnapshot,input:{frameId?:string;connectionId?:string}){
 if(input.frameId!==undefined){
  const snapshot=value as Class2Snapshot;
  if(snapshot.frameId!==input.frameId)throw new SessionPolicyError('scope_changed','The returned confidentiality scope does not match this research session.',409);
  return {revision:snapshot.revision,frameId:snapshot.frameId,rootFrameId:snapshot.rootFrameId,mode:snapshot.mode,
   main:snapshot.main,reviewer:snapshot.reviewer,ready:snapshot.ready,reason:snapshot.reason,
   models:snapshot.models.map(model=>({qualifiedId:model.qualifiedId,name:model.name,connectionId:model.connectionId,eligible:model.eligible,reason:model.reason})),
   reviews:snapshot.reviews.map(review=>({id:review.id,digest:review.digest,status:review.status,createdAt:review.createdAt,expiresAt:review.expiresAt,
    rationale:review.rationale,privacy:review.privacy,destination:review.destination,request:review.request,disclosures:review.disclosures}))};
 }
 const snapshot=value as Class2ConnectionSnapshot;
 if(snapshot.connectionId!==input.connectionId)throw new SessionPolicyError('connection_changed','The returned permission belongs to a different connection.',409);
 return {revision:snapshot.revision,connectionId:snapshot.connectionId,name:snapshot.name,allowedPurposes:snapshot.allowedPurposes,
  automaticPurposes:snapshot.automaticPurposes,eligible:snapshot.eligible,ready:snapshot.ready,reason:snapshot.reason,
  evidence:snapshot.evidence?{status:snapshot.evidence.status,retention:snapshot.evidence.retention,zdr:snapshot.evidence.zdr,summary:snapshot.evidence.summary}:undefined};
}

/** Install behind native human-session authentication and CSRF enforcement.
 * No route accepts a payload/destination, creates a review, or serializes a send
 * permit. The injected backend is responsible for trusted actor/scope checks. */
export function installClass2Http(app:any,backend:Class2Backend,moduleVersion:string){
 const base='/api/local/confidentiality';
 const snapshot=async(input:{frameId?:string;connectionId?:string})=>projectSnapshot(await backend.snapshot(input),input);
 const handle=(action:(request:any,reply:any)=>unknown)=>async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return await action(request,reply)}catch(error){
   const known=error instanceof SessionPolicyError||error instanceof OutboundBrokerError;
   const status=known?error.status:error instanceof z.ZodError?400:500;
   return reply.code(status).send({code:known?error.code:error instanceof z.ZodError?'invalid_request':'operation_failed',
    detail:known?error.message:error instanceof z.ZodError?'Check the confidentiality settings and reload if the session changed.':'The confidentiality operation could not be completed. Reload its current state before continuing.'});
  }
 };
 app.get(base,handle(request=>snapshot(frameQuery.parse(request.query))));
 app.put(base,handle(async request=>{const input=modeInput.parse(request.body);await backend.setMode(input);return snapshot({frameId:input.frameId})}));
 app.get(base+'/connections/:connectionId',handle(request=>snapshot(connectionParams.parse(request.params))));
 app.put(base+'/connections/:connectionId',handle(async request=>{
  const {connectionId}=connectionParams.parse(request.params),input=permissionInput.parse(request.body);
  await backend.approveConnection({connectionId,...input});return snapshot({connectionId});
 }));
 app.post(base+'/reviews/:id/send',handle(async(request,reply)=>{
  const {id:reviewId}=reviewParams.parse(request.params),input=sendInput.parse(request.body);
  const controller=new AbortController(),aborted=()=>controller.abort(),closed=()=>{if(!reply.raw?.writableEnded)controller.abort()};
  request.raw?.once?.('aborted',aborted);reply.raw?.once?.('close',closed);
  if(request.raw?.aborted||reply.raw?.destroyed&&!reply.raw?.writableEnded)controller.abort();
  try{await backend.sendOnce({...input,reviewId},controller.signal);return await snapshot({frameId:input.frameId})}
  finally{request.raw?.removeListener?.('aborted',aborted);reply.raw?.removeListener?.('close',closed)}
 }));
 app.post(base+'/reviews/:id/deny',handle(async request=>{const {id:reviewId}=reviewParams.parse(request.params),input=denyInput.parse(request.body);await backend.deny({...input,reviewId});return snapshot({frameId:input.frameId})}));
 app.get(base+'/component.js',handle((_request,reply)=>reply.type('text/javascript; charset=utf-8').send(readFileSync(new URL('./class2-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion))));
}
