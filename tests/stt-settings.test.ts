import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionPolicyStore,type ConnectionBinding} from '../src/session-policy';
import {SttSettingsManager,SttSettingsError,type SttSettingsDependencies} from '../src/stt-settings';
import {installSttHttp} from '../src/stt-http';

function fixture(){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-speech-settings-'));
 let binding:ConnectionBinding={id:'speech_a',endpoint:'https://speech.example.invalid/v1',api:'openai-completions',revision:'connection-1',credentialRevision:'a'.repeat(64)},ready=true,modelAvailable=true,modelRevision='catalog-1';let resolved=0,changed=0;
 const policy=new SessionPolicyStore(profile,{lookupFrame:()=>undefined,currentConnection:id=>id===binding.id?binding:undefined});
 const deps:SttSettingsDependencies={policy,localStatus:()=>({ready:true,name:'Local synthetic recognizer'}),listConnections:()=>[{id:'speech_a',name:'Synthetic speech',endpointUrl:'https://speech.example.invalid/v1/audio/transcriptions',ready,apiKey:'must-not-appear',models:modelAvailable?[{id:'synthetic-stt',name:'Synthetic STT'}]:[]}] as any,resolveTarget:()=>{resolved++;return {binding,target:{connectionId:binding.id,name:'Synthetic speech',baseUrl:binding.endpoint,modelId:'synthetic-stt',connectionRevision:binding.revision,credentialRevision:binding.credentialRevision,modelRevision}}},changed:()=>{changed++}};
 const manager=new SttSettingsManager(profile,deps);
 return {profile,manager,deps,policy,get resolved(){return resolved},get changed(){return changed},setReady:(value:boolean)=>{ready=value},setModel:(value:boolean)=>{modelAvailable=value},changeCredential:()=>{binding={...binding,credentialRevision:'b'.repeat(64),revision:'connection-2'}},changeModelRevision:()=>{modelRevision='catalog-2'},cleanup(){manager.close();policy.close();rmSync(profile,{recursive:true,force:true})}};
}

test('speech starts local and auto-approves only the explicitly saved STT purpose without inference',()=>{
 const f=fixture();try{
  expect(f.manager.snapshot().selected).toBeNull();expect(f.manager.resolveSelected()).toBeNull();expect(f.resolved).toBe(0);expect(f.policy.snapshot().approvals).toHaveLength(0);
  const value=f.manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'});expect(value.selected).toEqual({connectionId:'speech_a',modelId:'synthetic-stt'});expect(value.revision).toBe(1);
  expect(f.manager.resolveSelected()).toMatchObject({connectionId:'speech_a',modelId:'synthetic-stt',credentialRevision:'a'.repeat(64)});expect(f.policy.snapshot().approvals[0].purposes).toEqual(['stt']);expect(f.policy.snapshot().approvals[0].source).toBe('stt-selection');expect(f.changed).toBe(1);
  const json=JSON.stringify(value);expect(json).not.toContain('must-not-appear');expect(json).not.toContain('credentialRevision');expect(json).not.toContain('connectionRevision');
  expect(f.manager.configure({expectedRevision:1,connectionId:null}).selected).toBeNull();expect(f.policy.snapshot().selectedStt).toBeNull();expect(f.manager.resolveSelected()).toBeNull();
 }finally{f.cleanup()}
});

