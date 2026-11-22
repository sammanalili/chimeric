import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ImageGenerationManager} from '../src/image-generation-manager';
import {OPENAI_IMAGE_MODELS,OPENAI_SUBSCRIPTION_IMAGE_MODEL} from '../src/image-generation';

const cleanup:Array<()=>Promise<void>>=[];afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close()});
function fixture(){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-image-choice-review-'));
 let chatConnected=true,googleConnected=true,catalog=[{id:'synthetic-google-image',name:'Synthetic Google Image'}];
 const apiCalls:any[]=[],googleCalls:any[]=[],model=(id:string,api:string,baseUrl:string)=>({id:'synthetic-chat',provider:id,qualifiedId:id+'::synthetic-chat',api,baseUrl,input:['text'],reasoning:false,maxTokens:1024,contextWindow:128000,replayKey:id+'@initial'});
 const registry:any={profileDir,config:{providers:{
  paid:{name:'Synthetic API',api:'openai-responses',baseUrl:'https://api.openai.com/v1',enabled:true,revision:'api-v1'},
  chat:{name:'ChatGPT',api:'openai-codex-responses',baseUrl:'https://chatgpt.com/backend-api',enabled:true,revision:'subscription-v1'},
  google:{name:'Synthetic Google',api:'antigravity-http',baseUrl:'https://daily-cloudcode-pa.googleapis.com',enabled:true,revision:'google-v1'},
 }},models:new Map([
  ['paid::synthetic-chat',model('paid','openai-responses','https://api.openai.com/v1')],
  ['chat::synthetic-chat',model('chat','openai-codex-responses','https://chatgpt.com/backend-api')],
 ]),statuses:{paid:{ready:true}},getPrivateCredential:()=> 'SYNTHETIC_API_KEY',safeError:(e:any)=>String(e?.message??e),
 subscription:{status:()=>({connected:chatConnected}),vault:{read:()=>chatConnected?{session:'synthetic-chat-session'}:null}},
 antigravityHttp:{imageCatalog:()=>catalog,available:()=>googleConnected,project:()=> 'synthetic-project',auth:{status:()=>({connected:googleConnected}),vault:{read:()=>googleConnected?{session:'synthetic-google-session'}:null},requestAuth:async()=>({apiKey:'SYNTHETIC_GOOGLE_TOKEN'})},runRequest:async(run:any,signal:any)=>run(signal)},
 requestAuth:async()=>({apiKey:'SYNTHETIC_API_KEY'})};
 const manager=new ImageGenerationManager(registry,{generate:async request=>{apiCalls.push(request);throw Error('Synthetic API failure')},generateAntigravity:async request=>{googleCalls.push(request);throw Error('Synthetic Google quota failure')}});
 cleanup.push(async()=>{await manager.close();rmSync(profileDir,{recursive:true,force:true})});
 const host:any={projectId:'project',rootFrameId:'root',frameId:'root',agentName:'OPERON',_artifactSvcImpl:{save_artifact:async()=>{throw Error('No artifact should be saved after this injected failure')}},_fullStore:{}};
 return {manager,registry,apiCalls,googleCalls,host,disconnectChat:()=>{chatConnected=false},disconnectGoogle:()=>{googleConnected=false},catalog:(next:typeof catalog)=>{catalog=next}};
}

test('A disconnected ChatGPT image model never silently chooses a ready paid API',()=>{
 const f=fixture();f.disconnectChat();const snapshot=f.manager.snapshot(),chat=snapshot.quickChoices.find(choice=>choice.connectionId==='chat'&&choice.imageModel===OPENAI_SUBSCRIPTION_IMAGE_MODEL)!;
 expect(snapshot.providers.find(p=>p.id==='paid')?.ready).toBe(true);expect(chat).toMatchObject({connectionId:'chat',billing:'subscription',imageModel:OPENAI_SUBSCRIPTION_IMAGE_MODEL,ready:false,label:'ChatGPT subscription · GPT Image 2'});
 expect(()=>f.manager.configure({expectedRevision:0,connectionId:chat.connectionId,imageModel:chat.imageModel})).toThrow('ready image-generation');
 expect(f.manager.snapshot().selected).toBeNull();expect(f.apiCalls).toHaveLength(0);
});

test('An explicitly selected API model remains visibly API-billed and never falls back to ChatGPT on outage',async()=>{
 const f=fixture();f.manager.configure({expectedRevision:0,connectionId:'paid',imageModel:OPENAI_IMAGE_MODELS[0]});f.registry.statuses.paid.ready=false;
 const snapshot=f.manager.snapshot(),choice=snapshot.quickChoices.find(choice=>choice.connectionId==='paid'&&choice.imageModel===OPENAI_IMAGE_MODELS[0])!;
 expect(choice).toMatchObject({connectionId:'paid',billing:'api',imageModel:OPENAI_IMAGE_MODELS[0],ready:false,label:'Synthetic API · '+OPENAI_IMAGE_MODELS[0]});expect(snapshot.providers.find(p=>p.id==='chat')?.ready).toBe(true);
 expect(await f.manager.execute(f.host,{id:'synthetic-image-request'},{prompt:'Synthetic red square'})).toMatchObject({status:'error'});
 expect(f.manager.snapshot().selected).toEqual({connectionId:'paid',imageModel:OPENAI_IMAGE_MODELS[0]});expect(f.apiCalls).toHaveLength(0);
});

test('Google generation failure keeps the exact subscription selection and performs no API fallback',async()=>{
 const f=fixture();f.manager.configure({expectedRevision:0,connectionId:'google',imageModel:'synthetic-google-image'});
 expect(await f.manager.execute(f.host,{id:'synthetic-google-request'},{prompt:'Synthetic blue circle'})).toMatchObject({status:'error',error:'Synthetic Google quota failure'});
 expect(f.googleCalls).toHaveLength(1);expect(f.googleCalls[0]).toMatchObject({route:'antigravity',imageModel:'synthetic-google-image'});expect(f.apiCalls).toHaveLength(0);
 expect(f.manager.snapshot().selected).toEqual({connectionId:'google',imageModel:'synthetic-google-image'});
 f.disconnectGoogle();expect(f.manager.snapshot().quickChoices.find(c=>c.connectionId==='google'&&c.imageModel==='synthetic-google-image')).toMatchObject({connectionId:'google',billing:'subscription',ready:false,label:'Synthetic Google · Synthetic Google Image'});
});

test('A removed selected image model remains visible as unavailable rather than being relabelled',()=>{
 const f=fixture();f.manager.configure({expectedRevision:0,connectionId:'google',imageModel:'synthetic-google-image'});f.catalog([{id:'synthetic-new-google-image',name:'Synthetic New Google Image'}]);
 const snapshot=f.manager.snapshot(),selected=snapshot.selectedChoice!;
 expect(snapshot.providers.find(p=>p.id==='google')?.ready).toBe(true);
 expect(selected).toMatchObject({connectionId:'google',imageModel:'synthetic-google-image',ready:false,label:'Synthetic Google · synthetic-google-image'});
});
