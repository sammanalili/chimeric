import {r as React,j as jsx} from '/assets/vendor-CED4rDjN.js?science_local=chatgpt-v1';
import {subscribeProviderEvents} from '/api/local/connections/events.js';

// Presentation only. The daemon independently authorizes bytes and connectors.
const records=new WeakMap(),live=new Set(),StandardContext=React.createContext(null);
const idPattern=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/,checksumPattern=/^[a-f0-9]{64}$/;
const MAX_JSON=6*1024*1024,MAX_TEXT=256*1024,MAX_IMAGE=4*1024*1024,LEASE_MS=15000;
let serial=0;
const t=value=>globalThis.ChimericI18n?.t?.(value)??value;
const blocked=reason=>Object.freeze({decision:'blocked',reason:reason||'This file cannot open in the selected chat.'});
const validId=value=>typeof value==='string'&&idPattern.test(value);
const bytes=value=>new TextEncoder().encode(value).length;
function lookupOf(props){
 const {artifactId,versionId,consumerFrameId,allowUnboundStandard}=props??{};
 if((artifactId!==undefined&&!validId(artifactId))||(versionId!==undefined&&!validId(versionId))||(consumerFrameId!==undefined&&!validId(consumerFrameId)))return null;
 if(!artifactId&&!versionId)return allowUnboundStandard===true?Object.freeze({unbound:true,...consumerFrameId?{consumerFrameId}:{}}):null;
 return Object.freeze({...versionId?{versionId}:{artifactId},...artifactId?{artifactHint:artifactId}:{},...consumerFrameId?{consumerFrameId}:{}});
}
function lookupKey(lookup){return lookup?JSON.stringify(lookup):''}
function revision(value){return Number.isSafeInteger(value)&&value>=0||typeof value==='string'&&value.length>0&&value.length<=128&&/^[A-Za-z0-9._:-]+$/.test(value)}
function raster(value){
 // Deliberately PNG only. SVG/HTML/remote URLs/blobs never enter an inert view.
 if(typeof value!=='string'||!value.startsWith('data:image/png;base64,'))return null;
 const encoded=value.slice(22);if(!encoded||encoded.length>Math.ceil(MAX_IMAGE/3)*4||encoded.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))return null;
 let data;try{const decoded=atob(encoded);if(decoded.length>MAX_IMAGE||btoa(decoded)!==encoded)return null;data=Uint8Array.from(decoded,x=>x.charCodeAt(0))}catch{return null}
 const signature=[137,80,78,71,13,10,26,10];if(data.length<45||signature.some((n,i)=>data[i]!==n))return null;
 const view=new DataView(data.buffer),tag=offset=>String.fromCharCode(...data.subarray(offset,offset+4));
 let offset=8,chunks=0,ended=false,seenData=false;
 while(offset+12<=data.length){const length=view.getUint32(offset);if(length>MAX_IMAGE||offset+12+length>data.length)return null;const kind=tag(offset+4);
  if(!chunks){if(kind!=='IHDR'||length!==13)return null;const width=view.getUint32(offset+8),height=view.getUint32(offset+12);if(!width||!height||width>8192||height>8192||width*height>16777216)return null}else if(kind==='IHDR')return null;
  if(['acTL','fcTL','fdAT'].includes(kind))return null;if(kind==='IDAT')seenData=true;
  offset+=12+length;++chunks;if(kind==='IEND'){if(length!==0||offset!==data.length||!seenData)return null;ended=true;break}
 }
 return ended?value:null;
}
function normalizeSnapshot(value,lookup){
 if(!value||typeof value!=='object'||!lookup)return blocked();
 if(value.decision==='blocked')return blocked(typeof value.reason==='string'&&value.reason.length<=2048?value.reason:undefined);
 if(lookup.unbound){if(value.decision!=='standard-unbound'||!revision(value.policyRevision)||!(value.consumerRootFrameId==null||validId(value.consumerRootFrameId))||lookup.consumerFrameId&&!validId(value.consumerRootFrameId))return blocked();return Object.freeze({decision:'standard',unbound:true,artifactId:null,versionId:null,checksum:null,sourceRootFrameId:null,consumerRootFrameId:value.consumerRootFrameId??null,policyRevision:value.policyRevision})}
 if(!['standard','inert-text','inert-image'].includes(value.decision))return blocked();
 if(!validId(value.artifactId)||!validId(value.versionId)||!checksumPattern.test(value.checksum??'')||!validId(value.sourceRootFrameId)||!(value.consumerRootFrameId==null||validId(value.consumerRootFrameId))||!revision(value.policyRevision))return blocked();
 if(lookup.versionId&&lookup.versionId!==value.versionId||lookup.artifactHint&&lookup.artifactHint!==value.artifactId||lookup.consumerFrameId&&!validId(value.consumerRootFrameId))return blocked();
 const snapshot={decision:value.decision,artifactId:value.artifactId,versionId:value.versionId,checksum:value.checksum,sourceRootFrameId:value.sourceRootFrameId,consumerRootFrameId:value.consumerRootFrameId??null,policyRevision:value.policyRevision};
 if(value.decision==='inert-text'){if(typeof value.text!=='string'||bytes(value.text)>MAX_TEXT)return blocked();snapshot.text=value.text}
 if(value.decision==='inert-image'){const data=raster(value.imageData);if(!data)return blocked();snapshot.imageData=data}
 return Object.freeze(snapshot);
}
async function loadPolicy(lookup,signal){
 const query=new URLSearchParams(lookup.unbound?{}:lookup.versionId?{versionId:lookup.versionId}:{artifactId:lookup.artifactId});if(lookup.consumerFrameId)query.set('consumerFrameId',lookup.consumerFrameId);
 const response=await fetch((lookup.unbound?'/api/local/resources/unbound?':'/api/local/resources/policy?')+query,{credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{accept:'application/json'}});
 if(!response.ok)throw Error('Resource policy is unavailable.');const length=response.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||Number(length)>MAX_JSON))throw Error('Resource policy is too large.');
 if(!response.body?.getReader)throw Error('Resource policy response cannot be bounded.');const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_JSON)throw Error('Resource policy is too large.');parts.push(decoder.decode(value,{stream:true}))}parts.push(decoder.decode());return JSON.parse(parts.join(''))}finally{await reader.cancel().catch(()=>{})}
}
function makeLease(snapshot){const controller=new AbortController(),lease=Object.freeze({signal:controller.signal});records.set(lease,{snapshot,controller,active:true,key:'resource:'+ ++serial+':'+JSON.stringify([snapshot.unbound===true,snapshot.artifactId,snapshot.versionId,snapshot.checksum,snapshot.sourceRootFrameId,snapshot.consumerRootFrameId,snapshot.policyRevision])});return lease}
function revoke(lease){const record=records.get(lease);if(record?.active){record.active=false;record.controller.abort()}}
export function assertNativeResourceLease(lease,expected={}){
 const record=records.get(lease);if(!record?.active||record.controller.signal.aborted||record.snapshot.decision!=='standard'||expected.artifactId&&expected.artifactId!==record.snapshot.artifactId||expected.versionId&&expected.versionId!==record.snapshot.versionId)throw Error('This native preview has no current verified standard resource binding.');return record.snapshot;
}
// Revoked identities remain usable for cleanup, never for authority.
export function nativeResourceLeaseKey(lease){const record=records.get(lease);if(!record)throw Error('Unknown native resource binding.');return record.key}
export async function nativeResourceTask(lease,producer,onAbort){
 assertNativeResourceLease(lease);let cancel;const interrupted=new Promise((_,reject)=>{cancel=()=>{try{onAbort?.()}catch{}reject(new DOMException('Resource policy changed.','AbortError'))};lease.signal.addEventListener('abort',cancel,{once:true})});
 try{const result=await Promise.race([Promise.resolve().then(()=>{assertNativeResourceLease(lease);return producer()}),interrupted]);assertNativeResourceLease(lease);return result}finally{lease.signal.removeEventListener('abort',cancel)}
}
function subscribe(callback){const off=subscribeProviderEvents(callback),events=['chimeric-confidentiality-changing','chimeric-confidentiality-changed','chimeric-resource-policy-changed'];for(const event of events)globalThis.addEventListener?.(event,callback);return()=>{off();for(const event of events)globalThis.removeEventListener?.(event,callback)}}
/** Call before committing policy changes. Later SSE is not a quiescence proof. */
export function invalidateProtectedResources(){for(const controller of [...live])controller.invalidate()}
function createController(lookup,{read=loadPolicy,onChange=()=>{},onRevoke=()=>{},schedule=setTimeout,unschedule=clearTimeout,watch=subscribe}={}){
 let state=blocked(),lease=null,request=null,generation=0,disposed=false,timer=null,unwatch;
 const stop=()=>{if(timer!==null){unschedule(timer);timer=null}request?.abort();request=null;if(lease){const old=lease;lease=null;revoke(old);try{onRevoke(old)}catch{}}};
 const publish=value=>{state=value;onChange(state,lease)};
 const invalidate=()=>{if(disposed)return;++generation;stop();publish(blocked());void refresh()};
 async function refresh(){if(disposed||!lookup)return;const turn=++generation;stop();publish(blocked());const current=new AbortController();request=current;const deadline=schedule(()=>current.abort(),10000);
  try{const value=await read(lookup,current.signal);if(disposed||turn!==generation||current.signal.aborted)return;const next=normalizeSnapshot(value,lookup);if(next.decision==='standard')lease=makeLease(next);publish(next);timer=schedule(invalidate,LEASE_MS)}catch{if(!disposed&&turn===generation)publish(blocked())}finally{unschedule(deadline);if(request===current)request=null}
 }
 const controller={getSnapshot:()=>state,getLease:()=>lease,refresh,invalidate,dispose(){if(disposed)return;disposed=true;++generation;stop();unwatch?.();live.delete(controller)}};live.add(controller);try{unwatch=watch(invalidate)}catch{controller.dispose();return controller}return controller;
}
function InertView({snapshot}){
 if(snapshot.decision==='inert-text')return jsx.jsx('pre',{'data-chimeric-resource':'inert-text',style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',overflow:'auto',maxHeight:'70vh'},children:snapshot.text});
 if(snapshot.decision==='inert-image')return jsx.jsx('img',{'data-chimeric-resource':'inert-image',src:snapshot.imageData,alt:t('Protected raster preview'),referrerPolicy:'no-referrer',style:{maxWidth:'100%',maxHeight:'70vh',objectFit:'contain'}});
 return jsx.jsx('div',{'data-chimeric-resource':'blocked',role:'status',className:'text-xs text-text-300 p-3',children:t(snapshot.reason)});
}
export function ProtectedResourceView(props){
 const lookup=lookupOf(props),key=lookupKey(lookup),onRevoke=React.useRef(props.onRevoke);onRevoke.current=props.onRevoke;const [view,setView]=React.useState({key:'',snapshot:blocked(),lease:null});
 React.useLayoutEffect(()=>{if(!lookup||props.kind==='mcp')return;const controller=createController(lookup,{onChange:(snapshot,lease)=>setView({key,snapshot,lease}),onRevoke:lease=>onRevoke.current?.(lease)});void controller.refresh();return()=>controller.dispose()},[key,props.kind]);
 if(props.kind==='mcp')return jsx.jsx(InertView,{snapshot:blocked('Interactive connector previews are unavailable until a server-owned widget binding is verified.')});
 const current=view.key===key?view:{snapshot:blocked(),lease:null};if(current.snapshot.decision==='standard'&&current.lease){try{assertNativeResourceLease(current.lease);return jsx.jsx(StandardContext.Provider,{value:current.lease,children:props.renderStandard(current.lease)})}catch{}}
 return jsx.jsx(InertView,{snapshot:current.snapshot.decision==='standard'?blocked():current.snapshot});
}
export function ProtectedMarkdown({content,renderStandard}){const lease=React.useContext(StandardContext);try{assertNativeResourceLease(lease);return renderStandard(lease)}catch{}const text=typeof content==='string'?content:'';return jsx.jsx('pre',{'data-chimeric-resource':'inert-markdown',style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:'70vh',overflow:'auto'},children:bytes(text)<=MAX_TEXT?text:t('This text is too large for a protected preview.')})}
export function StandardResourceOnly({renderStandard}){const lease=React.useContext(StandardContext);try{assertNativeResourceLease(lease);return renderStandard(lease)}catch{return jsx.jsx(InertView,{snapshot:blocked()})}}
