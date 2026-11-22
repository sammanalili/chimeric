import {afterEach,expect,test} from 'bun:test';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {Registry} from '../src/registry';
import {ImageGenerationManager,ImageGenerationSettingsError} from '../src/image-generation-manager';
import {DEFAULT_IMAGE_MODEL,type generateImage} from '../src/image-generation';
import {SubscriptionManager,SubscriptionVault} from '../src/subscription';
import type {ImageReferenceResolver} from '../src/native-image-references';

// Generator injection never reaches an external service. The real Registry owns
// credential pinning; the native-store double writes and reads actual files.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC','base64');
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup()});
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
async function fixture(options:{generate?:typeof generateImage;configure?:boolean;subscription?:boolean;resolveReferenceImages?:ImageReferenceResolver;referenceConnection?:boolean}={}){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-image-manager-'));
 const referenceConnection=!!options.resolveReferenceImages&&options.referenceConnection!==false;
 const credentials=new Map([['openai','fixture-api-credential-one'],['second','fixture-api-credential-two']]);
 const registry=new Registry({providers:{
  openai:{name:'Fixture API',api:referenceConnection?'openai-completions':'openai-responses',baseUrl:referenceConnection?'https://reference-images.example.invalid/v1':'https://api.openai.com/v1',keyEnv:'CHIMERIC_FIXTURE_IMAGE_KEY',revision:'api-1',models:[referenceConnection?{id:'fixture-reference-image',image_generation:true}:{id:'fixture-chat'}]},
  second:{name:'Second API',api:'openai-responses',baseUrl:'https://api.openai.com/v1',keyEnv:'CHIMERIC_FIXTURE_IMAGE_SECOND_KEY',revision:'api-2',models:[{id:'fixture-chat'}]},
  noKey:{name:'API with no saved key',api:'openai-responses',baseUrl:'https://api.openai.com/v1',keyEnv:'CHIMERIC_FIXTURE_IMAGE_ABSENT_KEY',revision:'api-none',models:[{id:'fixture-chat'}]},
  subscription:{name:'Fixture ChatGPT',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api',models:[{id:'fixture-chat'}]},
 },defaultModel:'subscription::fixture-chat'},dir,credentials);
 const authPurposes:string[]=[],authSignals:AbortSignal[]=[],subscriptionVault=options.subscription?new SubscriptionVault(join(dir,'own-subscription-auth')):undefined;
 const subscriptionToken=(account:string,version:string)=>'fixture.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:account}})).toString('base64url')+'.'+version;
 const setSubscriptionAccount=(account='fixture-account-a',session='fixture-session-a',version='fixture-version-a')=>subscriptionVault!.write({session,version,credential:{type:'oauth',access:subscriptionToken(account,version),refresh:'fixture-subscription-refresh-'+version,expires:Date.now()+3_600_000}});
 if(subscriptionVault)setSubscriptionAccount();
 const subscription=subscriptionVault?new SubscriptionManager(subscriptionVault,{autoDiscover:false,fetch:(async()=>{throw Error('Manager fixture forbids network access')}) as typeof fetch}):undefined;
 if(subscription){
  const requestAuth=subscription.requestAuth.bind(subscription);
  subscription.requestAuth=(async(signal?:AbortSignal,purpose?:any)=>{authPurposes.push(purpose??'inference');if(signal)authSignals.push(signal);return requestAuth(signal,purpose)}) as typeof subscription.requestAuth;
  registry.subscription=subscription;
 }
 await registry.refresh(false);
 const requests:any[]=[],authProviders:string[]=[],saves:any[]=[],metadata=new Map<string,any>();
 let saveImpl:((input:any)=>Promise<any>)|undefined;
 const generator=(async(request,deps)=>{
  requests.push(request);
  const auth=await deps.resolveAuth(request.model,request.signal);
  const expected=request.model.api==='openai-codex-responses'?subscriptionVault?.read()?.credential?.access:credentials.get(request.model.provider);
  expect(auth.apiKey===expected).toBe(true);
  auth.assertCurrent?.();
  authProviders.push(request.model.provider);
  if(options.generate)return options.generate(request,deps);
  return generated(request);
 }) as typeof generateImage;
 const managers:ImageGenerationManager[]=[];
 const open=()=>{const manager=new ImageGenerationManager(registry,{generate:generator,resolveReferenceImages:options.resolveReferenceImages});managers.push(manager);return manager};
 let manager=open();
 const save=async(input:any)=>{
   const version_id='version-'+saves.length,storage_path=join('objects',version_id+'.png');
   mkdirSync(join(dir,'objects'),{recursive:true});writeFileSync(join(dir,storage_path),input.content);
   const result={version_id,artifact_id:'artifact-'+saves.length,filename:input.filename,storage_path,project_id:input.project_id,frame_id:input.frame_id,root_frame_id:input.root_frame_id,size_bytes:input.content.length,checksum:createHash('sha256').update(input.content).digest('hex'),content_type:input.content_type};
   metadata.set(version_id,result);return result;
 };
 const host:any={frameId:'frame-1',rootFrameId:'root-1',projectId:'project-1',agentName:'OPERON',
  _artifactSvcImpl:{save_artifact:async(input:any)=>{saves.push(input);return saveImpl?saveImpl(input):save(input)}},
  _fullStore:{_base_path:dir,resolve_storage_path:(path:string)=>join(dir,path),get_version_metadata_lite:async(id:string)=>metadata.get(id),get_version_metadata:async(id:string)=>metadata.get(id)}};
 if(options.configure!==false)manager.configure({expectedRevision:0,connectionId:'openai',imageModel:referenceConnection?'fixture-reference-image':DEFAULT_IMAGE_MODEL});
 cleanups.push(async()=>{for(const instance of managers)try{await instance.close()}catch{}subscription?.close();rmSync(dir,{recursive:true,force:true})});
 return {dir,registry,host,requests,authProviders,saves,metadata,manager,open,save,subscription,subscriptionVault,authPurposes,authSignals,setSubscriptionAccount,setSave:(impl:(input:any)=>Promise<any>)=>{saveImpl=impl},restart:async()=>{await manager.close();managers.splice(managers.indexOf(manager),1);manager=open();return manager}};
}
function generated(request:any){return {provider:request.model.provider,model:request.model.id,imageModel:request.imageModel,route:request.route??'images',billing:request.model.api==='openai-codex-responses'?'subscription' as const:'api' as const,responseId:'response-fixture',images:[{bytes:png,mimeType:'image/png' as const,extension:'png' as const,width:1,height:1}]}}
const args={prompt:'A synthetic red square',filename:'red-square.png'};
const call={id:'call-image-1'};

test('Explicit API selection is separate from the chat model and persists exact native artifact bytes',async()=>{
 const f=await fixture();expect(f.registry.state.model).toBe('subscription::fixture-chat');
 expect(f.manager.snapshot().providers.find(provider=>provider.id==='subscription')?.ready??false).toBe(false);
 expect(f.manager.toolDefinition()?.name).toBe('generate_image');
 const out=await f.manager.execute(f.host,call,args);expect(out.status).toBe('success');
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['openai']);
 expect(f.requests[0]).toMatchObject({route:'images',imageModel:DEFAULT_IMAGE_MODEL,format:'png',prompt:args.prompt});
 expect(f.saves[0]).toMatchObject({project_id:'project-1',root_frame_id:'root-1',frame_id:'frame-1',agent_name:'OPERON',content_type:'image/png',is_user_upload:false});
 expect(f.saves[0].filename).toMatch(/^red-square-[a-f0-9]{8}\.png$/);
 const artifact=out.result.artifacts[0];expect(readFileSync(artifact.file_path)).toEqual(png);
 expect(artifact.artifact_ref).toBe('{{artifact:'+artifact.version_id+'}}');
 expect(JSON.stringify(out)).not.toContain('fixture-api-credential');
});

