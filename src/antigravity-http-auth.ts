import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {chmodSync,existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {createServer,type Server} from 'node:http';
import {join} from 'node:path';
import {homedir} from 'node:os';

/**
 * Google Antigravity subscription authentication.
 *
 * The preferred path imports a session created by the installed official client.
 * An optional local OAuth client configuration enables PKCE + loopback sign-in.
 * Chimeric stores imported or locally obtained credentials in its own encrypted
 * vault and only sends access tokens to the Antigravity service hosts.
 *
 * Protocol facts (User-Agent gate, scopes, import path) are
 * live-verified in work/agy-http-20261111/protocol/PROTOCOL.md.
 */

export const ANTIGRAVITY_AUTHORIZE_URL='https://accounts.google.com/o/oauth2/v2/auth';
export const ANTIGRAVITY_TOKEN_URL='https://oauth2.googleapis.com/token';
export const ANTIGRAVITY_CONTROL_URL='https://cloudcode-pa.googleapis.com';
export const ANTIGRAVITY_INFERENCE_URL='https://daily-cloudcode-pa.googleapis.com';
/** Load-bearing: the service version-gates this exact shape. */
export const ANTIGRAVITY_HTTP_USER_AGENT='antigravity/cli/1.5.5 (aidev_client; os_type=darwin; arch=arm64; cl=1017970541; auth_method=consumer)';
/** Version presented in the User-Agent. The service version-gates this value. */
export const ANTIGRAVITY_CLIENT_VERSION='1.5.5';
export const ANTIGRAVITY_SCOPES=[
 'openid',
 'https://www.googleapis.com/auth/cloud-platform',
 'https://www.googleapis.com/auth/userinfo.email',
 'https://www.googleapis.com/auth/userinfo.profile',
 'https://www.googleapis.com/auth/aicode',
 'https://www.googleapis.com/auth/cclog',
 'https://www.googleapis.com/auth/experimentsandconfigs',
];

type Credential={access:string;refresh:string;expires:number;[key:string]:unknown};
export type AntigravityHttpRecord={session:string;version:string;credential:Credential|null;project?:string;email?:string;reauthRequired?:boolean};
export type AntigravityHttpLogin={id:string;method:'browser'|'import';phase:'preparing'|'waiting'|'connected'|'error'|'expired';url?:string;message?:string;errorCode?:string;expiresAt?:number};
export type AntigravityOAuthClient={id:string;secret:string};

export class AntigravityHttpError extends Error {
 constructor(message:string,readonly terminal=false,readonly status=400){super(message);}
}

const validCredential=(value:any):value is Credential=>value&&typeof value.access==='string'&&!!value.access&&typeof value.refresh==='string'&&!!value.refresh&&Number.isFinite(value.expires);

function base64url(buffer:Buffer){return buffer.toString('base64url');}

/** Daemon-owned encrypted storage; same construction as the ChatGPT vault. */
export class AntigravityHttpVault {
 readonly path:string;private keyPath:string;
 constructor(directory:string){mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);this.path=join(directory,'antigravity-http.enc.json');this.keyPath=join(directory,'antigravity-http.key');}
 private key(create=false){
  if(!existsSync(this.keyPath)&&create)try{writeFileSync(this.keyPath,randomBytes(32),{mode:0o600,flag:'wx'});}catch(error:any){if(error.code!=='EEXIST')throw error;}
  const key=readFileSync(this.keyPath);if(key.length!==32)throw new AntigravityHttpError('The Antigravity credential key is invalid.');return key;
 }
 read():AntigravityHttpRecord|undefined{
  if(!existsSync(this.path))return;
  try{
   const value=JSON.parse(readFileSync(this.path,'utf8'));
   const decipher=createDecipheriv('aes-256-gcm',this.key(),Buffer.from(value.iv,'base64'));decipher.setAuthTag(Buffer.from(value.tag,'base64'));
   const record=JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.data,'base64')),decipher.final()]).toString());
   if(typeof record.session!=='string'||typeof record.version!=='string'||(record.credential!==null&&!validCredential(record.credential)))throw new Error('Invalid record');
   return record as AntigravityHttpRecord;
  }catch{throw new AntigravityHttpError('The saved Antigravity sign-in could not be read. Disconnect and sign in again.');}
 }
 write(record:AntigravityHttpRecord){
  if(record.credential!==null&&!validCredential(record.credential))throw new AntigravityHttpError('Refusing to store an incomplete Antigravity credential.');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key(true),iv);
  const data=Buffer.concat([cipher.update(JSON.stringify(record)),cipher.final()]);
  const temporary=this.path+'.'+randomUUID()+'.tmp';
  writeFileSync(temporary,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{mode:0o600});
  renameSync(temporary,this.path);
 }
}

