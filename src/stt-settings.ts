import {mkdirSync,chmodSync,existsSync,readFileSync,writeFileSync,renameSync,unlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {connectionBindingDigest,normalizeConnectionBinding,type ConnectionBinding,type SessionPolicyStore} from './session-policy';
import {sttEndpoint,type SttTarget} from './stt';

export type SpeechConnection={id:string;name:string;endpointUrl:string;ready:boolean;models:ReadonlyArray<{id:string;name:string}>};
export type SpeechSelection={connectionId:string;modelId:string};
export type SpeechResolved={target:SttTarget;binding:ConnectionBinding};
export type SttSettingsDependencies={
 /** Cached metadata only. Saving a selection must not discover models, obtain
  * credentials, test a model, or send network requests. */
 listConnections:()=>ReadonlyArray<SpeechConnection>;
 localStatus:()=>{ready:boolean;name:string};
 resolveTarget:(connectionId:string,modelId:string)=>SpeechResolved|undefined;
 policy:Pick<SessionPolicyStore,'snapshot'|'selectStt'|'isApproved'|'assertBindingCurrent'>;
 changed?:()=>void;
 writeJson?:(path:string,value:unknown)=>void;
};
const id=z.string().trim().min(1).max(255),modelId=z.string().trim().min(1).max(512);
const selection=z.object({connectionId:id,modelId}).strict();
const document=z.object({schemaVersion:z.literal(1),revision:z.number().int().nonnegative(),selected:selection.nullable()}).strict();
const mutation=z.object({expectedRevision:z.number().int().nonnegative(),connectionId:id.nullable(),modelId:modelId.optional()}).strict();
export class SttSettingsError extends Error{constructor(message:string,readonly status=400){super(message);this.name='SttSettingsError'}}
function atomic(file:string,value:unknown){const temporary=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temporary,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,file);chmodSync(file,0o600)}finally{try{unlinkSync(temporary)}catch{}}}

/** Selection and policy approval live in different private stores. A pending
 * marker prevents capture after a partial commit, including after restart.
 * An explicit save repairs the selection; this class never falls back. */
