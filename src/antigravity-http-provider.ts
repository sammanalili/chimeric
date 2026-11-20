import type {AssistantMessage,Context,ImageContent,JsonObject,Model,StreamFunction,StreamOptions,TextContent,ThinkingContent,Tool,TranscriptContext,Usage} from '@earendil-works/pi-ai';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {ANTIGRAVITY_HTTP_USER_AGENT} from './antigravity-http-auth';
import {bridgeTransport,transportPreference} from './antigravity-http-bridge';
import {getCurrentTools,normalizeContext} from '@earendil-works/pi-ai/utils/transcript';

// Live-verified 2026-11-11 (work/agy-http-20261111/protocol/PROTOCOL.md). The inference
// host version-gates the client: the wrong User-Agent still returns HTTP 200, but the body
// is a "no longer supported" message instead of a model answer.
export const ANTIGRAVITY_HTTP_BASE_URL='https://daily-cloudcode-pa.googleapis.com';
export {ANTIGRAVITY_HTTP_USER_AGENT};
const INFERENCE_PATH='/v1internal:streamGenerateContent?alt=sse';
const DEFAULT_PROJECT='aicode-consumers';
const VERSION_GATE='This version of Antigravity is no longer supported';
const BODY_LIMIT=2000;
// Live probe (work/agy-http-20261111/protocol/PROTOCOL-GAPS.md §3): sending thinkingConfig
// suppresses thoughtsTokenCount and never streams thought parts, so it is omitted unless a
// caller explicitly asks for a budget. The model id's effort suffix selects the effort.
const THINKING_BUDGETS:Record<string,number>={low:1024,medium:4096,high:8192,xhigh:16384,max:16384};
const ZERO_COST={input:0,output:0,cacheRead:0,cacheWrite:0,total:0};

type FunctionChoice={type:'function';name?:string;function?:{name:string}};
type Choice='auto'|'none'|'required'|FunctionChoice;
type Block=TextContent|ThinkingContent|import('@earendil-works/pi-ai').ToolCall;

export type AntigravityHttpOptions=StreamOptions&{
 toolChoice?:Choice;
 project?:string;
 /** Catalog effort suffix is already part of model.id.
  * thinkingBudget is an explicit opt-in: by default no thinkingConfig is sent (see PROTOCOL-GAPS §3). */
 reasoningEffort?:string;
 thinkingBudget?:number;
 /** Wire transport override (named to avoid pi-ai's `transport:'sse'`). Default: the Go bridge when its binary is present, else fetch. */
 packetTransport?:'bridge'|'fetch';
};