type Options={
 fetch?:typeof fetch;
 onChange?:()=>void;
 loginTimeoutMs?:number;
 callbackPort?:number;
 /** Optional local OAuth registration. These values are never returned by status(). */
 oauthClient?:AntigravityOAuthClient|null;
 /** Explicit one-time import of the Antigravity desktop session file. */
 importPath?:string;
};

/** Source of an importable Antigravity session. Read only when the user asks for it. */
export function defaultImportPath(){return join(homedir(),'.gemini','jetski-standalone-oauth-token');}

export class AntigravityHttpAuth {
 private login?:AntigravityHttpLogin&{controller:AbortController;timer?:ReturnType<typeof setTimeout>;server?:Server};
 private refreshFlight?:Promise<AntigravityHttpRecord>;
 private secrets=new Set<string>();
 private listeners=new Set<()=>void>();
 private closed=false;
 private profile?:{project:string;tier?:string;paidTier?:string;email?:string};
 readonly vault:AntigravityHttpVault;
 constructor(directory:string,private options:Options={}){this.vault=new AntigravityHttpVault(directory);const record=this.vault.read();if(record?.credential)this.remember(record);}
 onChange(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private changed(){for(const listener of this.listeners)listener();this.options.onChange?.()}
 private remember(record?:AntigravityHttpRecord){if(record?.credential){this.secrets.add(record.credential.access);this.secrets.add(record.credential.refresh)}return record}
 private oauthClient(){
  const configured=this.options.oauthClient===undefined?{
   id:process.env.CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_ID,
   secret:process.env.CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_SECRET,
  }:this.options.oauthClient;
  if(configured===null||configured===undefined||!configured.id&&!configured.secret)return undefined;
  if(typeof configured.id!=='string'||!configured.id.trim()||typeof configured.secret!=='string'||!configured.secret.trim()){
   throw new AntigravityHttpError('Direct Antigravity browser sign-in is not configured. Set both CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_ID and CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_SECRET locally, or use the installed official client.');
  }
  return {id:configured.id.trim(),secret:configured.secret.trim()};
 }
 private requireOAuthClient(){
  const configured=this.oauthClient();
  if(!configured)throw new AntigravityHttpError('Direct Antigravity browser sign-in is not configured. Set both CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_ID and CHIMERIC_ANTIGRAVITY_OAUTH_CLIENT_SECRET locally, or use the installed official client.');
  return configured;
 }
 redact(message:string){for(const secret of this.secrets)message=message.split(secret).join('[redacted]');return message}
 private connectedRecord(){
  let record:AntigravityHttpRecord|undefined;
  try{record=this.remember(this.vault.read())}catch{return undefined}
  return record?.credential&&!record.reauthRequired?record:undefined;
 }
 status(){
  const record=this.connectedRecord();
  return {
   connected:!!record&&!this.closed,
   reauthRequired:this.vault.read()?.reauthRequired??false,
   oauthConfigured:(()=>{try{return !!this.oauthClient()}catch{return false}})(),
   ...(record?{email:record.email,project:record.project,expiresAt:record.credential!.expires}:{}),
   ...(this.profile?{tier:this.profile.tier,paidTier:this.profile.paidTier}:{}),
   ...(this.login?{login:{id:this.login.id,method:this.login.method,phase:this.login.phase,authorizationUrl:this.login.url,message:this.login.message,errorCode:this.login.errorCode,expiresAt:this.login.expiresAt}}:{}),
  };
 }

 /** Browser PKCE sign-in, or a one-time import of the desktop app's session.
  * Returns as soon as the sign-in is waiting so the caller can open the URL;
  * the flow itself continues in the background and reports through status(). */
 async start(method:'browser'|'import'='browser'){
  if(this.closed)throw new AntigravityHttpError('The Antigravity connection is closing.',true,409);
  if(!['browser','import'].includes(method))throw new AntigravityHttpError('Choose browser or import sign-in.');
  const oauthClient=method==='browser'?this.requireOAuthClient():undefined;
  this.cancel();
  const controller=new AbortController();
  const login:AntigravityHttpLogin&{controller:AbortController;timer?:ReturnType<typeof setTimeout>;server?:Server}={id:randomUUID(),method,phase:'preparing',controller};
  this.login=login;
  const timeout=this.options.loginTimeoutMs??600_000;
  login.expiresAt=Date.now()+timeout;
  login.timer=setTimeout(()=>{if(this.login===login){login.phase='expired';login.message='Antigravity sign-in timed out. Start again.';login.url=undefined;controller.abort();this.changed();}},timeout);
  try{
   if(method==='import'){
    login.phase='waiting';this.changed();
    const credential=await importDesktopSession(this.options.importPath??defaultImportPath());
    this.commit(login,credential);
   }else{
    const verifier=base64url(randomBytes(48));
    const challenge=base64url(createHash('sha256').update(verifier).digest());
    const state=base64url(randomBytes(16));
    const {server,port}=await this.listener(login,controller);
    const redirect=`http://127.0.0.1:${port}/oauth-callback`;
    const authorization=new URL(ANTIGRAVITY_AUTHORIZE_URL);
    authorization.search=new URLSearchParams({
     client_id:oauthClient!.id,redirect_uri:redirect,response_type:'code',
     scope:ANTIGRAVITY_SCOPES.join(' '),code_challenge:challenge,code_challenge_method:'S256',
     access_type:'offline',prompt:'consent',state,
    }).toString();
    login.url=authorization.href;login.phase='waiting';this.changed();
    // The human completes sign-in in a browser; the listener stays reachable until
    // the state-checked callback arrives or the attempt is cancelled/expired.
    void (async()=>{
     try{
      const code=await this.waitForCode(server,controller,state);
      const credential=await this.exchange({grant_type:'authorization_code',code,redirect_uri:redirect,code_verifier:verifier},oauthClient!,controller.signal);
      this.commit(login,credential);
     }catch(error){
      if(this.login===login&&!controller.signal.aborted)this.fail(login,error);
     }finally{
      if(login.timer!==undefined)clearTimeout(login.timer);
      login.server?.close();login.server=undefined;
     }
    })();
   }
  }catch(error){
   this.fail(login,error);
   if(login.timer!==undefined)clearTimeout(login.timer);
   login.server?.close();login.server=undefined;
  }
  return this.status();
 }
 private fail(login:AntigravityHttpLogin,error:unknown){
  if(this.login!==login)return;
  login.phase='error';login.url=undefined;
  const text=error instanceof Error?error.message:'';
  login.errorCode=/timeout|timed out/i.test(text)?'sign_in_timeout':/import|session file/i.test(text)?'import_unavailable':/state/i.test(text)?'state_mismatch':/exchange|invalid_grant|rejected/i.test(text)?'authorization_rejected':/fetch|network|ECONN|unreachable/i.test(text)?'network_error':'sign_in_failed';
  login.message=this.redact(text)||'Antigravity sign-in failed.';
  this.changed();
 }
 private commit(login:AntigravityHttpLogin,credential:Credential){
  if(this.login!==login||login.controller.signal.aborted)return;
  if(!validCredential(credential))throw new AntigravityHttpError('Google did not return usable Antigravity credentials.');
  const previous=this.connectedRecord();
  const record:AntigravityHttpRecord={session:previous?.session??randomUUID(),version:randomUUID(),credential,project:previous?.project,email:(credential as any).email??previous?.email};
  this.remember(record);this.vault.write(record);
  login.phase='connected';login.url=undefined;this.profile=undefined;this.changed();
 }
 private listener(login:AntigravityHttpLogin&{server?:Server},controller:AbortController){
  const preferred=this.options.callbackPort??0;
  return new Promise<{server:Server;port:number}>((resolve,reject)=>{
   const server=createServer();
   const fail=(error:any)=>{server.close();reject(error instanceof Error?error:new AntigravityHttpError('The Antigravity sign-in listener could not start.'))};
   server.once('error',fail);
   server.listen(preferred,'127.0.0.1',()=>{
    server.off('error',fail);
    const address=server.address();
    if(!address||typeof address==='string')return fail(new AntigravityHttpError('The Antigravity sign-in listener could not start.'));
    login.server=server;controller.signal.addEventListener('abort',()=>server.close(),{once:true});
    resolve({server,port:address.port});
   });
  });
 }
 private waitForCode(server:Server,controller:AbortController,state:string){
  return new Promise<string>((resolve,reject)=>{
   const abort=()=>{server.close();reject(new AntigravityHttpError('Antigravity sign-in cancelled.'))};
   if(controller.signal.aborted)return abort();
   controller.signal.addEventListener('abort',abort,{once:true});
   server.on('request',(request,response)=>{
    const url=new URL(request.url??'/','http://127.0.0.1');
    if(url.pathname!=='/oauth-callback'){response.writeHead(404).end();return}
    const finish=(status:number,body:string)=>{response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}).end(body);controller.signal.removeEventListener('abort',abort);server.close();};
    if(url.searchParams.get('error')){finish(400,'<h1>Sign-in denied</h1><p>Return to Chimeric and start again.</p>');return reject(new AntigravityHttpError('Google rejected the Antigravity sign-in: '+(url.searchParams.get('error_description')??url.searchParams.get('error')??'denied')))}
    const code=url.searchParams.get('code');
    if(url.searchParams.get('state')!==state){finish(400,'<h1>Sign-in mismatch</h1>');return reject(new AntigravityHttpError('The Antigravity sign-in response did not match this request.'))}
    if(!code){finish(400,'<h1>Missing authorization code</h1>');return reject(new AntigravityHttpError('Google did not return an authorization code.'))}
    finish(200,'<h1>Antigravity connected</h1><p>You can close this window and return to Chimeric.</p>');
    resolve(code);
   });
  });
 }
 private async exchange(fields:Record<string,string>,oauthClient:AntigravityOAuthClient,signal?:AbortSignal,previousRefresh?:string){
  let response:Response;
  try{
   response=await(this.options.fetch??fetch)(ANTIGRAVITY_TOKEN_URL,{method:'POST',redirect:'error',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({...fields,client_id:oauthClient.id,client_secret:oauthClient.secret}),
    signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20_000)])});
  }catch{throw new AntigravityHttpError('Google token service is unreachable. Check the connection and retry.');}
  let data:any;
  try{data=await response.json()}catch{throw new AntigravityHttpError('Google returned an invalid token response.')}
  if(!response.ok)throw new AntigravityHttpError(`Google rejected the Antigravity token request${data?.error?': '+data.error:''}.`,response.status>=400&&response.status<500);
  if(typeof data.access_token!=='string'||!data.access_token)throw new AntigravityHttpError('Google did not return an Antigravity access token.');
  // Google only returns a refresh_token on the authorization-code exchange; a
  // refresh grant omits it and the existing one stays valid.
  const refresh=typeof data.refresh_token==='string'&&data.refresh_token?data.refresh_token:previousRefresh;
  if(!refresh)throw new AntigravityHttpError('Google did not return an Antigravity refresh token. Start sign-in again.');
  const expiresIn=typeof data.expires_in==='number'&&data.expires_in>0?data.expires_in:3599;
  return {access:data.access_token,refresh,expires:Date.now()+expiresIn*1000,scope:data.scope};
 }
 private async refresh(previous:AntigravityHttpRecord):Promise<AntigravityHttpRecord>{
  if(this.refreshFlight)return this.refreshFlight;
  const promise=(async()=>{
   const current=this.remember(this.vault.read());
   if(!current?.credential||current.session!==previous.session)throw new AntigravityHttpError('The Antigravity connection changed. Retry with the current connection.');
   if(current.version!==previous.version)return current;
   const oauthClient=this.oauthClient();
   if(!oauthClient)throw new AntigravityHttpError('The imported Antigravity session needs renewal. Refresh it through the official agy client, then import it again.');
   let credential:Credential;
   try{credential=await this.exchange({grant_type:'refresh_token',refresh_token:current.credential.refresh},oauthClient,undefined,current.credential.refresh)}
   catch(error){
    const terminal=error instanceof AntigravityHttpError&&error.terminal;
    const after=this.vault.read();
    if(after?.session!==current.session)throw new AntigravityHttpError('The Antigravity connection changed. Retry with the current connection.');
    if(after.version!==current.version)return this.remember(after)!;
    if(terminal){this.vault.write({...after,version:randomUUID(),reauthRequired:true});this.changed()}
    throw new AntigravityHttpError(terminal?'Antigravity sign-in expired. Reconnect in Settings → Connections.':'Antigravity token renewal is temporarily unavailable. Retry in a moment.',terminal);
   }
   const before=this.vault.read();
   if(before?.session!==current.session)throw new AntigravityHttpError('The Antigravity connection changed. Retry with the current connection.');
   if(before.version!==current.version)return this.remember(before)!;
   const record:AntigravityHttpRecord={...before,version:randomUUID(),credential,reauthRequired:false};
   this.remember(record);this.vault.write(record);this.changed();return record;
  })();
  this.refreshFlight=promise;
  try{return await promise}finally{if(this.refreshFlight===promise)this.refreshFlight=undefined}
 }
 cancel(){
  if(!this.login)return;
  if(this.login.timer!==undefined)clearTimeout(this.login.timer);
  this.login.server?.close();this.login.controller.abort();this.login=undefined;this.changed();
 }
 disconnect(){
  this.cancel();
  try{const current=this.vault.read();this.vault.write({session:current?.session??randomUUID(),version:randomUUID(),credential:null});}catch{this.vault.write({session:randomUUID(),version:randomUUID(),credential:null})}
  this.profile=undefined;this.changed();
 }
 close(){if(this.closed)return;this.closed=true;this.cancel()}

 /** Returns a renewable request context bound to one credential revision. */
 async requestAuth(signal?:AbortSignal){
  signal?.throwIfAborted();
  let record=this.remember(this.vault.read());
  if(!record?.credential||record.reauthRequired)throw new AntigravityHttpError('Connect Antigravity in Settings → Connections to use its models.');
  if(record.credential.expires<Date.now()+120_000)record=await this.refresh(record);
  signal?.throwIfAborted();
  const session=record.session;let version=record.version;
  const assertCurrent=()=>{
   signal?.throwIfAborted();
   const current=this.vault.read();
   if(!current?.credential||current.session!==session||current.reauthRequired)throw new AntigravityHttpError('The Antigravity connection changed. Retry with the current connection.');
  };
  const authenticatedFetch:typeof fetch=async(input:any,init?:any)=>{
   assertCurrent();
   const current=this.remember(this.vault.read());
   if(!current?.credential||current.session!==session)throw new AntigravityHttpError('The Antigravity connection changed. Retry with the current connection.');
   const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
   if(![ANTIGRAVITY_INFERENCE_URL,ANTIGRAVITY_CONTROL_URL].some(origin=>url.origin===origin))throw new AntigravityHttpError('Antigravity credentials can only be sent to the Antigravity model service.');
   version=current.version;
   const headers=new Headers(init?.headers);headers.set('authorization','Bearer '+current.credential!.access);
   const signals=[signal,init?.signal].filter((value):value is AbortSignal=>!!value);
   return(this.options.fetch??fetch)(input,{...init,headers,redirect:'error',...(signals.length?{signal:AbortSignal.any(signals)}:{})});
  };
  return {apiKey:record.credential.access,sessionScope:session,assertCurrent,fetch:authenticatedFetch,version};
 }

 /** loadCodeAssist → project, tier and paid-subscription detection. */
 async profileInfo(signal?:AbortSignal){
  const auth=await this.requestAuth(signal);
  const response=await auth.fetch(ANTIGRAVITY_CONTROL_URL+'/v1internal:loadCodeAssist',{method:'POST',headers:{'content-type':'application/json','user-agent':ANTIGRAVITY_HTTP_USER_AGENT},body:JSON.stringify({metadata:{ideType:'ANTIGRAVITY'}})});
  if(!response.ok){await response.body?.cancel();throw new AntigravityHttpError('Antigravity eligibility could not be read (HTTP '+response.status+').',response.status<500);}
  const data:any=await response.json();
  const project=typeof data?.cloudaicompanionProject==='string'&&data.cloudaicompanionProject?data.cloudaicompanionProject:undefined;
  if(!project)throw new AntigravityHttpError('Antigravity did not return a project for this account.');
  this.profile={project,tier:data?.currentTier?.id,paidTier:data?.paidTier?.id};
  const record=this.vault.read();
  if(record?.credential&&!record.reauthRequired&&record.project!==project)this.vault.write({...record,project,version:randomUUID()});
  return this.profile;
 }
 /** Absolute project id used by every inference envelope. */
 async project(signal?:AbortSignal){
  if(this.profile?.project)return this.profile.project;
  const record=this.connectedRecord();
  if(record?.project){this.profile={project:record.project};return record.project}
  return (await this.profileInfo(signal)).project;
 }
}

