import {afterEach,expect,test} from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {Database} from 'bun:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBridge} from '../src/bridge';
import {ConfidentialityManager} from '../src/confidentiality-manager';

const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn()});
const visible='The same visible answer.';
const histories=(record:any)=>record.body.messages.filter((message:any)=>message.role==='assistant').flatMap((message:any)=>Array.isArray(message.content)?message.content:[]);
function reply(turn:number){
 const events=[
  {type:'message_start',message:{id:'synthetic-message-'+turn,type:'message',role:'assistant',model:'claude-sonnet-4-5',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:5,output_tokens:0}}},
  {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:''}},
  {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'Synthetic private reasoning '+turn}},
  {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signature-'+turn}},
  {type:'content_block_stop',index:0},
  {type:'content_block_start',index:1,content_block:{type:'text',text:''}},
  {type:'content_block_delta',index:1,delta:{type:'text_delta',text:visible}},
  {type:'content_block_stop',index:1},
  {type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:9}},
  {type:'message_stop'},
 ];return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
function fixture(){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-replay-scope-')),requests:any[]=[],authorizations:any[]=[],state={authSession:'synthetic-provider-session-A'};
 const mock=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){expect(new URL(request.url).pathname).toBe('/v1/messages');const record={body:await request.json(),headers:new Headers(request.headers)};requests.push(record);return reply(requests.length)}});
 const model:any={id:'claude-sonnet-4-5',provider:'synthetic',qualifiedId:'synthetic::claude-sonnet-4-5',name:'Synthetic reasoning model',mode:'chat',api:'anthropic-messages',baseUrl:'https://synthetic-provider.example.invalid',replayKey:'synthetic-model@binding',input:['text'],maxTokens:4096,contextWindow:8192,reasoning:true,reasoningEfforts:{high:'high'},defaultReasoningEffort:'high',cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{},requestTimeoutMs:2500};
 const fetcher=(async(input:any,init:any)=>{
  const request=new Request(input,init),url=new URL(request.url);if(url.origin!=='https://synthetic-provider.example.invalid')throw Error('Unexpected synthetic provider origin');
  return await fetch(new URL(url.pathname+url.search,mock.url),{method:request.method,headers:request.headers,body:await request.arrayBuffer(),signal:request.signal});
 }) as typeof fetch;
 const registry:any={profileDir,config:{providers:{synthetic:{name:'Synthetic provider',baseUrl:model.baseUrl,api:model.api,revision:'one',enabled:true}}},state:{model:model.qualifiedId},statuses:{synthetic:{ready:true}},models:new Map([[model.qualifiedId,model]]),getPrivateCredential:()=> 'synthetic-key-for-loopback-only',resolve:(id:string)=>{if(id!==model.qualifiedId)throw Error('Unknown synthetic model');return model},requestAuth:async()=>({apiKey:'synthetic-key-for-loopback-only',sessionScope:state.authSession,fetch:fetcher}),safeError:(error:any)=>String(error?.message??error)};
 const frames:any={
  'root-a':{frameId:'root-a',rootFrameId:'root-a',projectId:'project-a',ownerId:'owner',organizationId:'org'},
  'child-a':{frameId:'child-a',rootFrameId:'root-a',parentFrameId:'root-a',projectId:'project-a',ownerId:'owner',organizationId:'org'},
  'root-b':{frameId:'root-b',rootFrameId:'root-b',projectId:'project-b',ownerId:'owner',organizationId:'org'},
 };
 const manager=new ConfidentialityManager(registry, {protectionEvidence:()=>({verified:true}),owner:{userId:'owner',organizationId:'org'},lookupFrame:(_profile,id)=>frames[id],transport:async()=>{throw Error('No external-access request is allowed by this test')}});
 const token='synthetic-local-replay-bridge-token',bridge=startBridge(registry,token,0,undefined,{async authorize(request,body){const authorization=await manager.authorize(request,body);authorizations.push(authorization);return authorization}}),client=new Anthropic({baseURL:bridge.url.href,apiKey:token,maxRetries:0,timeout:3000});
 cleanup.push(()=>{manager.close();bridge.stop(true);mock.stop(true);rmSync(profileDir,{recursive:true,force:true})});
 const call=async(frameId?:string,continuation=false)=>{
  const headers=manager.scope.requestOptions(frameId?{frameId}:{},{},{}).headers;
  return await client.messages.create({model:model.qualifiedId,max_tokens:4096,messages:[{role:'user',content:'Fixed synthetic research question.'},...continuation?[{role:'assistant',content:[{type:'text',text:visible}]},{role:'user',content:'Continue the synthetic answer.'}]:[]]} as any,{headers});
 };
 const enable=async()=>{await manager.approveConnection({connectionId:'synthetic',expectedRevision:0,purposes:['model']});for(const frameId of ['root-a','root-b'])await manager.setMode({frameId,expectedRevision:0,mode:'class2',main:model.qualifiedId,reviewer:model.qualifiedId})};
 return {profileDir,manager,model,state,requests,authorizations,frames,call,enable};
}