test('No selection, disconnected subscription, missing saved key, and disabled providers never fall back to another API',async()=>{
 const f=await fixture({configure:false});expect(f.manager.toolDefinition()).toBeUndefined();
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'subscription',imageModel:DEFAULT_IMAGE_MODEL})).toThrow(ImageGenerationSettingsError);
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'noKey',imageModel:DEFAULT_IMAGE_MODEL})).toThrow(ImageGenerationSettingsError);
 f.registry.config.providers.openai.enabled=false;
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'openai',imageModel:DEFAULT_IMAGE_MODEL})).toThrow(ImageGenerationSettingsError);
 f.registry.config.providers.second.enabled=false;
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(0);
});

test('Concurrent duplicate tool calls share one dispatch and one saved artifact',async()=>{
 const gate=deferred(),entered=deferred();const f=await fixture({generate:async(request)=>{entered.resolve();await gate.promise;return generated(request)}});
 const a=f.manager.execute(f.host,call,args);await entered.promise;
 const b=f.manager.execute(f.host,call,args);gate.resolve();
 const [one,two]=await Promise.all([a,b]);expect(one).toEqual(two);expect(f.requests).toHaveLength(1);expect(f.saves).toHaveLength(1);
});

test('Completed duplicate remains idempotent across manager restart',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args);const manager=await f.restart();
 const replay=await manager.execute(f.host,call,args);expect(replay).toEqual(initial);expect(f.requests).toHaveLength(1);expect(f.saves).toHaveLength(1);
});

