/** Typed decision transport. Provider metadata never changes its destination. */
export type DecisionJSON=null|boolean|number|string|DecisionJSON[]|{[key:string]:DecisionJSON};
type Instructions=string|DecisionJSON[]|{[key:string]:DecisionJSON}|null;
export type DecisionQuestion=
 |{type:'noul';instructions?:Instructions;criteria?:{'true'?:Instructions;'false'?:Instructions}}
 |{type:'choice';instructions?:Instructions;criteria:Record<string,Instructions>}
 |{type:'score';instructions?:Instructions;criteria:Instructions[]};
export type DecisionAnswer=
 |{type:'noul';noul:number}
 |{type:'choice';choice:string;probabilities:Record<string,number>;confidence?:number}
 |{type:'score';score:number;probabilities:Record<string,number>;confidence?:number};
export type DecisionFormat='flat'|'chat-envelope';
export type DecisionRequest={
 endpointUrl:string;connectionBaseUrl:string;model:string;state:unknown;questions:unknown;
 format?:DecisionFormat;apiKey?:string;signal?:AbortSignal;timeoutMs?:number;maxResponseBytes?:number;
};
export type DecisionResult={model:string;answers:Record<string,DecisionAnswer>;usage?:Record<string,number>};
export type DecisionErrorCode='invalid_request'|'invalid_response'|'network'|'http'|'timeout'|'cancelled';
export class DecisionProviderError extends Error{
 readonly kind:DecisionErrorCode;
 constructor(readonly code:DecisionErrorCode,message:string,readonly status?:number){super(message);this.name='DecisionProviderError';this.kind=code}
}
export const decisionLimits={requestBytes:2*1024*1024,responseBytes:1024*1024,maxResponseBytes:8*1024*1024,timeoutMs:30_000,maxTimeoutMs:120_000,questions:128,depth:32,nodes:100_000} as const;
type Dependencies={fetch?:typeof fetch;redact?:(message:string)=>string};
const invalid=(message:string):never=>{throw new DecisionProviderError('invalid_request',message)};
const malformed=(message:string):never=>{throw new DecisionProviderError('invalid_response',message)};
const record=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const safeKey=(key:string,max=256)=>text(key,max)&&!['__proto__','prototype','constructor'].includes(key);

function jsonCopy(value:unknown):DecisionJSON{
 let nodes=0;const seen=new WeakSet<object>();
 const copy=(item:unknown,depth:number):DecisionJSON=>{
  if(++nodes>decisionLimits.nodes||depth>decisionLimits.depth)invalid('Decision input exceeds the JSON structure limit.');
  if(item===null||typeof item==='string'||typeof item==='boolean')return item;
  if(typeof item==='number'){if(!Number.isFinite(item))invalid('Decision input must contain finite JSON numbers.');return item}
  if(!Array.isArray(item)&&!record(item))invalid('Decision input must contain only JSON values.');
  const object=item as object;
  if(seen.has(object))invalid('Decision input cannot contain circular references.');
  seen.add(object);
  if(Object.getOwnPropertySymbols(object).length)invalid('Decision input cannot contain symbol properties.');
  const descriptors=Object.getOwnPropertyDescriptors(object);
  for(const descriptor of Object.values(descriptors))if(descriptor.get||descriptor.set)invalid('Decision input cannot contain accessors.');
  let result:DecisionJSON;
  if(Array.isArray(item)){
   const list:DecisionJSON[]=[];
   for(let index=0;index<item.length;index++){
    if(!Object.hasOwn(item,index))invalid('Decision input cannot contain sparse arrays.');
    list.push(copy(item[index],depth+1));
   }
   result=list;
  }else result=Object.fromEntries(Object.entries(item as Record<string,unknown>).map(([key,entry])=>[key,copy(entry,depth+1)]));
  seen.delete(object);return result;
 };
 return copy(value,0);
}
function instructions(value:unknown):Instructions{
 if(value!==null&&typeof value!=='string'&&!Array.isArray(value)&&!record(value))invalid('Decision instructions and criteria must be text or structured JSON.');
 return value as Instructions;
}

