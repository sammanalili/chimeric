import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {UsageManager} from '../src/usage-manager';
import {declaredPricing,publishedPricing,tokenCost,type TokenPricing} from '../src/model-pricing';
import {installUsageHttp} from '../src/usage-http';
import {Registry} from '../src/registry';

const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.reverse())fn();cleanup.length=0});
const inputUsage={input:1000,output:100,cacheRead:0,cacheWrite:0};
const manual={currency:'USD' as const,inputPerMillion:3,outputPerMillion:15,cacheReadPerMillion:0.3,cacheWritePerMillion:4};
function fixture(){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-usage-test-'));cleanup.push(()=>rmSync(profile,{recursive:true,force:true}));mkdirSync(join(profile,'local-auth'),{mode:0o700});
 const state={now:1_800_000_000_000,key:'synthetic-provider-private-key',session:'synthetic-private-session-A',googleSession:'synthetic-google-session',connected:true,generation:1,changes:0};
 const providers:any={
  api:{name:'Official API',baseUrl:'https://api.openai.com/v1',api:'openai-responses',revision:'revision-1',enabled:true},
  reseller:{name:'Reseller',baseUrl:'https://reseller.example/v1',api:'openai-responses',revision:'revision-1',enabled:true},
  unknown:{name:'Unknown API',baseUrl:'https://unknown.example/v1',api:'openai-completions',revision:'revision-1',enabled:true},
  codex:{name:'ChatGPT',baseUrl:'https://chatgpt.com/backend-api',api:'openai-codex-responses',revision:'revision-1',enabled:true},
  google:{name:'Google direct',baseUrl:'https://google-subscription.local.invalid',api:'antigravity-http',revision:'revision-1',enabled:true},
  cli:{name:'Google CLI',baseUrl:'https://google-cli.local.invalid',api:'antigravity-cli',revision:'revision-1',enabled:true},
  claude:{name:'Official client',baseUrl:'https://claude-code.local.invalid',api:'claude-code',revision:'revision-1',enabled:true},
 };
 const models=new Map<string,any>();
 for(const [provider,p] of Object.entries(providers) as any){
  const id=['api','reseller','codex'].includes(provider)?'gpt-6.1-sol':'synthetic-model';
  const qualifiedId=provider+'::'+id;models.set(qualifiedId,{id,qualifiedId,provider,name:id,api:p.api,baseUrl:p.baseUrl,pricing:null});
 }
 const registry:any={profileDir:profile,config:{providers},models,statuses:Object.fromEntries(Object.keys(providers).map(id=>[id,{ready:true}])),
  currentSelection:()=>({model:'api::gpt-6.1-sol'}),getPrivateCredential:()=>state.key,
  subscription:{vault:{read:()=>({session:state.session})},status:()=>({connected:state.connected})},
  antigravityHttp:{auth:{vault:{read:()=>({session:state.googleSession})}},available:()=>state.connected},
  antigravity:{connectionGeneration:()=>state.generation,available:()=>state.connected},
  claudeCode:{connectionGeneration:()=>state.generation,available:()=>state.connected}};
 const options={now:()=>state.now,changed:()=>{++state.changes}},manager=new UsageManager(registry,options);
 const model=(provider:string)=>[...models.values()].find(model=>model.provider===provider)!;
 const row=(provider:string,source=manager)=>source.snapshot().connections.find(connection=>connection.id===provider)!;
 return {profile,state,registry,options,manager,model,row};
}
function setPrice(f:ReturnType<typeof fixture>,provider='reseller',pricing:typeof manual|null=manual,expectedRevision=f.manager.snapshot().revision){return f.manager.configure({expectedRevision,model:f.model(provider).qualifiedId,pricing})}
function record(f:ReturnType<typeof fixture>,provider:string,id:string,usage:any=inputUsage){const model=f.model(provider);f.manager.record(model,usage,id,f.manager.captureBinding(provider))}
function headers(f:ReturnType<typeof fixture>,changes:Record<string,string>={}){return new Headers({'x-codex-primary-used-percent':'42.5','x-codex-primary-window-minutes':'300','x-codex-primary-reset-at':String(f.state.now/1000+3600),'x-codex-secondary-used-percent':'7','x-codex-secondary-window-minutes':'10080',...changes})}

