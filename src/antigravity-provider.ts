import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,realpathSync,statSync,chmodSync,lstatSync,opendirSync} from 'node:fs';
import {join,resolve,isAbsolute,dirname} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {AssistantMessage,Model,TranscriptContext,Context,StreamOptions,Tool} from '@earendil-works/pi-ai';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {normalizeContext,getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {validateToolArguments} from '@earendil-works/pi-ai/utils/validation';
import {antigravityEnvironment} from './antigravity';

const MAX_BYTES=8*1024*1024;
const AGENT='chimeric-model-provider';
const HOOK='chimeric-provider-tool-policy';
const SLUG=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/;
const EFFORTS=new Set(['low','medium','high','xhigh','max']);
const settings={toolPermission:'strict',permissions:{allow:[],ask:[],deny:['read_file(*)','write_file(*)','read_url(*)','execute_url(*)','command(*)','mcp(*)']},historySize:0,statusLine:{enabled:false},title:{enabled:false}};
// Runtime-verified against the official CLI by a live structured turn; re-verify
// after every CLI update before changing this (see work/agy-http-20261111 and the
// provider's own workspace-policy check, which validates hooks against the binary).
export const ANTIGRAVITY_PROVIDER_TESTED_VERSION='1.5.5';
export type AntigravityCatalogModel={id:string;name:string};
type Choice='auto'|'none'|'required'|{type:'function';function?:{name:string};name?:string};
export type AntigravityStreamOptions=StreamOptions&{toolChoice?:Choice;reasoningEffort?:string;requestId?:string};
export type AntigravityProviderOptions={
 executable?:string;workRoot?:string;timeoutMs?:number;killGraceMs?:number;
 /** Optional isolated profile seam. Authentication must be performed by the official CLI in this same home. */
 home?:string;
 /** Explicit opt-in: existing MCP/plugin startup runs with its own permissions, outside Chimeric's sandbox. External hooks remain blocked. */
 allowSharedCustomizations?:boolean;
 /** Test-only process seam. Production always starts the signature-verified CLI. */
 launch?:(args:string[],cwd:string)=>ChildProcessWithoutNullStreams;
};
type Envelope={text:string;tool_calls:Array<{name:string;arguments_json:string}>};
type Run={result:any;finish?:Envelope;conversationId?:string};
type RequestSpec={schema:any;prompt:string;tools:Tool[];choice:Choice;hash:string};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'";
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>jsonObject(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);

/** Environment construction never reads or copies credentials. */
export function antigravityProviderEnvironment(home?:string){
 const env=antigravityEnvironment();
 delete env.XDG_CONFIG_HOME;delete env.XDG_CACHE_HOME;
 if(home!==undefined){if(!isAbsolute(home))throw new Error('Antigravity profile home must be an absolute directory.');env.HOME=resolve(home)}
 return env;
}

/** Metadata only: a configured MCP server may start before any model tool call. */
export function inspectAntigravityProviderEnvironment(home=process.env.HOME??homedir(),workspace?:string,policy:{allowSharedCustomizations?:boolean}={}){
 if(!isAbsolute(home))throw new Error('Antigravity profile home must be an absolute directory.');
 const blocks:Array<{path:string;kind:string}>=[];
 const metadata=(path:string)=>{try{return lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw new Error('Cannot verify Antigravity execution configuration metadata at '+path+'.')}};
 const permitted=(kind:string)=>policy.allowSharedCustomizations===true&&['MCP','legacy MCP','plugins','legacy plugins','plugin manifest'].includes(kind);
 const file=(path:string,kind:string)=>{if(!permitted(kind)&&metadata(path))blocks.push({path,kind})};
 const directory=(path:string,kind:string)=>{
  if(permitted(kind))return;
  const info=metadata(path);if(!info)return;
  if(!info.isDirectory()||info.isSymbolicLink()){blocks.push({path,kind});return}
  let dir;try{dir=opendirSync(path);if(dir.readSync())blocks.push({path,kind})}finally{dir?.closeSync()}
 };
 const scope=(base:string)=>{
  file(join(base,'hooks.json'),'hooks');file(join(base,'mcp_config.json'),'MCP');file(join(base,'plugins.json'),'plugin manifest');directory(join(base,'plugins'),'plugins');
 };
 scope(join(resolve(home),'.gemini','config'));
 // Older documented CLI plugin storage follows the same explicit opt-in.
 directory(join(resolve(home),'.gemini','antigravity-cli','plugins'),'legacy plugins');
 file(join(resolve(home),'.gemini','antigravity-cli','hooks.json'),'legacy hooks');
 file(join(resolve(home),'.gemini','antigravity-cli','mcp_config.json'),'legacy MCP');
 if(workspace){
  // The request directory is created by this module. Parent customizations and
  // personal-discovery redirects are rejected before any CLI process starts.
  let parent=dirname(resolve(workspace));
  while(true){for(const alias of ['.agents','.agent','_agents','_agent'])scope(join(parent,alias));file(join(parent,'.gemini','config.json'),'customization redirect');const next=dirname(parent);if(next===parent)break;parent=next}
 }
 return {safe:blocks.length===0,blocks};
}
function assertEnvironment(options:AntigravityProviderOptions,workspace?:string){
 const result=inspectAntigravityProviderEnvironment(options.home??process.env.HOME??homedir(),workspace,options);
 if(!result.safe){
  const block=result.blocks[0],hooks=block.kind.includes('hooks')||block.kind==='customization redirect';
  throw new Error('Antigravity profile contains external '+block.kind+' execution configuration at '+block.path+'. '+(hooks?'Disable external hooks and customization redirects before using this model connection.':'Enable shared customizations in Connections to permit existing MCP/plugin startup, or disable that configuration in Antigravity.'));
 }
}

function cliPath(options:AntigravityProviderOptions){
 assertEnvironment(options);
 if(options.launch)return options.executable??'/synthetic/agy';
 const path=options.executable??join(homedir(),'.local','bin',process.platform==='win32'?'agy.exe':'agy');
 if(!isAbsolute(path))throw new Error('Antigravity requires an absolute path to the official agy executable.');
 const actual=realpathSync(path),info=statSync(actual);
 if(!info.isFile()||(process.platform!=='win32'&&((info.mode&0o022)!==0||(info.mode&0o111)===0)))throw new Error('The official agy executable must be executable and must not be writable by other users.');
 if(process.platform!=='darwin')throw new Error('The Antigravity model adapter currently supports the verified macOS CLI.');
 const signature=spawnSync('/usr/bin/codesign',['--verify','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',actual],{encoding:'utf8',timeout:10000,maxBuffer:65536,env:antigravityProviderEnvironment(options.home)});
 if(signature.status!==0)throw new Error('Antigravity requires an unmodified CLI with a valid Google code signature.');
 const version=spawnSync(actual,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:65536,env:antigravityProviderEnvironment(options.home)});
 if(version.status!==0||version.stdout.trim()!==ANTIGRAVITY_PROVIDER_TESTED_VERSION)throw new Error('This model adapter requires runtime-verified Antigravity CLI '+ANTIGRAVITY_PROVIDER_TESTED_VERSION+'. Verify compatibility before using a different version.');
 return actual;
}