/** Validate before retrieving a connection's credential or scheduling traffic. */
export function validateDecisionInput(value:{state:unknown;questions:unknown}):{state:DecisionJSON;questions:Record<string,DecisionQuestion>}{
 if(!record(value))invalid('Provide decision state and questions.');
 const copied=jsonCopy(value) as Record<string,DecisionJSON>;
 if(typeof copied.state!=='string'&&!Array.isArray(copied.state)&&!record(copied.state))invalid('Decision state must be text, a JSON object or a JSON array.');
 if(!record(copied.questions))invalid('Decision questions must be an object keyed by question ID.');
 const entries=Object.entries(copied.questions);
 if(entries.length<1||entries.length>decisionLimits.questions)invalid('Provide between 1 and 128 decision questions.');
 const questions:Record<string,DecisionQuestion>=Object.fromEntries(entries.map(([id,raw])=>{
  if(!safeKey(id,128))invalid('Use a nonempty decision question ID of at most 128 characters.');
  if(!record(raw)||!['noul','choice','score'].includes(raw.type))invalid('Each decision question must use noul, choice or score.');
  if(Object.keys(raw).some(key=>!['type','instructions','criteria'].includes(key)))invalid('Decision questions contain an unsupported field.');
  const common=Object.hasOwn(raw,'instructions')?{instructions:instructions(raw.instructions)}:{};
  if(raw.type==='noul'){
   if(raw.criteria!==undefined){
    if(!record(raw.criteria)||Object.keys(raw.criteria).some(key=>!['true','false'].includes(key)))invalid('Noul criteria may describe only true and false.');
    for(const entry of Object.values(raw.criteria))instructions(entry);
   }
   return [id,{type:'noul',...common,...raw.criteria!==undefined?{criteria:raw.criteria}:{}} as DecisionQuestion];
  }
  if(raw.type==='choice'){
   if(!record(raw.criteria)||Object.keys(raw.criteria).length<1||Object.keys(raw.criteria).length>255)invalid('Choice criteria require between 1 and 255 named options.');
   for(const [key,entry] of Object.entries(raw.criteria)){if(!safeKey(key))invalid('Choice option names must be nonempty and at most 256 characters.');instructions(entry)}
   return [id,{type:'choice',...common,criteria:raw.criteria} as DecisionQuestion];
  }
  if(!Array.isArray(raw.criteria)||raw.criteria.length<2||raw.criteria.length>10)invalid('Score criteria require between 2 and 10 ordered levels.');
  for(const entry of raw.criteria)instructions(entry);
  return [id,{type:'score',...common,criteria:raw.criteria} as DecisionQuestion];
 }));
 const result={state:copied.state,questions};
 if(Buffer.byteLength(JSON.stringify(result))>decisionLimits.requestBytes)invalid('Decision input exceeds the request byte limit.');
 return result;
}

