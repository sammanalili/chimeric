import {randomUUID} from 'node:crypto';
import {ClaudeCodeError,claudeCodeSafetyFlags,runClaudeCodeCommand,type ClaudeCodeProviderOptions} from './claude-code-provider';

export type ClaudeCodeDiscoveredModel={
 id:string;name:string;transportId:string;resolvedModel?:string;input:['text']|['text','image'];verified:false;reasoning:boolean;
 reasoningEfforts:Record<string,string>;reasoningEffortsVerified:boolean;reasoningEffortsSource:'official-cli-catalog';
 supportsAdaptiveThinking:boolean;availability:'unknown';contextWindow?:number;max_input_tokens?:number;max_output_tokens?:number;
};
const efforts=new Set(['low','medium','high','xhigh','max']);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9][a-z0-9._:/-]{0,190}(?:\[1m\])?$/i.test(value);
// ModelInfo currently omits token limits. These exact resolved model IDs have
// documented text/image input, 1M context and 128K output. The common image
// transport was live-tested with Haiku; individual model probes remain distinct.
// Do not extend these declarations to unknown versions.
// https://platform.claude.com/docs/en/build-with-claude/context-windows
// https://platform.claude.com/docs/en/models/haiku-5-5/overview
const reviewedMultimodalModels=new Set(['claude-opus-5-5','claude-sonnet-5-5','claude-haiku-5-5','claude-fable-5-2']);
function reportedLimit(row:any,fields:string[]):number|undefined{
 for(const field of fields){
  const value=row[field];
  if(value!==undefined&&(!Number.isSafeInteger(value)||value<1||value>100_000_000))throw new ClaudeCodeError('The official client returned invalid model token limits.',409);
 }
 const values=fields.map(field=>row[field]).filter(value=>value!==undefined);
 // A per-account input cap can be lower than the model's total context.
 return values.length?Math.min(...values):undefined;
}
function tokenLimits(row:any,contextVariant:boolean){
 const reportedContext=reportedLimit(row,['max_input_tokens','maxInputTokens','contextWindow','maxContextWindowTokens','context_length']);
 const reportedOutput=reportedLimit(row,['max_output_tokens','maxOutputTokens']);
 const reviewed=reviewedMultimodalModels.has(row.resolvedModel??row.value.replace(/\[1m\]$/i,''));
 const context=reportedContext??(reviewed||contextVariant?1_000_000:undefined),output=reportedOutput??(reviewed?128_000:undefined);
 return {...context!==undefined?{contextWindow:context,max_input_tokens:context}:{},...output!==undefined?{max_output_tokens:output}:{}};
}
function versionedName(displayName:string,resolved:string|undefined,isDefault:boolean){
 const match=resolved?.match(/^claude-([a-z][a-z0-9-]*?)-(\d+)-(\d+)(?:-\d{8})?$/i);
 if(!match)return displayName;
 const family=match[1].split('-').map(part=>part[0].toUpperCase()+part.slice(1)).join(' '),name=family+' '+match[2]+'.'+match[3];
 return isDefault?'Default ('+name+')':/\d/.test(displayName)?displayName:name;
}
export function normalizeClaudeCodeModels(value:unknown):ClaudeCodeDiscoveredModel[]{
 if(!Array.isArray(value)||value.length<1||value.length>128)throw new ClaudeCodeError('The official client returned an invalid model catalog.',409);
 const result=new Map<string,ClaudeCodeDiscoveredModel>();
 for(const row of value){
  if(!row||typeof row!=='object'||!identifier(row.value)||typeof row.displayName!=='string'||!row.displayName.trim()||row.displayName.length>200||/[\u0000-\u001f]/.test(row.displayName)||row.resolvedModel!==undefined&&!identifier(row.resolvedModel))throw new ClaudeCodeError('The official client returned invalid model metadata.',409);
  if(['supportsEffort','supportsAdaptiveThinking','disabled'].some(key=>row[key]!==undefined&&typeof row[key]!=='boolean'))throw new ClaudeCodeError('The official client returned invalid model capabilities.',409);
  if(row.disabled===true)continue;
  if(row.supportedEffortLevels!==undefined&&(!Array.isArray(row.supportedEffortLevels)||row.supportedEffortLevels.length>10||row.supportedEffortLevels.some((effort:unknown)=>typeof effort!=='string'||!efforts.has(effort))))throw new ClaudeCodeError('The official client returned invalid model effort levels.',409);
  const levels=row.supportsEffort===false?[]:[...new Set<string>(row.supportedEffortLevels??[])];
  // Keep saved exact IDs stable when the client advertises a context suffix.
  // The genuine CLI still receives its own advertised transport ID.
  const contextVariant=/^claude-[a-z0-9-]+\[1m\]$/i.test(row.value),id=contextVariant?row.value.slice(0,-4):row.value;
  const model:ClaudeCodeDiscoveredModel={id,name:versionedName(row.displayName.trim(),row.resolvedModel,id==='default'),transportId:row.value,...row.resolvedModel?{resolvedModel:row.resolvedModel}:{},input:reviewedMultimodalModels.has(row.resolvedModel??id)?['text','image']:['text'],verified:false,
   reasoning:row.supportsEffort===true||levels.length>0||row.supportsAdaptiveThinking===true,reasoningEfforts:Object.fromEntries(levels.map(level=>[level,level])),
   reasoningEffortsVerified:row.supportsEffort===false||Array.isArray(row.supportedEffortLevels),reasoningEffortsSource:'official-cli-catalog',supportsAdaptiveThinking:row.supportsAdaptiveThinking===true,availability:'unknown',
   ...tokenLimits(row,contextVariant)};
  const previous=result.get(id);
  if(previous){
   if(previous.transportId===model.transportId)throw new ClaudeCodeError('The official client returned duplicate model identifiers.',409);
   if(previous.transportId===id)continue;
   if(model.transportId!==id)throw new ClaudeCodeError('The official client returned ambiguous model identifiers.',409);
  }
  result.set(id,model);
 }
 if(!result.size)throw new ClaudeCodeError('The official client did not report any available models.',409);
 return [...result.values()];
}

