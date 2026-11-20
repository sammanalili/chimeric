import {describe,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,chmodSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
 AntigravityHttpAuth,AntigravityHttpError,AntigravityHttpVault,importDesktopSession,
 ANTIGRAVITY_INFERENCE_URL,ANTIGRAVITY_CONTROL_URL,
} from '../src/antigravity-http-auth';
import {normalizeAntigravityHttpCatalog,AntigravityHttpModels} from '../src/antigravity-http-models';

const temp=(prefix:string)=>mkdtempSync(join(tmpdir(),prefix));
const oauthClient={id:'test-client.invalid',secret:'fixture'};

describe('AntigravityHttpVault',()=>{
 test('round-trips a credential record and never stores it in plaintext',()=>{
  const dir=temp('agy-vault-');
  const vault=new AntigravityHttpVault(dir);
  const record={session:'s1',version:'v1',credential:{access:'access-token-abc',refresh:'refresh-token-def',expires:Date.now()+3_600_000},project:'aicode-consumers',email:'user@example.com'};
  vault.write(record);
  expect(vault.read()).toEqual(record);
  const onDisk=readFileSync(vault.path,'utf8');
  expect(onDisk.includes('access-token-abc')).toBe(false);
  expect(onDisk.includes('refresh-token-def')).toBe(false);
 });

 test('rejects a tampered record instead of trusting it',()=>{
  const dir=temp('agy-vault-');
  const vault=new AntigravityHttpVault(dir);
  vault.write({session:'s1',version:'v1',credential:{access:'a',refresh:'r',expires:Date.now()+1000}});
  const parsed=JSON.parse(readFileSync(vault.path,'utf8'));
  parsed.tag=Buffer.alloc(16).toString('base64');
  writeFileSync(vault.path,JSON.stringify(parsed));
  expect(()=>vault.read()).toThrow(AntigravityHttpError);
 });

 test('rejects an invalid credential shape',()=>{
  const dir=temp('agy-vault-');
  const vault=new AntigravityHttpVault(dir);
  expect(()=>vault.write({session:'s1',version:'v1',credential:{access:'',refresh:'r',expires:0}})).toThrow();
 });
});