function jsonObject(value:any){return value!==null&&typeof value==='object'&&!Array.isArray(value)}
function exactKeys(value:any,keys:string[]){return jsonObject(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))}
function validateEnvelope(value:any,tools:Tool[],choice:Choice):Envelope{
 if(!exactKeys(value,['text','tool_calls'])||typeof value.text!=='string'||!Array.isArray(value.tool_calls)||value.tool_calls.length>64)throw new Error('Antigravity returned an invalid structured model response.');
 const names=new Set(tools.map(t=>t.name));
 const forced=typeof choice==='object'?(choice.function?.name??choice.name):undefined;
 for(const call of value.tool_calls){
  if(!exactKeys(call,['name','arguments_json'])||typeof call.name!=='string'||!names.has(call.name)||typeof call.arguments_json!=='string')throw new Error('Antigravity returned an unknown or malformed Chimeric tool call.');
  let args:any;try{args=JSON.parse(call.arguments_json)}catch{throw new Error('Antigravity returned invalid JSON tool arguments.')}
  if(!jsonObject(args))throw new Error('Antigravity tool arguments must be a JSON object.');
  try{const checked=validateToolArguments(tools.find(t=>t.name===call.name)!,{type:'toolCall',id:'validation',name:call.name,arguments:args});if(canonical(checked)!==canonical(args))throw new Error('Arguments need coercion.')}catch{throw new Error('Antigravity returned arguments that do not match the Chimeric tool schema for '+call.name+'.')}
  if(forced&&call.name!==forced)throw new Error('Antigravity returned a tool outside the requested tool choice.');
 }
 if((choice==='none'||!tools.length)&&value.tool_calls.length)throw new Error('Antigravity returned tools when tool use was disabled.');
 if((choice==='required'||forced)&&!value.tool_calls.length)throw new Error('Antigravity did not return the required Chimeric tool call.');
 if(!value.text&&!value.tool_calls.length)throw new Error('Antigravity returned an empty model response.');
 return value;
}

