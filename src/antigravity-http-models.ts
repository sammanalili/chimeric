import {join} from 'node:path';
import {AntigravityHttpAuth,AntigravityHttpError,ANTIGRAVITY_CLIENT_VERSION,ANTIGRAVITY_CONTROL_URL,ANTIGRAVITY_HTTP_USER_AGENT,ANTIGRAVITY_INFERENCE_URL,installedCliVersion} from './antigravity-http-auth';
import {stream as antigravityHttpStream,type AntigravityHttpOptions} from './antigravity-http-provider';
import {closeBridge} from './antigravity-http-bridge';
import type {StreamFunction} from '@earendil-works/pi-ai';

/** Managed connection that speaks directly to Google's Antigravity service. */
export const ANTIGRAVITY_HTTP_PROVIDER_ID='antigravity-http';
export const ANTIGRAVITY_HTTP_BASE_URL=ANTIGRAVITY_INFERENCE_URL;

export type AntigravityHttpCatalogModel={
 id:string;
 name:string;
 displayName?:string;
 input:Array<'text'|'image'>;
 contextWindow:number;
 maxTokens:number;
 /** Registry-compatible aliases so limits survive catalog publishing. */
 max_input_tokens:number;
 max_output_tokens:number;
 apiProvider?:string;
 supportsThinking:boolean;
 thinkingBudget?:number;
 recommended:boolean;
};
export type AntigravityHttpPickerModel=AntigravityHttpCatalogModel&{
 reasoning:boolean;
 reasoningEfforts:Record<string,string>;
 antigravitySlugs:Record<string,string>;
 defaultReasoningEffort?:string;
};
export type AntigravityImageModel={id:string;name:string};
type StreamWaiter={grant:(release:()=>void)=>void;reject:(error:Error)=>void;cleanup:()=>void};

const TEXT_MODEL=/(^|[-_])(low|medium|high|xhigh|max)$/;
const validCatalogId=(id:unknown):id is string=>typeof id==='string'&&id.length>0&&id.length<=200&&/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id);
function catalogModelMap(payload:any,allowMissing=false):Record<string,any>{
 const models=payload?.models;
 if(models===undefined&&allowMissing&&payload&&typeof payload==='object'&&!Array.isArray(payload))return {};
 if(!models||typeof models!=='object'||Array.isArray(models))throw new AntigravityHttpError('Antigravity returned an invalid model catalog.');
 return models;
}
function normalizeImageCatalog(payload:any):AntigravityImageModel[]{
 const models=catalogModelMap(payload,true),ids=Array.isArray(payload.imageGenerationModelIds)?payload.imageGenerationModelIds:[];
 return [...new Set<string>(ids.filter(validCatalogId))]
  .filter(id=>models[id]?.isInternal!==true)
  .map(id=>({id,name:typeof models[id]?.displayName==='string'&&models[id].displayName.trim()?models[id].displayName.trim():id}));
}

/**
 * Live-verified on the consumer subscription but not advertised by
 * `fetchAvailableModels`: the inference service routes these ids anyway. Every
 * entry here was proven by a direct probe (text generation, each effort variant,
 * and image input) before being added — see
 * work/agy-http-20261111/live/carbon-probe.json and carbon-image.json. Limits are
 * not advertised for these ids, so the same-family defaults are used.
 */
