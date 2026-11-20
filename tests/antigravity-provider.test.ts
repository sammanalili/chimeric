import {test,expect} from 'bun:test';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {AntigravityModelProvider,inspectAntigravityProviderEnvironment,antigravityProviderEnvironment} from '../src/antigravity-provider';
const model:any={id:'gemini-fixture-medium',name:'Fixture',api:'antigravity',provider:'antigravity',baseUrl:'https://antigravity.google',reasoning:true,input:['text'],contextWindow:200000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const tool:any={name:'python',description:'Execute Python in the Chimeric sandbox.',parameters:{type:'object',properties:{code:{type:'string'}},required:['code']}};
const context:any={systemPrompt:'Follow Chimeric tool policy.',messages:[{role:'user',content:'Calculate six times seven.',timestamp:1}],tools:[tool]};
function fixture(mode='ok',policy:{allowSharedCustomizations?:boolean}={}){
 const root=mkdtempSync(join(tmpdir(),'chimeric-provider-test-')),journal=join(root,'journal.jsonl'),home=join(root,'synthetic-home');mkdirSync(home,{mode:0o700});
 const provider=new AntigravityModelProvider({home,workRoot:root,timeoutMs:1000,killGraceMs:30,...policy,launch:(args,cwd)=>spawn(process.execPath,[resolve('tests/fixtures/antigravity-provider-cli.mjs')],{cwd,env:{BUN_BE_BUN:'1',FIXTURE_ARGS:JSON.stringify(args),FIXTURE_MODE:mode,FIXTURE_JOURNAL:journal},stdio:['pipe','pipe','pipe'],detached:true})});
 return {provider,root,home,journal,wire:()=>existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],close:async()=>{await provider.close();rmSync(root,{recursive:true,force:true})}};
}
test('native text and tool events preserve the Chimeric loop and exact tool-result binding',async()=>{
 const f=fixture();try{
  const stream=f.provider.stream(model,context,{toolChoice:'required'}),events=[];for await(const event of stream)events.push(structuredClone(event));
  const first=await stream.result();expect(first.stopReason).toBe('toolUse');expect(first.content[1]).toMatchObject({type:'toolCall',name:'python',arguments:{code:'print(6 * 7)'}});
  expect(events.map(event=>event.type)).toEqual(['start','text_start','text_delta','text_end','toolcall_start','toolcall_delta','toolcall_end','done']);expect(events.find(event=>event.type==='toolcall_delta')?.delta).toBe('{"code":"print(6 * 7)"}');
  expect(first.usage).toMatchObject({input:100,output:20,cacheRead:30,reasoning:5,totalTokens:150});
  const call:any=first.content[1];const next:any={...context,messages:[...context.messages,first,{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:'42'}],isError:false,timestamp:2}]};
  const final=await f.provider.stream(model,next).result();expect(final.stopReason).toBe('stop');expect(final.content).toEqual([{type:'text',text:'The tool returned 42.'}]);
  const input=f.wire().filter(row=>row.kind==='input').at(-1).prompt;expect(input).toContain(call.id);expect(input).toContain('"role":"toolResult"');expect(f.wire().filter(row=>row.kind==='policy').every(row=>row.name==='finish'&&row.decision==='allow')).toBe(true);
  expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--input-format'))).toHaveLength(2);
 }finally{await f.close()}
});
test('the actual generated hook denies every resource tool and permits only validated finish data',async()=>{
 const f=fixture('hang');const controller=new AbortController();try{
  const pending=f.provider.stream(model,context,{signal:controller.signal});await new Promise(done=>setTimeout(done,100));
  const cwd=f.wire().find(row=>row.kind==='launch').cwd;
  for(const name of ['view_file','run_command','write_to_file','send_message','invoke_subagent','call_mcp_tool','future_unknown_tool']){
   const result=spawnSync(process.execPath,[join(cwd,'tool-policy.mjs')],{env:{BUN_BE_BUN:'1'},input:JSON.stringify({toolCall:{name,args:{}}}),encoding:'utf8'});expect(JSON.parse(result.stdout).decision).toBe('deny');
  }
  const malformed=spawnSync(process.execPath,[join(cwd,'tool-policy.mjs')],{env:{BUN_BE_BUN:'1'},input:'{invalid',encoding:'utf8'});expect(JSON.parse(malformed.stdout).decision).toBe('deny');
  controller.abort();expect((await pending.result()).stopReason).toBe('aborted');
 }finally{await f.close()}
});
test('images in users and tool results reject before any CLI launch',async()=>{
 const f=fixture();try{
  for(const role of ['user','toolResult']){
   const result=await f.provider.stream(model,{messages:[{role,content:[{type:'image',mimeType:'image/png',data:'aGVsbG8='}],timestamp:1}]} as any).result();expect(result.errorMessage).toContain('text only');
  }
  expect(f.wire()).toHaveLength(0);
 }finally{await f.close()}
});
for(const [mode,expected]of [['wrong-policy','execution policy'],['missing-conversation','identify its model conversation'],['invalid-schema-arguments','Chimeric tool schema'],['malformed-arguments','JSON object'],['unknown-tool','unknown or malformed'],['missing-proof','structured-finish proof'],['mismatched-result','structured-finish proof'],['duplicate-result','duplicate terminal'],['bad-json','malformed JSON'],['overflow','8 MB'],['builtin','own tool execution'],['quota','quota']] as const){
 test(mode+' fails closed without a provider retry',async()=>{const f=fixture(mode);try{const result=await f.provider.stream(model,context).result();expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain(expected);expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--input-format'))).toHaveLength(1)}finally{await f.close()}});
}
for(const mode of ['hang','ignored-child'])test('timeout kills the process group with '+mode+' descendants',async()=>{
 const f=fixture(mode);try{
  const result=await f.provider.stream(model,context,{timeoutMs:150}).result();expect(result.errorMessage).toContain('timed out');
  const descendants=f.wire().filter(row=>row.kind==='descendant');expect(descendants).toHaveLength(1);
  await new Promise(done=>setTimeout(done,50));expect(()=>process.kill(descendants[0].pid,0)).toThrow();
 }finally{await f.close()}
});
test('same explicit request identity replays the same native tool ID without another inference',async()=>{
 const f=fixture();try{
  const first=await f.provider.stream(model,context,{requestId:'native-request-1'}).result(),again=await f.provider.stream(model,context,{requestId:'native-request-1'}).result();expect(again.content).toEqual(first.content);expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--input-format'))).toHaveLength(1);
  const changed=await f.provider.stream(model,{...context,systemPrompt:'Changed'}, {requestId:'native-request-1'}).result();expect(changed.errorMessage).toContain('different model request');expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--input-format'))).toHaveLength(1);
 }finally{await f.close()}
});
test('an additional official lifecycle hook blocks inference before sending the model context',async()=>{
 const f=fixture('external-hook');try{const result=await f.provider.stream(model,context).result();expect(result.errorMessage).toContain('Disable other Antigravity execution hooks');expect(f.wire().some(row=>row.kind==='input')).toBe(false)}finally{await f.close()}
});
test('official catalog shape and model names are retained',async()=>{const f=fixture();try{expect(await f.provider.catalog()).toEqual([{id:'gemini-fixture-medium',name:'Gemini fixture'},{id:'claude-fixture-high',name:'Claude fixture'}]);expect(f.wire()[0].args.at(-1)).toBe('models');expect(JSON.parse(f.wire()[0].args[3]).statusLine.enabled).toBe(false);expect(JSON.parse(f.wire()[0].args[3]).title.enabled).toBe(false)}finally{await f.close()}});
test('disconnect cancels and drains an outstanding catalog process',async()=>{
 const f=fixture('catalog-hang');try{
  const pending=f.provider.catalog();void pending.catch(()=>{});await new Promise(done=>setTimeout(done,100));const pid=f.wire()[0].pid;
  await f.provider.close();await expect(pending).rejects.toThrow('cancelled');expect(()=>process.kill(pid,0)).toThrow();
 }finally{await f.close()}
});
for(const kind of ['hooks.json','mcp_config.json','plugins.json','plugins'])test('metadata guard blocks '+kind+' before any official CLI process starts',async()=>{
 const f=fixture();try{
  const config=join(f.home,'.gemini','config');mkdirSync(config,{recursive:true});
  if(kind==='plugins'){mkdirSync(join(config,kind));writeFileSync(join(config,kind,'synthetic-package'),'metadata only')}
  else writeFileSync(join(config,kind),'This content is intentionally malformed and must never be read.');
  expect(inspectAntigravityProviderEnvironment(f.home).safe).toBe(false);
  const result=await f.provider.stream(model,context).result();expect(result.errorMessage).toContain('execution configuration');expect(f.wire()).toHaveLength(0);
 }finally{await f.close()}
});
test('metadata guard rejects parent workspace hooks and detects configuration added after an earlier request',async()=>{
 const f=fixture();try{
  expect((await f.provider.stream(model,context).result()).stopReason).toBe('toolUse');
  const before=f.wire().length;mkdirSync(join(f.root,'.agents'));writeFileSync(join(f.root,'.agents','hooks.json'),'unread');
  const result=await f.provider.stream(model,context).result();expect(result.errorMessage).toContain('execution configuration');expect(f.wire()).toHaveLength(before);
 }finally{await f.close()}
});
test('explicit profile environment keeps OS identity and removes ambient config redirects',()=>{
 const env=antigravityProviderEnvironment('/synthetic/chimeric-profile');expect(env.HOME).toBe('/synthetic/chimeric-profile');expect(env.USER).toBe(process.env.USER);expect(env.XDG_CONFIG_HOME).toBeUndefined();expect(env.OPENAI_API_KEY).toBeUndefined();
});
test('explicit shared-customization opt-in permits synthetic MCP/plugins and retains exact hook preflight',async()=>{
 const f=fixture('ok',{allowSharedCustomizations:true});try{
  const config=join(f.home,'.gemini','config');mkdirSync(join(config,'plugins','synthetic-package'),{recursive:true});
  writeFileSync(join(config,'mcp_config.json'),'Synthetic metadata; no content read by the adapter.');writeFileSync(join(config,'plugins.json'),'Synthetic plugin manifest metadata.');
  expect(inspectAntigravityProviderEnvironment(f.home).safe).toBe(false);
  expect(inspectAntigravityProviderEnvironment(f.home,undefined,{allowSharedCustomizations:true}).safe).toBe(true);
  const result=await f.provider.stream(model,context).result();expect(result.stopReason).toBe('toolUse');
  const launches=f.wire().filter(row=>row.kind==='launch');expect(launches).toHaveLength(2);expect(launches[0].args).toContain('/hooks');
  for(const launch of launches){const settings=JSON.parse(launch.args[launch.args.indexOf('--settings')+1]);expect(settings.statusLine.enabled).toBe(false);expect(settings.title.enabled).toBe(false)}
 }finally{await f.close()}
});
test('shared-customization opt-in still rejects global hook-file metadata before any launch',async()=>{
 const f=fixture('ok',{allowSharedCustomizations:true});try{
  const config=join(f.home,'.gemini','config');mkdirSync(config,{recursive:true});writeFileSync(join(config,'hooks.json'),'Never read this hook content.');
  const result=await f.provider.stream(model,context).result();expect(result.errorMessage).toContain('Disable external hooks');expect(f.wire()).toHaveLength(0);
 }finally{await f.close()}
});
test('shared-customization opt-in rejects external plugin hooks advertised by the official preflight',async()=>{
 const f=fixture('external-hook',{allowSharedCustomizations:true});try{
  const config=join(f.home,'.gemini','config');mkdirSync(join(config,'plugins','synthetic-package'),{recursive:true});
  const result=await f.provider.stream(model,context).result();expect(result.errorMessage).toContain('Disable other Antigravity execution hooks');expect(f.wire().filter(row=>row.kind==='launch')).toHaveLength(1);expect(f.wire().some(row=>row.kind==='input')).toBe(false);
 }finally{await f.close()}
});
