import {r as React,j as jsx,a as useQueryClient} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';
const t=value=>globalThis.ChimericI18n?.t(value)??value;
const base='/api/local/image-generation';
const control='w-full min-w-0 rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-sm text-text-100';
const buttonClass='rounded-md border border-border-300 px-3 py-1.5 text-sm hover:bg-bg-200 disabled:opacity-50 focus-visible:shadow-focus';
const kindOf=value=>value?.kind??(value?.billing==='subscription'?'chatgpt':value?.billing==='api'?'openai-api':undefined);
const matchesProvider=(model,provider)=>!!provider&&kindOf(model)===kindOf(provider)&&(!model.connectionId||model.connectionId===provider.id);
const planLabel=provider=>kindOf(provider)==='antigravity'?'Google AI plan limits':kindOf(provider)==='chatgpt'?'ChatGPT plan limits':'API billing';
const settingsEvent='chimeric-image-generation-settings';
const publish=value=>{if(globalThis.dispatchEvent&&globalThis.CustomEvent)globalThis.dispatchEvent(new globalThis.CustomEvent(settingsEvent,{detail:value}))};
async function api(method='GET',body){
 if(method!=='GET')await fetch('/api/csrf',{credentials:'same-origin'});
 const cookie=document.cookie.split('; ').find(value=>value.startsWith('operon_csrf='));
 const response=await fetch(base,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(cookie?{'x-operon-csrf':decodeURIComponent(cookie.slice('operon_csrf='.length))}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json()}catch{throw Error(t('The server returned an unexpected response.'))}
 if(!response.ok)throw Error(t(response.status===401?'Open your local workspace again to continue.':data.detail||'Could not read the image generation settings.'));
 return data;
}
export function ImageGenerationSettings(){
 const client=useQueryClient();
 const [status,setStatus]=React.useState(null),[connectionId,setConnectionId]=React.useState(''),[imageModel,setImageModel]=React.useState(''),[dirty,setDirty]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState('');
 const live=React.useRef(false),edited=React.useRef(false),generation=React.useRef(0),baseRevision=React.useRef(null),latestRevision=React.useRef(-1);
 const update=React.useCallback(value=>{
  if(!live.current||value.revision<latestRevision.current)return;latestRevision.current=value.revision;setStatus(value);
  if(!edited.current){baseRevision.current=value.revision;setConnectionId(value.selected?.connectionId??'');setImageModel(value.selected?.imageModel??'')}
 },[]);
 const refresh=React.useCallback(async()=>{const version=++generation.current;try{const value=await api();if(live.current&&version===generation.current)update(value)}catch(e){if(live.current&&version===generation.current)setError(e.message)}},[update]);
 React.useEffect(()=>{
  live.current=true;refresh();const unsubscribe=subscribeProviderEvents(()=>refresh());
  const changed=event=>update(event.detail);globalThis.addEventListener?.(settingsEvent,changed);
  return()=>{live.current=false;generation.current++;unsubscribe();globalThis.removeEventListener?.(settingsEvent,changed)};
 },[refresh,update]);
 const edit=()=>{if(!edited.current)baseRevision.current=status?.revision;edited.current=true;setDirty(true);setNotice('')};
 const chooseConnection=id=>{
  edit();setConnectionId(id);
  const selected=status?.providers.find(value=>value.id===id),choices=status?.imageModels.filter(value=>matchesProvider(value,selected))??[];
  const preferred=kindOf(selected)==='chatgpt'?choices.find(value=>value.id==='gpt-image-2'):kindOf(selected)==='antigravity'?choices.find(value=>value.default===true):choices.find(value=>value.id===imageModel);
  setImageModel(preferred?.id??choices[0]?.id??'');
 };
 const reset=()=>{edited.current=false;setDirty(false);baseRevision.current=status?.revision??null;setConnectionId(status?.selected?.connectionId??'');setImageModel(status?.selected?.imageModel??'');setError('');setNotice('')};
 const save=async()=>{
  generation.current++;setBusy(true);setError('');setNotice('');
  try{
   const value=await api('PUT',{expectedRevision:baseRevision.current,connectionId:connectionId||null,...connectionId?{imageModel}:{}});
   if(live.current){edited.current=false;setDirty(false);update(value);publish(value);client.invalidateQueries();setNotice(t('Image generation settings saved.'))}
  }catch(e){if(live.current)setError(e.message);await refresh()}finally{if(live.current)setBusy(false)}
 };
 const provider=status?.providers?.find(value=>value.id===connectionId);
 const imageModels=status?.imageModels?.filter(value=>matchesProvider(value,provider))??[],knownModel=imageModels.some(value=>value.id===imageModel);
 const unavailable=connectionId&&(!provider||!provider.ready||!knownModel);
 const selectedProvider=status?.providers?.find(value=>value.id===status.selected?.connectionId);
 const selectedReady=!!status?.selected&&!!selectedProvider?.ready&&status.imageModels.some(value=>value.id===status.selected.imageModel&&matchesProvider(value,selectedProvider));
 const quotaMessage=provider?.message??(kindOf(provider)==='antigravity'?'Uses your Google AI subscription limits. API billing is never used as a fallback.':status?.subscription?.message??'Uses your ChatGPT subscription limits. API billing is never used as a fallback.');
 const button=(label,onClick,disabled=false)=>jsx.jsx('button',{type:'button',className:buttonClass,onClick,disabled:busy||disabled,children:t(label)});
 return jsx.jsxs('section',{'aria-label':t('Image generation'),'data-chimeric-dirty':dirty?'true':'false',className:'mb-5 border-b border-border-300 pb-4',children:[
  jsx.jsx('h2',{className:'mb-1 text-base font-medium',children:t('Image generation')}),
  jsx.jsx(ImageGenerationChoice,{}),
  jsx.jsx('p',{className:'mb-3 text-sm text-text-400',children:t('Create images in normal research sessions and save the results with your session files. Image generation has its own connection choice. Image-input probes only test whether a chat model can read images.')}),
  jsx.jsxs('div',{className:'rounded-lg border border-border-300 p-3',children:[
   jsx.jsx('h3',{className:'text-sm font-medium text-text-100',children:t('Image provider')}),
   jsx.jsx('p',{className:'mt-1 text-footnote text-text-400',role:'status',children:t(!status?'Reading connection…':!status.selected?'Image generation is off.':selectedReady?'Image generation connection configured.':'The saved image generation connection is unavailable. Choose another connection or turn image generation off.')}),
   selectedReady&&jsx.jsx('p',{className:'mt-3 text-footnote text-text-400',children:t('Ask the research agent to generate an image. The result will appear in this session’s Files.')}),
   !connectionId&&jsx.jsx('p',{className:'mt-3 text-footnote text-text-400',children:t('Choose Antigravity or ChatGPT subscription to use your plan’s image generation. API connections use separate API billing.')}),
   provider?.billing==='subscription'&&jsx.jsx('p',{className:'mt-3 text-sm text-text-400',role:'status',children:t(quotaMessage)}),
   provider?.billing==='api'&&jsx.jsx('p',{className:'mt-3 text-footnote text-text-400',children:t('Selecting an API connection uses that connection’s API billing. Chimeric keeps this choice until you change it and never switches billing connections automatically.')}),
   status?.subscription?.status==='disconnected'&&kindOf(provider)==='chatgpt'&&jsx.jsx('p',{className:'mt-3 text-footnote text-text-400',role:'status',children:t('Sign in with ChatGPT above to use subscription image generation.')}),
   jsx.jsxs('fieldset',{className:'mt-3 space-y-3',disabled:busy||!status,children:[
    jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Image generation connection')}),jsx.jsxs('select',{className:control,value:connectionId,onChange:event=>chooseConnection(event.target.value),'data-testid':'image-generation-connection',children:[
     jsx.jsx('option',{value:'',children:t('Off')}),
     connectionId&&!provider&&jsx.jsx('option',{value:connectionId,disabled:true,children:t('Saved connection unavailable')}),
     ...(status?.providers??[]).map(value=>jsx.jsx('option',{value:value.id,disabled:!value.ready,children:t(value.name)+' · '+t(planLabel(value))+(value.ready?'':' · '+t('Unavailable'))},value.id)),
    ]})]}),
    !!connectionId&&jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Image model')}),jsx.jsxs('select',{className:control,value:imageModel,onChange:event=>{edit();setImageModel(event.target.value)},'data-testid':'image-generation-model',children:[
     imageModel&&!knownModel&&jsx.jsx('option',{value:imageModel,disabled:true,children:imageModel+' · '+t('Unavailable')}),
     ...imageModels.map(value=>jsx.jsx('option',{value:value.id,children:value.name},value.id)),
    ]})]}),
    provider?.reason&&jsx.jsx('p',{className:'text-footnote text-text-400',role:'status',children:t(provider.reason)}),
    status&&status.providers.every(value=>!value.ready)&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Connect Antigravity or ChatGPT above, or add an OpenAI API connection to configure image generation.')}),
    jsx.jsxs('div',{className:'flex flex-wrap gap-2',children:[button(busy?'Saving…':'Save image generation',save,!status||!dirty||!!unavailable),button('Cancel',reset,!dirty)]}),
   ]}),
   error&&jsx.jsx('p',{className:'mt-3 text-sm text-text-100',role:'alert',children:error}),
   notice&&jsx.jsx('p',{className:'mt-3 text-footnote text-text-400',role:'status',children:notice}),
  ]}),
 ]});
}

