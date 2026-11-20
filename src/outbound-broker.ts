import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {SessionPolicyStore,SessionPolicyError,connectionBindingDigest,normalizeConnectionBinding,policyDigest,writePolicyJson,type ConnectionBinding,type PolicyChange,type SessionContext} from './session-policy';

type Json=null|boolean|number|string|Json[]|{[key:string]:Json};
export type OutboundPayload={kind:'none'}|{kind:'text';contentType:string;text:string}|{kind:'json';value:Json}|
  {kind:'bytes';contentType:string;base64:string;filename?:string}|
  {kind:'multipart';fields:Array<{name:string;value:string}>;files:Array<{fieldName:string;filename:string;contentType:string;base64:string}>};
export type OutboundIntent={intentId:string;connection:ConnectionBinding;rationale:string;
  privacy:{kind:'redacted'|'decontextualized';summary:string;limitations?:string[]};
  request:{method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE';url:string;headers?:Record<string,string>;payload:OutboundPayload}};
export type OutboundReview={id:string;digest:string;status:SendState;createdAt:number;expiresAt:number;
  scope:SessionContext;connection:{id:string;api:string;endpoint:string};rationale:string;
  privacy:{kind:'redacted'|'decontextualized';summary:string;limitations:string[];notice:string};
  destination:{url:string;origin:string;hostname:string;path:string;query:Array<[string,string]>;encrypted:boolean};
  request:{method:string;headers:Record<string,string>;payload:OutboundPayload;bodyBytes:number;bodySha256:string};
  disclosures:{authentication:string;ip:string;location:string;other:string}};
export type ApprovedSend=Readonly<{reviewId:string;digest:string}>;
export type BrokerWireRequest=Readonly<{url:string;method:string;headers:Readonly<Record<string,string>>;bodyBase64:string;
  binding:Readonly<ConnectionBinding>;signal:AbortSignal;redirect:'error';assertCurrent:()=>void}>;
export type BrokerResponse={status:number;headers?:Record<string,string>;bodyBase64:string};
export type SendState='pending'|'approved'|'sending'|'sent'|'failed'|'cancelled'|'denied'|'expired'|'revoked'|'interrupted';
type LedgerRow={key:string;reviewId:string;digest:string;state:SendState;createdAt:number;updatedAt:number};
type Entry={row:LedgerRow;review:OutboundReview;context:SessionContext;binding:ConnectionBinding;modelConnectionIds:string[];policyRevision:number;wire:{url:string;method:string;headers:Record<string,string>;bodyBase64:string};controller?:AbortController;dispatched?:boolean};
const statusSchema=z.enum(['pending','approved','sending','sent','failed','cancelled','denied','expired','revoked','interrupted']);
const ledgerSchema=z.object({schemaVersion:z.literal(1),entries:z.array(z.object({key:z.string().regex(/^[a-f0-9]{64}$/),reviewId:z.string().uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/),state:statusSchema,createdAt:z.number().int().nonnegative(),updatedAt:z.number().int().nonnegative()}).strict()).max(4096)}).strict();
export class OutboundBrokerError extends Error {
  constructor(readonly code:string,message:string,readonly status=409,readonly redirectUrl?:string){super(message);this.name='OutboundBrokerError'}
}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const copy=<T>(value:T):T=>structuredClone(value);
const text=(value:unknown,max:number,label:string)=>{if(typeof value!=='string'||!value.length||value.length>max||/[\0\r\n]/.test(value))throw new OutboundBrokerError('invalid_request','Provide a valid '+label+'.',400);return value};
function abortable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
  });
}
function base64(value:string,max:number){
  if(typeof value!=='string'||value.length>Math.ceil(max/3)*4||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw new OutboundBrokerError('invalid_payload','Provide valid bounded base64 bytes.',400);
  const bytes=Buffer.from(value,'base64');if(bytes.length>max||bytes.toString('base64')!==value)throw new OutboundBrokerError('invalid_payload','The payload exceeds its limit or has invalid encoding.',400);return bytes;
}
function safePart(value:string,label:string){text(value,255,label);if(/["\\]/.test(value))throw new OutboundBrokerError('invalid_payload','Multipart names cannot contain quotes or backslashes.',400);return value}
function headers(raw:Record<string,string>={}){
  const result:Record<string,string>=Object.create(null);if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>32)throw new OutboundBrokerError('invalid_headers','Provide at most 32 request headers.',400);
  for(const [name,value]of Object.entries(raw)){
    if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name)||/^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|host|connection|content-length|transfer-encoding|upgrade|proxy-connection)$/i.test(name))throw new OutboundBrokerError('invalid_headers','Authentication and transport headers must be supplied by the bound transport, not the draft.',400);
    const key=name.toLowerCase();if(Object.hasOwn(result,key))throw new OutboundBrokerError('invalid_headers','Duplicate request header.',400);result[key]=text(value,4096,'header value');
  }return result;
}
function materialize(payload:OutboundPayload,max:number):{payload:OutboundPayload;bytes:Buffer;contentType?:string}{
  const snapshot=copy(payload);let bytes:Buffer,contentType:string|undefined;
  if(snapshot.kind==='none')bytes=Buffer.alloc(0);
  else if(snapshot.kind==='text'){contentType=text(snapshot.contentType,255,'content type');if(typeof snapshot.text!=='string'||Buffer.byteLength(snapshot.text)>256*1024)throw new OutboundBrokerError('invalid_payload','Text payloads are limited to 256 KiB.',400);bytes=Buffer.from(snapshot.text)}
  else if(snapshot.kind==='json'){
    let encoded:string;try{encoded=JSON.stringify(snapshot.value)}catch{throw new OutboundBrokerError('invalid_payload','Provide a serializable JSON payload.',400)}
    if(encoded===undefined||Buffer.byteLength(encoded)>256*1024)throw new OutboundBrokerError('invalid_payload','JSON payloads are limited to 256 KiB.',400);snapshot.value=JSON.parse(encoded);contentType='application/json';bytes=Buffer.from(encoded);
  }else if(snapshot.kind==='bytes'){contentType=text(snapshot.contentType,255,'content type');if(snapshot.filename)safePart(snapshot.filename,'filename');bytes=base64(snapshot.base64,max)}
  else if(snapshot.kind==='multipart'){
    if(!Array.isArray(snapshot.fields)||!Array.isArray(snapshot.files)||snapshot.fields.length>64||snapshot.files.length>8)throw new OutboundBrokerError('invalid_payload','Use at most 64 fields and eight uploads.',400);
    const boundary='chimeric-'+policyDigest(snapshot).slice(0,40),chunks:Buffer[]=[];
    for(const field of snapshot.fields){safePart(field.name,'field name');if(typeof field.value!=='string'||Buffer.byteLength(field.value)>256*1024)throw new OutboundBrokerError('invalid_payload','Multipart fields are limited to 256 KiB.',400);chunks.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+field.name+'"\r\n\r\n'+field.value+'\r\n'))}
    for(const file of snapshot.files){safePart(file.fieldName,'field name');safePart(file.filename,'filename');text(file.contentType,255,'content type');const value=base64(file.base64,Math.min(max,4*1024*1024));chunks.push(Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="'+file.fieldName+'"; filename="'+file.filename+'"\r\nContent-Type: '+file.contentType+'\r\n\r\n'),value,Buffer.from('\r\n'))}
    chunks.push(Buffer.from('--'+boundary+'--\r\n'));bytes=Buffer.concat(chunks);contentType='multipart/form-data; boundary='+boundary;
  }else throw new OutboundBrokerError('invalid_payload','Choose a supported outbound payload.',400);
  if(bytes.length>max)throw new OutboundBrokerError('invalid_payload','The outbound payload exceeds its byte limit.',400);return {payload:snapshot,bytes,contentType};
}
function destination(address:string,binding:ConnectionBinding){
  text(address,8192,'destination URL');const url=new URL(address),base=new URL(binding.endpoint),prefix=base.pathname.replace(/\/+$/,'');
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||/%(?:2f|5c|00)/i.test(url.pathname)||url.origin!==base.origin||(prefix&&url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/')))
    throw new OutboundBrokerError('destination_mismatch','The request must remain inside the reviewed connection URL and API path prefix.',400);
  return {url:url.href,origin:url.origin,hostname:url.hostname,path:url.pathname,query:[...url.searchParams.entries()] as Array<[string,string]>,encrypted:url.protocol==='https:'};
}

/** Holds the proposed transformed copy, never the original input. This is a
 * request broker, not an OS firewall or a certification that a draft is anonymous.
 * The injected transport must apply bounded reads, exact binding/auth checks,
 * no redirects, no retries, and the supplied cancellation signal. */
export class OutboundBroker {
  private entries=new Map<string,Entry>();private ledger:LedgerRow[]=[];private permits=new WeakMap<object,Entry>();private file:string;private unwatch:()=>void;private closed=false;
  private maxBody:number;private timeout:number;private ttl:number;
  constructor(readonly policy:SessionPolicyStore,private options:{transport:(request:BrokerWireRequest)=>Promise<BrokerResponse>;now?:()=>number;maxBodyBytes?:number;timeoutMs?:number;reviewTtlMs?:number;maxPending?:number;maxLedgerEntries?:number}){
    this.maxBody=options.maxBodyBytes??8*1024*1024;this.timeout=options.timeoutMs??30_000;this.ttl=options.reviewTtlMs??10*60_000;
    if(!Number.isInteger(this.maxBody)||this.maxBody<1||this.maxBody>8*1024*1024||!Number.isInteger(this.timeout)||this.timeout<1||this.timeout>120_000||!Number.isInteger(this.ttl)||this.ttl<1||this.ttl>30*60_000)throw new OutboundBrokerError('invalid_limits','Invalid outbound broker limits.',400);
    if(!Number.isInteger(options.maxPending??32)||(options.maxPending??32)<1||(options.maxPending??32)>32||!Number.isInteger(options.maxLedgerEntries??4096)||(options.maxLedgerEntries??4096)<1||(options.maxLedgerEntries??4096)>4096)throw new OutboundBrokerError('invalid_limits','Invalid outbound broker capacity.',400);
    this.file=join(policy.profileDir,'local-auth','outbound-approvals.json');
    if(existsSync(this.file))try{
      if(statSync(this.file).size>2*1024*1024)throw Error('oversize');this.ledger=ledgerSchema.parse(JSON.parse(readFileSync(this.file,'utf8'))).entries;
      if(new Set(this.ledger.map(v=>v.key)).size!==this.ledger.length||new Set(this.ledger.map(v=>v.reviewId)).size!==this.ledger.length)throw Error('duplicate');
      let changed=false;for(const row of this.ledger)if(['pending','approved','sending'].includes(row.state)){row.state='interrupted';row.updatedAt=this.now();changed=true}if(changed)this.persist();
    }catch{throw new OutboundBrokerError('ledger_unreadable','Outbound approval receipts could not be read. Restore them before sending protected data.',503)}
    this.unwatch=policy.subscribe(change=>this.onPolicyChange(change));
  }
  private now(){return this.options.now?.()??Date.now()}
  private persist(){writePolicyJson(this.file,{schemaVersion:1,entries:this.ledger})}
  private assertOpen(){if(this.closed)throw new OutboundBrokerError('closed','The outbound broker is closed.',503)}
  private sameScope(a:SessionContext,b:SessionContext){return ['rootFrameId','projectId','ownerId','organizationId'].every(k=>a[k as keyof SessionContext]===b[k as keyof SessionContext])}
  private assertCurrent(entry:Entry){
    this.assertOpen();this.policy.assertWritable(entry.context);const p=this.policy.policy(entry.context);
    if(p.mode!=='class2'||p.revision!==entry.policyRevision)throw new OutboundBrokerError('policy_changed','The session confidentiality policy changed. Review the request again.');
    this.policy.modelFor(entry.context,'main');this.policy.modelFor(entry.context,'reviewer');
    this.policy.assertLane(entry.context,'brokered-http');this.policy.assertBindingCurrent(entry.binding);
    if(entry.row.state==='revoked'||entry.row.state==='cancelled'||entry.row.state==='denied')throw new OutboundBrokerError('approval_revoked','This request is no longer approved.');
    if(!entry.dispatched&&this.now()>=entry.review.expiresAt){this.transition(entry,'expired');throw new OutboundBrokerError('approval_expired','The send approval expired. Prepare a fresh review.')}
  }
  private trimTerminal(){
    const terminal=[...this.entries.values()].reverse().filter(v=>!['pending','approved','sending'].includes(v.row.state)).sort((a,b)=>b.row.updatedAt-a.row.updatedAt);
    let bytes=0;for(let index=0;index<terminal.length;index++){bytes+=terminal[index].review.request.bodyBytes;if(index>=16||bytes>8*1024*1024)this.entries.delete(terminal[index].row.reviewId)}
  }
  private transition(entry:Entry,state:SendState){entry.row.state=state;entry.row.updatedAt=this.now();entry.review.status=state;this.persist();this.trimTerminal()}
  private onPolicyChange(change:PolicyChange){
    for(const entry of this.entries.values())if(['pending','approved','sending'].includes(entry.row.state)&&
      (change.kind==='closed'||change.kind==='stt'||change.kind==='session'&&change.rootFrameId===entry.context.rootFrameId||change.kind==='connection'&&(change.connectionId===entry.binding.id||entry.modelConnectionIds.includes(change.connectionId)))){
      entry.controller?.abort(new Error('Send permission changed'));this.transition(entry,'revoked');
    }
  }
  async prepare(context:SessionContext,raw:OutboundIntent):Promise<OutboundReview>{
    this.assertOpen();this.policy.assertWritable(context);await this.policy.revalidateContext(context);const p=this.policy.policy(context);
    if(p.mode!=='class2')throw new OutboundBrokerError('protected_session_required','This review workflow requires a protected research session.');
    this.policy.modelFor(context,'main');this.policy.modelFor(context,'reviewer');
    this.policy.assertLane(context,'brokered-http');
    const intentId=text(raw.intentId,255,'request identifier'),binding=normalizeConnectionBinding(raw.connection);this.policy.assertBindingCurrent(binding);
    const rationale=z.string().trim().min(1).max(2000).parse(raw.rationale),privacy=z.object({kind:z.enum(['redacted','decontextualized']),summary:z.string().trim().min(1).max(2000),limitations:z.array(z.string().max(1000)).max(16).default([])}).strict().parse(raw.privacy);
    const target=destination(raw.request.url,binding),method=z.enum(['GET','POST','PUT','PATCH','DELETE']).parse(raw.request.method),body=materialize(raw.request.payload,this.maxBody),wireHeaders=headers(raw.request.headers);
    if((method==='GET'||method==='DELETE')&&body.bytes.length)throw new OutboundBrokerError('invalid_request','GET and DELETE reviews cannot contain a request body.',400);
    if(body.contentType){if(wireHeaders['content-type']&&wireHeaders['content-type']!==body.contentType)throw new OutboundBrokerError('invalid_headers','Content-Type must match the actual payload.',400);wireHeaders['content-type']=body.contentType}
    const wire={url:target.url,method,headers:wireHeaders,bodyBase64:body.bytes.toString('base64')},key=policyDigest({root:context.rootFrameId,frame:context.frameId,owner:context.ownerId,org:context.organizationId,intentId});
    const digest=policyDigest({wire,binding:connectionBindingDigest(binding),scope:context,policyRevision:p.revision,rationale,privacy}),prior=this.ledger.find(row=>row.key===key);
    if(prior){const existing=this.entries.get(prior.reviewId);if(prior.digest===digest&&prior.state==='pending'&&existing){this.assertCurrent(existing);return copy(existing.review)}throw new OutboundBrokerError('intent_replayed','This request identifier was already used. An explicit new request needs a new identifier.')}
    if(this.ledger.length>=(this.options.maxLedgerEntries??4096))throw new OutboundBrokerError('receipt_limit','The bounded send-receipt store is full. Protected sends are blocked until its retention is managed.',503);
    for(const entry of this.entries.values())if(['pending','approved'].includes(entry.row.state)&&this.now()>=entry.review.expiresAt)this.transition(entry,'expired');
    const pending=[...this.entries.values()].filter(v=>['pending','approved','sending'].includes(v.row.state));
    if(pending.length>=(this.options.maxPending??32)||pending.reduce((sum,e)=>sum+e.review.request.bodyBytes,0)+body.bytes.length>32*1024*1024)throw new OutboundBrokerError('pending_limit','Too many outbound reviews are pending.',429);
    const createdAt=this.now(),reviewId=randomUUID(),row:LedgerRow={key,reviewId,digest,state:'pending',createdAt,updatedAt:createdAt};
    const review:OutboundReview={id:reviewId,digest,status:'pending',createdAt,expiresAt:createdAt+this.ttl,scope:copy(context),connection:{id:binding.id,api:binding.api,endpoint:binding.endpoint},rationale,
      privacy:{...privacy,notice:'This is a proposed transformed copy. Neither Chimeric nor the proposing model guarantees anonymity; inspect the exact payload before sending.'},destination:target,
      request:{method,headers:copy(wireHeaders),payload:body.payload,bodyBytes:body.bytes.length,bodySha256:sha(body.bytes)},
      disclosures:{authentication:binding.credentialRevision==='keyless'?'No account credential or browser cookie is attached by this keyless transport. Inspect the URL, headers and payload for identifying information.':'The selected connection may attach its own credential. The credential is hidden, and approval is bound to its current revision.',
        ip:'The destination sees the outgoing connection IP, which may belong to your network, proxy or remote server. Its exact value has not been looked up.',
        location:'The destination may infer an approximate region from that IP. No location lookup is performed here; the approved payload may itself contain location information.',
        other:'The destination sees the URL/query, headers and exact payload shown here, plus timing and transport metadata. DNS resolvers and intermediaries may also see destination metadata.'}};
    const entry:Entry={row,review,context,binding,modelConnectionIds:[p.main!.connection.id,p.reviewer!.connection.id],policyRevision:p.revision,wire};this.ledger.push(row);this.persist();this.entries.set(reviewId,entry);return copy(review);
  }
  private entryFor(context:SessionContext,reviewId:string){
    this.policy.assertWritable(context);const entry=this.entries.get(reviewId);
    if(!entry||!this.sameScope(context,entry.context))throw new OutboundBrokerError('review_unavailable','This outbound review is unavailable in the current session.',404);return entry;
  }
  /** Invoke only from an authenticated human-review action, never a model tool. */
  async approve(context:SessionContext,reviewId:string,expectedDigest:string):Promise<ApprovedSend>{
    this.assertOpen();const entry=this.entryFor(context,reviewId);await this.policy.revalidateContext(context);this.assertCurrent(entry);
    if(entry.row.state!=='pending'||expectedDigest!==entry.row.digest)throw new OutboundBrokerError('review_changed','The review changed or was already decided. Review the exact current request.');
    this.transition(entry,'approved');const permit=Object.freeze({reviewId,digest:entry.row.digest});this.permits.set(permit,entry);return permit;
  }
  deny(context:SessionContext,reviewId:string){const entry=this.entryFor(context,reviewId);if(!['pending','approved'].includes(entry.row.state))throw new OutboundBrokerError('review_decided','This review was already decided.');this.transition(entry,'denied')}
  review(context:SessionContext,reviewId:string){return copy(this.entryFor(context,reviewId).review)}
  reviews(context:SessionContext){this.policy.policy(context);return [...this.entries.values()].filter(entry=>this.sameScope(context,entry.context)).map(entry=>copy(entry.review))}
  async execute(permit:ApprovedSend,signal?:AbortSignal):Promise<BrokerResponse>{
    this.assertOpen();const entry=this.permits.get(permit);if(!entry||entry.row.state!=='approved')throw new OutboundBrokerError('permit_replayed','This send approval is unavailable or was already consumed.');
    this.permits.delete(permit);this.transition(entry,'sending');const controller=new AbortController();entry.controller=controller;
    const deadline=AbortSignal.timeout(this.timeout),effective=AbortSignal.any([controller.signal,deadline,...signal?[signal]:[]]);
    try{
      effective.throwIfAborted();await this.policy.revalidateContext(entry.context);this.assertCurrent(entry);effective.throwIfAborted();
      const current=()=>{effective.throwIfAborted();this.assertCurrent(entry)};current();
      entry.dispatched=true;
      const response=await abortable(this.options.transport(Object.freeze({...entry.wire,headers:Object.freeze({...entry.wire.headers}),binding:Object.freeze({...entry.binding}),signal:effective,redirect:'error' as const,assertCurrent:current})),effective);
      current();if(!Number.isInteger(response.status)||response.status<100||response.status>599)throw new OutboundBrokerError('invalid_response','The outbound transport returned an invalid response.',502);
      base64(response.bodyBase64,8*1024*1024);
      if(response.status>=300&&response.status<=399){
        const location=Object.entries(response.headers??{}).find(([key])=>key.toLowerCase()==='location')?.[1];let redirect:string|undefined;
        if(location)try{const url=new URL(location,entry.wire.url);if(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password)redirect=url.href}catch{}
        throw new OutboundBrokerError('redirect_requires_review','The destination redirected the request. Prepare a new exact-destination review before continuing.',409,redirect);
      }
      this.transition(entry,'sent');return copy(response);
    }catch(error){
      if(entry.row.state!=='revoked')this.transition(entry,effective.aborted?'cancelled':'failed');
      if(error instanceof SessionPolicyError||error instanceof OutboundBrokerError)throw error;
      throw new OutboundBrokerError(deadline.aborted?'timeout':effective.aborted?'cancelled':'transport_failed',deadline.aborted?'The approved send timed out and was not retried.':effective.aborted?'The approved send was cancelled and was not retried.':'The approved send failed and was not retried.',502);
    }finally{entry.controller=undefined}
  }
  close(){if(this.closed)return;this.onPolicyChange({kind:'closed'});this.closed=true;this.unwatch()}
}
