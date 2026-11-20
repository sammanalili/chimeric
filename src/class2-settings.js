import {r as React,j as jsx} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';

const t=value=>globalThis.ChimericI18n?.t?.(value)??value;
const base='/api/local/confidentiality';
const muted='text-text-300 text-xs';
const button='rounded-md border border-border-300 px-2 py-1 text-sm disabled:opacity-50';
function subscribe(callback){
 const unsubscribe=subscribeProviderEvents(callback);
 globalThis.addEventListener?.('chimeric-confidentiality-changed',callback);
 return()=>{unsubscribe();globalThis.removeEventListener?.('chimeric-confidentiality-changed',callback)};
}
function csrf(){return document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('operon_csrf='))?.slice('operon_csrf='.length)}
async function api(url,options={}){
 const headers={...(options.headers??{})};
 if(options.method&&options.method!=='GET'){
  if(!csrf()){const result=await fetch('/api/csrf',{credentials:'same-origin',cache:'no-store',redirect:'error',signal:options.signal});if(!result.ok)throw Error(t('Refresh the app before changing confidentiality settings.'))}
  const token=csrf();if(!token)throw Error(t('Refresh the app before changing confidentiality settings.'));
  headers['x-operon-csrf']=decodeURIComponent(token);headers['content-type']='application/json';
 }
 const result=await fetch(url,{...options,headers,credentials:'same-origin',cache:'no-store',redirect:'error'});
 const value=await result.json();if(!result.ok)throw Error(typeof value.detail==='string'?t(value.detail):t('The confidentiality operation could not be completed.'));
 return value;
}
function endpoint(kind,id){return kind==='frame'?base+'?frameId='+encodeURIComponent(id):base+'/connections/'+encodeURIComponent(id)}
function useSnapshot(kind,id){
 const key=kind+':'+(id??''),current=React.useRef(key);current.current=key;
 const generation=React.useRef(0),read=React.useRef(),write=React.useRef(),alive=React.useRef(true),locked=React.useRef(false);
 const [state,setState]=React.useState({key:'',snapshot:null,error:'',busy:false});
 const refresh=React.useCallback(async(preserveError=false)=>{
  if(!id)return;const scope=key,turn=++generation.current;read.current?.abort();const controller=new AbortController();read.current=controller;
  try{const snapshot=await api(endpoint(kind,id),{signal:controller.signal});
   if((kind==='frame'?snapshot.frameId:snapshot.connectionId)!==id||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)throw Error(t('The confidentiality scope changed. Reload this session.'));
   if(alive.current&&current.current===scope&&turn===generation.current)setState(old=>({...old,key:scope,snapshot,error:preserveError===true?old.error:''}));
  }catch(error){if(error.name!=='AbortError'&&alive.current&&current.current===scope&&turn===generation.current)setState(old=>({...old,key:scope,snapshot:old.key===scope?old.snapshot:null,error:error.message}))}
 },[kind,id,key]);
 React.useEffect(()=>{alive.current=true;if(!id)return;refresh();const unsubscribe=subscribe(()=>refresh());return()=>{alive.current=false;++generation.current;read.current?.abort();write.current?.abort();write.current=undefined;locked.current=false;unsubscribe()}},[id,refresh]);
 const snapshot=state.key===key?state.snapshot:null;
 React.useEffect(()=>{
  if(kind!=='frame'||snapshot?.mode!=='class2')return;
  let timer;const tick=()=>{timer=setTimeout(async()=>{if(document.visibilityState!=='hidden')await refresh();tick()},5000)};tick();return()=>clearTimeout(timer);
 },[kind,snapshot?.mode,refresh]);
 const mutate=React.useCallback(async(path,body,method='POST')=>{
  if(!id||locked.current)return false;locked.current=true;const scope=key;read.current?.abort();++generation.current;
  // Revoke browser resource leases before the server can commit a stricter
  // scope. A failed mutation may refresh them; a late old lease cannot survive.
  globalThis.dispatchEvent?.(new Event('chimeric-confidentiality-changing'));
  const controller=new AbortController();write.current=controller;setState(old=>({...old,key:scope,busy:true,error:''}));
  try{const value=await api(path,{method,body:JSON.stringify(body),signal:controller.signal});
   if((kind==='frame'?value.frameId:value.connectionId)!==id||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error(t('The confidentiality scope changed. Reload this session.'));
   if(alive.current&&current.current===scope&&write.current===controller){setState({key:scope,snapshot:value,error:'',busy:false});globalThis.dispatchEvent?.(new Event('chimeric-confidentiality-changed'))}return true;
  }catch(error){if(error.name!=='AbortError'&&alive.current&&current.current===scope&&write.current===controller)setState(old=>({...old,key:scope,error:error.message,busy:false}));return false}
  finally{if(current.current===scope&&write.current===controller){locked.current=false;if(alive.current){setState(old=>({...old,busy:false}));refresh(true)}}}
 },[id,kind,key,refresh]);
 return {snapshot,error:state.key===key?state.error:'',busy:state.key===key&&state.busy,mutate};
}
function Field({label,children,literal=false}){return jsx.jsxs('div',{style:{marginTop:10},children:[jsx.jsx('div',{className:muted,children:literal?label:t(label)}),children]})}
function ExactText({value}){return jsx.jsx('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:300,overflow:'auto',margin:'4px 0',fontSize:12},children:String(value??'')})}
function byteCount(value){const padding=value.endsWith('==')?2:value.endsWith('=')?1:0;return Math.max(0,value.length*3/4-padding)}
function downloadBytes(file){
 const bytes=Uint8Array.from(atob(file.base64),value=>value.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:file.contentType}));
 const anchor=document.createElement('a');anchor.href=url;anchor.download=file.filename||'outgoing-data';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),0);
}
function FileBytes({file}){
 const preview=/^image\/(png|jpeg|webp|gif|avif)$/i.test(file.contentType);
 return jsx.jsxs('div',{className:'rounded-md border border-border-300 p-2',style:{marginTop:6},children:[
  jsx.jsx('strong',{children:file.filename||t('Outgoing bytes')}),jsx.jsx('div',{className:muted,children:file.contentType+' · '+byteCount(file.base64)+' '+t('bytes')}),
  preview?jsx.jsx('img',{alt:t('Exact outgoing image'),src:'data:'+file.contentType+';base64,'+file.base64,style:{maxWidth:'100%',maxHeight:220,objectFit:'contain'}}):null,
  jsx.jsx('button',{type:'button',className:button,onClick:()=>downloadBytes(file),children:t('Download exact bytes')}),
  jsx.jsxs('details',{children:[jsx.jsx('summary',{children:t('Exact base64 bytes')}),jsx.jsx('textarea',{readOnly:true,value:file.base64,'aria-label':t('Exact base64 bytes'),style:{width:'100%',minHeight:100,fontFamily:'monospace',fontSize:11}})]})]});
}
function ExactPayload({payload}){
 if(payload.kind==='none')return jsx.jsx('p',{children:t('No request body.')});
 if(payload.kind==='text')return jsx.jsxs(React.Fragment,{children:[jsx.jsx('div',{className:muted,children:payload.contentType}),jsx.jsx(ExactText,{value:payload.text}),jsx.jsxs('details',{children:[jsx.jsx('summary',{children:t('Escaped text, including whitespace')}),jsx.jsx(ExactText,{value:JSON.stringify(payload.text)})]})]});
 if(payload.kind==='json')return jsx.jsx(ExactText,{value:JSON.stringify(payload.value)});
 if(payload.kind==='bytes')return jsx.jsx(FileBytes,{file:payload});
 if(payload.kind==='multipart')return jsx.jsxs(React.Fragment,{children:[...payload.fields.map((field,index)=>jsx.jsxs(Field,{label:field.name,literal:true,children:[jsx.jsx(ExactText,{value:field.value}),jsx.jsx(ExactText,{value:JSON.stringify(field.value)})]},'field-'+index)),...payload.files.map((file,index)=>jsx.jsx(Field,{label:file.fieldName,literal:true,children:jsx.jsx(FileBytes,{file})},'file-'+index))]});
 return jsx.jsx('p',{role:'alert',children:t('This request format cannot be reviewed here. Sending is disabled.')});
}
function ReviewContent({review}){return jsx.jsxs(React.Fragment,{children:[
 jsx.jsx(Field,{label:'Why this request is needed',children:jsx.jsx(ExactText,{value:review.rationale})}),
 jsx.jsx(Field,{label:'Exact destination',children:jsx.jsx(ExactText,{value:review.request.method+' '+review.destination.url})}),
 jsx.jsx('p',{className:muted,children:t(review.destination.encrypted?'The connection uses HTTPS.':'The connection is not encrypted with HTTPS.')}),
 jsx.jsx(Field,{label:'Local transformation',children:jsx.jsxs(React.Fragment,{children:[jsx.jsx(ExactText,{value:t(review.privacy.kind)+': '+review.privacy.summary}),jsx.jsx(ExactText,{value:review.privacy.limitations?.join('\n')}),jsx.jsx('p',{children:t(review.privacy.notice)})]})}),
 jsx.jsx(Field,{label:'Exact request headers',children:jsx.jsx(ExactText,{value:JSON.stringify(review.request.headers)})}),
 jsx.jsx(Field,{label:'Exact outgoing content and uploads',children:jsx.jsx(ExactPayload,{payload:review.request.payload})}),
 jsx.jsx('p',{className:muted,children:t('Files can contain metadata. Review all fields and uploads before allowing this request.')}),
 jsx.jsx(Field,{label:'Request body identity',children:jsx.jsx(ExactText,{value:review.request.bodyBytes+' '+t('bytes')+'\nSHA-256: '+review.request.bodySha256})}),
 ...[['Authentication and account',review.disclosures.authentication],['Network address',review.disclosures.ip],['Approximate location',review.disclosures.location],['Other disclosures',review.disclosures.other]].map(([label,value])=>jsx.jsx(Field,{label,children:jsx.jsx(ExactText,{value:Array.isArray(value)?value.map(part=>t(part)).join('\n'):t(value)})},label))]})}
