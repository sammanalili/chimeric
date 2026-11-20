import {test,expect} from 'bun:test';
import {createServer} from 'node:net';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';

const callbackAvailable=await new Promise<boolean>(resolveAvailable=>{const server=createServer();server.once('error',()=>resolveAvailable(false));server.listen(1455,'127.0.0.1',()=>server.close(()=>resolveAvailable(true)))});

(callbackAvailable?test:test.skip)('a standalone subscription bundle starts real browser OAuth without neighboring SDK modules',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'chimeric-oauth-emitted-'));
 const entry=join(directory,'entry.ts'),bundle=join(directory,'standalone.js');
 writeFileSync(entry,[
  'import {SubscriptionManager,SubscriptionVault} from '+JSON.stringify(resolve(import.meta.dir,'../src/subscription.ts'))+';',
  'const manager=new SubscriptionManager(new SubscriptionVault('+JSON.stringify(join(directory,'profile'))+'));',
  'try {',
  "await manager.start('browser');",
  "for(let i=0;i<100&&!['waiting','error'].includes(manager.status().login?.phase??'');i++)await Bun.sleep(5);",
  'const result=manager.status();',
  "if(result.login?.phase!=='waiting'||!result.login.authorizationUrl)throw Error('Compiled browser OAuth did not reach its authorization URL.');",
  'const origin=new URL(result.login.authorizationUrl).origin;manager.cancel();',
  'console.log(JSON.stringify({before:result.login.phase,origin,after:manager.status().login??null,connected:manager.status().connected}));',
  '} finally {manager.close()}',
 ].join('\n'));
 try{
  const built=await Bun.build({entrypoints:[entry],target:'bun',outdir:directory,naming:'standalone.js'});expect(built.success).toBe(true);
  const child=Bun.spawn([process.execPath,bundle],{cwd:directory,env:{...process.env,BUN_BE_BUN:'1'},stdout:'pipe',stderr:'pipe'});
  const watchdog=setTimeout(()=>child.kill(),5000);
  try{const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text();expect(await child.exited).toBe(0);expect(stderr).toBe('');expect(JSON.parse(stdout)).toEqual({before:'waiting',origin:'https://auth.openai.com',after:null,connected:false})}finally{clearTimeout(watchdog)}
 }finally{rmSync(directory,{recursive:true,force:true})}
},10000);