export function ImageGenerationChoice({compact=false}={}){
 const client=useQueryClient(),[status,setStatus]=React.useState(null),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const live=React.useRef(false),current=React.useRef(null),generation=React.useRef(0),mutating=React.useRef(false);
 const update=React.useCallback(value=>{if(live.current&&value&&(!current.current||value.revision>=current.current.revision)){current.current=value;setStatus(value)}},[]);
 const refresh=React.useCallback(async()=>{const version=++generation.current;try{const value=await api();if(live.current&&version===generation.current)update(value)}catch(e){if(live.current&&version===generation.current)setError(e.message)}},[update]);
 React.useEffect(()=>{
  live.current=true;refresh();const unsubscribe=subscribeProviderEvents(()=>refresh());
  const changed=event=>update(event.detail);globalThis.addEventListener?.(settingsEvent,changed);
  return()=>{live.current=false;generation.current++;unsubscribe();globalThis.removeEventListener?.(settingsEvent,changed)};
 },[refresh,update]);
 const choose=async id=>{
  if(mutating.current||!current.current)return;
  const snapshot=current.current,choice=snapshot.quickChoices?.find(value=>value.id===id);
  if(id&&(!choice||!choice.ready)){setError(t(choice?.reason??'This image connection is unavailable.'));return}
  mutating.current=true;generation.current++;setBusy(true);setError('');
  try{const value=await api('PUT',{expectedRevision:snapshot.revision,connectionId:choice?.connectionId??null,...choice?{imageModel:choice.imageModel}:{}});if(live.current){update(value);publish(value);client.invalidateQueries()}}
  catch(e){if(live.current)setError(e.message);await refresh()}finally{mutating.current=false;if(live.current)setBusy(false)}
 };
 const choices=status?.quickChoices??[],selected=choices.find(value=>value.id===status?.selectedQuickChoice)??status?.selectedChoice;
 const value=status?.selectedQuickChoice??(status?.selected?'configured':'');
 const provider=selected&&status?.providers?.find(provider=>provider.id===selected.connectionId);
 return jsx.jsxs('div',{className:compact?'px-3 py-2':'mb-3 rounded-lg border border-border-300 p-3','data-testid':compact?'composer-image-choice':'image-quick-choice',onKeyDown:event=>event.stopPropagation(),children:[
  jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Image generation')}),jsx.jsxs('select',{className:control,value,disabled:busy||!status,onChange:event=>choose(event.target.value),'aria-label':t('Image generation'),'data-testid':'image-quick-select',children:[
   jsx.jsx('option',{value:'',children:t('Off')}),
   value==='configured'&&jsx.jsx('option',{value:'configured',disabled:true,children:selected?.label??t('Configured image model')}),
   ...choices.map(choice=>jsx.jsx('option',{value:choice.id,disabled:!choice.ready,children:choice.label+(choice.ready?'':' · '+t('Unavailable'))},choice.id)),
  ]})]}),
  selected&&jsx.jsx('p',{role:'status',className:'mt-2 text-footnote text-text-400',children:(selected.connectionName??provider?.name??'')+' · '+t(selected.billing==='api'?'API billing':planLabel(provider??{kind:selected.id==='nano-banana-latest'?'antigravity':'chatgpt'}))}),
  selected?.reason&&!selected.ready&&jsx.jsx('p',{className:'mt-2 text-footnote text-text-400',role:'status',children:t(selected.reason)}),
  error&&jsx.jsx('p',{className:'mt-2 text-footnote text-text-100',role:'alert',children:error}),
 ]});
}
