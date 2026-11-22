import {inflateSync} from 'node:zlib';
import {randomUUID} from 'node:crypto';

/** This catalog describes documented output models, never vision capability. */
export const OPENAI_IMAGE_MODELS = ['gpt-image-2.5-flare','gpt-image-2.5-sunburst','chatgpt-image-latest'] as const;
export const DEFAULT_IMAGE_MODEL = OPENAI_IMAGE_MODELS[0];
export const OPENAI_SUBSCRIPTION_IMAGE_MODEL='gpt-image-2';
export type ImageGenerationRoute = 'images'|'responses'|'subscription'|'antigravity';
export type ImageGenerationModel = {
  id:string; provider:string; qualifiedId?:string; api:string; baseUrl:string;
  input?:readonly string[]; requestTimeoutMs?:number; imageGenerationCandidate?:boolean; imageGenerationAdvertised?:boolean;
};
export type ImageGenerationCapability = {
  available:boolean; status:'available'|'unverified'|'unsupported'; verified:false;
  route:ImageGenerationRoute|null; billing:'api'|'subscription'; inputImages:boolean; reason:string;
};
const imageModel = (id:string) => /^gpt-image-[a-zA-Z0-9.-]+$/.test(id)||id==='chatgpt-image-latest';
function standardAPI(baseUrl:string) {
  try { const u=new URL(baseUrl); return u.href.replace(/\/$/,'')==='https://api.openai.com/v1'; } catch { return false; }
}
export function supportsImageReferenceTransport(model:ImageGenerationModel){return ['openai-completions','openai-responses'].includes(model.api)&&model.imageGenerationCandidate===true&&!standardAPI(model.baseUrl)}
export function imageGenerationCapability(model:ImageGenerationModel, options:{route?:ImageGenerationRoute}={}):ImageGenerationCapability {
  const common={verified:false as const,inputImages:model.input?.includes('image')??false};
  if(model.api==='openai-codex-responses'){
    let exact=false;try{exact=new URL(model.baseUrl).href.replace(/\/$/,'')==='https://chatgpt.com/backend-api';}catch{}
    if(!exact)return {...common,available:false,status:'unsupported',route:null,billing:'subscription',reason:'Subscription image generation requires the fixed ChatGPT connection destination.'};
    if(options.route!==undefined&&options.route!=='subscription')return {...common,available:false,status:'unsupported',route:null,billing:'subscription',reason:'Use the subscription image-generation route with this ChatGPT connection.'};
    return {...common,available:true,status:'available',route:'subscription',billing:'subscription',reason:'Uses the existing ChatGPT connection and included Codex usage. Image generation is subject to the account’s subscription limits.'};
  }
  const compatible=['openai-completions','openai-responses'].includes(model.api),official=standardAPI(model.baseUrl),candidate=compatible&&model.imageGenerationCandidate===true;
  if(!official&&!candidate)return {...common,available:false,status:'unsupported',route:null,billing:'api',reason:'Select an OpenAI image model or a model advertised for image generation by this compatible connection.'};
  if(options.route!==undefined&&!['images','responses'].includes(options.route))return {...common,available:false,status:'unsupported',route:null,billing:'api',reason:'Choose the Images or Responses image-generation route.'};
  if(model.id==='gpt-image-1')return {...common,available:false,status:'unsupported',route:null,billing:'api',reason:'GPT Image 1 was retired. Choose a current image-generation model.'};
  const route=options.route??(candidate?'images':imageModel(model.id)?'images':'responses');
  if(candidate&&route!=='images')return {...common,available:false,status:'unsupported',route:null,billing:'api',reason:'This compatible image model uses the Images route.'};
  if(route==='responses'&&imageModel(model.id))return {...common,available:false,status:'unsupported',route:null,billing:'api',reason:'Select a chat model for the Responses image-generation tool, or use the Images route with this image model.'};
  return {...common,available:true,status:candidate&&!model.imageGenerationAdvertised?'unverified':'available',route,billing:'api',reason:candidate?'The compatible provider listed this image model. The first generation verifies its endpoint support.':'The OpenAI API image-generation route is configured. Account access and generation have not been verified.'};
}