describe('AntigravityHttpAuth status and import',()=>{
 test('starts disconnected and reports reauthRequired after a failed record',()=>{
  const dir=temp('agy-auth-');
  const auth=new AntigravityHttpAuth(dir);
  expect(auth.status().connected).toBe(false);
  expect(auth.status().reauthRequired).toBe(false);
  expect(auth.status().oauthConfigured).toBe(false);
  auth.disconnect();
  expect(auth.status().connected).toBe(false);
  auth.close();
 });

 test('imports a desktop session file with the documented shape',async()=>{
  const file=join(temp('agy-import-'),'jetski-standalone-oauth-token');
  writeFileSync(file,JSON.stringify({token:{access_token:'access',refresh_token:'refresh',expiry:'2030-01-01T00:00:00Z',expires_in:3599},auth_method:'consumer',id_token_email:'user@example.com'}),{mode:0o600});
  const credential=await importDesktopSession(file);
  expect(credential.access).toBe('access');
  expect(credential.refresh).toBe('refresh');
  expect(credential.expires).toBeGreaterThan(Date.now());
 });

 test('explains a missing desktop session instead of throwing a bare error',async()=>{
  await expect(importDesktopSession(join(temp('agy-import-'),'missing.json'))).rejects.toThrow(/No Antigravity desktop session/);
 });

 test('browser sign-in builds a PKCE authorization URL on the loopback callback',async()=>{
  const auth=new AntigravityHttpAuth(temp('agy-auth-'),{oauthClient});
  const status=await auth.start('browser');
  const url=status.login?.authorizationUrl;
  expect(url).toBeDefined();
  const parsed=new URL(url!);
  expect(parsed.origin+parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  expect(parsed.searchParams.get('code_challenge')!.length).toBeGreaterThan(20);
  expect(parsed.searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
  expect(parsed.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/cloud-platform');
  expect(parsed.searchParams.get('access_type')).toBe('offline');
  auth.cancel();
  auth.close();
 });

 test('browser sign-in fails closed without a local OAuth client registration',async()=>{
  const auth=new AntigravityHttpAuth(temp('agy-auth-'),{oauthClient:null});
  expect(auth.status().oauthConfigured).toBe(false);
  await expect(auth.start('browser')).rejects.toThrow(/not configured/);
  expect(auth.status().login).toBeUndefined();
  auth.close();
 });

 test('source does not embed a Google installed-app OAuth credential',()=>{
  const source=readFileSync(new URL('../src/antigravity-http-auth.ts',import.meta.url),'utf8');
  expect(source).not.toContain('GOC'+'SPX-');
  expect(source).not.toMatch(/\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com/i);
 });
});

describe('requestAuth',()=>{
 test('refuses when signed out and strips credentials from unrelated hosts',async()=>{
  const dir=temp('agy-auth-');
  const auth=new AntigravityHttpAuth(dir);
  await expect(auth.requestAuth()).rejects.toThrow(/Connect Antigravity/);
  const vault=new AntigravityHttpVault(dir);
  vault.write({session:'s',version:'v',credential:{access:'secret-access',refresh:'secret-refresh',expires:Date.now()+3_600_000}});
  const bound=new AntigravityHttpAuth(dir);
  const auth2=await bound.requestAuth();
  expect(auth2.apiKey).toBe('secret-access');
  await expect(auth2.fetch('https://example.com/v1internal:streamGenerateContent',{method:'POST'})).rejects.toThrow(/only be sent to the Antigravity/);
  expect(bound.redact('token secret-access here')).toBe('token [redacted] here');
  bound.close();
 });

 test('renews an expired credential once before use',async()=>{
  const dir=temp('agy-auth-');
  const vault=new AntigravityHttpVault(dir);
  vault.write({session:'s',version:'v',credential:{access:'old',refresh:'refresh-1',expires:Date.now()-1000}});
  const calls:string[]=[];
  const fakeFetch=(async(input:any,init:any)=>{
   calls.push(String(input));
   expect(String(init?.body)).toContain('grant_type=refresh_token');
   return new Response(JSON.stringify({access_token:'new-access',refresh_token:'refresh-2',expires_in:3599}),{status:200,headers:{'content-type':'application/json'}});
  }) as typeof fetch;
  const auth=new AntigravityHttpAuth(dir,{fetch:fakeFetch,oauthClient});
  const bound=await auth.requestAuth();
  expect(bound.apiKey).toBe('new-access');
  expect(calls).toEqual(['https://oauth2.googleapis.com/token']);
  expect(vault.read()?.credential?.refresh).toBe('refresh-2');
  auth.close();
 });

 test('marks a rejected renewal as terminal and requires a new sign-in',async()=>{
  const dir=temp('agy-auth-');
  const vault=new AntigravityHttpVault(dir);
  vault.write({session:'s',version:'v',credential:{access:'old',refresh:'refresh-1',expires:Date.now()-1000}});
  const fakeFetch=(async()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'content-type':'application/json'}})) as unknown as typeof fetch;
  const auth=new AntigravityHttpAuth(dir,{fetch:fakeFetch,oauthClient});
  await expect(auth.requestAuth()).rejects.toThrow(/expired|reconnect/i);
  expect(vault.read()?.reauthRequired).toBe(true);
  auth.close();
 });

 test('an imported session remains usable but refuses renewal without local OAuth configuration',async()=>{
  const dir=temp('agy-auth-');
  const vault=new AntigravityHttpVault(dir);
  vault.write({session:'s',version:'v',credential:{access:'old',refresh:'refresh-1',expires:Date.now()-1000}});
  let reached=false;
  const auth=new AntigravityHttpAuth(dir,{oauthClient:null,fetch:(async()=>{reached=true;return new Response()}) as typeof fetch});
  await expect(auth.requestAuth()).rejects.toThrow(/official agy client/);
  expect(reached).toBe(false);
  expect(vault.read()?.reauthRequired).not.toBe(true);
  auth.close();
 });
});

