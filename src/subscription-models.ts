import {existsSync,readFileSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

const efforts=['minimal','low','medium','high','xhigh','max'];
export type SubscriptionModel={id:string;name:string;input:Array<'text'|'image'>;reasoning:boolean;reasoningEfforts:Record<string,string>;defaultReasoningEffort?:string;contextWindow?:number;maxTokens?:number};
type RecordData={schemaVersion:1;session:string;fetchedAt:number;models:SubscriptionModel[]};
const positive=(value:unknown,max:number)=>typeof value==='number'&&Number.isInteger(value)&&value>0&&value<=max?value:undefined;

/** Accept model metadata only. Server instructions and arbitrary fields never enter config. */
export function parseSubscriptionModels(value:any):SubscriptionModel[]{
 if(!value||!Array.isArray(value.models)||value.models.length>2048)throw Error('OpenAI returned an invalid model catalog.');
 const models=new Map<string,SubscriptionModel>();
 for(const raw of value.models){
  if(!raw||typeof raw!=='object'||(raw.visibility!==undefined&&raw.visibility!=='list')||raw.hidden===true)continue;
  const id=raw.slug??raw.id;
  if(typeof id!=='string'||!id.trim()||id.length>512||/[\s\x00-\x1f\x7f]/.test(id)||['__proto__','constructor','prototype'].includes(id))throw Error('OpenAI returned an invalid model identifier.');
  if(models.has(id))throw Error('OpenAI returned duplicate model identifiers.');
  const rawName=raw.display_name??raw.displayName??raw.name??id;
  const name=typeof rawName==='string'&&rawName.trim()&&rawName.length<=200?rawName:id;
  const supplied=raw.input_modalities??raw.inputModalities??raw.modalities;
  const input=(Array.isArray(supplied)?supplied.filter((x:any)=>x==='text'||x==='image'):['text']) as Array<'text'|'image'>;
  if(!input.includes('text'))continue;
  const levels=raw.supported_reasoning_levels??raw.supportedReasoningEfforts??raw.reasoning_efforts;
  const names=Array.isArray(levels)?levels.map((x:any)=>typeof x==='string'?x:x?.effort??x?.reasoningEffort).filter((x:any)=>efforts.includes(x)):[];
  const reasoningEfforts=Object.fromEntries(efforts.filter(e=>names.includes(e)).map(e=>[e,e]));
  const preferred=raw.default_reasoning_level??raw.defaultReasoningEffort??raw.default_reasoning_effort;
  const contextWindow=positive(raw.context_window??raw.contextWindow??raw.max_input_tokens,16_000_000);
  const maxTokens=positive(raw.max_output_tokens??raw.maxTokens,4_000_000);
  models.set(id,{id,name,input:[...new Set(input)],reasoning:Object.keys(reasoningEfforts).length>0,reasoningEfforts,
   ...(Object.hasOwn(reasoningEfforts,preferred)?{defaultReasoningEffort:preferred}:{}),...(contextWindow?{contextWindow}:{}),...(maxTokens?{maxTokens}:{})});
 }
 return [...models.values()];
}

/** Metadata is bound to a login session. Token refresh within that session keeps it valid. */
export class SubscriptionModels{
 private record?:RecordData;
 private flight?:{session:string;controller:AbortController;done:Promise<void>};
 private issue?:{session:string;message:string};
 constructor(private options:{path:string;session:()=>string|undefined;fetch:(signal:AbortSignal)=>Promise<Response>;onChange:()=>Promise<void>|void;timeoutMs?:number}){
  if(existsSync(options.path))try{
   const bytes=readFileSync(options.path);if(bytes.length>2*1024*1024)throw Error('Oversized cache');
   const value=JSON.parse(bytes.toString());
   if(value.schemaVersion!==1||typeof value.session!=='string'||!Number.isFinite(value.fetchedAt)||!Array.isArray(value.models))throw Error('Invalid cache');
   // Revalidate the persisted representation through the same allowlisted parser.
   const models=parseSubscriptionModels({models:value.models.map((m:any)=>({...m,supportedReasoningEfforts:Object.keys(m.reasoningEfforts??{}),inputModalities:m.input}))});
   this.record={schemaVersion:1,session:value.session,fetchedAt:value.fetchedAt,models};
  }catch{const session=options.session();if(session)this.issue={session,message:'The saved ChatGPT model catalog could not be read. Refresh models to recover.'};}
 }
 current(){return this.record?.session===this.options.session()?this.record:undefined;}
 status(){const session=this.options.session(),record=this.current();return{state:!session?'disconnected':this.flight?.session===session?'refreshing':this.issue?.session===session?'error':record?'ready':'not_loaded',count:record?.models.length??0,...record?{fetchedAt:record.fetchedAt}:{},...(session&&this.issue?.session===session?{message:this.issue.message}:{})};}
 async refresh(force=true){
  const session=this.options.session();if(!session)throw Error('Sign in with ChatGPT before discovering models.');
  if(this.flight?.session===session)return this.flight.done;
  if(!force&&this.current()&&Date.now()-this.current()!.fetchedAt<15*60_000)return;
  this.flight?.controller.abort();
  const controller=new AbortController(),flight={session,controller,done:undefined as unknown as Promise<void>};
  this.flight=flight;this.issue=undefined;
  flight.done=Promise.resolve().then(async()=>{
   try{
    await this.options.onChange();
    const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(this.options.timeoutMs??20_000)]);
    const response=await this.options.fetch(signal);
    if(!response.ok){await response.body?.cancel();throw Error('OpenAI model discovery returned HTTP '+response.status+'.');}
    if(Number(response.headers.get('content-length'))>2*1024*1024){await response.body?.cancel();throw Error('OpenAI model catalog exceeds its size limit.');}
    const reader=response.body?.getReader();if(!reader)throw Error('OpenAI returned an empty model catalog response.');
    const chunks:Uint8Array[]=[];let total=0;
    const abort=()=>{void reader.cancel().catch(()=>undefined)};signal.addEventListener('abort',abort,{once:true});
    try{while(true){signal.throwIfAborted();const part=await reader.read();if(part.done)break;total+=part.value.length;if(total>2*1024*1024){await reader.cancel();throw Error('OpenAI model catalog exceeds its size limit.');}chunks.push(part.value)}}finally{signal.removeEventListener('abort',abort);reader.releaseLock()}
    const models=parseSubscriptionModels(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    signal.throwIfAborted();if(this.flight!==flight||this.options.session()!==session)return;
    const record:RecordData={schemaVersion:1,session,fetchedAt:Date.now(),models};
    const temp=this.options.path+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(record)+'\n',{mode:0o600});renameSync(temp,this.options.path);this.record=record;
   }catch(error){
    if(this.flight!==flight||this.options.session()!==session)return;
    this.issue={session,message:controller.signal.aborted?'ChatGPT model discovery was cancelled.':error instanceof Error&&/^OpenAI (?:model|returned)/.test(error.message)?error.message:'ChatGPT model discovery failed. Your last saved models are still available. Retry Refresh models.'};
   }finally{
    if(this.flight===flight){this.flight=undefined;try{await this.options.onChange()}catch(error){if(this.options.session()===session)this.issue={session,message:'ChatGPT model discovery failed. Your last saved models are still available. Retry Refresh models.'};throw error}}
   }
  });
  return flight.done;
 }
 invalidate(){this.flight?.controller.abort();this.flight=undefined;this.record=undefined;this.issue=undefined;try{unlinkSync(this.options.path)}catch(error:any){if(error?.code!=='ENOENT')throw error}}
 close(){this.flight?.controller.abort();this.flight=undefined;}
}
