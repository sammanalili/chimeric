import {test,expect,afterEach} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {ConfidentialityManager} from '../src/confidentiality-manager';import {NativeSpeechManager,createNativeSpeechManager} from '../src/speech-manager';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0))fn()});
const settle=()=>new Promise(resolve=>setTimeout(resolve,1));
function fixture(){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-native-speech-')),models=['main','speech'].map(id=>({id,provider:'service',qualifiedId:'service::'+id,name:id,mode:id==='main'?'chat':'audio_transcription',available:true})),wires:any[]=[],state={starts:0,transcribes:0,failLocal:false};
 const registry:any={profileDir,config:{providers:{service:{name:'Synthetic research API',baseUrl:'https://speech.example/v1',revision:'one',api:'openai-completions',enabled:true}},voice:{python:'/missing',runtimeRoot:'/missing'}},models:new Map(models.map(m=>[m.qualifiedId,m])),statuses:{service:{ready:true}},state:{model:'service::main'},getPrivateCredential:()=> 'synthetic-speech-key',safeError:(e:any)=>String(e.message).replaceAll('synthetic-speech-key','[redacted]'),resolve:(id:string)=>models.find(m=>m.qualifiedId===id)};
 const conf=new ConfidentialityManager(registry, {protectionEvidence:()=>({verified:true}),owner:{userId:'owner',organizationId:'org'},lookupFrame:(_p,frameId)=>({frameId,rootFrameId:frameId,projectId:'p',ownerId:frameId==='foreign'?'another':'owner',organizationId:'org'}),transport:async()=>{throw Error('No broker request expected')}});
 const speech=new NativeSpeechManager(registry,conf,{start:async()=>{state.starts++;if(state.failLocal)throw Error('Local runtime missing')},transcribe:async()=>{state.transcribes++;return 'Local synthetic transcript'},stop:()=>{}},{localStatus:()=>({ready:!state.failLocal,name:'Synthetic offline recognizer'}),fetch:(async(url:any,init:any)=>{wires.push({url,init});return Response.json({text:'Remote synthetic transcript'})}) as any});
 cleanup.push(()=>{speech.close();conf.close();rmSync(profileDir,{recursive:true,force:true})});
 const select=()=>speech.settings.configure({expectedRevision:0,connectionId:'service',modelId:'speech'});
 const protect=async()=>{await conf.approveConnection({connectionId:'service',expectedRevision:conf.policy.snapshot().revision,purposes:['model']});await conf.setMode({frameId:'root',expectedRevision:0,mode:'class2',main:'service::main'})};
 function bridge(frameId='root'){const events:any[]=[];let closed=false;const value=new speech.VoiceBridge({sendEvent:e=>events.push(e),close:()=>{closed=true}},{frameId,language:'en'});return {value,events,isClosed:()=>closed}}
 return {conf,speech,registry,state,wires,select,protect,bridge};
}
test('speech selection is discovered from generic purpose metadata and grants only STT',()=>{
 const f=fixture(),s=f.speech.settings.snapshot();expect(s.selected).toBeNull();expect(s.connections[0].models.map(m=>m.id)).toEqual(['speech']);f.select();const b=f.conf.binding('service')!;expect(f.conf.policy.isApproved(b,'stt')).toBe(true);expect(f.conf.policy.isApproved(b,'model')).toBe(false);expect(f.wires).toHaveLength(0);
});
test('ordinary chat always uses local recognition even with a selected remote speech model',async()=>{
 const f=fixture();f.select();const b=f.bridge('ordinary');await b.value.start();expect(b.events[0].destination.kind).toBe('local');b.value.handleBrowserMessage(Buffer.alloc(320),true);b.value.handleBrowserMessage('{"type":"stop"}',false);
 for(let i=0;i<30&&!b.isClosed();i++)await settle();expect(b.events.find(e=>e.type==='transcript').text).toBe('Local synthetic transcript');expect(f.state.transcribes).toBe(1);expect(f.wires).toHaveLength(0);
});
test('protected speech requires the selected approved HTTPS target and uploads once only after Stop',async()=>{
 const f=fixture();await f.protect();const unavailable=f.bridge();await unavailable.value.start();expect(unavailable.events[0].type).toBe('error');expect(f.wires).toHaveLength(0);f.select();
 const b=f.bridge();await b.value.start();expect(b.events[0].destination).toMatchObject({kind:'remote',endpoint:'https://speech.example/v1/audio/transcriptions',model:'speech'});expect(f.state.starts).toBe(0);
 b.value.handleBrowserMessage(Buffer.alloc(320),true);expect(f.wires).toHaveLength(0);b.value.handleBrowserMessage('{"type":"stop"}',false);b.value.handleBrowserMessage('{"type":"stop"}',false);
 for(let i=0;i<40&&!b.isClosed();i++)await settle();expect(f.wires).toHaveLength(1);expect(f.wires[0].init.redirect).toBe('error');expect(f.wires[0].init.body.get('model')).toBe('speech');expect(b.events.find(e=>e.type==='transcript').text).toBe('Remote synthetic transcript');
});
test('owner, policy and speech connection changes cancel before upload with no fallback',async()=>{
 const f=fixture();f.select();await f.protect();const foreign=f.bridge('foreign');await foreign.value.start();expect(foreign.events[0].type).toBe('error');
 const b=f.bridge();await b.value.start();b.value.handleBrowserMessage(Buffer.alloc(320),true);f.registry.config.providers.service.revision='changed';f.conf.connectionChanged('service');expect(b.isClosed()).toBe(true);b.value.handleBrowserMessage('{"type":"stop"}',false);expect(f.wires).toHaveLength(0);expect(f.state.starts).toBe(0);
});
test('an unavailable local backend fails before ready and does not select a cloud fallback',async()=>{
 const f=fixture();f.select();f.state.failLocal=true;const b=f.bridge('ordinary');await b.value.start();expect(b.events.some(e=>e.type==='ready')).toBe(false);expect(b.events[0].type).toBe('error');expect(b.isClosed()).toBe(true);expect(f.wires).toHaveLength(0);
});
test('an unreadable optional speech store remains preserved and blocks only recording',async()=>{
 const f=fixture();f.speech.close();const file=join(f.registry.profileDir,'speech','settings.json');writeFileSync(file,'corrupt synthetic settings');let starts=0;
 const value=createNativeSpeechManager(f.registry,f.conf,{start:async()=>{starts++},transcribe:async()=>'',stop:()=>{}});
 expect(()=>value.settings.snapshot()).toThrow('could not be read');const events:any[]=[];const b=new value.VoiceBridge({sendEvent:e=>events.push(e),close:()=>{}},{});await b.start();expect(events[0].code).toBe('stt_unavailable');expect(events.some(e=>e.type==='ready')).toBe(false);expect(starts).toBe(0);expect(readFileSync(file,'utf8')).toBe('corrupt synthetic settings');value.close();
});
