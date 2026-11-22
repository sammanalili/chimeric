import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {z} from 'zod';
import {Registry,Configuration,Provider,atomicJson,type ModelEntry} from './registry';
import {chatSelectorEligible} from './catalog';
import {probeImage,type ImageProbeEvidence} from './model-probe';
type ProbeJob={id:string;providerId:string;status:'running'|'completed'|'cancelled';total:number;completed:number;createdAt:number;finishedAt?:number};
type ActiveProbeJob={public:ProbeJob;controller:AbortController;done:Promise<void>;resolve:()=>void};

const Model=z.object({id:z.string().trim().min(1).max(512),name:z.string().trim().min(1).max(200).optional(),contextWindow:z.number().int().min(1024).max(16000000).optional(),maxTokens:z.number().int().min(64).max(4000000).optional()});
const Capability=z.object({images:z.boolean(),reasoning:z.boolean(),efforts:z.array(z.enum(['minimal','low','medium','high','xhigh','max'])).min(1).max(6).default(['low','medium','high']),thinkingFormat:z.enum(['openai','qwen-chat-template','deepseek','zai','chat-template']).default('openai')});
const Connection=z.object({
  expectedRevision:z.number().int().nonnegative(),id:z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/).optional(),
  connectionRevision:z.string().optional(),
  name:z.string().trim().min(1).max(120),baseUrl:z.string().trim().url().max(2048),
  api:z.enum(['openai-completions','openai-responses','openai-codex-responses','anthropic-messages']),apiKey:z.string().max(16384).optional(),
  clearCredential:z.boolean().default(false),confirmDestinationChange:z.boolean().default(false),
  allowInsecureHttp:z.boolean().default(false),mode:z.enum(['discover','manual']).default('discover'),
  models:z.array(Model).max(1024).optional(),capabilities:Capability.optional(),
  requestTimeoutMs:z.number().int().min(1000).max(3_600_000).default(600_000),
});

export class ProviderChangeError extends Error {
  constructor(message:string,readonly status=400){super(message)}
}

