import {stream as completions} from '@earendil-works/pi-ai/api/openai-completions';
import {stream as responses} from '@earendil-works/pi-ai/api/openai-responses';
import {stream as codex} from '@earendil-works/pi-ai/api/openai-codex-responses';
import {stream as anthropic} from '@earendil-works/pi-ai/api/anthropic-messages';
import {anthropicProviderFetch} from './provider-transport';
import {anthropicApiModelMetadata,anthropicConfigurationError,FABLE_5_2_EFFORTS,fableAssistantBlocks,strictFablePayload} from './anthropic-compat';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';

type ManagedDriver={stream:(model:any,context:any,options:any)=>any};
export type ModelDrivers={antigravity?:ManagedDriver;antigravityHttp?:ManagedDriver;claudeCode?:ManagedDriver};
function preserveAnthropicStatus(events:any,status:()=>number|undefined){
 const output=new AssistantMessageEventStream();void(async()=>{
  try{for await(const event of events){if(event.type==='error'&&status()!==undefined)event.error={...event.error,httpStatus:status()};output.push(event)}output.end(await events.result())}
  catch(error){const failed:any={role:'assistant',content:[],usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'error',errorMessage:error instanceof Error?error.message:String(error),timestamp:Date.now(),...status()!==undefined?{httpStatus:status()}: {}};output.push({type:'error',reason:'error',error:failed});output.end(failed)}
 })();return output;
}

/** Normal research and capability probes share exactly the same transport. */
export function dispatchModel(model:any,context:any,options:any={},drivers:ModelDrivers={}){
 if(model.api==='antigravity-cli'){
  if(!drivers.antigravity)throw Error('Connect Antigravity in Settings → Connections.');
  return drivers.antigravity.stream(model,context,options);
 }
 if(model.api==='antigravity-http'){
  if(!drivers.antigravityHttp)throw Error('Connect Google Antigravity in Settings → Connections.');
  return drivers.antigravityHttp.stream(model,context,options);
 }
 if(model.api==='claude-code'){
  if(!drivers.claudeCode)throw Error('Connect the installed Claude Code client in Settings → Connections.');
  return drivers.claudeCode.stream(model,context,options);
 }
 if(model.api==='anthropic-messages'){
  if(typeof options.apiKey!=='string'||!options.apiKey||options.apiKey.includes('sk-ant-oat'))throw Error('Use an API key for the Anthropic API connection. Subscription access uses the installed Claude Code client.');
  const known=anthropicApiModelMetadata(model.id),fable=!!known;
  if(known)model={...model,reasoning:true,compat:{...model.compat,...known.compat},thinkingLevelMap:known.thinkingLevelMap};
  const tool=options.toolChoice;
  const toolChoice=tool&&typeof tool==='object'?['auto','none'].includes(tool.type)?tool:{type:'tool',name:tool.name??tool.function?.name}:tool==='required'?'any':tool;
  if(fable&&toolChoice!==undefined&&!(typeof toolChoice==='string'?['auto','none'].includes(toolChoice):toolChoice&&['auto','none'].includes(toolChoice.type)))throw anthropicConfigurationError('Claude Fable 5.2 supports only automatic tool choice or no tools. Forced tool calls are unsupported.');
  if(fable&&(options.reasoningEffort==='off'||options.thinkingEnabled===false||options.thinkingBudgetTokens!==undefined||options.thinkingBudget!==undefined||options.thinking?.type&&options.thinking.type!=='adaptive'||options.thinking?.budget_tokens!==undefined))throw anthropicConfigurationError('Claude Fable 5.2 requires always-on adaptive thinking. Disabled or manual budget thinking is unsupported.');
  const level=options.reasoningEffort??(fable?'high':undefined),cap=options.maxTokens??model.maxTokens;
  if(!Number.isInteger(cap)||cap<1||cap>model.maxTokens||(fable&&cap>128000))throw anthropicConfigurationError('Choose a valid Anthropic output token limit within this model’s supported range.');
  const budgets:Record<string,number>={minimal:1024,low:1024,medium:4096,high:8192,xhigh:16384,max:32768};
  if(level!==undefined&&level!=='off'&&(!Object.hasOwn(budgets,level)||(fable&&!(FABLE_5_2_EFFORTS as readonly string[]).includes(level))))throw anthropicConfigurationError('Choose a supported Anthropic reasoning effort.');
  if(level!==undefined&&level!=='off'&&!model.compat?.forceAdaptiveThinking&&cap<=1024)throw anthropicConfigurationError('Anthropic budget thinking requires an output limit above 1024 tokens. Increase the limit or turn thinking off.');
  if(level===undefined&&options.thinkingEnabled===true&&!model.compat?.forceAdaptiveThinking){
   const budget=options.thinkingBudgetTokens??1024;
   if(!Number.isInteger(budget)||budget<1024||budget>=cap)throw anthropicConfigurationError('The Anthropic thinking budget must be at least 1024 and smaller than the output token limit.');
  }
  const thinking=level===undefined?{}:level==='off'?{thinkingEnabled:false}:model.compat?.forceAdaptiveThinking?{thinkingEnabled:true,effort:level}:{thinkingEnabled:true,thinkingBudgetTokens:Math.min(budgets[level],Math.max(1024,cap-1024))};
  const historical=fable?fableAssistantBlocks(context):undefined;
  let httpStatus:number|undefined;
  const onPayload=fable?async(payload:any,selected:any)=>{
   try{
    const strict=strictFablePayload(payload,historical!,level),prefix=JSON.stringify({model:strict.model,system:strict.system,tools:strict.tools,messages:strict.messages});
    const candidate=await options.onPayload?.(strict,selected)??strict;
    if(JSON.stringify({model:candidate.model,system:candidate.system,tools:candidate.tools,messages:candidate.messages})!==prefix||candidate.thinking?.type!=='adaptive'||candidate.thinking?.block_binding?.prefix_mismatch_behavior!=='error'||candidate.thinking?.budget_tokens!==undefined||candidate.output_config?.effort!=='high'||['temperature','top_p','top_k'].some(key=>candidate[key]!==undefined))
     throw anthropicConfigurationError('A payload callback attempted an incompatible Fable history or thinking rewrite. No request was sent.');
    return candidate;
   }catch(error){httpStatus=400;throw error}
  }:options.onPayload;
  const onProviderStreamEvent=fable?async(event:any,selected:any)=>{
   if((event.message?.input_transformations??event.input_transformations)?.length){httpStatus=400;throw anthropicConfigurationError('The Anthropic service reported a thinking/history transformation. This strict session stopped instead of concealing a dropped block. Review the transcript before continuing.')}
   await options.onProviderStreamEvent?.(event,selected);
  }:options.onProviderStreamEvent;
  const {temperature:_temperature,topP:_topP,topK:_topK,top_p:_top_p,top_k:_top_k,...withoutSampling}=options;
  const sender=anthropicProviderFetch(model.baseUrl,options.fetch),fetcher=(async(input:any,init:any)=>{const response=await sender(input,init);if(response.status>=400)httpStatus=response.status;return response}) as typeof fetch;
  return preserveAnthropicStatus(anthropic(model,context,{...(fable?withoutSampling:options),...thinking,toolChoice,onPayload,onProviderStreamEvent,fetch:fetcher,maxRetries:0}),()=>httpStatus);
 }
 if(model.api==='openai-codex-responses')return codex(model,context,options);
 if(model.api==='openai-responses')return responses(model,context,options);
 if(model.api==='openai-completions')return completions(model,context,options);
 throw Error('This model transport is not supported.');
}
