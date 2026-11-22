import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,existsSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {deflateSync} from 'node:zlib';
import {ClaudeCodeModelProvider,claudeCodeEnvironment,claudeCodeAuthorizationUrl,type ClaudeCodeProviderOptions} from '../src/claude-code-provider';
const model:any={id:'opus',name:'Claude Opus',api:'claude-code',provider:'claude-code',baseUrl:'https://claude-code.local.invalid',reasoning:true,input:['text'],contextWindow:200000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
const tool:any={name:'python',description:'Python in Chimeric.',parameters:{type:'object',properties:{code:{type:'string'}},required:['code'],additionalProperties:false}};
const context:any={systemPrompt:'Follow the native Chimeric permissions.',messages:[{role:'user',content:'Compute six times seven.',timestamp:1}],tools:[tool]};
function png(red=255,green=0,blue=0){
 const chunk=(name:string,bytes:Buffer)=>{const type=Buffer.from(name),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(bytes.length);let crc=0xffffffff;for(const byte of Buffer.concat([type,bytes])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}tail.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([head,type,bytes,tail])};
 const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(2,4);header[8]=8;header[9]=2;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,red,green,blue,red,green,blue,0,red,green,blue,red,green,blue]))),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
function fixture(mode='ok',modelCatalog?:ClaudeCodeProviderOptions['modelCatalog']){
 const root=mkdtempSync(join(tmpdir(),'chimeric-cc-test-')),home=join(root,'home'),journal=join(root,'journal');mkdirSync(home);
 const provider=new ClaudeCodeModelProvider({home,workRoot:root,timeoutMs:1000,killGraceMs:30,modelCatalog,launch:(args,cwd,env)=>spawn(process.execPath,[resolve('tests/fixtures/claude-code-cli.mjs')],{cwd,env:{BUN_BE_BUN:'1',FIXTURE_ARGS:JSON.stringify(args),FIXTURE_MODE:mode,FIXTURE_JOURNAL:journal,FIXTURE_OUTPUT_LIMIT:env.CLAUDE_CODE_MAX_OUTPUT_TOKENS??''},stdio:['pipe','pipe','pipe'],detached:true})});
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
  expect(f.wire().find(row=>row.kind==='launch').args).toEqual(['auth','status','--json']);
  expect(args[args.indexOf('--tools')+1]).toBe('');expect(args[args.indexOf('--setting-sources')+1]).toBe('');expect(args[args.indexOf('--effort')+1]).toBe('high');
  const settings=JSON.parse(args[args.indexOf('--settings')+1]);expect(settings.disableAllHooks).toBe(true);expect(settings.switchModelsOnFlag).toBe(false);expect(settings.fallbackModel).toEqual([]);
  expect(args).not.toContain('--bare');expect(args).not.toContain('--dangerously-skip-permissions');
 }finally{await f.close()}
});
test('Japanese output survives arbitrary UTF-8 byte chunk boundaries',async()=>{const f=fixture('plain');try{const result=await f.provider.stream(model,{messages:context.messages} as any).result();expect(result.content).toEqual([{type:'text',text:'日本語の応答です。'}])}finally{await f.close()}});
test('Class2, invalid images, unknown models, and invalid efforts reject before starting the client',async()=>{
 const f=fixture();try{
  expect((await f.provider.stream(model,context,{dataClass:'class2'}).result()).stopReason).toBe('error');
  const image:any={messages:[{role:'user',content:[{type:'image',mimeType:'image/png',data:'AA=='}],timestamp:1}]};
  expect((await f.provider.stream(model,image).result()).errorMessage).toContain('valid base64');
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
test('a discovered context variant uses its CLI transport ID while preserving the saved model ID',async()=>{
 const f=fixture('sdk-catalog',[{id:'claude-fable-5-2',transportId:'claude-fable-5-2[1m]',resolvedModel:'claude-fable-5-2',efforts:['medium','high']}]);
 try{
  const result=await f.provider.stream({...model,id:'claude-fable-5-2'},context,{reasoningEffort:'medium'}).result();expect(result.stopReason).toBe('toolUse');expect(result.model).toBe('claude-fable-5-2');
  const args=f.wire().find(row=>row.kind==='launch'&&row.args.includes('--print')).args;expect(args[args.indexOf('--model')+1]).toBe('claude-fable-5-2[1m]');
 }finally{await f.close()}
});
test('the discovered catalog controls current models, effort levels and resolved model identity',async()=>{
 const catalog=[{id:'opus',transportId:'opus',resolvedModel:'claude-opus-current',efforts:['low']}];
 for(const request of [{id:'haiku',effort:'low'},{id:'opus',effort:'max'}]){
  const f=fixture('ok',catalog);try{expect((await f.provider.stream({...model,id:request.id},context,{reasoningEffort:request.effort}).result()).stopReason).toBe('error');expect(f.wire()).toHaveLength(0)}finally{await f.close()}
 }
 const changed=fixture('ok',catalog);try{const result=await changed.provider.stream(model,context,{reasoningEffort:'low'}).result();expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('changed the requested model')}finally{await changed.close()}
 const future=fixture('sdk-catalog',[{id:'claude-future-7-2',transportId:'claude-future-7-2',resolvedModel:'claude-future-7-2',efforts:['low']}]);try{const result=await future.provider.stream({...model,id:'claude-future-7-2'},context,{reasoningEffort:'low'}).result();expect(result.stopReason).toBe('toolUse')}finally{await future.close()}
});

test('image inputs are real CLI image blocks with role mappings rather than base64 transcript text',async()=>{
 const f=fixture('vision'),data=png();try{
  const image:any={messages:[{role:'user',content:[{type:'text',text:'Describe this supplied image.'},{type:'image',mimeType:'image/png',data}],timestamp:1}]};
  expect((await f.provider.stream(model,image).result()).content).toEqual([{type:'text',text:'VISUAL_RESULT'}]);
  const wire=f.wire().find(row=>row.kind==='input'),payload=JSON.parse(wire.prompt.slice(wire.prompt.indexOf('\n\n')+2));
  expect(wire.prompt).not.toContain(data);expect(payload.transcript[0].content[1]).toEqual({type:'image',image_ref:'chimeric_image_1',mimeType:'image/png'});
  expect(wire.content.filter((block:any)=>block.type==='image')).toEqual([{type:'image',source:{type:'base64',media_type:'image/png',data}}]);
  expect(JSON.parse(wire.content[1].text.slice('Chimeric image attachment: '.length))).toEqual({image_ref:'chimeric_image_1',message_index:0,content_index:1,role:'user'});
 }finally{await f.close()}
});

test('tool-result images and converted document pages retain their message and tool-call association',async()=>{
 const f=fixture('vision'),data=png();try{
  const transcript:any={...context,messages:[...context.messages,{role:'toolResult',toolCallId:'native-render-call',toolName:'render_pdf',content:[{type:'text',text:'Extracted document text. PDF page 1'},{type:'image',mimeType:'image/png',data}],isError:false,timestamp:2},{role:'user',content:'Explain the supplied page.',timestamp:3}]};
  const result=await f.provider.stream(model,transcript).result();expect(result.stopReason).toBe('stop');
  const wire=f.wire().find(row=>row.kind==='input'),payload=JSON.parse(wire.prompt.slice(wire.prompt.indexOf('\n\n')+2)),index=payload.transcript.findIndex((message:any)=>message.role==='toolResult');
  expect(payload.transcript[index]).toMatchObject({toolCallId:'native-render-call',toolName:'render_pdf',isError:false});expect(payload.transcript[index].content[0].text).toContain('PDF page 1');
  expect(JSON.parse(wire.content[1].text.slice('Chimeric image attachment: '.length))).toEqual({image_ref:'chimeric_image_1',message_index:index,content_index:1,role:'toolResult',tool_call_id:'native-render-call'});expect(wire.prompt).not.toContain(data);
 }finally{await f.close()}
});

test('image bytes bind replay identity and invalid attachments never launch the client',async()=>{
 const f=fixture('vision'),data=png(),withImage=(image:any)=>({messages:[{role:'user',content:[image],timestamp:1}]}) as any;try{
  const image={type:'image',mimeType:'image/png',data};expect((await f.provider.stream(model,withImage(image),{requestId:'image-replay'}).result()).stopReason).toBe('stop');
  const changed=await f.provider.stream(model,withImage({...image,data:png(0,0,255)}),{requestId:'image-replay'}).result();expect(changed.errorMessage).toContain('different model turn');expect(f.wire().filter(row=>row.kind==='input')).toHaveLength(1);
 }finally{await f.close()}
 const invalid=fixture('vision');try{
  for(const image of [{type:'image',mimeType:'image/svg+xml',data},{type:'image',mimeType:'image/jpeg',data},{type:'image',mimeType:'image/png',data:'not-base64'},{type:'image',mimeType:'image/png',data:Buffer.alloc(5*1024*1024+1).toString('base64')},{type:'document',source:{type:'base64',media_type:'application/pdf',data:'SYNTHETIC_PDF'}}])expect((await invalid.provider.stream(model,withImage(image)).result()).stopReason).toBe('error');
  const many:any={messages:[{role:'user',content:Array(101).fill({type:'image',mimeType:'image/png',data}),timestamp:1}]};expect((await invalid.provider.stream(model,many).result()).errorMessage).toContain('100 images');expect(invalid.wire()).toEqual([]);
 }finally{await invalid.close()}
});

test('context usage keeps only the latest top-level prompt while aggregate billing stays unchanged',async()=>{
 const f=fixture('context-usage');try{
  const result:any=await f.provider.stream(model,context).result();expect(result.stopReason).toBe('toolUse');
  expect(result.usage).toMatchObject({input:10000,output:200,cacheRead:3000,cacheWrite:1000,totalTokens:14200});expect(result.contextUsage).toEqual({input:700,output:200,cacheRead:200,cacheWrite:100});
  expect(result.contextUsage.input+result.contextUsage.cacheRead+result.contextUsage.cacheWrite).toBe(1000);
  expect(result.modelUsage).toEqual({'claude-opus-fixture':{contextWindow:1000000,maxOutputTokens:128000}});
 }finally{await f.close()}
 for(const mode of ['plain','bad-context-usage','fractional-context-usage']){
  const f=fixture(mode);try{const result:any=await f.provider.stream(model,mode==='plain'?{messages:context.messages} as any:context).result();if(mode==='plain'){expect(result.stopReason).toBe('stop');expect(result.contextUsage).toBeUndefined()}else{expect(result.stopReason).toBe('error');expect(result.errorMessage).toContain('token accounting')}}finally{await f.close()}
 }
});

test('output limits apply only to the inference child, clamp to model limits and bind replay identity',async()=>{
 const f=fixture('plain');try{
  const plain:any={messages:context.messages};expect((await f.provider.stream(model,plain,{maxTokens:512,requestId:'bounded-output'}).result()).stopReason).toBe('stop');
  const launches=f.wire().filter(row=>row.kind==='launch');expect(launches[0].outputTokenLimit).toBeNull();expect(launches[1].outputTokenLimit).toBe('512');
  expect((await f.provider.stream(model,plain,{maxTokens:513,requestId:'bounded-output'}).result()).errorMessage).toContain('different model turn');expect(f.wire().filter(row=>row.kind==='input')).toHaveLength(1);
  expect((await f.provider.stream(model,plain,{maxTokens:999999}).result()).stopReason).toBe('stop');expect(f.wire().filter(row=>row.kind==='launch').at(-1).outputTokenLimit).toBe(String(model.maxTokens));
 }finally{await f.close()}
 const invalid=fixture('plain');try{
  for(const maxTokens of [0,-1,0.5,NaN,Infinity])expect((await invalid.provider.stream(model,context,{maxTokens}).result()).stopReason).toBe('error');
  expect((await invalid.provider.stream({...model,maxTokens:0},context).result()).stopReason).toBe('error');expect(invalid.wire()).toEqual([]);
 }finally{await invalid.close()}
 const previous=process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS='999999';try{expect(claudeCodeEnvironment()).not.toHaveProperty('CLAUDE_CODE_MAX_OUTPUT_TOKENS')}finally{if(previous===undefined)delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;else process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS=previous}
});
