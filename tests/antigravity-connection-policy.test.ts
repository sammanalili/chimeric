import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AntigravityConnectionPolicy,type AntigravityClientCheckResult} from '../src/antigravity-connection-policy';
const valid:AntigravityClientCheckResult={installed:true,compatible:true,signedIn:true,evidence:'official-client-check'};
const sessionId='11111111-1111-4111-8111-111111111111';
function fixture(options:any={}){
 const profile=mkdtempSync(join(tmpdir(),'chimeric-agy-policy-')),calls:string[]=[],listeners=new Set<()=>void>();
 let state:any={connected:false,authState:'idle',executable:'',models:[]};
 const direct:any={status:()=>({connected:options.legacy===true,models:[]}),available:()=>true,onChange:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn)},connect:async()=>calls.push('direct-connect'),authenticate:async()=>calls.push('direct-signin'),refresh:async()=>calls.push('direct-refresh'),disconnect:async()=>calls.push('direct-disconnect'),auth:{cancel:()=>calls.push('direct-cancel')}};
 const cli:any={status:()=>({...state}),available:()=>true,onChange:(fn:any)=>{listeners.add(fn);return()=>listeners.delete(fn)},connect:async()=>calls.push('cli-connect'),authenticate:async()=>calls.push('cli-signin'),refresh:async()=>calls.push('cli-refresh'),disconnect:async()=>calls.push('cli-disconnect'),executablePath:()=>state.executable,
  auth:{status:()=>({...state}),connect:async()=>{calls.push('auth-connect');state.connected=true},create:async(raw:any)=>{expect(raw).toEqual({title:'Chimeric connection check'});calls.push('auth-session-new');state.authState='ready';return {session:{id:sessionId}}},snapshot:()=>({session:{title:'Chimeric connection check'}}),refresh:async(id:string)=>{expect(id).toBe(sessionId);calls.push('auth-session-load');state.authState='ready'},disconnect:async()=>calls.push('auth-disconnect')}};
 const policy=new AntigravityConnectionPolicy(profile,{direct,cli,checkClient:async()=>{calls.push('check');return valid},...options});
 return {profile,policy,direct,cli,calls,listeners,state,close:async()=>{await policy.close();rmSync(profile,{recursive:true,force:true})}};
}
test('new profiles are disabled and status cannot perform inference or establish sign-in',async()=>{
 const f=fixture();try{expect(f.policy.status().experimental).toEqual({enabled:false,transport:'direct'});expect(f.policy.status().prerequisite.signedIn).toBe(false);expect(f.calls).toEqual([]);expect(()=>f.policy.assertAvailable('direct')).toThrow('Enable');expect(f.policy.available()).toBe(false)}finally{await f.close()}
});
test('legacy direct connection preserves opt-in but its credentials cannot satisfy the official-client gate',async()=>{
 const f=fixture({legacy:true});try{expect(f.policy.status().experimental.enabled).toBe(true);expect(f.policy.status().connected).toBe(false);expect(()=>f.policy.assertAvailable('direct')).toThrow('official');expect(f.calls).toEqual([]);await f.policy.checkClient();expect(f.policy.available('direct')).toBe(true)}finally{await f.close()}
});
test('settings persist separately, default transport stays direct, and prerequisite proof is not persisted',async()=>{
 const f=fixture();try{
  await f.policy.configure({enabled:true,transport:'cli'});await f.policy.checkClient();
  const saved=JSON.parse(readFileSync(join(f.profile,'local-auth/antigravity-connection-policy.json'),'utf8'));expect(saved).toEqual({version:1,enabled:true,transport:'cli'});
  const second=new AntigravityConnectionPolicy(f.profile,{direct:f.direct,cli:f.cli,checkClient:async()=>valid});try{expect(second.status().experimental).toEqual({enabled:true,transport:'cli'});expect(second.status().prerequisite.signedIn).toBe(false);expect(second.available('cli')).toBe(false)}finally{await second.close()}
 }finally{await f.close()}
});
test('missing, incompatible, unsigned-in, and unproven clients fail before delegated sign-in or refresh',async()=>{
 for(const value of [{installed:false,compatible:false,signedIn:false},{installed:true,compatible:false,signedIn:false},{installed:true,compatible:true,signedIn:false},{installed:true,compatible:true,signedIn:true}]){
  const f=fixture({checkClient:async()=>value});try{await f.policy.configure({enabled:true});await f.policy.checkClient();expect(()=>f.policy.assertAvailable('direct')).toThrow('official');await expect(f.policy.signin()).rejects.toThrow();await expect(f.policy.refresh()).rejects.toThrow();expect(f.calls).toEqual([])}finally{await f.close()}
 }
});
test('selected transport is explicit and a failed direct operation never falls back to CLI',async()=>{
 const f=fixture();try{
  await f.policy.configure({enabled:true});await f.policy.checkClient();expect(()=>f.policy.assertAvailable('cli')).toThrow('selected');
  f.direct.refresh=async()=>{f.calls.push('direct-refresh');throw Error('synthetic failure')};await expect(f.policy.refresh()).rejects.toThrow('synthetic failure');expect(f.calls).not.toContain('cli-refresh');
  await f.policy.configure({transport:'cli'});expect(()=>f.policy.assertAvailable('direct')).toThrow('selected');f.policy.assertAvailable('cli');
 }finally{await f.close()}
});
test('Class2 denies before any account check or provider action',async()=>{
 const f=fixture();try{await f.policy.configure({enabled:true});expect(()=>f.policy.assertAvailable('direct','class2')).toThrow('Class 2');await expect(f.policy.ensureAvailable('direct','class2')).rejects.toThrow('Class 2');expect(f.calls).toEqual([])}finally{await f.close()}
});
test('expired proof is checked once and concurrent callers share one prerequisite check',async()=>{
 let now=1,release:any,count=0;const f=fixture({now:()=>now,prerequisiteMaxAgeMs:10,checkClient:async()=>{++count;if(count===1)return valid;return new Promise(done=>release=done)}});try{
  await f.policy.configure({enabled:true});await f.policy.checkClient();now=20;expect(()=>f.policy.assertAvailable('direct')).toThrow('official');
  const first=f.policy.ensureAvailable('direct'),second=f.policy.ensureAvailable('direct');expect(count).toBe(2);release(valid);await Promise.all([first,second]);expect(count).toBe(2);f.policy.assertAvailable('direct');
 }finally{await f.close()}
});
test('disabling aborts the request lifecycle and stale prerequisite success cannot reenable access',async()=>{
 let release:any;const f=fixture({checkClient:()=>new Promise(done=>release=done)});try{
  await f.policy.configure({enabled:true});const signal=f.policy.signal(),pending=f.policy.checkClient();await f.policy.configure({enabled:false});expect(signal.aborted).toBe(true);release(valid);await pending;
  expect(f.policy.status().prerequisite.signedIn).toBe(false);expect(f.policy.status().experimental.enabled).toBe(false);expect(()=>f.policy.assertAvailable('direct')).toThrow('Enable');
 }finally{await f.close()}
});
test('delegation uses only selected service and notifies subscribers without manipulating credentials',async()=>{
 const f=fixture();let changes=0;const unsubscribe=f.policy.onChange(()=>++changes);try{
  await f.policy.configure({enabled:true});await f.policy.checkClient();await f.policy.signin();await f.policy.refresh();await f.policy.cancel();await f.policy.disconnect();
  expect(f.calls).toEqual(['check','direct-signin','direct-refresh','direct-cancel','direct-disconnect']);expect(changes).toBeGreaterThanOrEqual(5);expect(f.policy.status().experimental.enabled).toBe(false);
 }finally{unsubscribe();await f.close()}
});
test('an embedded catalog cannot prove sign-in; official ACP session success provides separate evidence',async()=>{
 const f=fixture({checkClient:undefined,discover:async()=>[{id:'synthetic',name:'Synthetic'}]});try{
  const executable=join(f.profile,'synthetic-agy');writeFileSync(executable,'metadata-only fixture',{mode:0o700});f.state.executable=executable;
  await f.policy.configure({enabled:true});f.cli.auth.create=undefined;
  await f.policy.checkClient();expect(f.policy.status().prerequisite).toMatchObject({installed:true,compatible:true,signedIn:false});expect(()=>f.policy.assertAvailable('direct')).toThrow();
  f.cli.auth.create=async()=>{f.calls.push('auth-session-new');f.state.authState='ready';return {session:{id:sessionId}}};
  await f.policy.checkClient();expect(f.policy.status().prerequisite).toMatchObject({signedIn:true,evidence:'official-acp-session'});
  await f.policy.checkClient();expect(f.calls.filter(value=>value==='auth-session-new')).toHaveLength(1);expect(f.calls).toContain('auth-session-load');expect(f.calls).not.toContain('direct-signin');
 }finally{await f.close()}
});
test('client check errors and unexpected diagnostics never enter the public status',async()=>{
 const f=fixture({checkClient:async()=>{throw Error('synthetic-sensitive-private-diagnostics')}});try{await f.policy.configure({enabled:true});await f.policy.checkClient();expect(JSON.stringify(f.policy.status())).not.toContain('synthetic-sensitive');expect(f.policy.available()).toBe(false);await expect(f.policy.configure({enabled:true,token:'not accepted'})).rejects.toThrow()}finally{await f.close()}
});