test('published prices match only exact official model, transport, and normalized origin',()=>{
 const sol={id:'gpt-6.1-sol',api:'openai-responses',baseUrl:'https://api.openai.com/v1'};
 expect(publishedPricing(sol)).toMatchObject({currency:'USD',source:'published',inputPerMillion:2,outputPerMillion:10});
 expect(publishedPricing({...sol,baseUrl:'https://api.openai.com:443/v1/'})).not.toBeNull();
 for(const baseUrl of ['http://api.openai.com/v1','https://reseller.example/v1','https://api.openai.com.evil.test/v1','https://api.openai.com:8443/v1','https://api.openai.com/proxy/v1','https://api.openai.com/v1?key=synthetic','https://user:synthetic@api.openai.com/v1','https://api.openai.com/v1#fragment'])expect(publishedPricing({...sol,baseUrl})).toBeNull();
 for(const api of ['openai-codex-responses','claude-code','antigravity-http'])expect(publishedPricing({...sol,api})).toBeNull();
 expect(publishedPricing({...sol,id:'unreviewed-sol-suffix'})).toBeNull();
 expect(publishedPricing({id:'claude-fable-5-2',api:'anthropic-messages',baseUrl:'https://api.anthropic.com'})).toMatchObject({inputPerMillion:8,outputPerMillion:40,source:'published'});
 expect(publishedPricing({id:'claude-fable-5-2',api:'anthropic-messages',baseUrl:'https://reseller.example'})).toBeNull();
});
test('provider prices need explicit token units and valid finite rates',()=>{
 expect(declaredPricing({pricing:{currency:'USD',unit:'per_million_tokens',input:0,output:5,cacheRead:0.1,cacheWrite:1}})).toMatchObject({inputPerMillion:0,outputPerMillion:5,cacheReadPerMillion:0.1,cacheWritePerMillion:1,source:'provider'});
 expect(declaredPricing({model_info:{input_cost_per_token:0.000002,output_cost_per_token:0.00001}})).toMatchObject({inputPerMillion:2,outputPerMillion:10,source:'provider'});
 for(const pricing of [{currency:'USD',input:2,output:10},{currency:'JPY',unit:'per_million_tokens',input:2,output:10},{currency:'USD',unit:'per_token',input:2,output:10},{currency:'USD',unit:'per_million_tokens',input:-1,output:10},{currency:'USD',unit:'per_million_tokens',input:Infinity,output:10},{currency:'USD',unit:'per_million_tokens',input:2,output:NaN}])expect(declaredPricing({pricing})).toBeNull();
 expect(declaredPricing({input:2,output:10})).toBeNull();expect(declaredPricing(undefined)).toBeNull();
});
test('the actual registry carries declared pricing into accounting without contacting a model endpoint',async()=>{
 const f=fixture();
 const registry=new Registry({envFile:join(f.profile,'missing-env'),credentialRefsFile:join(f.profile,'missing-references'),modelMetadataFile:join(f.profile,'missing-metadata'),providers:{local:{name:'Static configured catalog',baseUrl:'https://configured.example/v1',models:[
  {id:'priced',pricing:{currency:'USD',unit:'per_million_tokens',input:1,output:4}},
  {id:'units-not-declared',pricing:{input:1,output:4}},
 ]}},defaultModel:'local::priced'},f.profile);
 await registry.refresh(false);const manager=new UsageManager(registry,f.options),model=registry.models.get('local::priced')!;
 expect(manager.pricing(model)).toMatchObject({inputPerMillion:1,outputPerMillion:4,source:'provider'});
 expect(manager.pricing(registry.models.get('local::units-not-declared')!)).toBeNull();
 manager.record(model,inputUsage,'synthetic-registry-request',manager.captureBinding('local'));
 expect(manager.snapshot().connections[0].tracked.estimatedUsd).toBeCloseTo(0.0014,10);
});
test('unknown cache rates and unknown model prices remain unpriced, while explicit zero is allowed',()=>{
 const price:TokenPricing={currency:'USD',inputPerMillion:2,outputPerMillion:10,source:'manual'};
 expect(tokenCost(inputUsage,null)).toBeNull();expect(tokenCost({...inputUsage,cacheRead:1},price)).toBeNull();expect(tokenCost({...inputUsage,cacheWrite:1},price)).toBeNull();
 expect(tokenCost({...inputUsage,input:NaN},price)).toBeNull();expect(tokenCost({...inputUsage,output:1.5},price)).toBeNull();expect(tokenCost({...inputUsage,input:-1},price)).toBeNull();
 expect(tokenCost(inputUsage,{...price,inputPerMillion:0,outputPerMillion:0})).toBe(0);
});
test('cache accounting and long-context surcharge use the full input boundary but not output tokens',()=>{
 const price:TokenPricing={...manual,source:'manual',inputPerMillion:4,outputPerMillion:20,cacheReadPerMillion:1,cacheWritePerMillion:5,longContext:{aboveTokens:100000,inputMultiplier:2,outputMultiplier:1.5}};
 expect(tokenCost({input:80000,output:2000,cacheRead:10000,cacheWrite:10000},price)).toBeCloseTo(0.42,10);
 expect(tokenCost({input:80001,output:2000,cacheRead:10000,cacheWrite:10000},price)).toBeCloseTo(0.820008,10);
 expect(tokenCost({input:0,output:1000000,cacheRead:0,cacheWrite:0},price)).toBe(20);
});
test('API price sources stay separate from resellers and every subscription stays outside API billing',()=>{
 const f=fixture();expect(f.manager.pricing(f.model('api'))?.source).toBe('published');expect(f.manager.pricing(f.model('reseller'))).toBeNull();
 for(const provider of ['codex','google','cli','claude']){
  f.model(provider).pricing={...manual,source:'provider'};expect(f.manager.pricing(f.model(provider))).toBeNull();
  expect(()=>setPrice(f,provider)).toThrow('API model');record(f,provider,'subscription-'+provider);
  expect(f.row(provider).tracked).toMatchObject({requests:1,input:1000,estimatedUsd:null});
 }
});
test('manual rates use revision checks, persist exact USD units, and can be cleared',()=>{
 const f=fixture();setPrice(f);expect(f.manager.pricing(f.model('reseller'))).toEqual({...manual,source:'manual'});
 expect(()=>setPrice(f,'reseller',manual,0)).toThrow('another window');expect(f.manager.snapshot().revision).toBe(1);
 for(const pricing of [{...manual,currency:'JPY'},{...manual,inputPerMillion:-1},{...manual,outputPerMillion:Infinity},{...manual,apiKey:'synthetic-private'}])expect(()=>f.manager.configure({expectedRevision:1,model:f.model('reseller').qualifiedId,pricing})).toThrow();
 const reloaded=new UsageManager(f.registry,f.options);expect(reloaded.pricing(f.model('reseller'))).toEqual({...manual,source:'manual'});
 setPrice(f,'reseller',null);expect(f.manager.pricing(f.model('reseller'))).toBeNull();expect(f.manager.snapshot().revision).toBe(2);
});
test('usage persists once per bound model request and serialization contains no keys, sessions, or request IDs',()=>{
 const f=fixture(),id='synthetic-private-request-id';setPrice(f);record(f,'reseller',id);record(f,'reseller',id);
 expect(f.row('reseller').tracked).toMatchObject({requests:1,input:1000,output:100,estimatedUsd:0.0045,unpricedRequests:0});
 const reloaded=new UsageManager(f.registry,f.options);reloaded.record(f.model('reseller'),inputUsage,id,reloaded.captureBinding('reseller'));expect(f.row('reseller',reloaded).tracked.requests).toBe(1);
 const persisted=readFileSync(join(f.profile,'usage.json'),'utf8'),snapshot=JSON.stringify(reloaded.snapshot());
 for(const sensitive of [f.state.key,f.state.session,f.state.googleSession,id]){expect(persisted).not.toContain(sensitive);expect(snapshot).not.toContain(sensitive)}
 expect(JSON.parse(persisted).receipts[0]).toMatch(/^[a-f0-9]{64}$/);expect(statSync(join(f.profile,'local-auth/usage.key')).mode&0o777).toBe(0o600);
});
test('unknown pricing never appears as free after usage and malformed token values are ignored',()=>{
 const f=fixture();record(f,'unknown','unknown-price');expect(f.row('unknown').tracked).toMatchObject({requests:1,unpricedRequests:1,estimatedUsd:null});
 for(const usage of [{input:-1,output:1},{input:Infinity,output:1},{input:1.5,output:1},{input:1,output:NaN},{input:1,output:1,cacheRead:-1}])record(f,'unknown','invalid-'+String(usage.input)+String(usage.cacheRead),usage);
 expect(f.row('unknown').tracked.requests).toBe(1);
});
test('account, key, endpoint, and provider revision changes reject in-flight old usage and isolate totals',()=>{
 const f=fixture();for(const [provider,change] of [['codex',()=>{f.state.session='synthetic-private-session-B'}],['reseller',()=>{f.state.key='synthetic-private-key-B'}],['api',()=>{f.registry.config.providers.api.baseUrl='https://changed.example/v1'}],['unknown',()=>{f.registry.config.providers.unknown.revision='revision-2'}]] as const){
  const old=f.manager.captureBinding(provider);record(f,provider,'first-'+provider);change();
  f.manager.record(f.model(provider),inputUsage,'old-in-flight-'+provider,old);expect(f.row(provider).tracked.requests).toBe(0);
  record(f,provider,'new-'+provider);expect(f.row(provider).tracked.requests).toBe(1);
 }
});
test('Codex quota headers are passive, account-bound, fresh only before expiry/reset, and never persisted',()=>{
 const f=fixture(),model=f.model('codex'),binding=f.manager.captureBinding('codex');
 expect(f.row('codex').quota).toEqual({status:'unavailable',windows:[]});f.manager.observeHeaders(model,headers(f),binding);
 expect(f.row('codex').quota).toMatchObject({status:'available',windows:[{usedPercent:42.5,windowMinutes:300,resetAt:f.state.now+3600000},{usedPercent:7,windowMinutes:10080}],source:'Provider response headers'});
 f.state.now+=300001;expect(f.row('codex').quota.status).toBe('stale');
 f.manager.observeHeaders(model,headers(f,{'x-codex-primary-reset-at':String(Math.floor(f.state.now/1000)-1)}),binding);expect(f.row('codex').quota.status).toBe('stale');
 f.state.session='synthetic-other-account';expect(f.row('codex').quota.status).toBe('unavailable');f.manager.observeHeaders(model,headers(f),binding);expect(f.row('codex').quota.status).toBe('unavailable');
 f.manager.observeHeaders(model,headers(f),f.manager.captureBinding('codex'));expect(f.row('codex').quota.status).toBe('available');f.state.connected=false;expect(f.row('codex').quota.status).toBe('unavailable');
 const reloaded=new UsageManager(f.registry,f.options);expect(f.row('codex',reloaded).quota.status).toBe('unavailable');
});
test('invalid percentages are ignored and malformed optional quota fields are never fabricated',()=>{
 const f=fixture(),model=f.model('codex'),binding=f.manager.captureBinding('codex');
 for(const value of ['', ' ', '-1','101','Infinity','NaN','invalid','0x10'])f.manager.observeHeaders(model,new Headers({'x-codex-primary-used-percent':value}),binding);
 expect(f.row('codex').quota.status).toBe('unavailable');
 f.manager.observeHeaders(model,new Headers({'x-codex-primary-used-percent':'0','x-codex-primary-window-minutes':'2.5','x-codex-primary-reset-at':'not-a-time'}),binding);
 expect(f.row('codex').quota.windows).toEqual([{label:'Primary limit',usedPercent:0}]);
 f.manager.observeHeaders(f.model('api'),headers(f),f.manager.captureBinding('api'));expect(f.row('api').quota.status).toBe('unavailable');
});
test('a local clock rollback marks earlier quota observations stale rather than extending their freshness',()=>{
 const f=fixture(),model=f.model('codex');f.manager.observeHeaders(model,headers(f),f.manager.captureBinding('codex'));f.state.now-=60000;expect(f.row('codex').quota.status).toBe('stale');
});
test('a malformed optional usage store stays recoverable and cannot interrupt or overwrite research accounting',()=>{
 const f=fixture(),path=join(f.profile,'usage.json'),bytes='{malformed-synthetic-usage';writeFileSync(path,bytes);
 const broken=new UsageManager(f.registry,f.options);expect(broken.snapshot().warning).toContain('could not be read');
 expect(()=>broken.record(f.model('api'),inputUsage,'synthetic-recovery-request',broken.captureBinding('api'))).not.toThrow();expect(readFileSync(path,'utf8')).toBe(bytes);
 try{broken.configure({expectedRevision:0,model:f.model('api').qualifiedId,pricing:manual});throw Error('Expected unavailable accounting')}catch(error){expect((error as any).status).toBe(503)}
 expect(readFileSync(path,'utf8')).toBe(bytes);
});
test('a broken optional usage key reports unavailable without replacing the key or blocking app construction',()=>{
 const f=fixture(),path=join(f.profile,'local-auth/usage.key'),bytes='malformed-synthetic-key';writeFileSync(path,bytes);
 let broken!:UsageManager;expect(()=>{broken=new UsageManager(f.registry,f.options)}).not.toThrow();expect(broken.snapshot().warning).toBeTruthy();
 expect(()=>broken.record(f.model('api'),inputUsage,'synthetic-request',broken.captureBinding('api'))).not.toThrow();expect(readFileSync(path,'utf8')).toBe(bytes);
 try{broken.configure({expectedRevision:0,model:f.model('api').qualifiedId,pricing:manual});throw Error('Expected unavailable accounting')}catch(error){expect((error as any).status).toBe(503)}
});
function httpFixture(manager:UsageManager){
 const routes=new Map<string,Function>(),app={get:(path:string,handler:Function)=>routes.set('GET '+path,handler),put:(path:string,handler:Function)=>routes.set('PUT '+path,handler)};installUsageHttp(app,manager,'test-module');
 const call=async(method:string,path:string,body?:unknown)=>{const headers:Record<string,string>={};let code=200;const reply:any={header:(name:string,value:string)=>{headers[name]=value;return reply},code:(value:number)=>{code=value;return reply},send:(value:unknown)=>value,type:()=>reply};const value=await routes.get(method+' '+path)!({body},reply);return {code,headers,value}};
 return {routes,call};
}
test('usage HTTP remains read/settings-only and returns noncacheable safe snapshots',async()=>{
 const f=fixture(),http=httpFixture(f.manager);expect([...http.routes.keys()].sort()).toEqual(['GET /api/local/usage','GET /api/local/usage/component.js','PUT /api/local/usage/pricing']);
 const result=await http.call('GET','/api/local/usage');expect(result.code).toBe(200);expect(result.headers['cache-control']).toBe('no-store');expect(JSON.stringify(result.value)).not.toContain(f.state.key);expect(JSON.stringify(result.value)).not.toContain(f.state.session);
});
test('pricing HTTP rejects stale revisions, subscription prices, and malformed fields without echoing request secrets',async()=>{
 const f=fixture(),http=httpFixture(f.manager),request=(model:string,pricing:any=manual,expectedRevision=0)=>http.call('PUT','/api/local/usage/pricing',{expectedRevision,model:f.model(model).qualifiedId,pricing});
 expect((await request('reseller')).code).toBe(200);expect((await request('reseller')).code).toBe(409);expect((await request('codex',manual,1)).code).toBe(400);
 const invalid=await request('reseller',{...manual,privateValue:'synthetic-private-request-secret'},1);expect(invalid.code).toBe(400);expect(invalid.headers['cache-control']).toBe('no-store');expect(JSON.stringify(invalid.value)).not.toContain('synthetic-private-request-secret');
});
