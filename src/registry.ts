import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes, createHmac } from "node:crypto";
import type {ImageProbeEvidence,ImageProbeRecord} from "./model-probe";
import yaml from "js-yaml";
import { z } from "zod";
import type { Model } from "@earendil-works/pi-ai";
import type {SubscriptionManager} from './subscription';
import {ProviderSecrets} from './provider-secrets';
import {defaultEffort,modelEfforts,effortNames} from './model-effort';
import type {ImageGenerationManager} from './image-generation-manager';
import {ANTIGRAVITY_PROVIDER_ID,ANTIGRAVITY_BASE_URL,type AntigravityModels} from './antigravity-models';
import {ANTIGRAVITY_HTTP_PROVIDER_ID,ANTIGRAVITY_HTTP_BASE_URL,type AntigravityHttpModels} from './antigravity-http-models';
import {bannedHost} from './vendor-hosts';
import {anthropicProviderFetch} from './provider-transport';
import {CLAUDE_CODE_PROVIDER_ID,CLAUDE_CODE_BASE_URL,type ClaudeCodeModels} from './claude-code';
import type {UsageManager} from './usage-manager';
import {declaredPricing,type TokenPricing} from './model-pricing';
import {anthropicApiModelMetadata} from './anthropic-compat';
import type {AntigravityConnectionPolicy} from './antigravity-connection-policy';
export {bannedHost} from './vendor-hosts';
const pinnedCredentials=new WeakMap<object,{key?:string;required:boolean;label:string}>();