function requestSpec(model:Model<any>,raw:TranscriptContext|Context,options:AntigravityStreamOptions):RequestSpec{
 if(!SLUG.test(model.id))throw new Error('Choose a model slug advertised by the official Antigravity CLI.');
 const context=normalizeContext(raw as Context),tools=getCurrentTools(context.messages);
 // Headless input supports text only. Reject every image, including tool-result images,
 // before starting the CLI or transforming the transcript.
 for(const message of context.messages){
  if(Array.isArray(message.content)&&message.content.some((block:any)=>block.type==='image'))throw new Error('Antigravity model connections currently accept text only. This headless transport cannot send images.');
 }
 let choice:Choice=options.toolChoice??'auto';
 if(!tools.length)choice='none';
 const forced=typeof choice==='object'?(choice.function?.name??choice.name):undefined;
 if(typeof choice==='object'&&(!forced||!tools.some(t=>t.name===forced)))throw new Error('The requested tool is not available in this Chimeric turn.');
 const names=forced?[forced]:tools.map(t=>t.name);
 const schema={type:'object',properties:{text:{type:'string'},tool_calls:{type:'array',maxItems:choice==='none'?0:64,...choice==='required'||forced?{minItems:1}:{},items:{type:'object',properties:{name:{type:'string',...(names.length?{enum:names}:{})},arguments_json:{type:'string'}},required:['name','arguments_json'],additionalProperties:false}}},required:['text','tool_calls'],additionalProperties:false};
 const transcript=context.messages.map(message=>{
  if(message.role==='assistant')return {role:'assistant',content:message.content.map(block=>block.type==='thinking'?{type:'thinking',thinking:block.thinking}:block.type==='toolCall'?{type:'toolCall',id:block.id,name:block.name,arguments:block.arguments}:block)};
  if(message.role==='toolResult')return {role:'toolResult',toolCallId:message.toolCallId,toolName:message.toolName,content:message.content,isError:message.isError};
  if(message.role==='system')return {role:'system',content:message.content,...message.sections?{sections:message.sections}:{},...message.toolsAdded?{toolsAdded:message.toolsAdded}:{},...message.toolsRemoved?{toolsRemoved:message.toolsRemoved}:{}};
  return {role:'user',content:message.content};
 });
 const data={transcript,available_tools:tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters})),tool_choice:choice,max_output_tokens_requested:options.maxTokens??model.maxTokens};
 const prompt='Continue the Chimeric conversation encoded below. The transcript contains ordered system, user, assistant, and toolResult messages. Respect those roles and the current tool declarations. Return exactly one model turn using finish with the required schema. Put user-facing text in text. Put Chimeric tool requests in tool_calls as data, with arguments_json containing one serialized JSON object matching that tool schema. Chimeric executes those tools and returns their results in later turns. Never invoke Antigravity resource, browser, file, command, MCP, messaging, or subagent tools. Use only finish to submit this response. Do not claim a tool was executed until a toolResult in the transcript establishes it. The requested output token budget is advisory because this CLI does not expose a generation token-limit flag.\n\n'+JSON.stringify(data);
 if(Buffer.byteLength(prompt)>MAX_BYTES)throw new Error('Antigravity model context exceeds the 8 MB transport limit.');
 return {schema,prompt,tools,choice,hash:digest(JSON.stringify({model:model.id,effort:options.reasoningEffort??null,data,schema}))};
}