test('Changed prompt, filename, or selected API connection cannot reuse a billed request ID',async()=>{
 const f=await fixture();await f.manager.execute(f.host,call,args);
 for(const altered of [{...args,prompt:'A blue circle'},{...args,filename:'other.png'}])expect(await f.manager.execute(f.host,call,altered)).toMatchObject({status:'error',error:expect.stringContaining('different')});
 f.manager.configure({expectedRevision:1,connectionId:'second',imageModel:DEFAULT_IMAGE_MODEL});
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('different')});expect(f.requests).toHaveLength(1);
});

test('A changed provider revision rejects a replay before resolving the replacement credential',async()=>{
 const f=await fixture();await f.manager.execute(f.host,call,args);
 f.registry.config.providers.openai.revision='api-replaced';await f.registry.refresh(false,['openai']);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('different')});expect(f.requests).toHaveLength(1);
});

test('A shared tool-call ID in different native frames or projects produces separately bound artifacts',async()=>{
 const f=await fixture();await f.manager.execute(f.host,call,args);
 const second=await f.manager.execute({...f.host,frameId:'frame-2'},call,args);
 const third=await f.manager.execute({...f.host,projectId:'project-2',rootFrameId:'root-2'},call,args);
 expect(second.result.artifacts[0].frame_id).toBe('frame-2');expect(third.result.artifacts[0].project_id).toBe('project-2');expect(f.requests).toHaveLength(3);
});

for(const change of [{agentName:'REVIEWER'},{agentName:'AUDITOR'},{agentName:'BOOKMARKER'},{agentName:'reviewer'},{_isAside:true}])test('Read-only native frame cannot dispatch or replay: '+JSON.stringify(change),async()=>{
 const f=await fixture();expect(await f.manager.execute({...f.host,...change},call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(0);
 await f.manager.execute(f.host,call,args);expect(await f.manager.execute({...f.host,...change},call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);
});

test('Already cancelled calls never dispatch and leave the request available for an explicit later attempt',async()=>{
 const f=await fixture(),controller=new AbortController();controller.abort();
 expect(await f.manager.execute(f.host,call,args,controller.signal)).toMatchObject({status:'error',error:expect.stringContaining('cancelled')});expect(f.requests).toHaveLength(0);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'success'});expect(f.requests).toHaveLength(1);
});

test('Cancellation after dispatch prevents artifact persistence and permanently suppresses automatic replay',async()=>{
 const gate=deferred(),entered=deferred(),controller=new AbortController();
 const f=await fixture({generate:async(request)=>{entered.resolve();await gate.promise;return generated(request)}});
 const pending=f.manager.execute(f.host,call,args,controller.signal);await entered.promise;controller.abort();gate.resolve();
 expect(await pending).toMatchObject({status:'error',error:expect.stringContaining('cancelled')});expect(f.saves).toHaveLength(0);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});expect(f.requests).toHaveLength(1);
});

test('Shutdown cancels an active generation before closing its durable receipt store',async()=>{
 const entered=deferred();const f=await fixture({generate:async(request)=>{entered.resolve();await new Promise<void>(resolve=>request.signal!.addEventListener('abort',()=>resolve(),{once:true}));return generated(request)}});
 const pending=f.manager.execute(f.host,call,args);await entered.promise;await f.manager.close();
 expect(await pending).toMatchObject({status:'error',error:expect.stringContaining('cancelled')});expect(f.saves).toHaveLength(0);
});

test('Interrupted durable receipt survives restart and never redispatches its paid request',async()=>{
 const f=await fixture({generate:async()=>{throw Error('Interrupted synthetic request')}});
 await f.manager.execute(f.host,call,args);await f.manager.close();
 // Simulate the exact durable state after a process dies after dispatch and
 // before it records an outcome, retaining the manager's real binding/hash.
 const db=new Database(join(f.dir,'image-generation','jobs.sqlite'));db.query("UPDATE jobs SET phase='generating'").run();db.close();
 const manager=f.open();expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});expect(f.requests).toHaveLength(1);
});