export const Provider = z.object({
  name: z.string().min(1), baseUrl: z.string().url(), keyEnv: z.string().default(''),
  secretRef:z.string().optional(),revision:z.string().default('initial'),enabled:z.boolean().default(true),allowInsecureHttp:z.boolean().default(false),
  api: z.enum(["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "claude-code", "antigravity-cli", "antigravity-http"]).default("openai-completions"),
  requestTimeoutMs: z.number().int().min(1000).max(3_600_000).default(600_000),
  models: z.array(z.object({ id: z.string(), name: z.string().optional() }).passthrough()).optional(),
  modelOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
});
export const Configuration = z.object({
  envFile: z.string().optional(),
  credentialRefsFile: z.string().optional(),
  modelMetadataFile: z.string().optional(),
  providers: z.record(z.string(), Provider),
  defaultModel: z.string(), roles: z.record(z.string(), z.string()).default({}),
  headlineModels: z.array(z.string()).default([]),
  hiddenModels: z.array(z.string()).default([]),
  searchUrl: z.string().url().optional(),
  voice: z.object({
    python:z.string().default(''),runtimeRoot:z.string().default(''),model:z.string().default('base'),
  }).prefault({}),
});
export type Configuration = z.infer<typeof Configuration>;
export type ModelEntry = Model<any> & { qualifiedId: string; providerName: string; capabilitiesVerified: boolean; declaredInput?: Array<'text'|'image'>; imageProbe?:ImageProbeEvidence; /** Image-output capability advertised by the provider catalog or inferred from a dedicated image-model name. */ imageGenerationCandidate?:boolean; imageGenerationAdvertised?:boolean; mode: string; providerMaxOutputTokens?: number;pricing?:TokenPricing|null;claudeCodeExecutable?:string;claudeCodeGeneration?:number; efforts?: string[];defaultReasoningEffort?:string;subscriptionAvailable?:boolean;available?:boolean;unavailableReason?:string;antigravitySlugs?:Record<string,string>;antigravityExecutable?:string;antigravityGeneration?:number;antigravityProject?:string;requestTimeoutMs:number;replayKey:string };
export function withModelReplayKey(model:ModelEntry,replayKey:string):ModelEntry{
  const updated={...model,replayKey},binding=pinnedCredentials.get(model);
  // Replay partitions must preserve the exact model/credential snapshot.
  // Object spread alone loses the WeakMap binding; looking up a current
  // provider by ID can send a replacement credential to the old URL.
  if(binding)pinnedCredentials.set(updated,binding);
  return updated;
}
function imageGenerationMetadata(raw:any,override:any){
 const output=[raw?.output_modalities,raw?.output,raw?.modalities?.output,raw?.capabilities?.output,override?.output_modalities,override?.output,override?.capabilities?.output].flatMap(value=>Array.isArray(value)?value:[value]).filter(value=>typeof value==='string').map(value=>value.toLowerCase());
 const advertised=raw?.image_generation===true||raw?.imageGeneration===true||raw?.capabilities?.image_generation===true||raw?.capabilities?.imageGeneration===true||raw?.capabilities?.image_output===true||raw?.capabilities?.imageOutput===true||output.some(value=>['image','image_generation','image-generation','image_output','image-output'].includes(value));
 // Some OpenAI-compatible catalogs publish only opaque IDs. This identifies
 // dedicated image models without naming any individual provider. It is a
 // candidate, not a background billing probe or a claim of verification.
 const named=/\b(?:image[-_ ]?gen(?:erator|ator)?|diffusion(?:gemma)?|flux|imagen|stable[-_ ]?diffusion)\b/i.test([raw?.id,raw?.name,raw?.display_name,override?.name].filter(value=>typeof value==='string').join(' '));
 return {candidate:advertised||named,advertised};
}

export const defaultConfiguration: Configuration = Configuration.parse({
  providers: {
    'openai-codex': {name:'ChatGPT',baseUrl:'https://chatgpt.com/backend-api',api:'openai-codex-responses',models:[{id:'gpt-6.1-sol',name:'GPT 6.1 Sol'}],modelOverrides:{'gpt-6.1-sol':{contextWindow:922_000,maxTokens:128_000,input:['text','image'],verified:true,reasoning:true,reasoningEfforts:{low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'},compat:{supportsStrictMode:false}}}},
  },
  defaultModel: 'openai-codex::gpt-6.1-sol',headlineModels:['openai-codex::gpt-6.1-sol'],roles:{},
});

export function atomicJson(path: string, data: unknown) {
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

export function readCredentialReferences(config: Configuration): Map<string, string> {
  const values = new Map<string, string>();
  const fileKeys = new Set<string>();
  if (config.credentialRefsFile && existsSync(config.credentialRefsFile)) {
    const doc = yaml.load(readFileSync(config.credentialRefsFile, "utf8")) as any;
    for (const provider of Object.values(config.providers)) {
      const value = doc?.refs?.[provider.keyEnv];
      if (typeof value === "string") values.set(provider.keyEnv, value);
    }
  }
  if (config.envFile && existsSync(config.envFile)) for (let line of readFileSync(config.envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "").trim();
    values.set(match[1], value);
    fileKeys.add(match[1]);
  }
  for (const provider of Object.values(config.providers)) {
    if (provider.keyEnv && !fileKeys.has(provider.keyEnv)
      && values.get('UPSTREAM_BASE_URL')?.replace(/\/$/,'') === provider.baseUrl.replace(/\/$/,'')
      && values.get('UPSTREAM_API_KEY')) values.set(provider.keyEnv,values.get('UPSTREAM_API_KEY')!);
    if (process.env[provider.keyEnv]) values.set(provider.keyEnv, process.env[provider.keyEnv]!);
  }
  return values;
}

export class Registry {
  imageGeneration?:ImageGenerationManager;
  antigravity?:AntigravityModels;
  antigravityHttp?:AntigravityHttpModels;
  antigravityPolicy?:AntigravityConnectionPolicy;
  claudeCode?:ClaudeCodeModels;
  usage?:UsageManager;
  subscription?:SubscriptionManager;
  config: Configuration;
  models = new Map<string, ModelEntry>();
  private keys: Map<string, string>;
  private redactionSecrets=new Set<string>();
  private metadata = new Map<string,any>();
  statuses: Record<string, { ready: boolean; models: number; error?: string }> = {};
  readonly profileDir: string;
  readonly secrets:ProviderSecrets;
  private imageProbes=new Map<string,ImageProbeRecord>();
  revision=0;
  catalogGeneration=randomUUID();
  state: { model: string; effort?: string };
  constructor(config: unknown, profileDir: string,private readonly credentialOverrides=new Map<string,string>()) {
    this.config = Configuration.parse(config);
    this.profileDir = resolve(profileDir); mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    this.keys = readCredentialReferences(this.config);
    for(const [id,key]of credentialOverrides){const p=this.config.providers[id];if(p?.keyEnv)this.keys.set(p.keyEnv,key)}
    this.secrets=new ProviderSecrets(join(this.profileDir,'local-auth'));
    if (this.config.modelMetadataFile && existsSync(this.config.modelMetadataFile)) {
      const visit = (node:any) => {
        if (!node || typeof node !== 'object') return;
        for (const [id,p] of Object.entries(this.config.providers)) {
          const source = node.providers?.[id];
          if (source?.baseURL?.replace(/\/$/,'') === p.baseUrl.replace(/\/$/,'') && Array.isArray(source.models)) {
            for (const m of source.models) if (typeof m.id === 'string') this.metadata.set(id+'::'+m.id, {name:m.name,contextWindow:m.contextWindow,maxTokens:m.maxTokens,input:m.input,reasoningEfforts:m.reasoningEfforts,compat:{...source.compat,...m.compat}});
          }
        }
        for (const value of Object.values(node)) visit(value);
      };
      visit(yaml.load(readFileSync(this.config.modelMetadataFile,'utf8')));
    }
    const stateFile = join(this.profileDir, "model-selection.json");
    this.state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { model: this.config.defaultModel };
    for (const [providerId,provider] of Object.entries(this.config.providers)) {
      if(provider.api==='claude-code'&&(providerId!==CLAUDE_CODE_PROVIDER_ID||provider.baseUrl!==CLAUDE_CODE_BASE_URL||provider.keyEnv||provider.secretRef))throw new Error('Claude subscriptions use the managed official Claude Code connection.');
      if(provider.api==='antigravity-cli'&&(providerId!==ANTIGRAVITY_PROVIDER_ID||provider.baseUrl!==ANTIGRAVITY_BASE_URL||provider.keyEnv||provider.secretRef))throw new Error('Antigravity uses its managed official CLI connection.');
      if(provider.api==='antigravity-http'&&(providerId!==ANTIGRAVITY_HTTP_PROVIDER_ID||provider.baseUrl!==ANTIGRAVITY_HTTP_BASE_URL||provider.keyEnv||provider.secretRef))throw new Error('Antigravity subscriptions use the managed Google sign-in connection.');
      const u = new URL(provider.baseUrl);
      if (u.username || u.password || u.search || u.hash || (bannedHost(u.hostname)&&!(provider.api==='anthropic-messages'&&u.hostname==='api.anthropic.com'&&u.protocol==='https:'))) throw new Error("provider URL contains unsupported credentials, parameters, or a vendor product destination");
      if (u.protocol !== "https:" && !(u.protocol === "http:" && (["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)||provider.allowInsecureHttp))) throw new Error("remote providers require HTTPS or an explicitly enabled HTTP connection");
      // Loopback is needed by injected driver fixtures. SubscriptionManager also
      // checks the exact destination before attaching renewable credentials.
      if(provider.api==='openai-codex-responses'&&u.href.replace(/\/$/,'')!=='https://chatgpt.com/backend-api'&&!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('The ChatGPT subscription connection uses its fixed OpenAI destination.');
    }
    const probeFile=join(this.profileDir,'model-probes.json');
    if(existsSync(probeFile)){
      try{const bytes=readFileSync(probeFile);if(bytes.length<=1024*1024){const record=JSON.parse(bytes.toString('utf8'));if(record.schemaVersion===1&&Array.isArray(record.entries)&&record.entries.length<=4096)for(const [id,value]of record.entries)if(typeof id==='string'&&typeof value?.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(value.fingerprint)&&['supported','rejected','inconclusive'].includes(value.evidence?.status)&&value.evidence.probeVersion==='image-v1'&&typeof value.evidence.detail==='string'&&value.evidence.detail.length<=1000&&Number.isFinite(value.evidence.testedAt)&&(!value.lastSupported||(value.lastSupported.status==='supported'&&value.lastSupported.probeVersion==='image-v1'&&Number.isFinite(value.lastSupported.testedAt))))this.imageProbes.set(id,value)}}catch{/* Invalid optional probe evidence never grants image capability. */}
    }
    const cached = join(this.profileDir, 'models.last-good.json');
    if (existsSync(cached)) {
      const entries = JSON.parse(readFileSync(cached, 'utf8'));
      for (const m of entries) {
        const p = this.config.providers[m.provider];
        if (p?.enabled && p.baseUrl === m.baseUrl && p.api === m.api){
          const model={...m,requestTimeoutMs:p.requestTimeoutMs,replayKey:m.qualifiedId+'@'+p.revision};
          this.models.set(m.qualifiedId,model);this.pin(model);
        }
      }
    }
  }
  static fromFile(path: string | undefined, profileDir: string) {
    const managed=join(profileDir,'provider-config.json');
    const record=existsSync(managed)?JSON.parse(readFileSync(managed,'utf8')):undefined;
    const registry=new Registry(record?.configuration??(path?JSON.parse(readFileSync(path,'utf8')):defaultConfiguration),profileDir);
    registry.revision=record?.revision??0;
    if(!record)atomicJson(managed,{schemaVersion:1,revision:0,configuration:registry.config});
    return registry;
  }
  private pin(model:ModelEntry){
    const p=this.config.providers[model.provider];
    const key=this.credentialOverrides.get(model.provider)??(p.secretRef?this.secrets.get(p.secretRef,p.baseUrl):this.keys.get(p.keyEnv));
    if(key)this.redactionSecrets.add(key);
    pinnedCredentials.set(model,{key,required:!!(p.secretRef||p.keyEnv),label:p.keyEnv||p.name});
  }
  getPrivateCredential(providerId:string){
    const model=[...this.models.values()].find(m=>m.provider===providerId);
    if(model)return pinnedCredentials.get(model)?.key;
    const p=this.config.providers[providerId];
    return p?(p.secretRef?this.secrets.get(p.secretRef,p.baseUrl):this.keys.get(p.keyEnv)):undefined;
  }
  adopt(candidate:Registry,revision:number){
    this.config=candidate.config;this.models=candidate.models;this.statuses=candidate.statuses;
    this.keys=candidate.keys;this.metadata=candidate.metadata;this.imageProbes=candidate.imageProbes;this.revision=revision;this.catalogGeneration=randomUUID();
    for(const key of candidate.redactionSecrets)this.redactionSecrets.add(key);
  }
  async refresh(persist=true,providerIds?:string[]) {
    const models=new Map(this.models);const statuses={...this.statuses};
    await Promise.all(Object.entries(this.config.providers).filter(([id])=>!providerIds||providerIds.includes(id)).map(async ([providerId, p]) => {
      if(!p.enabled){for(const [id,m]of models)if(m.provider===providerId)models.delete(id);statuses[providerId]={ready:false,models:0};return}
      try {
        const headers: Record<string, string> = {};
        const key = this.credentialOverrides.get(providerId)??(p.secretRef?this.secrets.get(p.secretRef,p.baseUrl):this.keys.get(p.keyEnv)); if (key) headers.authorization = "Bearer " + key;
        if(p.api==='anthropic-messages'&&key?.includes('sk-ant-oat'))throw new Error('The Anthropic API connection requires an API key; use Claude Code for subscription access.');
        let data: any[];
        const agyCatalog=p.api==='antigravity-cli'?this.antigravity?.catalog():undefined;
        const agyReady=p.api==='antigravity-cli'?(this.antigravityPolicy?this.antigravityPolicy.available('cli'):this.antigravity?.available()===true):true;
        const agyHttpCatalog=p.api==='antigravity-http'?this.antigravityHttp?.catalog():undefined;
        const agyHttpReady=p.api==='antigravity-http'?(this.antigravityPolicy?this.antigravityPolicy.available('direct'):this.antigravityHttp?.available()===true):true;
        const subscriptionCatalog=p.api==='openai-codex-responses'?this.subscription?.modelCatalog.current():undefined;
        const claudeCatalog=p.api==='claude-code'?this.claudeCode?.catalog():undefined;
        const claudeReady=p.api==='claude-code'?this.claudeCode?.available()===true:true;
        if(p.api==='antigravity-cli')data=agyCatalog??[];
        else if(p.api==='antigravity-http')data=agyHttpCatalog??[];
        else if(p.api==='claude-code')data=claudeCatalog??[];
        else if(p.api==='openai-codex-responses'&&this.subscription)data=subscriptionCatalog?.models??p.models??[];
        else if (p.models) data = p.models;
        else {
          if(p.api==='anthropic-messages'){
            delete headers.authorization;if(key)headers['x-api-key']=key;headers['anthropic-version']='2023-06-01';
          }
          const sender=p.api==='anthropic-messages'?anthropicProviderFetch(p.baseUrl):fetch;
          const r = await sender(p.baseUrl.replace(/\/$/, "") + (p.api==='anthropic-messages'?'/v1/models':'/models'), { headers, redirect:'error',signal: AbortSignal.timeout(20_000) });
          if (!r.ok) throw new Error("model catalog returned HTTP " + r.status);
          // Bound discovery even if the endpoint omits Content-Length or streams.
          if(Number(r.headers.get('content-length'))>8*1024*1024){await r.body?.cancel();throw new Error('Model catalog exceeds the 8 MB limit. Register model IDs manually.')}
          const reader=r.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
          if(!reader)throw new Error('Model catalog has no response body.');
          try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw new Error('Model catalog exceeds the 8 MB limit. Register model IDs manually.')}chunks.push(value)}}finally{reader.releaseLock()}
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as any;
          if (!Array.isArray(body.data)) throw new Error("model catalog must contain a data array");
          if(body.data.length>4096)throw new Error('Model catalog exceeds 4096 entries. Register model IDs manually.');
          data = body.data;
        }
        const discovered=new Map<string,ModelEntry>();
        for (const raw of data) {
          if (typeof raw?.id !== "string" || !raw.id || raw.id.length>512) continue;
          const qualifiedId = providerId + "::" + raw.id;
          const configured = this.metadata.get(qualifiedId) ?? {};
          const known=p.api==='anthropic-messages'?anthropicApiModelMetadata(raw.id):undefined;
          const override = {...known,...configured,...p.modelOverrides[raw.id],...(subscriptionCatalog||agyCatalog||agyHttpCatalog||claudeCatalog?raw:{}),compat:{...known?.compat,...configured.compat,...p.modelOverrides[raw.id]?.compat as any,...(subscriptionCatalog?{supportsStrictMode:false}:{})}};
          const effortMap = override.reasoningEfforts ?? {};
          const efforts = Object.keys(effortMap).filter(e=>effortNames.includes(e) && effortMap[e]!=null);
          const advertised=override.input??raw.input_modalities??raw.input;
          const modalities=Array.isArray(advertised)?advertised.filter((x:any)=>x==='text'||x==='image'):['text'];
          if(!modalities.length)modalities.push('text');
          const imageOutput=imageGenerationMetadata(raw,override);
          const limit=(value:unknown,fallback:number)=>Number.isFinite(Number(value))&&Number(value)>0?Math.floor(Number(value)):fallback;
          const entry: ModelEntry = {
            id: raw.id, qualifiedId, provider: providerId, providerName: p.name,
            requestTimeoutMs:p.requestTimeoutMs,replayKey:qualifiedId+'@'+p.revision,
            name: String(override.name ?? raw.display_name ?? raw.name ?? raw.id), api: p.api,
            baseUrl: p.baseUrl, input: modalities, declaredInput:[...modalities],
            reasoning: override.reasoning === true || raw.reasoning === true || efforts.length>0,
            defaultReasoningEffort:override.defaultReasoningEffort,thinkingLevelMap:override.thinkingLevelMap,
            efforts: efforts.length ? efforts : (p.api==='antigravity-cli'||p.api==='antigravity-http')?[]:['low','medium','high','max'],
            contextWindow: limit(override.contextWindow ?? raw.max_input_tokens ?? raw.context_length,128_000),
            maxTokens: limit(override.maxTokens ?? raw.max_output_tokens,16_384),
            providerMaxOutputTokens: raw.max_output_tokens,
            mode: String(raw.mode ?? 'chat'),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            pricing:declaredPricing({...raw,...override}),
            capabilitiesVerified: override.verified === true,
            ...(imageOutput.candidate?{imageGenerationCandidate:true,imageGenerationAdvertised:imageOutput.advertised}:{}),
            ...(subscriptionCatalog?{subscriptionAvailable:true,capabilitiesVerified:false,defaultReasoningEffort:raw.defaultReasoningEffort}:{}),
            ...(p.api==='claude-code'?{available:claudeReady,unavailableReason:claudeReady?undefined:'Connect the official Claude Code client in Settings → Connections.',claudeCodeExecutable:this.claudeCode?.executablePath(),claudeCodeGeneration:this.claudeCode?.connectionGeneration()}:{}),
            ...(p.api==='antigravity-cli'?{available:agyReady,unavailableReason:agyReady?undefined:'Connect Antigravity and refresh its models in Settings → Connections.',antigravitySlugs:raw.antigravitySlugs,antigravityExecutable:this.antigravity?.executablePath(),antigravityGeneration:this.antigravity?.connectionGeneration(),defaultReasoningEffort:efforts.includes('medium')?'medium':efforts[0]}:{}),
            ...(p.api==='antigravity-http'?{available:agyHttpReady,unavailableReason:agyHttpReady?undefined:'Connect Antigravity (Google sign-in) and refresh its models in Settings → Connections.',antigravityProject:this.antigravityHttp?.project(),antigravitySlugs:raw.antigravitySlugs,defaultReasoningEffort:raw.defaultReasoningEffort}:{}),
            compat: override.compat as any,
          };
          this.pin(entry);discovered.set(qualifiedId,entry);
        }
        if(p.api==='openai-codex-responses'||p.api==='antigravity-cli'||p.api==='antigravity-http'||p.api==='claude-code'){
          const referenced=new Set([this.state.model,...Object.values(this.config.roles),...this.config.headlineModels]);
          for(const [id,model]of models)if(model.provider===providerId&&!discovered.has(id)&&referenced.has(id)){
            const alias=p.api==='antigravity-http'?this.antigravityHttp?.resolveAlias?.(model.id):undefined;
            if(alias&&discovered.has(providerId+'::'+alias.id))continue;
            discovered.set(id,p.api!=='openai-codex-responses'?{...model,available:false,unavailableReason:'This model is unavailable in the current connection. Check the connection and refresh models.'}:{...model,subscriptionAvailable:false});
          }
        }
        for(const [id,m]of models)if(m.provider===providerId)models.delete(id);
        for(const [id,m]of discovered)models.set(id,m);
        { const ready=agyReady&&agyHttpReady&&claudeReady;
        statuses[providerId] = { ready, models: discovered.size,...!ready?{error:p.api==='antigravity-http'?'Connect Antigravity (Google sign-in) and refresh its models in Settings → Connections.':'Connect Antigravity and refresh its models in Settings → Connections.'}:{} };
        }
      } catch (error) {
        statuses[providerId] = { ready: false, models: [...models.values()].filter(m=>m.provider===providerId).length, error: this.safeError(error) };
      }
    }));
    this.models=models;this.statuses=statuses;this.applyImageProbes();
    if(persist)atomicJson(join(this.profileDir, 'models.last-good.json'), [...this.models.values()]);
  }
  probeFingerprint(model:ModelEntry){
    const provider=this.config.providers[model.provider];if(!provider)throw Error('The model connection is unavailable.');
    const file=join(this.profileDir,'local-auth','model-probe.key');
    if(!existsSync(file))try{writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600})}catch(error:any){if(error?.code!=='EEXIST')throw error}
    const key=readFileSync(file);if(key.length!==32)throw Error('The model probe key is invalid.');
    const binding=pinnedCredentials.get(model);
    const credential=provider.api==='openai-codex-responses'?{kind:'subscription',session:this.subscription?.vault.read()?.session??null}:provider.api==='antigravity-http'?{kind:'google-subscription',session:this.antigravityHttp?.auth?.vault?.read()?.session??null}:provider.api==='antigravity-cli'?{kind:'google-cli',generation:this.antigravity?.connectionGeneration(),available:this.antigravity?.available()}:provider.api==='claude-code'?{kind:'claude-code',generation:this.claudeCode?.connectionGeneration(),available:this.claudeCode?.available()}:{kind:'api',required:binding?.required??false,key:binding?.key??null};
    const stable=(value:any):any=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(name=>[name,stable(value[name])])):value;
    return createHmac('sha256',key).update(JSON.stringify(stable({provider:model.provider,revision:provider.revision,url:provider.baseUrl,api:provider.api,id:model.id,credential,input:model.declaredInput??model.input,mode:model.mode,reasoning:model.reasoning,compat:model.compat,contextWindow:model.contextWindow,maxTokens:model.maxTokens}))).digest('hex');
  }
  revalidateImageProbes(){this.applyImageProbes()}
  private applyImageProbes(){
    const next=new Map<string,ModelEntry>();
    for(const [id,model]of this.models){
      const declared=[...(model.declaredInput??model.input)] as Array<'text'|'image'>,record=this.imageProbes.get(id);
      let evidence:ImageProbeEvidence|undefined,supported=false;
      if(record){try{if(record.fingerprint===this.probeFingerprint(model)){evidence=record.evidence;supported=record.evidence.status==='supported'||!!record.lastSupported}}catch{/* Unreadable identity cannot validate optional evidence. */}}
      const updated={...model,declaredInput:declared,input:supported&&!declared.includes('image')?[...declared,'image']:declared,imageProbe:evidence} as ModelEntry;
      const binding=pinnedCredentials.get(model);if(binding)pinnedCredentials.set(updated,binding);next.set(id,updated);
    }
    this.models=next;
  }
  recordImageProbe(modelId:string,fingerprint:string,evidence:ImageProbeEvidence){
    const model=this.models.get(modelId);if(!model||this.probeFingerprint(model)!==fingerprint)return false;
    const previous=this.imageProbes.get(modelId),same=previous?.fingerprint===fingerprint;
    const lastSupported=evidence.status==='supported'?evidence:evidence.status==='inconclusive'&&same?(previous.evidence.status==='supported'?previous.evidence:previous.lastSupported):undefined;
    const entries=new Map(this.imageProbes);entries.set(modelId,{fingerprint,evidence,...lastSupported?{lastSupported}:{}});
    atomicJson(join(this.profileDir,'model-probes.json'),{schemaVersion:1,entries:[...entries].slice(-4096)});this.imageProbes=entries;this.applyImageProbes();return true;
  }
  safeError(error: unknown) {
    let value = error instanceof Error ? error.message : String(error);
    for (const key of this.keys.values()) if (key) value = value.split(key).join("[redacted]");
    for(const key of this.credentialOverrides.values())if(key)value=value.split(key).join('[redacted]');
    for(const key of this.redactionSecrets)if(key)value=value.split(key).join('[redacted]');
    const redacted=this.subscription?.redact(value)??value;
    return this.antigravityHttp?.auth?.redact?.(redacted)??redacted;
  }
  resolve(id: string): ModelEntry {
    let resolved = id.replace(/^anthropic\//,'');
    // Fully qualified provider IDs are exact routes. In particular,
    // claude-code::opus must not be treated as a legacy Claude role alias.
    if (!resolved.includes('::') && resolved.startsWith("claude-")) {
      const role = /haiku/.test(resolved) ? "small" : /opus|fable/.test(resolved) ? "large" : "medium";
      resolved = this.config.roles[role] ?? this.state.model;
    }
    const httpPrefix=ANTIGRAVITY_HTTP_PROVIDER_ID+'::';
    const alias=resolved.startsWith(httpPrefix)?this.antigravityHttp?.resolveAlias?.(resolved.slice(httpPrefix.length)):undefined;
    let model = this.models.get(alias?httpPrefix+alias.id:resolved);
    if(model&&alias?.effort){
      const source=model;
      model={...source,defaultReasoningEffort:alias.effort};
      const binding=pinnedCredentials.get(source);if(binding)pinnedCredentials.set(model,binding);
    }
    if (!model) {
      const matches = [...this.models.values()].filter(m => m.id === resolved);
      if (matches.length === 1) model = matches[0];
    }
    if (!model) throw new Error("unknown or unavailable model: " + id);
    if (model.mode !== 'chat') throw new Error('Model ' + id + ' serves ' + model.mode + ', which cannot drive the analysis agent');
    return model;
  }
  canonicalId(id:string){try{return this.resolve(id).qualifiedId}catch{return id}}
  currentSelection(){
    try{
      const model=this.resolve(this.state.model),choices=modelEfforts(model);
      const effort=choices.includes(this.state.effort??'')?this.state.effort:defaultEffort(model);
      return {model:model.qualifiedId,...(effort?{effort}:{})};
    }catch{return {...this.state}}
  }
  apiKey(model: ModelEntry) {
    if(model.api==='claude-code')throw new Error('Claude Code handles its own official client authentication.');
    if(model.api==='antigravity-cli')throw new Error('Antigravity uses official CLI authentication.');
    if(model.api==='antigravity-http')throw new Error('Antigravity subscription requests require Google sign-in.');
    if(model.api==='openai-codex-responses')throw new Error('Subscription requests require renewable ChatGPT authentication.');
    const binding=pinnedCredentials.get(model);
    const provider=this.config.providers[model.provider];
    if (binding?.key) return binding.key;
    // Missing snapshots may fail closed, but must never acquire credentials
    // from a newer connection revision. Cached models are pinned on load.
    const required=binding?.required??!!(provider?.secretRef||provider?.keyEnv);
    if(required)throw new Error('Missing provider credential: '+(binding?.label||provider?.keyEnv||provider?.name||model.provider));
    // Keyless compatible servers are supported; credentials are never inferred from another connection.
    return 'local-no-key-required';
  }
  async requestAuth(model:ModelEntry,signal?:AbortSignal){
    if(model.api==='claude-code'){
      if(model.available===false||!this.claudeCode?.available())throw new Error('Connect the official Claude Code client in Settings → Connections.');
      signal?.throwIfAborted();return {apiKey:undefined,sessionScope:undefined};
    }
    if(model.api==='antigravity-cli'){
      await this.antigravityPolicy?.ensureAvailable('cli');
      if(model.available===false||!this.antigravity?.available())throw new Error(model.unavailableReason??'Connect Antigravity in Settings → Connections.');
      signal?.throwIfAborted();return {apiKey:undefined,sessionScope:undefined,signal:this.antigravityPolicy?.signal()};
    }
    if(model.api==='antigravity-http'){
      await this.antigravityPolicy?.ensureAvailable('direct');
      if(model.available===false||!this.antigravityHttp?.available())throw new Error(model.unavailableReason??'Connect Antigravity (Google sign-in) in Settings → Connections.');
      if(!this.antigravityHttp)throw new Error('Connect Antigravity (Google sign-in) in Settings → Connections.');
      const auth=await this.antigravityHttp.auth.requestAuth(signal);
      // The auth wrapper's fetch is deliberately not forwarded: the provider
      // attaches the token itself and each transport (Go bridge or fetch) pins
      // the destination hosts, so the default transport can be the bridge.
      return {apiKey:auth.apiKey,sessionScope:auth.sessionScope,project:model.antigravityProject??this.antigravityHttp.project()};
    }
    if(model.api==='openai-codex-responses'){
      if(model.subscriptionAvailable===false)throw new Error('This model is unavailable in the current ChatGPT model catalog. Refresh models or select another model.');
      if(!this.subscription)throw new Error('Connect ChatGPT in Settings → Connections.');
      return this.subscription.requestAuth(signal);
    }
    return {apiKey:this.apiKey(model),sessionScope:undefined};
  }
  select(model: string, effort?: string) {
    const entry=this.resolve(model),choices=modelEfforts(entry);
    if(entry.available===false)throw new Error(entry.unavailableReason??'This model connection is unavailable.');
    if(entry.subscriptionAvailable===false)throw new Error('This model is unavailable in the current ChatGPT model catalog. Refresh models or select another model.');
    if(effort!==undefined&&choices.length&&!choices.includes(effort))throw new Error('Unsupported reasoning effort for '+entry.name);
    const selected=choices.includes(effort??'')?effort:defaultEffort(entry);
    this.state = { model:entry.qualifiedId, ...(selected ? { effort:selected } : {}) };
    atomicJson(join(this.profileDir, "model-selection.json"), this.state);
    return this.snapshot();
  }
  snapshot() {
    const selection=this.currentSelection();
    return {
      defaultModel: selection.model, effort: selection.effort,
      roles: { ...this.config.roles }, statuses: this.statuses,
      models: [...this.models.values()].map(({ cost, ...m }) => m),
    };
  }
}