function createWorkspace(root:string|undefined,spec?:RequestSpec){
 if(root)mkdirSync(root,{recursive:true,mode:0o700});
 const directory=mkdtempSync(join(root?resolve(root):tmpdir(),'chimeric-agy-model-'));chmodSync(directory,0o700);
 if(!spec)return directory;
 mkdirSync(join(directory,'.agents','agents'),{recursive:true,mode:0o700});
 // This explicit allowlist reduces the CLI's model-visible tools. The pre-tool
 // hook is the execution boundary; init.tools is only a global advertisement.
 writeFileSync(join(directory,'.agents','agents',AGENT+'.md'),'---\nname: '+AGENT+'\ndescription: Chimeric model transport.\nmainAgent: true\nsubagent: false\ntools:\n  - finish\ncommandExecutionPolicy: off\n---\nYou produce one language-model turn for Chimeric using the requested structured schema. Chimeric owns all tool execution. Return host tool calls as data. Use only finish to submit the structured response.\n',{mode:0o600});
 writeFileSync(join(directory,'response-schema.json'),JSON.stringify(spec.schema),{mode:0o600});
 // Standalone hook: no dependencies, network, credentials, or process spawning.
 // An exact valid finish only records the response and completes the CLI turn.
 const script=`import{readFileSync,writeFileSync}from'node:fs';\nconst names=new Set(${JSON.stringify(spec.tools.map(t=>t.name))});\nlet permitted=false;\ntry{const raw=readFileSync(0,'utf8');if(Buffer.byteLength(raw)>${MAX_BYTES})throw Error();const c=JSON.parse(raw).toolCall;const a=c?.args;permitted=c?.name==='finish'&&a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).length===2&&typeof a.text==='string'&&Array.isArray(a.tool_calls)&&a.tool_calls.length<=64&&a.tool_calls.every(t=>t&&typeof t==='object'&&!Array.isArray(t)&&Object.keys(t).length===2&&names.has(t.name)&&typeof t.arguments_json==='string'&&(()=>{try{const v=JSON.parse(t.arguments_json);return v!==null&&typeof v==='object'&&!Array.isArray(v)}catch{return false}})());if(permitted)writeFileSync(new URL('./finish-proof.json',import.meta.url),JSON.stringify(a),{mode:0o600,flag:'wx'});}catch{permitted=false}\nprocess.stdout.write(JSON.stringify({decision:permitted?'allow':'deny',reason:'Chimeric owns resource and tool execution; only a validated structured finish may complete this model turn.'})+'\\n');\n`;
 const helper=join(directory,'tool-policy.mjs');writeFileSync(helper,script,{mode:0o600});
 const command='BUN_BE_BUN=1 '+quote(process.execPath)+' '+quote(helper);
 writeFileSync(join(directory,'.agents','hooks.json'),JSON.stringify({[HOOK]:{PreToolUse:[{matcher:'*',hooks:[{type:'command',command,timeout:5}]}]}}),{mode:0o600});
 return directory;
}

