import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {z} from 'zod';
import {Antigravity,AntigravityError} from './antigravity';
import {atomicJson} from './registry';
import {createAntigravityProvider,discoverAntigravityModels,type AntigravityModelProvider,type AntigravityCatalogModel} from './antigravity-provider';
export const ANTIGRAVITY_PROVIDER_ID='antigravity';
// Identity marker only. Inference always travels through the official CLI.
export const ANTIGRAVITY_BASE_URL='https://antigravity.local.invalid';
export type AntigravityModel={id:string;name:string;reasoningEfforts:Record<string,string>;antigravitySlugs:Record<string,string>;input:['text'];verified:false};
export function groupAntigravityModels(raw:AntigravityCatalogModel[]):AntigravityModel[]{
 const models=new Map<string,AntigravityModel>();
 for(const item of raw){
  const match=item.id.match(/^(.*)-(low|medium|high|xhigh|max)$/),id=match?.[1]??item.id,effort=match?.[2]??'default';
  const model=models.get(id)??{id,name:item.name.replace(/\s*\((?:Low|Medium|High|Extra High|Max)\)$/i,''),reasoningEfforts:{},antigravitySlugs:{},input:['text'],verified:false};
  model.antigravitySlugs[effort]=item.id;if(match)model.reasoningEfforts[effort]=effort;models.set(id,model);
 }return [...models.values()];
}
/** Official sign-in and catalog for Chimeric's existing research model picker. */
export class AntigravityModels{
 readonly auth:Antigravity;
 private enabled=false;
 private allowSharedCustomizations=false;
 private raw:AntigravityCatalogModel[]=[];
 private executable='';
 private fetchedAt?:number;
 private discovery:{state:string;message?:string}={state:'idle'};
 private generation=0;
 private refreshing?:Promise<any>;
 private discoveryController?:AbortController;
 private discoveries=new Set<Promise<any>>();
 private drivers=new Map<string,AntigravityModelProvider>();
 private listeners=new Set<()=>void>();
 private unsubscribe:()=>void;
 private closed=false;
 private file:string;
 constructor(profile:string,private options:{auth?:Antigravity;discover?:typeof discoverAntigravityModels;driver?:typeof createAntigravityProvider}={}){
  this.auth=options.auth??new Antigravity(profile);this.file=join(this.auth.root,'model-catalog.json');
  if(existsSync(this.file))try{
   const bytes=readFileSync(this.file);if(bytes.length>1024*1024)throw Error('Oversized catalog');
   const saved=z.object({allowSharedCustomizations:z.boolean().default(false),enabled:z.boolean(),executable:z.string(),fetchedAt:z.number().optional(),models:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/),name:z.string().min(1).max(256)})).max(4096)}).parse(JSON.parse(bytes.toString('utf8')));
   this.allowSharedCustomizations=saved.allowSharedCustomizations;this.enabled=saved.enabled;this.executable=saved.executable;this.raw=saved.models;this.fetchedAt=saved.fetchedAt;if(this.raw.length)this.discovery={state:'cached'};
  }catch{this.discovery={state:'error',message:'The saved Antigravity catalog could not be read. Refresh models.'}}
  let previous=this.auth.status().authState;
  this.unsubscribe=this.auth.subscribe(()=>{const state=this.auth.status().authState;if(state==='ready'&&previous==='waiting'){++this.generation;this.discoveryController?.abort();this.refreshing=undefined;void this.refresh().catch(()=>undefined)}previous=state;this.changed()});
 }
 onChange(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
 private changed(){for(const listener of this.listeners)listener()}
 private persist(){atomicJson(this.file,{allowSharedCustomizations:this.allowSharedCustomizations,enabled:this.enabled,executable:this.executable,fetchedAt:this.fetchedAt,models:this.raw})}
 catalog(){return groupAntigravityModels(this.raw)}
 available(){return !this.closed&&this.enabled&&this.auth.status().connected&&this.discovery.state==='ready'}
 status(){const {sessions,activeSessionId,imageInput,...status}=this.auth.status();return {...status,allowSharedCustomizations:this.allowSharedCustomizations,connected:this.enabled&&status.connected,modelDiscovery:{...this.discovery,count:this.catalog().length,fetchedAt:this.fetchedAt},models:this.catalog().map(({id,name})=>({id,name}))}}
 async restore(){if(this.enabled)try{await this.connect()}catch{/* The connection status retains its error. */}}
 async configure(raw:unknown){++this.generation;this.discoveryController?.abort();this.refreshing=undefined;await this.auth.configure(raw);this.enabled=false;this.raw=[];this.fetchedAt=undefined;this.discovery={state:'idle'};this.executable=this.auth.status().executable;this.persist();this.changed();return this.status()}
 async setSharedCustomizations(raw:unknown){const {allowSharedCustomizations}=z.object({allowSharedCustomizations:z.boolean()}).parse(raw);if(allowSharedCustomizations===this.allowSharedCustomizations)return this.status();this.allowSharedCustomizations=allowSharedCustomizations;++this.generation;this.discoveryController?.abort();this.refreshing=undefined;this.discovery={state:this.raw.length?'cached':'idle'};this.persist();this.changed();if(!allowSharedCustomizations){const drivers=[...this.drivers.values()];this.drivers.clear();await Promise.all(drivers.map(driver=>driver.close()))}if(this.enabled&&this.auth.status().connected)try{await this.refresh()}catch{/* Saved policy is visible together with the discovery error. */}return this.status()}
 async connect(){if(this.closed)throw new AntigravityError('The connection is stopping.',409);await this.auth.connect();this.enabled=true;this.executable=this.auth.status().executable;await this.refresh();return this.status()}
 async authenticate(raw:unknown){await this.auth.authenticate(raw);return this.status()}
 async disconnect(){++this.generation;this.discoveryController?.abort();this.refreshing=undefined;this.enabled=false;const drivers=[...this.drivers.values()];this.drivers.clear();await Promise.all(drivers.map(driver=>driver.close()));await this.auth.disconnect();this.discovery={state:this.raw.length?'cached':'idle'};this.persist();this.changed();return this.status()}
 refresh(){
  if(this.refreshing)return this.refreshing;
  if(!this.enabled||!this.auth.status().connected)return Promise.reject(new AntigravityError('Connect Antigravity before refreshing models.',409));
  const generation=this.generation,executable=this.auth.status().executable,controller=new AbortController();this.discoveryController=controller;this.discovery={state:'refreshing'};this.changed();
  const pending=(async()=>{try{
   const models=await (this.options.discover??discoverAntigravityModels)(executable,{workRoot:join(this.auth.root,'model-requests'),timeoutMs:30000,signal:controller.signal,allowSharedCustomizations:this.allowSharedCustomizations});
   if(this.closed||generation!==this.generation||!this.enabled)return this.status();
   if(!models.length)throw Error('Antigravity advertised no models.');
   this.raw=models;this.executable=executable;this.fetchedAt=Date.now();this.discovery={state:'ready'};this.persist();this.changed();return this.status();
  }catch(error){if(generation===this.generation&&!this.closed){this.discovery={state:'error',message:error instanceof Error?error.message:'Could not refresh Antigravity models.'};this.changed()}throw error}})();
  this.refreshing=pending;this.discoveries.add(pending);void pending.finally(()=>{this.discoveries.delete(pending);if(this.refreshing===pending)this.refreshing=undefined}).catch(()=>undefined);return pending;
 }
 stream(model:any,context:any,options:any){
  if(!this.available())throw new AntigravityError('Connect Antigravity and refresh its models in Settings → Connections.',409);
  const executable=model.antigravityExecutable;if(!executable||executable!==this.executable||model.antigravityGeneration!==this.generation)throw new AntigravityError('The Antigravity connection changed. Start this turn again with a current model.',409);
  const slugs=model.antigravitySlugs??{},effort=options.reasoningEffort??model.defaultReasoningEffort;
  const slug=slugs[effort]??slugs.default??(!effort?Object.values(slugs)[0]:undefined);if(typeof slug!=='string')throw new AntigravityError('Choose an advertised Antigravity reasoning effort.');
  let driver=this.drivers.get(executable+'@'+this.allowSharedCustomizations);if(!driver){driver=(this.options.driver??createAntigravityProvider)({executable,workRoot:join(this.auth.root,'model-requests'),timeoutMs:model.requestTimeoutMs,allowSharedCustomizations:this.allowSharedCustomizations});this.drivers.set(executable+'@'+this.allowSharedCustomizations,driver)}
  return driver.stream({...model,id:slug},context,options);
 }
 executablePath(){return this.executable}
 connectionGeneration(){return this.generation}
 async close(){if(this.closed)return;this.closed=true;++this.generation;this.discoveryController?.abort();this.unsubscribe();await Promise.all([...this.drivers.values()].map(driver=>driver.close()));await this.auth.close();await Promise.allSettled(this.discoveries)}
}
