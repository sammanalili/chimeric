import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {Registry} from '../src/registry';
import {makeCatalog} from '../src/catalog';
import {AntigravityHttpModels,ANTIGRAVITY_HTTP_BASE_URL} from '../src/antigravity-http-models';
import {ImageGenerationManager} from '../src/image-generation-manager';
import {generateAntigravityImage} from '../src/antigravity-image-generation';
import {DEFAULT_IMAGE_MODEL} from '../src/image-generation';

const imageModel='gemini-3.1-flash-image',chatModel='gemini-4-argon-medium';
const jpeg='/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAADAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABgj/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABykX//Z';
const bytes=Buffer.from(jpeg,'base64');
const args={prompt:'A synthetic blue atom on white',filename:'blue-atom.png'};
const call={id:'image-tool-call'};
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()});
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
const tick=()=>Bun.sleep(0);
const response=()=>new Response('data: '+JSON.stringify({response:{responseId:'synthetic-agy-image',candidates:[{content:{role:'model',parts:[{inlineData:{mimeType:'image/jpeg',data:jpeg}}]},finishReason:'STOP'}]}})+'\n\n',{headers:{'content-type':'text/event-stream'}});

async function fixture(options:{configure?:boolean;imageFetch?:(url:string,init:any)=>Response|Promise<Response>}={}){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-agy-image-manager-'));
 let record:any={session:'synthetic-google-session-a',version:'v1',credential:{access:'synthetic-google-access-a',refresh:'synthetic-google-refresh-a',expires:Date.now()+3_600_000}};
 const catalog:any={models:{[chatModel]:{displayName:'Gemini 4 Argon (Medium)',supportsImages:true,supportsThinking:true,maxTokens:1048576,maxOutputTokens:65536},[imageModel]:{displayName:'Gemini 3.1 Flash Image',supportsImages:true,maxTokens:65536,maxOutputTokens:65536}},agentModelSorts:[{groups:[{modelIds:[chatModel]}]}],imageGenerationModelIds:[imageModel]};
 let authCalls=0,catalogCalls=0,apiFallbackCalls=0;
 const connected=()=>!!record.credential;
 const auth:any={
  status:()=>({connected:connected()}),onChange:()=>()=>{},redact:(value:string)=>value.replace(/synthetic-google-(?:access|refresh)-[ab]/g,'[redacted]'),close(){},
  vault:{read:()=>record},disconnect(){record={...record,credential:null}},
  async profileInfo(signal?:AbortSignal){signal?.throwIfAborted();return {project:'synthetic-google-project'}},
  async requestAuth(signal?:AbortSignal){
   signal?.throwIfAborted();if(!connected())throw Error('Synthetic Google sign-in disconnected');authCalls++;
   const session=record.session;
   return {apiKey:record.credential.access,sessionScope:session,assertCurrent(){signal?.throwIfAborted();if(!connected()||record.session!==session)throw Error('Synthetic Google connection changed')},fetch:async(url:any)=>{catalogCalls++;expect(String(url)).toBe('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');return Response.json(catalog)}};
  },
 };
 const service=new AntigravityHttpModels(dir,{auth});
 const registry=new Registry({providers:{
  'antigravity-http':{name:'Antigravity subscription',api:'antigravity-http',baseUrl:ANTIGRAVITY_HTTP_BASE_URL,revision:'agy-v1'},
  openai:{name:'Available API',api:'openai-responses',baseUrl:'https://api.openai.com/v1',keyEnv:'SYNTHETIC_IMAGE_API_KEY',models:[{id:'synthetic-chat'}]},
 },defaultModel:'openai::synthetic-chat'},dir,new Map([['openai','synthetic-openai-key']]));
 registry.antigravityHttp=service;await service.refresh();await registry.refresh(false);
 const requests:any[]=[],imageRequests:any[]=[],saves:any[]=[],metadata=new Map<string,any>();
 const managers:ImageGenerationManager[]=[];
 const generate:typeof generateAntigravityImage=async(request,deps)=>{
  requests.push(request);
  return generateAntigravityImage(request,{...deps,fetch:(async(url:any,init:any)=>{imageRequests.push({url:String(url),body:JSON.parse(init.body),signal:init.signal});return options.imageFetch?options.imageFetch(String(url),init):response()}) as typeof fetch});
 };
 const open=()=>{const manager=new ImageGenerationManager(registry,{generateAntigravity:generate,generate:async()=>{apiFallbackCalls++;throw Error('Unexpected API billing fallback')}});managers.push(manager);return manager};
 let manager=open();
 const host:any={frameId:'synthetic-frame',rootFrameId:'synthetic-root',projectId:'synthetic-project',agentName:'OPERON',
  _artifactSvcImpl:{async save_artifact(input:any){
   saves.push(input);const version_id='image-version-'+saves.length,storage_path=join('objects',version_id+'.jpg');mkdirSync(join(dir,'objects'),{recursive:true});writeFileSync(join(dir,storage_path),input.content);
   const result={version_id,artifact_id:'image-artifact-'+saves.length,filename:input.filename,storage_path,project_id:input.project_id,root_frame_id:input.root_frame_id,frame_id:input.frame_id,size_bytes:input.content.length,checksum:createHash('sha256').update(input.content).digest('hex'),content_type:input.content_type};metadata.set(version_id,result);return result;
  }},
  _fullStore:{_base_path:dir,resolve_storage_path:(path:string)=>join(dir,path),get_version_metadata_lite:async(id:string)=>metadata.get(id)},
 };
 if(options.configure!==false)manager.configure({expectedRevision:0,connectionId:'antigravity-http',imageModel});
 cleanups.push(async()=>{for(const item of managers)try{await item.close()}catch{}await service.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,registry,service,catalog,manager,host,requests,imageRequests,saves,metadata,get authCalls(){return authCalls},get catalogCalls(){return catalogCalls},get apiFallbackCalls(){return apiFallbackCalls},replaceSession(){record={...record,session:'synthetic-google-session-b',version:'v2',credential:{access:'synthetic-google-access-b',refresh:'synthetic-google-refresh-b',expires:Date.now()+3_600_000}}},async restart(){await manager.close();managers.splice(managers.indexOf(manager),1);manager=open();return manager}};
}

test('Google image models stay outside chat and are scoped to their image-provider kind',async()=>{
 const f=await fixture({configure:false});
 expect(f.service.catalog().some(model=>model.id===imageModel)).toBe(false);
 expect(f.registry.models.has('antigravity-http::'+imageModel)).toBe(false);
 expect(makeCatalog(f.registry).model_selector.catalog.models.some(model=>model.id.endsWith(imageModel))).toBe(false);
 const state=f.manager.snapshot();
 expect(state.providers.find(provider=>provider.id==='antigravity-http')).toMatchObject({kind:'antigravity',billing:'subscription',ready:true});
 expect(state.imageModels.find(model=>model.id===imageModel)).toMatchObject({kind:'antigravity',billing:'subscription'});
 expect(state.subscription.available).toBe(false);
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'antigravity-http',imageModel:'gpt-image-2'})).toThrow('Choose an image model');
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'openai',imageModel})).toThrow('Choose an image model');
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'antigravity-http',imageModel:DEFAULT_IMAGE_MODEL})).toThrow('Choose an image model');
 expect(f.requests).toHaveLength(0);expect(f.apiFallbackCalls).toBe(0);
});

