import {spawn,spawnSync,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {mkdtempSync,mkdirSync,chmodSync,rmSync,realpathSync,statSync,existsSync} from 'node:fs';
import {join,isAbsolute,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import type {AssistantMessage,Model,TranscriptContext,Context,StreamOptions,Tool} from '@earendil-works/pi-ai';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {normalizeContext,getCurrentTools} from '@earendil-works/pi-ai/utils/transcript';
import {validateToolArguments} from '@earendil-works/pi-ai/utils/validation';

const MAX_BYTES=8*1024*1024;
const ALIASES=new Set(['default','opus','sonnet','haiku']);
// Reviewed official model ID, not a claim that every subscription can use it.
export const CLAUDE_CODE_REVIEWED_MODEL_IDS=Object.freeze(['claude-fable-5-2']);
const EFFORTS=new Set(['low','medium','high','xhigh','max']);
const settings={disableAllHooks:true,autoMemoryEnabled:false,enableAllProjectMcpServers:false,
 permissions:{allow:[],deny:['Bash','PowerShell','Read','Write','Edit','WebFetch','WebSearch','Agent','mcp__*']},
 fallbackModel:[],switchModelsOnFlag:false,ultracode:false};
export const CLAUDE_CODE_MIN_VERSION='2.1.321';
export class ClaudeCodeError extends Error{constructor(message:string,readonly status=400){super(message)}}
export type ClaudeCodeProviderOptions={executable?:string;home?:string;workRoot?:string;timeoutMs?:number;killGraceMs?:number;
 /** Synthetic process seam for tests. Production always starts the installed official client. */
 launch?:(args:string[],cwd:string,env:NodeJS.ProcessEnv)=>ChildProcessWithoutNullStreams;
};
type Choice='auto'|'none'|'required'|{type:'function';function?:{name:string};name?:string};
export type ClaudeCodeStreamOptions=StreamOptions&{toolChoice?:Choice;reasoningEffort?:string;requestId?:string;dataClass?:'standard'|'class2'};
type Envelope={text:string;tool_calls:Array<{name:string;arguments_json:string}>};
type Spec={prompt:string;schema:any;tools:Tool[];choice:Choice;hash:string};
const object=(value:any)=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value:any,keys:string[])=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>object(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Credential files and tokens are never read, imported, or returned by Chimeric. */
export function claudeCodeEnvironment(home?:string){
 const env:NodeJS.ProcessEnv={};
 for(const name of ['PATH','HOME','USER','LOGNAME','TMPDIR','TEMP','TMP','LANG','LC_ALL','SHELL','SYSTEMROOT','WINDIR'])if(process.env[name]!==undefined)env[name]=process.env[name];
 env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
 if(home!==undefined){if(!isAbsolute(home))throw new ClaudeCodeError('The official client home must be an absolute directory.');env.HOME=resolve(home)}
 return env;
}
export function findClaudeCodeExecutable(){
 const name=process.platform==='win32'?'claude.exe':'claude';
 for(const directory of (process.env.PATH??'').split(process.platform==='win32'?';':':')){
  if(!directory||!isAbsolute(directory))continue;
  const path=join(directory,name);if(existsSync(path))return path;
 }
 for(const path of [join(homedir(),'.local','bin',name),'/opt/homebrew/bin/claude','/usr/local/bin/claude'])if(existsSync(path))return path;
 return '';
}
export function inspectClaudeCodeExecutable(options:ClaudeCodeProviderOptions={}){
 if(options.launch)return {executable:options.executable??'/synthetic/claude',version:CLAUDE_CODE_MIN_VERSION,signatureVerified:true};
 const supplied=options.executable||findClaudeCodeExecutable();
 if(!supplied)throw new ClaudeCodeError('Install the official Claude Code CLI, then check this connection.',409);
 if(!isAbsolute(supplied))throw new ClaudeCodeError('Choose the absolute path to the official Claude Code executable.');
 let executable:string,info:ReturnType<typeof statSync>;
 try{executable=realpathSync(supplied);info=statSync(executable)}catch{throw new ClaudeCodeError('The official Claude Code executable is unavailable.',409)}
 if(!info.isFile()||(process.platform!=='win32'&&((info.mode&0o022)!==0||(info.mode&0o111)===0)))throw new ClaudeCodeError('The official client must be executable and must not be writable by other users.',409);
 if(process.platform==='win32')throw new ClaudeCodeError('Use the official Claude Code client inside WSL for this connection.',409);
 let signatureVerified=false;
 if(process.platform==='darwin'){
  const signature=spawnSync('/usr/bin/codesign',['--verify','--strict','-R','=anchor apple generic and identifier "com.anthropic.claude-code" and certificate leaf[subject.OU] = "Q6L2SF6YDW"',executable],{encoding:'utf8',timeout:10000,maxBuffer:65536,env:claudeCodeEnvironment(options.home)});
  if(signature.status!==0)throw new ClaudeCodeError('The Claude Code signature could not be verified in this execution environment. Verify the official installation and check again outside a restricted shell before connecting.',409);
  signatureVerified=true;
 }
 const result=spawnSync(executable,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:65536,env:claudeCodeEnvironment(options.home)});
 const match=result.status===0&&result.stdout.trim().match(/^(\d+)\.(\d+)\.(\d+) \(Claude Code\)$/);
 if(!match||Number(match[1])!==2||Number(match[2])<1||(Number(match[2])===1&&Number(match[3])<321))throw new ClaudeCodeError('This connection requires official Claude Code '+CLAUDE_CODE_MIN_VERSION+' or a compatible later 2.x version.',409);
 return {executable,version:match.slice(1).join('.'),signatureVerified};
}
export function claudeCodeSafetyFlags(){return ['--safe-mode','--restricted','--setting-sources','','--settings',JSON.stringify(settings),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--disallowedTools','mcp__*']}

export function claudeCodeAuthorizationUrl(text:string){
 for(const candidate of text.match(/https:\/\/[^\s<>"']+/g)??[]){
  try{const url=new URL(candidate.replace(/[),.;]+$/,''));if(!url.username&&!url.password&&!url.hash&&['claude.ai','console.anthropic.com','platform.claude.com'].includes(url.hostname)&&url.pathname==='/oauth/authorize')return url.href}catch{/* Ignore non-URL diagnostics. */}
 }
 return undefined;
}
export async function runClaudeCodeCommand(options:ClaudeCodeProviderOptions,args:string[],input:string|undefined,signal:AbortSignal,timeoutMs:number,onData?:(text:string)=>void){
 signal.throwIfAborted();
 if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new ClaudeCodeError('The official client timeout must be between 1 ms and one hour.');
 const executable=inspectClaudeCodeExecutable(options).executable;
 if(options.workRoot)mkdirSync(options.workRoot,{recursive:true,mode:0o700});
 const cwd=mkdtempSync(join(options.workRoot?resolve(options.workRoot):tmpdir(),'chimeric-claude-model-'));chmodSync(cwd,0o700);
 let child:ChildProcessWithoutNullStreams|undefined,timer:ReturnType<typeof setTimeout>|undefined,force:ReturnType<typeof setTimeout>|undefined;
 let failure:Error|undefined;
 const terminate=(error:Error)=>{
  failure??=error;if(!child)return;
  const kill=(mode:NodeJS.Signals)=>{try{if(child!.pid&&process.platform!=='win32')process.kill(-child!.pid,mode);else child!.kill(mode)}catch{/* Already stopped. */}};
  kill('SIGTERM');force??=setTimeout(()=>kill('SIGKILL'),options.killGraceMs??1000);
 };
 const abort=()=>terminate(new ClaudeCodeError('The official client request was cancelled.',409));
 try{
  child=options.launch?options.launch(args,cwd,claudeCodeEnvironment(options.home)):spawn(executable,args,{cwd,env:claudeCodeEnvironment(options.home),stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  const closed=new Promise<number|null>((done,reject)=>{child!.once('error',()=>reject(new ClaudeCodeError('Could not start the official Claude Code client.',409)));child!.once('close',code=>done(code))});
  void closed.catch(()=>{});
  let stdout='',stderr='',bytes=0;const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
  const collect=(which:'stdout'|'stderr',chunk:Buffer)=>{
   bytes+=chunk.length;if(bytes>MAX_BYTES){terminate(new ClaudeCodeError('The official client output exceeded the 8 MB limit.'));return}
   const text=decoders[which].write(chunk);if(which==='stdout')stdout+=text;else stderr+=text;
   try{onData?.(text)}catch{terminate(new ClaudeCodeError('The official client returned invalid connection metadata.'))}
  };
  child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
  child.stdin.on('error',()=>{});signal.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>terminate(new ClaudeCodeError('The official client request timed out. Chimeric did not resubmit it.',408)),timeoutMs);
  if(signal.aborted)abort();
  child.stdin.end(input);
  const code=await closed;stdout+=decoders.stdout.end();stderr+=decoders.stderr.end();if(failure)throw failure;signal.throwIfAborted();
  return {code,stdout,stderr};
 }finally{
  clearTimeout(timer);signal.removeEventListener('abort',abort);
  if(child?.pid&&process.platform!=='win32'){
   try{process.kill(-child.pid,'SIGKILL')}catch{/* No request process remains. */}
  }
  clearTimeout(force);rmSync(cwd,{recursive:true,force:true});
 }
}

function envelope(value:any,spec:Spec):Envelope{
 if(!exact(value,['text','tool_calls'])||typeof value.text!=='string'||!Array.isArray(value.tool_calls)||value.tool_calls.length>64)throw new ClaudeCodeError('The official client returned an invalid structured model turn.');
 const forced=typeof spec.choice==='object'?(spec.choice.function?.name??spec.choice.name):undefined;
 for(const call of value.tool_calls){
  if(!exact(call,['name','arguments_json'])||typeof call.name!=='string'||typeof call.arguments_json!=='string')throw new ClaudeCodeError('The official client returned a malformed Chimeric tool request.');
  const tool=spec.tools.find(tool=>tool.name===call.name);
  if(!tool||(forced&&forced!==call.name))throw new ClaudeCodeError('The official client requested a tool outside this Chimeric turn.');
  let args:any;try{args=JSON.parse(call.arguments_json)}catch{throw new ClaudeCodeError('The official client returned invalid JSON tool arguments.')}
  if(!object(args))throw new ClaudeCodeError('Chimeric tool arguments must be a JSON object.');
  try{const checked=validateToolArguments(tool,{type:'toolCall',id:'validation',name:call.name,arguments:args});if(canonical(checked)!==canonical(args))throw Error()}catch{throw new ClaudeCodeError('The official client returned arguments that do not match the Chimeric tool schema.')}
 }
 if(spec.choice==='none'&&value.tool_calls.length)throw new ClaudeCodeError('The official client requested tools when tool use was disabled.');
 if((spec.choice==='required'||forced)&&!value.tool_calls.length)throw new ClaudeCodeError('The official client omitted the required Chimeric tool request.');
 if(!value.text&&!value.tool_calls.length)throw new ClaudeCodeError('The official client returned an empty model turn.');
 return value;
}
function requestSpec(model:Model<any>,raw:TranscriptContext|Context,options:ClaudeCodeStreamOptions):Spec{
 if(options.dataClass==='class2')throw new ClaudeCodeError('Claude Code is unavailable in Class 2 mode until its complete confinement is verified.',403);
 if(!ALIASES.has(model.id)&&!CLAUDE_CODE_REVIEWED_MODEL_IDS.includes(model.id))throw new ClaudeCodeError('Choose a documented official Claude Code alias or reviewed exact model identifier.');
 if(options.reasoningEffort!==undefined&&!EFFORTS.has(options.reasoningEffort))throw new ClaudeCodeError('Choose a documented Claude Code effort level.');
 const context=normalizeContext(raw as Context),tools=getCurrentTools(context.messages);
 if(context.messages.some(message=>Array.isArray(message.content)&&message.content.some((block:any)=>block.type==='image')))throw new ClaudeCodeError('This Claude Code model transport currently accepts text only.');
 let choice:Choice=options.toolChoice??'auto';if(!tools.length)choice='none';
 const forced=typeof choice==='object'?(choice.function?.name??choice.name):undefined;
 if(typeof choice==='object'&&(!forced||!tools.some(tool=>tool.name===forced)))throw new ClaudeCodeError('The requested Chimeric tool is not available.');
 const names=forced?[forced]:tools.map(tool=>tool.name);
 const schema={type:'object',properties:{text:{type:'string'},tool_calls:{type:'array',maxItems:choice==='none'?0:64,...choice==='required'||forced?{minItems:1}:{},items:{type:'object',properties:{name:{type:'string',...(names.length?{enum:names}:{})},arguments_json:{type:'string'}},required:['name','arguments_json'],additionalProperties:false}}},required:['text','tool_calls'],additionalProperties:false};
 const transcript=context.messages.map(message=>{
  if(message.role==='assistant')return {role:message.role,content:message.content.map(block=>block.type==='toolCall'?{type:block.type,id:block.id,name:block.name,arguments:block.arguments}:block)};
  if(message.role==='toolResult')return {role:message.role,toolCallId:message.toolCallId,toolName:message.toolName,content:message.content,isError:message.isError};
  if(message.role==='system')return {role:message.role,content:message.content,...message.toolsAdded?{toolsAdded:message.toolsAdded}:{},...message.toolsRemoved?{toolsRemoved:message.toolsRemoved}:{}};
  return {role:message.role,content:message.content};
 });
 const payload={transcript,available_tools:tools.map(tool=>({name:tool.name,description:tool.description,parameters:tool.parameters})),tool_choice:choice,max_output_tokens_requested:options.maxTokens??model.maxTokens};
 const prompt='Return exactly one Chimeric model turn using the JSON schema. The encoded transcript retains system, user, assistant, and toolResult roles. Follow the system instructions and current tool declarations. Put user-facing prose in text. Put requested Chimeric tools in tool_calls as data, with arguments_json containing one JSON object matching that tool schema. Chimeric alone executes these tools and provides their results on a later turn. Do not run client tools or claim an action happened unless the transcript contains its actual result. The output token budget is advisory for this official-client transport.\n\n'+JSON.stringify(payload);
 if(Buffer.byteLength(prompt)>MAX_BYTES)throw new ClaudeCodeError('The model transcript exceeds the 8 MB official-client input limit.');
 return {prompt,schema,tools,choice,hash:hash(JSON.stringify({model:model.id,effort:options.reasoningEffort??null,payload,schema}))};
}
function blank(model:Model<any>):AssistantMessage{return {role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'pending',timestamp:Date.now()}}
function resultMessage(model:Model<any>,text:string,spec:Spec){
 let result:any,seen=0,actualModel:string|undefined;
 for(const line of text.split('\n').filter(line=>line.trim())){
  let event:any;try{event=JSON.parse(line)}catch{throw new ClaudeCodeError('The official client returned malformed JSON output.')}
  if(event.type==='assistant'){
   if(typeof event.message?.model==='string')actualModel=event.message.model;
   for(const block of event.message?.content??[])if(block.type==='tool_use'&&block.name!=='StructuredOutput')throw new ClaudeCodeError('The official client attempted its own tool execution; this model connection was stopped.');
  }
  if(event.type==='result'){if(++seen>1)throw new ClaudeCodeError('The official client returned duplicate terminal results.');result=event}
 }
 if(!result||result.subtype!=='success'||result.is_error===true)throw new ClaudeCodeError('The official client did not complete this model turn. Check its account, quota, model access, and official CLI status.');
 if(!actualModel)throw new ClaudeCodeError('The official client did not identify the model that produced this turn.');
 if(CLAUDE_CODE_REVIEWED_MODEL_IDS.includes(model.id)?actualModel!==model.id:model.id!=='default'&&!actualModel.startsWith('claude-'+model.id+'-'))throw new ClaudeCodeError('The official client changed the requested model. Chimeric did not accept the substituted response.');
 const output=envelope(result.structured_output,spec),message=blank(model),usage=result.usage??{};
 const number=(name:string)=>{const value=usage[name]??0;if(!Number.isSafeInteger(value)||value<0)throw new ClaudeCodeError('The official client returned invalid token accounting.');return value};
 message.usage.input=number('input_tokens');message.usage.output=number('output_tokens');message.usage.cacheRead=number('cache_read_input_tokens');message.usage.cacheWrite=number('cache_creation_input_tokens');message.usage.totalTokens=message.usage.input+message.usage.output+message.usage.cacheRead+message.usage.cacheWrite;
 if(typeof result.session_id==='string'&&/^[a-zA-Z0-9_-]{1,200}$/.test(result.session_id))message.responseId=result.session_id;
 if(output.text)message.content.push({type:'text',text:output.text});
 for(const call of output.tool_calls)message.content.push({type:'toolCall',id:'call_cc_'+randomUUID().replaceAll('-',''),name:call.name,arguments:JSON.parse(call.arguments_json)});
 message.stopReason=output.tool_calls.length?'toolUse':'stop';return message;
}
export class ClaudeCodeModelProvider{
 private controllers=new Set<AbortController>();private tasks=new Set<Promise<unknown>>();private closed=false;
 private replays=new Map<string,{hash:string;promise:Promise<AssistantMessage>}>();
 constructor(private options:ClaudeCodeProviderOptions={}){}
 stream(model:Model<any>,context:TranscriptContext|Context,options:ClaudeCodeStreamOptions={}){
  const events=new AssistantMessageEventStream(),message=blank(model),controller=new AbortController();this.controllers.add(controller);
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  const task=(async()=>{try{
   if(this.closed)throw new ClaudeCodeError('The official-client connection is closed.',409);signal.throwIfAborted();
   const spec=requestSpec(model,context,options);
   const perform=async()=>{
    const authenticated=await runClaudeCodeCommand(this.options,[...claudeCodeSafetyFlags(),'auth','status'],undefined,signal,30000);
    let identity:any;try{identity=JSON.parse(authenticated.stdout)}catch{throw new ClaudeCodeError('The official client could not confirm subscription authentication. Check its sign-in again.',409)}
    if(authenticated.code!==0||identity?.loggedIn!==true||identity?.authMethod!=='claude.ai')throw new ClaudeCodeError('The official client is not using a verified Claude subscription sign-in. No model request was sent.',409);
    const args=[...claudeCodeSafetyFlags(),'--print','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--disable-slash-commands','--no-session-persistence','--max-turns','4','--model',model.id,'--json-schema',JSON.stringify(spec.schema)];
    if(options.reasoningEffort)args.push('--effort',options.reasoningEffort);
    const payload={model:model.id,...options.reasoningEffort?{reasoning_effort:options.reasoningEffort}:{}};
    const inspected=await options.onPayload?.(payload,model);if(inspected!==undefined&&JSON.stringify(inspected)!==JSON.stringify(payload))throw new ClaudeCodeError('The official-client transport does not permit payload overrides.');
    const run=await runClaudeCodeCommand(this.options,args,JSON.stringify({type:'user',message:{role:'user',content:spec.prompt}})+'\n',signal,options.timeoutMs??this.options.timeoutMs??600000);
    if(run.code!==0)throw new ClaudeCodeError('The official client could not complete this turn. Check sign-in, quota, model access, and the official CLI.');
    return resultMessage(model,run.stdout,spec);
   };
   let result:AssistantMessage;
   if(options.requestId){
    if(!/^[a-zA-Z0-9_.:-]{1,200}$/.test(options.requestId))throw new ClaudeCodeError('Invalid model request identity.');
    const previous=this.replays.get(options.requestId);
    if(previous){if(previous.hash!==spec.hash)throw new ClaudeCodeError('This request identity was used for a different model turn.');result=await previous.promise}
    else{if(this.replays.size>=128)throw new ClaudeCodeError('Reconnect this official-client connection before starting more requests.');const promise=perform();this.replays.set(options.requestId,{hash:spec.hash,promise});result=await promise}
   }else result=await perform();
   signal.throwIfAborted();Object.assign(message,structuredClone(result));const blocks=message.content;message.content=[];events.push({type:'start',partial:message});
   for(const block of blocks){const contentIndex=message.content.length;
    if(block.type==='text'){message.content.push({type:'text',text:''});events.push({type:'text_start',contentIndex,partial:message});message.content[contentIndex]=block;events.push({type:'text_delta',contentIndex,delta:block.text,partial:message});events.push({type:'text_end',contentIndex,content:block.text,partial:message})}
    else if(block.type==='toolCall'){message.content.push({...block,arguments:{}});events.push({type:'toolcall_start',contentIndex,partial:message});message.content[contentIndex]=block;events.push({type:'toolcall_delta',contentIndex,delta:JSON.stringify(block.arguments),partial:message});events.push({type:'toolcall_end',contentIndex,toolCall:block,partial:message})}
   }
   events.push({type:'done',reason:message.stopReason as 'stop'|'toolUse',message});events.end();
  }catch(error){message.stopReason=signal.aborted?'aborted':'error';message.errorMessage=error instanceof ClaudeCodeError?error.message:'The official client could not complete this request. Check its installation and connection.';events.push({type:'error',reason:message.stopReason,error:message});events.end()}
  finally{this.controllers.delete(controller)}})();
  this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));return events;
 }
 async close(){this.closed=true;for(const controller of this.controllers)controller.abort();await Promise.allSettled(this.tasks);this.replays.clear()}
}
