import {r as React,j as jsx,a as useQueryClient} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';
const t=value=>globalThis.ChimericI18n?.t(value)??value,endpoint='/api/local/speech';
const control='w-full min-w-0 rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-sm text-text-100';
async function api(method='GET',body){
 if(method!=='GET')await fetch('/api/csrf',{credentials:'same-origin'});
 const cookie=document.cookie.split('; ').find(value=>value.startsWith('operon_csrf='));
 const response=await fetch(endpoint,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(cookie?{'x-operon-csrf':decodeURIComponent(cookie.slice('operon_csrf='.length))}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let data;try{data=await response.json()}catch{throw Error(t('The server returned an unexpected response.'))}
 if(!response.ok)throw Error(t(response.status===401?'Open your local workspace again to continue.':typeof data.detail==='string'?data.detail:'Could not read speech settings.'));return data;
}
export function VoiceSettings(){
 const client=useQueryClient(),[data,setData]=React.useState(null),[connectionId,setConnectionId]=React.useState(''),[modelId,setModelId]=React.useState(''),[dirty,setDirty]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState(''),[notice,setNotice]=React.useState('');
 const live=React.useRef(false),current=React.useRef(null),edited=React.useRef(false),baseRevision=React.useRef(null),generation=React.useRef(0),mutating=React.useRef(false);
 const update=React.useCallback(value=>{
  if(!live.current||!value||current.current&&value.revision<current.current.revision)return;current.current=value;setData(value);
  if(!edited.current){baseRevision.current=value.revision;setConnectionId(value.selected?.connectionId??'');setModelId(value.selected?.modelId??'')}
 },[]);
 const refresh=React.useCallback(async()=>{const version=++generation.current;try{const value=await api();if(live.current&&version===generation.current)update(value)}catch(e){if(live.current&&version===generation.current)setError(e.message)}},[update]);
 React.useEffect(()=>{live.current=true;refresh();const unsubscribe=subscribeProviderEvents(()=>refresh());return()=>{live.current=false;generation.current++;unsubscribe()}},[refresh]);
 const edit=()=>{if(!edited.current)baseRevision.current=current.current?.revision??null;edited.current=true;setDirty(true);setError('');setNotice('')};
 const reset=()=>{edited.current=false;setDirty(false);setConnectionId(data?.selected?.connectionId??'');setModelId(data?.selected?.modelId??'');baseRevision.current=data?.revision??null;setError('')};
 const connection=data?.connections.find(value=>value.id===connectionId),knownModel=connection?.models.some(value=>value.id===modelId);
 const available=!connectionId||!!connection?.ready&&!!knownModel;
 const save=async()=>{
  if(mutating.current||!data||!available)return;mutating.current=true;generation.current++;setBusy(true);setError('');setNotice('');
  try{const value=await api('PUT',{expectedRevision:baseRevision.current??data.revision,connectionId:connectionId||null,...connectionId?{modelId}:{}});if(live.current){edited.current=false;setDirty(false);update(value);client.invalidateQueries();setNotice(t('Speech settings saved.'))}}
  catch(e){if(live.current)setError(e.message);await refresh()}finally{mutating.current=false;if(live.current)setBusy(false)}
 };
 const button=(label,handler,disabled=false)=>jsx.jsx('button',{type:'button',className:'rounded-md border border-border-300 px-3 py-1.5 text-sm hover:bg-bg-200 disabled:opacity-50 focus-visible:shadow-focus',onClick:handler,disabled:busy||disabled,children:t(label)});
 return jsx.jsxs('section',{'aria-label':t('Speech recognition'),'data-chimeric-dirty':dirty?'true':'false',className:'mb-5 border-b border-border-300 pb-4',children:[
  jsx.jsx('h2',{className:'mb-1 text-base font-medium',children:t('Speech recognition')}),
  jsx.jsx('p',{className:'mb-3 text-sm text-text-400',children:t('Outside Class 2, speech recognition stays local. In Class 2, your selected speech connection is used.')}),
  jsx.jsxs('div',{className:'rounded-lg border border-border-300 p-3',children:[
   jsx.jsxs('fieldset',{disabled:busy||!data,className:'space-y-3',children:[
    jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Speech connection')}),jsx.jsxs('select',{className:control,value:connectionId,'data-testid':'speech-connection',onChange:event=>{edit();setConnectionId(event.target.value);setModelId(data.connections.find(value=>value.id===event.target.value)?.models[0]?.id??'')},children:[
     jsx.jsx('option',{value:'',children:t('Local speech recognition')+(data?.local.ready?'':' · '+t('Unavailable'))}),
     connectionId&&!connection&&jsx.jsx('option',{value:connectionId,disabled:true,children:t('Saved connection unavailable')}),
     ...(data?.connections??[]).map(value=>jsx.jsx('option',{value:value.id,disabled:!value.ready,children:value.name+(value.ready?'':' · '+t('Unavailable'))},value.id)),
    ]})]}),
    !!connectionId&&jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Speech model')}),jsx.jsxs('select',{className:control,value:modelId,'data-testid':'speech-model',onChange:event=>{edit();setModelId(event.target.value)},children:[
     modelId&&!knownModel&&jsx.jsx('option',{value:modelId,disabled:true,children:modelId+' · '+t('Unavailable')}),
     ...(connection?.models??[]).map(value=>jsx.jsx('option',{value:value.id,children:value.name},value.id)),
    ]})]}),
    jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Recording destination')+': '+(connectionId?connection?.endpointUrl??t('Saved connection unavailable'):data?.local.name??t('Local speech recognition'))}),
    !!connectionId&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Selecting this connection approves it for speech transcription in Class 2 sessions. Other model roles keep their own approvals.')}),
    jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Saving sends no recording or model request. The destination is shown again before microphone recording starts.')}),
    !available&&jsx.jsx('p',{role:'status',className:'text-footnote text-text-400',children:t('The saved speech connection or model is unavailable. It will not switch to another connection.')}),
    data?.warning&&jsx.jsx('p',{role:'alert',className:'text-footnote text-text-100',children:t(data.warning)}),
    jsx.jsxs('div',{className:'flex flex-wrap gap-2',children:[button(busy?'Saving…':'Save speech settings',save,!data||!available||!dirty&&!data?.warning),button('Cancel',reset,!dirty)]}),
   ]}),
   error&&jsx.jsx('p',{role:'alert',className:'mt-3 text-sm text-text-100',children:error}),
   notice&&jsx.jsx('p',{role:'status',className:'mt-3 text-footnote text-text-400',children:notice}),
  ]}),
 ]});
}