test('A failed native artifact save cannot cause a second image charge on replay or restart',async()=>{
 const f=await fixture();f.setSave(async()=>{throw Error('Synthetic storage failure')});
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('Synthetic storage failure')});
 const manager=await f.restart();expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});expect(f.requests).toHaveLength(1);
});

test('Deleted saved artifact metadata refuses completed replay without charging again',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args);f.metadata.delete(initial.result.artifacts[0].version_id);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('unavailable')});expect(f.requests).toHaveLength(1);
});

for(const damage of ['missing','altered'] as const)test('Completed replay detects '+damage+' bytes even when native metadata remains',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args);const artifact=initial.result.artifacts[0];
 if(damage==='missing')rmSync(artifact.file_path);else {const damaged=Buffer.from(png);damaged[damaged.length-1]^=1;writeFileSync(artifact.file_path,damaged)}
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);
});

test('Completed replay refuses an external symlink even when its bytes match the saved image',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args),artifact=initial.result.artifacts[0];
 const outside=mkdtempSync(join(tmpdir(),'chimeric-image-outside-'));cleanups.push(async()=>rmSync(outside,{recursive:true,force:true}));
 const target=join(outside,'same-image.png');writeFileSync(target,png);rmSync(artifact.file_path);symlinkSync(target,artifact.file_path);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);
});

test('Completed replay checks native artifact session binding even when version ID remains present',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args),id=initial.result.artifacts[0].version_id;
 f.metadata.set(id,{...f.metadata.get(id),root_frame_id:'root-other'});
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);
});

test('Replaying a request in a changed root session never exposes an artifact from the previous session',async()=>{
 const f=await fixture();const initial=await f.manager.execute(f.host,call,args);
 const out=await f.manager.execute({...f.host,rootFrameId:'root-other'},call,args);
 if(out.status==='success'){expect(out.result.artifacts[0].root_frame_id).toBe('root-other');expect(out.result.artifacts[0].version_id).not.toBe(initial.result.artifacts[0].version_id)}
 else expect(out.status).toBe('error');
});

test('Cancellation during native save preserves the committed receipt and reports the saved artifact',async()=>{
 const f=await fixture(),entered=deferred(),gate=deferred(),controller=new AbortController();
 f.setSave(async(input)=>{entered.resolve();await gate.promise;return f.save(input)});
 const pending=f.manager.execute(f.host,call,args,controller.signal);await entered.promise;controller.abort();gate.resolve();
 const out=await pending;expect(out.status).toBe('error');expect(out.error).toContain('cancelled');expect(out.result.artifacts).toHaveLength(1);
 expect(readFileSync(out.result.artifacts[0].file_path)).toEqual(png);
 const manager=await f.restart(),replay=await manager.execute(f.host,call,args);
 expect(replay.status).toBe('success');expect(replay.result.artifacts[0].version_id).toBe(out.result.artifacts[0].version_id);expect(f.requests).toHaveLength(1);expect(f.saves).toHaveLength(1);
});

test('Tool arguments cannot replace the configured connection, credential, route, or output format',async()=>{
 const f=await fixture();await f.manager.execute(f.host,call,{...args,connectionId:'second',apiKey:'injected-key',route:'responses',format:'svg',model:'other'});
 expect(f.authProviders).toEqual(['openai']);expect(f.requests[0].route).toBe('images');expect(f.requests[0].format).toBe('png');
});

test('Malformed or unbounded tool arguments fail before generation',async()=>{
 const f=await fixture();
 for(const input of [null,[],{prompt:''},{prompt:'x'.repeat(32001)},{prompt:'ok',size:'99999x99999'},{prompt:'ok',quality:'unknown'},{prompt:42}])await expect(f.manager.execute(f.host,call,input)).rejects.toBeDefined();
 expect(f.requests).toHaveLength(0);expect(f.saves).toHaveLength(0);
});

test('Generator failure is redacted and never retried implicitly',async()=>{
 const f=await fixture({generate:async()=>{throw Error('Rejected fixture-api-credential-one')}});
 const out=await f.manager.execute(f.host,call,args);expect(out.status).toBe('error');expect(out.error).not.toContain('fixture-api-credential');
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);expect(f.saves).toHaveLength(0);
});

test('Two active generation slots are bounded and third-call rejection is safe to retry after a slot opens',async()=>{
 const gate=deferred(),entered=deferred();let active=0;
 const f=await fixture({generate:async(request)=>{if(++active===2)entered.resolve();await gate.promise;return generated(request)}});
 const one=f.manager.execute(f.host,call,args),two=f.manager.execute(f.host,{id:'call-image-2'},args);await entered.promise;
 expect(await f.manager.execute(f.host,{id:'call-image-3'},args)).toMatchObject({status:'error',error:expect.stringContaining('already running')});expect(f.requests).toHaveLength(2);
 gate.resolve();await Promise.all([one,two]);expect(await f.manager.execute(f.host,{id:'call-image-3'},args)).toMatchObject({status:'success'});expect(f.requests).toHaveLength(3);
});

