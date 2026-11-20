// A synthetic process speaking ACP over the same pipes as the official CLI.
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {appendFileSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
const line=createInterface({input:process.stdin}),pending=new Map(),sessions=new Map();
const config=()=>[{id:'model',name:'Model',category:'model',type:'select',currentValue:'gemini-fixture',options:[{value:'gemini-fixture',name:'Gemini fixture'},{value:'claude-fixture',name:'Restricted fixture'}]},{id:'thought_level',name:'Thinking Level',category:'thought_level',type:'select',currentValue:'medium',options:[{value:'medium',name:'Medium'},{value:'high',name:'High'}]},{id:'mode',name:'Mode',category:'mode',type:'select',currentValue:'default',options:[{value:'default',name:'Default'},{value:'accept-edits',name:'Accept edits'},{value:'plan',name:'Plan'}]}];
function send(message){process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\n')}
function update(sessionId,update){send({method:'session/update',params:{sessionId,update}})}
line.on('line',async raw=>{
 const msg=JSON.parse(raw);if(!msg.method){const done=pending.get(msg.id);if(done){pending.delete(msg.id);done(msg)}return}
 const {method,params,id}=msg;const reply=result=>send({id,result});
 appendFileSync(join(process.cwd(),'fixture-wire.jsonl'),JSON.stringify({method,params})+'\n');
 try{
  if(method==='initialize'){reply({protocolVersion:process.env.FIXTURE_WRONG_VERSION?'9':1,agentInfo:{name:'Antigravity ACP Server',version:'1.5.1'},agentCapabilities:{loadSession:true,promptCapabilities:{image:true},sessionCapabilities:{resume:{}}},authMethods:[{id:'oauth-personal',name:'Google'}]});return}
  if(method==='authenticate'){reply({});return}
  if(method==='session/new'){
   const sid=randomUUID(),value={sessionId:sid,configOptions:config()};sessions.set(sid,{cwd:params.cwd,value});writeFileSync(join(process.cwd(),sid+'.json'),JSON.stringify({cwd:params.cwd,value}));reply(value);return;
  }
  if(method==='session/resume'||method==='session/load'){
   const session=JSON.parse(readFileSync(join(process.cwd(),params.sessionId+'.json'),'utf8'));sessions.set(params.sessionId,session);reply(session.value);return;
  }
  const session=sessions.get(params?.sessionId);
  if(method==='session/set_config_option'){
   const option=session.value.configOptions.find(c=>c.id===params.configId);option.currentValue=params.value;reply({configOptions:session.value.configOptions});return;
  }
  if(method==='session/prompt'){
   const text=params.prompt.filter(b=>b.type==='text').map(b=>b.text).join('\n');
   if(text==='quota'){send({id,error:{code:429,message:'quota exhausted'}});return}
   if(text==='crash'){process.exit(3)}
   if(text==='oversized'){process.stdout.write('x'.repeat(8*1024*1024+100)+'\n');return}
   if(text==='wait'||text==='stubborn'){session.prompt=id;session.stubborn=text==='stubborn';return}
   if(text==='permission'){
    const requestId='permission-'+randomUUID();
    update(params.sessionId,{sessionUpdate:'tool_call',toolCallId:'tool1',title:'Write synthetic result',status:'pending',kind:'edit',rawInput:{path:'result.txt'}});
    const decision=new Promise(done=>pending.set(requestId,done));
    send({id:requestId,method:'session/request_permission',params:{sessionId:params.sessionId,toolCall:{toolCallId:'tool1',title:'Write synthetic result',rawInput:{path:'result.txt'}},options:[{optionId:'once',name:'Allow once',kind:'allow_once'},{optionId:'always',name:'Always allow',kind:'allow_always'},{optionId:'reject',name:'Deny',kind:'reject_once'}]}});
    const response=await decision;
    if(response.result?.outcome?.optionId==='once')writeFileSync(join(session.cwd,'result.txt'),'synthetic result\n');
    update(params.sessionId,{sessionUpdate:'tool_call_update',toolCallId:'tool1',status:response.result?.outcome?.optionId==='once'?'completed':'failed'});
   }
   update(params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Synthetic answer: '+text}});
   const image=params.prompt.find(b=>b.type==='image');if(image)update(params.sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'; image received as '+image.mimeType}});
   reply({stopReason:'end_turn'});return;
  }
  if(method==='session/cancel'){
   if(session?.prompt&&!session.stubborn){send({id:session.prompt,result:{stopReason:'cancelled'}});session.prompt=null}return;
  }
  if(id!==undefined)send({id,error:{code:-32601,message:'Unknown method'}});
 }catch{if(id!==undefined)send({id,error:{code:-32603,message:'Synthetic server failed'}})}
});
