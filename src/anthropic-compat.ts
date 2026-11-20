/** Public model specifications, not account entitlement or confidentiality approval.
 * https://platform.claude.com/docs/en/models/fable-5-2/overview
 * https://platform.claude.com/docs/en/models/fable-5-2/migration-guide */
export const FABLE_5_2_ID='claude-fable-5-2';
export const FABLE_5_2_EFFORTS=['low','medium','high','xhigh','max'] as const;
export function anthropicApiModelMetadata(modelId:string){
 if(modelId!==FABLE_5_2_ID)return undefined;
 return {name:'Claude Fable 5.2',input:['text','image'],reasoning:true,contextWindow:1_000_000,maxTokens:128_000,
  defaultReasoningEffort:'high',reasoningEfforts:Object.fromEntries(FABLE_5_2_EFFORTS.map(level=>[level,level])),
  thinkingLevelMap:{off:null,...Object.fromEntries(FABLE_5_2_EFFORTS.map(level=>[level,level]))},
  compat:{forceAdaptiveThinking:true,requiresAdaptiveThinking:true,supportsThinkingOff:false,supportsForcedToolChoice:false,
   supportsTemperature:false,supportsMidConvoSystemMessages:true,supportsMidConvoToolChanges:true,supportsMidConvoEffort:true,strictThinkingPrefix:true}};
}
export const anthropicConfigurationError=(message:string)=>Object.assign(new Error(message),{httpStatus:400});

/** The adapter normally normalizes missing results and drops foreign thinking.
 * Fable's prefix binding makes those silent rewrites unsafe. Validate the
 * supported transcript and retain every assistant block, including empty thought text. */
export function fableAssistantBlocks(context:any):any[][]{
 const turns:any[][]=[],pending=new Map<string,string>();let lastRole:string|undefined;
 const initial=context.messages?.[0],fixedTools=initial?.role==='system'&&(initial.toolsAdded?.length??0)>0;
 for(const [index,message]of(context.messages??[]).entries()){
  if(message.role==='assistant'){
   if(pending.size)throw anthropicConfigurationError('Fable history has an unanswered tool call. Restore its exact tool result before continuing.');
   if(!Array.isArray(message.content))throw anthropicConfigurationError('Fable requires preserved assistant content blocks.');
   const blocks=message.content.map((block:any)=>{
    if(block.type==='text'){
     if(typeof block.text!=='string')throw anthropicConfigurationError('Fable history contains an invalid text block.');
     return {type:'text',text:block.text};
    }
    if(block.type==='thinking'){
     if(message.api!=='anthropic-messages'||typeof block.thinkingSignature!=='string'||!block.thinkingSignature||block.thinkingSignature==='local-provider-replay')
      throw anthropicConfigurationError('Fable cannot replay this unverified thinking history. Restore the original signed transcript or start a new conversation.');
     if(block.redacted)return {type:'redacted_thinking',data:block.thinkingSignature};
     if(typeof block.thinking!=='string')throw anthropicConfigurationError('Fable history contains an invalid thinking block.');
     return {type:'thinking',thinking:block.thinking,signature:block.thinkingSignature};
    }
    if(block.type==='toolCall'){
     if(typeof block.id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(block.id)||typeof block.name!=='string'||!block.name||!block.arguments||typeof block.arguments!=='object'||Array.isArray(block.arguments)||pending.has(block.id))
      throw anthropicConfigurationError('Fable cannot preserve this tool-call history. Restore valid original tool identifiers and arguments.');
     pending.set(block.id,block.name);return {type:'tool_use',id:block.id,name:block.name,input:structuredClone(block.arguments)};
    }
    throw anthropicConfigurationError('Fable history contains an unsupported assistant block; it was not silently removed.');
   });
   if(!blocks.length)throw anthropicConfigurationError('Fable cannot replay an empty assistant turn.');
   turns.push(blocks);lastRole='assistant';
  }else if(message.role==='toolResult'){
   if(pending.get(message.toolCallId)!==message.toolName)throw anthropicConfigurationError('Fable history has a tool result without its exact matching call.');
   pending.delete(message.toolCallId);lastRole='user';
  }else if(message.role==='user'){
   if(pending.size)throw anthropicConfigurationError('Fable history has an unanswered tool call before a user message.');lastRole='user';
  }else if(message.role==='system'){
   if(pending.size)throw anthropicConfigurationError('Place Fable instruction/tool updates after the pending tool results.');
   if(index>0&&lastRole!=='user')throw anthropicConfigurationError('Fable instruction/tool updates must follow the newest user message or completed tool results.');
   if(index>0&&!fixedTools&&((message.toolsAdded?.length??0)||(message.toolsRemoved?.length??0)))throw anthropicConfigurationError('Fable cannot add tools to this preserved conversation without an initial fixed tool declaration. Start a new conversation with its initial tools declared.');
  }else throw anthropicConfigurationError('Fable history contains an unsupported message role.');
 }
 if(pending.size)throw anthropicConfigurationError('Fable requires the exact result of every pending tool call.');
 if(lastRole==='assistant')throw anthropicConfigurationError('Fable does not support assistant prefill. Add a user message before continuing.');
 return turns;
}

/** pi-ai provides official inline tool/system/effort serialization. Its default
 * drop_block recovery is intentionally replaced by an explicit prefix error.
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/change-tools-or-instructions */
export function strictFablePayload(payload:any,assistantBlocks:any[][],effort:string){
 const result=structuredClone(payload);let index=0;
 for(const message of result.messages??[])if(message.role==='assistant'){
  if(!assistantBlocks[index])throw anthropicConfigurationError('The serializer changed Fable assistant history.');message.content=structuredClone(assistantBlocks[index++]);
 }
 if(index!==assistantBlocks.length)throw anthropicConfigurationError('The serializer removed Fable assistant history.');
 result.thinking={...result.thinking,type:'adaptive',block_binding:{prefix_mismatch_behavior:'error'}};
 const tail=result.messages?.at(-1);
 if(tail?.role!=='system'||tail.output_config?.effort!==effort)throw anthropicConfigurationError('The serializer did not retain the current Fable effort setting.');
 for(const parameter of ['temperature','top_p','top_k'])delete result[parameter];
 return result;
}