const SUBSCRIPTION_IMAGE_MODEL='gpt-image-2';
function selectSubscription(f:Awaited<ReturnType<typeof fixture>>){
 return f.manager.configure({expectedRevision:f.manager.snapshot().revision,connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
}

test('Connected subscription source uses its own saved session and images-purpose auth without an API key',async()=>{
 const f=await fixture({configure:false,subscription:true});
 expect(f.registry.getPrivateCredential('subscription')).toBeUndefined();
 expect(f.manager.snapshot().selected).toBeNull();
 const chosen=selectSubscription(f);
 expect(chosen.providers.find(provider=>provider.id==='subscription')).toMatchObject({ready:true,billing:'subscription'});
 expect(chosen.selected).toEqual({connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(f.manager.toolDefinition()?.description.toLowerCase()).toContain('subscription');
 const result=await f.manager.execute(f.host,call,args);
 expect(result).toMatchObject({status:'success',result:{provider:'subscription',model:SUBSCRIPTION_IMAGE_MODEL,source_model:'fixture-chat',route:'subscription',billing:'subscription'}});
 expect(f.requests[0]).toMatchObject({model:{api:'openai-codex-responses',provider:'subscription',baseUrl:'https://chatgpt.com/backend-api'},route:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL,format:'png'});
 expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
 expect(f.authSignals).toHaveLength(1);expect(f.authSignals[0].aborted).toBe(false);
 expect(readFileSync(result.result.artifacts[0].file_path)).toEqual(png);
 expect(JSON.stringify(result)).not.toContain('fixture-subscription-refresh');
 expect(JSON.stringify(result)).not.toContain('fixture-account-a');
});

test('Subscription preference and its completed receipt survive restart while the active chat model changes',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 const initial=await f.manager.execute(f.host,call,args);f.registry.select('openai::fixture-chat');
 const manager=await f.restart();
 expect(manager.snapshot().selected).toEqual({connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(await manager.execute(f.host,call,args)).toEqual(initial);
 const saved=readFileSync(join(f.dir,'image-generation','settings.json'),'utf8');
 expect(JSON.parse(saved).selected).toEqual({connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(saved).not.toContain('fixture-subscription-refresh');expect(saved).not.toContain('fixture-api-credential');
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
});

test('A connected subscription never replaces an explicitly selected API image source',async()=>{
 const f=await fixture({subscription:true});
 const result=await f.manager.execute(f.host,call,args);
 expect(result).toMatchObject({status:'success',result:{provider:'openai',route:'images',billing:'api'}});
 expect(f.authProviders).toEqual(['openai']);expect(f.authPurposes).toHaveLength(0);
});

test('Subscription readiness follows its real connection rather than API credentials or chat-catalog readiness',async()=>{
 const f=await fixture({configure:false,subscription:true});
 f.registry.statuses.subscription={ready:false,models:1,error:'Synthetic chat catalog unavailable'};
 expect(f.manager.snapshot().providers.find(provider=>provider.id==='subscription')).toMatchObject({ready:true,billing:'subscription'});
 selectSubscription(f);expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'success',result:{billing:'subscription'}});
 expect(f.authProviders).toEqual(['subscription']);
});

test('Subscription image generation works with API credential resolution forbidden',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 let apiCredentialCalls=0;
 f.registry.apiKey=()=>{apiCredentialCalls++;throw Error('API credential fallback is forbidden in this fixture')};
 const result=await f.manager.execute(f.host,call,args);
 expect(result).toMatchObject({status:'success',result:{billing:'subscription'}});expect(apiCredentialCalls).toBe(0);expect(f.authPurposes).toEqual(['images']);
});

test('Tool input cannot switch subscription billing, route, connection, or legacy image model',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 await f.manager.execute(f.host,call,{...args,connectionId:'openai',route:'images',billing:'api',imageModel:DEFAULT_IMAGE_MODEL,apiKey:'untrusted-tool-key'});
 expect(f.requests).toHaveLength(1);expect(f.requests[0]).toMatchObject({route:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
});

test('A subscription connection rejects image models belonging only to the API source',async()=>{
 const f=await fixture({configure:false,subscription:true});
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:'subscription',imageModel:DEFAULT_IMAGE_MODEL})).toThrow(ImageGenerationSettingsError);
 expect(f.manager.snapshot().selected).toBeNull();expect(f.requests).toHaveLength(0);expect(f.authPurposes).toHaveLength(0);
});

test('Subscription quota failure keeps its preferred source and cannot fall back or replay after restart',async()=>{
 const f=await fixture({configure:false,subscription:true,generate:async()=>{throw Object.assign(Error('Synthetic subscription image quota exhausted'),{status:429})}});selectSubscription(f);
 const result=await f.manager.execute(f.host,call,args);expect(result).toMatchObject({status:'error',error:expect.stringContaining('quota')});
 const manager=await f.restart();expect(manager.snapshot().selected).toEqual({connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);expect(f.saves).toHaveLength(0);
});

test('A disconnected selected subscription stays selected and refuses new image requests despite ready APIs',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);f.subscription!.disconnect();
 expect(f.manager.snapshot().selected).toEqual({connectionId:'subscription',imageModel:SUBSCRIPTION_IMAGE_MODEL});
 expect(f.manager.snapshot().providers.find(provider=>provider.id==='subscription')).toMatchObject({ready:false,billing:'subscription'});
 expect(f.manager.toolDefinition()).toBeUndefined();expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});
 const manager=await f.restart();expect(manager.snapshot().selected?.connectionId).toBe('subscription');
 expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error'});
 expect(f.requests).toHaveLength(0);expect(f.authProviders).toHaveLength(0);expect(f.authPurposes).toHaveLength(0);
});

