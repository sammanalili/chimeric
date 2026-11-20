import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync,symlinkSync,statSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {Antigravity,antigravityEnvironment} from '../src/antigravity';

async function fixture(extra={}){
 const dir=mkdtempSync(join(tmpdir(),'chimeric-acp-'));
 const service=new Antigravity(dir,{cancelTimeoutMs:100,operationTimeoutMs:1000,launch:cwd=>spawn(process.execPath,[resolve('tests/fixtures/antigravity-agent.mjs')],{cwd,env:{BUN_BE_BUN:'1',...extra},stdio:['pipe','pipe','pipe']})});
 await service.connect();
 return {dir,service,close:async()=>{await service.close();rmSync(dir,{recursive:true,force:true})},wire:()=>readFileSync(join(service.root,'fixture-wire.jsonl'),'utf8').trim().split('\n').map(l=>JSON.parse(l))};
}
async function wait(fn:()=>any){const until=Date.now()+4000;while(Date.now()<until){const result=fn();if(result)return result;await new Promise(done=>setTimeout(done,10))}throw Error('Expected ACP transition was not observed')}

test('The genuine ACP identity exposes advertised models and enforces one-time permission modes',async()=>{
 const f=await fixture();try{
  const result=await f.service.create({title:'Research'});const id=result.session.id;
  expect(f.wire()[0].params.clientInfo.name).toBe('chimeric');expect(f.wire()[0].params.clientCapabilities.terminal).toBe(false);
  expect(result.session.configOptions[0].options.map(o=>o.value)).toEqual(['gemini-fixture','claude-fixture']);
  await f.service.setConfig(id,{configId:'model',value:'claude-fixture'});
  expect(f.service.snapshot(id).session.configOptions[0].currentValue).toBe('claude-fixture');
  await expect(f.service.setConfig(id,{configId:'model',value:'unadvertised-model'})).rejects.toThrow('offered to this client');
  await expect(f.service.setConfig(id,{configId:'mode',value:'accept-edits'})).rejects.toThrow('offered to this client');
  await f.service.setConfig(id,{configId:'thought_level',value:'high'});
  expect(f.service.snapshot(id).session.configOptions[1].currentValue).toBe('high');
  expect(f.wire().filter(v=>v.method==='session/set_config_option')).toHaveLength(2);
 }finally{await f.close()}
});

test('A prompt streams through a real child process and identical request replay never sends twice',async()=>{
 const f=await fixture();try{
  const {session}=await f.service.create({});const request={requestId:randomUUID(),text:'Hello'};
  await f.service.prompt(session.id,request);await wait(()=>!f.service.status().activeSessionId);
  const snapshot=f.service.snapshot(session.id);expect(snapshot.events.some(e=>e.kind==='agent'&&e.data.content?.text==='Synthetic answer: Hello')).toBe(true);
  expect(snapshot.session.status).toBe('idle');
  expect((await f.service.prompt(session.id,request)).replayed).toBe(true);
  await expect(f.service.prompt(session.id,{...request,text:'Changed'})).rejects.toThrow('different message');
  expect(f.wire().filter(v=>v.method==='session/prompt')).toHaveLength(1);
  expect(statSync(join(f.service.root,'sessions.sqlite')).mode&0o777).toBe(0o600);
 }finally{await f.close()}
});

test('Permission approval binds to the exact session and turn and a stale approval never runs a tool',async()=>{
 const f=await fixture();try{
  const {session}=await f.service.create({});const other=(await f.service.create({})).session;const request={requestId:randomUUID(),text:'permission'};
  await f.service.prompt(session.id,request);
  const permission=await wait(()=>f.service.snapshot(session.id).permissions[0]);
  expect(permission.options.map(o=>o.optionId)).toEqual(['once','reject']);
  expect(existsSync(join(f.service.root,'workspaces',session.id,'result.txt'))).toBe(false);
  const decision={permissionId:permission.id,turnId:request.requestId,optionId:'once'};
  expect(()=>f.service.permission(other.id,decision)).toThrow('ended');
  expect(()=>f.service.permission(session.id,{...decision,optionId:'always'})).toThrow('one-time');
  expect(()=>f.service.permission(session.id,{...decision,turnId:randomUUID()})).toThrow('ended');
  f.service.permission(session.id,decision);await wait(()=>!f.service.status().activeSessionId);
  expect(readFileSync(join(f.service.root,'workspaces',session.id,'result.txt'),'utf8')).toBe('synthetic result\n');
  expect(()=>f.service.permission(session.id,decision)).toThrow('ended');expect(f.service.snapshot(session.id).session.status).toBe('idle');
 }finally{await f.close()}
});

test('Cancellation denies pending permission, blocks concurrent turns and never retries a stopped turn',async()=>{
 const f=await fixture();try{
  const id=(await f.service.create({})).session.id;await f.service.prompt(id,{requestId:randomUUID(),text:'permission'});
  const p=await wait(()=>f.service.snapshot(id).permissions[0]);
  await expect(f.service.prompt(id,{requestId:randomUUID(),text:'extra'})).rejects.toThrow('active');
  await f.service.cancel(id);expect(f.service.snapshot(id).permissions).toEqual([]);
  expect(f.service.snapshot(id).session.status).toBe('interrupted');
  expect(()=>f.service.permission(id,{permissionId:p.id,turnId:p.turnId,optionId:'once'})).toThrow('ended');
  expect(existsSync(join(f.service.root,'workspaces',id,'result.txt'))).toBe(false);
  expect(f.wire().filter(v=>v.method==='session/prompt')).toHaveLength(1);
 }finally{await f.close()}
});