function ReviewDialog({frameId,review,busy,onSend,onDeny,onClose}){
 const dialog=React.useRef(),key=frameId+':'+review.id+':'+review.digest,[consent,setConsent]=React.useState(''),[now,setNow]=React.useState(Date.now());
 React.useEffect(()=>{const element=dialog.current;if(element&&!element.open)element.showModal();return()=>{if(element?.open)element.close()}},[key]);
 React.useEffect(()=>{if(!Number.isFinite(review.expiresAt))return;const delay=Math.max(0,Math.min(2147483647,review.expiresAt-Date.now()+1));const timer=setTimeout(()=>setNow(Date.now()),delay);return()=>clearTimeout(timer)},[key,review.expiresAt]);
 const pending=review.status==='pending'&&Number.isFinite(review.expiresAt)&&review.expiresAt>Math.max(now,Date.now());
 const supported=['none','text','json','bytes','multipart'].includes(review.request.payload.kind);
 return jsx.jsxs('dialog',{ref:dialog,onCancel:onClose,onClose,style:{width:'min(880px,calc(100vw - 32px))',maxHeight:'85vh',overflow:'auto',padding:20,borderRadius:12,border:'1px solid var(--border-300)',color:'var(--text-100)',background:'var(--bg-100)'},'aria-label':t('Review outgoing request'),children:[
  jsx.jsx('h3',{style:{marginTop:0},children:t('Review outgoing request')}),jsx.jsx('p',{children:t('Only the server-held request shown below can be sent. Permission applies once.')}),jsx.jsx(ReviewContent,{review}),
  jsx.jsxs('label',{style:{display:'flex',gap:8,alignItems:'start',marginTop:16},children:[jsx.jsx('input',{type:'checkbox',checked:consent===key,disabled:busy||!pending,onChange:event=>setConsent(event.target.checked?key:'')}),t('I reviewed the destination, content, uploads and disclosures. Allow this request once.')]}),
  !pending?jsx.jsx('p',{role:'status',children:t(review.status==='pending'?'This review expired. Prepare a new request.':'This request is no longer pending.')}):null,
  jsx.jsxs('div',{style:{display:'flex',justifyContent:'end',gap:8,marginTop:16},children:[jsx.jsx('button',{type:'button',className:button,onClick:onClose,children:t('Close')}),jsx.jsx('button',{type:'button',className:button,disabled:busy||review.status!=='pending',onClick:onDeny,children:t('Deny')}),jsx.jsx('button',{type:'button',className:button,disabled:busy||!pending||!supported||consent!==key,onClick:onSend,children:t('Send once')})]})]});
}
function ReviewList({frameId,snapshot,busy,mutate}){
 const [selected,setSelected]=React.useState(null),key=frameId+':'+selected?.id;
 const review=selected?.frameId===frameId?snapshot?.reviews?.find(item=>item.id===selected.id):undefined;
 const pending=snapshot?.reviews?.filter(item=>item.status==='pending')??[];
 return jsx.jsxs(React.Fragment,{children:[...pending.map(item=>jsx.jsx('button',{type:'button',className:button,style:{display:'block',marginTop:8},onClick:()=>setSelected({frameId,id:item.id}),children:t('Review outgoing request')+' · '+item.destination.hostname},item.id)),review?jsx.jsx(ReviewDialog,{frameId,review,busy,onClose:()=>setSelected(null),onSend:()=>mutate(base+'/reviews/'+encodeURIComponent(review.id)+'/send',{frameId,digest:review.digest}),onDeny:()=>mutate(base+'/reviews/'+encodeURIComponent(review.id)+'/deny',{frameId})},key):null]});
}
export function ConfidentialityControl({frameId,compact=false}){
 const {snapshot,error,busy,mutate}=useSnapshot('frame',frameId),[draft,setDraft]=React.useState({key:'',main:'',reviewer:''});
 const choices=snapshot?.models?.filter(model=>model.eligible===true)??[],policyKey=frameId+':'+snapshot?.revision;
 const fallback=choices[0]?.qualifiedId??'',valid=value=>choices.some(model=>model.qualifiedId===value);
 const main=valid(draft.key===policyKey?draft.main:snapshot?.main)?(draft.key===policyKey?draft.main:snapshot.main):fallback;
 const reviewer=valid(draft.key===policyKey?draft.reviewer:snapshot?.reviewer)?(draft.key===policyKey?draft.reviewer:snapshot.reviewer):main;
 const active=snapshot?.mode==='class2',save=(mode,nextMain=main,nextReviewer=reviewer)=>mutate(base,{frameId,expectedRevision:snapshot.revision,mode,...mode==='class2'?{main:nextMain,reviewer:nextReviewer}:{}},'PUT');
 const select=(role,value)=>{if(!valid(value)||!snapshot)return;const nextMain=role==='main'?value:main,nextReviewer=role==='reviewer'?value:reviewer===main?nextMain:reviewer;setDraft({key:policyKey,main:nextMain,reviewer:nextReviewer});if(active)save('class2',nextMain,nextReviewer)};
 return jsx.jsxs('section',{'data-testid':'confidentiality-control',style:{minWidth:compact?230:0,padding:compact?'8px 0':0},children:[
  jsx.jsxs('label',{style:{display:'flex',gap:8,alignItems:'center'},children:[jsx.jsx('input',{type:'checkbox','aria-label':t('Class 2 confidentiality'),checked:active,disabled:busy||!snapshot||(!active&&(!snapshot.ready||!main||!reviewer)),onChange:event=>save(event.target.checked?'class2':'standard')}),jsx.jsx('strong',{children:t('Class 2 confidentiality')})]}),
  jsx.jsx('p',{className:muted,children:!frameId?t('Start a research session before choosing its confidentiality level.'):snapshot?.reason?t(snapshot.reason):t(active?'Approved models handle this session. External requests require review. Unverified tools are blocked.':'Choose approved model connections before enabling Class 2.')}),
  ...[['main','Main model',main],['reviewer','Reviewer model',reviewer]].map(([role,label,value])=>jsx.jsx(Field,{label,children:jsx.jsxs('select',{'aria-label':t(label),value,disabled:busy||!snapshot||!choices.length,onChange:event=>select(role,event.target.value),style:{width:'100%',minHeight:30},children:[!choices.length?jsx.jsx('option',{value:'',children:t('No approved model connection')}):null,...choices.map(model=>jsx.jsx('option',{value:model.qualifiedId,children:model.name},model.qualifiedId))]})},role)),
  error?jsx.jsx('p',{role:'alert',children:t(error)}):null,jsx.jsx(ReviewList,{frameId,snapshot,busy,mutate})]});
}
export function OutboundReviews({frameId}){const {snapshot,error,busy,mutate}=useSnapshot('frame',frameId);return jsx.jsxs('div',{children:[error?jsx.jsx('p',{role:'alert',children:t(error)}):null,jsx.jsx(ReviewList,{frameId,snapshot,busy,mutate})]})}
export function PolicyModelPicker({frameId,fallback}){
 const {snapshot,error}=useSnapshot('frame',frameId),[open,setOpen]=React.useState(false),dialog=React.useRef();
 React.useEffect(()=>{if(open&&dialog.current&&!dialog.current.open)dialog.current.showModal();return()=>{if(dialog.current?.open)dialog.current.close()}},[open,frameId,snapshot?.mode]);
 React.useEffect(()=>{setOpen(false)},[frameId]);
 if(!frameId||snapshot?.mode==='standard')return fallback;
 const model=snapshot?.models?.find(model=>model.qualifiedId===snapshot.main),label=model?.name||t(error?'Model unavailable':'Checking model…');
 return jsx.jsxs(React.Fragment,{children:[jsx.jsxs('button',{type:'button','data-testid':'protected-model-selector','aria-label':t('Class 2 model')+': '+label,disabled:!snapshot,onClick:()=>setOpen(true),className:'inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-sm text-text-200 hover:bg-bg-200',title:t('Class 2 model'),children:[jsx.jsx('svg',{width:13,height:13,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.5,'aria-hidden':true,children:jsx.jsx('path',{d:'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z'})}),jsx.jsx('span',{className:'max-w-48 truncate',children:label})]}),open&&jsx.jsxs('dialog',{ref:dialog,onCancel:()=>setOpen(false),onClose:()=>setOpen(false),'aria-label':t('Class 2 model'),style:{width:'min(380px,calc(100vw - 32px))',padding:20,border:'1px solid var(--color-border-300)',borderRadius:12},children:[jsx.jsx(ConfidentialityControl,{frameId}),jsx.jsx('button',{type:'button',className:button,onClick:()=>setOpen(false),children:t('Close')})]})]});
}
export function ConnectionEligibility({connectionId}){
 const {snapshot,error,busy,mutate}=useSnapshot('connection',connectionId),automatic=snapshot?.automaticPurposes??[],explicit=snapshot?.allowedPurposes??[];
 const change=(purpose,allowed)=>{const purposes=explicit.filter(value=>value!==purpose);if(allowed)purposes.push(purpose);mutate(base+'/connections/'+encodeURIComponent(connectionId),{expectedRevision:snapshot.revision,purposes},'PUT')};
 return jsx.jsxs('section',{'data-testid':'class2-connection-eligibility',style:{marginTop:12},children:[jsx.jsx('strong',{children:t('Class 2 permission')}),
  jsx.jsx('p',{className:muted,children:t('Allow this connection only after checking where it sends and stores data. Connections are not approved automatically.')}),
  ...[['model','Allow Class 2 model processing'],['stt','Allow Class 2 speech transcription']].map(([purpose,label])=>jsx.jsxs('label',{style:{display:'flex',gap:8,marginTop:6},children:[jsx.jsx('input',{type:'checkbox',checked:explicit.includes(purpose),disabled:busy||!snapshot,onChange:event=>change(purpose,event.target.checked)}),t(label)]},purpose)),
  automatic.includes('stt')?jsx.jsx('p',{className:muted,children:t('Speech permission also comes from the selected transcription model. Changing the selection removes that automatic permission.')}):null,
  snapshot?.reason?jsx.jsx('p',{className:muted,children:t(snapshot.reason)}):null,
  jsx.jsx(Field,{label:'Retention and ZDR evidence',children:jsx.jsxs(React.Fragment,{children:[jsx.jsx(ExactText,{value:t(snapshot?.evidence?.status||'Unknown')}),snapshot?.evidence?.retention?jsx.jsx(ExactText,{value:t(snapshot.evidence.retention)}):null,snapshot?.evidence?.zdr?jsx.jsx(ExactText,{value:t(snapshot.evidence.zdr)}):null,snapshot?.evidence?.summary?jsx.jsx(ExactText,{value:t(snapshot.evidence.summary)}):null,jsx.jsx('p',{className:muted,children:t('Your permission is separate from retention evidence. It does not prove zero data retention or guarantee confidentiality.')})]})}),
  error?jsx.jsx('p',{role:'alert',children:t(error)}):null]});
}