export class ImageGenerationError extends Error {
  constructor(public readonly code:'unsupported'|'invalid_request'|'authentication'|'provider_error'|'invalid_response'|'aborted'|'timeout',message:string,public readonly status?:number) { super(message);this.name='ImageGenerationError'; }
}
export type GeneratedImage = {bytes:Uint8Array;mimeType:'image/png'|'image/jpeg'|'image/webp';extension:'png'|'jpg'|'webp';width:number;height:number;revisedPrompt?:string;generationId?:string};
export type ImageGenerationResult = {images:GeneratedImage[];provider:string;model:string;imageModel:string;route:ImageGenerationRoute;billing:'api'|'subscription';responseId?:string;usage?:Record<string,unknown>;operation?:'edit';referenceImageCount?:number};
export type ImageReferenceInput={bytes:Uint8Array;mimeType:'image/png'|'image/jpeg'|'image/webp'};
export type ImageGenerationRequest = {
  model:ImageGenerationModel;prompt:string;route?:ImageGenerationRoute;imageModel?:string;
  size?:string;quality?:'auto'|'low'|'medium'|'high'|'xhigh'|'max';
  format?:'png'|'jpeg'|'webp';background?:'auto'|'opaque'|'transparent';count?:number;
  timeoutMs?:number;signal?:AbortSignal;requestId?:string;
  referenceImages?:readonly ImageReferenceInput[];
};
export type ImageGenerationLimits = {imageBytes:number;responseBytes:number;eventBytes:number;imageCount:number;pixels:number;decodedBytes:number};
const LIMITS:ImageGenerationLimits={imageBytes:32*1024*1024,responseBytes:192*1024*1024,eventBytes:184*1024*1024,imageCount:4,pixels:32*1024*1024,decodedBytes:160*1024*1024};
export type ImageGenerationDependencies = {
  /** Resolve the selected model's pinned credential. Never resolve another provider as fallback. */
  resolveAuth:(model:ImageGenerationModel,signal:AbortSignal)=>Promise<{apiKey:string;fetch?:typeof fetch;signal?:AbortSignal;assertCurrent?:()=>void;project?:string}>;
  fetch?:typeof fetch;redact?:(message:string)=>string;
  /** Hosts may tighten resource bounds; raising these limits is rejected. */
  limits?:Partial<ImageGenerationLimits>;
};
const invalid=(message:string):never=>{throw new ImageGenerationError('invalid_response',message)};
function abortable<T>(promise:Promise<T>,signal:AbortSignal):Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    promise.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
  });
}
function bounds(overrides:Partial<ImageGenerationLimits>={}):ImageGenerationLimits {
  const limits={...LIMITS,...overrides};
  for(const key of Object.keys(LIMITS) as Array<keyof ImageGenerationLimits>)if(!Number.isSafeInteger(limits[key])||limits[key]<1||limits[key]>LIMITS[key])throw new ImageGenerationError('invalid_request','Invalid image-generation resource limit.');
  return limits;
}
export function imageGenerationLimits(overrides?:Partial<ImageGenerationLimits>):ImageGenerationLimits { return bounds(overrides); }
function dimensions(width:number,height:number,limits:ImageGenerationLimits) {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>limits.pixels)invalid('Generated image dimensions exceed the supported pixel limit.');
  return {width,height};
}
const CRC_TABLE=Array.from({length:256},(_,value)=>{let crc=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0});
function crc32(bytes:Buffer) {let crc=0xffffffff;for(const byte of bytes)crc=(crc>>>8)^CRC_TABLE[(crc^byte)&255];return (crc^0xffffffff)>>>0;}
function pngDimensions(bytes:Buffer,limits:ImageGenerationLimits) {
  if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))invalid('Generated PNG has an invalid signature.');
  let offset=8,width=0,height=0,depth=0,color=0,interlace=0,ended=false,sawData=false,dataEnded=false,palette=false;const compressed:Buffer[]=[];
  while(offset<bytes.length){
    if(offset+12>bytes.length)invalid('Generated PNG is truncated.');
    const length=bytes.readUInt32BE(offset),end=offset+12+length;
    if(end>bytes.length)invalid('Generated PNG has a truncated chunk.');
    const name=bytes.subarray(offset+4,offset+8).toString('ascii'),data=bytes.subarray(offset+8,end-4);
    if(!/^[A-Za-z]{4}$/.test(name)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4))invalid('Generated PNG has an invalid chunk checksum.');
    if(offset===8&&name!=='IHDR')invalid('Generated PNG has no initial header.');
    if(name==='IHDR'){
      if(offset!==8||length!==13)invalid('Generated PNG has an invalid header.');
      width=data.readUInt32BE(0);height=data.readUInt32BE(4);dimensions(width,height,limits);depth=data[8];color=data[9];interlace=data[12];
      const allowed:Record<number,number[]>={0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      if(!allowed[color]?.includes(depth)||data[10]!==0||data[11]!==0||interlace>1)invalid('Generated PNG has unsupported encoding.');
    }else if(name==='PLTE'){
      if(palette||sawData||!length||length%3||length>768||[0,4].includes(color)||color===3&&length/3>2**depth)invalid('Generated PNG has an invalid palette.');palette=true;
    }else if(name==='IDAT'){
      if(color===3&&!palette)invalid('Generated indexed PNG has no palette.');
      if(dataEnded)invalid('Generated PNG has noncontiguous image data.');sawData=true;compressed.push(data);
    }else if(name==='IEND'){
      if(length!==0||!sawData||end!==bytes.length)invalid('Generated PNG is incomplete or has trailing data.');ended=true;
    }else {if(sawData)dataEnded=true;if(name[0]===name[0].toUpperCase()&&!['PLTE'].includes(name))invalid('Generated PNG has an unsupported critical chunk.');}
    offset=end;
  }
  if(!ended)invalid('Generated PNG has no final image marker.');
  const channels:Record<number,number>={0:1,2:3,3:1,4:2,6:4},bits=channels[color]*depth;
  const passes=interlace?[[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]]:[[0,0,1,1]];
  const rows:Array<[number,number]>=[];let expected=0;
  for(const [x,y,dx,dy]of passes){const w=Math.max(0,Math.ceil((width-x)/dx)),h=Math.max(0,Math.ceil((height-y)/dy));if(w&&h){const row=1+Math.ceil(w*bits/8);expected+=row*h;rows.push([row,h]);}}
  if(expected>limits.decodedBytes)invalid('Generated PNG decoded data exceeds the resource limit.');
  let raw:Buffer;try{raw=inflateSync(Buffer.concat(compressed),{maxOutputLength:Math.min(expected+1,limits.decodedBytes)});}catch{invalid('Generated PNG contains corrupt or incomplete compressed image data.');}
  if(raw!.length!==expected)invalid('Generated PNG decoded data has the wrong size.');
  let start=0;for(const [row,height]of rows)for(let y=0;y<height;y++,start+=row)if(raw![start]>4)invalid('Generated PNG has an invalid row filter.');
  return {width,height};
}
function jpegDimensions(bytes:Buffer,limits:ImageGenerationLimits) {
  if(bytes.length<4||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)invalid('Generated JPEG is incomplete.');
  let offset=2,width=0,height=0,sawScan=false;
  while(offset<bytes.length){
    if(bytes[offset++]!==0xff)invalid('Generated JPEG has an invalid segment.');while(bytes[offset]===0xff)offset++;
    if(offset>=bytes.length)invalid('Generated JPEG is truncated.');const marker=bytes[offset++];
    if(marker===0xd9){if(offset!==bytes.length||!sawScan||!width)invalid('Generated JPEG is incomplete.');return {width,height};}
    if(marker===0xd8||marker===0||marker>=0xd0&&marker<=0xd7)invalid('Generated JPEG has an invalid marker.');
    if(marker===0x01)continue;
    if(offset+2>bytes.length)invalid('Generated JPEG is truncated.');const length=bytes.readUInt16BE(offset);
    if(length<2||offset+length>bytes.length)invalid('Generated JPEG has a truncated segment.');
    if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
      if(length<8)invalid('Generated JPEG has an invalid frame.');height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);dimensions(width,height,limits);
    }
    offset+=length;
    if(marker===0xda){
      if(!width)invalid('Generated JPEG has no frame.');sawScan=true;const scanStart=offset;
      while(offset<bytes.length){if(bytes[offset]!==0xff){offset++;continue}let next=offset+1;while(bytes[next]===0xff)next++;if(bytes[next]===0||bytes[next]>=0xd0&&bytes[next]<=0xd7){offset=next+1;continue}break;}
      if(offset===scanStart)invalid('Generated JPEG has no image data.');
    }
  }
  return invalid('Generated JPEG has no final image marker.');
}
function webpDimensions(bytes:Buffer,limits:ImageGenerationLimits) {
  if(bytes.length<20||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WEBP'||bytes.readUInt32LE(4)!==bytes.length-8)invalid('Generated WebP is incomplete.');
  let offset=12,width=0,height=0,sawFrame=false;
  while(offset<bytes.length){
    if(offset+8>bytes.length)invalid('Generated WebP has a truncated chunk.');const name=bytes.toString('ascii',offset,offset+4),length=bytes.readUInt32LE(offset+4),start=offset+8,end=start+length;
    if(end+(length%2)>bytes.length)invalid('Generated WebP has a truncated chunk.');
    if(name==='VP8X'){if(length!==10)invalid('Generated WebP has an invalid header.');if(bytes[start]&2)invalid('Animated image generation outputs are unsupported.');width=1+bytes.readUIntLE(start+4,3);height=1+bytes.readUIntLE(start+7,3);}
    if(name==='VP8L'){if(length<5||bytes[start]!==0x2f)invalid('Generated WebP has an invalid lossless frame.');const frame=bytes.readUInt32LE(start+1);const w=1+(frame&0x3fff),h=1+((frame>>>14)&0x3fff);if(width&&(width!==w||height!==h))invalid('Generated WebP frame dimensions disagree.');width=w;height=h;sawFrame=true;}
    if(name==='VP8 '){if(length<10||bytes[start]&1||bytes.toString('hex',start+3,start+6)!=='9d012a')invalid('Generated WebP has an invalid frame.');const w=bytes.readUInt16LE(start+6)&0x3fff,h=bytes.readUInt16LE(start+8)&0x3fff;if(width&&(width!==w||height!==h))invalid('Generated WebP frame dimensions disagree.');width=w;height=h;sawFrame=true;}
    offset=end+(length%2);
  }
  if(!sawFrame)invalid('Generated WebP contains no image frame.');return dimensions(width,height,limits);
}
function decodeImage(encoded:unknown,format:unknown,limits:ImageGenerationLimits,revisedPrompt?:unknown):GeneratedImage {
  if(typeof encoded!=='string'||!encoded.length||encoded.length>Math.ceil(limits.imageBytes/3)*4||encoded.length%4!==0||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(encoded))invalid('Generated image contains invalid or oversized base64 data.');
  const bytes=Buffer.from(encoded,'base64');
  if(!bytes.length||bytes.length>limits.imageBytes||bytes.toString('base64')!==encoded)invalid('Generated image contains noncanonical or oversized base64 data.');
  let detected:'png'|'jpeg'|'webp';
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))detected='png';
  else if(bytes[0]===0xff&&bytes[1]===0xd8)detected='jpeg';
  else if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')detected='webp';
  else return invalid('Generated output is not a supported PNG, JPEG, or WebP image.');
  if(format!==undefined&&format!==detected)invalid('Generated image bytes do not match the output format.');
  const size=detected==='png'?pngDimensions(bytes,limits):detected==='jpeg'?jpegDimensions(bytes,limits):webpDimensions(bytes,limits);
  return {bytes,mimeType:`image/${detected}`,extension:detected==='jpeg'?'jpg':detected,...size,...(typeof revisedPrompt==='string'&&revisedPrompt.length<=32_000?{revisedPrompt}:{})};
}
/** Shared provider decoder. Callers may tighten, but never raise, resource limits. */
export function decodeGeneratedImage(encoded:unknown,format?:unknown,limits?:Partial<ImageGenerationLimits>,revisedPrompt?:unknown):GeneratedImage {
  return decodeImage(encoded,format,bounds(limits),revisedPrompt);
}
/** Validate and pin reference bytes before resolving a provider credential. */
function validatedReferences(value:ImageGenerationRequest['referenceImages'],limits:ImageGenerationLimits):ImageReferenceInput[]{
  if(value===undefined)return [];
  const fail=():never=>{throw new ImageGenerationError('invalid_request','Provide one to four valid PNG, JPEG or WebP reference images within the image resource limits.');};
  if(!Array.isArray(value)||value.length<1||value.length>4)return fail();
  const references:ImageReferenceInput[]=[];let total=0;
  for(let i=0;i<value.length;i++){
    if(!Object.hasOwn(value,i))return fail();
    const item=value[i];
    if(!item||!(item.bytes instanceof Uint8Array)||!['image/png','image/jpeg','image/webp'].includes(item.mimeType)||!item.bytes.byteLength||item.bytes.byteLength>Math.min(limits.imageBytes,16*1024*1024))return fail();
    total+=item.bytes.byteLength;if(total>Math.min(limits.responseBytes,32*1024*1024))return fail();
    const bytes=Uint8Array.from(item.bytes);
    try{decodeImage(Buffer.from(bytes).toString('base64'),item.mimeType.slice(6),{...limits,imageBytes:Math.min(limits.imageBytes,16*1024*1024),pixels:Math.min(limits.pixels,16*1024*1024),decodedBytes:Math.min(limits.decodedBytes,80*1024*1024)});}catch{return fail();}
    references.push({bytes,mimeType:item.mimeType});
  }
  return references;
}
function providerFailure(body:any,status?:number):never {
  const error=body?.error??body?.response?.error;
  const message=typeof error?.message==='string'?error.message:typeof body?.message==='string'?body.message:'The provider did not complete image generation.';
  throw new ImageGenerationError('provider_error',`OpenAI image generation${status?` (HTTP ${status})`:''}: ${message}`,status);
}
async function readStream(response:Response,signal:AbortSignal,limits:ImageGenerationLimits,onEvent?:(event:any)=>void) {
  if(Number(response.headers.get('content-length'))>limits.responseBytes){void response.body?.cancel().catch(()=>{});invalid('Image-generation response exceeds the resource limit.');}
  if(!response.body)invalid('Image-generation response has no body.');
  const reader=response.body!.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let total=0,text='',data:string[]=[],dataLength=0,eventName='';
  const dispatch=()=>{if(!data.length){eventName='';return}const payload=data.join('\n');data=[];dataLength=0;if(payload==='[DONE]'){eventName='';return}let value:any;try{value=JSON.parse(payload)}catch{invalid('Image-generation stream contains malformed JSON.');}if(!value||typeof value!=='object'||Array.isArray(value))invalid('Image-generation stream contains an invalid event.');if(eventName&&value.type&&eventName!==value.type)invalid('Image-generation stream event type disagrees with its payload.');onEvent!({...value,...(!value.type&&eventName?{type:eventName}:{})});eventName='';};
  const line=(value:string)=>{if(!value){dispatch();return}if(value.startsWith(':'))return;const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon),raw=colon<0?'':value.slice(colon+1),content=raw.startsWith(' ')?raw.slice(1):raw;if(field==='event')eventName=content;if(field==='data'){data.push(content);dataLength+=content.length;if(dataLength>limits.eventBytes)invalid('Image-generation stream event exceeds the resource limit.');}};
  try{
    while(true){const next=await abortable(reader.read(),signal);if(next.done)break;total+=next.value.byteLength;if(total>limits.responseBytes)invalid('Image-generation response exceeds the resource limit.');text+=decoder.decode(next.value,{stream:true});
      if(onEvent){let end:number;while((end=text.indexOf('\n'))>=0){line(text.slice(0,end).replace(/\r$/,''));text=text.slice(end+1);}if(text.length+dataLength>limits.eventBytes)invalid('Image-generation stream event exceeds the resource limit.');}
    }
    text+=decoder.decode();if(onEvent){if(text)line(text.replace(/\r$/,''));dispatch();return undefined;}return text;
  }finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** Reuse the bounded JSON/SSE reader across image providers. */
