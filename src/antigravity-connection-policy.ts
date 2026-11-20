import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,chmodSync,statSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {z} from 'zod';
import {discoverAntigravityModels} from './antigravity-provider';

export type AntigravityTransport='direct'|'cli';
export type AntigravityPrerequisite={installed:boolean;compatible:boolean;signedIn:boolean;detail?:string;checkedAt?:number;evidence?:'official-acp-session'|'official-client-check'};
export class AntigravityConnectionPolicyError extends Error{constructor(message:string,readonly status=409){super(message)}}
type DirectService={status:()=>any;available:()=>boolean;onChange:(listener:()=>void)=>()=>void;
 connect:()=>Promise<any>;authenticate:(raw:unknown)=>Promise<any>;refresh:()=>Promise<any>;disconnect:()=>Promise<any>;
 auth?:{cancel?:()=>void}};
type CliService={status:()=>any;available:()=>boolean;onChange:(listener:()=>void)=>()=>void;
 connect:()=>Promise<any>;authenticate:(raw:unknown)=>Promise<any>;refresh:()=>Promise<any>;disconnect:()=>Promise<any>;executablePath?:()=>string;
 auth:{status:()=>any;connect:()=>Promise<any>;create?:(raw:unknown)=>Promise<any>;refresh?:(id:string)=>Promise<any>;snapshot?:(id:string)=>any;disconnect:()=>Promise<any>}};
export type AntigravityClientCheckInput={executable:string;sessionId?:string;signal:AbortSignal};
export type AntigravityClientCheckResult=AntigravityPrerequisite&{sessionId?:string};
export type AntigravityConnectionPolicyOptions={direct:DirectService;cli:CliService;
 checkClient?:(input:AntigravityClientCheckInput)=>Promise<AntigravityClientCheckResult>;
 /** Test seam for the documented catalog command, never configurable by HTTP. */
 discover?:typeof discoverAntigravityModels;
 now?:()=>number;prerequisiteMaxAgeMs?:number};
const policySchema=z.object({version:z.literal(1),enabled:z.boolean(),transport:z.enum(['direct','cli']),checkSessionId:z.string().uuid().optional()}).strict();
const configureSchema=z.object({enabled:z.boolean().optional(),transport:z.enum(['direct','cli']).optional()}).strict().refine(value=>value.enabled!==undefined||value.transport!==undefined);
const resultSchema=z.object({installed:z.boolean(),compatible:z.boolean(),signedIn:z.boolean(),
 evidence:z.enum(['official-acp-session','official-client-check']).optional(),sessionId:z.string().uuid().optional()});
const unknownPrerequisite:AntigravityPrerequisite={installed:false,compatible:false,signedIn:false,detail:'Check the installed official client before using this experimental connection.'};
const ready=(value:AntigravityPrerequisite)=>value.installed&&value.compatible&&value.signedIn;

