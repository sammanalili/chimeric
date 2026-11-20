import {existsSync} from 'node:fs';
import {Registry} from './registry';
import {ConfidentialityManager} from './confidentiality-manager';
import {SttSettingsManager,SttSettingsError} from './stt-settings';
import {SttError,createRecordedVoiceBridge,sttEndpoint,validateSpeechCapture,type SttCapture,type SttTarget,type SttChange} from './stt';
import {connectionBindingDigest,type SessionContext} from './session-policy';
import type {LocalASR} from './voice';

const modes=new Set(['audio_transcription','transcription','speech-to-text','stt']);
type CaptureState={context?:SessionContext;settingsRevision:number};
/** Records are held locally until Stop. A saved speech selection grants only
 * transcription, never chat-model access or a fallback billing route. */
export class NativeSpeechManager {
 readonly settings:SttSettingsManager;readonly VoiceBridge:ReturnType<typeof createRecordedVoiceBridge>;
 private captures=new WeakMap<object,CaptureState>();private listeners=new Set<(change:SttChange)=>void>();private unwatch:Array<()=>void>=[];
 private closed=false;
 constructor(readonly registry:Registry,readonly confidentiality:ConfidentialityManager,private asr:Pick<LocalASR,'start'|'transcribe'|'stop'>,private options:{localStatus?:()=>{ready:boolean;name:string};changed?:()=>void;fetch?:typeof fetch}={}){
  const policy=confidentiality.policy;
  this.settings=new SttSettingsManager(registry.profileDir,{
   listConnections:()=>Object.entries(registry.config.providers).filter(([,p])=>p.enabled&&['openai-completions','openai-responses'].includes(p.api)).map(([id,p])=>({id,name:p.name,endpointUrl:sttEndpoint({connectionId:id,baseUrl:p.baseUrl,modelId:'metadata',connectionRevision:p.revision,credentialRevision:confidentiality.binding(id)?.credentialRevision??'keyless',allowInsecureHttp:p.allowInsecureHttp}),ready:registry.statuses[id]?.ready===true,models:[...registry.models.values()].filter(model=>model.provider===id&&modes.has(model.mode)&&model.available!==false).map(model=>({id:model.id,name:model.name}))})).filter(connection=>connection.models.length),
   localStatus:()=>options.localStatus?.()??{ready:existsSync(registry.config.voice.python)&&existsSync(registry.config.voice.runtimeRoot),name:'Local speech recognition'},
   resolveTarget:(connectionId,modelId)=>{const binding=confidentiality.binding(connectionId),provider=registry.config.providers[connectionId],model=registry.models.get(connectionId+'::'+modelId);if(!binding||!provider||!model||!modes.has(model.mode))return;
    return {binding,target:{connectionId,name:provider.name,baseUrl:binding.endpoint,modelId,connectionRevision:binding.revision,credentialRevision:binding.credentialRevision,allowInsecureHttp:provider.allowInsecureHttp}};
   },policy,changed:()=>options.changed?.(),
  });
  const emit=(change:SttChange)=>{for(const listener of this.listeners)try{listener(change)}catch{}};
  this.unwatch.push(policy.subscribe(emit),this.settings.subscribe(emit));
  this.VoiceBridge=createRecordedVoiceBridge({
   capture:(options,signal)=>this.capture(options,signal),assertCurrent:capture=>this.assertCurrent(capture),subscribeChanges:listener=>{this.listeners.add(listener);return()=>this.listeners.delete(listener)},
   resolveAuth:async(target,signal)=>{signal.throwIfAborted();this.assertTarget(target);const apiKey=registry.getPrivateCredential(target.connectionId);return {apiKey,assertCurrent:()=>this.assertTarget(target)}},
   transcribeLocal:async(pcm,language,signal)=>{signal.throwIfAborted();const text=await asr.transcribe(pcm,language);signal.throwIfAborted();return text},fetch:options.fetch,redact:message=>registry.safeError(new Error(message)),
  });
 }
 private assertTarget(target:SttTarget){const binding=this.confidentiality.binding(target.connectionId);if(!binding||binding.endpoint!==target.baseUrl||binding.revision!==target.connectionRevision||binding.credentialRevision!==target.credentialRevision||!this.registry.config.providers[target.connectionId]?.enabled||!this.registry.statuses[target.connectionId]?.ready)throw new SttError('scope_changed','The speech connection changed. Save its selection again before recording.');this.confidentiality.policy.assertBindingCurrent(binding)}
 async capture(raw:unknown,signal:AbortSignal):Promise<SttCapture>{
  const options=raw as any;signal.throwIfAborted();if(options?.frameId!==undefined&&(typeof options.frameId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(options.frameId)))throw new SttError('invalid_request','Choose a valid research chat before recording.');
  const context=options?.frameId?await this.confidentiality.ownedContext(options.frameId):undefined,p=context?this.confidentiality.policy.policy(context):undefined;
  let target:SttCapture['target']={kind:'local',name:'Local speech recognition'};
  if(p?.mode==='class2'){
   const approved=this.confidentiality.policy.sttFor(context!),selected=this.settings.resolveSelected();
   if(approved.kind!=='connection'||!selected)throw new SttError('unavailable','Choose an approved HTTPS speech model in Connections before recording in Class 2.');
   if(connectionBindingDigest(approved.connection)!==connectionBindingDigest(this.confidentiality.binding(selected.connectionId)!))throw new SttError('scope_changed','The approved speech destination changed.');
   this.assertTarget(selected);target={kind:'remote',...selected};
  }else {await this.asr.start();signal.throwIfAborted()}
  const capture=Object.freeze({frameId:context?.frameId??'new-draft',rootFrameId:context?.rootFrameId??'new-draft',policyRevision:p?.revision??0,dataClass:p?.mode==='class2'?'class2' as const:'standard' as const,context,target:Object.freeze(target)});
  validateSpeechCapture(capture);this.captures.set(capture,{context,settingsRevision:this.settings.snapshot().revision});await this.assertCurrent(capture);return capture;
 }
 async assertCurrent(capture:SttCapture){
  const state=this.captures.get(capture);if(!state)throw new SttError('scope_changed','The speech capture has no trusted native context.');
  if(state.context){await this.confidentiality.policy.revalidateContext(state.context);const p=this.confidentiality.policy.policy(state.context);if(p.revision!==capture.policyRevision||(p.mode==='class2')!==(capture.dataClass==='class2'))throw new SttError('scope_changed','The chat confidentiality setting changed during recording.')}
  if(capture.target.kind==='remote'){
   if(this.settings.snapshot().revision!==state.settingsRevision)throw new SttError('scope_changed','The speech selection changed during recording.');this.assertTarget(capture.target);
   const selected=this.settings.resolveSelected();if(!selected||selected.connectionId!==capture.target.connectionId||selected.modelId!==capture.target.modelId)throw new SttError('scope_changed','The speech model changed during recording.');
   const approved=this.confidentiality.policy.sttFor(state.context!);if(approved.kind!=='connection'||connectionBindingDigest(approved.connection)!==connectionBindingDigest(this.confidentiality.binding(selected.connectionId)!))throw new SttError('scope_changed','The speech permission changed during recording.');
  }
 }
 close(){if(this.closed)return;this.closed=true;this.settings.close();for(const remove of this.unwatch)remove();this.listeners.clear();this.asr.stop()}
}

/** An optional speech store must not prevent ordinary research from starting.
 * Preserve the unreadable file; never replace it or choose an outside fallback. */
export function createNativeSpeechManager(...args:ConstructorParameters<typeof NativeSpeechManager>){
 try{return new NativeSpeechManager(...args)}catch{
  const message='The saved speech settings could not be read. Restore them before recording. No outside fallback was used.';
  const unavailable=()=>{throw new SttSettingsError(message,503)};
  const settings={snapshot:unavailable,configure:unavailable,safeError:()=>message,close:()=>{}};
  class UnavailableVoiceBridge{
   private closed=false;
   constructor(private downstream:{sendEvent:(event:any)=>void;close:()=>void},_options:any){}
   async start(){if(this.closed)return;this.downstream.sendEvent({type:'error',code:'stt_unavailable',message});this.finish()}
   handleBrowserMessage(_data:any,_binary:boolean){}
   handleBrowserClose(){this.closed=true}
   private finish(){if(this.closed)return;this.closed=true;this.downstream.sendEvent({type:'closed',reason:'speech unavailable'});this.downstream.close()}
  }
  return {settings,VoiceBridge:UnavailableVoiceBridge,close:()=>args[2].stop()};
 }
}