test('An unresponsive cancel closes the process and leaves the session interrupted',async()=>{
 const f=await fixture();try{
  const id=(await f.service.create({})).session.id;await f.service.prompt(id,{requestId:randomUUID(),text:'stubborn'});
  await wait(()=>f.wire().some(m=>m.method==='session/prompt'));
  await f.service.cancel(id);expect(f.service.status().connected).toBe(false);expect(f.service.snapshot(id).session.status).toBe('interrupted');
 }finally{await f.close()}
});

test('Quota errors stop the connection with a clear reason and a single model request',async()=>{
 const f=await fixture();try{
  const id=(await f.service.create({})).session.id;await f.service.prompt(id,{requestId:randomUUID(),text:'quota'});
  await wait(()=>!f.service.status().activeSessionId);expect(f.service.status().connected).toBe(false);
  expect(f.service.snapshot(id).session.error).toContain('quota');expect(f.wire().filter(v=>v.method==='session/prompt')).toHaveLength(1);
 }finally{await f.close()}
});

test('Image bytes reach ACP, attachment ownership is enforced and files cannot escape the workspace',async()=>{
 const f=await fixture();try{
  const id=(await f.service.create({})).session.id,other=(await f.service.create({})).session.id;
  const data='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=';
  const file=f.service.upload(id,{name:'pixel.png',mimeType:'image/png',data});
  await expect(f.service.prompt(other,{requestId:randomUUID(),text:'image',attachmentIds:[file.id]})).rejects.toThrow('unavailable');
  await f.service.prompt(id,{requestId:randomUUID(),text:'image',attachmentIds:[file.id]});await wait(()=>!f.service.status().activeSessionId);
  const prompt=f.wire().find(m=>m.method==='session/prompt').params.prompt;
  expect(prompt[1]).toEqual({type:'image',data,mimeType:'image/png'});
  expect(()=>f.service.upload(id,{name:'bad.png',mimeType:'image/png',data:Buffer.from('bad').toString('base64')})).toThrow('valid PNG');
  expect(()=>f.service.download(id,'../../sessions.sqlite')).toThrow('inside');
  symlinkSync(join(f.service.root,'sessions.sqlite'),join(f.service.root,'workspaces',id,'leak'));
  expect(()=>f.service.download(id,'leak')).toThrow('Symbolic links');expect(f.service.files(id).files.some(f=>f.path==='leak')).toBe(false);
 }finally{await f.close()}
});

test('A new service instance restores history, explicitly resumes ACP, and preserves request replay protection',async()=>{
 const f=await fixture();let restored:Antigravity|undefined;try{
  const id=(await f.service.create({})).session.id,request={requestId:randomUUID(),text:'persist'};
  await f.service.prompt(id,request);await wait(()=>!f.service.status().activeSessionId);await f.service.close();
  restored=new Antigravity(f.dir,{launch:cwd=>spawn(process.execPath,[resolve('tests/fixtures/antigravity-agent.mjs')],{cwd,env:{BUN_BE_BUN:'1'},stdio:['pipe','pipe','pipe']})});
  expect(restored.status().connected).toBe(false);expect(restored.snapshot(id).events.some(e=>e.data.text==='persist')).toBe(true);
  expect((await restored.prompt(id,request)).replayed).toBe(true);expect(restored.status().connected).toBe(false);
  await restored.prompt(id,{requestId:randomUUID(),text:'continue'});await wait(()=>!restored!.status().activeSessionId);
  expect(f.wire().filter(v=>v.method==='session/resume')).toHaveLength(1);expect(f.wire().filter(v=>v.method==='session/prompt')).toHaveLength(2);
 }finally{await restored?.close();await f.close()}
});

test('Provider secrets and injected agent configuration never enter the CLI environment',()=>{
 const env=antigravityEnvironment({HOME:'/home/user',PATH:'/bin',GEMINI_API_KEY:'secret',ANTHROPIC_API_KEY:'secret',OPENAI_API_KEY:'secret',NODE_OPTIONS:'--require=evil',BUN_OPTIONS:'evil',AGY_API_ENDPOINT:'evil',SSL_CERT_FILE:'evil'});
 expect(env).toEqual({HOME:'/home/user',PATH:'/bin'});
});

test('Unsupported protocol versions are rejected before any session or model request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'chimeric-acp-version-'));
 const service=new Antigravity(dir,{operationTimeoutMs:500,launch:cwd=>spawn(process.execPath,[resolve('tests/fixtures/antigravity-agent.mjs')],{cwd,env:{BUN_BE_BUN:'1',FIXTURE_WRONG_VERSION:'1'},stdio:['pipe','pipe','pipe']})});
 try{await expect(service.connect()).rejects.toThrow('compatible');expect(service.status().connected).toBe(false);const wire=readFileSync(join(service.root,'fixture-wire.jsonl'),'utf8');expect(wire).not.toContain('session/new');expect(wire).not.toContain('session/prompt')}
 finally{await service.close();rmSync(dir,{recursive:true,force:true})}
});

test('A crashed agent preserves user history and stops without reconnecting or resubmitting',async()=>{
 const f=await fixture();try{
  const id=(await f.service.create({})).session.id,request={requestId:randomUUID(),text:'crash'};
  await f.service.prompt(id,request);await wait(()=>!f.service.status().activeSessionId);
  expect(f.service.status().connected).toBe(false);expect(f.service.snapshot(id).session.status).toBe('interrupted');
  expect(f.service.snapshot(id).events.some(e=>e.kind==='user'&&e.data.turnId===request.requestId)).toBe(true);
  expect(f.wire().filter(v=>v.method==='session/prompt')).toHaveLength(1);expect((await f.service.prompt(id,request)).replayed).toBe(true);
 }finally{await f.close()}
});
