import {r as React,j as jsx} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';
const t=value=>globalThis.ChimericI18n?.t(value)??value;
const normalize=value=>typeof value==='string'?value.replace(/^anthropic\//,''):'';
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0;
const count=value=>number(value)?value.toLocaleString():'—';
const dollars=value=>number(value)?'$'+value.toLocaleString(undefined,{maximumFractionDigits:4}):'—';
const time=value=>{if(typeof value!=='string'&&typeof value!=='number')return '';const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleString()};
const timestamp=value=>typeof value==='number'?value:typeof value==='string'?Date.parse(value):NaN;
let nextId=0;
function selectedUsage(snapshot,requested){
 const selected=normalize(requested??snapshot?.selectedModel),connections=snapshot?.connections??[];
 for(const connection of connections){const model=connection.models?.find(model=>normalize(model.qualifiedId)===selected);if(model)return {connection,model}}
 const matches=connections.flatMap(connection=>(connection.models??[]).filter(model=>normalize(model.id)===selected).map(model=>({connection,model})));
 if(matches.length===1)return matches[0];
 const connection=connections.find(connection=>selected.startsWith(connection.id+'::'));return {connection,model:undefined};
}
function PriceEditor({model,price,revision,onSaved}){
 const [editing,setEditing]=React.useState(false),[draft,setDraft]=React.useState({}),[base,setBase]=React.useState(revision),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const live=React.useRef(true),pending=React.useRef(null);
 React.useEffect(()=>{live.current=true;return()=>{live.current=false;pending.current?.abort()}},[model.qualifiedId]);
 const start=()=>{setDraft(Object.fromEntries(['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion'].map(key=>[key,number(price?.[key])?String(price[key]):''])));setBase(revision);setError('');setEditing(true)};
 const save=async(clear=false)=>{
  if(busy||pending.current)return;let pricing=null;
  if(!clear){pricing={currency:'USD'};for(const key of ['inputPerMillion','outputPerMillion','cacheReadPerMillion','cacheWritePerMillion']){const raw=String(draft[key]??'').trim();if(!raw&&key.startsWith('cache'))continue;const value=Number(raw);if(!raw||!number(value)){setError(t('Enter nonnegative USD prices per million tokens.'));return}pricing[key]=value}}
  const controller=new AbortController();pending.current=controller;setBusy(true);setError('');
  try{
   const cookie=()=>String(document.cookie??'').split(';').map(part=>part.trim()).find(part=>part.startsWith('operon_csrf='))?.slice(12);
   if(!cookie()){const check=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:controller.signal});if(!check.ok)throw Error(t('Refresh the app before editing prices.'))}
   const token=cookie();if(!token)throw Error(t('Refresh the app before editing prices.'));
   const response=await fetch('/api/local/usage/pricing',{method:'PUT',credentials:'same-origin',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json','x-operon-csrf':decodeURIComponent(token)},body:JSON.stringify({expectedRevision:clear?revision:base,model:model.qualifiedId,pricing})});
   const value=await response.json();if(!response.ok)throw Error(t(typeof value.detail==='string'?value.detail:'Could not save these prices.'));
   if(live.current&&!controller.signal.aborted){setEditing(false);await onSaved()}
  }catch(error){if(live.current&&!controller.signal.aborted)setError(error instanceof Error?error.message:t('Could not save these prices.'))}
  finally{if(pending.current===controller)pending.current=null;if(live.current)setBusy(false)}
 };
 return jsx.jsxs('span',{className:'mt-2 block','data-testid':'price-editor',children:[
  !editing?jsx.jsx('button',{type:'button',className:'underline',onClick:start,children:t('Edit API prices')}):jsx.jsxs(React.Fragment,{children:[
   jsx.jsx('span',{className:'mb-2 block text-text-400',children:t('USD per million tokens. Cache prices are optional.')}),
   ...[['inputPerMillion','Input'],['outputPerMillion','Output'],['cacheReadPerMillion','Cache read'],['cacheWritePerMillion','Cache write']].map(([key,label])=>jsx.jsxs('label',{className:'mb-2 flex items-center justify-between gap-2',children:[t(label),jsx.jsx('input',{type:'number',min:0,step:'any',value:draft[key]??'',disabled:busy,'aria-label':t(label)+' '+t('USD per 1M tokens'),className:'w-28 rounded border border-border-300 bg-bg-000 px-2 py-1',onChange:event=>setDraft(previous=>({...previous,[key]:event.target.value}))})]},key)),
   jsx.jsxs('span',{className:'flex flex-wrap gap-3',children:[jsx.jsx('button',{type:'button',disabled:busy,onClick:()=>save(),className:'underline',children:t(busy?'Saving…':'Save prices')}),jsx.jsx('button',{type:'button',disabled:busy,onClick:start,className:'underline',children:t('Reload prices')}),jsx.jsx('button',{type:'button',disabled:busy,onClick:()=>setEditing(false),children:t('Cancel')})]}),
  ]}),
  price?.source==='manual'&&!editing&&jsx.jsx('button',{type:'button',disabled:busy,onClick:()=>save(true),className:'ml-3 underline',children:t('Clear custom prices')}),
  error&&jsx.jsx('span',{role:'alert',className:'mt-2 block',children:error}),
 ]});
}
export function UsageIndicator({modelId,frameId}={}){
 const [snapshot,setSnapshot]=React.useState(null),[error,setError]=React.useState(''),[open,setOpen]=React.useState(false),[position,setPosition]=React.useState(null),[clock,setClock]=React.useState(()=>Date.now());
 const live=React.useRef(false),generation=React.useRef(0),abort=React.useRef(null),root=React.useRef(null),focused=React.useRef(false),pinned=React.useRef(false),id=React.useRef(null),refreshedDeadlines=React.useRef(new Set());
 if(id.current===null)id.current='chimeric-usage-'+(++nextId);
 const refresh=React.useCallback(async()=>{
  abort.current?.abort();const controller=new AbortController(),version=++generation.current;abort.current=controller;
  try{const response=await fetch('/api/local/usage'+(frameId?'?frameId='+encodeURIComponent(frameId):''),{credentials:'same-origin',signal:controller.signal});if(!response.ok)throw Error();const value=await response.json();if(live.current&&version===generation.current){setSnapshot(value);setError('')}}
  catch{if(live.current&&version===generation.current&&!controller.signal.aborted){setSnapshot(null);setError(t('Usage information could not be refreshed.'))}}
 },[frameId]);
 React.useEffect(()=>{
  live.current=true;refresh();const unsubscribe=subscribeProviderEvents(()=>refresh());
  const visible=()=>{if(document.visibilityState!=='hidden')refresh()};document.addEventListener?.('visibilitychange',visible);globalThis.addEventListener?.('focus',visible);
  return()=>{live.current=false;generation.current++;abort.current?.abort();unsubscribe();document.removeEventListener?.('visibilitychange',visible);globalThis.removeEventListener?.('focus',visible)};
 },[refresh,modelId]);
 const place=React.useCallback(()=>{const box=root.current?.getBoundingClientRect();if(box&&number(globalThis.innerWidth)&&number(globalThis.innerHeight))setPosition({position:'fixed',left:Math.max(12,Math.min(box.left,globalThis.innerWidth-312)),bottom:Math.max(12,globalThis.innerHeight-box.top+8)})},[]);
 const reveal=()=>{place();setOpen(true)};
 React.useEffect(()=>{
  if(!open)return;const outside=event=>{if(root.current&&!root.current.contains(event.target)){pinned.current=false;setOpen(false)}};
  document.addEventListener?.('pointerdown',outside);globalThis.addEventListener?.('resize',place);
  return()=>{document.removeEventListener?.('pointerdown',outside);globalThis.removeEventListener?.('resize',place)};
 },[open,place]);
 const scopedSnapshot=frameId&&snapshot?.frameId!==frameId?null:snapshot;
 const effectiveModel=frameId&&scopedSnapshot?.effectiveModelId||modelId;
 const {connection,model}=selectedUsage(scopedSnapshot,effectiveModel),reportedQuota=connection?.quota,tracked=connection?.tracked;
 // Account headers can describe one model's limit. Neither another model nor a
 // report without an explicit model binding can supply this chip's allowance.
 const scopedQuota=typeof model?.qualifiedId==='string'&&reportedQuota?.modelId===model.qualifiedId?reportedQuota:null;
 const observed=timestamp(scopedQuota?.observedAt),now=Math.max(clock,Date.now());
 const deadlines=[Number.isFinite(observed)?observed+300000:NaN,...(scopedQuota?.windows??[]).map(value=>timestamp(value.resetAt))].filter(Number.isFinite);
 const deadline=deadlines.length?Math.min(...deadlines):null;
 const deadlineKey=deadline===null?null:JSON.stringify([connection?.id,model?.qualifiedId,deadline]);
 const expired=deadline!==null&&now>=deadline||Number.isFinite(observed)&&now<observed;
 const quota=scopedQuota?.status==='available'&&expired?{...scopedQuota,status:'stale'}:scopedQuota;
 React.useEffect(()=>{
  if(scopedQuota?.status!=='available'||deadline===null||refreshedDeadlines.current.has(deadlineKey))return;
  const delay=Math.max(0,deadline-Date.now()+10);
  // A malformed far-future timestamp must not overflow the browser timer into
  // a tight loop. Normal observations expire within five minutes.
  if(delay>2147483647)return;
  const timer=setTimeout(()=>{
   if(!live.current)return;
   refreshedDeadlines.current.add(deadlineKey);
   if(refreshedDeadlines.current.size>64)refreshedDeadlines.current.delete(refreshedDeadlines.current.values().next().value);
   setClock(Date.now());refresh();
  },delay);
  return()=>clearTimeout(timer);
 },[scopedQuota?.status,deadline,deadlineKey,refresh]);
 const windows=Array.isArray(quota?.windows)?quota.windows.filter(window=>number(window.usedPercent)&&window.usedPercent<=100):[];
 const remaining=windows.length?Math.round(100-Math.max(...windows.map(window=>window.usedPercent))):undefined;
 const rawPrice=model?.pricing,price=rawPrice?.currency==='USD'&&number(rawPrice.inputPerMillion)&&number(rawPrice.outputPerMillion)?rawPrice:null;
 let label='—',mobile='—';
 if(connection?.connected===false){label='⊘';mobile='⊘'}
 else if(connection?.subscription&&quota?.status==='available'&&remaining!==undefined){label='◔ '+remaining+'%';mobile=label}
 else if(connection?.subscription&&quota?.status==='stale'){label='◌';mobile='◌'}
 else if(!connection?.subscription&&price){mobile='↥'+dollars(price.inputPerMillion)+' ↧'+dollars(price.outputPerMillion);label=mobile}
 const row=(name,value)=>jsx.jsxs('div',{className:'flex items-start justify-between gap-3',children:[jsx.jsx('dt',{className:'text-text-400',children:t(name)}),jsx.jsx('dd',{className:'m-0 text-right text-text-100',children:value})]});
 const sourceUrl=typeof price?.sourceUrl==='string'&&/^https?:\/\//i.test(price.sourceUrl)?price.sourceUrl:null;
 const priceSource=({manual:t('Custom prices'),provider:t('Provider metadata'),published:t('Published prices')})[price?.source]??price?.source;
 return jsx.jsxs('span',{ref:root,className:'relative inline-flex min-w-0 shrink-0 items-center','data-testid':'usage-indicator',onMouseEnter:reveal,onMouseLeave:()=>{if(!focused.current&&!pinned.current)setOpen(false)},onFocusCapture:()=>{focused.current=true},onBlurCapture:event=>{if(!root.current?.contains(event.relatedTarget)){focused.current=false;pinned.current=false;setOpen(false)}},onKeyDown:event=>{if(event.key==='Escape'){pinned.current=false;setOpen(false)}},children:[
  jsx.jsxs('button',{type:'button',className:'inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-footnote text-text-400 hover:bg-bg-200 focus-visible:shadow-focus','aria-label':t('Model usage and pricing')+': '+label,'aria-expanded':open,'aria-controls':id.current,'data-testid':'usage-trigger',onFocus:()=>{focused.current=true;reveal()},onBlur:event=>{if(!root.current?.contains(event.relatedTarget)){focused.current=false;pinned.current=false;setOpen(false)}},onClick:()=>{pinned.current=!pinned.current;place();setOpen(pinned.current)},children:[
   jsx.jsx('svg',{width:14,height:14,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true,children:jsx.jsx('path',{d:'M4 17a9 9 0 1 1 16 0M12 5v2M5.5 8.5 7 10m10 0 1.5-1.5M8 17l4-5 4 5H8Z'})}),
   jsx.jsx('span',{className:'hidden md:inline',children:label}),jsx.jsx('span',{className:'md:hidden',children:mobile}),
  ]}),
  open&&jsx.jsxs('span',{id:id.current,role:'region','aria-label':t('Model usage and pricing'),className:'rounded-lg border border-border-300 bg-bg-000 p-3 text-left text-footnote shadow-md',style:{position:'absolute',bottom:'calc(100% + 8px)',right:0,zIndex:70,width:300,maxWidth:'calc(100vw - 24px)',maxHeight:'65vh',overflowY:'auto',...position},children:[
   jsx.jsx('span',{className:'mb-2 block text-sm font-medium text-text-100',children:model?.name??connection?.name??t('Model usage and pricing')}),
   error&&jsx.jsx('span',{role:'status',className:'mb-2 block text-text-400',children:error}),
   typeof snapshot?.warning==='string'&&snapshot.warning&&jsx.jsx('span',{role:'status',className:'mb-2 block text-text-400',children:t(snapshot.warning)}),
   connection?.subscription?jsx.jsxs('span',{className:'mb-3 block space-y-2',children:[
    quota?.status==='available'||quota?.status==='stale'?windows.length?jsx.jsx('ul',{className:'m-0 list-none space-y-1 p-0',children:windows.map((window,index)=>jsx.jsx('li',{children:'◔ '+Math.round(100-window.usedPercent)+'%'+(time(window.resetAt)?' · ◷ '+time(window.resetAt):'')},index))}):jsx.jsx('span',{className:'block text-text-400',children:'—'}):jsx.jsx('span',{className:'block text-text-400',children:'—'}),
   ]}):jsx.jsxs('span',{className:'mb-3 block space-y-2',children:[
    price?jsx.jsxs(React.Fragment,{children:[jsx.jsxs('dl',{className:'m-0 space-y-1',children:[row('↥',dollars(price.inputPerMillion)),row('↧',dollars(price.outputPerMillion)),number(price.cacheReadPerMillion)&&row('▣',dollars(price.cacheReadPerMillion)),number(price.cacheWritePerMillion)&&row('▤',dollars(price.cacheWritePerMillion))]}),sourceUrl&&jsx.jsx('a',{href:sourceUrl,target:'_blank',rel:'noopener noreferrer',className:'block underline text-text-400',children:'↗'})]}):jsx.jsx('span',{className:'block text-text-400',children:'—'}),
    model?.qualifiedId&&jsx.jsx(PriceEditor,{model,price,revision:scopedSnapshot?.revision,onSaved:refresh},model.qualifiedId),
   ]}),
   jsx.jsxs('span',{className:'block border-t border-border-300 pt-2',children:[
    jsx.jsxs('dl',{className:'m-0 space-y-1',children:[row('↺',count(tracked?.requests)),row('↥',count(tracked?.input)),row('↧',count(tracked?.output)),row('▣',count(tracked?.cacheRead)),row('▤',count(tracked?.cacheWrite)),row('$',number(tracked?.estimatedUsd)?dollars(tracked.estimatedUsd):'—')]}),
   ]}),
  ]}),
 ]});
}
