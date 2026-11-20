import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {zstdDecompressSync} from 'node:zlib';
import {SubscriptionManager,SubscriptionVault} from '../src/subscription';

const jwt=(suffix='old')=>'header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture-account'}})).toString('base64url')+'.'+suffix;
const model=(baseUrl:string)=>({id:'gpt-6.1-sol',qualifiedId:'openai-codex::gpt-6.1-sol',provider:'openai-codex',name:'Fixture',api:'openai-codex-responses',baseUrl,input:['text'],reasoning:false,contextWindow:10000,maxTokens:128,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} as any);
function fixture(options:any={}){const directory=mkdtempSync(join(tmpdir(),'chimeric-subscription-check-')),vault=new SubscriptionVault(join(directory,'auth'));vault.write({session:randomUUID(),version:randomUUID(),credential:{type:'oauth',access:jwt(),refresh:'synthetic-refresh',expires:Date.now()+3600000}});const manager=new SubscriptionManager(vault,options);return{vault,manager,close(){manager.close();rmSync(directory,{recursive:true,force:true})}}}
function stream(text='CHIMERIC_CONNECTION_OK'){
 const item={id:'message_fixture',type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]},response={id:'resp_fixture',object:'response',created_at:1,status:'completed',model:'gpt-6.1-sol',output:[item],usage:{input_tokens:5,output_tokens:1,total_tokens:6,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}

test('subscription credentials and refresh bodies never follow actual HTTP redirects',async()=>{
 let reachedCodex=false,reachedRefresh=false;const originalFetch=globalThis.fetch;
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request){const path=new URL(request.url).pathname;if(path==='/codex'||path==='/refresh')return new Response(null,{status:307,headers:{location:'/captured-'+path.slice(1)}});if(path==='/captured-codex')reachedCodex=true;if(path==='/captured-refresh')reachedRefresh=true;return Response.json({access_token:jwt('new'),refresh_token:'new-refresh',expires_in:3600})}});
 const f=fixture({endpoint:upstream.url.href+'codex',fetch:(async(input:any,init:any)=>originalFetch(String(input).includes('/oauth/token')?upstream.url.href+'refresh':input,init)) as typeof fetch});
 try{const auth=await f.manager.requestAuth();await expect(auth.fetch(upstream.url.href+'codex',{redirect:'follow'})).rejects.toThrow();expect(reachedCodex).toBe(false);const record=f.vault.read()!;f.vault.write({...record,version:randomUUID(),credential:{...record.credential!,expires:0}});await expect(f.manager.requestAuth()).rejects.toThrow('temporarily');expect(reachedRefresh).toBe(false);expect(f.manager.status().connected).toBe(true)}finally{f.close();upstream.stop(true)}
});

test('connection check uses the production Codex stream, synthetic text and credential-bound status',async()=>{
 let body:any;const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const raw=Buffer.from(await request.arrayBuffer());body=JSON.parse(request.headers.get('content-encoding')==='zstd'?zstdDecompressSync(raw).toString():raw.toString());return stream()}});
 const f=fixture({endpoint:upstream.url.href+'codex/responses'});
 try{expect(f.manager.status().connectionCheck).toBeUndefined();const result=await f.manager.check(model(upstream.url.href));expect(result.connectionCheck?.status).toBe('passed');expect(result.connectionCheck?.model).toBe('openai-codex::gpt-6.1-sol');expect(body.input).toHaveLength(1);expect(JSON.stringify(body.input)).toContain('Reply with exactly CHIMERIC_CONNECTION_OK.');expect(body.store).toBe(false);expect(JSON.stringify(result)).not.toContain('synthetic-refresh');expect(JSON.stringify(result)).not.toContain(jwt());const previous=f.vault.read()!;f.vault.write({...previous,version:randomUUID()});expect(f.manager.status().connectionCheck).toBeUndefined()}finally{f.close();upstream.stop(true)}
});

test('a wrong synthetic response fails without exposing its body',async()=>{
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>stream('provider-private-diagnostic')});const f=fixture({endpoint:upstream.url.href+'codex/responses'});
 try{const result=await f.manager.check(model(upstream.url.href));expect(result.connectionCheck?.status).toBe('failed');expect(JSON.stringify(result)).not.toContain('provider-private-diagnostic')}finally{f.close();upstream.stop(true)}
});

test('a connection-check timeout is bounded and leaves stored login intact',async()=>{
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'))}}),{headers:{'content-type':'text/event-stream'}})});const f=fixture({endpoint:upstream.url.href+'codex/responses',checkTimeoutMs:40});
 try{const before=Date.now(),result=await f.manager.check(model(upstream.url.href));expect(Date.now()-before).toBeLessThan(2000);expect(result.connectionCheck?.status).toBe('failed');expect(result.connectionCheck?.message).toContain('timed out');expect(result.connected).toBe(true)}finally{f.close();upstream.stop(true)}
});

test('disconnect invalidates an in-flight check and cannot restore its result',async()=>{
 let started!:()=>void;const ready=new Promise<void>(resolve=>started=resolve);let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 const upstream=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(){started();await gate;return stream()}});const f=fixture({endpoint:upstream.url.href+'codex/responses'});
 try{const check=f.manager.check(model(upstream.url.href));await ready;f.manager.disconnect();release();const result=await check;expect(result.connected).toBe(false);expect(result.connectionCheck).toBeUndefined();expect(f.vault.read()?.credential).toBeNull()}finally{release();f.close();upstream.stop(true)}
});

test('401 renewal inside a check binds verification to the credential actually sent',async()=>{
 let calls=0,refreshes=0;const upstream=Bun.serve({hostname:'127.0.0.1',port:0,fetch(){return ++calls===1?new Response(null,{status:401}):stream()}});const originalFetch=globalThis.fetch;
 const f=fixture({endpoint:upstream.url.href+'codex/responses',fetch:(async(input:any,init:any)=>{if(String(input).includes('/oauth/token')){refreshes++;return Response.json({access_token:jwt('new'),refresh_token:'renewed-refresh',expires_in:3600})}return originalFetch(input,init)}) as typeof fetch});
 try{const result=await f.manager.check(model(upstream.url.href));expect(result.connectionCheck?.status).toBe('passed');expect(refreshes).toBe(1);expect(calls).toBe(2);expect(f.vault.read()?.credential?.refresh).toBe('renewed-refresh')}finally{f.close();upstream.stop(true)}
});

test('sign-in errors expose a fixed actionable category without raw token responses',async()=>{
 const f=fixture({callbackAvailable:async()=>true,oauth:{login:async(_interaction:any,options:any)=>{expect(options.agentName).toBe('Chimeric');throw Error('OpenAI Codex token exchange failed (400): synthetic-secret-response')}}});
 try{await f.manager.start('browser');await Bun.sleep(0);const result=f.manager.status();expect(result.login?.phase).toBe('error');expect(result.login?.errorCode).toBe('authorization_rejected');expect(result.login?.message).toContain('fresh sign-in');expect(JSON.stringify(result)).not.toContain('synthetic-secret-response')}finally{f.close()}
});
