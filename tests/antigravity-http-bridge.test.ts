import {afterEach,describe,expect,test} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {bridgeTransport,findBridgeBinary,transportPreference,closeBridge,bridgeTest,type BridgeLike} from '../src/antigravity-http-bridge';
import {stream as streamAntigravityHttp,ANTIGRAVITY_HTTP_USER_AGENT} from '../src/antigravity-http-provider';
import type {Model} from '@earendil-works/pi-ai';

const PYTHON='/opt/homebrew/bin/python3';
const model={id:'gemini-4-argon-medium',name:'Gemini 4 Argon (Medium)',api:'antigravity-http',provider:'antigravity-http',baseUrl:'https://daily-cloudcode-pa.googleapis.com',reasoning:false,contextWindow:1_048_576,maxTokens:65_536,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} as unknown as Model<'antigravity-http'>;
const context=(text:string)=>({messages:[{role:'user' as const,content:[{type:'text' as const,text}],timestamp:Date.now()}]});
const turn=(text:string)=>({role:'user' as const,content:[{type:'text' as const,text}],timestamp:Date.now()});
const sse=(frames:string[])=>frames.map(frame=>'data: '+frame+'\n\n').join('');

afterEach(()=>{closeBridge();delete process.env.CHIMERIC_ANTIGRAVITY_BRIDGE});

/** Writes a fake bridge (python) that speaks the NDJSON protocol. */
function fakeBridge(script:string):{path:string;dir:string}{
 const dir=mkdtempSync(join(tmpdir(),'agy-fake-bridge-'));
 const path=join(dir,'fake-bridge.py');
 const body='#!/opt/homebrew/bin/python3\n'+script.replace('PYTHON',PYTHON).replaceAll('%LOG%',join(dir,'seen.jsonl')).replace(/^\n/,'');
 writeFileSync(path,body,{mode:0o755});
 return {path,dir};
}

describe('bridge binary discovery',()=>{
 test('respects the explicit CHIMERIC_ANTIGRAVITY_BRIDGE override',()=>{
  const {path,dir}=fakeBridge('pass');
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  expect(findBridgeBinary()).toBe(realpathSync(path));
  rmSync(dir,{recursive:true,force:true});
 });

 test('returns undefined for a missing binary',()=>{
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=join(tmpdir(),'no-such-bridge');
  expect(findBridgeBinary()).toBeUndefined();
 });
});

describe('transport preference',()=>{
 test('an injected fetch (tests/fixtures) always selects fetch',()=>{
  expect(transportPreference(true)).toBe('fetch');
 });
 test('without an injected fetch the Go bridge is the default',()=>{
  expect(transportPreference(false)).toBe('bridge');
 });
 test('the environment override wins over the default',()=>{
  const previous=process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT;
  process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT='fetch';
  expect(transportPreference(false)).toBe('fetch');
  process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT='bridge';
  expect(transportPreference(true)).toBe('bridge');
  if(previous===undefined)delete process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT;else process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT=previous;
 });
});

