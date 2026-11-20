import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ClaudeCodeModelProvider,claudeCodeEnvironment,claudeCodeAuthorizationUrl} from '../src/claude-code-provider';
const model:any={id:'opus',name:'Claude Opus',api:'claude-code',provider:'claude-code',baseUrl:'https://claude-code.local.invalid',reasoning:true,input:['text'],contextWindow:200000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const tool:any={name:'python',description:'Python in Chimeric.',parameters:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}};
const context:any={systemPrompt:'Follow the native Chimeric permissions.',messages:[{role:'user',content:'Compute six times seven.',timestamp:1}],tools:[tool]};
function fixture(mode='ok'){
 const root=mkdtempSync(join(tmpdir(),'chimeric-cc-test-')),home=join(root,'home'),journal=join(root,'journal');mkdirSync(home);
 const provider=new ClaudeCodeModelProvider({home,workRoot:root,timeoutMs:1000,killGraceMs:30,launch:(args,cwd)=>spawn(process.execPath,[resolve('tests/fixtures/claude-code-cli.mjs')],{cwd,env:{BUN_BE_BUN:'1',FIXTURE_ARGS:JSON.stringify(args),FIXTURE_MODE:mode,FIXTURE_JOURNAL:journal},stdio:['pipe','pipe','pipe'],detached:true})});
 return {root,provider,wire:()=>existsSync(journal)?readFileSync(journal,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[],close:async()=>{await provider.close();rmSync(root,{recursive:true,force:true})}};
}
test('official-client structured tool requests preserve native execution and tool result identity',async()=>{
 const f=fixture();try{
  const events:any[]=[],stream=f.provider.stream(model,context,{toolChoice:'required',reasoningEffort:'high'});for await(const event of stream)events.push(event);
  const first=await stream.result();expect(first.stopReason).toBe('toolUse');expect(first.content[1]).toMatchObject({type:'toolCall',name:'python',arguments:{code:'print(6 * 7)'}});
  expect(events.map(event=>event.type)).toEqual(['start','text_start','text_delta','text_end','toolcall_start','toolcall_delta','toolcall_end','done']);
  expect(first.usage).toMatchObject({input:100,output:20,cacheRead:30,cacheWrite:5,totalTokens:155});
  const call:any=first.content[1];const next:any={...context,messages:[...context.messages,first,{role:'toolResult',toolCallId:call.id,toolName:call.name,content:[{type:'text',text:'42'}],isError:false,timestamp:2}]};
  const final=await f.provider.stream(model,next).result();expect(final.stopReason).toBe('stop');expect(final.content).toEqual([{type:'text',text:'The tool returned 42.'}]);
  expect(f.wire().filter(row=>row.kind==='input').at(-1).prompt).toContain(call.id);
  const args=f.wire().find(row=>row.kind==='launch'&&row.args.includes('--print')).args;for(const flag of ['--safe-mode','--restricted','--strict-mcp-config','--no-session-persistence','--disable-slash-commands'])expect(args).toContain(flag);
  expect(args[args.indexOf('--tools')+1]).toBe('');expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--effort')+1]).toBe('high');
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);expect(settings.disableAllHooks).toBe(true);expect(settings.switchModelsOnFlag).toBe(false);expect(settings.fallbackModel).toEqual([]);
  expect(args).not.toContain('--bare');expect(args).not.toContain('--dangerously-skip-permissions');
 }finally{await f.close()}
});
test('Japanese output survives arbitrary UTF-8 byte chunk boundaries',async()=>{const f=fixture('plain');try{const result=await f.provider.stream(model,{messages:context.messages} as any).result();expect(result.content).toEqual([{type:'text',text:'日本語の応答です。'}])}finally{await f.close()}});
test('Class2, images, unknown models, and invalid efforts reject before starting the client',async()=>{
 const f=fixture();try{
  expect((await f.provider.stream(model,context,{dataClass:'class2'}).result()).stopReason).toBe('error');
  const image:any={messages:[{role:'user',content:[{type:'image',mimeType:'image/png',data:'AA=='}],timestamp:1}]};
  expect((await f.provider.stream(model,image).result()).errorMessage).toContain('text only');
  expect((await f.provider.stream({...model,id:'guessed-model'},context).result()).stopReason).toBe('error');
  expect((await f.provider.stream(model,context,{reasoningEffort:'ultra'}).result()).stopReason).toBe('error');
  expect(f.wire()).toEqual([]);
 }finally{await f.close()}
});
for(const mode of ['builtin','unknown-tool','invalid-arguments','empty','malformed','quota','bad-json','duplicate','fallback'])test(mode+' is rejected without repeating inference or leaking diagnostics',async()=>{
 const f=fixture(mode);try{const result=await f.provider.stream(model,context).result();expect(result.stopReason).toBe('error');expect(result.errorMessage).not.toContain('synthetic-sensitive');expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--print'))).toHaveLength(1)}finally{await f.close()}
});
test('the same request identity replays the same native tool ID and rejects changed context',async()=>{
 const f=fixture();try{
  const first=await f.provider.stream(model,context,{requestId:'request-1'}).result(),again=await f.provider.stream(model,context,{requestId:'request-1'}).result();expect(again.content).toEqual(first.content);
  expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--print'))).toHaveLength(1);
  const changed=await f.provider.stream(model,{...context,systemPrompt:'Changed rules'},{requestId:'request-1'}).result();expect(changed.stopReason).toBe('error');expect(f.wire().filter(row=>row.kind==='launch'&&row.args.includes('--print'))).toHaveLength(1);
 }finally{await f.close()}
});
test('timeout stops descendants and removes the temporary transcript workspace',async()=>{
 const f=fixture('descendant');try{
  const result=await f.provider.stream(model,context,{timeoutMs:150}).result();expect(result.errorMessage).toContain('timed out');
  await new Promise(done=>setTimeout(done,80));const pid=f.wire().find(row=>row.kind==='descendant').pid;expect(()=>process.kill(pid,0)).toThrow();
  expect(readdirSync(f.root).filter(name=>name.startsWith('chimeric-claude-model-'))).toEqual([]);
 }finally{await f.close()}
});
test('closing a connection aborts a running model turn',async()=>{
 const f=fixture('hang');try{const stream=f.provider.stream(model,context);await new Promise(done=>setTimeout(done,60));await f.provider.close();expect((await stream.result()).stopReason).toBe('aborted')}finally{await f.close()}
});
test('environment and authorization URL handling do not import credentials or arbitrary destinations',()=>{
 const previous=process.env.ANTHROPIC_API_KEY;process.env.ANTHROPIC_API_KEY='synthetic-test-only';try{expect(claudeCodeEnvironment()).not.toHaveProperty('ANTHROPIC_API_KEY');expect(claudeCodeEnvironment()).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')}finally{if(previous===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=previous}
 expect(claudeCodeAuthorizationUrl('Open https://claude.ai/oauth/authorize?state=synthetic')).toBe('https://claude.ai/oauth/authorize?state=synthetic');
 for(const url of ['https://evil.test/oauth/authorize','https://claude.ai.evil.test/oauth/authorize','https://user@claude.ai/oauth/authorize','http://claude.ai/oauth/authorize','https://claude.ai/settings'])expect(claudeCodeAuthorizationUrl(url)).toBeUndefined();
 expect(claudeCodeEnvironment().CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
});
test('each model turn verifies the current billing identity before sending any transcript',async()=>{
 const f=fixture('api-identity');try{const result=await f.provider.stream(model,context).result();expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('subscription');expect(f.wire().filter(row=>row.kind==='launch')).toHaveLength(1);expect(f.wire().some(row=>row.kind==='input')).toBe(false)}finally{await f.close()}
});
test('reviewed Fable 5.2 exact ID reaches the CLI and rejects an older substituted model',async()=>{
 for(const mode of ['ok','exact-substitution']){
  const f=fixture(mode);try{const result=await f.provider.stream({...model,id:'claude-fable-5-2'},context).result();expect(result.stopReason).toBe(mode==='ok'?'toolUse':'error');const args=f.wire().find(row=>row.kind==='launch'&&row.args.includes('--print')).args;expect(args[args.indexOf('--model')+1]).toBe('claude-fable-5-2')}finally{await f.close()}
 }
});