/** A complete endpoint must stay inside the explicitly selected API prefix. */
export function validateDecisionEndpoint(endpointUrl:string,connectionBaseUrl:string):string{
 let endpoint:URL,base:URL;
 try{endpoint=new URL(endpointUrl);base=new URL(connectionBaseUrl)}catch{return invalid('Provide complete decision endpoint and connection URLs.')}
 for(const url of [endpoint,base])if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||/%(?:2e|2f|5c)/i.test(url.pathname))invalid('Decision URLs cannot contain credentials, queries, fragments or encoded path separators.');
 const prefix=base.pathname.replace(/\/+$/,'');
 if(endpoint.origin!==base.origin||(prefix&&endpoint.pathname!==prefix&&!endpoint.pathname.startsWith(prefix+'/')))invalid('The decision endpoint must remain inside the selected connection origin and API prefix.');
 return endpoint.href;
}
function requestBody(model:string,input:ReturnType<typeof validateDecisionInput>,format:DecisionFormat){
 if(format==='flat')return {model,...input};
 const questions=Object.entries(input.questions).map(([id,question])=>{
  if(question.type!=='choice')invalid('The documented chat envelope supports Choice questions. Use flat format for Noul or Score.');
  const original=question.instructions===undefined?'':typeof question.instructions==='string'?question.instructions:JSON.stringify(question.instructions);
  // This wire format has option names instead of criteria pairs, so their
  // supplied descriptions must travel in instructions to preserve the rubric.
  const described=Object.values(question.criteria).some(value=>value!==null);
  const instruction=[original,...described?['Option criteria (JSON): '+JSON.stringify(question.criteria)]:[]].filter(Boolean).join('\n\n');
  return {id,type:'choice',instructions:instruction,options:Object.keys(question.criteria)};
 });
 return {model,messages:[{role:'system',content:JSON.stringify({questions})},{role:'user',content:JSON.stringify({state:input.state})}],max_tokens:512};
}
function probability(value:unknown):number{
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>1)malformed('The decision endpoint returned an invalid probability.');
 return value;
}
function probabilities(value:unknown,keys:string[]):Record<string,number>{
 if(!record(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))malformed('The decision probabilities do not match the supplied criteria.');
 return Object.fromEntries(keys.map(key=>[key,probability(value[key])]));
}
function normalized(payload:unknown,questions:Record<string,DecisionQuestion>,requestedModel:string):DecisionResult{
 if(!record(payload)||!record(payload.answers))malformed('The decision endpoint returned no typed answers.');
 const ids=Object.keys(questions);
 if(Object.keys(payload.answers).length!==ids.length||ids.some(id=>!Object.hasOwn(payload.answers,id)))malformed('The returned answers do not match the supplied question IDs.');
 const answers:Record<string,DecisionAnswer>=Object.fromEntries(ids.map(id=>{
  const question=questions[id],answer=payload.answers[id];
  if(!record(answer)||answer.type!==question.type)malformed('A decision answer has the wrong question type.');
  if(question.type==='noul')return [id,{type:'noul',noul:probability(answer.noul)}];
  const confidence=answer.confidence===undefined?{}:{confidence:probability(answer.confidence)};
  if(question.type==='choice'){
   if(typeof answer.choice!=='string'||!Object.hasOwn(question.criteria,answer.choice))malformed('The decision choice is not one of the supplied options.');
   return [id,{type:'choice',choice:answer.choice,probabilities:probabilities(answer.probabilities,Object.keys(question.criteria)),...confidence}];
  }
  if(typeof answer.score!=='number'||!Number.isFinite(answer.score)||answer.score<0||answer.score>question.criteria.length-1)malformed('The decision score is outside the supplied criteria.');
  return [id,{type:'score',score:answer.score,probabilities:probabilities(answer.probabilities,question.criteria.map((_level,index)=>String(index))),...confidence}];
 }));
 if(payload.model!==undefined&&!text(payload.model,512))malformed('The decision endpoint returned an invalid model identifier.');
 const usageKeys=['input_tokens','output_tokens','total_tokens','prompt_tokens','completion_tokens','cached_tokens'];
 const usage=record(payload.usage)?Object.fromEntries(usageKeys.filter(key=>Number.isSafeInteger(payload.usage[key])&&payload.usage[key]>=0&&payload.usage[key]<=1_000_000_000_000).map(key=>[key,payload.usage[key]])):{};
 // Provider confidence is retained as supplied. No calibration claim is made.
 return {model:payload.model??requestedModel,answers,...Object.keys(usage).length?{usage}:{}};
}
function abortable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  pending.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)});
 });
}
async function readJSON(response:Response,signal:AbortSignal,limit:number):Promise<unknown>{
 const declared=Number(response.headers.get('content-length'));
 if(Number.isFinite(declared)&&declared>limit){void response.body?.cancel().catch(()=>{});malformed('Decision response exceeds the byte limit.')}
 const reader=response.body?.getReader();if(!reader)malformed('The decision endpoint returned an empty response.');
 const cancel=()=>{void reader.cancel().catch(()=>{})};signal.addEventListener('abort',cancel,{once:true});
 try{
  const chunks:Uint8Array[]=[];let size=0;
  while(true){const part=await abortable(reader.read(),signal);signal.throwIfAborted();if(part.done)break;size+=part.value.length;if(size>limit){cancel();malformed('Decision response exceeds the byte limit.')}chunks.push(part.value)}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{malformed('The decision endpoint returned invalid JSON.')}
 }finally{signal.removeEventListener('abort',cancel);reader.releaseLock()}
}

