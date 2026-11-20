/** Recorded speech transport. Only trusted native callbacks choose its scope
 * and destination; browser messages contain PCM16 bytes or stop/cancel only. */
export const sttLimits={sampleRate:16000,pcmBytes:9_600_000,captureMs:300_000,idleMs:45_000,timeoutMs:120_000,responseBytes:128*1024,transcriptBytes:64*1024,captures:2,controlBytes:2048} as const;
export type SttErrorCode='invalid_request'|'invalid_response'|'unavailable'|'http'|'network'|'timeout'|'cancelled'|'scope_changed'|'resource_limit';
export class SttError extends Error{constructor(readonly code:SttErrorCode,message:string,readonly status?:number){super(message);this.name='SttError'}}
export type SttTarget=Readonly<{connectionId:string;name?:string;baseUrl:string;modelId:string;connectionRevision:string;credentialRevision:string;modelRevision?:string|number;allowInsecureHttp?:boolean}>;
export type SttAuth={apiKey?:string;headers?:Record<string,string>;fetch?:typeof fetch;signal?:AbortSignal;assertCurrent?:()=>void|Promise<void>};
export type SttTransportDependencies={resolveAuth:(target:SttTarget,signal:AbortSignal)=>SttAuth|Promise<SttAuth>;fetch?:typeof fetch;redact?:(message:string)=>string};
export type SttTranscription={text:string;connectionId:string;model:string};
export type SttCapture=Readonly<{frameId:string;rootFrameId:string;policyRevision:string|number;dataClass:'standard'|'class2';context?:unknown;target:Readonly<{kind:'local';name?:string}>|Readonly<{kind:'remote'}&SttTarget>}>;
export type SttChange={kind?:string;rootFrameId?:string;connectionId?:string};
export type RecordedVoiceDependencies=SttTransportDependencies&{
 /** Resolve the actual frame and its policy from the native datastore. Never
  * construct this from a browser-supplied mode, root ID, endpoint or approval. */
 capture:(options:unknown,signal:AbortSignal)=>SttCapture|Promise<SttCapture>;
 assertCurrent:(capture:SttCapture,phase:'capture'|'upload'|'completion')=>void|Promise<void>;
 subscribeChanges:(listener:(change?:SttChange)=>void)=>()=>void;
 transcribeLocal?:(pcm:Buffer,language:string|undefined,signal:AbortSignal)=>string|Promise<string>;
 limits?:Partial<Record<'pcmBytes'|'captureMs'|'idleMs'|'timeoutMs'|'captures',number>>;
};
const invalid=(message:string):never=>{throw new SttError('invalid_request',message)};
const stopped=()=>new SttError('cancelled','Speech transcription was cancelled.');
function abortable<T>(pending:PromiseLike<T>|T,signal:AbortSignal):Promise<T>{
 if(signal.aborted)return Promise.reject(stopped());
 return new Promise((resolve,reject)=>{const cancel=()=>{cleanup();reject(stopped())},cleanup=()=>signal.removeEventListener('abort',cancel);signal.addEventListener('abort',cancel,{once:true});Promise.resolve(pending).then(value=>{cleanup();signal.aborted?reject(stopped()):resolve(value)},error=>{cleanup();reject(error)})});
}
function text(value:unknown,max=512):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)}
function target(value:SttTarget):SttTarget{
 if(!value||!text(value.connectionId,255)||!text(value.modelId)||!text(value.connectionRevision,255)||!text(value.baseUrl,8192)||!(/^(?:[a-f0-9]{64}|keyless)$/.test(value.credentialRevision)))invalid('A complete bound speech connection is required.');
 if(value.modelRevision!==undefined&&!(text(value.modelRevision,255)||Number.isSafeInteger(value.modelRevision)))invalid('The speech model revision is invalid.');
 let url:URL;try{url=new URL(value.baseUrl)}catch{return invalid('Choose a complete speech connection URL.')}
 if(url.username||url.password||url.search||url.hash||/%(?:2f|5c|2e)/i.test(value.baseUrl))invalid('Speech connection URLs cannot contain credentials, queries, fragments or encoded path separators.');
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if(url.protocol!=='https:'&&!(url.protocol==='http:'&&(local||value.allowInsecureHttp===true)))invalid('Speech connections require HTTPS, except for explicitly permitted HTTP destinations.');
 url.pathname=url.pathname.replace(/\/+$/,'');
 return Object.freeze({...value,baseUrl:url.href.replace(/\/$/,'')});
}
export function sttEndpoint(binding:SttTarget):string{const url=new URL(target(binding).baseUrl);url.pathname=url.pathname.replace(/\/+$/,'')+'/audio/transcriptions';return url.href}
function languageCode(value:unknown):string|undefined{
 if(value===undefined||value===null||value===''||value==='auto')return;
 if(typeof value!=='string'||!/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(value)||value.length>35)invalid('Choose a valid speech language or automatic detection.');
 return value.split(/[-_]/)[0].toLowerCase();
}
export function encodePcm16Wav(pcm:Uint8Array):Buffer{
 if(!(pcm instanceof Uint8Array)||pcm.byteLength<2||pcm.byteLength%2||pcm.byteLength>sttLimits.pcmBytes)invalid('Provide a nonempty recording of 16 kHz mono PCM16 audio within the recording limit.');
 const result=Buffer.alloc(44+pcm.byteLength);result.write('RIFF',0);result.writeUInt32LE(36+pcm.byteLength,4);result.write('WAVE',8);result.write('fmt ',12);result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(1,22);result.writeUInt32LE(sttLimits.sampleRate,24);result.writeUInt32LE(sttLimits.sampleRate*2,28);result.writeUInt16LE(2,32);result.writeUInt16LE(16,34);result.write('data',36);result.writeUInt32LE(pcm.byteLength,40);result.set(pcm,44);return result;
}
async function boundedBody(response:Response,signal:AbortSignal):Promise<string>{
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>sttLimits.responseBytes)){void response.body?.cancel().catch(()=>{});throw new SttError('invalid_response','The speech response exceeds its size limit.')}
 if(!response.body)throw new SttError('invalid_response','The speech endpoint returned no response body.');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
 try{while(true){const item=await abortable(reader.read(),signal);if(item.done)break;bytes+=item.value.byteLength;if(bytes>sttLimits.responseBytes)throw new SttError('invalid_response','The speech response exceeds its size limit.');chunks.push(item.value)}return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes))}
 catch(error){void reader.cancel().catch(()=>{});if(error instanceof SttError)throw error;throw new SttError('invalid_response','The speech endpoint returned invalid response data.')}
 finally{try{reader.releaseLock()}catch{}}
}
/** Exactly one multipart request. This function never retries, streams partial
 * audio, switches a connection, or falls back to another transcription route. */
