import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {SubscriptionModels} from './subscription-models';
import {modelEfforts} from './model-effort';
import {createServer} from 'node:net';
import {openaiCodexProvider} from '@earendil-works/pi-ai/providers/openai-codex';
import {registerBunOAuthFlows} from '@earendil-works/pi-ai/bun-oauth';
import {stream as codex} from '@earendil-works/pi-ai/api/openai-codex-responses';
import type {Model} from '@earendil-works/pi-ai';

// PiAI's default OAuth loader uses a bundler-opaque relative import. The
// standalone runtime has no node_modules beside it, so embed the supported
// OAuth implementations through PiAI's public standalone-registration API.
registerBunOAuthFlows();

type Credential={type:'oauth';access:string;refresh:string;expires:number;[key:string]:unknown};
type RecordData={session:string;version:string;credential:Credential|null;reauthRequired?:boolean};
type OAuth={login:(interaction:any,options?:any)=>Promise<Credential>};
type Login={id:string;method:'browser'|'device_code';phase:string;url?:string;userCode?:string;message?:string;errorCode?:string;expiresAt?:number;controller:AbortController;timer?:ReturnType<typeof setTimeout>};
type CheckRecord={id:string;session:string;version:string;status:'checking'|'passed'|'failed';model:string;checkedAt?:number;message?:string};
const authBindings=new WeakMap<object,{session:string;version:string}>();
const AUTH_ORIGIN='https://auth.openai.com';
const CODEX_URL='https://chatgpt.com/backend-api/codex/responses';
const CODEX_IMAGES_URL='https://chatgpt.com/backend-api/codex/images/generations';
// Catalog protocol version used by the existing Codex connection. This is
// separate from Chimeric's release version and does not require a Codex CLI.
const CODEX_MODELS_URL='https://chatgpt.com/backend-api/codex/models?client_version=0.166.0';
const validCredential=(c:any):c is Credential=>c?.type==='oauth'&&typeof c.access==='string'&&!!c.access&&typeof c.refresh==='string'&&!!c.refresh&&Number.isFinite(c.expires);
function loginFailure(error:unknown){
 const text=error instanceof Error?error.message:'';
 if(/Cannot find (?:module|package)|ResolveMessage|OAuth.*only available in Node/i.test(text))return{errorCode:'sign_in_runtime_unavailable',message:'The local sign-in service is incomplete. Rebuild or update Chimeric, then retry.'};
 if(/state mismatch/i.test(text))return{errorCode:'state_mismatch',message:'The sign-in response did not match this request. Start a fresh sign-in.'};
 if(/token exchange|invalid_grant|authorization.*expired/i.test(text))return{errorCode:'authorization_rejected',message:'OpenAI rejected this sign-in response. Start a fresh sign-in and use the newest browser tab.'};
 if(/accountId|account.*token/i.test(text))return{errorCode:'account_unavailable',message:'OpenAI did not return usable ChatGPT account information. Try another account or Device code.'};
 if(/device.*(?:not enabled|failed|request|response)/i.test(text))return{errorCode:'device_code_unavailable',message:'Device-code sign-in is unavailable for this account or service. Try browser sign-in.'};
 if(/fetch|network|ECONN|ENET|timed? ?out/i.test(text))return{errorCode:'network_error',message:'OpenAI sign-in could not reach the service. Check the connection and retry.'};
 return{errorCode:'sign_in_failed',message:'ChatGPT sign-in failed. Retry, or use Device code if the browser callback is unavailable.'};
}

export class SubscriptionError extends Error {
 constructor(message:string,readonly terminal=false){super(message);}
}

/** Daemon-owned storage. This directory is inside the native auth sandbox boundary. */
export class SubscriptionVault {
 readonly path:string;private keyPath:string;
 constructor(directory:string){mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);this.path=join(directory,'chatgpt.enc.json');this.keyPath=join(directory,'chatgpt.key');}
 private key(create=false){
  if(!existsSync(this.keyPath)&&create)try{writeFileSync(this.keyPath,randomBytes(32),{mode:0o600,flag:'wx'});}catch(e:any){if(e.code!=='EEXIST')throw e;}
  const key=readFileSync(this.keyPath);if(key.length!==32)throw new Error('Invalid credential key');return key;
 }
 read():RecordData|undefined{
  if(!existsSync(this.path))return;
  try{
   const value=JSON.parse(readFileSync(this.path,'utf8'));
   const d=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(value.iv,'base64'));d.setAuthTag(Buffer.from(value.tag,'base64'));
   const r=JSON.parse(Buffer.concat([d.update(Buffer.from(value.data,'base64')),d.final()]).toString());
   if(typeof r.session!=='string'||typeof r.version!=='string'||(r.credential!==null&&!validCredential(r.credential)))throw new Error('Invalid credential record');
   return r as RecordData;
  }catch{throw new SubscriptionError('ChatGPT credential storage could not be read. Restore the local auth directory or reconnect after repairing it.');}
 }
 write(record:RecordData){
  const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.key(true),iv);
  const data=Buffer.concat([c.update(JSON.stringify(record)),c.final()]);
  const temporary=this.path+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify({iv:iv.toString('base64'),tag:c.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});
  renameSync(temporary,this.path);
 }
}