async function verifyWorkspacePolicy(executable:string,directory:string,options:AntigravityProviderOptions,signal:AbortSignal,timeoutMs:number){
 const {result}=await runCli(executable,['--output-format','stream-json','--settings',JSON.stringify(settings),'--print','/hooks'],directory,options,signal,Math.min(timeoutMs,30000));
 const hooks=result.command?.data?.hooks;
 if(result.command?.name!=='hooks'||!Array.isArray(hooks))throw new Error('Antigravity did not report its active execution hooks.');
 const active=hooks.filter((hook:any)=>hook.enabled!==false),expected=JSON.parse(readFileSync(join(directory,'.agents','hooks.json'),'utf8'))[HOOK].PreToolUse[0].hooks[0];
 if(active.length!==1)throw new Error('Disable other Antigravity execution hooks before using this Chimeric model connection.');
 const hook=active[0],action=hook.actions?.[0];
 if(hook.name!==HOOK||hook.enabled!==true||typeof hook.source!=='string'||realpathSync(hook.source)!==realpathSync(join(directory,'.agents','hooks.json'))||hook.actions.length!==1||action?.event!=='PreToolUse'||action.matcher!=='*'||action.type!=='command'||action.command!==expected.command||action.timeout_seconds!==expected.timeout)throw new Error('Antigravity did not load the exact Chimeric execution policy.');
}

function publicFailure(raw:any){
 const message=String(raw?.message??raw);
 if(/quota|rate.?limit|resource.?exhausted|429/i.test(message))return 'Antigravity reported a quota or rate limit. Chimeric did not resubmit this request.';
 if(/authentication|not authenticated|sign.?in|unauthenticated/i.test(message))return 'Sign in through the official Antigravity CLI to use this model connection.';
 if(/permission.?denied|suspend|account.*disabled|403/i.test(message))return 'Antigravity denied account access. Chimeric did not resubmit this request.';
 return message;
}