describe('normalizeAntigravityHttpCatalog',()=>{
 const payload={models:{
  'gemini-4-argon-medium':{displayName:'Gemini 4 Argon (Medium)',supportsImages:true,supportsThinking:true,thinkingBudget:1024,maxTokens:1048576,maxOutputTokens:65536,recommended:true,apiProvider:'API_PROVIDER_GOOGLE_GEMINI'},
  'gemini-4-argon-low':{displayName:'Gemini 4 Argon (Low)',supportsImages:true,supportsThinking:true,maxTokens:1048576,maxOutputTokens:65536,recommended:true},
  'gpt-oss-120b-medium':{displayName:'GPT-OSS 120B (Medium)',supportsImages:false,supportsThinking:true,maxTokens:131072,maxOutputTokens:32768},
  'chat_23310':{isInternal:true,maxTokens:32768},
  'tab_jump_flash_lite_preview':{maxTokens:4096},
 }};
 test('drops internal entries, keeps image and thinking capability, and sorts variants',()=>{
  const models=normalizeAntigravityHttpCatalog(payload);
  expect(models.map(model=>model.id)).toEqual(['gemini-4-argon-low','gemini-4-argon-medium','gpt-oss-120b-medium']);
  expect(models.find(model=>model.id==='gemini-4-argon-medium')!.input).toEqual(['text','image']);
  expect(models.find(model=>model.id==='gpt-oss-120b-medium')!.input).toEqual(['text']);
  expect(models.find(model=>model.id==='gemini-4-argon-medium')!.maxTokens).toBe(65536);
  expect(models.every(model=>!model.id.includes('chat_')&&!model.id.includes('tab_'))).toBe(true);
 });

 test('normalize keeps unnamed internal entries out of the picker catalog',()=>{
  const models=normalizeAntigravityHttpCatalog({models:{'gemini-4-carbon-medium':{displayName:'Gemini 4 Carbon (Medium)',supportsImages:true,supportsThinking:true,maxTokens:1048576,maxOutputTokens:65536},...payload.models}});
  expect(models.some(model=>model.id==='tab_jump_flash_lite_preview')).toBe(false);
 });

 test('refresh merges probe-verified Carbon models and an advertised entry wins',async()=>{
  // Fake auth serving the real consumer catalog shape (no Carbon advertised).
  const advertised={models:{'gemini-4-argon-medium':{displayName:'Gemini 4 Argon (Medium)',supportsImages:true,supportsThinking:true,maxTokens:1048576,maxOutputTokens:65536}}};
  const catalogPayload=(extra:any=undefined)=>({models:{...advertised.models,...(extra??{})}});
  const makeAuth=(payload:any)=>({
   status:()=>({connected:true}),
   onChange:()=>()=>{},
   redact:(message:string)=>message,
   close:()=>{},
   cancel:()=>{},
   disconnect:()=>{},
   async requestAuth(){return {apiKey:'x',fetch:async()=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}})}},
   async profileInfo(){return {project:'aicode-consumers'}},
   vault:{read:()=>({session:'s',version:'v',credential:{access:'a',refresh:'r',expires:Date.now()+3_600_000}})},
  }) as any;
  // Without an advertised Carbon: the three live-verified variants are added.
  const withoutCarbon=new AntigravityHttpModels(temp('agy-profile-'),{auth:makeAuth(catalogPayload())});
  await withoutCarbon.refresh();
  const ids=withoutCarbon.catalog().map(model=>model.id);
  expect(ids.filter(id=>id.startsWith('gemini-4-carbon'))).toEqual(['gemini-4-carbon']);
  expect(withoutCarbon.catalog().find(model=>model.id==='gemini-4-carbon')!.input).toEqual(['text','image']);
  for(const effort of ['low','medium','high'])expect(withoutCarbon.resolveAlias('gemini-4-carbon-'+effort)).toEqual({id:'gemini-4-carbon',effort});
  // Once the service advertises Carbon itself, its entry replaces the supplement.
  const withCarbon=new AntigravityHttpModels(temp('agy-profile-'),{auth:makeAuth(catalogPayload({'gemini-4-carbon-medium':{displayName:'Gemini 4 Carbon (Medium, advertised)',supportsImages:true,supportsThinking:true,maxTokens:1048576,maxOutputTokens:32768}}))});
  await withCarbon.refresh();
  const advertisedEntry=withCarbon.catalog().find(model=>model.id==='gemini-4-carbon');
  expect(advertisedEntry!.name).toBe('Gemini 4 Carbon (advertised)');
  expect(advertisedEntry!.maxTokens).toBe(32768);
  // Only one entry per id, never a duplicate.
  expect(withCarbon.catalog().filter(model=>model.id==='gemini-4-carbon')).toHaveLength(1);
 });

 test('rejects a catalog without usable models',()=>{
  expect(()=>normalizeAntigravityHttpCatalog({models:{}})).toThrow(/no usable models/);
  expect(()=>normalizeAntigravityHttpCatalog({})).toThrow(/invalid model catalog/);
 });
});

describe('AntigravityHttpModels',()=>{
 test('reports disconnected state and refuses streaming until connected',()=>{
  const models=new AntigravityHttpModels(temp('agy-profile-'));
  expect(models.available()).toBe(false);
  expect(models.status().connected).toBe(false);
  expect(()=>models.stream({id:'m'},{} as any,{} as any)).toThrow(/Connect Antigravity/);
  expect(models.status().modelDiscovery.count).toBe(0);
 });

 test('refresh is rejected while signed out',async()=>{
  const models=new AntigravityHttpModels(temp('agy-profile-'));
  await expect(models.refresh()).rejects.toThrow(/Connect Antigravity/);
 });
});
