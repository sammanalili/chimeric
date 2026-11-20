import {r as React,j as jsx,a as useQueryClient} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';
const t=value=>globalThis.ChimericI18n?.t(value)??value;
const base='/api/local/classifiers',typesafeEndpoint='https://api.typesafe.ai/v1/systemone';
const kinds=[['typesafe-hosted','TypeSafe-hosted'],['self-hosted-diffusion','Self-hosted diffusion'],['custom-system-one','Custom System One']];
const control='w-full min-w-0 rounded-md border border-border-300 bg-bg-000 px-3 py-2 text-sm text-text-100';
const buttonClass='rounded-md border border-border-300 px-3 py-1.5 text-sm hover:bg-bg-200 disabled:opacity-50 focus-visible:shadow-focus';
const empty=()=>({name:'',kind:'typesafe-hosted',endpointUrl:typesafeEndpoint,model:'',format:'flat',enabled:true,apiKey:'',clearCredential:false,confirmDestinationChange:false,class2Approved:false,policyEvidence:'',confirmPolicyChange:false,timeoutMs:15000});
const binding=value=>JSON.stringify([value.kind,value.endpointUrl.trim(),value.model.trim(),value.format]);
async function api(path='',method='GET',body){
 if(method!=='GET')await fetch('/api/csrf',{credentials:'same-origin'});
 const cookie=document.cookie.split('; ').find(value=>value.startsWith('operon_csrf='));
 const response=await fetch(base+path,{method,credentials:'same-origin',headers:{'content-type':'application/json',...(cookie?{'x-operon-csrf':decodeURIComponent(cookie.slice('operon_csrf='.length))}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 let data;try{data=await response.json()}catch{throw Error(t('The server returned an unexpected response.'))}
 if(!response.ok)throw Error(t(response.status===401?'Open your local workspace again to continue.':typeof data.detail==='string'?data.detail:'Could not load classifier connections.'));
 return data;
}
export function DecisionSettings(){
 const client=useQueryClient();
 const [data,setData]=React.useState(null),[form,setForm]=React.useState(empty),[dirty,setDirty]=React.useState(false),[busy,setBusy]=React.useState(false);
 const [error,setError]=React.useState(''),[notice,setNotice]=React.useState(''),[removing,setRemoving]=React.useState(null),[testResults,setTestResults]=React.useState({});
 const live=React.useRef(false),snapshot=React.useRef(null),readVersion=React.useRef(0),baseRevision=React.useRef(null),mutating=React.useRef(false);
 const accept=React.useCallback(value=>{if(live.current&&value&&Number.isInteger(value.revision)&&Array.isArray(value.connections)&&(!snapshot.current||value.revision>=snapshot.current.revision)){snapshot.current=value;setData(value)}},[]);
 const refresh=React.useCallback(async()=>{const version=++readVersion.current;const value=await api();if(live.current&&version===readVersion.current)accept(value);return value},[accept]);
 React.useEffect(()=>{
  live.current=true;refresh().catch(e=>{if(live.current)setError(e.message)});
  const unsubscribe=subscribeProviderEvents(()=>refresh().catch(e=>{if(live.current)setError(e.message)}));
  return()=>{live.current=false;readVersion.current++;unsubscribe()};
 },[refresh]);
 const reset=()=>{baseRevision.current=null;setForm(empty());setDirty(false);setError('')};
 const change=(key,value)=>{
  if(baseRevision.current===null)baseRevision.current=snapshot.current?.revision??null;
  setDirty(true);setNotice('');setError('');
  setForm(current=>{
   const next={...current,[key]:value};
   if(key==='kind'){next.endpointUrl=value==='typesafe-hosted'?typesafeEndpoint:'';next.model=''}
   if(key==='apiKey'&&value.trim())next.clearCredential=false;
   if(key==='clearCredential'&&value)next.apiKey='';
   if(['kind','endpointUrl'].includes(key))next.confirmDestinationChange=false;
   if(['kind','endpointUrl','model','format'].includes(key)&&current.savedClass2Approved&&binding(next)!==current.savedBinding){next.class2Approved=false;next.confirmPolicyChange=false}
   if(key==='class2Approved')next.confirmPolicyChange=!!value&&!!current.savedClass2Approved&&binding(next)!==current.savedBinding;
   return next;
  });
 };
 const edit=connection=>{
  baseRevision.current=snapshot.current.revision;
  setForm({...empty(),id:connection.id,name:connection.name,kind:connection.kind,endpointUrl:connection.endpointUrl,model:connection.model,format:connection.format,enabled:connection.enabled!==false,timeoutMs:connection.timeoutMs??15000,hasCredential:!!connection.hasCredential,savedEndpoint:connection.endpointUrl,savedClass2Approved:!!connection.class2Approved,savedBinding:binding(connection),class2Approved:!!connection.class2Approved,policyEvidence:connection.policyEvidence??''});
  setDirty(false);setError('');setNotice('');setRemoving(null);
 };
 const run=async(path,method,body,success)=>{
  if(mutating.current)return;mutating.current=true;readVersion.current++;setBusy(true);setError('');setNotice('');
  try{const value=await api(path,method,body);if(!live.current)return;accept(value);await refresh().catch(()=>undefined);if(!live.current)return;client.invalidateQueries();if(success)setNotice(t(success));return {value}}
  catch(e){if(live.current)setError(e.message);await refresh().catch(()=>undefined)}
  finally{mutating.current=false;if(live.current)setBusy(false)}
 };
 const destinationChanged=!!form.hasCredential&&form.endpointUrl.trim()!==form.savedEndpoint;
 const credentialConfirmation=destinationChanged&&!form.apiKey.trim()&&!form.clearCredential&&!form.confirmDestinationChange;
 const validTimeout=Number.isInteger(Number(form.timeoutMs))&&Number(form.timeoutMs)>=1000&&Number(form.timeoutMs)<=120000;
 const validEndpoint=(()=>{try{const url=new URL(form.endpointUrl);return !url.username&&!url.password&&!url.search&&!url.hash&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))}catch{return false}})();
 const canSave=!!data&&dirty&&!!form.name.trim()&&validEndpoint&&!!form.model.trim()&&validTimeout&&(!form.class2Approved||!!form.policyEvidence.trim())&&!credentialConfirmation;
 const save=async()=>{
  if(!canSave||mutating.current)return;
  const payload={expectedRevision:baseRevision.current??data.revision,...form.id?{id:form.id}:{},name:form.name.trim(),kind:form.kind,endpointUrl:form.endpointUrl.trim(),model:form.model.trim(),format:form.format,enabled:!!form.enabled,timeoutMs:Number(form.timeoutMs),class2Approved:!!form.class2Approved,policyEvidence:form.policyEvidence.trim(),...form.apiKey.trim()?{apiKey:form.apiKey.trim()}:{},...form.clearCredential?{clearCredential:true}:{},...form.confirmDestinationChange?{confirmDestinationChange:true}:{},...form.confirmPolicyChange?{confirmPolicyChange:true}:{}};
  if(await run('','POST',payload,'Classifier connection saved.'))reset();
 };
 const testConnection=async id=>{const connectionRevision=data.connections.find(connection=>connection.id===id)?.connectionRevision;const result=await run('/test','POST',{id,expectedRevision:data.revision});if(result&&live.current)setTestResults(previous=>({...previous,[id]:{connectionRevision,result:result.value}}))};
 const remove=async()=>{if(await run('','DELETE',{expectedRevision:data.revision,id:removing},'Classifier connection removed.')){if(form.id===removing)reset();setRemoving(null)}};
 const button=(label,onClick,disabled=false,props={})=>jsx.jsx('button',{type:'button',className:buttonClass,onClick,disabled:busy||disabled,...props,children:t(label)});
 const field=(label,key,props={})=>jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t(label)}),jsx.jsx('input',{className:control,value:form[key],onChange:event=>change(key,event.target.value),disabled:busy,...props})]});
 const check=(label,key,props={})=>jsx.jsxs('label',{className:'flex items-start gap-2 text-sm',children:[jsx.jsx('input',{type:'checkbox',className:'mt-0.5',checked:!!form[key],onChange:event=>change(key,event.target.checked),disabled:busy,...props}),t(label)]});
 const select=(label,key,options,props={})=>jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t(label)}),jsx.jsx('select',{className:control,value:form[key],onChange:event=>change(key,event.target.value),disabled:busy,...props,children:options.map(([value,label])=>jsx.jsx('option',{value,children:t(label)},value))})]});
 const resultView=connection=>{
  const local=testResults[connection.id],result=local?.connectionRevision===connection.connectionRevision?local?.result??connection.lastTest:connection.lastTest;if(!result)return null;
  const answers=result.answers===undefined?'':JSON.stringify(result.answers,null,2);
  return jsx.jsxs('div',{className:'mt-3 space-y-2',children:[
   jsx.jsx('p',{role:'status',className:'text-footnote text-text-400',children:t(typeof result.message==='string'?result.message:'Synthetic test request completed.')}),
   answers&&jsx.jsxs('details',{children:[jsx.jsx('summary',{className:'cursor-pointer text-footnote text-text-400',children:t('Synthetic test answers')}),jsx.jsx('pre',{className:'mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words text-footnote text-text-400',children:answers.length>8000?answers.slice(0,8000)+'\n…':answers})]}),
  ]});
 };
 return jsx.jsxs('section',{'aria-label':t('Classifiers'),'data-chimeric-dirty':dirty?'true':'false',className:'mb-5 border-b border-border-300 pb-4',children:[
  jsx.jsx('h2',{className:'mb-1 text-base font-medium',children:t('Classifiers')}),
  jsx.jsx('p',{className:'mb-2 text-sm text-text-400',children:t('Classifiers are optional. Adding a connection does not select it or send data. Requests run only when you explicitly test or use a classifier.')}),
  jsx.jsx('p',{className:'mb-3 text-sm text-text-400',children:t('Configure the service that returns System One classification decisions. Choose a default classifier separately from your research models.')}),
  jsx.jsxs('div',{className:'rounded-lg border border-border-300 p-3',children:[
   jsx.jsx('h3',{className:'mb-3 text-sm font-medium',children:t(form.id?'Edit classifier':'Add classifier')}),
   jsx.jsxs('fieldset',{disabled:busy,className:'space-y-3',children:[
    field('Connection name','name',{autoComplete:'off','data-testid':'classifier-name'}),
    select('Classifier type','kind',kinds,{'data-testid':'classifier-kind'}),
    field('Full endpoint URL','endpointUrl',{type:'url',spellCheck:false,autoComplete:'off','data-testid':'classifier-endpoint'}),
    jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Enter the complete request endpoint, including its path. Self-hosted and custom services require the URL supplied by their operator.')}),
    field('Model ID','model',{spellCheck:false,autoComplete:'off','data-testid':'classifier-model'}),
    field('API key (optional)','apiKey',{type:'password',autoComplete:'new-password',spellCheck:false,placeholder:t(form.hasCredential?'Leave blank to keep the saved key':'Leave blank for a keyless endpoint'),'data-testid':'classifier-api-key'}),
    form.hasCredential&&check('Remove saved key','clearCredential',{'data-testid':'classifier-clear-key'}),
    destinationChanged&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Changing the endpoint changes where the saved API key is sent. Enter a new key, remove the saved key, or confirm reuse.')}),
    destinationChanged&&!form.clearCredential&&!form.apiKey.trim()&&check('Reuse the saved key at the new endpoint','confirmDestinationChange',{'data-testid':'classifier-confirm-key'}),
    jsx.jsxs('details',{children:[jsx.jsx('summary',{className:'cursor-pointer text-sm',children:t('Connection options')}),jsx.jsxs('div',{className:'mt-3 space-y-3',children:[
     select('Request format','format',[['flat','Flat JSON'],['chat-envelope','Chat envelope']],{'data-testid':'classifier-format'}),
     field('Request timeout (milliseconds)','timeoutMs',{type:'number',min:1000,max:120000,step:1000,'data-testid':'classifier-timeout'}),
    ]})]}),
    jsx.jsxs('div',{className:'border-t border-border-300 pt-3 space-y-2',children:[
     jsx.jsx('h4',{className:'text-sm font-medium',children:t('Connection policy')}),
     jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Normal data is allowed. Class 2 data requires your explicit approval and supporting policy evidence. The provider name does not establish this permission.')}),
     check('Allow Class 2 data for this connection','class2Approved',{'data-testid':'classifier-class2'}),
     form.savedClass2Approved&&binding(form)!==form.savedBinding&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('This connection changed. Approve Class 2 again only after checking that the policy covers the new endpoint, model and request format.')}),
     jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Policy source or approval evidence')}),jsx.jsx('textarea',{rows:2,className:control,value:form.policyEvidence,onChange:event=>change('policyEvidence',event.target.value),disabled:busy,'aria-required':!!form.class2Approved,placeholder:t('Link to the policy or describe the approval and its scope.'),'data-testid':'classifier-policy-evidence'})]}),
     jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Class 2 approval records your connection policy. It does not certify the server or enforce data isolation.')}),
    ]}),
    jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Saved API keys are never returned to this form.')}),
    jsx.jsxs('div',{className:'flex flex-wrap gap-2',children:[button(busy?'Saving…':'Save classifier',save,!canSave,{'data-testid':'classifier-save'}),button('Cancel',reset,!dirty&&!form.id)]}),
   ]}),
  ]}),
  error&&jsx.jsx('p',{role:'alert',className:'mt-3 text-sm text-text-100',children:error}),
  notice&&jsx.jsx('p',{role:'status',className:'mt-3 text-footnote text-text-400',children:notice}),
  !data&&jsx.jsx('p',{role:'status',className:'mt-3 text-footnote text-text-400',children:t('Loading classifier connections…')}),
  data&&jsx.jsxs('div',{className:'mt-4 space-y-3',children:[
   jsx.jsxs('label',{className:'block text-sm',children:[jsx.jsx('span',{className:'mb-1 block text-text-400',children:t('Default classifier')}),jsx.jsxs('select',{className:control,value:data.selectedId??'',disabled:busy||dirty,'data-testid':'classifier-default',onChange:event=>run('','PUT',{expectedRevision:data.revision,selectedId:event.target.value||null},'Default classifier updated.'),children:[
    jsx.jsx('option',{value:'',children:t('Off')}),
    ...data.connections.map(connection=>jsx.jsx('option',{value:connection.id,disabled:connection.enabled===false,children:connection.name},connection.id)),
   ]})]}),
   data.connections.length===0&&jsx.jsx('p',{className:'text-footnote text-text-400',children:t('No classifier connections configured.')}),
   data.connections.map(connection=>jsx.jsxs('details',{className:'rounded-lg border border-border-300 p-3','data-testid':'classifier-connection-'+connection.id,children:[
    jsx.jsx('summary',{className:'cursor-pointer text-sm font-medium',children:connection.name+(connection.id===data.selectedId?' · '+t('Default'):'')}),
    jsx.jsx('p',{className:'mt-2 break-all text-footnote text-text-400',children:connection.endpointUrl}),
    jsx.jsx('p',{className:'mt-1 break-all text-footnote text-text-400',children:t(kinds.find(([id])=>id===connection.kind)?.[1]??connection.kind)+' · '+connection.model+' · '+connection.format}),
    jsx.jsx('p',{className:'mt-1 text-footnote text-text-400',children:t(connection.hasCredential?'Key configured':'No saved key')+' · '+t(connection.enabled===false?'Disabled':'Enabled')}),
    jsx.jsx('p',{className:'mt-1 text-footnote text-text-400',children:t(connection.class2Approved?'Normal and Class 2 data':'Normal data only')}),
    connection.policyEvidence&&jsx.jsx('p',{className:'mt-1 whitespace-pre-wrap break-words text-footnote text-text-400',children:t('Policy source or approval evidence')+': '+connection.policyEvidence}),
    jsx.jsxs('div',{className:'mt-3 flex flex-wrap gap-2',children:[button('Edit',()=>edit(connection),dirty),button('Remove classifier',()=>setRemoving(connection.id),dirty),button('Test with synthetic text',()=>testConnection(connection.id),dirty||connection.enabled===false)]}),
    resultView(connection),
    removing===connection.id&&jsx.jsxs('div',{className:'mt-3 space-y-2',children:[jsx.jsx('p',{className:'text-sm',children:t('Remove this classifier connection?')}),jsx.jsxs('div',{className:'flex flex-wrap gap-2',children:[button('Remove classifier',remove,dirty,{'data-testid':'classifier-confirm-remove'}),button('Cancel',()=>setRemoving(null))]})]}),
   ]},connection.id)),
   jsx.jsx('p',{className:'text-footnote text-text-400',children:t('Connection tests send fixed synthetic text using the saved connection. Research content and unsaved form values are excluded.')}),
  ]}),
 ]});
}
