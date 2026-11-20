import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AntigravityHttpModels,ANTIGRAVITY_HTTP_BASE_URL} from '../src/antigravity-http-models';
import {stream as httpStream} from '../src/antigravity-http-provider';
import {Registry} from '../src/registry';
import {ProviderManager} from '../src/provider-manager';
import {makeCatalog} from '../src/catalog';
import {startBridge} from '../src/bridge';

const prefix='antigravity-http::';
async function fixture(requireGeminiSignatures=false){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-http-registry-'));
 const ids=['gemini-4-argon-low','gemini-4-argon-medium','gemini-4-argon-high','claude-opus-5-5-low','claude-opus-5-5-high'];
 const payload={models:Object.fromEntries(ids.map(id=>[id,{displayName:id.startsWith('gemini')?'Gemini 4 Argon ('+id.split('-').at(-1)+')':'Claude Opus 5.5 ('+id.split('-').at(-1)+')',supportsThinking:true,supportsImages:true,maxTokens:1_048_576,maxOutputTokens:65_536}])),agentModelSorts:[{groups:[{modelIds:ids}]}]};
 const seen:any[]=[];
 const auth:any={status:()=>({connected:true}),onChange:()=>()=>{},redact:(v:string)=>v,close(){},disconnect(){},async profileInfo(){return {project:'synthetic-project'}},async requestAuth(){return {apiKey:'synthetic-access',sessionScope:'synthetic-session',fetch:async()=>Response.json(payload)}}};
 const service=new AntigravityHttpModels(dir,{auth,stream:((model:any,context:any,options:any)=>httpStream(model,context,{...options,packetTransport:'fetch',fetch:async(_url:any,init:any)=>{
  const body=JSON.parse(init.body);seen.push(body);
  if(requireGeminiSignatures&&body.model.startsWith('gemini-')&&body.request.contents.some((entry:any)=>{
   const first=entry.role==='model'&&entry.parts.find((part:any)=>part.functionCall);
   return first&&!first.thoughtSignature;
  }))return Response.json({error:{code:400,status:'INVALID_ARGUMENT',message:'Function call is missing a thought_signature in functionCall parts.'}},{status:400});
  return new Response('data: '+JSON.stringify({response:{candidates:[{content:{role:'model',parts:[{text:body.model}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:1,candidatesTokenCount:1,totalTokenCount:2}}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
 }})) as any});
 const registry=new Registry({providers:{'antigravity-http':{name:'Antigravity',api:'antigravity-http',baseUrl:ANTIGRAVITY_HTTP_BASE_URL}},defaultModel:prefix+'gemini-4-argon-high',roles:{large:prefix+'claude-opus-5-5-low'},headlineModels:[prefix+'gemini-4-argon-low',prefix+'gemini-4-argon-high']},dir);
 registry.antigravityHttp=service;
 await service.refresh();await registry.refresh();
 return {dir,service,registry,seen,async close(){await service.close();rmSync(dir,{recursive:true,force:true})}};
}

test('native HTTP catalog exposes families, thinking controls and Carbon while preserving saved suffix references',async()=>{
 const f=await fixture();
 try{
  const catalog=makeCatalog(f.registry),rows=catalog.model_selector.catalog.models;
  const argon=rows.filter(row=>row.id===prefix+'gemini-4-argon');
  expect(argon).toHaveLength(1);
  expect(argon[0].thinking?.effort_options.map(option=>option.id)).toEqual(['low','medium','high']);
  expect(argon[0].thinking?.always_on).toBe(true);
  expect(rows.some(row=>row.id===prefix+'gemini-4-carbon')).toBe(true);
  expect(rows.some(row=>/-(low|medium|high)$/.test(row.id))).toBe(false);
  expect(catalog.default_model_id).toBe(prefix+'gemini-4-argon');
  expect(catalog.default_effort).toBe('high');
  expect(f.registry.state.model).toBe(prefix+'gemini-4-argon-high');
  expect(f.registry.resolve(prefix+'claude-opus-5-5-low').defaultReasoningEffort).toBe('low');
  const settings=new ProviderManager(f.registry).snapshot();
  expect(settings.headlineModels).toEqual([prefix+'gemini-4-argon']);
  expect(settings.roles.large).toBe(prefix+'claude-opus-5-5-low');
  expect(settings.roleModels.find(model=>model.qualifiedId===settings.roles.large)?.name).toContain('(low)');
  f.registry.select(prefix+'gemini-4-argon-high');
  expect(f.registry.state).toEqual({model:prefix+'gemini-4-argon',effort:'high'});
 }finally{await f.close()}
});

test('refresh removes cached variant rows and legacy helpers without breaking saved variant IDs',async()=>{
 const f=await fixture();
 try{
  const base=f.registry.resolve(prefix+'gemini-4-argon');
  f.registry.models.set(prefix+'gemini-4-argon-high',{...base,id:'gemini-4-argon-high',qualifiedId:prefix+'gemini-4-argon-high'});
  f.registry.models.set(prefix+'gemini-2.5-flash',{...base,id:'gemini-2.5-flash',qualifiedId:prefix+'gemini-2.5-flash',name:'Gemini 3.5 Flash Lite'});
  await f.registry.refresh();
  expect(f.registry.models.has(prefix+'gemini-4-argon-high')).toBe(false);
  expect(f.registry.models.has(prefix+'gemini-2.5-flash')).toBe(false);
  expect(f.registry.resolve(prefix+'gemini-4-argon-high').qualifiedId).toBe(prefix+'gemini-4-argon');
  expect(f.registry.resolve(prefix+'gemini-4-argon-high').defaultReasoningEffort).toBe('high');
  for await(const _event of f.service.stream(f.registry.resolve(prefix+'gemini-4-argon-low'),{messages:[{role:'user',content:'Synthetic saved-reference check',timestamp:1}]},{apiKey:'synthetic-access'})){}
  expect(f.seen.at(-1).model).toBe('gemini-4-argon-low');
 }finally{await f.close()}
});

test('changing native effort and recalling a saved suffix ID select the exact HTTP wire model',async()=>{
 const f=await fixture();let bridge:ReturnType<typeof startBridge>|undefined;
 try{
  bridge=startBridge(f.registry,'synthetic-bridge-key');
  for(const [model,effort,expected] of [[prefix+'gemini-4-argon','low','gemini-4-argon-low'],[prefix+'gemini-4-argon','high','gemini-4-argon-high'],[prefix+'gemini-4-argon-low',undefined,'gemini-4-argon-low']] as const){
   const response=await fetch(new URL('v1/messages',bridge.url),{method:'POST',headers:{'x-api-key':'synthetic-bridge-key','content-type':'application/json'},body:JSON.stringify({model,max_tokens:128,...effort?{output_config:{effort}}:{},messages:[{role:'user',content:'Synthetic catalog check'}]})});
   expect(response.status).toBe(200);
   expect((await response.json() as any).content).toEqual([{type:'text',text:expected}]);
   expect(f.seen.at(-1).model).toBe(expected);
  }
 }finally{bridge?.stop(true);await f.close()}
});

test('editing unrelated connections preserves saved HTTP model aliases and routing',async()=>{
 const f=await fixture();
 try{
  const manager=new ProviderManager(f.registry);
  const updated=await manager.upsert({expectedRevision:0,name:'Local fixture',baseUrl:'http://127.0.0.1:1/v1',api:'openai-completions',mode:'manual',models:[{id:'fixture'}]});
  const added=updated.connections.find(connection=>connection.name==='Local fixture')!;
  expect(f.registry.antigravityHttp).toBe(f.service);
  expect(f.registry.resolve(f.registry.config.roles.large).defaultReasoningEffort).toBe('low');
  await manager.settings({expectedRevision:updated.revision,roles:updated.roles,headlineModels:updated.headlineModels});
  await manager.remove({expectedRevision:f.registry.revision,id:added.id});
  expect(f.registry.resolve(prefix+'gemini-4-argon-high').qualifiedId).toBe(prefix+'gemini-4-argon');
  expect(f.registry.config.roles.large).toBe(prefix+'claude-opus-5-5-low');
 }finally{await f.close()}
});

test('switching native tool history to Carbon high supplies the documented unsigned-history marker',async()=>{
 const f=await fixture(true);let bridge:ReturnType<typeof startBridge>|undefined;
 try{
  bridge=startBridge(f.registry,'synthetic-bridge-key');
  const response=await fetch(new URL('v1/messages',bridge.url),{method:'POST',headers:{'x-api-key':'synthetic-bridge-key','content-type':'application/json'},body:JSON.stringify({
   model:prefix+'gemini-4-carbon',max_tokens:128,output_config:{effort:'high'},
   tools:[{name:'send_user_message',description:'Record a synthetic message.',input_schema:{type:'object',properties:{message:{type:'string'}},required:['message']}}],
   messages:[
    {role:'user',content:'Synthetic history from another model.'},
    {role:'assistant',content:[{type:'tool_use',id:'native-prior-call',name:'send_user_message',input:{message:'Synthetic prior result.'}}]},
    {role:'user',content:[{type:'tool_result',tool_use_id:'native-prior-call',content:'Recorded.'}]},
    {role:'user',content:'Continue the synthetic conversation.'},
   ],
  })});
  expect(response.status).toBe(200);
  expect((await response.json() as any).content).toEqual([{type:'text',text:'gemini-4-carbon-high'}]);
  expect(f.seen).toHaveLength(1);
  const parts=f.seen[0].request.contents.flatMap((entry:any)=>entry.parts),call=parts.find((part:any)=>part.functionCall),result=parts.find((part:any)=>part.functionResponse);
  expect(call).toEqual({functionCall:{name:'send_user_message',args:{message:'Synthetic prior result.'},id:'native-prior-call'},thoughtSignature:'skip_thought_signature_validator'});
  expect(result.functionResponse).toMatchObject({name:'send_user_message',id:'native-prior-call',response:{result:'Recorded.'}});
 }finally{bridge?.stop(true);await f.close()}
});
