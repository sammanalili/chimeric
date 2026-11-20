import {AsyncLocalStorage} from 'node:async_hooks';
import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {SessionPolicyError,type ModelRole,type SessionContext,type SessionPolicyStore} from './session-policy';

const HEADER='x-chimeric-session-scope',FIELD='__chimeric_scope';
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
type Scope={frameId:string;role:ModelRole}|{requestId:string;role:'main'};
export type VerifiedNativeScope={context:SessionContext;role:ModelRole}|{standardRequest:true;role:'main';replayNamespace:string};
/** Private, process-lifetime authority. Neither the key nor a signing endpoint
 * is exposed to the browser or to research subprocesses. Metadata is signed
 * only at checked native construction sites, and is never itself authority. */
export class NativeSessionScope {
 private storage=new AsyncLocalStorage<Scope>();private key=randomBytes(32);private standardRequests=new Set<string>();
 constructor(private policy:SessionPolicyStore,private options:{assertOwner?:(context:SessionContext)=>void;now?:()=>number;ttlMs?:number}={}){}
 private now(){return this.options.now?.()??Date.now()}
 private scope(frameId:unknown,role:ModelRole='main'):{frameId:string;role:ModelRole}|undefined{return typeof frameId==='string'&&identifier.test(frameId)?{frameId,role}:undefined}
 private role(input:any):ModelRole{
  const label=String(input?.callSite??input?.lane??input?.agentName??'').toLowerCase();
  return /review/.test(label)?'reviewer':/compact|fold/.test(label)?'compaction':/memory/.test(label)?'memory':/lineage/.test(label)?'lineage':'main';
 }
 private sign(scope:Scope){const body=Buffer.from(JSON.stringify({...scope,issuedAt:this.now()})).toString('base64url');return body+'.'+createHmac('sha256',this.key).update(body).digest('base64url')}
 private decode(raw:unknown,allowExpired=false):Scope{
  const fail=()=>new SessionPolicyError('untrusted_context','The model request has no current verified native session scope.');
  if(typeof raw!=='string'||raw.length>2048)throw fail();const parts=raw.split('.');if(parts.length!==2)throw fail();
  const expected=createHmac('sha256',this.key).update(parts[0]).digest(),actual=Buffer.from(parts[1],'base64url');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw fail();
  let data:any;try{data=JSON.parse(Buffer.from(parts[0],'base64url').toString())}catch{throw fail()}
  if(!data||!Number.isSafeInteger(data.issuedAt)||data.issuedAt>this.now()+1000||!allowExpired&&this.now()-data.issuedAt>(this.options.ttlMs??120_000))throw fail();
  if(Object.keys(data).sort().join(',')==='issuedAt,requestId,role'&&typeof data.requestId==='string'&&this.standardRequests.has(data.requestId)&&data.role==='main')return {requestId:data.requestId,role:'main'};
  if(Object.keys(data).sort().join(',')!=='frameId,issuedAt,role'||!this.scope(data.frameId)||!['main','reviewer','small','medium','large','memory','classifier','compaction','lineage'].includes(data.role))throw fail();
  return {frameId:data.frameId,role:data.role};
 }
 async withFrame<T>(frameId:string,callback:()=>T):Promise<Awaited<T>>{
  let context:SessionContext;
  try{context=await this.policy.contextForFrame(frameId)}catch(error){
   // A newly allocated native frame is not durable until the native job writes
   // it. Keep that first job explicitly standard instead of leaving it
   // unscoped. Once any protected session exists, a missing frame fails closed
   // because the store cannot prove that it is unrelated to protected data.
   if(!(error instanceof SessionPolicyError)||error.code!=='frame_unavailable'||this.policy.snapshot().sessions.some(session=>session.mode==='class2'))throw error;
   return await this.withNewStandardRequest(callback);
  }
  this.options.assertOwner?.(context);
  return await this.storage.run({frameId:context.frameId,role:'main'},callback);
 }
 currentFrame(){const scope=this.storage.getStore();return scope&&'frameId' in scope?scope.frameId:undefined}
 /** Native authenticated /api/request only, after checking that neither native
  * frame field is supplied. This authority expires when that handler returns. */
 async withNewStandardRequest<T>(callback:()=>T):Promise<Awaited<T>>{
  const requestId=randomBytes(24).toString('hex');this.standardRequests.add(requestId);
  try{return await this.storage.run({requestId,role:'main'},callback)}finally{this.standardRequests.delete(requestId)}
 }
 /** Synchronous because the native SDK consumes request options immediately. */
 requestOptions(input:any,_settings:any,result:any){
  const scope=this.scope(input?.frameId,this.role(input))??this.storage.getStore();
  const headers=new Headers(result?.headers??{});headers.delete(HEADER);
  if(scope)headers.set(HEADER,this.sign(scope));
  return {...result,headers:Object.fromEntries(headers.entries())};
 }
 nativeMetadata(input:any,result:any){
  if(!result||typeof result!=='object'||Array.isArray(result))throw new SessionPolicyError('metadata_changed','The native metadata boundary changed.');
  const {[FIELD]:_discard,...metadata}=result,scope=this.scope(input?.frameId,this.role(input))??this.storage.getStore()??this.scope(input?.sessionId,this.role(input));
  return scope?{...metadata,[FIELD]:this.sign(scope)}:metadata;
 }
 /** Raw SDK callers bypass requestOptions; their factories receive this same
  * wrapper. It adds an ALS scope only for the exact local bridge origin. */
 scopeFetch(fetcher:typeof fetch,bridgeOrigin:string):typeof fetch{
  return (async(input:any,init:any)=>{
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
   if(url.origin===bridgeOrigin){let scope=this.storage.getStore();
    if(!headers.has(HEADER)&&typeof init?.body==='string'&&init.body.includes(FIELD)){
     let embedded:unknown;try{embedded=JSON.parse(init.body)?.metadata?.[FIELD]}catch{}
     if(embedded!==undefined)scope=this.decode(embedded,true);
    }
    // A cached native metadata object can outlive a turn. Only this checked
    // process-local fetch hook renews it; the bridge still verifies its owner.
    if(scope&&!headers.has(HEADER))headers.set(HEADER,this.sign(scope));
   }
   else throw new SessionPolicyError('scope_destination','A native SDK request cannot leave the local model bridge.');
   return await fetcher(input,{...init,headers});
  }) as typeof fetch;
 }
 /** Called before credential resolution, document conversion or model traffic.
  * Remove the local proof, even when the provider accepts arbitrary metadata. */
 async verify(request:Request,body:any):Promise<VerifiedNativeScope|undefined>{
  const header=request.headers.get(HEADER),metadata=body?.metadata,embedded=metadata?.[FIELD];
  if(metadata&&typeof metadata==='object')delete metadata[FIELD];
  if(!header&&!embedded)return;
  const a=header?this.decode(header):undefined,b=embedded?this.decode(embedded,!!a):undefined;
  // Native agent metadata uses lane:"agent" for both main and REVIEWER.
  // The checked request-options callSite supplies the more specific role.
  if(a&&b&&('frameId' in a&&'frameId' in b?a.frameId!==b.frameId:'requestId' in a&&'requestId' in b?a.requestId!==b.requestId:true))throw new SessionPolicyError('scope_mismatch','Native request and metadata scopes disagree.');
  const scope=a??b!;if('requestId' in scope)return {standardRequest:true,role:'main',replayNamespace:createHmac('sha256',this.key).update('standard:'+scope.requestId).digest('hex')};
  const context=await this.policy.contextForFrame(scope.frameId);this.options.assertOwner?.(context);
  return {context,role:scope.role};
 }
 close(){this.key.fill(0);this.standardRequests.clear();this.storage.disable()}
}
