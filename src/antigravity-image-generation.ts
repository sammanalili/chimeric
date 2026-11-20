import {randomUUID} from 'node:crypto';
import {ANTIGRAVITY_HTTP_USER_AGENT,ANTIGRAVITY_INFERENCE_URL} from './antigravity-http-auth';
import {bridgeTransport,transportPreference} from './antigravity-http-bridge';
import {decodeGeneratedImage,imageGenerationLimits,readImageGenerationResponse,ImageGenerationError,type ImageGenerationDependencies,type ImageGenerationRequest,type ImageGenerationResult,type GeneratedImage} from './image-generation';

const ENDPOINT=ANTIGRAVITY_INFERENCE_URL+'/v1internal:streamGenerateContent?alt=sse';
const VERSION_GATE='This version of Antigravity is no longer supported';
const SIZES:Record<string,string>={'auto':'1:1','1024x1024':'1:1','1536x1024':'3:2','1024x1536':'2:3'};
const invalid=(message:string):never=>{throw new ImageGenerationError('invalid_response',message)};
const fail=(message:string):never=>{throw new ImageGenerationError('invalid_request',message)};
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
 });
}
function baseMatches(value:string){try{return new URL(value).href.replace(/\/+$/,'')===ANTIGRAVITY_INFERENCE_URL}catch{return false}}
function failureMessage(status:number,retryAfter:string|null,detail:string){
 const suffix=detail?' '+detail:'';
 if(status===401)return 'Antigravity rejected the image-generation sign-in (HTTP 401). Reconnect in Settings → Connections.'+suffix;
 if(status===403)return 'Antigravity refused image generation (HTTP 403). Stop using this connection and reconnect through the official client.'+suffix;
 if(status===429)return 'Antigravity image quota is unavailable (HTTP 429). Stop and wait.'+(retryAfter&&/^\d{1,10}$/.test(retryAfter)?' Retry after '+retryAfter+' seconds.':'')+suffix;
 return 'Antigravity image generation returned HTTP '+status+'.'+suffix;
}
function streamErrorStatus(error:any):number|undefined{
 if(Number.isSafeInteger(error?.code)&&error.code>=100&&error.code<=599)return error.code;
 if(error?.status==='UNAUTHENTICATED')return 401;
 if(error?.status==='PERMISSION_DENIED')return 403;
 if(error?.status==='RESOURCE_EXHAUSTED')return 429;
}
/** Subscription text-to-image; provider-native image format, one final output. */
export async function generateAntigravityImage(request:ImageGenerationRequest&{project?:string},deps:ImageGenerationDependencies):Promise<ImageGenerationResult>{
 if(request.model.api!=='antigravity-http'||!baseMatches(request.model.baseUrl))throw new ImageGenerationError('unsupported','Antigravity images require the fixed Antigravity subscription connection.');
 if(request.route!==undefined&&request.route!=='antigravity')throw new ImageGenerationError('unsupported','Choose the Antigravity subscription image-generation route.');
 if(typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>32_000)fail('Provide an image prompt containing 1 to 32000 characters.');
 if(typeof request.imageModel!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(request.imageModel))fail('Choose an advertised Antigravity image-generation model.');
 if(request.count!==undefined&&request.count!==1)fail('Antigravity image generation produces one image per request.');
 if(request.format!==undefined)fail('Antigravity returns its native image format. Explicit image-format conversion is unsupported.');
 if(request.quality!==undefined&&request.quality!=='auto')fail('Antigravity image quality is automatic; explicit quality controls are unsupported.');
 if(request.background!==undefined&&request.background!=='auto')fail('Antigravity image background is controlled by the prompt; explicit background controls are unsupported.');
 const aspectRatio=SIZES[request.size??'auto'];if(!aspectRatio)fail('Choose auto, square, landscape or portrait for Antigravity images.');
 const timeoutMs=request.timeoutMs??request.model.requestTimeoutMs??180_000;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600_000)fail('Choose an image-generation timeout from 1 to 600000 milliseconds.');
 const limits=imageGenerationLimits(deps.limits),deadline=AbortSignal.timeout(timeoutMs);
 let signal=request.signal?AbortSignal.any([request.signal,deadline]):deadline,secret='';
 const safe=(value:string)=>{const redacted=secret?value.split(secret).join('[redacted]'):value;return deps.redact?.(redacted)??redacted};
 try{
  signal.throwIfAborted();
  let auth:Awaited<ReturnType<ImageGenerationDependencies['resolveAuth']>>;
  try{auth=await abortable(deps.resolveAuth(request.model,signal),signal)}catch(error){if(signal.aborted)throw error;throw new ImageGenerationError('authentication',error instanceof Error?error.message:'Connect Antigravity before generating images.');}
  secret=auth.apiKey;if(typeof secret!=='string'||!secret)throw new ImageGenerationError('authentication','Antigravity image generation is missing its subscription sign-in.');
  if(auth.signal)signal=AbortSignal.any([signal,auth.signal]);signal.throwIfAborted();auth.assertCurrent?.();
  const project=request.project??auth.project;
  if(typeof project!=='string'||!project.trim()||project.length>512||/[\r\n]/.test(project))fail('Refresh the Antigravity connection before generating images.');
  const requestId=request.requestId??randomUUID();if(!/^[A-Za-z0-9._:-]{1,128}$/.test(requestId))fail('Provide a valid image request identifier.');
  const payload={model:request.imageModel,project,request:{contents:[{role:'user',parts:[{text:request.prompt}]}],generationConfig:{maxOutputTokens:65_536,responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio,imageSize:'1K'}}},requestId};
  const transport=transportPreference(deps.fetch!==undefined);let pending:Promise<Response>;
  if(transport==='bridge'){
   const bridge=bridgeTransport();if(!bridge)throw new ImageGenerationError('provider_error','The Antigravity image transport is unavailable. Rebuild the app with its transport helper.');
   pending=bridge.start(ENDPOINT,secret,JSON.stringify(payload),signal);
  }else{
   pending=(deps.fetch??auth.fetch??fetch)(ENDPOINT,{method:'POST',redirect:'error',headers:{authorization:'Bearer '+secret,'content-type':'application/json',accept:'text/event-stream','user-agent':ANTIGRAVITY_HTTP_USER_AGENT},body:JSON.stringify(payload),signal});
  }
  const response=await abortable(pending.then(value=>{if(signal.aborted){void value.body?.cancel().catch(()=>{});throw signal.reason}return value}),signal);
  if(!response.ok){
   let detail='';try{detail=safe((await readImageGenerationResponse(response,signal,{...limits,responseBytes:Math.min(limits.responseBytes,8192)}))??'').slice(0,2000)}catch{if(signal.aborted)throw signal.reason}
   throw new ImageGenerationError(response.status===401?'authentication':'provider_error',failureMessage(response.status,response.headers.get('retry-after'),detail),response.status);
  }
  const images:GeneratedImage[]=[];let completed=false,responseId:string|undefined,providerText='',textTail='';const usage:Record<string,number>={};
  const diagnostic=(value:string)=>safe(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').trim().slice(0,2000);
  const explain=(message:string,detail=providerText)=>message+(detail?' Provider response: '+diagnostic(detail):'');
  const consume=(event:any)=>{
   const body=event?.response??event;
   if(!body||typeof body!=='object'||Array.isArray(body))invalid('Antigravity returned an invalid image response.');
   const streamError=event?.error??body.error;
   if(streamError){
    const status=streamErrorStatus(streamError),label=typeof streamError.status==='string'&&/^[A-Z_]{1,80}$/.test(streamError.status)?' ['+streamError.status+']':'';
    const detail=diagnostic(typeof streamError.message==='string'?streamError.message:'Antigravity did not complete image generation.')+label;
    throw new ImageGenerationError(status===401?'authentication':'provider_error',status?failureMessage(status,null,detail):detail,status);
   }
   if(body.promptFeedback?.blockReason)throw new ImageGenerationError('provider_error','Antigravity declined the image request ('+diagnostic(String(body.promptFeedback.blockReason)).slice(0,100)+').');
   if(typeof body.responseId==='string'&&body.responseId.length<=512)responseId=body.responseId;
   for(const key of ['promptTokenCount','candidatesTokenCount','totalTokenCount','thoughtsTokenCount'])if(Number.isFinite(body.usageMetadata?.[key])&&body.usageMetadata[key]>=0)usage[key]=body.usageMetadata[key];
   if(body.candidates!==undefined&&!Array.isArray(body.candidates))invalid('Antigravity returned invalid image candidates.');
   if(body.candidates?.length>1)invalid('Antigravity returned more image candidates than requested.');
   for(const candidate of body.candidates??[]){
    if(candidate.index!==undefined&&candidate.index!==0)invalid('Antigravity returned an unrequested image candidate.');
    if(candidate.content?.parts!==undefined&&!Array.isArray(candidate.content.parts))invalid('Antigravity returned invalid image parts.');
    for(const part of candidate.content?.parts??[]){
     if(part?.thought===true||typeof part?.text!=='string')continue;
     const joined=textTail+part.text;
     if(joined.includes(VERSION_GATE))throw new ImageGenerationError('provider_error',VERSION_GATE);
     textTail=joined.slice(-(VERSION_GATE.length-1));
     // Keep enough extra text to redact a credential spanning chunks and the
     // display limit, then truncate the redacted explanation in diagnostic().
     const textLimit=2000+secret.length;
     if(providerText.length<textLimit)providerText+=part.text.slice(0,textLimit-providerText.length);
    }
    if(candidate.finishReason&&candidate.finishReason!=='STOP')throw new ImageGenerationError('provider_error',explain('Antigravity image generation ended with '+diagnostic(String(candidate.finishReason)).slice(0,100)+'.',typeof candidate.finishMessage==='string'?candidate.finishMessage:providerText));
    for(const part of candidate.content?.parts??[]){
     if(!part||typeof part!=='object'||Array.isArray(part))invalid('Antigravity returned an invalid image part.');
     if(part.thought===true)continue;
     if(part.inlineData){
      if(completed)invalid('Antigravity returned image bytes after completion.');
      if(images.length>=Math.min(1,limits.imageCount))invalid('Antigravity returned more final images than requested.');
      const format=part.inlineData.mimeType==='image/png'?'png':part.inlineData.mimeType==='image/jpeg'?'jpeg':part.inlineData.mimeType==='image/webp'?'webp':undefined;
      if(!format)invalid('Antigravity returned an unsupported image MIME type.');
      images.push(decodeGeneratedImage(part.inlineData.data,format,limits));
     }
    }
    if(candidate.finishReason==='STOP')completed=true;
   }
  };
  if((response.headers.get('content-type')??'').toLowerCase().includes('text/event-stream'))await readImageGenerationResponse(response,signal,limits,consume);
  else{
   const text=await readImageGenerationResponse(response,signal,limits);
   if(text?.includes(VERSION_GATE))throw new ImageGenerationError('provider_error',VERSION_GATE);
   let parsed:any;try{parsed=JSON.parse(text??'')}catch{invalid('Antigravity returned malformed image JSON.');}
   consume(parsed);
  }
  signal.throwIfAborted();auth.assertCurrent?.();
  if(!completed)invalid('Antigravity image generation ended without a completion marker.');
  if(images.length!==1){if(providerText)throw new ImageGenerationError('provider_error',explain('Antigravity completed without a final image.'));invalid('Antigravity completed without a final image.');}
  return {images,provider:request.model.provider,model:request.model.id,imageModel:request.imageModel!,route:'antigravity',billing:'subscription',...responseId?{responseId}:{},...Object.keys(usage).length?{usage}:{}};
 }catch(error){
  if(signal.aborted)throw new ImageGenerationError(deadline.aborted?'timeout':'aborted',deadline.aborted?'Antigravity image generation timed out.':'Antigravity image generation was cancelled.');
  if(error instanceof ImageGenerationError)throw new ImageGenerationError(error.code,safe(error.message),error.status);
  throw new ImageGenerationError('provider_error',safe(error instanceof Error?error.message:'Antigravity image generation failed.'));
 }
}
