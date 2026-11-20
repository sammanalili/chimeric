import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const args=JSON.parse(process.env.FIXTURE_ARGS),mode=process.env.FIXTURE_MODE??'ok',journal=process.env.FIXTURE_JOURNAL;
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const log=value=>{if(journal)appendFileSync(journal,JSON.stringify(value)+'\n')};
log({kind:'launch',args,cwd:process.cwd(),pid:process.pid});
if(args.includes('/hooks')){
 const source=join(process.cwd(),'.agents','hooks.json'),definition=JSON.parse(readFileSync(source,'utf8'))['chimeric-provider-tool-policy'].PreToolUse[0].hooks[0];
 const hooks=[{name:'chimeric-provider-tool-policy',enabled:true,source,actions:[{event:'PreToolUse',matcher:'*',type:'command',command:definition.command,timeout_seconds:definition.timeout}]}];
 if(mode==='external-hook')hooks.push({name:'global-code',enabled:true,source:'/synthetic/global/hooks.json',actions:[{event:'SessionStart',type:'command',command:'external-code'}]});
 const command={name:'hooks',data:{hooks}};emit({event:'command_result',command});emit({event:'result',result:{status:'SUCCESS',command}});process.exit(0);
}
if(args.includes('models')){
 if(mode==='catalog-hang'){process.on('SIGTERM',()=>{});setInterval(()=>{},1000);await new Promise(()=>{});}else{
 const command={name:'models',data:{models:[{id:'gemini-fixture-medium',label:'Gemini fixture'},{id:'claude-fixture-high',label:'Claude fixture'}]}};
 emit({event:'command_result',command});emit({event:'result',result:{status:'SUCCESS',command}});process.exit(0);}
}
const schema=JSON.parse(readFileSync(args[args.indexOf('--json-schema')+1],'utf8'));
const conversation='synthetic-conversation';
const step=value=>emit({event:'step_update',step_update:{conversation_id:conversation,...value}});
const policy=(name,parameters)=>{
 const payload=JSON.stringify({toolCall:{name,args:parameters}});
 const child=spawnSync(process.execPath,[join(process.cwd(),'tool-policy.mjs')],{input:payload,encoding:'utf8',env:{BUN_BE_BUN:'1'}});
 const result=JSON.parse(child.stdout);log({kind:'policy',name,decision:result.decision});return result;
};
createInterface({input:process.stdin}).on('line',raw=>{
 const input=JSON.parse(raw),prompt=input.message.content;log({kind:'input',prompt});
 emit({event:'init',conversation_id:mode==='missing-conversation'?undefined:conversation,init:{model:args[args.indexOf('--model')+1],agent:args[args.indexOf('--agent')+1],permission_mode:mode==='wrong-policy'?'request-review':'strict',json_schema:schema,tools:['finish','run_command','view_file']}});
 if(mode==='hang'||mode==='ignored-child'){
  if(mode==='hang')process.on('SIGTERM',()=>{});const descendant=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{env:{BUN_BE_BUN:'1'},stdio:mode==='hang'?'inherit':'ignore'});
  log({kind:'descendant',pid:descendant.pid});setInterval(()=>{},1000);return;
 }
 if(mode==='bad-json'){process.stdout.write('{broken\n');return}
 if(mode==='overflow'){process.stdout.write('x'.repeat(8*1024*1024+1));return}
 if(mode==='quota'){emit({event:'result',result:{conversation_id:conversation,status:'ERROR',error:'quota exhausted'}});process.exit(2)}
 if(mode==='builtin'){
  const decision=policy('run_command',{CommandLine:'synthetic'});if(decision.decision!=='deny')writeFileSync(join(process.cwd(),'unsafe-executed'),'yes');
  step({step_index:1,state:'ACTIVE',step_type:'tool',tool_name:'run_command',tool_info:{name:'run_command',parameters:{CommandLine:'synthetic'}}});setInterval(()=>{},1000);return;
 }
 const data=JSON.parse(prompt.slice(prompt.indexOf('\n\n')+2));
 const hasResult=data.transcript.some(message=>message.role==='toolResult');
 const output=mode==='malformed-arguments'?{text:'',tool_calls:[{name:'python',arguments_json:'[]'}]}:mode==='invalid-schema-arguments'?{text:'',tool_calls:[{name:'python',arguments_json:'{"code":42}'}]}:mode==='unknown-tool'?{text:'',tool_calls:[{name:'not_available',arguments_json:'{}'}]}:data.available_tools.length&&!hasResult?{text:'I will calculate this.',tool_calls:[{name:data.available_tools[0].name,arguments_json:JSON.stringify({code:'print(6 * 7)'})}]}:{text:hasResult?'The tool returned 42.':'Synthetic answer.',tool_calls:[]};
 step({step_index:1,state:'ACTIVE',step_type:'tool',tool_name:'finish',tool_info:{name:'finish',parameters:output}});
 if(mode!=='missing-proof')policy('finish',output);
 step({step_index:1,state:'DONE',step_type:'finish'});
 const result={conversation_id:conversation,status:'SUCCESS',structured_output:output,usage:{input_tokens:100,output_tokens:20,thinking_tokens:5,cache_read_tokens:30}};
 if(mode==='mismatched-result')result.structured_output={text:'Different response.',tool_calls:[]};
 emit({event:'result',result});if(mode==='duplicate-result')emit({event:'result',result});process.exit(0);
});
