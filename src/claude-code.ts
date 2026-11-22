import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {z} from 'zod';
import {ClaudeCodeError,ClaudeCodeModelProvider,claudeCodeAuthorizationUrl,
 findClaudeCodeExecutable,inspectClaudeCodeExecutable,runClaudeCodeCommand,type ClaudeCodeProviderOptions} from './claude-code-provider';
export {ClaudeCodeError};
export const CLAUDE_CODE_PROVIDER_ID='claude-code';
// An identity marker. Chimeric never calls an HTTP service at this address.
export const CLAUDE_CODE_BASE_URL='https://claude-code.local.invalid';
export type ClaudeCodeCatalogModel={id:string;name:string;input:['text'];verified:false;reasoning:true;reasoningEfforts:Record<string,string>;reasoningEffortsVerified:false;reasoningEffortsSource:'official-cli-options';contextWindow?:number;maxTokens?:number;availability:'unknown'};
const aliases=[['default','Claude Default'],['opus','Claude Opus'],['sonnet','Claude Sonnet'],['haiku','Claude Haiku'],['claude-fable-5-2','Fable 5.2']];
const actionSchema=z.object({action:z.enum(['check','connect','refresh','disconnect','login','cancel-login']),executable:z.string().min(1).max(4096).refine(isAbsolute,'Use an absolute executable path.').optional()}).strict();
export type ClaudeCodeModelsOptions=ClaudeCodeProviderOptions&{
 inspect?:typeof inspectClaudeCodeExecutable;run?:typeof runClaudeCodeCommand;
 driver?:(options:ClaudeCodeProviderOptions)=>ClaudeCodeModelProvider;
};
function atomic(path:string,value:unknown){
 mkdirSync(dirname(path),{recursive:true,mode:0o700});
 const temporary=path+'.tmp';writeFileSync(temporary,JSON.stringify(value),{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,path);
}
function normalizeAuth(text:string){
 let value:any;try{value=JSON.parse(text)}catch{throw new ClaudeCodeError('The official client returned invalid authentication status.',409)}
 if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.loggedIn!=='boolean')throw new ClaudeCodeError('The official client returned invalid authentication status.',409);
 const method=typeof value.authMethod==='string'&&['none','claude.ai','oauth_token','api_key','api_key_helper','third_party'].includes(value.authMethod)?value.authMethod:'unknown';
 return {connected:value.loggedIn,authMethod:method};
}
/** Optional model connection; the unmodified official CLI owns all authentication. */
export class ClaudeCodeModels{
 private file:string;private enabled=false;private connected=false;private executable:string;
 private installed=false;private version?:string;private signatureVerified=false;
 private authState:'unknown'|'ready'|'signed_out'|'error'='unknown';private authMethod='unknown';
 private operation:null|'checking'|'signing_in'=null;private error?:string;
 private login?:{phase:'waiting'|'connected'|'cancelled'|'error';authorizationUrl?:string};
 private generation=0;private closed=false;private active?:AbortController;private pending=new Set<Promise<unknown>>();
 private driver?:ClaudeCodeModelProvider;private listeners=new Set<()=>void>();
 constructor(profile:string,private options:ClaudeCodeModelsOptions={}){
  this.file=join(profile,'local-auth','claude-code','connection.json');this.executable=options.executable??findClaudeCodeExecutable();this.installed=Boolean(this.executable);
  if(existsSync(this.file))try{
   const bytes=readFileSync(this.file);if(bytes.length>16384)throw Error();
   const value=z.object({version:z.literal(1),enabled:z.boolean(),executable:z.string().max(4096)}).strict().parse(JSON.parse(bytes.toString('utf8')));
   if(value.executable&&!isAbsolute(value.executable))throw Error();
   this.enabled=value.enabled;this.executable=options.executable??(findClaudeCodeExecutable()||value.executable);this.installed=Boolean(this.executable);
  }catch{this.authState='error';this.error='The saved official-client connection could not be read. Check it again.'}
 }
 onChange(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
 private changed(){for(const listener of this.listeners)listener()}
 private persist(){atomic(this.file,{version:1,enabled:this.enabled,executable:this.executable})}
 private configuration(){return {...this.options,executable:this.executable}}
 private track<T>(promise:Promise<T>){this.pending.add(promise);void promise.finally(()=>this.pending.delete(promise)).catch(()=>{});return promise}
 private async revoke(){const generation=++this.generation;this.active?.abort();this.active=undefined;const driver=this.driver;this.driver=undefined;if(driver)await driver.close();return generation}
 available(){return !this.closed&&this.enabled&&this.connected&&this.authState==='ready'}
 catalog():ClaudeCodeCatalogModel[]{
  if(!this.available())return [];
  // These are documented official aliases, not a discovered entitlement catalog.
  // The client may cap effort under organization policy; verified remains false.
  return aliases.map(([id,name])=>({id,name,input:['text'],verified:false,reasoning:true,availability:'unknown',
   ...id==='claude-fable-5-2'?{contextWindow:1_000_000,maxTokens:128_000}:{},
   reasoningEffortsVerified:false,reasoningEffortsSource:'official-cli-options',
   reasoningEfforts:Object.fromEntries(['low','medium','high','xhigh','max'].map(effort=>[effort,effort]))}));
 }
 status(){return {installed:this.installed,executable:this.executable,version:this.version,signatureVerified:this.signatureVerified,
  enabled:this.enabled,connected:this.connected,ready:this.available(),authState:this.authState,authMethod:this.authMethod,
  operation:this.operation,error:this.error,detail:this.error??(this.available()?'The official client handles sign-in and inference. Model aliases and effort are subject to your account and organization limits.':'Check the official client or sign in through its own authorization flow.'),
  login:this.login?{...this.login}:undefined,models:this.catalog(),class2Supported:false,transport:'official-cli',modelDiscovery:{state:'aliases',verified:false,count:this.catalog().length}}}
 executablePath(){return this.executable}
 connectionGeneration(){return this.generation}
 async restore(){if(this.enabled)try{await this.check()}catch{/* Status retains the actionable error. */}return this.status()}
 async action(raw:unknown){
  const input=actionSchema.parse(raw);if(this.closed)throw new ClaudeCodeError('The official-client connection is stopping.',409);
  if(input.executable!==undefined&&input.executable!==this.executable){const generation=await this.revoke();if(generation!==this.generation)return this.status();this.executable=input.executable;this.connected=false;this.authState='unknown';this.version=undefined;this.signatureVerified=false;this.enabled=false;this.persist()}
  if(input.action==='disconnect')return this.disconnect();
  if(input.action==='cancel-login'){await this.revoke();this.operation=null;this.login={phase:'cancelled'};this.changed();return this.status()}
  if(input.action==='login')return this.startLogin();
  return this.check();
 }
 private async check(){
  const generation=await this.revoke();if(this.closed)throw new ClaudeCodeError('The official-client connection is stopping.',409);if(generation!==this.generation)return this.status();
  const controller=new AbortController();this.active=controller;this.operation='checking';this.error=undefined;this.changed();
  return this.track((async()=>{try{
   const info=(this.options.inspect??inspectClaudeCodeExecutable)(this.configuration());
   this.executable=info.executable;this.installed=true;this.version=info.version;this.signatureVerified=info.signatureVerified;
   // Auth is a CLI subcommand, not an agent turn. Inference options include
   // variadic tool lists which would consume "auth status" as tool names.
   const run=await (this.options.run??runClaudeCodeCommand)(this.configuration(),['auth','status','--json'],undefined,controller.signal,30000);
   if(this.closed||generation!==this.generation)return this.status();
   if(run.code!==0&&run.code!==1)throw new ClaudeCodeError('The official client could not check sign-in. Run its own authentication command, then check again.',409);
   const value=normalizeAuth(run.stdout);if((run.code===0)!==value.connected)throw new ClaudeCodeError('The official client returned inconsistent authentication status.',409);
   this.authMethod=value.authMethod;
   if(value.connected&&value.authMethod!=='claude.ai')throw new ClaudeCodeError('This connection requires the official client signed in with your Claude subscription. Its current authentication method may use API billing or another provider; no model request was sent.',409);
   this.connected=value.connected;this.authState=value.connected?'ready':'signed_out';this.enabled=value.connected;
   if(this.login&&value.connected)this.login={phase:'connected'};
   this.persist();return this.status();
  }catch(error){
   if(generation!==this.generation||this.closed)return this.status();
   this.connected=false;this.enabled=false;this.authState='error';this.error=error instanceof ClaudeCodeError?error.message:'The official client could not check this connection. Verify its installation and sign-in.';this.persist();return this.status();
  }finally{if(generation===this.generation){this.operation=null;this.active=undefined;this.changed()}}})()).then(()=>this.status());
 }
 private async startLogin(){
  // Adopt an existing official subscription sign-in before opening a browser.
  // A failed status check is actionable and must not launch an agent/login as
  // an implicit fallback.
  const checked=await this.check();if(checked.ready||checked.authState!=='signed_out')return checked;
  const generation=await this.revoke();if(this.closed)throw new ClaudeCodeError('The official-client connection is stopping.',409);if(generation!==this.generation)return this.status();
  let info:ReturnType<typeof inspectClaudeCodeExecutable>;
  try{info=(this.options.inspect??inspectClaudeCodeExecutable)(this.configuration())}catch(error){
   this.connected=false;this.enabled=false;this.authState='error';this.operation=null;this.login={phase:'error'};
   this.error=error instanceof ClaudeCodeError?error.message:'The official client installation could not be verified in this environment.';this.persist();this.changed();return this.status();
  }
  this.executable=info.executable;this.installed=true;this.version=info.version;this.signatureVerified=info.signatureVerified;
  const controller=new AbortController();this.active=controller;this.operation='signing_in';this.login={phase:'waiting'};this.error=undefined;this.connected=false;this.enabled=false;this.changed();
  let output='';
  const pending=(async()=>{try{
   const run=await (this.options.run??runClaudeCodeCommand)(this.configuration(),['auth','login','--claudeai'],undefined,controller.signal,300000,text=>{
    if(generation!==this.generation||this.closed)return;
    output=(output+text).slice(-65536);const authorizationUrl=claudeCodeAuthorizationUrl(output);
    if(authorizationUrl&&this.login?.authorizationUrl!==authorizationUrl){this.login={phase:'waiting',authorizationUrl};this.changed()}
   });
   if(generation!==this.generation||this.closed)return;
   if(run.code!==0)throw new ClaudeCodeError('The official sign-in did not complete. Try again through the official client.',409);
   await this.check();
  }catch(error){if(generation===this.generation&&!this.closed){this.login={phase:controller.signal.aborted?'cancelled':'error'};this.authState='error';this.error=error instanceof ClaudeCodeError?error.message:'The official sign-in did not complete. Check the official client.';this.operation=null;this.active=undefined;this.changed()}}})();
  this.track(pending);return this.status();
 }
 private async disconnect(){await this.revoke();this.enabled=false;this.connected=false;this.authState='unknown';this.authMethod='unknown';this.operation=null;this.login=undefined;this.error=undefined;this.persist();this.changed();return this.status()}
 stream(model:any,context:any,options:any={}){
  if(options.dataClass==='class2')throw new ClaudeCodeError('Claude Code is unavailable in Class 2 mode until its complete confinement is verified.',403);
  if(!this.available())throw new ClaudeCodeError('Check the official-client connection in Settings → Connections before using this model.',409);
  if((model.claudeCodeExecutable!==undefined&&model.claudeCodeExecutable!==this.executable)||(model.claudeCodeGeneration!==undefined&&model.claudeCodeGeneration!==this.generation))throw new ClaudeCodeError('The official-client connection changed. Choose a current model and start this turn again.',409);
  this.driver??=(this.options.driver??(options=>new ClaudeCodeModelProvider(options)))(this.configuration());
  return this.driver.stream(model,context,options);
 }
 async close(){if(this.closed)return;this.closed=true;await this.revoke();await Promise.allSettled(this.pending);this.listeners.clear()}
}