const SUPPLEMENTAL_MODELS:AntigravityHttpCatalogModel[]=[
 {id:'gemini-4-carbon-low',name:'Gemini 4 Carbon (Low)',displayName:'Gemini 4 Carbon (Low)',input:['text','image'],contextWindow:1_048_576,maxTokens:65_536,max_input_tokens:1_048_576,max_output_tokens:65_536,supportsThinking:true,recommended:false},
 {id:'gemini-4-carbon-medium',name:'Gemini 4 Carbon (Medium)',displayName:'Gemini 4 Carbon (Medium)',input:['text','image'],contextWindow:1_048_576,maxTokens:65_536,max_input_tokens:1_048_576,max_output_tokens:65_536,supportsThinking:true,recommended:false},
 {id:'gemini-4-carbon-high',name:'Gemini 4 Carbon (High)',displayName:'Gemini 4 Carbon (High)',input:['text','image'],contextWindow:1_048_576,maxTokens:65_536,max_input_tokens:1_048_576,max_output_tokens:65_536,supportsThinking:true,recommended:false},
];
/** Normalizes `fetchAvailableModels` into model entries the registry can publish. */
function normalizeTextCatalog(payload:any,allowEmpty=false):AntigravityHttpCatalogModel[]{
 const models=catalogModelMap(payload,allowEmpty);
 // The service also publishes models for tab completion, search and image
 // generation. Only agentModelSorts describes the research model picker.
 const pickerIds=new Set<string>();
 if(Array.isArray(payload.agentModelSorts))for(const section of payload.agentModelSorts){
  if(!Array.isArray(section?.groups))continue;
  for(const group of section.groups){
   if(!Array.isArray(group?.modelIds))continue;
   for(const id of group.modelIds)if(validCatalogId(id)&&Object.hasOwn(models,id))pickerIds.add(id);
  }
 }
 const imageIds=new Set(Array.isArray(payload.imageGenerationModelIds)?payload.imageGenerationModelIds.filter(validCatalogId):[]);
 const entries:AntigravityHttpCatalogModel[]=[];
 for(const [id,value] of Object.entries<any>(models)){
  if(!validCatalogId(id)||value?.isInternal||/^(?:chat|tab)_/.test(id))continue;
  if(imageIds.has(id)||pickerIds.size&&!pickerIds.has(id))continue;
  // Unnamed helper entries (chat_*, tab_*) drive internal features, not the picker.
  if(typeof value?.displayName!=='string'||!value.displayName.trim())continue;
  const supportsImages=value?.supportsImages===true;
  const displayName=typeof value?.displayName==='string'&&value.displayName.trim()?value.displayName.trim():id;
  const contextWindow=Number.isFinite(value?.maxTokens)&&value.maxTokens>0?Math.floor(value.maxTokens):128_000;
  const maxTokens=Number.isFinite(value?.maxOutputTokens)&&value.maxOutputTokens>0?Math.floor(value.maxOutputTokens):65_536;
  entries.push({id,name:displayName,displayName,input:supportsImages?['text','image']:['text'],contextWindow,maxTokens,max_input_tokens:contextWindow,max_output_tokens:maxTokens,
   apiProvider:typeof value?.apiProvider==='string'?value.apiProvider:undefined,
   supportsThinking:value?.supportsThinking===true,
   thinkingBudget:Number.isFinite(value?.thinkingBudget)?value.thinkingBudget:undefined,
   recommended:value?.recommended===true});
 }
 // Keep effort variants adjacent and ordered from low to high.
 const rank=(model:AntigravityHttpCatalogModel)=>TEXT_MODEL.exec(model.id)?.[2]??'';
 const order=['low','medium','high','xhigh','max',''];
 entries.sort((left,right)=>{
  const a=rank(left),b=rank(right);
  const base=left.id.replace(TEXT_MODEL,'').localeCompare(right.id.replace(TEXT_MODEL,''));
  if(base)return base;
  return order.indexOf(a)-order.indexOf(b);
 });
 if(!entries.length&&!allowEmpty)throw new AntigravityHttpError('Antigravity advertised no usable models.');
 return entries;
}
export function normalizeAntigravityHttpCatalog(payload:any):AntigravityHttpCatalogModel[]{return normalizeTextCatalog(payload)}