test('Disconnect cannot expose a completed subscription receipt or silently generate it through an API',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 await f.manager.execute(f.host,call,args);f.subscription!.disconnect();
 const manager=await f.restart();expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error'});
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
});

test('Rotating credentials inside the same subscription session preserves receipt idempotency',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 const initial=await f.manager.execute(f.host,call,args);f.setSubscriptionAccount('fixture-account-a','fixture-session-a','rotated-version');
 const manager=await f.restart();expect(await manager.execute(f.host,call,args)).toEqual(initial);
 expect(f.requests).toHaveLength(1);expect(f.authPurposes).toEqual(['images']);
});

test('Replacing the subscription account invalidates an old request identity without billing again',async()=>{
 const f=await fixture({configure:false,subscription:true});selectSubscription(f);
 await f.manager.execute(f.host,call,args);f.setSubscriptionAccount('fixture-account-b','fixture-session-b','fixture-version-b');
 const manager=await f.restart();expect(await manager.execute(f.host,call,args)).toMatchObject({status:'error'});
 expect(f.requests).toHaveLength(1);expect(f.authPurposes).toEqual(['images']);
 expect(await manager.execute(f.host,{id:'explicit-new-account-request'},args)).toMatchObject({status:'success',result:{provider:'subscription',billing:'subscription'}});
 expect(f.requests).toHaveLength(2);expect(f.authProviders).toEqual(['subscription','subscription']);expect(f.authPurposes).toEqual(['images','images']);
});

test('Disconnect during subscription generation prevents late artifact persistence and API fallback',async()=>{
 const entered=deferred(),gate=deferred();const f=await fixture({configure:false,subscription:true,generate:async(request)=>{entered.resolve();await gate.promise;return generated(request)}});selectSubscription(f);
 const pending=f.manager.execute(f.host,call,args);await entered.promise;f.subscription!.disconnect();gate.resolve();
 expect(await pending).toMatchObject({status:'error'});expect(f.saves).toHaveLength(0);
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
});

test('Replacing the subscription account during generation cannot save under the new account binding',async()=>{
 const entered=deferred(),gate=deferred();const f=await fixture({configure:false,subscription:true,generate:async(request)=>{entered.resolve();await gate.promise;return generated(request)}});selectSubscription(f);
 const pending=f.manager.execute(f.host,call,args);await entered.promise;f.setSubscriptionAccount('fixture-account-b','fixture-session-b','fixture-version-b');gate.resolve();
 expect(await pending).toMatchObject({status:'error'});expect(f.saves).toHaveLength(0);
 expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);expect(f.authPurposes).toEqual(['images']);
});

