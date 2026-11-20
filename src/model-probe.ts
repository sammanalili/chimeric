import {dispatchModel,type ModelDrivers} from './model-dispatch';
import {randomInt} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {normalizeContext} from '@earendil-works/pi-ai/utils/transcript';
import type {ModelEntry} from './registry';
import {modelEfforts} from './model-effort';
import {anthropicApiModelMetadata} from './anthropic-compat';

export type ImageProbeEvidence={status:'supported'|'rejected'|'inconclusive';testedAt:number;detail:string;probeVersion:'image-v1'};
export type ImageProbeRecord={fingerprint:string;evidence:ImageProbeEvidence;lastSupported?:ImageProbeEvidence};
export const IMAGE_PROBE_GLYPHS:Record<string,string[]>={
 '2':['01110','10001','00001','00010','00100','01000','11111'],
 '3':['11110','00001','00001','01110','00001','00001','11110'],
 '4':['00010','00110','01010','10010','11111','00010','00010'],
 '5':['11111','10000','10000','11110','00001','00001','11110'],
 '6':['01110','10000','10000','11110','10001','10001','01110'],
 '7':['11111','00001','00010','00100','01000','01000','01000'],
 '8':['01110','10001','10001','01110','10001','10001','01110'],
 '9':['01110','10001','10001','01111','00001','00001','01110'],
};
const crc=(data:Buffer)=>{let value=0xffffffff;for(const byte of data){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0)}return(value^0xffffffff)>>>0};
function chunk(name:string,data:Buffer){const type=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([type,data])));return Buffer.concat([length,type,data,sum])}
export function imageChallenge(){
 const alphabet='23456789',answer=Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join(''),width=240,height=66,scale=6,padding=12;
 const pixels=Buffer.alloc(height*(1+width*3),255);
 for(let y=0;y<height;y++)pixels[y*(1+width*3)]=0;
 for(let index=0;index<answer.length;index++)for(let gy=0;gy<7;gy++)for(let gx=0;gx<5;gx++)if(IMAGE_PROBE_GLYPHS[answer[index]][gy][gx]==='1')for(let sy=0;sy<scale;sy++)for(let sx=0;sx<scale;sx++){
  const offset=(padding+gy*scale+sy)*(1+width*3)+1+(padding+index*36+gx*scale+sx)*3;pixels.fill(0,offset,offset+3);
 }
 const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
 const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
 return{answer,data:png.toString('base64')};
}

export async function probeImage(model:ModelEntry,auth:any,signal:AbortSignal,safeError:(error:unknown)=>string,drivers:ModelDrivers={}):Promise<ImageProbeEvidence>{
 const local=new AbortController(),probeSignal=AbortSignal.any([signal,local.signal]);
 const evidence=(status:ImageProbeEvidence['status'],detail:string):ImageProbeEvidence=>({status,testedAt:Date.now(),detail,probeVersion:'image-v1'});
 try{
  signal.throwIfAborted();if(model.api==='antigravity-cli')return evidence('rejected','The current Antigravity CLI model transport accepts text input only.');const challenge=imageChallenge();
  const testModel={...model,input:['text','image']};
  const context=normalizeContext({messages:[{role:'user',content:[{type:'text',text:'Return only the six digits displayed in the supplied image. Do not explain.'},{type:'image',mimeType:'image/png',data:challenge.data}],timestamp:Date.now()}]});
  const effort=modelEfforts(model).find(value=>value!=='off');
  // Manual Anthropic thinking needs >=1024 thinking tokens plus answer room.
  // Respect the model cap rather than sending the former invalid 512/1024 pair.
  const budgetThinking=model.api==='anthropic-messages'&&model.reasoning&&!model.compat?.forceAdaptiveThinking&&!anthropicApiModelMetadata(model.id);
  const maxTokens=Math.min(model.maxTokens,budgetThinking?2048:512);
  let final:any,total=0;
  for await(const event of dispatchModel(testModel as any,context,{...auth,transport:'sse',signal:probeSignal,maxTokens,maxRetries:0,timeoutMs:30_000,...(effort?{reasoningEffort:effort}:{})},drivers)){
   if(event.type==='text_delta'){total+=Buffer.byteLength(event.delta);if(total>8192)throw Error('Probe output exceeded its limit.');}
   if(event.type==='error')throw Error(event.error?.errorMessage??event.reason??'The provider returned an error.');
   if(event.type==='done')final=event.message;
  }
  signal.throwIfAborted();
  if(!final)return evidence('inconclusive','The provider closed without a completed response.');
  const text=(final.content??[]).filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('').trim();
  if(Buffer.byteLength(text)>8192)return evidence('inconclusive','Probe output exceeded its limit.');
  if(final.stopReason==='length')return evidence('inconclusive','The probe reached its output limit.');
  return text===challenge.answer?evidence('supported','The model read the synthetic image correctly.'):evidence('inconclusive','The model did not read the synthetic image correctly.');
 }catch(error){
  const message=safeError(error);
  if(signal.aborted)return evidence('inconclusive','The image probe timed out or was cancelled.');
  const unavailable=/\b(401|403|429|5\d\d)\b|auth|credential|rate.limit|quota|timeout|timed out|renew|sign.in|connect ChatGPT/i.test(message);
  const imageRejected=!unavailable&&/does not support.{0,30}image|image.{0,30}(not supported|unsupported)|invalid.{0,20}image|image_url.{0,30}(unsupported|invalid)|\bis not a multimodal model\b/i.test(message);
  return evidence(imageRejected?'rejected':'inconclusive',(imageRejected?'The endpoint rejected image input. ':'The image probe could not complete. ')+message.slice(0,300));
 }finally{local.abort()}
}