describe('bridge transport client',()=>{
 test('cancelling during helper startup sends no model request',async()=>{
  const {path,dir}=fakeBridge(`
import sys
with open('%LOG%','w') as log:
    log.write('ready\\n')
for line in sys.stdin:
    with open('%LOG%','a') as log: log.write('request\\n')
`);
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  try{
   const controller=new AbortController();
   const pending=bridgeTransport()!.start('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse','synthetic-access','{}',controller.signal);
   controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});
   const seen=await new Promise<string>((resolve,reject)=>{
    const deadline=Date.now()+5000;
    const poll=()=>{try{const text=readFileSync(join(dir,'seen.jsonl'),'utf8');if(text.includes('ready'))return resolve(text)}catch{}if(Date.now()>deadline)return reject(Error('The helper did not start'));setTimeout(poll,10)};poll();
   });
   expect(seen.trim()).toBe('ready');
  }finally{closeBridge();rmSync(dir,{recursive:true,force:true})}
 },20_000);
 test('streams status, headers and body chunks through a real child process',async()=>{
  const {path,dir}=fakeBridge(`
import json,sys,base64
for line in sys.stdin:
    req=json.loads(line)
    print(json.dumps({"id":req["id"],"status":200,"headers":{"content-type":"text/event-stream"}}),flush=True)
    for frame in [b'data: {"a":1}\\n\\n',b'data: {"b":2}\\n\\n']:
        print(json.dumps({"id":req["id"],"data":base64.b64encode(frame).decode()}),flush=True)
    print(json.dumps({"id":req["id"],"done":True}),flush=True)
`);
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  const bridge=bridgeTransport()!;
  expect(bridge).toBeDefined();
  const response=await bridge.start('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse','ya29.test','{"model":"m"}');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  const text=await response.text();
  expect(text).toContain('{"a":1}');
  expect(text).toContain('{"b":2}');
  closeBridge();
  rmSync(dir,{recursive:true,force:true});
 },20_000);

 test('refuses to carry the token to a foreign host before any bytes are written',async()=>{
  const {path,dir}=fakeBridge(`
import sys
with open('%LOG%','w') as log:
    for line in sys.stdin:
        log.write(line)
`);
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  const bridge=bridgeTransport()!;
  await expect(bridge.start('https://example.com/steal','ya29.secret','{}')).rejects.toThrow(/only be sent to the Antigravity/);
  closeBridge();
  expect(()=>readFileSync(join(dir,'seen.jsonl'))).toThrow();
  rmSync(dir,{recursive:true,force:true});
 },20_000);

 test('an abort sends the cancel line and rejects the request',async()=>{
  const {path,dir}=fakeBridge(`
import json,sys
for line in sys.stdin:
    req=json.loads(line)
    if req.get("cancel"):
        with open('%LOG%','a') as log: log.write('cancel:'+req['id']+'\\n')
        break
    with open('%LOG%','a') as log: log.write('start:'+req['id']+'\\n')
    # never answer the request: the caller must give up on its own
`);
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  const bridge=bridgeTransport()!;
  const controller=new AbortController();
  const pending=bridge.start('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse','ya29.test','{"model":"m"}',controller.signal);
  setTimeout(()=>controller.abort(),150);
  await expect(pending).rejects.toThrow(/cancelled/);
  // The child flushes asynchronously; wait for both log lines.
  const seen=await new Promise<string>((resolve,reject)=>{
   const deadline=Date.now()+5000;
   const poll=()=>{try{const value=readFileSync(join(dir,'seen.jsonl'),'utf8');if(value.includes('cancel:'))resolve(value);else if(Date.now()>deadline)reject(new Error('fake bridge did not log the cancel line: '+value));else setTimeout(poll,50)}catch(error){if(Date.now()>deadline)throw error;setTimeout(poll,50)}};
   poll();
  });
  expect(seen).toMatch(/^start:/);
  expect(seen).toMatch(/cancel:/);
  closeBridge();
  rmSync(dir,{recursive:true,force:true});
 },20_000);
 test('an abort after response headers cancels the remote stream and rejects its body',async()=>{
  const {path,dir}=fakeBridge(`
import json,sys
for line in sys.stdin:
    req=json.loads(line)
    if req.get("cancel"):
        with open('%LOG%','a') as log: log.write('cancel:'+req['id']+'\\n')
        break
    print(json.dumps({"id":req["id"],"status":200,"headers":{"content-type":"text/event-stream"}}),flush=True)
`);
  process.env.CHIMERIC_ANTIGRAVITY_BRIDGE=path;
  try{
   const controller=new AbortController();
   const response=await bridgeTransport()!.start('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse','synthetic-access','{}',controller.signal);
   expect(response.status).toBe(200);
   const body=response.text();controller.abort();
   await expect(body).rejects.toThrow(/cancelled/);
   const seen=await new Promise<string>((resolve,reject)=>{
    const deadline=Date.now()+5000;
    const poll=()=>{
     try{const value=readFileSync(join(dir,'seen.jsonl'),'utf8');if(value.includes('cancel:'))return resolve(value)}catch{}
     if(Date.now()>deadline)return reject(new Error('The child never received the streaming cancellation.'));
     setTimeout(poll,10);
    };poll();
   });
   expect(seen).toMatch(/^cancel:/);
  }finally{closeBridge();rmSync(dir,{recursive:true,force:true})}
 },20_000);
});

describe('provider over the bridge',()=>{
 const cleanup:Array<()=>void>=[];
 afterEach(()=>{for(const fn of cleanup)fn();cleanup.length=0;closeBridge()});

 test('streams SSE events through an injected bridge transport',async()=>{
  const body=sse([
   '{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"BRIDGE_OK"}]}}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1,"totalTokenCount":4}}}',
   '{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}}',
  ]);
  let asked:{url:string;token:string;body:string}|undefined;
  const fake:BridgeLike={
   alive:true,
   async start(url,token,requestBody){
    asked={url,token,body:requestBody};
    return new Response(body,{status:200,headers:{'content-type':'text/event-stream'}});
   },
   close(){},
  };
  bridgeTest.factory=()=>fake;
  cleanup.push(()=>{bridgeTest.factory=undefined});
  const events=streamAntigravityHttp(model,context('hi'),{apiKey:'ya29.via-bridge',packetTransport:'bridge'});
  let text='';
  for await(const event of events)if(event.type==='text_delta')text+=event.delta;
  const done=await events.result();
  expect(text).toBe('BRIDGE_OK');
  expect(done.stopReason).toBe('stop');
  expect(asked?.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse');
  expect(asked?.token).toBe('ya29.via-bridge');
  expect(JSON.parse(asked!.body).model).toBe('gemini-4-argon-medium');
  expect(JSON.parse(asked!.body).requestId).toMatch(/^[0-9a-f-]{36}$/);
 });

 test('the bridge path surfaces HTTP errors with status and body',async()=>{
  const fake:BridgeLike={
   alive:true,
   async start(){return new Response('{"error":"quota"}',{status:429,headers:{'content-type':'application/json','retry-after':'30'}})},
   close(){},
  };
  bridgeTest.factory=()=>fake;
  const events=streamAntigravityHttp(model,context('hi'),{apiKey:'ya29.x',packetTransport:'bridge'});
  const done=await events.result();
  expect(done.stopReason).toBe('error');
  expect(done.errorMessage).toContain('429');
  expect(done.errorMessage).toContain('30');
  expect(done.errorMessage).not.toContain('ya29.x');
 });

 test('packetTransport fetch keeps the injected-fetch path unchanged',async()=>{
  let called=false;
  const fetchStub=(async()=>{called=true;return new Response(sse(['{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"FETCH_OK"}]}}],"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}','{"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}]}}']),{status:200,headers:{'content-type':'text/event-stream'}})}) as unknown as typeof fetch;
  const events=streamAntigravityHttp(model,context('hi'),{apiKey:'ya29.z',fetch:fetchStub});
  let text='';
  for await(const event of events)if(event.type==='text_delta')text+=event.delta;
  await events.result();
  expect(called).toBe(true);
  expect(text).toBe('FETCH_OK');
 });
});