test('An in-flight subscription request retains its billing source when future image preferences switch to API',async()=>{
 const entered=deferred(),gate=deferred();const f=await fixture({configure:false,subscription:true,generate:async(request)=>{entered.resolve();await gate.promise;return generated(request)}});selectSubscription(f);
 const pending=f.manager.execute(f.host,call,args);await entered.promise;
 f.manager.configure({expectedRevision:f.manager.snapshot().revision,connectionId:'openai',imageModel:DEFAULT_IMAGE_MODEL});gate.resolve();
 expect(await pending).toMatchObject({status:'success',result:{provider:'subscription',route:'subscription',billing:'subscription'}});
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'error'});expect(f.requests).toHaveLength(1);expect(f.authProviders).toEqual(['subscription']);
});


const referenceVersion='9e600eb1-a3da-4c36-91b2-87b94ccdd09a';
const referenceChecksum=createHash('sha256').update(png).digest('hex');
const referenceArgs={...args,reference_image_version_ids:[referenceVersion]};
const referenceReceipt={artifact_id:'native-guide-artifact',version_id:referenceVersion,checksum:referenceChecksum};
function referenceResolver(check:()=>void=()=>{}):ImageReferenceResolver{
 return async()=>({images:[{bytes:png,mimeType:'image/png'}],references:[referenceReceipt],assertCurrent:async()=>check()});
}

test('Native reference bytes reach the selected generator while receipts retain IDs and checksum only',async()=>{
 const f=await fixture({resolveReferenceImages:referenceResolver(),generate:async request=>({...generated(request),operation:'edit',referenceImageCount:1})});
 expect(f.manager.toolDefinition()?.input_schema.properties.reference_image_version_ids).toMatchObject({minItems:1,maxItems:4,uniqueItems:true});
 const out=await f.manager.execute(f.host,call,referenceArgs);
 expect(out).toMatchObject({status:'success',result:{operation:'edit',reference_image_count:1,reference_images:[referenceReceipt]}});
 expect(f.requests[0].referenceImages).toEqual([{bytes:png,mimeType:'image/png'}]);
 const db=new Database(join(f.dir,'image-generation','jobs.sqlite'),{readonly:true});
 const receipt=(db.query('SELECT result FROM jobs').get() as any).result;db.close();
 expect(receipt).not.toContain(png.toString('base64'));expect(receipt).not.toContain('"referenceImages"');
 expect(await (await f.restart()).execute(f.host,call,referenceArgs)).toEqual(out);expect(f.requests).toHaveLength(1);
});

test('Native reference arguments reject paths, URLs, duplicates and extra images before resolution or auth',async()=>{
 let resolutions=0;
 const f=await fixture({resolveReferenceImages:async()=>{resolutions++;return referenceResolver()(f.host,{versionIds:[referenceVersion]})}});
 for(const reference_image_version_ids of [[],['/tmp/guide.png'],['https://example.test/guide.png'],[referenceVersion,referenceVersion],Array(5).fill(referenceVersion)]){
  await expect(f.manager.execute(f.host,call,{...args,reference_image_version_ids})).rejects.toBeDefined();
 }
 expect(resolutions).toBe(0);expect(f.authProviders).toHaveLength(0);expect(f.saves).toHaveLength(0);
});

test('Missing native authorization and reference resolution failures cannot dispatch an image request',async()=>{
 const absent=await fixture();expect(await absent.manager.execute(absent.host,call,referenceArgs)).toMatchObject({status:'error'});expect(absent.requests).toHaveLength(0);
 const denied=await fixture({resolveReferenceImages:async()=>{throw Error('Native reference denied')}});
 expect(await denied.manager.execute(denied.host,call,referenceArgs)).toMatchObject({status:'error',error:'Native reference denied'});expect(denied.authProviders).toHaveLength(0);expect(denied.requests).toHaveLength(0);
});

test('A revoked reference prevents completed receipt replay without a second request',async()=>{
 let allowed=true;const f=await fixture({resolveReferenceImages:referenceResolver(()=>{if(!allowed)throw Error('Native scope changed')})});
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'success'});allowed=false;
 expect(await (await f.restart()).execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:'Native scope changed'});
 expect(f.requests).toHaveLength(1);expect(f.saves).toHaveLength(1);
});

test('Changed reference identity or checksum cannot reuse a paid request ID',async()=>{
 let checksum=referenceChecksum;const f=await fixture({resolveReferenceImages:async()=>({images:[{bytes:png,mimeType:'image/png'}],references:[{...referenceReceipt,checksum}],assertCurrent:async()=>{}})});
 await f.manager.execute(f.host,call,referenceArgs);checksum='f'.repeat(64);
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:expect.stringContaining('different')});expect(f.requests).toHaveLength(1);
});

