import {test,expect} from 'bun:test';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Antigravity} from '../src/antigravity';
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}};
async function waitFor(check:()=>boolean,timeout=2000){const until=Date.now()+timeout;while(!check()&&Date.now()<until)await Bun.sleep(10);if(!check())throw Error('Expected auth fixture state was not reached.')}

for(const scenario of ['close-after-initialize','parent-exits-after-authenticate'])test('auth cleanup drains ignored-stdio descendants: '+scenario,async()=>{
 const profile=mkdtempSync(join(tmpdir(),'chimeric-auth-cleanup-'));let leader:number|undefined,descendant:number|undefined;
 const auth=new Antigravity(profile,{operationTimeoutMs:1000,killGraceMs:30,launch:cwd=>{const child=spawn(process.execPath,[resolve('tests/fixtures/antigravity-auth-descendant.mjs')],{cwd,env:{BUN_BE_BUN:'1',AUTH_CHILD_STAGE:scenario==='close-after-initialize'?'initialize':'authenticate',AUTH_EXIT_AFTER_AUTH:scenario==='parent-exits-after-authenticate'?'1':'0'},stdio:['pipe','pipe','pipe'],detached:true});leader=child.pid;return child}});
 try{
  await auth.connect();
  if(scenario==='parent-exits-after-authenticate'){await auth.authenticate({methodId:'oauth-personal'});await waitFor(()=>!auth.status().connected)}
  const marker=join(auth.root,'owned-descendant.json');await waitFor(()=>existsSync(marker));descendant=JSON.parse(readFileSync(marker,'utf8')).pid;
  expect(alive(descendant!)).toBe(true);
  await auth.close();
  await Bun.sleep(50);
  expect(alive(descendant!)).toBe(false);
  expect(readFileSync(join(auth.root,'auth-wire.jsonl'),'utf8')).not.toContain('session/');
 }finally{
  // This group belongs only to the synthetic fixture, even after its leader exits.
  if(leader)try{process.kill(-leader,'SIGKILL')}catch{}
  await auth.close();await Bun.sleep(30);rmSync(profile,{recursive:true,force:true});
 }
},6000);

test('same-tick connect and close cannot launch an ACP process after shutdown begins',async()=>{
 const profile=mkdtempSync(join(tmpdir(),'chimeric-auth-connect-close-'));let launches=0,leader:number|undefined;
 const auth=new Antigravity(profile,{operationTimeoutMs:500,killGraceMs:30,launch:cwd=>{launches++;const child=spawn(process.execPath,[resolve('tests/fixtures/antigravity-auth-descendant.mjs')],{cwd,env:{BUN_BE_BUN:'1'},stdio:['pipe','pipe','pipe'],detached:true});leader=child.pid;return child}});
 const statusErrors:unknown[]=[];auth.subscribe(()=>{try{auth.status()}catch(error){statusErrors.push(error)}});
 try{
  const connecting=auth.connect();void connecting.catch(()=>{});
  await auth.close();await expect(connecting).rejects.toThrow('shutting down');
  expect(launches).toBe(0);
  expect(statusErrors).toHaveLength(0);
 }finally{
  if(leader)try{process.kill(-leader,'SIGKILL')}catch{}
  await auth.close();await Bun.sleep(30);rmSync(profile,{recursive:true,force:true});
 }
});