/** One picker row per model family; exact service ids remain in its effort map. */
export function groupAntigravityHttpModels(variants:AntigravityHttpCatalogModel[]):AntigravityHttpPickerModel[]{
 const groups=new Map<string,AntigravityHttpCatalogModel[]>();
 for(const variant of variants){
  const id=variant.id.replace(TEXT_MODEL,'');
  const group=groups.get(id)??[];group.push(variant);groups.set(id,group);
 }
 return [...groups].map(([id,group])=>{
  const preferred=group.find(model=>TEXT_MODEL.exec(model.id)?.[2]==='medium')??group[0];
  const slugs:Record<string,string>={};
  for(const variant of group)slugs[TEXT_MODEL.exec(variant.id)?.[2]??'default']=variant.id;
  const efforts=Object.keys(slugs).filter(effort=>effort!=='default');
  const contextWindow=Math.min(...group.map(model=>model.contextWindow)),maxTokens=Math.min(...group.map(model=>model.maxTokens));
  const name=preferred.name.replace(/\s*\((?:Low|Medium|High|Extra High|Max)(?:,\s*([^)]*))?\)\s*$/i,(_label,rest:string|undefined)=>rest?' ('+rest+')':'');
  const supportsThinking=group.some(model=>model.supportsThinking);
  return {...preferred,id,name,displayName:name,input:group.every(model=>model.input.includes('image'))?['text','image']:['text'],
   contextWindow,maxTokens,max_input_tokens:contextWindow,max_output_tokens:maxTokens,
   supportsThinking,reasoning:supportsThinking||efforts.length>0,
   reasoningEfforts:Object.fromEntries(efforts.map(effort=>[effort,effort])),antigravitySlugs:slugs,
   ...(efforts.length?{defaultReasoningEffort:efforts.includes('medium')?'medium':efforts[0]}:{}),
   recommended:group.some(model=>model.recommended)} as AntigravityHttpPickerModel;
 });
}

