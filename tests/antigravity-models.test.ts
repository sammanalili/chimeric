import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AntigravityModels,groupAntigravityModels,ANTIGRAVITY_BASE_URL} from '../src/antigravity-models';
import {Registry} from '../src/registry';
import {ProviderManager} from '../src/provider-manager';
import {makeCatalog} from '../src/catalog';
import {startBridge} from '../src/bridge';
import {probeImage} from '../src/model-probe';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
const raw=[{id:'claude-opus-5-5-low',name:'Claude Opus 5.5 (Low)'},{id:'claude-opus-5-5-high',name:'Claude Opus 5.5 (High)'},{id:'gemini-4-argon-medium',name:'Gemini 4 Argon (Medium)'}];
function setup(discover:any=async()=>raw,customDriver?:any){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-agy-models-')),listeners=new Set<()=>void>();let connected=false,path='/synthetic/agy';
 const auth:any={root:join(dir,'antigravity'),status:()=>({connected,executable:path,version:'1.5.1',authState:'idle',authMethods:[],sessions:[],activeSessionId:null}),subscribe:(cb:any)=>{listeners.add(cb);return()=>listeners.delete(cb)},async connect(){connected=true},async configure(input:any){path=input.executable;connected=false},async disconnect(){connected=false},async close(){connected=false},async authenticate(){}};
 mkdirSync(auth.root);const seen:any[]=[];
 const service=new AntigravityModels(dir,{auth,discover,driver:customDriver??(()=>({stream(model:any,context:any,options:any){seen.push({model,context,options});const message:any={role:'assistant',api:'antigravity-cli',provider:'antigravity',model:model.id,content:[{type:'text',text:'AGY_NATIVE_OK'}],stopReason:'stop',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};const stream=new AssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end(message);return stream},async close(){}} as any))});
 const registry=new Registry({providers:{antigravity:{name:'Antigravity',api:'antigravity-cli',baseUrl:ANTIGRAVITY_BASE_URL}},defaultModel:'antigravity::claude-opus-5-5'},dir);registry.antigravity=service;
 return{dir,service,registry,seen,async close(){await service.close();rmSync(dir,{recursive:true,force:true})}};
}
test('Advertised variants become ordinary models with exact effort-to-slug mapping',()=>{const models=groupAntigravityModels(raw);expect(models).toHaveLength(2);expect(models[0]).toMatchObject({id:'claude-opus-5-5',name:'Claude Opus 5.5',input:['text'],reasoningEfforts:{low:'low',high:'high'},antigravitySlugs:{low:'claude-opus-5-5-low',high:'claude-opus-5-5-high'}})});
test('Managed provider appears in native catalog and dispatches through CLI without HTTP/key fallback',async()=>{
 const f=setup();let bridge:any;
 try{await f.service.connect();await f.registry.refresh();const catalog=makeCatalog(f.registry);const model=catalog.model_selector.catalog.models[0];expect(model.disabled).toBe(false);expect(model.thinking?.effort_options.map((v:any)=>v.id)).toEqual(['low','high']);expect(model.supports_vision).toBe(false);expect(model.thinking?.always_on).toBe(true);expect(()=>f.registry.apiKey(f.registry.resolve(model.id))).toThrow('official CLI');
 bridge=startBridge(f.registry,'test-agy');const r=await fetch(bridge.url.href+'v1/messages',{method:'POST',headers:{'x-api-key':'test-agy','content-type':'application/json'},body:JSON.stringify({model:model.id,max_tokens:128,output_config:{effort:'high'},messages:[{role:'user',content:'hello'}]})});expect(r.status).toBe(200);expect((await r.json() as any).content).toEqual([{type:'text',text:'AGY_NATIVE_OK'}]);expect(f.seen[0].model.id).toBe('claude-opus-5-5-high');expect(f.seen[0].options.apiKey).toBeUndefined();
 const count=f.seen.length;const bad=await fetch(bridge.url.href+'v1/messages',{method:'POST',headers:{'x-api-key':'test-agy','content-type':'application/json'},body:JSON.stringify({model:model.id,max_tokens:128,messages:[{role:'user',content:[{type:'image',source:{type:'base64',data:'AA==',media_type:'image/png'}}]}]})});expect(bad.status).toBe(400);expect(f.seen.length).toBe(count);
 }finally{bridge?.stop(true);await f.close()}
});
test('Disconnect retains selected catalog history while disabling new inference and vision probes',async()=>{
 const f=setup();try{await f.service.connect();await f.registry.refresh();const model=f.registry.resolve(f.registry.state.model);await f.service.disconnect();await f.registry.refresh();expect(makeCatalog(f.registry).model_selector.catalog.models[0].disabled).toBe(true);await expect(f.registry.requestAuth(model)).rejects.toThrow('Connect Antigravity');expect(()=>f.registry.select(model.qualifiedId)).toThrow('Connect Antigravity');const probe=await probeImage(model,{},new AbortController().signal,String);expect(probe.status).toBe('rejected');expect(f.seen).toHaveLength(0)}finally{await f.close()}
});
test('Stale in-flight catalog cannot overwrite a changed connection or repopulate disconnected models',async()=>{
 let release!:(v:any)=>void;const f=setup(()=>new Promise(resolve=>release=resolve));try{const pending=f.service.connect();await Bun.sleep(0);await f.service.configure({executable:'/synthetic/new-agy'});release(raw);await pending;expect(f.service.catalog()).toHaveLength(0);expect(f.service.available()).toBe(false);expect(JSON.parse(readFileSync(join(f.dir,'antigravity/model-catalog.json'),'utf8')).executable).toBe('/synthetic/new-agy')}finally{await f.close()}
});
test('Saving an API connection retains managed provider routing and forbids editing its identity',async()=>{
 const f=setup();try{await f.service.connect();await f.registry.refresh();const manager=new ProviderManager(f.registry);await manager.upsert({expectedRevision:0,name:'Local',baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',mode:'manual',models:[{id:'local'}]});expect(f.registry.antigravity).toBe(f.service);await manager.refreshAntigravity();expect(f.registry.resolve('antigravity::claude-opus-5-5').available).toBe(true);await expect(manager.remove({expectedRevision:1,id:'antigravity'})).rejects.toThrow('separate connection');await expect(manager.upsert({expectedRevision:1,id:'antigravity',name:'Hijack',baseUrl:'https://evil.example/v1',api:'openai-completions',mode:'manual',models:[{id:'x'}]})).rejects.toThrow('separate connection')}finally{await f.close()}
});

test('Revoking shared customization permission cancels active old-policy inference before returning',async()=>{
 const events=new AssistantMessageEventStream();let closed=0;
 const f=setup(async()=>raw,()=>({stream(){return events},async close(){closed++;const error:any={role:'assistant',content:[],stopReason:'aborted',errorMessage:'revoked'};events.push({type:'error',reason:'aborted',error});events.end(error)}}));
 try{await f.service.setSharedCustomizations({allowSharedCustomizations:true});await f.service.connect();await f.registry.refresh();const model=f.registry.resolve(f.registry.state.model);const running=f.service.stream(model,{},{}).result();await f.service.setSharedCustomizations({allowSharedCustomizations:false});expect(closed).toBe(1);expect((await running).stopReason).toBe('aborted');expect(f.service.status().allowSharedCustomizations).toBe(false);expect(JSON.parse(readFileSync(join(f.dir,'antigravity/model-catalog.json'),'utf8')).allowSharedCustomizations).toBe(false)}finally{await f.close()}
});