const base=(model:Model<any>)=>model.baseUrl.replace(/\/+$/,'');
function jsonObject(value:any):value is JsonObject{return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function textContent(content:string|(TextContent|ImageContent)[]):string{
 return typeof content==='string'?content:content.map(block=>block.type==='text'?block.text:'').join('');
}
function toolConfig(choice:Choice|undefined){
 if(choice===undefined)return undefined;
 if(choice==='auto')return {functionCallingConfig:{mode:'AUTO'}};
 if(choice==='none')return {functionCallingConfig:{mode:'NONE'}};
 if(choice==='required')return {functionCallingConfig:{mode:'ANY'}};
 const name=choice.function?.name??choice.name;
 return {functionCallingConfig:{mode:'ANY',...name?{allowedFunctionNames:[name]}:{}}};
}
function assistantParts(message:AssistantMessage,model:Model<any>):any[]{
 const parts:any[]=[],sameModel=message.api===model.api&&message.provider===model.provider&&message.model===model.id;
 const geminiVersion=/^gemini-(\d+)(?:[.-]|$)/i.exec(model.id),needsSignature=geminiVersion!==null&&Number(geminiVersion[1])>=3;
 let firstCall=true;
 for(const block of message.content){
  if(block.type==='text'){
   const signature=sameModel?block.textSignature:undefined;
   if(block.text||signature)parts.push({text:block.text,...signature?{thoughtSignature:signature}:{}});
  }else if(block.type==='thinking'){
   if(sameModel)parts.push({text:block.thinking,thought:true,...block.thinkingSignature?{thoughtSignature:block.thinkingSignature}:{}});
  }else{
   // Google documents this migration marker for tool history from models that
   // never supplied a signature. Real signatures take precedence; only the
   // first parallel call requires one. This cannot recover old private thoughts.
   // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking/thought-signatures
   const signature=(sameModel&&block.thoughtSignature?block.thoughtSignature:undefined)??(needsSignature&&firstCall?'skip_thought_signature_validator':undefined);
   parts.push({functionCall:{name:block.name,args:block.arguments,id:block.id},...signature?{thoughtSignature:signature}:{}});
   firstCall=false;
  }
 }
 return parts;
}
function userParts(content:string|(TextContent|ImageContent)[]):any[]{
 if(typeof content==='string')return content?[{text:content}]:[];
 const parts:any[]=[];
 for(const block of content){
  if(block.type==='image')parts.push({inlineData:{mimeType:block.mimeType,data:block.data}});
  else if(block.text)parts.push({text:block.text});
 }
 return parts;
}
function toolResultParts(message:Extract<Context['messages'][number],{role:'toolResult'}>){
 const text=textContent(message.content);
 const images=typeof message.content==='string'?[]:message.content.filter(block=>block.type==='image');
 return [{functionResponse:{name:message.toolName,id:message.toolCallId,response:message.isError?{error:text}:{result:text}}},...userParts(images)];
}
function buildRequest(model:Model<any>,context:TranscriptContext,options:AntigravityHttpOptions){
 const tools=getCurrentTools(context.messages);
 const system=context.messages.filter(message=>message.role==='system').map(message=>textContent(message.content)).filter(Boolean).join('\n\n');
 const contents:any[]=[];
 const append=(role:'user'|'model',parts:any[])=>{
  if(!parts.length)return;
  const last=contents[contents.length-1];
  if(last?.role===role)last.parts.push(...parts);
  else contents.push({role,parts});
 };
 for(const message of context.messages){
  if(message.role==='system')continue;
  if(message.role==='user')append('user',userParts(message.content));
  else if(message.role==='assistant')append('model',assistantParts(message,model));
  else if(message.role==='toolResult')append('user',toolResultParts(message));
 }
 const generationConfig:any={};
 if(options.maxTokens!==undefined)generationConfig.maxOutputTokens=options.maxTokens;
 if(options.temperature!==undefined)generationConfig.temperature=options.temperature;
 const budget=options.thinkingBudget??(options.reasoningEffort!==undefined?THINKING_BUDGETS[options.reasoningEffort]:undefined);
 if(options.thinkingBudget!==undefined&&budget!==undefined)generationConfig.thinkingConfig={thinkingBudget:budget,includeThoughts:true};
 const project=options.project??(model as any).project??DEFAULT_PROJECT;
 const config=toolConfig(options.toolChoice);
 const request:any={contents,...system?{systemInstruction:{parts:[{text:system}]}}:{},...tools.length?{tools:[{functionDeclarations:tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters}))}]}:{},...config?{toolConfig:config}:{},generationConfig};
 // The official client tags every generate call with a correlation id; the field
 // exists in its own request descriptor (see PROTOCOL-GAPS §1).
 const requestId=typeof (options as any).requestId==='string'&&(options as any).requestId
  ?(options as any).requestId
  :globalThis.crypto.randomUUID();
 return {model:model.id,project,request,requestId};
}

function emptyMessage(model:Model<any>):AssistantMessage{
 return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{...ZERO_COST}},stopReason:'pending',timestamp:Date.now()};
}
function usageFrom(metadata:any):Usage{
 const input=Number.isFinite(metadata?.promptTokenCount)?metadata.promptTokenCount:0;
 const output=Number.isFinite(metadata?.candidatesTokenCount)?metadata.candidatesTokenCount:0;
 const total=Number.isFinite(metadata?.totalTokenCount)?metadata.totalTokenCount:input+output;
 return {input,output,cacheRead:0,cacheWrite:0,...Number.isFinite(metadata?.thoughtsTokenCount)?{reasoning:metadata.thoughtsTokenCount}:{},totalTokens:total,cost:{...ZERO_COST}};
}
async function boundedBody(response:Response,apiKey?:string){
 try{return diagnostic(await response.text(),apiKey)}catch{return ''}
}
function httpError(status:number,body:string,host:string,retryAfter?:string|null){
 const failure=(message:string)=>Object.assign(new Error(message),{httpStatus:status});
 const detail=body.trim()?': '+body.trim():'.';
 const wait=retryAfter&&/^\d+$/.test(retryAfter)?' Try again in '+retryAfter+' seconds.':'';
 if(status===429)return failure('Antigravity quota exhausted (HTTP 429). Stop and wait; Chimeric does not retry or switch accounts.'+wait+detail);
 if(status===404&&host.includes('daily-cloudcode-pa.googleapis.com'))return failure('Antigravity model not found (HTTP 404). The model id must include its effort suffix, for example gemini-4-argon-medium.'+detail);
 if(status===401)return failure('Antigravity rejected the access token (HTTP 401). Sign in again in Settings → Connections; Chimeric does not retry with another credential.'+detail);
 if(status===403)return failure('Antigravity refused this account or client (HTTP 403). Stop using this connection and reconnect through the official client instead of retrying.'+detail);
 return failure('Antigravity HTTP request failed with status '+status+detail);
}
function redact(text:string,apiKey?:string){return apiKey?text.split(apiKey).join('[redacted]'):text}
function diagnostic(text:string,apiKey?:string,limit=BODY_LIMIT){return redact(text,apiKey).slice(0,limit)}