/** One request, no redirects or retries, using only its explicitly bound key. */
export async function requestDecisions(request:DecisionRequest,dependencies:Dependencies={}):Promise<DecisionResult>{
 const endpoint=validateDecisionEndpoint(request.endpointUrl,request.connectionBaseUrl);
 const input=validateDecisionInput({state:request.state,questions:request.questions});
 if(!text(request.model,512))invalid('Provide a nonempty decision model identifier.');
 if(request.apiKey!==undefined&&(typeof request.apiKey!=='string'||request.apiKey.length>65536||/[\r\n\0]/.test(request.apiKey)))invalid('The decision credential is invalid.');
 const format=request.format??'flat';if(format!=='flat'&&format!=='chat-envelope')invalid('Choose flat or chat-envelope decision format.');
 const body=JSON.stringify(requestBody(request.model,input,format));if(Buffer.byteLength(body)>decisionLimits.requestBytes)invalid('Decision input exceeds the request byte limit.');
 const timeout=request.timeoutMs??decisionLimits.timeoutMs,limit=request.maxResponseBytes??decisionLimits.responseBytes;
 if(!Number.isSafeInteger(timeout)||timeout<1||timeout>decisionLimits.maxTimeoutMs||!Number.isSafeInteger(limit)||limit<1||limit>decisionLimits.maxResponseBytes)invalid('Decision time and byte limits are invalid.');
 const timed=new AbortController(),signal=request.signal?AbortSignal.any([request.signal,timed.signal]):timed.signal;
 const timer=setTimeout(()=>timed.abort(),timeout);
 const safe=(message:string)=>{
  let result=request.apiKey?message.split(request.apiKey).join('[redacted]'):message;
  if(dependencies.redact)try{result=dependencies.redact(result)}catch{result='Decision request failed.'}
  if(request.apiKey)result=result.split(request.apiKey).join('[redacted]');
  return result.slice(0,600);
 };
 try{
  signal.throwIfAborted();
  const pending=(dependencies.fetch??fetch)(endpoint,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{'content-type':'application/json',accept:'application/json',...request.apiKey?{authorization:'Bearer '+request.apiKey}:{}},body,signal});
  const response=await abortable(pending.then(value=>{if(signal.aborted){void value.body?.cancel().catch(()=>{});throw signal.reason}return value}),signal);
  if(!response.ok){void response.body?.cancel().catch(()=>{});throw new DecisionProviderError('http','Decision endpoint returned HTTP '+response.status+'.',response.status)}
  return normalized(await readJSON(response,signal,limit),input.questions,request.model);
 }catch(error){
  if(request.signal?.aborted)throw new DecisionProviderError('cancelled','Decision request was cancelled.');
  if(timed.signal.aborted)throw new DecisionProviderError('timeout','Decision request timed out.');
  if(error instanceof DecisionProviderError)throw new DecisionProviderError(error.code,safe(error.message),error.status);
  // Network and JSON parser diagnostics can contain request text or headers.
  // Keep them out of stored results and application error messages.
  throw new DecisionProviderError('network',safe('The decision endpoint could not be reached.'));
 }finally{clearTimeout(timer)}
}
