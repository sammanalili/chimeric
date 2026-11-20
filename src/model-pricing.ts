export type TokenPricing={currency:'USD';inputPerMillion:number;outputPerMillion:number;cacheReadPerMillion?:number;cacheWritePerMillion?:number;source:'published'|'provider'|'manual';sourceUrl?:string;checkedAt?:string;note?:string;longContext?:{aboveTokens:number;inputMultiplier:number;outputMultiplier:number}};
const valid=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1e9;
/** Accept only fields whose unit is explicit. Unknown prices stay unknown. */
export function declaredPricing(raw:any):TokenPricing|null{
 const value=raw?.pricing;
 if(value?.currency==='USD'&&value?.unit==='per_million_tokens'&&valid(value.input)&&valid(value.output))return {currency:'USD',inputPerMillion:value.input,outputPerMillion:value.output,...valid(value.cacheRead)?{cacheReadPerMillion:value.cacheRead}:{},...valid(value.cacheWrite)?{cacheWritePerMillion:value.cacheWrite}:{},source:'provider'};
 const info=raw?.model_info??raw;
 if(valid(info?.input_cost_per_token)&&valid(info?.output_cost_per_token)&&info.input_cost_per_token<=1000&&info.output_cost_per_token<=1000)return {currency:'USD',inputPerMillion:info.input_cost_per_token*1e6,outputPerMillion:info.output_cost_per_token*1e6,source:'provider'};
 return null;
}
/** Exact official endpoints only. Resellers set their own prices. */
export function publishedPricing(model:{id:string;baseUrl:string;api:string}):TokenPricing|null{
 let url:URL;try{url=new URL(model.baseUrl)}catch{return null}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return null;
 if(model.api==='anthropic-messages'&&url.hostname==='api.anthropic.com'&&['','/'].includes(url.pathname)&&model.id==='claude-fable-5-2')return {currency:'USD',inputPerMillion:8,outputPerMillion:40,cacheReadPerMillion:0.2,cacheWritePerMillion:10,source:'published',sourceUrl:'https://platform.claude.com/docs/en/models/fable-5-2/overview',checkedAt:'2026-11-20',note:'Standard token rates. One-hour cache writes, tools, taxes and negotiated rates can differ.'};
 if(['openai-responses','openai-completions'].includes(model.api)&&url.hostname==='api.openai.com'&&['/v1','/v1/'].includes(url.pathname)&&model.id==='gpt-6.1-sol')return {currency:'USD',inputPerMillion:2,outputPerMillion:10,cacheReadPerMillion:0.1,cacheWritePerMillion:2.5,source:'published',sourceUrl:'https://developers.openai.com/api/docs/models/gpt-6.1-sol',checkedAt:'2026-11-20',longContext:{aboveTokens:272000,inputMultiplier:2,outputMultiplier:1.5},note:'Standard global token rates. Fast/Ultrafast, regional processing, longer cache retention and tools can cost more.'};
 return null;
}
export type TokenUsage={input:number;output:number;cacheRead:number;cacheWrite:number};
export function tokenCost(usage:TokenUsage,pricing:TokenPricing|null):number|null{
 if(!pricing||Object.values(usage).some(value=>!Number.isSafeInteger(value)||value<0))return null;
 if(usage.cacheRead>0&&pricing.cacheReadPerMillion===undefined||usage.cacheWrite>0&&pricing.cacheWritePerMillion===undefined)return null;
 const long=pricing.longContext,extended=long&&usage.input+usage.cacheRead+usage.cacheWrite>long.aboveTokens;
 return ((usage.input*pricing.inputPerMillion+usage.cacheRead*(pricing.cacheReadPerMillion??0)+usage.cacheWrite*(pricing.cacheWritePerMillion??0))*(extended?long!.inputMultiplier:1)+usage.output*pricing.outputPerMillion*(extended?long!.outputMultiplier:1))/1e6;
}