/** One official CLI process, one request, one terminal result. Never resumes or retries. */
async function runCli(executable:string,args:string[],directory:string,options:AntigravityProviderOptions,signal:AbortSignal,timeoutMs:number,input?:string,spec?:RequestSpec):Promise<Run>{
 signal.throwIfAborted();
 if(input!==undefined&&Buffer.byteLength(input)>MAX_BYTES)throw new Error('Antigravity serialized input exceeds the 8 MB transport limit.');
 assertEnvironment(options,directory);
 const child=options.launch?.(args,directory)??spawn(executable,args,{cwd:directory,env:antigravityProviderEnvironment(options.home),stdio:['pipe','pipe','pipe'],detached:true,windowsHide:true});
 const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}))});
 // Keep an early startup error handled while stdout is being consumed.
 void closed.catch(()=>{});
 let stopError:Error|undefined,cleanup:Promise<void>|undefined;
 const kill=(signal:NodeJS.Signals)=>{try{if(child.pid&&process.platform!=='win32')process.kill(-child.pid,signal);else if(child.exitCode===null&&child.signalCode===null)child.kill(signal)}catch{if(child.exitCode===null&&child.signalCode===null)child.kill(signal)}};
 const cleanupGroup=()=>{
  if(cleanup)return cleanup;
  kill('SIGTERM');
  // The group can outlive its leader with ignored/inherited pipes. Complete the
  // escalation even when the direct child closes before this timer fires.
  cleanup=new Promise(done=>setTimeout(()=>{kill('SIGKILL');done()},options.killGraceMs??500));return cleanup;
 };
 const stop=(reason:Error)=>{
  if(stopError)return;stopError=reason;
  void cleanupGroup();
 };
 const abort=()=>stop(new Error('Antigravity model request was cancelled.'));
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 const timer=setTimeout(()=>stop(new Error('Antigravity model request timed out. Chimeric did not resubmit this request.')),timeoutMs);timer.unref();
 let bytes=0,stderrBytes=0,buffer='',init:any,result:any,commandResult:any,finish:Envelope|undefined,finishDone=false,conversationId:string|undefined;
 const decoder=new StringDecoder('utf8');
 child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>MAX_BYTES)stop(new Error('Antigravity diagnostics exceeded the 8 MB limit.'))});
 child.stdin.on('error',error=>stop(new Error('Antigravity input pipe closed: '+((error as NodeJS.ErrnoException).code??'closed'))));
 const line=(text:string)=>{
  if(!text.trim())return;
  let event:any;try{event=JSON.parse(text)}catch{throw new Error('Antigravity emitted malformed JSON.')}
  if(event.event==='init'){
   if(init||result)throw new Error('Antigravity emitted a duplicate or out-of-order initialization.');
   init=event.init;conversationId=event.conversation_id;
   if(spec&&(typeof conversationId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(conversationId)))throw new Error('Antigravity did not identify its model conversation.');
   if(spec&&(init?.model!==args[args.indexOf('--model')+1]||init?.agent!==AGENT||init?.permission_mode!=='strict'||canonical(init?.json_schema)!==canonical(spec.schema)))throw new Error('Antigravity did not apply the requested model and execution policy.');
  }else if(event.event==='step_update'){
   if(!init||result)throw new Error('Antigravity emitted an out-of-order model step.');
   const step=event.step_update;
   if(step?.conversation_id!==conversationId)throw new Error('Antigravity mixed model conversations.');
   if(step.step_type==='tool'){
    if(step.tool_name!=='finish'||step.tool_info?.name!=='finish')throw new Error('Antigravity attempted its own tool execution. The pre-tool policy denies this action; the model request has stopped.');
    if(step.state==='ACTIVE'){if(finish)throw new Error('Antigravity attempted a second finish.');finish=validateEnvelope(step.tool_info.parameters,spec!.tools,spec!.choice)}
    else if(step.state==='ERROR')throw new Error('Antigravity could not validate the structured finish.');
   }else if(step.step_type==='finish'){
    if(!finish||step.state!=='DONE')throw new Error('Antigravity emitted an invalid finish step.');finishDone=true;
   }else if(!['user_input','agent_response','checkpoint'].includes(step.step_type))throw new Error('Antigravity emitted an unsupported model step.');
  }else if(event.event==='command_result'&&!spec){
   if(commandResult||result)throw new Error('Antigravity emitted duplicate command results.');commandResult=event.command;
  }else if(event.event==='result'){
   if(result)throw new Error('Antigravity emitted duplicate terminal results.');
   result=event.result;
   if(spec&&(!init||result?.conversation_id!==conversationId))throw new Error('Antigravity emitted a result for a different conversation.');
  }else throw new Error('Antigravity emitted an unsupported transport event.');
 };
 try{
  if(input!==undefined)child.stdin.end(input);else child.stdin.end();
  for await(const chunk of child.stdout){
   bytes+=chunk.length;if(bytes>MAX_BYTES)throw new Error('Antigravity output exceeded the 8 MB limit.');
   buffer+=decoder.write(chunk);let newline:number;
   while((newline=buffer.indexOf('\n'))!==-1){const text=buffer.slice(0,newline);buffer=buffer.slice(newline+1);line(text)}
   if(stopError)throw stopError;
  }
  buffer+=decoder.end();if(buffer.trim())line(buffer);
  const status=await closed;if(stopError)throw stopError;
  if(status.code!==0||result?.status!=='SUCCESS')throw new Error(publicFailure(result?.error??'The official Antigravity CLI exited without a successful result.'));
  if(commandResult&&canonical(commandResult)!==canonical(result.command))throw new Error('Antigravity returned inconsistent catalog results.');
  if(spec){
   const output=validateEnvelope(result.structured_output,spec.tools,spec.choice);
   const proofPath=join(directory,'finish-proof.json');let proof:any;
   try{if(!lstatSync(proofPath).isFile()||lstatSync(proofPath).isSymbolicLink())throw new Error();proof=JSON.parse(readFileSync(proofPath,'utf8'))}catch{throw new Error('Antigravity completed without the enforced structured-finish proof.')}
   if(!finish||!finishDone||canonical(finish)!==canonical(output)||canonical(proof)!==canonical(output))throw new Error('Antigravity completed without the enforced structured-finish proof.');
  }
  return {result,finish,conversationId};
 }catch(error){stop(error instanceof Error?error:new Error(String(error)));await closed.catch(()=>{});throw stopError??error}
 finally{
  clearTimeout(timer);signal.removeEventListener('abort',abort);
  if(!cleanup&&child.pid&&process.platform!=='win32'){try{process.kill(-child.pid,0);void cleanupGroup()}catch{/* No process from this request remains in its group. */}}
  await cleanup;
 }
}

