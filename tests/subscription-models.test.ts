import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SubscriptionManager,SubscriptionVault} from '../src/subscription';
import {parseSubscriptionModels,SubscriptionModels} from '../src/subscription-models';
import {Registry,defaultConfiguration} from '../src/registry';
import {ProviderManager} from '../src/provider-manager';
import {makeCatalog} from '../src/catalog';

const credential={type:'oauth' as const,access:'header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic-account'}})).toString('base64url')+'.signature',refresh:'synthetic-refresh',expires:Date.now()+3600000};
const entry=(slug='other-model',extra:any={})=>({slug,display_name:'Discovered '+slug,visibility:'list',input_modalities:['text','image'],supported_reasoning_levels:[{effort:'low'},{effort:'medium'}],default_reasoning_level:'low',context_window:200000,...extra});
const catalog=(...models:any[])=>({models});
const wait=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await Bun.sleep(5);expect(check()).toBe(true)};
function fixture(fetcher?:typeof fetch){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-subscription-models-')),vault=new SubscriptionVault(join(dir,'local-auth'));vault.write({session:'session-one',version:'version-one',credential});
 let manager:ProviderManager;const requests:any[]=[];
 const subscription=new SubscriptionManager(vault,{catalogEndpoint:'https://chatgpt.com/backend-api/codex/models?client_version=fixture',fetch:fetcher??(async(input,init)=>{requests.push({url:String(input),method:init?.method,headers:new Headers(init?.headers),redirect:init?.redirect});return Response.json(catalog(entry()))}),onModelsChanged:()=>manager?.refreshSubscriptions()});
 const registry=new Registry(defaultConfiguration,dir);registry.subscription=subscription;manager=new ProviderManager(registry);
 return{dir,vault,subscription,registry,manager,requests,async close(){await manager.close();subscription.close();rmSync(dir,{recursive:true,force:true})}};
}

test('account catalog parsing keeps supported visible models, metadata and server ordering only',()=>{
 const parsed=parseSubscriptionModels(catalog(entry('new-first',{base_instructions:'UNTRUSTED_REMOTE_INSTRUCTIONS'}),entry('hidden',{visibility:'hide'}),entry('audio',{input_modalities:['audio']}),entry('second',{supported_reasoning_levels:[{effort:'high'},{effort:'unsupported'}],default_reasoning_level:'high'})));
 expect(parsed.map(m=>m.id)).toEqual(['new-first','second']);expect(parsed[0].input).toEqual(['text','image']);expect(parsed[0].contextWindow).toBe(200000);expect(parsed[0].defaultReasoningEffort).toBe('low');expect(parsed[1].reasoningEfforts).toEqual({high:'high'});expect(JSON.stringify(parsed)).not.toContain('UNTRUSTED');
 expect(()=>parseSubscriptionModels({data:[entry()]})).toThrow('invalid model catalog');expect(()=>parseSubscriptionModels(catalog(entry('x'),entry('x')))).toThrow('duplicate');expect(()=>parseSubscriptionModels(catalog(entry('bad\nmodel')))).toThrow('identifier');
});

test('discovery uses the selected account and updates every picker and role consumer without config changes',async()=>{
 const f=fixture();try{
  await f.registry.refresh(false);const revision=f.registry.revision;let notifications=0;f.manager.subscribe(()=>notifications++);
  await f.subscription.discoverModels();expect(f.requests).toHaveLength(1);expect(f.requests[0].method).toBe('GET');expect(f.requests[0].headers.get('authorization')).toBe('Bearer '+credential.access);expect(f.requests[0].headers.get('chatgpt-account-id')).toBe('synthetic-account');expect(f.requests[0].redirect).toBe('error');
  const model=f.registry.resolve('openai-codex::other-model');expect(model.input).toContain('image');expect(model.efforts).toEqual(['low','medium']);expect(model.defaultReasoningEffort).toBe('low');
  const selector=makeCatalog(f.registry).model_selector.catalog.models.find(m=>m.id===model.qualifiedId)!;expect(selector.disabled).toBe(false);expect(selector.thinking!.effort_options.find(e=>e.recommended)!.id).toBe('low');expect(f.manager.snapshot().connections[0].models.some(m=>m.id==='other-model')).toBe(true);expect(f.registry.revision).toBe(revision);expect(notifications).toBeGreaterThan(0);
  expect(f.registry.state.model).toBe(defaultConfiguration.defaultModel);expect(f.registry.resolve(defaultConfiguration.defaultModel).subscriptionAvailable).toBe(false);
  f.registry.select(model.qualifiedId,'low');expect(f.registry.state.model).toBe(model.qualifiedId);
  expect(JSON.stringify(f.subscription.status())).not.toContain(credential.access);expect(readFileSync(join(f.dir,'local-auth/chatgpt-models.json'),'utf8')).not.toContain(credential.refresh);expect(statSync(join(f.dir,'local-auth/chatgpt-models.json')).mode&0o777).toBe(0o600);
 }finally{await f.close()}
});

test('refresh failure retains same-account models and account changes invalidate persisted metadata',async()=>{
 let fail=false;const f=fixture(async()=>fail?new Response('private provider diagnostic',{status:429}):Response.json(catalog(entry())));
 try{await f.subscription.discoverModels();fail=true;await f.subscription.discoverModels();expect(f.subscription.status().modelDiscovery.state).toBe('error');expect(f.subscription.status().modelDiscovery.count).toBe(1);expect(f.registry.models.has('openai-codex::other-model')).toBe(true);expect(JSON.stringify(f.subscription.status())).not.toContain('private provider');
  const restored=new SubscriptionModels({path:join(f.dir,'local-auth/chatgpt-models.json'),session:()=>f.vault.read()?.session,fetch:async()=>{throw Error('must not fetch')},onChange:()=>{}});expect(restored.current()?.models[0].id).toBe('other-model');await restored.refresh(false);restored.close();
  f.vault.write({session:'session-two',version:'version-two',credential});expect(f.subscription.modelCatalog.current()).toBeUndefined();await f.manager.refreshSubscriptions();expect(f.registry.models.has('openai-codex::other-model')).toBe(false);
 }finally{await f.close()}
});