async function callbackPortAvailable(){
 const server=createServer();
 return await new Promise<boolean>(resolve=>{
  server.once('error',()=>resolve(false));
  server.listen(1455,'127.0.0.1',()=>server.close(()=>resolve(true)));
 });
}

export class SubscriptionManager {
 private login?:Login;private refreshFlight?:Promise<RecordData>;private refreshController?:AbortController;
 private connectionCheck?:CheckRecord;private checkController?:AbortController;private checkFlight?:Promise<void>;
 private secrets=new Set<string>();
 private imageLifetime=new AbortController();
 private invalidateImageAuth(){this.imageLifetime.abort(new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.'));this.imageLifetime=new AbortController();}
 readonly modelCatalog:SubscriptionModels;
 constructor(readonly vault:SubscriptionVault,private options:{oauth?:OAuth;fetch?:typeof fetch;callbackAvailable?:()=>Promise<boolean>;endpoint?:string;catalogEndpoint?:string;catalogTimeoutMs?:number;autoDiscover?:boolean;loginTimeoutMs?:number;checkTimeoutMs?:number;onChange?:()=>void;onModelsChanged?:()=>Promise<void>|void}={}){
  this.modelCatalog=new SubscriptionModels({path:join(dirname(vault.path),'chatgpt-models.json'),session:()=>{const r=vault.read();return r?.credential&&!r.reauthRequired?r.session:undefined},timeoutMs:options.catalogTimeoutMs,
   fetch:async signal=>{const auth=await this.requestAuth(signal,'models');return auth.fetch(options.catalogEndpoint??CODEX_MODELS_URL,{method:'GET',headers:{originator:'codex_cli_rs'},signal})},
   onChange:async()=>{await options.onModelsChanged?.();options.onChange?.();}});
 }
 async discoverModels(force=true){await this.modelCatalog.refresh(force);return this.status();}
 private remember(r?:RecordData){if(r?.credential){this.secrets.add(r.credential.access);this.secrets.add(r.credential.refresh);}return r;}
 redact(message:string){try{this.remember(this.vault.read());}catch{}for(const secret of this.secrets)message=message.split(secret).join('[redacted]');return message;}
 status(){
  const r=this.remember(this.vault.read());
  return {connected:!!r?.credential&&!r.reauthRequired,reauthRequired:r?.reauthRequired??false,modelDiscovery:this.modelCatalog.status(),
   ...(r?.credential?{expiresAt:r.credential.expires}:{}),
   ...(r?.credential&&!r.reauthRequired&&this.connectionCheck?.session===r.session&&this.connectionCheck.version===r.version?{connectionCheck:{status:this.connectionCheck.status,model:this.connectionCheck.model,checkedAt:this.connectionCheck.checkedAt,message:this.connectionCheck.message}}:{}),
   ...(this.login?{login:{id:this.login.id,method:this.login.method,phase:this.login.phase,authorizationUrl:this.login.url,userCode:this.login.userCode,message:this.login.message,errorCode:this.login.errorCode,expiresAt:this.login.expiresAt}}:{})};
 }
 async start(method:'browser'|'device_code'='browser'){
  if(!['browser','device_code'].includes(method))throw new SubscriptionError('Choose browser or device-code sign-in.');
  if(method==='browser'&&!await(this.options.callbackAvailable??callbackPortAvailable)())throw new SubscriptionError('The sign-in callback port is busy. Finish the other sign-in, or choose Device code.');
  this.cancel();
  const controller=new AbortController();
  const login:Login={id:randomUUID(),method,phase:'preparing',controller};
  // A browser callback must remain reachable while the human completes sign-in.
  // OpenAI controls the authorization-code lifetime; cancellation closes our listener.
  const timeout=this.options.loginTimeoutMs??(method==='device_code'?900_000:undefined);
  if(timeout!==undefined){
   login.expiresAt=Date.now()+timeout;
   login.timer=setTimeout(()=>{
    if(this.login===login){login.phase='expired';login.message='Sign-in timed out. Start a new connection.';login.url=undefined;login.userCode=undefined;controller.abort();}
   },timeout);
  }
  this.login=login;
  const previousSession=this.vault.read()?.session;
  const oauth=this.options.oauth??openaiCodexProvider().auth!.oauth!;
  void oauth.login({signal:controller.signal,
   prompt:async(p:any)=>{
    if(p.type==='select')return method;
    // Browser authorization completes through the state-checked loopback callback.
    // Raw authorization codes are never accepted by this application's UI.
    if(p.type==='manual_code')return await new Promise<string>((_resolve,reject)=>{
     const abort=()=>reject(new SubscriptionError('Sign-in cancelled.'));
     if(p.signal?.aborted||controller.signal.aborted)return abort();
     p.signal?.addEventListener('abort',abort,{once:true});controller.signal.addEventListener('abort',abort,{once:true});
    });
    throw new SubscriptionError('Unsupported sign-in prompt. Use browser or device-code sign-in.');
   },
   notify:(event:any)=>{
    if(this.login!==login||controller.signal.aborted)return;
    if(event.type==='auth_url'){
     const u=new URL(event.url);if(u.origin!==AUTH_ORIGIN)throw new SubscriptionError('Unexpected authorization destination.');
     login.url=u.href;login.phase='waiting';
    }else if(event.type==='device_code'){
     const u=new URL(event.verificationUri);if(u.origin!==AUTH_ORIGIN)throw new SubscriptionError('Unexpected authorization destination.');
     login.url=u.href;login.userCode=String(event.userCode);login.phase='waiting';
    }
   },
  },{agentName:'Chimeric'}).then(credential=>{
   if(this.login!==login||controller.signal.aborted||this.vault.read()?.session!==previousSession)return;
   if(!validCredential(credential))throw new SubscriptionError('OpenAI did not return usable subscription credentials.');
   const record={session:randomUUID(),version:randomUUID(),credential};this.invalidateImageAuth();
   this.remember(record);this.vault.write(record);this.modelCatalog.invalidate();login.phase='connected';login.url=undefined;login.userCode=undefined;this.options.onChange?.();
   if(this.options.autoDiscover)void this.discoverModels(false).catch(()=>undefined); // Failure is exposed in modelDiscovery.
  }).catch(error=>{
   if(this.login===login&&!controller.signal.aborted){login.phase='error';Object.assign(login,loginFailure(error));login.url=undefined;login.userCode=undefined;}
  }).finally(()=>{if(login.timer!==undefined)clearTimeout(login.timer);});
  return this.status();
 }
 cancel(){
  if(this.login){if(this.login.timer!==undefined)clearTimeout(this.login.timer);this.login.controller.abort();this.login=undefined;}
 }
 disconnect(){
  this.cancel();this.refreshController?.abort();this.clearCheck();this.invalidateImageAuth();
  this.vault.write({session:randomUUID(),version:randomUUID(),credential:null});this.modelCatalog.invalidate();void Promise.resolve(this.options.onModelsChanged?.()).catch(()=>console.warn('[chimeric] Could not refresh model choices after disconnect. Reopen Connections.'));this.options.onChange?.();
 }
 close(){this.cancel();this.refreshController?.abort();this.clearCheck();this.modelCatalog.close();this.imageLifetime.abort(new SubscriptionError('The ChatGPT connection closed.'));}
 private clearCheck(){this.checkController?.abort();this.checkController=undefined;this.checkFlight=undefined;this.connectionCheck=undefined;}
 /** A synthetic text round trip through the same Codex driver as research. */
 async check(model:Model<any>&{qualifiedId?:string;efforts?:string[]},signal?:AbortSignal){
  if(model.api!=='openai-codex-responses')throw new SubscriptionError('Choose a ChatGPT subscription model for this connection check.');
  const current=this.vault.read();
  if(!current?.credential||current.reauthRequired)throw new SubscriptionError('Sign in with ChatGPT before checking this connection.');
  const modelId=model.qualifiedId??model.id;
  if(this.checkFlight&&this.connectionCheck?.model===modelId&&this.connectionCheck.session===current.session&&this.connectionCheck.version===current.version){await this.checkFlight;return this.status()}
  this.clearCheck();
  const controller=new AbortController(),timeoutMs=Math.min(30_000,Math.max(1,this.options.checkTimeoutMs??15_000));
  this.checkController=controller;
  const record:CheckRecord={id:randomUUID(),session:current.session,version:current.version,status:'checking',model:modelId};this.connectionCheck=record;
  const combined=AbortSignal.any([controller.signal,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  const task=(async()=>{
   let binding:{session:string;version:string}|undefined;
   try{
    const auth=await this.requestAuth(combined);binding=authBindings.get(auth)!;
    record.version=binding.version;
    const {sessionScope:_scope,...requestAuth}=auth;
    let text='',bytes=0,done=false;
    const events=codex(model as any,{systemPrompt:'This is a connection test. Follow the exact reply instruction.',messages:[{role:'user',content:[{type:'text',text:'Reply with exactly CHIMERIC_CONNECTION_OK.'}],timestamp:0}]},
     {...requestAuth,transport:'sse',signal:combined,timeoutMs,maxRetries:0,maxTokens:32,...(model.reasoning?{reasoningEffort:modelEfforts(model).find(e=>e!=='off')}:{})});
    for await(const event of events){
     if(event.type==='text_delta'||event.type==='thinking_delta'){
      bytes+=Buffer.byteLength(event.delta);
      if(bytes>64*1024)throw new SubscriptionError('The connection check exceeded its output limit.');
      if(event.type==='text_delta')text+=event.delta;
     }else if(event.type==='done')done=true;
     else if(event.type==='error')throw new SubscriptionError('The ChatGPT model request failed. Check account access and retry.');
    }
    if(combined.aborted)throw new SubscriptionError('The connection check was cancelled or timed out.');
    const latest=this.vault.read();
    if(this.connectionCheck!==record||!latest?.credential||latest.reauthRequired||latest.session!==binding.session||latest.version!==binding.version)return;
    record.version=binding.version;
    if(!done||text.trim()!=='CHIMERIC_CONNECTION_OK')throw new SubscriptionError('The model did not return the expected connection-test reply.');
    record.status='passed';record.checkedAt=Date.now();record.message='The ChatGPT model returned the expected test reply.';
   }catch(error){
    if(this.connectionCheck!==record)return;
    const latest=this.vault.read();
    if(!latest?.credential||latest.session!==record.session||latest.reauthRequired)return;
    if(binding&&latest.session===binding.session&&latest.version===binding.version)record.version=binding.version;
    // A credential revision changed outside this check. Its result cannot
    // certify the newly saved credentials.
    if(latest.version!==record.version)return;
    record.status='failed';record.checkedAt=Date.now();record.message=combined.aborted?'The connection check was cancelled or timed out.':error instanceof SubscriptionError?error.message:'The ChatGPT connection could not be verified. Retry or reconnect.';
   }finally{controller.abort();}
  })();
  this.checkFlight=task;
  try{await task;return this.status()}finally{if(this.checkFlight===task){this.checkFlight=undefined;this.checkController=undefined}}
 }
 private async refresh(previous:RecordData):Promise<RecordData>{
  if(this.refreshFlight)return this.refreshFlight;
  const controller=new AbortController();this.refreshController=controller;
  const promise=(async()=>{
   const current=this.remember(this.vault.read());
   if(!current?.credential||current.session!==previous.session)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
   if(current.version!==previous.version)return current;
   let response:Response;
   try{response=await(this.options.fetch??fetch)(AUTH_ORIGIN+'/oauth/token',{method:'POST',redirect:'error',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:current.credential.refresh,client_id:'app_EMoamEEZ73f0CkXaXp7hrann'}),
    signal:AbortSignal.any([controller.signal,AbortSignal.timeout(20_000)])});
   }catch{throw new SubscriptionError('ChatGPT token renewal is temporarily unavailable. Retry in a moment.');}
   const latest=this.vault.read();
   if(latest?.session!==current.session)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
   if(latest.version!==current.version)return this.remember(latest)!;
   if(!response.ok){
    const terminal=response.status>=400&&response.status<500&&![408,429].includes(response.status);
    await response.body?.cancel();
    const afterCancel=this.vault.read();
    if(afterCancel?.session!==current.session)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
    if(afterCancel.version!==current.version)return this.remember(afterCancel)!;
    if(terminal){this.vault.write({...afterCancel,version:randomUUID(),reauthRequired:true});this.options.onChange?.();}
    throw new SubscriptionError(terminal?'ChatGPT sign-in expired. Reconnect in Settings → Connections.':'ChatGPT token renewal is temporarily unavailable. Retry in a moment.',terminal);
   }
   let data:any;try{data=await response.json();}catch{throw new SubscriptionError('OpenAI returned an invalid token renewal response.');}
   if(typeof data.expires_in!=='number'||!Number.isFinite(data.expires_in)||data.expires_in<=0)throw new SubscriptionError('OpenAI returned an invalid token expiry.');
   const credential:Credential={type:'oauth',access:data.access_token,refresh:data.refresh_token,expires:Date.now()+data.expires_in*1000};
   if(!validCredential(credential))throw new SubscriptionError('OpenAI returned an incomplete token renewal response.');
   const beforeWrite=this.vault.read();
   if(beforeWrite?.session!==current.session)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
   if(beforeWrite.version!==current.version)return this.remember(beforeWrite)!;
   const record={...beforeWrite,version:randomUUID(),credential,reauthRequired:false};this.remember(record);this.vault.write(record);return record;
  })();
  this.refreshFlight=promise;
  try{return await promise;}finally{if(this.refreshFlight===promise){this.refreshFlight=undefined;this.refreshController=undefined;}}
 }
 async requestAuth(signal?:AbortSignal,purpose:'inference'|'models'|'images'='inference'){
  signal?.throwIfAborted();
  let r=this.remember(this.vault.read());
  if(!r?.credential||r.reauthRequired)throw new SubscriptionError('Connect your ChatGPT subscription in Settings → Connections to use GPT 6.1 Sol.');
  if(r.credential.expires<Date.now()+60_000)r=await this.refresh(r);
  signal?.throwIfAborted();
  const session=r.session;
  const imageSignal=purpose==='images'?this.imageLifetime.signal:undefined;
  const assertCurrent=()=>{
   signal?.throwIfAborted();imageSignal?.throwIfAborted();
   const current=this.vault.read();
   if(!current?.credential||current.session!==session||current.reauthRequired)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
  };
  const binding={session,version:r.version};
  const authenticatedFetch:typeof fetch=async(input:any,init?:any)=>{
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   const allowed=purpose==='images'?CODEX_IMAGES_URL:purpose==='models'?(this.options.catalogEndpoint??CODEX_MODELS_URL):(this.options.endpoint??CODEX_URL);
   const method=(init?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
   if(url.href!==allowed||(purpose==='models'&&method!=='GET')||(purpose==='images'&&method!=='POST'))throw new SubscriptionError('Subscription credentials can only be sent to the configured Codex endpoint.');
   assertCurrent();
   let current=this.remember(this.vault.read());
   if(!current?.credential||current.session!==session||current.reauthRequired)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
   const send=(record:RecordData)=>{
    binding.version=record.version;
    const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+record.credential!.access);
    const parts=record.credential!.access.split('.');let account:unknown;
    try{const claims=JSON.parse(Buffer.from(parts[1],'base64url').toString());account=claims['https://api.openai.com/auth']?.chatgpt_account_id;}catch{}
    if(typeof account==='string'&&account)headers.set('chatgpt-account-id',account);
    else if(purpose==='images')throw new SubscriptionError('ChatGPT account information is unavailable. Reconnect in Settings → Connections.');
    const signals=[signal,imageSignal,init?.signal??(input instanceof Request?input.signal:undefined)].filter((value):value is AbortSignal=>!!value);
    const requestSignal=signals.length?AbortSignal.any(signals):undefined;requestSignal?.throwIfAborted();
    return(this.options.fetch??fetch)(input,{...init,headers,redirect:'error',...(requestSignal?{signal:requestSignal}:{})});
   };
   const response=await send(current);
   if(purpose==='images'){
    try{
     assertCurrent();
     // Renew rejected auth for the next explicit request. Replaying a generation
     // POST automatically can create an additional charged image.
     if(response.status===401){await this.refresh(current);assertCurrent();}
     return response;
    }catch(error){void response.body?.cancel().catch(()=>{});throw error;}
   }
   if(response.status!==401)return response;
   await response.body?.cancel();current=await this.refresh(current);
   if(current.session!==session||!current.credential)throw new SubscriptionError('The ChatGPT connection changed. Retry with the current connection.');
   return send(current);
  };
  const auth={apiKey:r.credential!.access,fetch:authenticatedFetch,sessionScope:session,...purpose==='images'?{signal:imageSignal,assertCurrent}:{}};authBindings.set(auth,binding);return auth;
 }
}