export async function transcribePcm16(request:{target:SttTarget;pcm:Uint8Array;language?:string;signal?:AbortSignal;timeoutMs?:number},deps:SttTransportDependencies):Promise<SttTranscription>{
 const binding=target(request.target),endpoint=sttEndpoint(binding),language=languageCode(request.language),timeout=request.timeoutMs??sttLimits.timeoutMs;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>sttLimits.timeoutMs)invalid('Choose a speech request timeout within 120 seconds.');
 if(request.signal?.aborted)throw stopped();const wav=encodePcm16Wav(request.pcm),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
 const initial=request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal;let effective=initial;
 try{
  const auth=await abortable(deps.resolveAuth(binding,initial),initial);effective=auth.signal?AbortSignal.any([initial,auth.signal]):initial;
  await abortable(auth.assertCurrent?.(),effective);
  const headers=new Headers(auth.headers);
  for(const name of ['cookie','set-cookie','content-type','content-length','host','connection'])if(headers.has(name))invalid('The speech credential resolver supplied a forbidden request header.');
  if(auth.apiKey!==undefined){if(!text(auth.apiKey,16384))invalid('The speech API key is invalid.');headers.set('authorization','Bearer '+auth.apiKey)}
  const body=new FormData();body.set('file',new Blob([wav],{type:'audio/wav'}),'recording.wav');body.set('model',binding.modelId);body.set('response_format','json');if(language)body.set('language',language);
  effective.throwIfAborted();await abortable(auth.assertCurrent?.(),effective);
  const response=await abortable((auth.fetch??deps.fetch??fetch)(endpoint,{method:'POST',headers,body,signal:effective,credentials:'omit',redirect:'error',cache:'no-store'}),effective);
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new SttError('http','The selected speech endpoint returned HTTP '+response.status+'. No request was retried.',response.status)}
  if(!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type')??'')){void response.body?.cancel().catch(()=>{});throw new SttError('invalid_response','The speech endpoint did not return JSON.')}
  const raw=await boundedBody(response,effective);let value:any;try{value=JSON.parse(raw)}catch{throw new SttError('invalid_response','The speech endpoint returned invalid JSON.')}
  if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.text!=='string'||value.text.includes('\0')||Buffer.byteLength(value.text)>sttLimits.transcriptBytes)throw new SttError('invalid_response','The speech endpoint returned an invalid or oversized transcript.');
  await abortable(auth.assertCurrent?.(),effective);effective.throwIfAborted();
  return {text:value.text,connectionId:binding.connectionId,model:binding.modelId};
 }catch(error){
  if(controller.signal.aborted)throw new SttError('timeout','Speech transcription timed out. No request was retried.');
  if(effective.aborted)throw stopped();if(error instanceof SttError)throw error;
  throw new SttError('network','The speech request could not complete at the selected endpoint. No request was retried.');
 }finally{clearTimeout(timer);wav.fill(0)}
}

