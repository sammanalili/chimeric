import {expect,test} from 'bun:test';
import {AntigravityHttpModels,normalizeAntigravityHttpCatalog,groupAntigravityHttpModels} from '../src/antigravity-http-models';

const model:any={id:'gemini-4-argon-medium',name:'Synthetic',api:'antigravity-http',provider:'antigravity-http',input:['text'],reasoning:false,contextWindow:128000,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const context:any={messages:[{role:'user',content:'Synthetic request',timestamp:1}]};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
async function drain(events:any){const all=[];for await(const event of events)all.push(event);return all}
function fixture(){
 const requests:Array<{finish:()=>void;aborted:boolean}>=[];
 const auth:any={status:()=>({connected:true}),onChange:()=>()=>{},close(){},disconnect(){}};
 const manager:any=new AntigravityHttpModels('/unused-synthetic-profile',{auth});
 // Start at discovery's ready state and drive the actual eager HTTP provider.
 manager.discovery={state:'ready'};
 manager.models=groupAntigravityHttpModels(normalizeAntigravityHttpCatalog({models:{[model.id]:{displayName:'Synthetic (Medium)',supportsThinking:true,maxTokens:128000,maxOutputTokens:1000}}}));
 const fetchStub=(async(_url:any,init:any)=>await new Promise<Response>((resolve,reject)=>{
  const request={aborted:false,finish:()=>{
   init.signal.removeEventListener('abort',abort);
   resolve(new Response('data: '+JSON.stringify({response:{candidates:[{content:{role:'model',parts:[{text:'OK'}]},finishReason:'STOP'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}}));
  }};
  const abort=()=>{request.aborted=true;reject(new DOMException('Cancelled','AbortError'))};
  init.signal.addEventListener('abort',abort,{once:true});requests.push(request);
 })) as typeof fetch;
 const start=(signal?:AbortSignal)=>drain(manager.stream(model,context,{apiKey:'synthetic-access',fetch:fetchStub,signal}));
 return {manager,requests,start};
}

test('queues before constructing the real eager provider and keeps at most four requests in flight',async()=>{
 const f=fixture(),turns=Array.from({length:9},()=>f.start());
 try{
  await tick();expect(f.requests.length).toBe(4);
  for(const request of f.requests.slice(0,4))request.finish();
  await tick();expect(f.requests.length).toBe(8);
  for(const request of f.requests.slice(4,8))request.finish();
  await tick();expect(f.requests.length).toBe(9);
  f.requests[8].finish();
  const results=await Promise.all(turns);
  expect(results.every(events=>events.some(event=>event.type==='done'))).toBe(true);
 }finally{for(const request of f.requests)request.finish();await f.manager.close()}
});

function catalogPayload(){
 const models:Record<string,any>={},ids:string[]=[];
 for(const [base,name] of [['gemini-4-argon','Gemini 4 Argon'],['gemini-3.8-flash','Gemini 3.8 Flash'],['claude-opus-5-5','Claude Opus 5.5'],['claude-sonnet-5-5','Claude Sonnet 5.5']]){
  for(const effort of ['low','medium','high']){
   const id=base+'-'+effort;ids.push(id);
   models[id]={displayName:name+' ('+effort[0].toUpperCase()+effort.slice(1)+')',supportsThinking:true,supportsImages:true,maxTokens:1000000,maxOutputTokens:65536};
  }
 }
 ids.push('gpt-oss-120b-medium');models['gpt-oss-120b-medium']={displayName:'GPT-OSS 120B (Medium)',supportsThinking:true,maxTokens:131072,maxOutputTokens:32768};
 for(const id of ['gemini-3.5-flash-lite','gemini-2.5-flash-lite','gemini-2.5-flash-thinking','gemini-2.5-flash'])models[id]={displayName:'Gemini 3.5 Flash Lite',supportsThinking:true};
 models['gemini-3.1-flash-image']={displayName:'Gemini 3.1 Flash Image',supportsImages:true};
 models['chat_named_helper']={displayName:'Internal helper'};
 return {models,agentModelSorts:[{displayName:'Recommended',groups:[{modelIds:ids}]}],imageGenerationModelIds:['gemini-3.1-flash-image']};
}
function catalogAuth(payload:any):any{
 return {status:()=>({connected:true}),onChange:()=>()=>{},close(){},disconnect(){},redact:(message:string)=>message,
  async requestAuth(){return {apiKey:'synthetic-access',fetch:async()=>Response.json(payload)}},
  async profileInfo(){return {project:'synthetic-project'}}};
}

test('uses the advertised research picker and excludes named legacy aliases and image generation',()=>{
 const raw=normalizeAntigravityHttpCatalog(catalogPayload()),families=groupAntigravityHttpModels(raw);
 expect(raw).toHaveLength(13);expect(families).toHaveLength(5);
 expect(raw.some(entry=>/flash-lite|flash-image|^chat_/.test(entry.id))).toBe(false);
 expect(families.map(entry=>entry.name)).toEqual(['Claude Opus 5.5','Claude Sonnet 5.5','Gemini 3.8 Flash','Gemini 4 Argon','GPT-OSS 120B']);
 expect(families.find(entry=>entry.id==='gemini-4-argon')!.reasoningEfforts).toEqual({low:'low',medium:'medium',high:'high'});
 expect(families.find(entry=>entry.id==='gemini-4-argon')!.defaultReasoningEffort).toBe('medium');
});

test('fallback catalog excludes dedicated images and named internal helpers when picker metadata is absent or invalid',()=>{
 const payload=catalogPayload();
 for(const agentModelSorts of [undefined,[],[{groups:[{modelIds:['missing-model',12,null]}]}]]){
  const models=normalizeAntigravityHttpCatalog({...payload,agentModelSorts});
  expect(models.some(model=>model.id==='gemini-3.1-flash-image')).toBe(false);
  expect(models.some(model=>model.id==='chat_named_helper')).toBe(false);
  expect(models.some(model=>model.id==='gemini-4-argon-medium')).toBe(true);
 }
});

test('family limits and image capability are conservative across effort variants',()=>{
 const raw=normalizeAntigravityHttpCatalog({models:{
  'synthetic-low':{displayName:'Synthetic (Low)',supportsImages:true,supportsThinking:true,maxTokens:10000,maxOutputTokens:3000},
  'synthetic-high':{displayName:'Synthetic (High)',supportsImages:false,supportsThinking:true,maxTokens:8000,maxOutputTokens:2000},
 }});
 const [family]=groupAntigravityHttpModels(raw);
 expect(family.input).toEqual(['text']);expect(family.contextWindow).toBe(8000);expect(family.maxTokens).toBe(2000);
 expect(family.max_input_tokens).toBe(8000);expect(family.max_output_tokens).toBe(2000);
});

test('real provider sends the chosen effort slug, supports saved raw ids, and publishes Carbon as a family',async()=>{
 const manager=new AntigravityHttpModels('/unused-synthetic-profile',{auth:catalogAuth(catalogPayload())});
 try{
  await manager.refresh();
  expect(manager.catalog()).toHaveLength(6);expect(manager.status().modelDiscovery.variantCount).toBe(16);
  expect(manager.catalog().some(model=>model.id==='gemini-4-carbon')).toBe(true);
  expect(manager.resolveAlias('gemini-4-argon')).toEqual({id:'gemini-4-argon'});
  expect(manager.resolveAlias('gemini-4-argon-high')).toEqual({id:'gemini-4-argon',effort:'high'});
  expect(manager.resolveAlias('gemini-2.5-flash')).toBeUndefined();
  const requests:any[]=[];
  const fetchStub=(async(_url:any,init:any)=>{requests.push(JSON.parse(init.body));return new Response('data: '+JSON.stringify({response:{candidates:[{content:{role:'model',parts:[{text:'OK'}]},finishReason:'STOP'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}})}) as typeof fetch;
  const family={...model,...manager.catalog().find(entry=>entry.id==='gemini-4-argon')};
  for(const effort of ['low','high'])await drain(manager.stream(family,context,{apiKey:'synthetic-access',fetch:fetchStub,reasoningEffort:effort}));
  await drain(manager.stream({...family,id:'gemini-4-argon-low'},context,{apiKey:'synthetic-access',fetch:fetchStub}));
  await drain(manager.stream(family,context,{apiKey:'synthetic-access',fetch:fetchStub}));
  expect(requests.map(request=>request.model)).toEqual(['gemini-4-argon-low','gemini-4-argon-high','gemini-4-argon-low','gemini-4-argon-medium']);
  expect(requests.every(request=>request.project==='synthetic-project')).toBe(true);
  expect(requests.every(request=>request.request.generationConfig.thinkingConfig===undefined)).toBe(true);
  await expect(drain(manager.stream(family,context,{apiKey:'synthetic-access',fetch:fetchStub,reasoningEffort:'max'}))).rejects.toThrow(/supported Antigravity reasoning effort/);
  expect(requests).toHaveLength(4);
 }finally{await manager.close()}
});

test('cancelling a queued request never starts provider or network work',async()=>{
 const f=fixture(),active=Array.from({length:4},()=>f.start()),controller=new AbortController();
 const queued=f.start(controller.signal);
 try{
  await tick();expect(f.requests.length).toBe(4);
  controller.abort();await expect(queued).rejects.toThrow(/cancelled while waiting/);
  for(const request of f.requests)request.finish();
  await Promise.all(active);await tick();expect(f.requests.length).toBe(4);
 }finally{for(const request of f.requests)request.finish();await f.manager.close()}
});

test('disconnect aborts active requests and rejects queued requests without starting them',async()=>{
 const f=fixture(),active=Array.from({length:4},()=>f.start()),queued=f.start();
 try{
  await tick();expect(f.requests.length).toBe(4);
  await f.manager.disconnect();await expect(queued).rejects.toThrow(/cancelled while waiting/);
  const results=await Promise.all(active);
  expect(f.requests.every(request=>request.aborted)).toBe(true);
  expect(results.every(events=>events.some(event=>event.type==='error'&&event.reason==='aborted'))).toBe(true);
  expect(f.requests.length).toBe(4);
 }finally{for(const request of f.requests)request.finish();await f.manager.close()}
});

test('image-only catalogs stay usable without publishing image models or supplemental chat models in the picker',async()=>{
 const image='synthetic-image-model';
 const payload={models:{[image]:{displayName:'Synthetic Image',supportsImages:true},internal:{isInternal:true}},imageGenerationModelIds:[image,'internal',image]};
 const manager=new AntigravityHttpModels('/unused-synthetic-profile',{auth:catalogAuth(payload)});
 try{
  await manager.refresh();
  expect(manager.available()).toBe(true);
  expect(manager.catalog()).toEqual([]);
  expect(manager.imageCatalog()).toEqual([{id:image,name:'Synthetic Image'}]);
  expect(manager.status().modelDiscovery).toMatchObject({state:'ready',count:0,variantCount:0});
  expect(manager.project()).toBe('synthetic-project');
 }finally{await manager.close()}
});

test('image generation ids never leak into chat even when picker metadata also contains them',async()=>{
 const payload=catalogPayload();
 payload.agentModelSorts[0].groups[0].modelIds.push(payload.imageGenerationModelIds[0]);
 expect(normalizeAntigravityHttpCatalog(payload).some(entry=>entry.id===payload.imageGenerationModelIds[0])).toBe(false);
});

test('advertised image ids stay usable when optional model metadata is absent',async()=>{
 const manager=new AntigravityHttpModels('/unused-synthetic-profile',{auth:catalogAuth({imageGenerationModelIds:['synthetic-image']})});
 try{
  await manager.refresh();
  expect(manager.imageCatalog()).toEqual([{id:'synthetic-image',name:'synthetic-image'}]);
  expect(manager.available()).toBe(true);
  expect(manager.catalog()).toEqual([]);
 }finally{await manager.close()}
});
