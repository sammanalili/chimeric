import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ClaudeCodeModels} from '../src/claude-code';
const inspect=()=>({executable:'/synthetic/claude',version:'2.1.321',signatureVerified:true});
function fixture(run:any=async()=>({code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'private-fixture@example.test',configDirectory:'/private/fixture'}),stderr:''})){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-cc-manager-')),records:any[]=[];
 const service=new ClaudeCodeModels(profile,{executable:'/synthetic/claude',inspect,run:async(...args:any[])=>{records.push(args);return run(...args)}});
 return {profile,service,records,close:async()=>{await service.close();rmSync(profile,{recursive:true,force:true})}};
}
test('connection is optional and model aliases appear only after official auth status succeeds',async()=>{
 const f=fixture();try{
  expect(f.service.status()).toMatchObject({enabled:false,ready:false,class2Supported:false,transport:'official-cli'});expect(f.service.catalog()).toEqual([]);expect(f.records).toHaveLength(0);
  const status=await f.service.action({action:'check'});expect(status).toMatchObject({ready:true,authState:'ready',operation:null});expect(status.models.map(model=>model.id)).toEqual(['default','opus','sonnet','haiku','claude-fable-5-2']);
  expect(status.models.find(model=>model.id==='claude-fable-5-2')).toMatchObject({contextWindow:1_000_000,maxTokens:128_000,availability:'unknown',verified:false});
  expect(status.models.every(model=>model.verified===false&&model.reasoningEffortsVerified===false)).toBe(true);
  expect(JSON.stringify(status)).not.toContain('private-fixture@example.test');expect(JSON.stringify(status)).not.toContain('/private/fixture');
  expect(f.records[0][1]).toEqual(['auth','status','--json']);
  const saved=readFileSync(join(f.profile,'local-auth/claude-code/connection.json'),'utf8');expect(saved).not.toContain('private-fixture');expect(JSON.parse(saved)).toEqual({version:1,enabled:true,executable:'/synthetic/claude'});
 }finally{await f.close()}
});
test('refresh rechecks official auth and disconnect never logs the user out of the CLI',async()=>{
 const f=fixture();try{await f.service.action({action:'connect'});await f.service.action({action:'refresh'});await f.service.action({action:'disconnect'});expect(f.service.available()).toBe(false);expect(f.service.catalog()).toEqual([]);expect(f.records).toHaveLength(2);expect(f.records.some(row=>row[1].includes('logout'))).toBe(false)}finally{await f.close()}
});
test('signed-out or malformed auth does not invent available models or expose raw failures',async()=>{
 for(const result of [{code:1,stdout:'{"loggedIn":false,"authMethod":"none"}',stderr:''},{code:0,stdout:'private-fixture-invalid-json',stderr:'private-fixture-stderr'},{code:1,stdout:'{"loggedIn":true}',stderr:''}]){
  const f=fixture(async()=>result);try{const status=await f.service.action({action:'check'});expect(status.ready).toBe(false);expect(status.models).toEqual([]);expect(JSON.stringify(status)).not.toContain('private-fixture')}finally{await f.close()}
 }
});
test('API billing and third-party credentials never become a subscription connection',async()=>{
 for(const authMethod of ['api_key','api_key_helper','third_party','oauth_token','unknown']){
  const f=fixture(async()=>({code:0,stdout:JSON.stringify({loggedIn:true,authMethod}),stderr:''}));try{const status=await f.service.action({action:'check'});expect(status.ready).toBe(false);expect(status.models).toEqual([]);expect(status.detail).toContain('subscription');expect(f.records).toHaveLength(1)}finally{await f.close()}
 }
});
test('only connection configuration is persisted and reloaded; chat state stays untouched',async()=>{
 const f=fixture();try{
  const chat=join(f.profile,'chat-state.json');writeFileSync(chat,'synthetic existing chat');await f.service.action({action:'check'});
  const second=new ClaudeCodeModels(f.profile,{inspect,run:async()=>({code:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:''})});
  try{expect(second.available()).toBe(false);expect(second.catalog()).toEqual([]);await second.restore();expect(second.available()).toBe(true);expect(readFileSync(chat,'utf8')).toBe('synthetic existing chat')}finally{await second.close()}
 }finally{await f.close()}
});
test('disconnect wins against a stale auth check even if the subprocess ignores cancellation',async()=>{
 let release:any;const f=fixture(()=>new Promise(done=>release=done));try{
  const pending=f.service.action({action:'check'});while(!release)await new Promise(done=>setTimeout(done,1));await f.service.action({action:'disconnect'});release({code:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:''});await pending;
  expect(f.service.available()).toBe(false);expect(f.service.status().authState).toBe('unknown');
 }finally{await f.close()}
});
test('official login exposes only a validated authorization URL and rechecks auth on completion',async()=>{
 let release:any,signedIn=false;const f=fixture(async(_options:any,args:string[],_input:any,_signal:any,_timeout:any,onData:any)=>{
  if(args.includes('login')){onData('noise https://evil.test/authorize private-fixture\nhttps://claude.ai/oauth/authorize?state=synthetic');return new Promise(done=>release=(value:any)=>{signedIn=true;done(value)})}
  return {code:signedIn?0:1,stdout:JSON.stringify({loggedIn:signedIn,authMethod:signedIn?'claude.ai':'none'}),stderr:''};
 });try{
  const status=await f.service.action({action:'login'});expect(status.login).toEqual({phase:'waiting',authorizationUrl:'https://claude.ai/oauth/authorize?state=synthetic'});expect(JSON.stringify(status)).not.toContain('evil.test');expect(JSON.stringify(status)).not.toContain('private-fixture');
  expect(f.records.map(row=>row[1])).toEqual([['auth','status','--json'],['auth','login','--claudeai']]);
  release({code:0,stdout:'',stderr:''});while(f.service.status().operation)await new Promise(done=>setTimeout(done,1));expect(f.service.available()).toBe(true);expect(f.service.status().login?.phase).toBe('connected');
 }finally{await f.close()}
});
test('cancel login aborts the official flow and ignores its late completion',async()=>{
 let release:any,signal:any;const f=fixture(async(_options:any,args:string[],_input:any,inputSignal:any)=>{if(args[1]==='status')return {code:1,stdout:'{"loggedIn":false,"authMethod":"none"}',stderr:''};signal=inputSignal;return new Promise(done=>release=done)});try{
  await f.service.action({action:'login'});await f.service.action({action:'cancel-login'});expect(signal.aborted).toBe(true);release({code:0,stdout:'',stderr:''});await new Promise(done=>setTimeout(done,1));expect(f.service.status().login?.phase).toBe('cancelled');expect(f.service.available()).toBe(false);
 }finally{await f.close()}
});
test('Connect adopts an existing official subscription sign-in without starting login or inference',async()=>{
 const f=fixture();try{
  const status=await f.service.action({action:'login'});
  expect(status).toMatchObject({connected:true,ready:true,authState:'ready',operation:null});
  expect(f.records.map(row=>row[1])).toEqual([['auth','status','--json']]);
  expect(status.login).toBeUndefined();
 }finally{await f.close()}
});
test('Connect stops on an invalid auth-status response instead of falling back to login or inference',async()=>{
 const f=fixture(async()=>({code:0,stdout:'private-fixture-not-auth-status',stderr:'private-fixture-diagnostic'}));try{
  const status=await f.service.action({action:'login'});
  expect(status).toMatchObject({connected:false,ready:false,authState:'error',operation:null});
  expect(f.records.map(row=>row[1])).toEqual([['auth','status','--json']]);
  expect(JSON.stringify(status)).not.toContain('private-fixture');
 }finally{await f.close()}
});
test('invalid actions fail before official commands and Class2 blocks before the provider',async()=>{
 const f=fixture();try{
  for(const body of [{action:'import-token',token:'synthetic'},{action:'login',executable:'relative-cli'},{action:'check',extra:true}])await expect(f.service.action(body)).rejects.toThrow();
  expect(f.records).toHaveLength(0);expect(()=>f.service.stream({id:'opus'}, {},{dataClass:'class2'})).toThrow('Class 2');expect(f.records).toHaveLength(0);
 }finally{await f.close()}
});
