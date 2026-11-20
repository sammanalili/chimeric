import {r as React,j as jsx,a as useQueryClient} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
const t=value=>globalThis.ChimericI18n?.t(value)??value;
const endpoint='/api/local/antigravity-http';
const caution='This integration is not an official Google integration for Chimeric. Google may change access or restrict accounts. Review Google’s terms before enabling it.';
const buttonClass='rounded-md border border-border-300 px-3 py-1.5 text-sm hover:bg-bg-200 disabled:opacity-50 focus-visible:shadow-focus';
async function api(body){
 if(body!==undefined)await fetch('/api/csrf',{credentials:'same-origin'});
 const cookie=document.cookie.split('; ').find(value=>value.startsWith('operon_csrf='));
 const response=await fetch(endpoint,{method:body===undefined?'GET':'POST',credentials:'same-origin',headers:{'content-type':'application/json',...(cookie?{'x-operon-csrf':decodeURIComponent(cookie.slice('operon_csrf='.length))}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 let data;try{data=await response.json()}catch{throw Error(t('The server returned an unexpected response.'))}
 if(!response.ok)throw Error(t(response.status===401?'Open your local workspace again to continue.':typeof data.detail==='string'?data.detail:'Could not read the Antigravity subscription. Retry or reopen Connections.'));
 return data;
}
export function AntigravityConnection(){
 const client=useQueryClient(),[status,setStatus]=React.useState(null),[open,setOpen]=React.useState(false),[warning,setWarning]=React.useState(false),[busy,setBusy]=React.useState(false),[error,setError]=React.useState('');
 const live=React.useRef(false),generation=React.useRef(0),mutating=React.useRef(false),warningFocused=React.useRef(false);
 const waiting=['preparing','waiting'].includes(status?.login?.phase),refreshing=status?.modelDiscovery?.state==='refreshing';
 React.useEffect(()=>{
  live.current=true;let timer,stopped=false;
  const poll=async()=>{
   if(mutating.current){timer=setTimeout(poll,1000);return}const version=++generation.current;
   try{const value=await api();if(!stopped&&version===generation.current){setStatus(value);setError('')}}catch(e){if(!stopped&&version===generation.current)setError(e.message)}
   if(!stopped)timer=setTimeout(poll,waiting||refreshing?1000:15_000);
  };
  poll();return()=>{stopped=true;live.current=false;generation.current++;clearTimeout(timer)};
 },[waiting,refreshing]);
 const action=async body=>{
  if(mutating.current)return;mutating.current=true;generation.current++;setBusy(true);setError('');
  try{const value=await api(body);if(live.current){setStatus(value);client.invalidateQueries()}}catch(e){if(live.current)setError(e.message)}finally{mutating.current=false;if(live.current)setBusy(false)}
 };
 const ready=!!status?.prerequisite?.installed&&!!status?.prerequisite?.compatible&&!!status?.prerequisite?.signedIn;
 const enabled=status?.experimental?.enabled===true,transport=status?.experimental?.transport??'direct';
 const button=(label,body,disabled=false)=>jsx.jsx('button',{type:'button',className:buttonClass,onClick:()=>action(body),disabled:busy||disabled,children:t(label)});
 const title=status?.connected?enabled&&ready?'Connected':'Signed in · connection disabled':waiting?'Waiting for sign-in':'Disconnected';
 return jsx.jsxs('section',{'aria-label':t('Google Antigravity'),'data-testid':'antigravity-subscription',className:'mb-5 rounded-lg border border-border-300 p-3',children:[
  jsx.jsxs('div',{className:'flex items-center justify-between gap-3',children:[
   jsx.jsx('button',{type:'button',className:'flex-1 text-left text-sm font-medium text-text-100','aria-expanded':open,'aria-controls':'google-antigravity-controls',onClick:()=>setOpen(value=>!value),children:'Google Antigravity'}),
   jsx.jsxs('span',{className:'relative inline-flex',onMouseEnter:()=>setWarning(true),onMouseLeave:()=>{if(!warningFocused.current)setWarning(false)},children:[
    jsx.jsx('button',{type:'button',className:'inline-flex h-7 w-7 items-center justify-center rounded-md text-text-400 hover:bg-bg-200 focus-visible:shadow-focus','aria-label':t('About the Google Antigravity connection'),'aria-expanded':warning,'aria-describedby':warning?'google-antigravity-warning':undefined,onFocus:()=>{warningFocused.current=true;setWarning(true)},onBlur:()=>{warningFocused.current=false;setWarning(false)},onClick:()=>setWarning(true),onKeyDown:event=>{if(event.key==='Escape')setWarning(false)},'data-testid':'antigravity-warning',children:jsx.jsxs('svg',{width:16,height:16,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.6,'aria-hidden':true,children:[jsx.jsx('path',{d:'M10.3 4.2 2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z'}),jsx.jsx('path',{d:'M12 9v4m0 4h.01'})]})}),
    warning&&jsx.jsx('span',{id:'google-antigravity-warning',role:'tooltip',className:'rounded-md border border-border-300 bg-bg-000 p-3 text-left text-footnote text-text-100 shadow-md',style:{position:'absolute',insetInlineEnd:0,top:'100%',zIndex:60,width:280,maxWidth:'calc(100vw - 64px)'},children:t(caution)}),
   ]}),
  ]}),
  open&&jsx.jsxs('div',{id:'google-antigravity-controls',className:'mt-3 space-y-3',children:[
   jsx.jsx('p',{role:'status',className:'text-footnote text-text-400',children:t(title)}),
   jsx.jsxs('label',{className:'flex items-start gap-2 text-sm',children:[jsx.jsx('input',{type:'checkbox',checked:enabled,disabled:busy||!status||waiting||!enabled&&!ready,onChange:event=>action({action:'configure',enabled:event.target.checked,transport}),'data-testid':'antigravity-enabled'}),t('Enable this connection')]}),
   !ready&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Install and sign in to a compatible Antigravity client before enabling this connection.')}),
   status?.prerequisite?.detail&&jsx.jsx('p',{role:'status',className:'text-footnote text-text-400',children:t(status.prerequisite.detail)}),
   jsx.jsxs('div',{className:'flex flex-wrap gap-2',children:[button('Check client',{action:'check-client'},!status||waiting),status?.connected?button('Disconnect',{action:'disconnect'},waiting):!waiting&&transport==='direct'&&button('Use existing Antigravity session',{action:'signin',method:'import'},!status||!ready),!status?.connected&&!waiting&&button(transport==='cli'?'Connect official CLI':'Sign in with Google',{action:'signin',method:'browser'},!status||transport==='direct'&&!status.oauthConfigured)]}),
   transport==='direct'&&!status?.oauthConfigured&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Browser sign-in needs a local OAuth client configuration. Use the official CLI, or import a refreshed session from the installed official client.')}),
   jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Connection method')}),jsx.jsxs('select',{className:'w-full rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-sm text-text-100',value:transport,disabled:busy||!status||waiting,onChange:event=>action({action:'configure',enabled,transport:event.target.value}),'data-testid':'antigravity-transport',children:[jsx.jsx('option',{value:'direct',children:t('Direct connection')}),jsx.jsx('option',{value:'cli',children:t('Official CLI')})]})]}),
   status?.connected&&jsx.jsxs('div',{className:'space-y-2 text-footnote text-text-400',children:[status.email&&jsx.jsx('p',{children:t('Signed in as')+': '+status.email}),jsx.jsx('p',{children:t('Plan')+': '+(status.paidTier||status.tier||t('Unknown'))}),jsx.jsx('p',{role:'status',children:t('Discovered models')+': '+(status.modelDiscovery?.count??status.models?.length??0)}),button(refreshing?'Refreshing models…':'Refresh models',{action:'refresh'},!ready||refreshing),status.modelDiscovery?.message&&jsx.jsx('p',{role:'status',children:t(status.modelDiscovery.message)})]}),
   waiting&&jsx.jsxs('div',{className:'space-y-2 text-sm',children:[jsx.jsx('p',{children:t('Complete Google’s sign-in screen, then return here. This connection stays open until you finish or cancel.')}),status.login.authorizationUrl&&jsx.jsx('a',{href:status.login.authorizationUrl,target:'_blank',rel:'noopener noreferrer',className:'underline',children:t('Continue to Google')}),button('Cancel sign-in',{action:'cancel'})]}),
   error&&jsx.jsx('p',{className:'text-sm',role:'alert',children:error}),
   jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Uses your Google AI subscription limits. You can disable or disconnect this connection at any time.')}),
  ]}),
 ]});
}