test('A reference revoked during provider auth prevents dispatch and cannot be retried implicitly',async()=>{
 let allowed=true;const f=await fixture({resolveReferenceImages:referenceResolver(()=>{if(!allowed)throw Error('Reference revoked during auth')})});
 const original=f.registry.requestAuth.bind(f.registry);f.registry.requestAuth=async(...params:any[])=>{const auth=await original(...params as Parameters<typeof original>);allowed=false;return auth};
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:'Reference revoked during auth'});
 expect(f.authProviders).toHaveLength(0);expect(f.saves).toHaveLength(0);allowed=true;
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});expect(f.requests).toHaveLength(1);
});

test('A reference revoked while generation is pending prevents saving and a duplicate charge',async()=>{
 const gate=deferred(),entered=deferred();let allowed=true;
 const f=await fixture({resolveReferenceImages:referenceResolver(()=>{if(!allowed)throw Error('Reference scope changed')}),generate:async request=>{entered.resolve();await gate.promise;return generated(request)}});
 const pending=f.manager.execute(f.host,call,referenceArgs);await entered.promise;allowed=false;gate.resolve();
 expect(await pending).toMatchObject({status:'error',error:'Reference scope changed'});expect(f.saves).toHaveLength(0);allowed=true;
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:expect.stringContaining('not been sent again')});expect(f.requests).toHaveLength(1);
});

test('Subscription selection rejects reference images before resolving files or subscription auth',async()=>{
 let resolutions=0;const f=await fixture({subscription:true,resolveReferenceImages:async(...input)=>{resolutions++;return referenceResolver()(...input)}});selectSubscription(f);
 expect(f.manager.toolDefinition()?.input_schema.properties).not.toHaveProperty('reference_image_version_ids');
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:expect.stringContaining('API image connection')});
 expect(resolutions).toBe(0);expect(f.authPurposes).toHaveLength(0);expect(f.requests).toHaveLength(0);
});

test('Official OpenAI image generation hides reference inputs and rejects them before native resolution or auth while text generation works',async()=>{
 let resolutions=0,authCalls=0;
 const f=await fixture({referenceConnection:false,resolveReferenceImages:async()=>{resolutions++;throw Error('The unsupported route must not resolve references')}});
 const original=f.registry.requestAuth.bind(f.registry);f.registry.requestAuth=async(...params:Parameters<typeof original>)=>{authCalls++;return original(...params)};
 expect(f.manager.toolDefinition()?.input_schema.properties).not.toHaveProperty('reference_image_version_ids');
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:expect.stringContaining('compatible API image connection')});
 expect(resolutions).toBe(0);expect(authCalls).toBe(0);expect(f.requests).toHaveLength(0);expect(f.saves).toHaveLength(0);
 expect(await f.manager.execute(f.host,call,args)).toMatchObject({status:'success',result:{provider:'openai',route:'images',billing:'api'}});
 expect(resolutions).toBe(0);expect(authCalls).toBe(1);expect(f.requests).toHaveLength(1);expect(f.requests[0]).not.toHaveProperty('referenceImages');expect(f.saves).toHaveLength(1);
});

test('Shutdown cancels reference authorization before a job or credential can be created',async()=>{
 const entered=deferred();
 const f=await fixture({resolveReferenceImages:async(_host,{signal})=>{entered.resolve();await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true}));signal!.throwIfAborted();throw Error('unreachable')}});
 const pending=f.manager.execute(f.host,call,referenceArgs);await entered.promise;await f.manager.close();
 expect(await pending).toMatchObject({status:'error',error:expect.stringContaining('cancelled')});expect(f.requests).toHaveLength(0);expect(f.authProviders).toHaveLength(0);
});


test('The final synchronous auth guard rechecks native references and retains the credential guard',async()=>{
 let nativeCurrent=true,nativeChecks=0,credentialChecks=0;
 const f=await fixture({resolveReferenceImages:async()=>({...await referenceResolver()(f.host,{versionIds:[referenceVersion]}),assertDispatchCurrent:()=>{nativeChecks++;if(!nativeCurrent)throw Error('Native scope changed before fetch')}})});
 const original=f.registry.requestAuth.bind(f.registry);
 f.registry.requestAuth=async(...params:any[])=>({...await original(...params as Parameters<typeof original>),assertCurrent:()=>{credentialChecks++;nativeCurrent=false}});
 expect(await f.manager.execute(f.host,call,referenceArgs)).toMatchObject({status:'error',error:'Native scope changed before fetch'});
 expect(credentialChecks).toBe(1);expect(nativeChecks).toBe(1);expect(f.authProviders).toHaveLength(0);expect(f.saves).toHaveLength(0);
});