/** Explicit opt-in and official-client prerequisite; never a credential source. */
export class AntigravityConnectionPolicy{
 private file:string;private enabled=false;private transport:AntigravityTransport='direct';private checkSessionId?:string;
 private prerequisite:AntigravityPrerequisite={...unknownPrerequisite};private revision=0;private closed=false;
 private lifecycle=new AbortController();private checkController?:AbortController;private pending?:Promise<any>;
 private tasks=new Set<Promise<unknown>>();private listeners=new Set<()=>void>();private unsubscribes:Array<()=>void>=[];
 constructor(profile:string,private options:AntigravityConnectionPolicyOptions){
  this.file=join(profile,'local-auth','antigravity-connection-policy.json');
  if(existsSync(this.file))try{
   const bytes=readFileSync(this.file);if(bytes.length>16384)throw Error();const saved=policySchema.parse(JSON.parse(bytes.toString('utf8')));
   this.enabled=saved.enabled;this.transport=saved.transport;this.checkSessionId=saved.checkSessionId;
  }catch{this.prerequisite={...unknownPrerequisite,detail:'The saved experimental connection settings could not be read. Configure and check the connection again.'}}
  else this.enabled=this.options.direct.status().connected===true;
  // Existing direct credentials preserve opt-in only. They never prove that the
  // official application is installed, compatible, or signed in.
  this.unsubscribes.push(options.direct.onChange(()=>this.changed()),options.cli.onChange(()=>this.changed()));
 }
 onChange(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
 private changed(){for(const listener of this.listeners)listener()}
 private now(){return (this.options.now??Date.now)()}
 private persist(){mkdirSync(dirname(this.file),{recursive:true,mode:0o700});const temporary=this.file+'.tmp';writeFileSync(temporary,JSON.stringify({version:1,enabled:this.enabled,transport:this.transport,...this.checkSessionId?{checkSessionId:this.checkSessionId}:{}}),{mode:0o600});chmodSync(temporary,0o600);renameSync(temporary,this.file)}
 private invalidate(){++this.revision;this.lifecycle.abort();this.lifecycle=new AbortController();this.checkController?.abort();this.checkController=undefined;this.pending=undefined}
 private fresh(){return this.prerequisite.checkedAt!==undefined&&this.now()-this.prerequisite.checkedAt>=0&&this.now()-this.prerequisite.checkedAt<=(this.options.prerequisiteMaxAgeMs??300000)}
 signal(){return this.lifecycle.signal}
 selectedTransport(){return this.transport}
 connectionGeneration(){return this.revision}
 status(){
  const selected=this.transport==='direct'?this.options.direct.status():this.options.cli.status();
  return {...this.options.direct.status(),...this.transport==='cli'?selected:{},
   connected:selected.connected===true&&this.enabled&&ready(this.prerequisite)&&this.fresh(),ready:this.available(this.transport),
   prerequisite:{...this.prerequisite},experimental:{enabled:this.enabled,transport:this.transport},class2Supported:false,
   detail:!this.enabled?'This experimental connection is disabled.':!this.fresh()?'Check the official client before sending another request.':this.prerequisite.detail};
 }
 assertAvailable(transport:AntigravityTransport,dataClass:'standard'|'class2'='standard'){
  if(dataClass==='class2')throw new AntigravityConnectionPolicyError('Antigravity is unavailable in Class 2 mode until its complete confinement is verified.',403);
  if(this.closed||!this.enabled)throw new AntigravityConnectionPolicyError('Enable the experimental Antigravity connection in Connections before using it.');
  if(transport!==this.transport)throw new AntigravityConnectionPolicyError('This Antigravity transport is not selected. Choose it explicitly in Connections; no fallback was attempted.');
  if(!this.fresh()||!ready(this.prerequisite))throw new AntigravityConnectionPolicyError('A compatible installed official Antigravity client and successful official sign-in check are required before sending this request.');
 }
 async ensureAvailable(transport:AntigravityTransport,dataClass:'standard'|'class2'='standard'){
  if(dataClass==='class2'||this.closed||!this.enabled||transport!==this.transport)this.assertAvailable(transport,dataClass);
  if(!this.fresh())await this.checkClient();this.assertAvailable(transport,dataClass);
 }
 available(transport:AntigravityTransport=this.transport){try{this.assertAvailable(transport);return (transport==='direct'?this.options.direct:this.options.cli).available()}catch{return false}}
 async configure(raw:unknown){
  const input=configureSchema.parse(raw);if(this.closed)throw new AntigravityConnectionPolicyError('The Antigravity connection is stopping.');
  if(input.enabled!==undefined)this.enabled=input.enabled;if(input.transport!==undefined)this.transport=input.transport;
  this.invalidate();this.persist();this.changed();return this.status();
 }
 async restore(){if(this.enabled)await this.checkClient();return this.status()}
 checkClient(){
  if(this.closed)return Promise.reject(new AntigravityConnectionPolicyError('The Antigravity connection is stopping.'));
  if(this.pending)return this.pending;
  const revision=this.revision,controller=new AbortController();this.checkController=controller;
  const executable=this.options.cli.executablePath?.()||this.options.cli.status().executable||'';
  const pending=(async()=>{try{
   const raw=await (this.options.checkClient??(input=>this.defaultClientCheck(input)))({executable,sessionId:this.checkSessionId,signal:controller.signal});
   if(this.closed||revision!==this.revision||controller.signal.aborted)return this.status();
   const value=resultSchema.parse(raw);
   if((value.signedIn||value.compatible)&&!value.installed||value.signedIn&&!value.compatible||value.signedIn&&!value.evidence)throw Error();
   const before=ready(this.prerequisite);
   this.prerequisite={installed:value.installed,compatible:value.compatible,signedIn:value.signedIn,checkedAt:this.now(),...value.evidence?{evidence:value.evidence}:{},
    detail:!value.installed?'Install the official Antigravity client, then check again.':!value.compatible?'The installed official client did not complete the compatibility check.':!value.signedIn?'The official client has not confirmed a signed-in account. Finish its own sign-in, then check again.':'The compatible official client accepted an authenticated connection check. No model inference was requested.'};
   if(value.sessionId)this.checkSessionId=value.sessionId;
   if(before&&!ready(this.prerequisite)){this.lifecycle.abort();this.lifecycle=new AbortController()}
   this.persist();this.changed();return this.status();
  }catch{
   if(!this.closed&&revision===this.revision&&!controller.signal.aborted){this.prerequisite={...unknownPrerequisite,checkedAt:this.now(),detail:'The official client check could not be completed. Verify its installation and sign-in. No model request was sent.'};this.lifecycle.abort();this.lifecycle=new AbortController();this.changed()}
   return this.status();
  }finally{if(this.checkController===controller)this.checkController=undefined}})();
  this.pending=pending;this.tasks.add(pending);void pending.finally(()=>{this.tasks.delete(pending);if(this.pending===pending)this.pending=undefined}).catch(()=>{});return pending;
 }
 private async defaultClientCheck(input:AntigravityClientCheckInput):Promise<AntigravityClientCheckResult>{
  input.signal.throwIfAborted();
  let installed=false;try{installed=isAbsolute(input.executable)&&statSync(input.executable).isFile()}catch{/* Missing client. */}
  if(!installed)return {installed:false,compatible:false,signedIn:false};
  // The existing adapter verifies the vendor signature/version and runs a
  // documented catalog command. A catalog alone is not sign-in evidence.
  try{await (this.options.discover??discoverAntigravityModels)(input.executable,{signal:input.signal,timeoutMs:30000,allowSharedCustomizations:this.options.cli.status().allowSharedCustomizations===true})}
  catch{return {installed:true,compatible:false,signedIn:false}}
  input.signal.throwIfAborted();
  const auth=this.options.cli.auth;
  if(auth.status().activeSessionId||auth.status().operation||auth.status().authState==='waiting')return {installed:true,compatible:true,signedIn:false};
  try{
   await auth.connect();input.signal.throwIfAborted();let sessionId=input.sessionId;
   if(sessionId&&auth.refresh){
    if(auth.snapshot?.(sessionId)?.session?.title!=='Chimeric connection check')return {installed:true,compatible:true,signedIn:false};
    await auth.refresh(sessionId);
   }else{
    if(!auth.create)return {installed:true,compatible:true,signedIn:false};
    const created=await auth.create({title:'Chimeric connection check'});sessionId=created?.session?.id;
   }
   input.signal.throwIfAborted();const signedIn=auth.status().authState==='ready';
   return {installed:true,compatible:true,signedIn,...signedIn?{evidence:'official-acp-session' as const}:{},...sessionId?{sessionId}:{}};
  }catch{return {installed:true,compatible:true,signedIn:false}}
 }
 async signin(raw?:unknown){
  if(this.transport==='direct'){await this.ensureAvailable('direct');await this.options.direct.authenticate(raw??{method:'browser'})}
  else{
   if(this.closed||!this.enabled)throw new AntigravityConnectionPolicyError('Enable the experimental connection before sign-in.');
   await this.options.cli.connect();if(raw!==undefined)await this.options.cli.authenticate(raw);
  }
  this.changed();return this.status();
 }
 async refresh(){await this.ensureAvailable(this.transport);await (this.transport==='direct'?this.options.direct:this.options.cli).refresh();this.changed();return this.status()}
 async cancel(){this.invalidate();if(this.transport==='direct')this.options.direct.auth?.cancel?.();else await this.options.cli.disconnect();this.changed();return this.status()}
 async disconnect(){this.enabled=false;this.invalidate();this.persist();await (this.transport==='direct'?this.options.direct:this.options.cli).disconnect();this.changed();return this.status()}
 async close(){if(this.closed)return;this.closed=true;this.invalidate();for(const unsubscribe of this.unsubscribes)unsubscribe();await Promise.allSettled(this.tasks);this.listeners.clear()}
}