/** Serializes configuration commits; streams retain their model/auth snapshots. */
export class ProviderManager {
  private queue:Promise<unknown>=Promise.resolve();
  private listeners=new Set<(revision:string)=>void>();
  cleanupWarning?:string;
  private probeJobs=new Map<string,ActiveProbeJob>();
  private probeQueue:Array<{job:ActiveProbeJob;model:ModelEntry;fingerprint:string}>=[];
  private activeProbes=0;
  private closing=false;
  private serviceRevision=0;
  constructor(readonly registry:Registry,private changed:()=>void=()=>{},private probeOptions:{timeoutMs?:number}={}){}
  private serial<T>(action:()=>Promise<T>):Promise<T>{
    const job=this.queue.then(action);
    this.queue=job.catch(()=>undefined);
    return job;
  }
  private check(expected:number){
    if(expected!==this.registry.revision)throw new ProviderChangeError('Connections changed in another window. Reload the connection list before saving.',409);
  }
  event(){const selection=this.registry.currentSelection();return JSON.stringify({catalogRevision:this.catalogRevision,selectedModel:selection.model,effort:selection.effort,serviceRevision:this.serviceRevision})}
  notifyServiceChange(){this.serviceRevision++;this.publish()}
  publish(){for(const listener of this.listeners)listener(this.event())}
  get catalogRevision(){return 'chimeric-'+this.registry.revision+'-'+this.registry.catalogGeneration}
  subscribe(listener:(revision:string)=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
  notify(){
    this.registry.revalidateImageProbes();this.registry.catalogGeneration=randomUUID();this.changed();
    this.publish();
  }
  refreshAntigravity(){return this.serial(async()=>{const ids=Object.entries(this.registry.config.providers).filter(([,p])=>p.api==='antigravity-cli'||p.api==='antigravity-http').map(([id])=>id);if(ids.length)await this.registry.refresh(true,ids);this.notify();});}
  refreshSubscriptions(){return this.serial(async()=>{const ids=Object.entries(this.registry.config.providers).filter(([,p])=>p.api==='openai-codex-responses'||p.api==='claude-code').map(([id])=>id);if(ids.length)await this.registry.refresh(true,ids);this.notify();});}
  snapshot(){
    const r=this.registry;
    const roleModels=[...r.models.values()].filter(m=>m.mode==='chat'&&m.input.includes('text')).map(m=>({qualifiedId:m.qualifiedId,name:m.name,provider:m.providerName,available:chatSelectorEligible(r,m)}));
    for(const id of Object.values(r.config.roles))if(!roleModels.some(model=>model.qualifiedId===id)){
      try{const model=r.resolve(id);roleModels.push({qualifiedId:id,name:model.name+(model.defaultReasoningEffort?' ('+model.defaultReasoningEffort+')':''),provider:model.providerName,available:chatSelectorEligible(r,model)})}catch{roleModels.push({qualifiedId:id,name:id,provider:'Unavailable',available:false})}
    }
    const hiddenModels=[...new Set((r.config.hiddenModels??[]).map(id=>r.canonicalId(id)))];
    return {revision:r.revision,catalogRevision:this.catalogRevision,selectedModel:r.currentSelection().model,roles:{...r.config.roles},headlineModels:[...new Set(r.config.headlineModels.map(id=>r.canonicalId(id)))],hiddenModels,roleModels,probeJobs:[...this.probeJobs.values()].map(job=>({...job.public})),
      connections:Object.entries(r.config.providers).map(([id,p])=>({
        id,name:p.name,baseUrl:p.baseUrl,api:p.api,enabled:p.enabled,mode:p.models?'manual':'discover',connectionRevision:p.revision,
        allowInsecureHttp:p.allowInsecureHttp,requestTimeoutMs:p.requestTimeoutMs,
        hasCredential:!!r.getPrivateCredential(id),subscription:p.api==='openai-codex-responses',managed:p.api==='antigravity-cli'||p.api==='antigravity-http'||p.api==='claude-code',status:r.statuses[id],...(p.api==='openai-codex-responses'?{modelDiscovery:r.subscription?.modelCatalog.status()}:{}),
        models:[...r.models.values()].filter(m=>m.provider===id).map(m=>({id:m.id,qualifiedId:m.qualifiedId,name:m.name,input:m.input,declaredInput:m.declaredInput??m.input,imageProbe:m.imageProbe,reasoning:m.reasoning,efforts:m.efforts,mode:m.mode,available:m.subscriptionAvailable!==false&&m.available!==false,selectorEligible:chatSelectorEligible(r,m),showInSelector:!hiddenModels.includes(m.qualifiedId),capabilitiesVerified:m.capabilitiesVerified})),
      })),...(this.cleanupWarning?{warning:this.cleanupWarning}:{}),};
  }
  private credentialsFor(config:Configuration){
    const keys=new Map<string,string>();
    for(const id of Object.keys(config.providers)){
      const key=this.registry.getPrivateCredential(id);if(key)keys.set(id,key);
    }
    return keys;
  }
  private draft(raw:unknown){
    const input=Connection.parse(raw);this.check(input.expectedRevision);
    const id=input.id??'provider_'+randomUUID().replaceAll('-','');
    if(['constructor','prototype','__proto__'].includes(id))throw new ProviderChangeError('Choose a different connection ID.');
    const existing=Object.hasOwn(this.registry.config.providers,id)?this.registry.config.providers[id]:undefined;
    if(input.id&&!existing)throw new ProviderChangeError('Connection no longer exists.',404);
    if(existing&&input.connectionRevision&&input.connectionRevision!==existing.revision)throw new ProviderChangeError('This connection was edited in another window. Cancel editing and reopen it before saving.',409);
    if(existing?.api==='claude-code')throw new ProviderChangeError('Manage Claude Code using its separate connection controls.');
    if(existing?.api==='antigravity-cli')throw new ProviderChangeError('Manage Antigravity using its separate connection controls.');
    if(existing?.api==='antigravity-http')throw new ProviderChangeError('Manage the Antigravity subscription using its separate sign-in controls.');
    if(existing?.api==='openai-codex-responses')throw new ProviderChangeError('Manage the ChatGPT subscription using its separate sign-in controls.');
    const baseUrl=input.baseUrl.replace(/\/+$/,'').replace(input.api==='anthropic-messages'?/\/v1$/:/$^/,'');
    const supplied=input.apiKey?.trim()||undefined;
    if(input.api==='anthropic-messages'&&supplied?.includes('sk-ant-oat'))throw new ProviderChangeError('Use an Anthropic API key here. Subscription sign-in belongs to the installed Claude Code connection.');
    if(supplied&&/[\r\n\0]/.test(supplied))throw new ProviderChangeError('The API key cannot contain line breaks.');
    if(supplied&&input.clearCredential)throw new ProviderChangeError('Choose either a new key or removing the saved key.');
    const previousKey=existing?this.registry.getPrivateCredential(id):undefined;
    if(existing&&existing.baseUrl!==baseUrl&&previousKey&&!supplied&&!input.clearCredential&&!input.confirmDestinationChange)
      throw new ProviderChangeError('The API URL changed. Enter the key for this URL, or explicitly confirm using the saved key at the new URL.');
    const key=input.clearCredential?undefined:supplied??previousKey;
    const config=structuredClone(this.registry.config);
    const modelOverrides=structuredClone(existing?.modelOverrides??{});
    if(existing&&(existing.baseUrl!==baseUrl||existing.api!==input.api||supplied||input.clearCredential))for(const override of Object.values(modelOverrides))override.verified=false;
    const models=input.models?.map(m=>({...m}));
    for(const model of models??[])if(model.contextWindow||model.maxTokens)modelOverrides[model.id]={...modelOverrides[model.id],...model.contextWindow?{contextWindow:model.contextWindow}:{},...model.maxTokens?{maxTokens:model.maxTokens}:{}};
    if(input.mode==='manual'&&!models?.length)throw new ProviderChangeError('Enter at least one model ID, or choose model discovery.');
    if(models&&new Set(models.map(m=>m.id)).size!==models.length)throw new ProviderChangeError('Model IDs must be unique within a connection.');
    if(input.capabilities){
      if(input.mode!=='manual')throw new ProviderChangeError('Apply shared capabilities after registering manual model IDs.');
      for(const model of models!){
        const c=input.capabilities;
        modelOverrides[model.id]={...modelOverrides[model.id],input:c.images?['text','image']:['text'],reasoning:c.reasoning,verified:false,
          reasoningEfforts:Object.fromEntries(c.efforts.map(e=>[e,e])),compat:{...modelOverrides[model.id]?.compat as any,
            supportsReasoningEffort:c.reasoning,...c.thinkingFormat!=='openai'?{thinkingFormat:c.thinkingFormat}:{}}};
      }
    }
    config.providers[id]=Provider.parse({...existing,name:input.name,baseUrl,api:input.api,revision:randomUUID(),enabled:true,
      allowInsecureHttp:input.allowInsecureHttp,requestTimeoutMs:input.requestTimeoutMs,modelOverrides,
      models:input.mode==='manual'?models:undefined,...input.clearCredential?{secretRef:undefined,keyEnv:''}:{}});
    // New keys stay in this candidate's private closure until validation succeeds.
    const overrides=this.credentialsFor(config);if(key)overrides.set(id,key);else overrides.delete(id);
    const candidate=this.withServices(new Registry(config,this.registry.profileDir,overrides));
    candidate.models=new Map(this.registry.models);candidate.statuses={...this.registry.statuses};candidate.subscription=this.registry.subscription;candidate.antigravity=this.registry.antigravity;
    return {id,input,candidate,key,existing,supplied};
  }
  async preview(raw:unknown){
    const {id,candidate}=this.draft(raw);
    await candidate.refresh(false,[id]);
    const status=candidate.statuses[id];
    if(!status?.ready)throw new ProviderChangeError(status?.error??'Model discovery failed.');
    return {models:[...candidate.models.values()].filter(m=>m.provider===id).map(m=>({id:m.id,name:m.name,input:m.input,declaredInput:m.declaredInput??m.input,imageProbe:m.imageProbe,reasoning:m.reasoning,mode:m.mode})),count:status.models};
  }
  upsert(raw:unknown){return this.serial(async()=>{
    const d=this.draft(raw);await d.candidate.refresh(false,[d.id]);
    const status=d.candidate.statuses[d.id];
    if(!status?.ready)throw new ProviderChangeError(status?.error??'Connection validation failed.');
    if(!status.models)throw new ProviderChangeError('The endpoint returned no models. Register model IDs manually if discovery is unavailable.');
    // A model may have been selected while catalog validation was in flight.
    this.ensureReferences(d.candidate);
    const p=d.candidate.config.providers[d.id];
    if(d.key&&(d.supplied||d.existing?.baseUrl!==p.baseUrl||!d.existing?.secretRef&&!d.existing?.keyEnv)){
      p.secretRef=this.registry.secrets.put(d.key,p.baseUrl);p.keyEnv='';
    }
    this.commit(d.candidate);return this.snapshot();
  })}
  remove(raw:unknown){return this.serial(async()=>{
    const input=z.object({id:z.string(),expectedRevision:z.number().int().nonnegative(),resetRoles:z.boolean().default(false)}).parse(raw);
    this.check(input.expectedRevision);const config=structuredClone(this.registry.config),p=Object.hasOwn(config.providers,input.id)?config.providers[input.id]:undefined;
    if(!p)throw new ProviderChangeError('Connection no longer exists.',404);
    if(p.api==='antigravity-cli')throw new ProviderChangeError('Disconnect Antigravity using its separate connection controls.');
    if(p.api==='claude-code')throw new ProviderChangeError('Disconnect Claude Code using its separate connection controls.');
    if(p.api==='antigravity-http')throw new ProviderChangeError('Disconnect the Antigravity subscription using its separate sign-in controls.');
    if(p.api==='openai-codex-responses')throw new ProviderChangeError('Disconnect ChatGPT using its separate sign-in controls.');
    if(input.resetRoles)for(const [role,model]of Object.entries(config.roles))if(model.startsWith(input.id+'::'))delete config.roles[role];
    delete config.providers[input.id];config.headlineModels=config.headlineModels.filter(id=>!id.startsWith(input.id+'::'));config.hiddenModels=(config.hiddenModels??[]).filter(id=>!id.startsWith(input.id+'::'));
    const candidate=this.withServices(new Registry(config,this.registry.profileDir,this.credentialsFor(config)));candidate.models=new Map([...this.registry.models].filter(([,m])=>m.provider!==input.id));
    candidate.statuses={...this.registry.statuses};delete candidate.statuses[input.id];
    this.ensureReferences(candidate);this.commit(candidate);return this.snapshot();
  })}
  settings(raw:unknown){return this.serial(async()=>{
    const input=z.object({expectedRevision:z.number().int().nonnegative(),roles:z.record(z.string(),z.string()),headlineModels:z.array(z.string()).max(100),hiddenModels:z.array(z.string().min(1).max(1024)).max(4096).optional()}).parse(raw);
    this.check(input.expectedRevision);
    if(Object.keys(input.roles).some(k=>!['small','medium','large'].includes(k)))throw new ProviderChangeError('Unknown background model role.');
    const r=this.registry;
    const roles=Object.fromEntries(Object.entries(input.roles).map(([role,id])=>{
      if(r.config.roles[role]===id)return [role,id];
      const model=r.resolve(id);if(!chatSelectorEligible(r,model))throw new ProviderChangeError('Choose an available chat model for this background role.');
      return [role,model.qualifiedId];
    }));
    const references=(ids:string[],previous:string[],requireAvailable:boolean)=>{
      const retained=new Set(previous.map(id=>r.canonicalId(id)));
      return [...new Set(ids.map(id=>{
        const canonical=r.canonicalId(id);if(retained.has(canonical))return canonical;
        const model=r.resolve(id);
        if(requireAvailable&&!chatSelectorEligible(r,model))throw new ProviderChangeError('Only available chat models can be pinned in the selector.');
        return model.qualifiedId;
      }))];
    };
    let headlineModels=references(input.headlineModels,r.config.headlineModels,true);
    const oldHidden=r.config.hiddenModels??[];
    let hiddenModels=input.hiddenModels===undefined?[...new Set(oldHidden.map(id=>r.canonicalId(id)))]:references(input.hiddenModels,oldHidden,false);
    const oldPins=new Set(r.config.headlineModels.map(id=>r.canonicalId(id))),oldHiddenIds=new Set(oldHidden.map(id=>r.canonicalId(id)));
    const newPins=new Set(headlineModels.filter(id=>!oldPins.has(id))),newHidden=new Set(hiddenModels.filter(id=>!oldHiddenIds.has(id)));
    if([...newPins].some(id=>newHidden.has(id)))throw new ProviderChangeError('Choose either pinning or hiding a model in one change.');
    hiddenModels=hiddenModels.filter(id=>!newPins.has(id));
    const hidden=new Set(hiddenModels);headlineModels=headlineModels.filter(id=>!hidden.has(id));
    const config=Configuration.parse({...r.config,roles,headlineModels,hiddenModels});
    const candidate=this.withServices(new Registry(config,this.registry.profileDir,this.credentialsFor(config)));candidate.models=new Map(this.registry.models);candidate.statuses={...this.registry.statuses};
    this.commit(candidate);return this.snapshot();
  })}
  probe(raw:unknown){return this.serial(async()=>{
    const input=z.object({id:z.string(),expectedRevision:z.number().int().nonnegative(),connectionRevision:z.string(),modelId:z.string().min(1).max(512).optional(),modelIds:z.array(z.string().min(1).max(512)).min(1).max(64).optional()}).parse(raw);
    this.check(input.expectedRevision);if(this.closing)throw new ProviderChangeError('The model probe service is stopping.',409);
    const provider=this.registry.config.providers[input.id];if(!provider)throw new ProviderChangeError('Connection no longer exists.',404);
    if(provider.revision!==input.connectionRevision)throw new ProviderChangeError('This connection changed. Refresh before probing its models.',409);
    if([...this.probeJobs.values()].filter(job=>job.public.status==='running').length>=2)throw new ProviderChangeError('Two probe batches are already running. Wait for one to finish.',429);
    const requested=input.modelId?[input.modelId]:input.modelIds??[...this.registry.models.values()].filter(model=>model.provider===input.id&&model.mode==='chat').map(model=>model.id);
    const ids=[...new Set(requested)];if(!ids.length||ids.length>64)throw new ProviderChangeError('Choose between 1 and 64 chat models to probe.');
    const models=ids.map(id=>{const model=this.registry.models.get(input.id+'::'+id);if(!model||model.mode!=='chat')throw new ProviderChangeError('The selected chat model is unavailable.',404);return model});
    if([...this.probeJobs.values()].some(job=>job.public.status==='running'&&job.public.providerId===input.id))throw new ProviderChangeError('A probe is already running for this connection.',409);
    let resolve!:()=>void;const done=new Promise<void>(accept=>resolve=accept),job:ActiveProbeJob={public:{id:randomUUID(),providerId:input.id,status:'running',total:models.length,completed:0,createdAt:Date.now()},controller:new AbortController(),done,resolve};
    const items=models.map(model=>({job,model,fingerprint:this.registry.probeFingerprint(model)}));
    this.probeJobs.set(job.public.id,job);while(this.probeJobs.size>16){const old=[...this.probeJobs.values()].find(value=>value.public.status!=='running');if(!old)break;this.probeJobs.delete(old.public.id)}
    this.probeQueue.push(...items);this.notify();this.drainProbes();return{...this.snapshot(),probeJobId:job.public.id};
  })}
  private drainProbes(){
    while(this.activeProbes<2&&this.probeQueue.length){
      const item=this.probeQueue.shift()!;this.activeProbes++;
      void this.runProbe(item).catch(error=>{this.cleanupWarning='The model probe failed. '+this.registry.safeError(error).slice(0,300)}).finally(()=>{this.activeProbes--;item.job.public.completed++;
        if(item.job.public.completed===item.job.public.total){item.job.public.status=item.job.controller.signal.aborted?'cancelled':'completed';item.job.public.finishedAt=Date.now();item.job.resolve()}
        this.notify();this.drainProbes();
      });
    }
  }
  private async runProbe(item:{job:ActiveProbeJob;model:ModelEntry;fingerprint:string}){
    const {job,model,fingerprint}=item;
    if(job.controller.signal.aborted)return;
    const signal=AbortSignal.any([job.controller.signal,AbortSignal.timeout(this.probeOptions.timeoutMs??30_000)]);
    let evidence:ImageProbeEvidence;
    try{
      const current=this.registry.models.get(model.qualifiedId);if(!current||this.registry.probeFingerprint(current)!==fingerprint)return;
      const auth=await this.registry.requestAuth(model,signal);
      evidence=await probeImage(model,auth,signal,error=>this.registry.safeError(error),this.registry);
    }catch(error){evidence={status:'inconclusive',testedAt:Date.now(),detail:signal.aborted?'The image probe timed out or was cancelled.':'The image probe could not complete. '+this.registry.safeError(error).slice(0,300),probeVersion:'image-v1'}}
    if(job.controller.signal.aborted)return;
    try{await this.serial(async()=>{if(this.registry.recordImageProbe(model.qualifiedId,fingerprint,evidence))this.notify()})}
    catch(error){this.cleanupWarning='Saving model probe evidence failed. '+this.registry.safeError(error).slice(0,300)}
  }
  async close(){this.closing=true;for(const job of this.probeJobs.values())if(job.public.status==='running')job.controller.abort();await Promise.all([...this.probeJobs.values()].map(job=>job.done))}
  private withServices(candidate:Registry){
    candidate.subscription=this.registry.subscription;candidate.antigravity=this.registry.antigravity;
    candidate.antigravityHttp=this.registry.antigravityHttp;candidate.antigravityPolicy=this.registry.antigravityPolicy;candidate.usage=this.registry.usage;candidate.claudeCode=this.registry.claudeCode;candidate.imageGeneration=this.registry.imageGeneration;
    return candidate;
  }
  private ensureReferences(candidate:Registry){
    const resolvable=(registry:Registry,id:string)=>{try{registry.resolve(id);return true}catch{return false}};
    if(resolvable(this.registry,this.registry.state.model)&&!resolvable(candidate,this.registry.state.model))
      throw new ProviderChangeError('Choose a different default model before removing the selected model.',409);
    for(const id of Object.values(candidate.config.roles))if(!resolvable(candidate,id))
      throw new ProviderChangeError('Choose a replacement for the background model role before removing this model.',409);
  }
  private commit(candidate:Registry){
    candidate.config.defaultModel=this.registry.state.model;
    const revision=this.registry.revision+1;
    atomicJson(join(this.registry.profileDir,'provider-config.json'),{schemaVersion:1,revision,configuration:candidate.config});
    this.registry.adopt(candidate,revision);this.cleanupWarning=undefined;
    try{
      atomicJson(join(this.registry.profileDir,'models.last-good.json'),[...this.registry.models.values()]);
      this.registry.secrets.prune(new Set(Object.values(this.registry.config.providers).flatMap(p=>p.secretRef?[p.secretRef]:[])));
    }catch{
      this.cleanupWarning='The connection was saved. Updating the offline cache or removing unused encrypted keys failed. Check the private profile directory permissions.';
    }
    this.notify();
  }
}
