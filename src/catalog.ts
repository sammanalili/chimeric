import type {Registry} from './registry';
import {localize} from './localization';
import {defaultEffort,modelEfforts} from './model-effort';
const names:Record<string,string>={minimal:'Minimal',low:'Low',medium:'Medium',high:'High',xhigh:'Extra high',max:'Max'};
export function makeCatalog(registry:Registry,locale='en'){
 const t=(value:string)=>localize(value,locale);
 const catalogId='chimeric-'+registry.revision+'-'+registry.catalogGeneration;
 const selection=registry.currentSelection();
 const headlines=[...new Set(registry.config.headlineModels.map(id=>registry.canonicalId(id)))].filter(id=>registry.models.has(id));
 const main=new Set(headlines.length?headlines:[selection.model]);
 const rank=new Map([...main].map((id,i)=>[id,i]));
 const models=[...registry.models.values()].sort((a,b)=>(rank.get(a.qualifiedId)??main.size)-(rank.get(b.qualifiedId)??main.size)).map(m=>({
  id:m.qualifiedId,name:m.name,display_name:m.name,
  section:main.has(m.qualifiedId)?'main':'overflow',
  description:m.providerName+' · '+Math.round(m.contextWindow/1024)+'k '+t('context')+(m.input.includes('image')?' · '+t('images'):'')+(m.api==='openai-codex-responses'?' · '+t('subscription'):''),
  max_input_tokens:m.contextWindow,max_output_tokens:m.maxTokens,max_tokens:m.maxTokens,context_window:m.contextWindow,
  supports_vision:m.input.includes('image'),capabilities:{vision:m.input.includes('image'),pdf:true,web_search:true,effort:{supported:m.reasoning&&modelEfforts(m).length>0}},
  disabled:m.mode!=='chat'||m.subscriptionAvailable===false||m.available===false||(m.api==='openai-codex-responses'&&!registry.subscription?.status().connected),
  disabled_reason:m.available===false?{message:t(m.unavailableReason??'This model connection is unavailable.')}:m.mode!=='chat'?{message:'Dedicated '+m.mode+' endpoint; choose a chat model for analysis'}:m.subscriptionAvailable===false?{message:t('This model is unavailable in the current ChatGPT model catalog. Refresh models or select another model.')}:m.api==='openai-codex-responses'&&!registry.subscription?.status().connected?{message:t('Connect ChatGPT in Settings → Connections')}:undefined,
  ...(m.reasoning&&m.mode==='chat'&&modelEfforts(m).length>0?{thinking:{type:'effort',always_on:m.api==='antigravity-cli'||m.api==='antigravity-http'||(m.api==='anthropic-messages'||m.api==='claude-code')&&m.id==='claude-fable-5-2',
   effort_options:modelEfforts(m).map(e=>({id:e,name:t(e==='off'?'Thinking off':names[e]??e),recommended:e===defaultEffort(m)})),
   mode_options:[],
   description:t('Choose the reasoning effort requested from this model.')}}:{}),
 }));
 const selected=models.find(m=>m.id===selection.model);
 const options=selected?.thinking?.effort_options.map(o=>o.id)??[];
 const fallback=selected?defaultEffort(registry.models.get(selected.id)!):undefined;
 const effort=options.includes(selection.effort??'')?selection.effort:fallback;
 const thinking=effort?{type:'effort',effort}:undefined;
 return {models:{anthropic:models},default_model_id:selection.model,model_list_source:'selector',selection_source:'local',default_effort:effort,
  model_selector:{catalog:{id:catalogId,models},state:{id:catalogId,model:selection.model,thinking,
   thinking_by_model:models.filter(m=>m.thinking).map(m=>({id:m.id,thinking:{type:'effort',effort:defaultEffort(registry.models.get(m.id)!)}}))}},provider_status:registry.statuses};
}