/** pi-ai StreamFunction over Google Antigravity's `v1internal:streamGenerateContent` SSE. */
export const stream:StreamFunction<'antigravity-http',AntigravityHttpOptions>=(model,context,options={})=>{
 const events=new AssistantMessageEventStream(),output=emptyMessage(model);
 void (async()=>{
  try{
   if(!options.apiKey)throw new Error('Antigravity HTTP connection is missing its access token.');
   const timeoutMs=options.timeoutMs??120000;
   const deadline=AbortSignal.timeout(timeoutMs);
   const signal=options.signal?AbortSignal.any([options.signal,deadline]):deadline;
   const payload=buildRequest(model,normalizeContext(context as Context),options);
   const url=base(model)+INFERENCE_PATH;
   const transport=options.packetTransport??transportPreference(options.fetch!==undefined);
   let response:Response;
   if(transport==='bridge'){
    // The Go bridge presents the official client's TLS/HTTP2 ClientHello, so
    // packets on the wire match the official CLI (see work/agy-http-20261111/packets/).
    const bridge=bridgeTransport();
    if(!bridge)throw new Error('The Antigravity Go transport bridge is unavailable. Rebuild the app or set CHIMERIC_ANTIGRAVITY_TRANSPORT=fetch.');
    response=await bridge.start(url,options.apiKey,JSON.stringify(payload),signal);
   }else{
    response=await(options.fetch??fetch)(url,{method:'POST',headers:{authorization:'Bearer '+options.apiKey,'content-type':'application/json',accept:'text/event-stream','user-agent':ANTIGRAVITY_HTTP_USER_AGENT},body:JSON.stringify(payload),redirect:'error',signal});
   }
   if(!response.ok)throw httpError(response.status,await boundedBody(response,options.apiKey),base(model),response.headers.get('retry-after'));
   events.push({type:'start',partial:output});

   let finishReason:string|undefined,usage:Usage|undefined,gateChecked=false,gatePrefix='',buffer='';
   const opened:number[]=[];
   const push=(event:any)=>events.push(event);
   const startBlock=(block:TextContent|ThinkingContent)=>{
    const contentIndex=output.content.length;output.content.push(block);opened.push(contentIndex);
    push({type:block.type==='text'?'text_start':'thinking_start',contentIndex,partial:output});
    return contentIndex;
   };
   const attachSignature=(signature:string)=>{
    const last=output.content[output.content.length-1] as any;
    if(last?.type==='thinking'){
     if(last.thinkingSignature)startBlock({type:'thinking',thinking:'',thinkingSignature:signature});
     else last.thinkingSignature=signature;
    }
    else if(last?.type==='toolCall')last.thoughtSignature=signature;
    else if(last?.type==='text'&&!last.textSignature)last.textSignature=signature;
    else startBlock({type:'text',text:'',textSignature:signature});
   };
   const consume=(part:any)=>{
    if(!part||typeof part!=='object')return;
    if(part.functionCall){
     const call=part.functionCall;
     const toolCall:any={type:'toolCall',id:typeof call.id==='string'&&call.id?call.id:'call_'+globalThis.crypto.randomUUID().replaceAll('-',''),name:String(call.name??''),arguments:jsonObject(call.args)?call.args:{}};
     if(typeof part.thoughtSignature==='string')toolCall.thoughtSignature=part.thoughtSignature;
     const contentIndex=output.content.length;
     output.content.push({...toolCall,arguments:{}});
     push({type:'toolcall_start',contentIndex,partial:output});
     output.content[contentIndex]=toolCall;
     push({type:'toolcall_delta',contentIndex,delta:JSON.stringify(toolCall.arguments),partial:output});
     push({type:'toolcall_end',contentIndex,toolCall,partial:output});
     return;
    }
    if(typeof part.text!=='string'||!part.text.length){if(typeof part.thoughtSignature==='string')attachSignature(part.thoughtSignature);return}
    if(part.thought===true){
     const last=output.content[output.content.length-1];
     const contentIndex=last?.type==='thinking'&&!last.thinkingSignature?output.content.length-1:startBlock({type:'thinking',thinking:''});
     const block=output.content[contentIndex] as ThinkingContent;
     block.thinking+=part.text;
     if(typeof part.thoughtSignature==='string')block.thinkingSignature=part.thoughtSignature;
     push({type:'thinking_delta',contentIndex,delta:part.text,partial:output});
     return;
    }
    if(!gateChecked){
     gatePrefix+=part.text;
     if(gatePrefix.startsWith(VERSION_GATE))throw new Error(gatePrefix);
     gateChecked=!VERSION_GATE.startsWith(gatePrefix);
    }
    const last=output.content[output.content.length-1];
    const contentIndex=last?.type==='text'&&!last.textSignature?output.content.length-1:startBlock({type:'text',text:''});
    const block=output.content[contentIndex] as TextContent;
    block.text+=part.text;
    if(typeof part.thoughtSignature==='string')block.textSignature=part.thoughtSignature;
    push({type:'text_delta',contentIndex,delta:part.text,partial:output});
   };
   const consumeLine=(line:string)=>{
    const trimmed=line.endsWith('\r')?line.slice(0,-1):line;
    if(!trimmed.startsWith('data:'))return;
    const data=trimmed.slice(5).trim();
    if(!data||data==='[DONE]')return;
    let parsed:any;try{parsed=JSON.parse(data)}catch{throw new Error('Antigravity emitted malformed SSE JSON.')}
    const serviceError=parsed?.error??parsed?.response?.error;
    if(serviceError){
     const detail=typeof serviceError.message==='string'?diagnostic(serviceError.message,options.apiKey):'The service did not complete the request.';
     throw Number.isInteger(serviceError.code)&&serviceError.code>=400&&serviceError.code<=599
      ?httpError(serviceError.code,detail,base(model))
      :new Error('Antigravity service error: '+detail);
    }
    const frame=parsed?.response??parsed,candidate=frame?.candidates?.[0];
    if(frame?.promptFeedback?.blockReason)throw new Error('Antigravity declined the request ('+diagnostic(String(frame.promptFeedback.blockReason),options.apiKey,100)+').');
    if(frame?.usageMetadata)usage=usageFrom(frame.usageMetadata);
    if(typeof candidate?.finishReason==='string'&&candidate.finishReason&&candidate.finishReason!=='FINISH_REASON_UNSPECIFIED'){
     if(candidate.finishReason!=='STOP'&&candidate.finishReason!=='MAX_TOKENS')throw new Error('Antigravity generation ended with '+diagnostic(candidate.finishReason,options.apiKey,100)+'.');
     finishReason=candidate.finishReason;
    }
    for(const part of candidate?.content?.parts??[])consume(part);
   };
   const body=response.body;
   if(!body)throw new Error('Antigravity returned an empty response body.');
   const contentType=(response.headers.get('content-type')??'').toLowerCase();
   if(contentType&&!contentType.includes('text/event-stream')){
    const text=diagnostic(await response.text(),options.apiKey).trim();
    if(text.startsWith(VERSION_GATE))throw new Error(text);
    throw new Error('Antigravity returned an unexpected non-SSE response: '+text);
   }
   const reader=body.getReader(),decoder=new TextDecoder();let fullyRead=false;
   try{
    for(;;){
     const {done,value}=await reader.read();
     if(done)break;
     buffer+=decoder.decode(value,{stream:true});
     let newline:number;
     while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);consumeLine(line)}
    }
    buffer+=decoder.decode();
    if(buffer.trim())consumeLine(buffer);
    fullyRead=true;
   }finally{
    if(!fullyRead)try{await reader.cancel()}catch{/* Preserve the provider error. */}
    try{reader.releaseLock()}catch{/* The body stream is already closed. */}
   }
   if(!finishReason)throw new Error('Antigravity stream ended without a completion marker.');
   if(!output.content.some(block=>block.type==='toolCall'||block.type==='text'&&block.text.length>0))throw new Error('Antigravity completed without an answer or tool call.');
   for(const contentIndex of opened){
    const block=output.content[contentIndex];
    if(block.type==='text')push({type:'text_end',contentIndex,content:block.text,partial:output});
    else push({type:'thinking_end',contentIndex,content:(block as ThinkingContent).thinking,partial:output});
   }
   if(usage)output.usage=usage;
   output.rawStopReason=finishReason;
   output.stopReason=output.content.some(block=>block.type==='toolCall')?'toolUse':finishReason==='MAX_TOKENS'?'length':'stop';
   push({type:'done',reason:output.stopReason as 'stop'|'length'|'toolUse',message:output});
   events.end(output);
  }catch(error){
   const name=(error as any)?.name;
   const aborted=options.signal?.aborted===true||name==='AbortError'||name==='TimeoutError';
   output.stopReason=aborted?'aborted':'error';
   output.errorMessage=aborted?'Antigravity model request was cancelled.':redact(error instanceof Error?error.message:String(error),options.apiKey);
   const httpStatus=(error as any)?.httpStatus;
   if(Number.isInteger(httpStatus)&&httpStatus>=400&&httpStatus<=599)Object.assign(output,{httpStatus});
   events.push({type:'error',reason:output.stopReason as 'aborted'|'error',error:output});
   events.end(output);
  }
 })();
 return events;
};