test('the AGY image tool hides unsupported controls and sends its chosen image model through the real adapter',async()=>{
 const f=await fixture();const tool=f.manager.toolDefinition()!;
 expect(tool.name).toBe('generate_image');expect(tool.description).toContain('Antigravity subscription');
 expect(tool.description).toContain('Selected connection: antigravity-http.');
 expect(tool.description).toContain('Image model: '+imageModel+'.');
 expect(tool.input_schema.properties.quality).toBeUndefined();expect(tool.input_schema.properties.background).toBeUndefined();
 const out=await f.manager.execute(f.host,call,args);
 expect(out.status).toBe('success');expect(f.requests).toHaveLength(1);
 expect(f.requests[0]).toMatchObject({model:{api:'antigravity-http',provider:'antigravity-http',mode:'image-generation'},route:'antigravity',imageModel,project:'synthetic-google-project'});
 expect(f.requests[0].format).toBeUndefined();
 expect(f.imageRequests).toHaveLength(1);expect(f.imageRequests[0].url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
 expect(f.imageRequests[0].body).toMatchObject({model:imageModel,project:'synthetic-google-project',request:{generationConfig:{responseModalities:['TEXT','IMAGE']}}});
 expect(out.result).toMatchObject({provider:'antigravity-http',model:imageModel,billing:'subscription',route:'antigravity'});
 expect(f.saves[0]).toMatchObject({project_id:'synthetic-project',root_frame_id:'synthetic-root',frame_id:'synthetic-frame',content_type:'image/jpeg',agent_name:'OPERON',is_user_upload:false});
 expect(f.saves[0].filename).toMatch(/^blue-atom-[a-f0-9]{8}\.jpg$/);
 expect(readFileSync(out.result.artifacts[0].file_path)).toEqual(bytes);
 expect(out.result.artifacts[0].artifact_ref).toBe('{{artifact:'+out.result.artifacts[0].version_id+'}}');
 expect(JSON.stringify(out)).not.toContain('synthetic-google-access');expect(f.apiFallbackCalls).toBe(0);
});

test('completed AGY receipts replay after restart without another generation or API fallback',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args);
 const manager=await f.restart();expect(manager.snapshot().selected).toEqual({connectionId:'antigravity-http',imageModel});
 expect(await manager.execute(f.host,call,args)).toEqual(initial);
 expect(f.requests).toHaveLength(1);expect(f.imageRequests).toHaveLength(1);expect(f.saves).toHaveLength(1);expect(f.apiFallbackCalls).toBe(0);
});