test('speech rejects stale revisions and client policy flags before changing approval',()=>{
 const f=fixture();try{
  expect(()=>f.manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt',class2:true})).toThrow();expect(f.policy.snapshot().approvals).toHaveLength(0);expect(f.resolved).toBe(0);
  f.manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'});const revision=f.policy.snapshot().revision;expect(()=>f.manager.configure({expectedRevision:0,connectionId:null})).toThrow(SttSettingsError);expect(f.policy.snapshot().revision).toBe(revision);expect(f.manager.snapshot().selected?.connectionId).toBe('speech_a');
  expect(()=>f.manager.configure({expectedRevision:1,connectionId:null,modelId:'synthetic-stt'})).toThrow(SttSettingsError);
 }finally{f.cleanup()}
});

test('speech resolve verifies readiness, model availability and current credential approval without fallback',()=>{
 const f=fixture();try{
  f.manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'});f.setReady(false);expect(()=>f.manager.resolveSelected()).toThrow(SttSettingsError);f.setReady(true);f.setModel(false);expect(()=>f.manager.resolveSelected()).toThrow(SttSettingsError);f.setModel(true);
  f.changeModelRevision();expect(f.manager.resolveSelected()?.modelRevision).toBe('catalog-2');f.changeCredential();expect(()=>f.manager.resolveSelected()).toThrow(SttSettingsError);f.manager.configure({expectedRevision:1,connectionId:'speech_a',modelId:'synthetic-stt'});expect(f.manager.resolveSelected()?.credentialRevision).toBe('b'.repeat(64));
 }finally{f.cleanup()}
});

test('the displayed speech destination must match the trusted resolver destination',()=>{
 const f=fixture();try{
  const manager=new SttSettingsManager(f.profile,{...f.deps,listConnections:()=>[{id:'speech_a',name:'Wrong destination',endpointUrl:'https://another.example.invalid/v1/audio/transcriptions',ready:true,models:[{id:'synthetic-stt',name:'Synthetic'}]}]});expect(()=>manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'})).toThrow('destination or credential binding');expect(f.policy.snapshot().approvals).toHaveLength(0);manager.close();
 }finally{f.cleanup()}
});

test('an interrupted speech save blocks capture across restart until an explicit resave repairs it',()=>{
 const f=fixture();try{
  const failing=new SttSettingsManager(f.profile,{...f.deps,writeJson:(path,value)=>{if(path.endsWith('/settings.json'))throw Error('Synthetic disk failure');writeFileSync(path,JSON.stringify(value),{mode:0o600})}});expect(()=>failing.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'})).toThrow('saved again');expect(f.policy.snapshot().selectedStt?.id).toBe('speech_a');expect(()=>failing.resolveSelected()).toThrow(SttSettingsError);expect(existsSync(join(f.profile,'speech/selection-pending.json'))).toBe(true);failing.close();
  const restored=new SttSettingsManager(f.profile,f.deps);expect(restored.snapshot().warning).toContain('saved again');expect(()=>restored.resolveSelected()).toThrow(SttSettingsError);restored.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'});expect(restored.resolveSelected()?.connectionId).toBe('speech_a');expect(existsSync(join(f.profile,'speech/selection-pending.json'))).toBe(false);restored.close();
 }finally{f.cleanup()}
});

test('speech persists its model selection and verifies it against policy after restart',()=>{
 const f=fixture();try{
  f.manager.configure({expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'});const restored=new SttSettingsManager(f.profile,f.deps);expect(restored.snapshot().selected).toEqual({connectionId:'speech_a',modelId:'synthetic-stt'});expect(restored.resolveSelected()?.connectionId).toBe('speech_a');f.policy.selectStt(null,f.policy.snapshot().revision);expect(()=>restored.resolveSelected()).toThrow('no longer approved');restored.close();
 }finally{f.cleanup()}
});

test('speech HTTP adapter exposes settings only, serves a versioned no-store component and closes its manager',async()=>{
 const f=fixture(),routes=new Map<string,Function>(),hooks=new Map<string,Function>(),app:any={addHook:(name:string,callback:Function)=>hooks.set(name,callback)};for(const method of ['get','put'])app[method]=(path:string,callback:Function)=>routes.set(method.toUpperCase()+' '+path,callback);
 const reply=()=>({status:200,headers:{} as Record<string,string>,contentType:'',body:undefined as any,header(name:string,value:string){this.headers[name]=value;return this},code(status:number){this.status=status;return this},send(body:any){this.body=body;return this},type(type:string){this.contentType=type;return this}});
 try{
  installSttHttp(app,f.manager,'?chimeric=synthetic-speech');expect([...routes.keys()]).toEqual(['GET /api/local/speech','PUT /api/local/speech','GET /api/local/speech/component.js']);
  let response=reply();const initial=await routes.get('GET /api/local/speech')!({},response);expect(initial.selected).toBeNull();expect(response.headers['cache-control']).toBe('no-store');
  response=reply();await routes.get('PUT /api/local/speech')!({body:{expectedRevision:0,connectionId:'speech_a',modelId:'synthetic-stt'}},response);expect(f.manager.snapshot().selected?.connectionId).toBe('speech_a');
  response=reply();await routes.get('PUT /api/local/speech')!({body:{expectedRevision:0,connectionId:null}},response);expect(response.status).toBe(409);expect(response.headers['cache-control']).toBe('no-store');
  response=reply();await routes.get('GET /api/local/speech/component.js')!({},response);expect(response.contentType).toBe('text/javascript; charset=utf-8');expect(response.headers['cache-control']).toBe('no-store');expect(response.body).toContain('vendor-CED4rDjN.js?chimeric=synthetic-speech');expect(response.body).not.toContain('?science_local=chatgpt-v1');
  await hooks.get('onClose')!();expect(()=>f.manager.resolveSelected()).toThrow('closed');
 }finally{f.cleanup()}
});