test('token renewal keeps catalog identity while disconnect prevents late responses from recreating a cache',async()=>{
 let release!:(r:Response)=>void,held=false;const f=fixture(async()=>held?new Promise<Response>(resolve=>release=resolve):Response.json(catalog(entry())));
 try{await f.subscription.discoverModels();f.vault.write({session:'session-one',version:'renewed-version',credential:{...credential,access:credential.access+'-renewed'}});expect(f.subscription.modelCatalog.current()?.models).toHaveLength(1);
  held=true;const first=f.subscription.discoverModels(),second=f.subscription.discoverModels();await wait(()=>!!release);f.subscription.disconnect();release(Response.json(catalog(entry('late-model'))));await Promise.all([first,second]);expect(f.subscription.status().connected).toBe(false);expect(f.subscription.status().modelDiscovery.count).toBe(0);expect(existsSync(join(f.dir,'local-auth/chatgpt-models.json'))).toBe(false);
 }finally{await f.close()}
});

test('catalog requests cannot follow redirects or reuse the catalog credential for inference or arbitrary URLs',async()=>{
 let leaked=false;const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){if(new URL(request.url).pathname==='/models')return new Response(null,{status:307,headers:{location:'/capture'}});leaked=true;return Response.json(catalog(entry()))}});
 const dir=mkdtempSync(join(tmpdir(),'chimeric-catalog-redirect-')),vault=new SubscriptionVault(join(dir,'auth'));vault.write({session:'fixture',version:'one',credential});const manager=new SubscriptionManager(vault,{catalogEndpoint:server.url.href+'models'});
 try{await manager.discoverModels();expect(manager.status().modelDiscovery.state).toBe('error');expect(leaked).toBe(false);const auth=await manager.requestAuth(undefined,'models');await expect(auth.fetch(server.url.href+'models',{method:'POST'})).rejects.toThrow('configured');await expect(auth.fetch('https://example.com/models')).rejects.toThrow('configured');const inference=await manager.requestAuth();await expect(inference.fetch(server.url.href+'models')).rejects.toThrow('configured')}
 finally{manager.close();server.stop(true);rmSync(dir,{recursive:true,force:true})}
});

test('malformed, oversized and stalled responses remain bounded and never replace a valid catalog',async()=>{
 let mode='valid';const dir=mkdtempSync(join(tmpdir(),'chimeric-model-bounds-'));
 const models=new SubscriptionModels({path:join(dir,'models.json'),session:()=> 'fixture',timeoutMs:30,onChange:()=>{},fetch:async()=>mode==='valid'?Response.json(catalog(entry())):mode==='malformed'?Response.json({data:[]}):mode==='oversized'?new Response('x',{headers:{'content-length':'9999999'}}):new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'))}}))});
 try{await models.refresh();for(const value of ['malformed','oversized','stalled']){mode=value;const started=Date.now();await models.refresh();expect(Date.now()-started).toBeLessThan(2000);expect(models.current()?.models[0].id).toBe('other-model');expect(models.status().state).toBe('error')}}finally{models.close();rmSync(dir,{recursive:true,force:true})}
});

test('runtime-enabled automatic discovery runs after a successful sign-in',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-model-auto-')),vault=new SubscriptionVault(join(dir,'auth'));let fetched=0;
 const manager=new SubscriptionManager(vault,{autoDiscover:true,callbackAvailable:async()=>true,oauth:{login:async()=>credential},fetch:async()=>{fetched++;return Response.json(catalog(entry('after-sign-in')))}});
 try{await manager.start();await wait(()=>manager.status().modelDiscovery.state==='ready');expect(fetched).toBe(1);expect(manager.modelCatalog.current()?.models[0].id).toBe('after-sign-in')}
 finally{manager.close();rmSync(dir,{recursive:true,force:true})}
});

test('a catalog 401 renews through the existing credential flow and retries the same account',async()=>{
 let calls=0,renewals=0;const f=fixture(async(input,init)=>{
  if(String(input).endsWith('/oauth/token')){renewals++;expect(init?.redirect).toBe('error');return Response.json({access_token:credential.access+'-renewed',refresh_token:'renewed-refresh',expires_in:3600})}
  calls++;if(calls===1)return new Response('',{status:401});expect(new Headers(init?.headers).get('authorization')).toBe('Bearer '+credential.access+'-renewed');return Response.json(catalog(entry()));
 });
 try{await f.subscription.discoverModels();expect(calls).toBe(2);expect(renewals).toBe(1);expect(f.subscription.status().modelDiscovery.state).toBe('ready');expect(f.vault.read()!.session).toBe('session-one');expect(f.subscription.modelCatalog.current()?.models).toHaveLength(1)}finally{await f.close()}
});

test('a selector-update failure clears refreshing state and a retry recovers',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-catalog-callback-'));let fail=true;
 const models=new SubscriptionModels({path:join(dir,'models.json'),session:()=> 'fixture',fetch:async()=>Response.json(catalog(entry())),onChange:()=>{if(fail)throw Error('synthetic selector update failure')}});
 try{await expect(models.refresh()).rejects.toThrow('selector update');expect(models.status().state).toBe('error');fail=false;await models.refresh();expect(models.status().state).toBe('ready')}finally{models.close();rmSync(dir,{recursive:true,force:true})}
});
