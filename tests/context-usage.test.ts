import {afterEach,expect,test} from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {Database} from 'bun:sqlite';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBridge} from '../src/bridge';
import {messageContextUsage,nativeMessage,nativeUsage,type ContextUsage,type ContextUsageMessage} from '../src/protocol';
import {UsageManager} from '../src/usage-manager';

const cleanups:Array<()=>void>=[];
afterEach(()=>{for(const close of cleanups.splice(0).reverse())close()});
const aggregate={input:350000,output:120,cacheRead:800000,cacheWrite:10000};
const occupied:ContextUsage={input:10000,output:120,cacheRead:200000,cacheWrite:5000};
const nativeOccupied={input_tokens:10000,output_tokens:120,cache_read_input_tokens:200000,cache_creation_input_tokens:5000};
const model:any={id:'fixture',qualifiedId:'synthetic-subscription::fixture',name:'Synthetic subscription model',provider:'synthetic-subscription',api:'claude-code',baseUrl:'https://official-client.example.invalid',input:['text'],mode:'chat',contextWindow:1000000,maxTokens:128000,reasoning:false,replayKey:'synthetic-subscription@one',requestTimeoutMs:2000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
function message(usage=aggregate,contextUsage:ContextUsage|null=occupied,content:any[]=[{type:'text',text:'A synthetic answer.'}]):ContextUsageMessage{
 return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content,
  usage:{...usage,totalTokens:usage.input+usage.output+usage.cacheRead+usage.cacheWrite,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
  ...contextUsage?{contextUsage}:{},stopReason:content.some(block=>block.type==='toolCall')?'toolUse':'stop',timestamp:1};
}
function fixture(replies:ContextUsageMessage[],executor?:any){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-context-usage-'));
 mkdirSync(join(profileDir,'local-auth'),{mode:0o700});
 const contexts:any[]=[];let requests=0;
 const driver={available:()=>true,connectionGeneration:()=>1,
  async *stream(_model:any,context:any){
   contexts.push(structuredClone(context));
   const result=structuredClone(replies[requests++]);if(!result)throw Error('Unexpected synthetic model request');
   yield {type:'start',partial:result};
   for(const [contentIndex,block] of result.content.entries()){
    const shared={contentIndex,partial:result};
    if(block.type==='text'){
     yield {type:'text_start',...shared};yield {type:'text_delta',...shared,delta:block.text};yield {type:'text_end',...shared,content:block.text};
    }else if(block.type==='toolCall'){
     yield {type:'toolcall_start',...shared};yield {type:'toolcall_delta',...shared,delta:JSON.stringify(block.arguments)};yield {type:'toolcall_end',...shared,toolCall:block};
    }
   }
   yield {type:'done',reason:result.stopReason,message:result};
  }};
 const registry:any={profileDir,config:{providers:{[model.provider]:{name:'Synthetic subscription',api:model.api,baseUrl:model.baseUrl,revision:1,enabled:true}}},models:new Map([[model.qualifiedId,model]]),statuses:{[model.provider]:{ready:true}},claudeCode:driver,
  resolve:(id:string)=>{if(id!==model.qualifiedId)throw Error('Unknown synthetic model');return model},currentSelection:()=>({model:model.qualifiedId}),requestAuth:async()=>({apiKey:'synthetic-no-remote-credential'}),safeError:(error:any)=>String(error?.message??error)};
 registry.usage=new UsageManager(registry);
 const bridge=startBridge(registry,'synthetic-context-bridge-token',0,executor);
 const client=new Anthropic({baseURL:bridge.url.href,apiKey:'synthetic-context-bridge-token',maxRetries:0,timeout:3000});
 cleanups.push(()=>{bridge.stop(true);rmSync(profileDir,{recursive:true,force:true})});
 const request=(messages:any[]=[{role:'user',content:'A fixed synthetic question.'}],extra:any={})=>({model:model.qualifiedId,max_tokens:4096,messages,...extra});
 return {profileDir,client,contexts,registry,request,call:async(messages?:any[],extra?:any)=>await client.messages.create(request(messages,extra) as any),tracked:()=>registry.usage.snapshot().connections[0].tracked};
}

test('native usage selects context occupancy while aggregate accounting remains unchanged',()=>{
 const value=message();
 expect(nativeUsage(value)).toEqual(nativeOccupied);
 expect(nativeMessage(value,model.qualifiedId,'synthetic-message').usage).toEqual(nativeOccupied);
 expect(value.usage).toMatchObject(aggregate);
 expect(messageContextUsage(structuredClone(value))).toEqual(occupied);
 const ordinary=message(aggregate,null);
 expect(nativeUsage(ordinary)).toEqual({input_tokens:aggregate.input,output_tokens:aggregate.output,cache_read_input_tokens:aggregate.cacheRead,cache_creation_input_tokens:aggregate.cacheWrite});
 expect(messageContextUsage(ordinary)).toBeUndefined();
});

test('malformed explicit context accounting cannot silently become native token counts',()=>{
 for(const value of [null,[],{}, {...occupied,input:-1},{...occupied,cacheRead:NaN},{...occupied,output:0.5},{...occupied,cacheWrite:Number.MAX_SAFE_INTEGER+1},{...occupied,input:'10000'}]){
  expect(()=>nativeUsage({...message(),contextUsage:value} as any)).toThrow('invalid context token accounting');
 }
});

test('non-streaming native responses and replay retain context counts while the usage UI records billed totals',async()=>{
 const f=fixture([message(),message(aggregate,occupied,[{type:'text',text:'A second synthetic answer.'}])]);
 const first:any=await f.call();
 expect(first.usage).toEqual(nativeOccupied);
 expect(first).not.toHaveProperty('contextUsage');
 expect(f.tracked()).toMatchObject({...aggregate,requests:1,estimatedUsd:null});
 const db=new Database(join(f.profileDir,'provider/replay.db'),{readonly:true});
 try{
  const saved=JSON.parse((db.query('SELECT message FROM replay').get() as any).message);
  expect(saved.contextUsage).toEqual(occupied);expect(saved.usage).toMatchObject(aggregate);
 }finally{db.close()}
 const next:any=await f.call([{role:'user',content:'A fixed synthetic question.'},{role:'assistant',content:first.content},{role:'user',content:'Continue.'}]);
 expect(next.usage).toEqual(nativeOccupied);
 expect(f.contexts[1].messages.find((entry:any)=>entry.role==='assistant').usage).toMatchObject(aggregate);
 expect(f.tracked()).toMatchObject({input:aggregate.input*2,output:aggregate.output*2,cacheRead:aggregate.cacheRead*2,cacheWrite:aggregate.cacheWrite*2,requests:2,estimatedUsd:null});
 const completed=readFileSync(join(f.profileDir,'provider/requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.event==='complete');
 expect(completed).toHaveLength(2);expect(completed[0]).toMatchObject({inputTokens:aggregate.input,outputTokens:aggregate.output});
});

test('the real native SSE consumer receives context occupancy without changing aggregate accounting',async()=>{
 const f=fixture([message()]);
 const stream=f.client.messages.stream(f.request() as any);
 const final=await stream.finalMessage();
 expect(final.usage).toMatchObject(nativeOccupied);
 expect(final.content).toEqual([{type:'text',text:'A synthetic answer.'}]);
 expect(f.tracked()).toMatchObject({...aggregate,requests:1,estimatedUsd:null});
});

for(const separateContext of [true,false])test('server-tool continuation '+(separateContext?'uses only the last occupied context':'retains legacy aggregate semantics')+' while billing every round',async()=>{
 const firstUsage={input:1000,output:10,cacheRead:100,cacheWrite:20},lastUsage={input:2000,output:15,cacheRead:200,cacheWrite:30};
 const firstContext={input:100,output:10,cacheRead:50,cacheWrite:5},lastContext={input:200,output:15,cacheRead:75,cacheWrite:8};
 const first=message(firstUsage,separateContext?firstContext:null,[{type:'toolCall',id:'synthetic-search',name:'web_search',arguments:{query:'synthetic'}}]);
 const last=message(lastUsage,separateContext?lastContext:null);
 const f=fixture([first,last],async()=>({query:'synthetic',results:[]}));
 const result:any=await f.call(undefined,{tools:[{name:'web_search',type:'web_search_20250305'}]});
 expect(result.usage).toEqual(separateContext?{input_tokens:200,output_tokens:15,cache_read_input_tokens:75,cache_creation_input_tokens:8}:{input_tokens:3000,output_tokens:25,cache_read_input_tokens:200,cache_creation_input_tokens:30});
 expect(f.contexts).toHaveLength(2);
 expect(f.tracked()).toMatchObject({input:3000,output:25,cacheRead:300,cacheWrite:50,requests:2,estimatedUsd:null});
});