test('real bridge isolates identical visible replies across protected roots while preserving same-root descendant reasoning and signatures',async()=>{
 const f=fixture();await f.enable();const first:any=await f.call('root-a'),second:any=await f.call('root-b');
 expect(first.content).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 1',signature:'synthetic-signature-1'});expect(second.content).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 2',signature:'synthetic-signature-2'});
 await f.call('child-a',true);expect(histories(f.requests[2])).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 1',signature:'synthetic-signature-1'});expect(JSON.stringify(histories(f.requests[2]))).not.toContain('private reasoning 2');expect(JSON.stringify(histories(f.requests[2]))).not.toContain('signature-2');
 await f.call('root-b',true);expect(histories(f.requests[3])).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 2',signature:'synthetic-signature-2'});expect(JSON.stringify(histories(f.requests[3]))).not.toContain('private reasoning 3');
 expect(f.authorizations[0].replayNamespace).toBe(f.authorizations[2].replayNamespace);expect(f.authorizations[0].replayNamespace).not.toBe(f.authorizations[1].replayNamespace);expect(f.requests).toHaveLength(4);
 for(const record of f.requests){expect(record.headers.has('x-chimeric-session-scope')).toBe(false);expect(JSON.stringify(record.body)).not.toContain('__chimeric_scope');for(const authorization of f.authorizations)expect(JSON.stringify(record.body)).not.toContain(authorization.replayNamespace)}
 const db=new Database(join(f.profileDir,'provider/replay.db'),{readonly:true});try{const keys=db.query('SELECT model FROM replay').all() as any[];expect(keys).toHaveLength(2);for(const key of keys){expect(key.model).toMatch(/@native-root:[a-f0-9]{64}@synthetic-provider-session-A$/);for(const raw of ['root-a','root-b','project-a','project-b'])expect(key.model).not.toContain(raw)}}finally{db.close()}
},10000);
test('provider auth-session rotation stays partitioned inside a root and does not overwrite the root namespace',async()=>{
 const f=fixture();await f.enable();await f.call('root-a');f.state.authSession='synthetic-provider-session-B';await f.call('root-a',true);expect(histories(f.requests[1]).some((block:any)=>block.type==='thinking')).toBe(false);
 f.state.authSession='synthetic-provider-session-A';await f.call('root-a',true);expect(histories(f.requests[2])).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 1',signature:'synthetic-signature-1'});expect(JSON.stringify(histories(f.requests[2]))).not.toContain('private reasoning 2');expect(f.authorizations[0].replayNamespace).toBe(f.authorizations[1].replayNamespace);
},10000);
test('unscoped standard calls never reuse another call reasoning even when their visible assistant reply matches',async()=>{
 const f=fixture();await f.call();await f.call(undefined,true);expect(histories(f.requests[1]).some((block:any)=>block.type==='thinking')).toBe(false);expect(f.authorizations[0].replayNamespace).toMatch(/^[a-f0-9]{64}$/);expect(f.authorizations[0].replayNamespace).not.toBe(f.authorizations[1].replayNamespace);
},10000);
test('new standard bootstrap replay is valid within its native request lifetime and isolated from the next request',async()=>{
 const f=fixture();await f.manager.scope.withNewStandardRequest(async()=>{await f.call();await f.call(undefined,true)});expect(histories(f.requests[1])).toContainEqual({type:'thinking',thinking:'Synthetic private reasoning 1',signature:'synthetic-signature-1'});expect(f.authorizations[0].replayNamespace).toBe(f.authorizations[1].replayNamespace);
 await f.manager.scope.withNewStandardRequest(async()=>{await f.call(undefined,true)});expect(histories(f.requests[2]).some((block:any)=>block.type==='thinking')).toBe(false);expect(f.authorizations[0].replayNamespace).not.toBe(f.authorizations[2].replayNamespace);
},10000);