function emptyMessage(model:Model<any>):AssistantMessage{return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending',timestamp:Date.now()}}
function applyResult(message:AssistantMessage,run:Run,spec:RequestSpec){
 const output=validateEnvelope(run.result.structured_output,spec.tools,spec.choice),usage=run.result.usage;
 for(const field of ['input_tokens','output_tokens','cache_read_tokens','thinking_tokens'])if(!Number.isSafeInteger(usage?.[field])||usage[field]<0)throw new Error('Antigravity returned invalid token accounting.');
 message.usage={input:usage.input_tokens,output:usage.output_tokens,cacheRead:usage.cache_read_tokens,cacheWrite:0,reasoning:usage.thinking_tokens,totalTokens:usage.input_tokens+usage.output_tokens+usage.cache_read_tokens,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
 message.responseId=run.conversationId;
 if(output.text)message.content.push({type:'text',text:output.text});
 for(const call of output.tool_calls)message.content.push({type:'toolCall',id:'call_agy_'+randomUUID().replaceAll('-',''),name:call.name,arguments:JSON.parse(call.arguments_json)});
 message.stopReason=output.tool_calls.length?'toolUse':'stop';return message;
}

export class AntigravityModelProvider{
 private active=new Set<AbortController>();
 private tasks=new Set<Promise<unknown>>();
 private closed=false;
 private requests=new Map<string,{hash:string;promise:Promise<AssistantMessage>}>();
 constructor(private options:AntigravityProviderOptions={}){}
 stream(model:Model<any>,context:TranscriptContext|Context,options:AntigravityStreamOptions={}){
  const stream=new AssistantMessageEventStream(),message=emptyMessage(model);
  const task=(async()=>{
   const controller=new AbortController();this.active.add(controller);
   const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
   try{
    if(this.closed)throw new Error('Antigravity model provider is closed.');signal.throwIfAborted();
    const spec=requestSpec(model,context,options);
    if(options.reasoningEffort&&!EFFORTS.has(options.reasoningEffort))throw new Error('Antigravity supports low, medium, high, xhigh, or max effort.');
    const perform=async()=>{
     const timeout=options.timeoutMs??this.options.timeoutMs??600000;
     if(!Number.isFinite(timeout)||timeout<1||timeout>3600000)throw new Error('Antigravity request timeout must be between 1 ms and one hour.');
     const deadline=Date.now()+timeout,executable=cliPath(this.options),directory=createWorkspace(this.options.workRoot,spec);
     try{
      await verifyWorkspacePolicy(executable,directory,this.options,signal,Math.max(1,deadline-Date.now()));
      const args=['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--sandbox','--agent',AGENT,'--model',model.id,'--settings',JSON.stringify(settings),'--json-schema',join(directory,'response-schema.json')];
      if(options.reasoningEffort)args.push('--effort',options.reasoningEffort);
      const payload={model:model.id,...options.reasoningEffort?{reasoning_effort:options.reasoningEffort}:{}};
      const inspected=await options.onPayload?.(payload,model);if(inspected!==undefined&&JSON.stringify(inspected)!==JSON.stringify(payload))throw new Error('Antigravity does not support overriding its model transport payload.');
      if(Date.now()>=deadline)throw new Error('Antigravity model request timed out before inference. Chimeric did not resubmit this request.');
      const run=await runCli(executable,args,directory,this.options,signal,deadline-Date.now(),JSON.stringify({event:'user',message:{content:spec.prompt}})+'\n',spec);
      return applyResult(emptyMessage(model),run,spec);
     }finally{rmSync(directory,{recursive:true,force:true})}
    };
    let result:AssistantMessage;
    if(options.requestId){
     if(!/^[a-zA-Z0-9_.:-]{1,200}$/.test(options.requestId))throw new Error('Invalid Antigravity request identity.');
     const existing=this.requests.get(options.requestId);
     if(existing){if(existing.hash!==spec.hash)throw new Error('This Antigravity request identity was already used for a different model request.');result=await existing.promise}
     else{if(this.requests.size>=128)throw new Error('Antigravity request replay storage is full. Reconnect before starting new requests.');const promise=perform();this.requests.set(options.requestId,{hash:spec.hash,promise});result=await promise}
    }else result=await perform();
    signal.throwIfAborted();Object.assign(message,structuredClone(result));
    // Raw JSON is withheld until validation, so it never leaks into native chat.
    const blocks=message.content;message.content=[];stream.push({type:'start',partial:message});
    for(const block of blocks){
     const contentIndex=message.content.length;
     if(block.type==='text'){message.content.push({type:'text',text:''});stream.push({type:'text_start',contentIndex,partial:message});message.content[contentIndex]=block;stream.push({type:'text_delta',contentIndex,delta:block.text,partial:message});stream.push({type:'text_end',contentIndex,content:block.text,partial:message})}
     else if(block.type==='toolCall'){message.content.push({...block,arguments:{}});stream.push({type:'toolcall_start',contentIndex,partial:message});message.content[contentIndex]=block;stream.push({type:'toolcall_delta',contentIndex,delta:JSON.stringify(block.arguments),partial:message});stream.push({type:'toolcall_end',contentIndex,toolCall:block,partial:message})}
    }
    stream.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});stream.end();
   }catch(error){message.stopReason=signal.aborted?'aborted':'error';message.errorMessage=publicFailure(error);stream.push({type:'error',reason:message.stopReason,error:message});stream.end()}
   finally{this.active.delete(controller)}
  })();this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));return stream;
 }
 async catalog(signal?:AbortSignal){
  if(this.closed)throw new Error('Antigravity model provider is closed.');
  const controller=new AbortController();this.active.add(controller);
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const task=discoverAntigravityModels(this.options.executable,{...this.options,signal:combined});this.tasks.add(task);
  try{return await task}finally{this.tasks.delete(task);this.active.delete(controller)}
 }
 async close(){this.closed=true;for(const controller of this.active)controller.abort();await Promise.allSettled([...this.tasks]);this.requests.clear()}
}