function captureKey(capture:SttCapture){return JSON.stringify([capture.frameId,capture.rootFrameId,capture.policyRevision,capture.dataClass,capture.target])}
/** Shape/transport validation for a trusted native capture, also reusable by
 * preflight. The caller must still authorize its native frame and policy. */
export function validateSpeechCapture(capture:SttCapture){
 if(!capture||!text(capture.frameId,255)||!text(capture.rootFrameId,255)||!['standard','class2'].includes(capture.dataClass)||!(text(capture.policyRevision,255)||Number.isSafeInteger(capture.policyRevision))||!capture.target||!['local','remote'].includes(capture.target.kind))invalid('A trusted native speech capture context is required.');
 if(capture.target.kind==='remote'){const bound=target(capture.target);if(capture.dataClass==='class2'&&new URL(bound.baseUrl).protocol!=='https:')throw new SttError('unavailable','Protected speech transcription requires an approved HTTPS connection.')}
 return capture;
}
export function speechDestination(capture:SttCapture){validateSpeechCapture(capture);return capture.target.kind==='local'?{kind:'local' as const,name:capture.target.name??'Local speech recognition'}:{kind:'remote' as const,name:capture.target.name??capture.target.connectionId,connectionId:capture.target.connectionId,endpoint:sttEndpoint(capture.target),model:capture.target.modelId}}

/** A separate record/stop bridge prevents the overlapping interim decodes in
 * the local streaming bridge from becoming repeated external uploads. */
