import {createInterface} from 'node:readline';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
const marker=join(process.cwd(),'owned-descendant.json');
async function startDescendant(){
 if(existsSync(marker))return;
 spawn(process.execPath,['-e',"import{writeFileSync}from'node:fs';process.on('SIGTERM',()=>{});writeFileSync(process.env.AUTH_CHILD_MARKER,JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)"],{env:{BUN_BE_BUN:'1',AUTH_CHILD_MARKER:marker},stdio:'ignore'});
 const until=Date.now()+1000;while(!existsSync(marker)&&Date.now()<until)await new Promise(done=>setTimeout(done,5));
 if(!existsSync(marker))throw Error('Synthetic descendant did not become ready.');
}
createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);appendFileSync(join(process.cwd(),'auth-wire.jsonl'),JSON.stringify({method:request.method})+'\n');
 const send=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
 if(request.method==='initialize'){
  if(process.env.AUTH_CHILD_STAGE==='initialize')await startDescendant();
  send({protocolVersion:1,agentInfo:{name:'Antigravity ACP Server',version:'1.5.1'},agentCapabilities:{},authMethods:[{id:'oauth-personal',name:'Google'}]});return;
 }
 if(request.method==='authenticate'){
  await startDescendant();send({});
  if(process.env.AUTH_EXIT_AFTER_AUTH==='1')setTimeout(()=>process.exit(0),25);
 }
});