export class AntigravityHttpModels {
 readonly auth:AntigravityHttpAuth;
 private variants:AntigravityHttpCatalogModel[]=[];
 private models:AntigravityHttpPickerModel[]=[];
 private imageModels:AntigravityImageModel[]=[];
 private discovery:{state:'idle'|'refreshing'|'ready'|'error';message?:string;fetchedAt?:number}={state:'idle'};
 private refreshing?:Promise<unknown>;
 private generation=0;
 private closed=false;
 private lifecycle=new AbortController();
 private projectId?:string;
 /** Soft concurrency cap: bursty parallel turns must not look like a scrape. */
 private inFlight=0;
 private clientIdentity:{presented:string;installed?:string;matches?:boolean}={presented:ANTIGRAVITY_CLIENT_VERSION};
 private waiters:StreamWaiter[]=[];
 private listeners=new Set<()=>void>();
 constructor(profile:string,private options:{auth?:AntigravityHttpAuth;stream?:StreamFunction<'antigravity-http',AntigravityHttpOptions>;
  assertAccess?:()=>void;accessSignal?:()=>AbortSignal}={}){
  this.auth=options.auth??new AntigravityHttpAuth(join(profile,'local-auth'));
  this.auth.onChange(()=>{if(this.auth.status().connected&&!this.models.length)void this.refresh().catch(()=>undefined);this.changed()});
 }
 onChange(listener:()=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 private changed(){for(const listener of this.listeners)listener()}
 catalog(){return this.models}
 imageCatalog(){return this.imageModels.map(model=>({...model}))}
 /** Retains exact suffix ids for saved selections while publishing family ids. */
 resolveAlias(id:string):{id:string;effort?:string}|undefined{
  for(const model of this.models){
   if(model.id===id)return {id:model.id};
   for(const [effort,slug] of Object.entries(model.antigravitySlugs))if(slug===id)return {id:model.id,...effort==='default'?{}:{effort}};
  }
  return undefined;
 }
 private access(){
  // Keep the signal from this policy generation. A later re-enable must not
  // revive work that was queued or started under a revoked connection.
  const signal=this.options.accessSignal?.();
  const assert=()=>{this.options.assertAccess?.();signal?.throwIfAborted()};
  assert();return {signal,assert};
 }
 available(){try{this.access();return !this.closed&&this.auth.status().connected&&this.discovery.state==='ready'}catch{return false}}
 status(){
  return {...this.auth.status(),client:{...this.clientIdentity},modelDiscovery:{...this.discovery,count:this.models.length,variantCount:this.variants.length},
   models:this.models.map(({id,name,input,contextWindow,maxTokens,reasoningEfforts,defaultReasoningEffort})=>({id,name,input,contextWindow,maxTokens,reasoningEfforts,defaultReasoningEffort})),imageModels:this.imageCatalog()};
 }
 async connect(){await this.auth.start('browser');return this.status()}
 async authenticate(raw:unknown){const method=raw&&typeof raw==='object'&&(raw as any).method==='import'?'import':'browser';await this.auth.start(method);if(this.auth.status().connected)await this.refresh();return this.status()}
 async disconnect(){this.generation++;this.lifecycle.abort();this.lifecycle=new AbortController();this.cancelWaiting();closeBridge();this.discovery={state:'idle'};this.models=[];this.variants=[];this.imageModels=[];this.auth.disconnect();this.changed();return this.status()}
 async restore(){if(this.auth.status().connected)try{await this.refresh()}catch{/* Status retains the discovery error. */}}
 refresh(){
  if(this.refreshing)return this.refreshing;
  if(!this.auth.status().connected)return Promise.reject(new AntigravityHttpError('Connect Antigravity before refreshing its models.',false,409));
  const generation=this.generation;
  this.discovery={state:'refreshing'};this.changed();
  const pending=(async()=>{
   try{
    const controller=new AbortController();
    // The service gates on the presented client identity, so keep it honest about
    // the installed official client instead of silently drifting.
    const installed=installedCliVersion();
    this.clientIdentity={presented:ANTIGRAVITY_CLIENT_VERSION,...(installed?{installed,matches:installed===ANTIGRAVITY_CLIENT_VERSION}:{})};
    const auth=await this.auth.requestAuth(controller.signal);
    const profile=await this.auth.profileInfo(controller.signal);
    // agy sends the resolved project here, not an empty body; a project-less
    // request is answered from the free-tier view of the catalog.
    const response=await auth.fetch(ANTIGRAVITY_CONTROL_URL+'/v1internal:fetchAvailableModels',{method:'POST',
     headers:{'content-type':'application/json','user-agent':ANTIGRAVITY_HTTP_USER_AGENT},body:JSON.stringify({project:profile.project})});
    if(!response.ok){await response.body?.cancel();throw new AntigravityHttpError('Antigravity model catalog returned HTTP '+response.status+'.',response.status<500)}
    const payload=await response.json() as any;
    const models=normalizeTextCatalog(payload,true),imageModels=normalizeImageCatalog(payload);
    if(!models.length&&!imageModels.length)throw new AntigravityHttpError('Antigravity advertised no usable models.');
    if(this.closed||generation!==this.generation)return this.status();
    // Merge probe-verified models the consumer catalog does not advertise. An
    // advertised entry always wins, so a later catalog update replaces these.
    const advertised=new Set(models.map(model=>model.id));
    this.variants=models.length?[...models,...SUPPLEMENTAL_MODELS.filter(model=>!advertised.has(model.id)).map(model=>({...model}))]:[];
    this.models=groupAntigravityHttpModels(this.variants);
    this.imageModels=imageModels;
    this.discovery={state:'ready',fetchedAt:Date.now()};
    // Cache the project for the registry's per-model request envelopes.
    this.projectId=profile.project;
    this.changed();
    return this.status();
   }catch(error){
    if(generation===this.generation&&!this.closed){this.discovery={state:'error',message:this.auth.redact(error instanceof Error?error.message:'Could not refresh Antigravity models.')};this.changed()}
    throw error;
   }
  })();
  this.refreshing=pending;
  void pending.finally(()=>{if(this.refreshing===pending)this.refreshing=undefined}).catch(()=>undefined);
  return pending;
 }
 /** Current project id; every inference envelope must carry it. */
 project(){return this.projectId}
 /** Image and chat requests share the same subscription concurrency budget. */
 async runRequest<T>(run:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const access=this.access();
  if(!this.available())throw new AntigravityHttpError('Connect Antigravity and refresh its models in Settings → Connections.',false,409);
  const generation=this.generation,combined=AbortSignal.any([this.lifecycle.signal,...signal?[signal]:[],...access.signal?[access.signal]:[]]);
  const release=await this.acquire(combined);
  try{
   combined.throwIfAborted();access.assert();
   if(this.closed||generation!==this.generation)throw new AntigravityHttpError('The Antigravity connection changed while this request was waiting.',false,409);
   const result=await run(combined);access.assert();return result;
  }finally{release()}
 }
 stream(model:any,context:any,options:AntigravityHttpOptions={}){
  const access=this.access();
  if(!this.available())throw new AntigravityHttpError('Connect Antigravity and refresh its models in Settings → Connections.',false,409);
  const signal=AbortSignal.any([this.lifecycle.signal,...options.signal?[options.signal]:[],...access.signal?[access.signal]:[]]);
  // Provider streams start their network request at construction, so defer the
  // construction itself until a request slot has been reserved.
  return this.throttle(()=>{
   const alias=this.resolveAlias(model.id),family=alias&&this.models.find(entry=>entry.id===alias.id);
   if(!family)throw new AntigravityHttpError('This Antigravity model is unavailable in the current research catalog. Refresh models.',false,409);
   const effort=options.reasoningEffort??alias?.effort??model.defaultReasoningEffort??family.defaultReasoningEffort;
   const slug=effort?family.antigravitySlugs[effort]:family.antigravitySlugs.default;
   if(!slug)throw new AntigravityHttpError('Choose a supported Antigravity reasoning effort for this model.',false,400);
   return (this.options.stream??antigravityHttpStream)({...model,id:slug,baseUrl:ANTIGRAVITY_HTTP_BASE_URL} as any,context,{...options,signal,reasoningEffort:effort,project:options.project??model.antigravityProject??this.project()});
  },signal,this.generation,access.assert) as any;
 }
 /** At most `maxConcurrent` model requests in flight; extra turns wait instead of bursting. */
 private async *throttle(start:()=>AsyncIterable<any>,signal:AbortSignal|undefined,generation:number,assertAccess:()=>void){
  assertAccess();
  const release=await this.acquire(signal);
  try{
   signal?.throwIfAborted();assertAccess();
   if(this.closed||generation!==this.generation)throw new AntigravityHttpError('The Antigravity connection changed while this request was waiting.',false,409);
   for await(const event of start()){assertAccess();yield event}
   assertAccess();
  }finally{release()}
 }
 private acquire(signal?:AbortSignal):Promise<()=>void>{
  signal?.throwIfAborted();
  if(this.closed)return Promise.reject(new AntigravityHttpError('The Antigravity connection is closing.',false,409));
  if(this.inFlight<4&&!this.waiters.length){this.inFlight++;return Promise.resolve(this.releaseSlot())}
  return new Promise((resolve,reject)=>{
   const waiter:StreamWaiter={grant:resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)};
   const abort=()=>{
    this.waiters=this.waiters.filter(entry=>entry!==waiter);waiter.cleanup();
    reject(new AntigravityHttpError('The Antigravity request was cancelled while waiting its turn.',false,499));
   };
   signal?.addEventListener('abort',abort,{once:true});this.waiters.push(waiter);
  });
 }
 private releaseSlot(){
  let released=false;
  return ()=>{
   if(released)return;released=true;
   // Transfer the reserved slot directly to the next waiter. Decrementing it
   // before that waiter resumes would let a new caller steal the same slot.
   const next=this.waiters.shift();
   if(next){next.cleanup();next.grant(this.releaseSlot())}else this.inFlight--;
  };
 }
 private cancelWaiting(){
  const waiting=this.waiters;this.waiters=[];
  for(const waiter of waiting){waiter.cleanup();waiter.reject(new AntigravityHttpError('The Antigravity connection changed while this request was waiting.',false,409))}
 }
 async close(){if(this.closed)return;this.closed=true;this.generation++;this.lifecycle.abort();this.cancelWaiting();closeBridge();this.auth.close()}
}