export function readImageGenerationResponse(response:Response,signal:AbortSignal,limits?:Partial<ImageGenerationLimits>,onEvent?:(event:any)=>void) {
  return readStream(response,signal,bounds(limits),onEvent);
}

/** Returns only complete provider outputs. Partial previews never become artifacts. */
export async function generateImage(request:ImageGenerationRequest,deps:ImageGenerationDependencies):Promise<ImageGenerationResult> {
  const limits=bounds(deps.limits),capability=imageGenerationCapability(request.model,{route:request.route});
  if(!capability.available||!capability.route)throw new ImageGenerationError('unsupported',capability.reason);
  const route=capability.route,format=request.format??'png',quality=request.quality??'auto',background=request.background??(route==='subscription'?'opaque':'auto'),count=request.count??1;
  if(typeof request.prompt!=='string'||!request.prompt.trim()||request.prompt.length>32_000)throw new ImageGenerationError('invalid_request','Provide an image prompt containing 1 to 32000 characters.');
  if(!['png','jpeg','webp'].includes(format)||!['auto','low','medium','high','xhigh','max'].includes(quality)||!['auto','opaque','transparent'].includes(background))throw new ImageGenerationError('invalid_request','Invalid image-generation format, quality, or background.');
  if(background==='transparent'&&format==='jpeg')throw new ImageGenerationError('invalid_request','Transparent backgrounds require PNG or WebP output.');
  if(!Number.isSafeInteger(count)||count<1||count>limits.imageCount||['responses','subscription'].includes(route)&&count!==1)throw new ImageGenerationError('invalid_request','Invalid image count for the selected generation route.');
  const size=request.size??'auto';if(size!=='auto'){const match=/^([1-9]\d{0,4})x([1-9]\d{0,4})$/.exec(size);if(!match||Number(match[1])*Number(match[2])>limits.pixels)throw new ImageGenerationError('invalid_request','Image dimensions exceed the supported pixel limit.');}
  const compatibleImageModel=route==='images'&&supportsImageReferenceTransport(request.model);
  const references=validatedReferences(request.referenceImages,limits);
  if(references.length&&!compatibleImageModel)throw new ImageGenerationError('unsupported','Reference-image generation is not implemented for this image route. Choose a compatible image-editing connection.');
  const generatedModel=request.imageModel??(route==='subscription'?OPENAI_SUBSCRIPTION_IMAGE_MODEL:compatibleImageModel?request.model.id:imageModel(request.model.id)?request.model.id:DEFAULT_IMAGE_MODEL);
  if((!compatibleImageModel&&(!imageModel(generatedModel)||generatedModel==='gpt-image-1'))||(compatibleImageModel&&generatedModel!==request.model.id))throw new ImageGenerationError('invalid_request','Choose the image model advertised by this compatible connection.');
  if(route==='subscription'&&(generatedModel!==OPENAI_SUBSCRIPTION_IMAGE_MODEL||format!=='png'||!['auto','low','medium','high'].includes(quality)))throw new ImageGenerationError('invalid_request','Subscription image generation uses GPT Image 2 with PNG output and auto, low, medium, or high quality.');
  if(request.requestId!==undefined&&!/^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId))throw new ImageGenerationError('invalid_request','Invalid image-generation request identifier.');
  const timeoutMs=request.timeoutMs??request.model.requestTimeoutMs??600_000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3_600_000)throw new ImageGenerationError('invalid_request','Image-generation timeout must be between 1 millisecond and 1 hour.');
  const deadline=Date.now()+timeoutMs,controller=new AbortController(),signal=request.signal?AbortSignal.any([request.signal,controller.signal]):controller.signal;
  const timer=setTimeout(()=>controller.abort(new ImageGenerationError('timeout','Image generation timed out.')),timeoutMs);let secret='',authSignal:AbortSignal|undefined;
  const safe=(message:string)=>{let value=message;if(secret)value=value.split(secret).join('[redacted]');try{value=deps.redact?.(value)??value}catch{value='Image generation failed.'}return value.replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,'[redacted]').slice(0,1000);};
  try{
    signal.throwIfAborted();const auth=await abortable(deps.resolveAuth(request.model,signal),signal);secret=auth.apiKey;authSignal=auth.signal;
    const effectiveSignal=authSignal?AbortSignal.any([signal,authSignal]):signal;effectiveSignal.throwIfAborted();auth.assertCurrent?.();
    if(typeof secret!=='string'||!secret||secret==='local-no-key-required')throw new ImageGenerationError('authentication',route==='subscription'?'Connect ChatGPT before generating an image.':'The selected OpenAI API connection has no API credential.');
    if(route==='subscription'&&!auth.fetch)throw new ImageGenerationError('authentication','Subscription image generation requires destination-bound ChatGPT authentication.');
    const options={size,quality,output_format:format,background};
    const body=route==='subscription'?{prompt:request.prompt,background,model:OPENAI_SUBSCRIPTION_IMAGE_MODEL,quality,size}:route==='images'?(compatibleImageModel?{model:generatedModel,prompt:request.prompt,n:count,response_format:'b64_json'}:{model:generatedModel,prompt:request.prompt,n:count,...options,stream:true,partial_images:0}):{model:request.model.id,input:request.prompt,tools:[{type:'image_generation',model:generatedModel,action:'generate',...options,partial_images:0}],tool_choice:{type:'image_generation'},stream:true,store:false};
    let editBody:FormData|undefined;
    if(references.length){
      editBody=new FormData();editBody.set('model',generatedModel);editBody.set('prompt',request.prompt);editBody.set('n',String(count));editBody.set('response_format','b64_json');
      if(size!=='auto')editBody.set('size',size);
      for(const [index,image]of references.entries())editBody.append(references.length===1?'image':'image[]',new Blob([Uint8Array.from(image.bytes)],{type:image.mimeType}),'reference-'+(index+1)+'.'+(image.mimeType==='image/jpeg'?'jpg':image.mimeType.slice(6)));
    }
    const endpoint=references.length?new URL('images/edits',request.model.baseUrl.replace(/\/?$/,'/')).href:route==='subscription'?'https://chatgpt.com/backend-api/codex/images/generations':route==='images'?(compatibleImageModel?new URL('images/generations',request.model.baseUrl.replace(/\/?$/,'/')).href:'https://api.openai.com/v1/images/generations'):'https://api.openai.com/v1/responses';
    const turnId=request.requestId??randomUUID();
    const response=await abortable((auth.fetch??deps.fetch??fetch)(endpoint,{method:'POST',headers:{authorization:'Bearer '+secret,...(!editBody?{'content-type':'application/json'}:{}),accept:route==='subscription'||compatibleImageModel?'application/json':'text/event-stream, application/json',...route==='subscription'?{originator:'chimeric','user-agent':'Chimeric/0.1.0','x-codex-image-turn-id':turnId,'x-codex-turn-metadata':JSON.stringify({turn_id:turnId,model:request.model.id})}:{}},body:editBody??JSON.stringify(body),redirect:'error',signal:effectiveSignal}),effectiveSignal);
    if(!response.ok){
      let raw:string|undefined;
      try{raw=await readStream(response,effectiveSignal,{...limits,responseBytes:Math.min(limits.responseBytes,64*1024)});}catch(error){if(effectiveSignal.aborted)throw error;providerFailure({message:'The provider returned an unreadable error body.'},response.status);}
      let error:any;try{error=JSON.parse(raw!)}catch{error={message:raw?.slice(0,1000)||response.statusText}}providerFailure(error,response.status);
    }
    let final:any;const contentType=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if(contentType==='text/event-stream'){
      if(route==='subscription'){void response.body?.cancel().catch(()=>{});invalid('The subscription image endpoint did not return a final JSON image response.');}
      const completed:any[]=[];await readStream(response,effectiveSignal,limits,event=>{
        if(event.type==='error'||event.type==='response.failed'||event.type==='response.incomplete'||event.type==='image_generation.failed')providerFailure(event);
        if(route==='responses'&&event.type==='response.completed'){if(final)invalid('Image-generation stream contains duplicate completion events.');final=event.response;}
        if(route==='images'&&event.type==='image_generation.completed'){completed.push(event);if(completed.length>count)invalid('Image-generation stream returned too many final images.');}
      });
      if(route==='images'){if(completed.length!==count)invalid('Image-generation stream ended without all final images.');final={data:completed.map(event=>({b64_json:event.b64_json,revised_prompt:event.revised_prompt,output_format:event.output_format})),usage:completed.length===1?completed[0].usage:undefined};}
    }else if(contentType==='application/json'){
      const raw=await readStream(response,effectiveSignal,limits);try{final=JSON.parse(raw!)}catch{invalid('Image-generation response contains malformed JSON.');}
    }else {void response.body?.cancel().catch(()=>{});invalid('Image-generation response has an unsupported content type.');}
    effectiveSignal.throwIfAborted();auth.assertCurrent?.();
    if(!final||typeof final!=='object'||Array.isArray(final))invalid('Image generation ended without a final response.');
    if(final.error)providerFailure(final);
    if(route==='subscription'&&final.status!==undefined&&final.status!=='completed')invalid('Subscription image-generation response is incomplete.');
    let images:GeneratedImage[];
    if(route==='responses'){
      if(final.status!=='completed')invalid('Image-generation response was not completed.');
      if(!Array.isArray(final.output)||final.output.length>1024)invalid('Image-generation response has an invalid output list.');
      const calls=final.output.filter((item:any)=>item?.type==='image_generation_call');
      if(!calls.length||calls.length>limits.imageCount)invalid('The provider returned no usable final image or too many images.');
      images=calls.map((item:any)=>{if(item.status!=='completed')invalid('Image-generation output is incomplete.');return decodeImage(item.result,item.output_format??format,limits,item.revised_prompt)});
    }else{
      if(!Array.isArray(final.data)||final.data.length!==count)invalid('Image-generation response returned an unexpected image count.');
      images=final.data.map((item:any)=>{if(!item||typeof item!=='object')invalid('Image-generation response contains an invalid image.');if(typeof item.url==='string'&&!item.b64_json)invalid('Image URL outputs are unsupported. Request binary image output.');if(route==='subscription'&&item.status!==undefined&&item.status!=='completed')invalid('Subscription image-generation output is incomplete.');const image=decodeImage(item.b64_json,item.output_format??final.output_format??format,limits,item.revised_prompt);if(typeof item.generation_id==='string'&&item.generation_id.length>0&&item.generation_id.length<=512)image.generationId=item.generation_id;return image});
    }
    if(images.reduce((total,image)=>total+image.bytes.byteLength,0)>limits.responseBytes)invalid('Generated image bytes exceed the resource limit.');
    if(Date.now()>=deadline)throw new ImageGenerationError('timeout','Image generation timed out.');effectiveSignal.throwIfAborted();auth.assertCurrent?.();
    const usage:Record<string,unknown>={};
    // Usage is metadata, not a channel for arbitrary upstream fields.
    for(const key of ['input_tokens','output_tokens','total_tokens'])if(Number.isSafeInteger(final.usage?.[key])&&final.usage[key]>=0)usage[key]=final.usage[key];
    for(const key of ['input_tokens_details','output_tokens_details'])if(final.usage?.[key]&&typeof final.usage[key]==='object'){const details:Record<string,number>={};for(const field of ['image_tokens','text_tokens','cached_tokens','reasoning_tokens'])if(Number.isSafeInteger(final.usage[key][field])&&final.usage[key][field]>=0)details[field]=final.usage[key][field];if(Object.keys(details).length)usage[key]=details;}
    return {images,provider:request.model.provider,model:request.model.id,imageModel:generatedModel,route,billing:capability.billing,...(references.length?{operation:'edit' as const,referenceImageCount:references.length}:{}),...(typeof final.id==='string'&&final.id.length<=512?{responseId:final.id}:{}),...(Object.keys(usage).length?{usage}:{})};
  }catch(error){
    if(signal.aborted){if(controller.signal.aborted)throw new ImageGenerationError('timeout','Image generation timed out.');throw new ImageGenerationError('aborted','Image generation was cancelled.');}
    if(authSignal?.aborted)throw new ImageGenerationError('authentication','The ChatGPT connection changed while generating the image. Retry with the current connection.');
    if(error instanceof ImageGenerationError)throw new ImageGenerationError(error.code,safe(error.message),error.status);
    throw new ImageGenerationError('provider_error',safe(error instanceof Error?error.message:'Image generation failed.'));
  }finally{clearTimeout(timer);}
}
