import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {startBridge} from '../src/bridge';

async function failureEvent(httpStatus:unknown,message='Synthetic upstream failure') {
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-bridge-error-'));
 let calls=0;
 const model={api:'antigravity-http',provider:'antigravity-http',id:'gemini-4-carbon-high',qualifiedId:'antigravity-http::gemini-4-carbon',replayKey:'synthetic-binding',input:['text'],maxTokens:128,reasoning:false,requestTimeoutMs:1000};
 const registry:any={profileDir,config:{searchUrl:''},state:{model:model.qualifiedId},resolve:()=>model,requestAuth:async()=>({apiKey:'synthetic-key'}),safeError:(error:any)=>String(error?.message??error),
  antigravityHttp:{stream(){calls++;const events=new AssistantMessageEventStream();queueMicrotask(()=>{events.push({type:'error',reason:'error',error:{role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:'error',errorMessage:message,httpStatus}} as any);events.end()});return events;}}};
 const bridge=startBridge(registry,'synthetic-local-token');
 try{
  const response=await fetch(new URL('v1/messages',bridge.url),{method:'POST',headers:{'x-api-key':'synthetic-local-token','content-type':'application/json'},body:JSON.stringify({model:model.qualifiedId,max_tokens:128,stream:true,messages:[{role:'user',content:'Synthetic request.'}]})});
  const raw=await response.text(),events=raw.split('\n').filter(line=>line.startsWith('data: ')).map(line=>JSON.parse(line.slice(6))),failure=events.find(event=>event.type==='error');
  return {response,failure,calls};
 }finally{bridge.stop(true);rmSync(profileDir,{recursive:true,force:true})}
}

for(const [status,type] of [[400,'invalid_request_error'],[401,'authentication_error'],[403,'permission_error'],[404,'not_found_error'],[429,'invalid_request_error']] as const) {
 test(`AGY HTTP ${status} reaches the native stream as terminal ${type}`,async()=>{
  const result=await failureEvent(status);
  expect(result.response.status).toBe(200);
  expect(result.failure.error).toEqual({type,message:'Synthetic upstream failure'});
  expect(result.calls).toBe(1);
 });
}
test('AGY transient HTTP failures retain the native server-error category',async()=>{
 const result=await failureEvent(503);
 expect(result.failure.error.type).toBe('api_error');expect(result.calls).toBe(1);
});
test('AGY error text does not determine whether the native consumer retries',async()=>{
 for(const status of [undefined,'400',NaN,200]){
  const result=await failureEvent(status,'Synthetic note mentioning HTTP 400.');
  expect(result.failure.error.type).toBe('api_error');
 }
});