test('tool arguments cannot substitute an API provider, image model or explicit PNG format',async()=>{
 const f=await fixture();const out=await f.manager.execute(f.host,call,{...args,connectionId:'openai',imageModel:DEFAULT_IMAGE_MODEL,model:'other',route:'images',format:'png',billing:'api',apiKey:'untrusted-token'});
 expect(out.status).toBe('success');expect(f.requests[0].imageModel).toBe(imageModel);expect(f.requests[0].route).toBe('antigravity');expect(f.requests[0].format).toBeUndefined();expect(f.apiFallbackCalls).toBe(0);
});

test('a session replacement while queued behind four requests is refused before image dispatch',async()=>{
 const f=await fixture(),gate=deferred();let entered=0;
 const blockers=Array.from({length:4},()=>f.service.runRequest(async()=>{entered++;await gate.promise}));
 let image:Promise<any>|undefined;
 try{
  while(entered<4)await tick();
  image=f.manager.execute(f.host,call,args);await tick();expect(f.imageRequests).toHaveLength(0);
  f.replaceSession();gate.resolve();await Promise.all(blockers);
  const out=await image;expect(out.status).toBe('error');expect(out.error).toContain('connection changed before image generation');
  expect(f.imageRequests).toHaveLength(0);expect(f.saves).toHaveLength(0);expect(f.apiFallbackCalls).toBe(0);
 }finally{gate.resolve();await Promise.allSettled([...blockers,...image?[image]:[]])}
});

test('disconnect cancels an in-flight AGY image, saves nothing and keeps the selected source',async()=>{
 const entered=deferred();
 const f=await fixture({imageFetch:async(_url,init)=>{entered.resolve();return new Promise<Response>((_resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true})})}});
 const pending=f.manager.execute(f.host,call,args);await entered.promise;await f.service.disconnect();
 const out=await pending;expect(out.status).toBe('error');expect(out.error).toContain('cancelled');expect(f.saves).toHaveLength(0);expect(f.apiFallbackCalls).toBe(0);
 expect(f.manager.snapshot().selected).toEqual({connectionId:'antigravity-http',imageModel});expect(f.manager.toolDefinition()).toBeUndefined();
 expect(await f.manager.execute(f.host,{id:'new-after-disconnect'},args)).toMatchObject({status:'error'});expect(f.imageRequests).toHaveLength(1);
});

test('a replacement account after dispatch cannot persist the previous account image',async()=>{
 const entered=deferred(),gate=deferred();
 const f=await fixture({imageFetch:async()=>{entered.resolve();await gate.promise;return response()}});
 const pending=f.manager.execute(f.host,call,args);
 try{await entered.promise;f.replaceSession();gate.resolve();const out=await pending;expect(out.status).toBe('error');expect(out.error).toContain('connection changed');expect(f.saves).toHaveLength(0);expect(f.apiFallbackCalls).toBe(0)}
 finally{gate.resolve();await pending}
});

test('removing an advertised image model disables its selected tool without falling back to an API',async()=>{
 const f=await fixture();f.catalog.imageGenerationModelIds=[];await f.service.refresh();await f.registry.refresh(false);
 expect(f.manager.snapshot().providers.find(provider=>provider.id==='antigravity-http')?.ready).toBe(false);
 expect(f.manager.snapshot().selected).toEqual({connectionId:'antigravity-http',imageModel});expect(f.manager.toolDefinition()).toBeUndefined();
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.imageRequests).toHaveLength(0);expect(f.apiFallbackCalls).toBe(0);
});
