import {createHmac,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {atomicJson,type Registry,type ModelEntry} from './registry';
import {publishedPricing,tokenCost,type TokenPricing,type TokenUsage} from './model-pricing';
const rate=z.number().finite().min(0).max(1e9);
const rates=z.object({currency:z.literal('USD'),inputPerMillion:rate,outputPerMillion:rate,cacheReadPerMillion:rate.optional(),cacheWritePerMillion:rate.optional()}).strict();
const record=z.object({requests:z.number().int().nonnegative(),input:z.number().int().nonnegative(),output:z.number().int().nonnegative(),cacheRead:z.number().int().nonnegative(),cacheWrite:z.number().int().nonnegative(),estimatedUsd:z.number().finite().nonnegative(),unpricedRequests:z.number().int().nonnegative(),startedAt:z.number().int().nonnegative()}).strict();
const saved=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),prices:z.record(z.string(),rates),totals:z.record(z.string(),z.object({binding:z.string().regex(/^[a-f0-9]{64}$/),value:record})),receipts:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8192)}).strict();
type Window={label:string;usedPercent:number;windowMinutes?:number;resetAt?:number};
export class UsageSettingsError extends Error{constructor(message:string,readonly status=400){super(message)}}
const subscription=(api:string)=>['openai-codex-responses','antigravity-http','antigravity-cli','claude-code'].includes(api);
const blank=(now:number)=>({requests:0,input:0,output:0,cacheRead:0,cacheWrite:0,estimatedUsd:0,unpricedRequests:0,startedAt:now});
/** Local accounting and passive quota observation. Never polls a provider. */
export class UsageManager{
 private state:z.infer<typeof saved>={version:1,revision:0,prices:{},totals:{},receipts:[]};
 private key:Buffer=Buffer.alloc(32);private file:string;private unavailable=false;
 private quotas=new Map<string,{binding:string;windows:Window[];observedAt:number;source:string;modelId:string}>();
 warning?:string;
 constructor(private registry:Registry,private options:{changed?:()=>void;now?:()=>number}={}){
  this.file=join(registry.profileDir,'usage.json');
  const keyFile=join(registry.profileDir,'local-auth','usage.key');
  try{
   if(!existsSync(keyFile))try{writeFileSync(keyFile,randomBytes(32),{flag:'wx',mode:0o600})}catch(error:any){if(error?.code!=='EEXIST')throw error}
   this.key=readFileSync(keyFile);if(this.key.length!==32)throw Error();
  }catch{this.unavailable=true;this.warning='Usage accounting is unavailable because its local key could not be read. Existing files were preserved.';return}
  if(existsSync(this.file))try{const data=readFileSync(this.file);if(data.length>2*1024*1024)throw Error();const parsed=saved.parse(JSON.parse(data.toString()));if(Object.keys(parsed.prices).length>4096||Object.keys(parsed.totals).length>4096)throw Error();this.state=parsed}catch{this.unavailable=true;this.warning='Saved usage could not be read. Existing files were preserved and accounting is unavailable.'}
 }
 private now(){return this.options.now?.()??Date.now()}
 private hash(value:unknown){return createHmac('sha256',this.key).update(JSON.stringify(value)).digest('hex')}
 captureBinding(id:string){
  if(this.unavailable)return undefined;
  const p=this.registry.config.providers[id];if(!p)return undefined;
  const identity=p.api==='openai-codex-responses'?this.registry.subscription?.vault.read()?.session:p.api==='antigravity-http'?this.registry.antigravityHttp?.auth.vault.read()?.session:p.api==='antigravity-cli'?this.registry.antigravity?.connectionGeneration():p.api==='claude-code'?this.registry.claudeCode?.connectionGeneration():this.registry.getPrivateCredential(id)??'keyless';
  return this.hash({id,revision:p.revision,endpoint:p.baseUrl,api:p.api,identity:identity??null});
 }
 pricing(model:ModelEntry):TokenPricing|null{
  if(subscription(model.api))return null;
  const manual=this.state.prices[model.qualifiedId];
  return manual?{...manual,source:'manual'}:(model as any).pricing??publishedPricing(model);
 }
 configure(raw:unknown){
  if(this.unavailable)throw new UsageSettingsError('Restore local usage accounting before editing its prices. Existing files were preserved.',503);
  const input=z.object({expectedRevision:z.number().int().nonnegative(),model:z.string().max(1024),pricing:rates.nullable()}).strict().parse(raw);
  if(input.expectedRevision!==this.state.revision)throw new UsageSettingsError('Pricing changed in another window. Reload before saving.',409);
  const model=this.registry.models.get(input.model);if(!model||subscription(model.api))throw new UsageSettingsError('Choose a configured API model.');
  const next=structuredClone(this.state);if(input.pricing)next.prices[input.model]=input.pricing;else delete next.prices[input.model];if(Object.keys(next.prices).length>4096)throw new UsageSettingsError('Too many custom prices.');next.revision++;
  atomicJson(this.file,next);this.state=next;this.changed();return this.snapshot();
 }
 private changed(){try{this.options.changed?.()}catch{/* Accounting must not interrupt inference. */}}
 observeHeaders(model:ModelEntry,headers:Headers|Record<string,string>,binding:string|undefined){
  if(!binding||binding!==this.captureBinding(model.provider)||model.api!=='openai-codex-responses')return;
  const h=new Headers(headers),windows:Window[]=[];
  // Same response fields used by the official Codex client's rate-limit parser.
  for(const name of ['primary','secondary']){
   const raw=h.get('x-codex-'+name+'-used-percent');if(raw===null||!/^\d+(?:\.\d+)?$/.test(raw.trim()))continue;const usedPercent=Number(raw);if(!Number.isFinite(usedPercent)||usedPercent<0||usedPercent>100)continue;
   const minutes=Number(h.get('x-codex-'+name+'-window-minutes')),reset=Number(h.get('x-codex-'+name+'-reset-at'));
   windows.push({label:name==='primary'?'Primary limit':'Secondary limit',usedPercent,...Number.isSafeInteger(minutes)&&minutes>0&&minutes<=525600?{windowMinutes:minutes}:{},...Number.isSafeInteger(reset)&&reset>0&&reset<=1e11?{resetAt:reset*1000}:{}});
  }
  if(!windows.length)return;
  this.quotas.set(model.provider,{binding,windows,observedAt:this.now(),source:'Provider response headers',modelId:model.qualifiedId});this.changed();
 }
 record(model:ModelEntry,value:any,requestId:string,binding:string|undefined){
  if(!binding||binding!==this.captureBinding(model.provider))return;
  const usage:TokenUsage={input:value?.input,output:value?.output,cacheRead:value?.cacheRead??0,cacheWrite:value?.cacheWrite??0};
  if(Object.values(usage).some(n=>!Number.isSafeInteger(n)||n<0||n>1e12))return;
  const receipt=this.hash({id:requestId,binding,model:model.qualifiedId});if(this.state.receipts.includes(receipt))return;
  if(this.state.receipts.length>=8192){this.warning='Local accounting has reached its receipt limit. Later requests are not included.';return}
  const next=structuredClone(this.state),previous=next.totals[model.qualifiedId],total=previous?.binding===binding?previous.value:blank(this.now());
  const price=subscription(model.api)?null:this.pricing(model),cost=tokenCost(usage,price);
  total.requests++;for(const name of ['input','output','cacheRead','cacheWrite'] as const)total[name]+=usage[name];
  if(cost===null)total.unpricedRequests++;else total.estimatedUsd+=cost;
  next.totals[model.qualifiedId]={binding,value:total};next.receipts.push(receipt);
  if(Object.keys(next.totals).length>4096)return;
  try{atomicJson(this.file,next);this.state=next;this.changed()}catch{this.warning='Local usage could not be saved. Totals may be incomplete.'}
 }
 snapshot(){
  return {revision:this.state.revision,selectedModel:this.registry.currentSelection().model,...this.warning?{warning:this.warning}:{},connections:Object.entries(this.registry.config.providers).map(([id,p])=>{
   const binding=this.captureBinding(id),models=[...this.registry.models.values()].filter(m=>m.provider===id),isSub=subscription(p.api);
   const connected=!!p.enabled&&(p.api==='openai-codex-responses'?!!this.registry.subscription?.status().connected:p.api==='antigravity-http'?!!this.registry.antigravityHttp?.available():p.api==='antigravity-cli'?!!this.registry.antigravity?.available():p.api==='claude-code'?!!this.registry.claudeCode?.available():!!this.registry.statuses[id]?.ready);
   const observed=this.quotas.get(id),current=connected&&observed?.binding===binding?observed:undefined;
   const stale=current&&(this.now()<current.observedAt||this.now()-current.observedAt>5*60e3||current.windows.some(w=>w.resetAt!==undefined&&w.resetAt<=this.now()));
   const totals=models.map(m=>this.state.totals[m.qualifiedId]).filter(v=>v&&v.binding===binding).map(v=>v.value),tracked=blank(this.now());tracked.startedAt=totals.length?Math.min(...totals.map(v=>v.startedAt)):this.now();
   for(const total of totals)for(const key of ['requests','input','output','cacheRead','cacheWrite','estimatedUsd','unpricedRequests'] as const)tracked[key]+=total[key];
   return {id,name:p.name,subscription:isSub,connected,quota:current?{status:stale?'stale':'available',windows:current.windows.map(w=>({...w})),observedAt:current.observedAt,source:current.source,modelId:current.modelId}:{status:'unavailable',windows:[]},models:models.map(model=>({id:model.id,qualifiedId:model.qualifiedId,name:model.name,pricing:this.pricing(model)})),tracked:{...tracked,estimatedUsd:isSub||tracked.unpricedRequests>0?null:tracked.estimatedUsd}};
  })};
 }
}