/** Reads the Antigravity desktop app's consumer session without copying it elsewhere. */
export async function importDesktopSession(path=defaultImportPath()){
 let parsed:any;
 try{parsed=JSON.parse(readFileSync(path,'utf8'))}catch{throw new AntigravityHttpError('No Antigravity desktop session was found. Sign in through Chimeric instead.');}
 const token=parsed?.token??parsed;
 const access=typeof token?.access_token==='string'?token.access_token:undefined;
 const refresh=typeof token?.refresh_token==='string'?token.refresh_token:undefined;
 if(!access||!refresh)throw new AntigravityHttpError('The Antigravity desktop session has no reusable tokens. Sign in through Chimeric instead.');
 const expiry=typeof token?.expiry==='string'?Date.parse(token.expiry):Number.NaN;
 const expires=Number.isFinite(expiry)?expiry:Date.now()+(typeof token?.expires_in==='number'?token.expires_in*1000:0);
 const email=typeof parsed?.id_token_email==='string'?parsed.id_token_email:undefined;
 return {access,refresh,expires,source:'desktop-session',email};
}

/**
 * Version of the officially installed CLI, used only to warn when the presented
 * client identity has drifted from the client the user actually has. The direct
 * HTTP path never executes the CLI. Returns undefined when no CLI is installed.
 */
export function installedCliVersion(executable=join(homedir(),'.local','bin',process.platform==='win32'?'agy.exe':'agy')){
 if(!existsSync(executable))return undefined;
 try{
  const {spawnSync}=require('node:child_process') as typeof import('node:child_process');
  const result=spawnSync(executable,['--version'],{encoding:'utf8',timeout:3000,maxBuffer:64*1024});
  const version=(result.stdout??'').trim().split(/\s+/)[0];
  return /^\d+\.\d+\.\d+$/.test(version)?version:undefined;
 }catch{return undefined}
}