export function createRecordedVoiceBridge(deps:RecordedVoiceDependencies){
 const limits={...sttLimits,...deps.limits};for(const key of ['pcmBytes','captureMs','idleMs','timeoutMs','captures'] as const)if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>sttLimits[key])invalid('The speech recording limits are invalid.');
 if(limits.pcmBytes%2)invalid('The speech recording byte limit must be even.');let captures=0;
 return class RecordedVoiceBridge{
  private phase:'new'|'preparing'|'recording'|'uploading'|'closed'='new';private controller=new AbortController();private capture?:SttCapture;private captureIdentity='';private pcm?:Buffer;private bytes=0;private idle?:ReturnType<typeof setTimeout>;private deadline?:ReturnType<typeof setTimeout>;private unsubscribe?:()=>void;private reserved=false;
  constructor(readonly downstream:{sendEvent:(event:any)=>void;close:()=>void},readonly options:any){}
  async start(){
   if(this.phase!=='new')return;this.phase='preparing';if(captures>=limits.captures){this.fail(new SttError('resource_limit','Too many speech captures are already active.'));return}captures++;this.reserved=true;
   try{
    this.unsubscribe=deps.subscribeChanges(change=>{if(this.phase==='closed')return;if(this.capture&&change?.rootFrameId&&change.rootFrameId!==this.capture.rootFrameId)return;if(this.capture&&change?.connectionId&&(this.capture.target.kind!=='remote'||change.connectionId!==this.capture.target.connectionId))return;this.fail(new SttError('scope_changed','Speech capture was cancelled because its session, policy or connection changed.'))});
    this.deadline=setTimeout(()=>this.fail(new SttError('timeout','The speech recording reached its time limit. No audio was uploaded.')),limits.captureMs);
    this.controller.signal.throwIfAborted();
    const capture=await abortable(deps.capture(this.options,this.controller.signal),this.controller.signal);
    validateSpeechCapture(capture);
    this.capture=capture;this.captureIdentity=captureKey(capture);await this.check('capture');if(this.phase==='closed')return;
    this.pcm=Buffer.alloc(limits.pcmBytes);this.phase='recording';this.armIdle();this.downstream.sendEvent({type:'ready',destination:speechDestination(capture)});
   }catch(error){this.fail(error)}
  }
  private async check(phase:'capture'|'upload'|'completion',signal=this.controller.signal){
   if(!this.capture||captureKey(this.capture)!==this.captureIdentity)throw new SttError('scope_changed','The bound speech capture context changed.');
   signal.throwIfAborted();await abortable(deps.assertCurrent(this.capture,phase),signal);if(this.phase==='closed')throw stopped();
   if(captureKey(this.capture)!==this.captureIdentity)throw new SttError('scope_changed','The bound speech capture context changed.');
  }
  private armIdle(){clearTimeout(this.idle);this.idle=setTimeout(()=>this.fail(new SttError('timeout','No audio was received before the speech capture timed out. No audio was uploaded.')),limits.idleMs)}
  handleBrowserMessage(data:any,binary:boolean){
   if(this.phase==='closed')return;
   if(!binary){
    let value:any;try{const raw=typeof data==='string'?data:Buffer.from(data).toString('utf8');if(Buffer.byteLength(raw)>sttLimits.controlBytes)throw Error();value=JSON.parse(raw)}catch{return this.fail(new SttError('invalid_request','Invalid speech control message.'))}
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==1||!['stop','cancel','abort'].includes(value.type))return this.fail(new SttError('invalid_request','Speech controls accept only stop or cancel.'));
    if(value.type!=='stop'){this.finish('speech capture cancelled');return}if(this.phase==='uploading')return;if(this.phase!=='recording')return this.fail(new SttError('invalid_request','Wait for the speech capture destination before recording.'));
    this.phase='uploading';clearTimeout(this.idle);clearTimeout(this.deadline);void this.transcribe();return;
   }
   if(this.phase!=='recording')return this.phase==='uploading'?undefined:this.fail(new SttError('invalid_request','Wait for the speech capture destination before recording.'));
   if(!Buffer.isBuffer(data)&&!ArrayBuffer.isView(data)&&!(data instanceof ArrayBuffer))return this.fail(new SttError('invalid_request','Invalid PCM16 frame.'));
   const frame=Buffer.isBuffer(data)?data:data instanceof ArrayBuffer?Buffer.from(data):Buffer.from(data.buffer,data.byteOffset,data.byteLength);
   if(!frame.length||frame.length%2)return this.fail(new SttError('invalid_request','Invalid PCM16 frame.'));
   if(this.bytes+frame.length>limits.pcmBytes)return this.fail(new SttError('resource_limit','The speech recording exceeded its size limit. No audio was uploaded.'));
   frame.copy(this.pcm!,this.bytes);this.bytes+=frame.length;this.armIdle();
  }
  private async transcribe(){
   const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),limits.timeoutMs),signal=AbortSignal.any([this.controller.signal,timeout.signal]);
   try{
    if(!this.bytes){this.finish('empty speech recording');return}await this.check('upload',signal);const capture=this.capture!,pcm=this.pcm!.subarray(0,this.bytes),language=languageCode(this.options?.language);let transcript:string;
    if(capture.target.kind==='local'){if(!deps.transcribeLocal)throw new SttError('unavailable','Local speech recognition is unavailable. No external fallback was used.');transcript=await abortable(deps.transcribeLocal(pcm,language,signal),signal)}
    else transcript=(await transcribePcm16({target:capture.target,pcm,language,signal,timeoutMs:limits.timeoutMs},{...deps,resolveAuth:async(binding,signal)=>{await this.check('upload',signal);return deps.resolveAuth(binding,signal)}})).text;
    if(timeout.signal.aborted)throw new SttError('timeout','Speech transcription timed out.');
    if(typeof transcript!=='string'||Buffer.byteLength(transcript)>sttLimits.transcriptBytes||transcript.includes('\0'))throw new SttError('invalid_response','The speech recognizer returned an invalid transcript.');
    await this.check('completion',signal);if(this.phase==='closed')return;if(transcript.trim())this.downstream.sendEvent({type:'transcript',text:transcript});this.finish('speech transcription finished');
   }catch(error){this.fail(timeout.signal.aborted?new SttError('timeout','Speech transcription timed out. No request was retried.'):error)}finally{clearTimeout(timer)}
  }
  handleBrowserClose(){this.dispose()}
  private fail(error:unknown){if(this.phase==='closed')return;const failure=error instanceof SttError?error:new SttError('unavailable','Speech capture or its trusted policy check could not complete. No fallback was used.');this.downstream.sendEvent({type:'error',code:'stt_'+failure.code,message:failure.message});this.finish('speech transcription stopped')}
  private finish(reason:string){if(this.phase==='closed')return;this.dispose();this.downstream.sendEvent({type:'closed',reason});this.downstream.close()}
  private dispose(){if(this.phase==='closed')return;this.phase='closed';this.controller.abort();clearTimeout(this.idle);clearTimeout(this.deadline);this.unsubscribe?.();this.unsubscribe=undefined;this.pcm?.fill(0);this.pcm=undefined;this.bytes=0;if(this.reserved){captures--;this.reserved=false}}
 };
}