export function createAntigravityProvider(options:AntigravityProviderOptions={}){return new AntigravityModelProvider(options)}
export function streamAntigravity(model:Model<any>,context:TranscriptContext|Context,options:AntigravityStreamOptions&AntigravityProviderOptions={}){return new AntigravityModelProvider(options).stream(model,context,options)}

export async function discoverAntigravityModels(executable?:string,options:AntigravityProviderOptions&{signal?:AbortSignal}={}):Promise<AntigravityCatalogModel[]>{
 options.signal?.throwIfAborted();
 const configured={...options,...executable?{executable}:{}},path=cliPath(configured),directory=createWorkspace(options.workRoot);
 try{
  // Slash commands are answered by the official CLI without a model request.
  const {result}=await runCli(path,['--output-format','stream-json','--settings',JSON.stringify(settings),'models'],directory,configured,options.signal??new AbortController().signal,options.timeoutMs??30000);
  const models=result.command?.data?.models;
  if(result.command?.name!=='models'||!Array.isArray(models)||models.length>4096)throw new Error('Antigravity did not return a supported model catalog.');
  const seen=new Set<string>();return models.map((model:any)=>{if(!SLUG.test(model.id)||typeof model.label!=='string'||model.label.length>500||seen.has(model.id))throw new Error('Antigravity returned an invalid model catalog.');seen.add(model.id);return {id:model.id,name:model.label}});
 }finally{rmSync(directory,{recursive:true,force:true})}
}