export class SttSettingsManager{
 private state:z.infer<typeof document>={schemaVersion:1,revision:0,selected:null};
 private file:string;private pending:string;private recovery=false;private committing=false;private closed=false;private listeners=new Set<(change:{kind:'stt'|'closed'})=>void>();
 constructor(profile:string,private deps:SttSettingsDependencies){
  const directory=join(profile,'speech');mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);this.file=join(directory,'settings.json');this.pending=join(directory,'selection-pending.json');
  if(existsSync(this.file)){if(statSync(this.file).size>65536)throw new SttSettingsError('The saved speech settings exceed their size limit.',503);try{this.state=document.parse(JSON.parse(readFileSync(this.file,'utf8')))}catch{throw new SttSettingsError('The saved speech settings could not be read. Restore them before recording.',503)}}
  this.recovery=existsSync(this.pending);
 }
 private open(){if(this.closed)throw new SttSettingsError('Speech settings are closed.',503)}
 private write(file:string,value:unknown){(this.deps.writeJson??atomic)(file,value)}
 private publish(){for(const listener of this.listeners)try{listener({kind:'stt'})}catch{}try{this.deps.changed?.()}catch{}}
 safeError(error:unknown){return error instanceof SttSettingsError?error.message:'The speech settings could not be updated. No transcription request was sent.'}
 snapshot(){
  this.open();const local=this.deps.localStatus();
  return {revision:this.state.revision,selected:this.state.selected?{...this.state.selected}:null,
   connections:this.deps.listConnections().map(connection=>({id:connection.id,name:connection.name,endpointUrl:connection.endpointUrl,ready:connection.ready===true,models:connection.models.map(model=>({id:model.id,name:model.name}))})),
   local:{ready:local.ready===true,name:local.name},...(this.recovery?{warning:'The speech selection needs to be saved again before protected recording.'}:{})};
 }
 private resolve(selected:SpeechSelection):SpeechResolved{
  const connection=this.deps.listConnections().find(value=>value.id===selected.connectionId&&value.ready);
  if(!connection||!connection.models.some(value=>value.id===selected.modelId))throw new SttSettingsError('The selected speech connection or model is unavailable. Choose a ready speech connection.',409);
  const resolved=this.deps.resolveTarget(selected.connectionId,selected.modelId);if(!resolved)throw new SttSettingsError('The selected speech connection could not be resolved.',409);
  let binding:ConnectionBinding;try{binding=normalizeConnectionBinding(resolved.binding);sttEndpoint(resolved.target)}catch{throw new SttSettingsError('The selected speech connection has invalid destination metadata.',409)}
  const boundUrl=new URL(resolved.target.baseUrl);boundUrl.pathname=boundUrl.pathname.replace(/\/+$/,'')||'/';const baseUrl=boundUrl.href.replace(/\/$/,'');
  if(binding.id!==selected.connectionId||resolved.target.connectionId!==selected.connectionId||resolved.target.modelId!==selected.modelId||binding.endpoint!==baseUrl||binding.revision!==resolved.target.connectionRevision||binding.credentialRevision!==resolved.target.credentialRevision||connection.endpointUrl!==sttEndpoint(resolved.target))throw new SttSettingsError('The speech destination or credential binding changed. Reload the speech settings.',409);
  this.deps.policy.assertBindingCurrent(binding);return {target:Object.freeze({...resolved.target}),binding};
 }
 configure(raw:unknown){
  this.open();const input=mutation.parse(raw);if(input.expectedRevision!==this.state.revision)throw new SttSettingsError('Speech settings changed in another window. Reload before saving.',409);if(this.committing)throw new SttSettingsError('A speech settings change is already being saved.',409);
  if(input.connectionId&&!input.modelId)throw new SttSettingsError('Choose a speech model.');if(!input.connectionId&&input.modelId)throw new SttSettingsError('A local speech selection cannot include a remote model.');
  const selected=input.connectionId?{connectionId:input.connectionId,modelId:input.modelId!}:null,resolved=selected?this.resolve(selected):undefined;
  const policyRevision=this.deps.policy.snapshot().revision,next={schemaVersion:1 as const,revision:this.state.revision+1,selected};this.committing=true;
  try{
   this.write(this.pending,{schemaVersion:1,revision:next.revision});this.recovery=true;
   this.deps.policy.selectStt(resolved?.binding??null,policyRevision);
   this.write(this.file,next);this.state=next;unlinkSync(this.pending);this.recovery=false;this.publish();return this.snapshot();
  }catch(error){
   if(this.recovery)throw new SttSettingsError('The speech selection needs to be saved again before protected recording.',503);throw error;
  }finally{this.committing=false}
 }
 /** Call from an already authenticated, policy-checked Class 2 capture. For
  * ordinary sessions the parent must deliberately choose local recognition. */
 resolveSelected():SttTarget|null{
  this.open();if(this.recovery||this.committing)throw new SttSettingsError('The speech selection needs to be saved again before protected recording.',503);
  const selected=this.state.selected,policy=this.deps.policy.snapshot();
  if(!selected){if(policy.selectedStt)throw new SttSettingsError('The speech selection and its policy do not match. Save the speech selection again.',409);return null}
  const resolved=this.resolve(selected);
  if(!policy.selectedStt||connectionBindingDigest(policy.selectedStt)!==connectionBindingDigest(resolved.binding)||!this.deps.policy.isApproved(resolved.binding,'stt'))throw new SttSettingsError('The selected speech connection changed or is no longer approved. Save the speech selection again.',409);
  return resolved.target;
 }
 subscribe(listener:(change:{kind:'stt'|'closed'})=>void){this.open();this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 close(){if(this.closed)return;this.closed=true;for(const listener of this.listeners)try{listener({kind:'closed'})}catch{}this.listeners.clear()}
}