/** Read the official Agent SDK initialization catalog without a user prompt.
 * https://code.claude.com/docs/en/agent-sdk/typescript#sdkcontrolinitializeresponse
 * The connection manager verifies subscription authentication before calling.
 * No account metadata from the response is retained or returned. */
export async function discoverClaudeCodeModels(options:ClaudeCodeProviderOptions,signal:AbortSignal,run:typeof runClaudeCodeCommand=runClaudeCodeCommand){
 const requestId=randomUUID(),input=JSON.stringify({type:'control_request',request_id:requestId,request:{subtype:'initialize',hooks:{},sdkMcpServers:[]}})+'\n';
 const args=[...claudeCodeSafetyFlags(),'--print','--input-format','stream-json','--output-format','stream-json','--verbose','--tools','','--disable-slash-commands','--no-session-persistence','--await-initialize'];
 const response=await run(options,args,input,signal,20000);
 if(response.code!==0||Buffer.byteLength(response.stdout)>1024*1024)throw new ClaudeCodeError('The official client could not refresh its model catalog. Check the client and try Refresh models again.',409);
 let catalog:unknown,seen=false;
 for(const line of response.stdout.split('\n').filter(line=>line.trim())){
  let message:any;try{message=JSON.parse(line)}catch{throw new ClaudeCodeError('The official client returned invalid model discovery output.',409)}
  if(!['system','control_response'].includes(message?.type))throw new ClaudeCodeError('The official client did not stay in metadata-only discovery mode.',409);
  if(message.type==='control_response'){
   if(seen||message.response?.request_id!==requestId||message.response?.subtype!=='success')throw new ClaudeCodeError('The official client returned an invalid model initialization response.',409);
   seen=true;catalog=message.response.response?.models;
  }
 }
 if(!seen)throw new ClaudeCodeError('The official client did not return its model catalog. Try Refresh models again.',409);
 return normalizeClaudeCodeModels(catalog);
}
