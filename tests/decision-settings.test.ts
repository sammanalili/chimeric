import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {providerEventsPrelude} from './provider-events-fixture';
const response=(data:any,status=200)=>({ok:status>=200&&status<300,json:async()=>data,status});
const settle=()=>new Promise<void>(done=>setTimeout(done,0));
function harness(handler:(path:string,options:any)=>any,translations:Record<string,string>={}){
 const slots:any[]=[],effects:Function[]=[],requests:any[]=[],sources:any[]=[];let cursor=0,tree:any;
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={
  useState(initial:any){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,(value:any)=>{slots[i].value=typeof value==='function'?value(slots[i].value):value}]},
  useRef(value:any){const i=cursor++;slots[i]??={current:value};return slots[i]},
  useCallback(fn:Function,deps:any[]){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn},
  useEffect(fn:Function,deps:any[]){const i=cursor++;const slot=slots[i]??={};if(!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()})}},
 };
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})},client={invalidateQueries(){}};
 const source=readFileSync(new URL('../src/decision-settings.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export function DecisionSettings','function DecisionSettings');
 const component=runInNewContext(providerEventsPrelude+'\n'+source+';DecisionSettings',{React,jsx,URL,useQueryClient:()=>client,globalThis:{ChimericI18n:{t:(s:string)=>translations[s]??s}},document:{cookie:'operon_csrf=synthetic%2Ftoken'},fetch:async(path:string,options:any)=>{requests.push({path,options});return handler(path,options)},EventSource:class{onmessage?:Function;closed=false;constructor(){sources.push(this)}close(){this.closed=true}}});
 const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const content=(node:any):string=>Array.isArray(node)?node.map(content).join(' '):node&&typeof node==='object'?content(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):'';
 const render=()=>{cursor=0;tree=component();while(effects.length)effects.shift()!();return tree};
 const all=(node:any=tree)=>walk(node),text=(node:any=tree)=>content(node);
 const find=(predicate:(node:any)=>boolean)=>{const value=all().find(predicate);if(!value)throw Error('Missing control: '+text());return value};
 const control=(id:string)=>find(node=>node.props['data-testid']===id);
 const change=(id:string,value:any)=>{const node=control(id);node.props.onChange({target:node.props.type==='checkbox'?{checked:value}:{value}});render()};
 return {requests,sources,render,all,text,find,control,change,button:(label:string)=>find(node=>node.type==='button'&&text(node)===label),
  async mount(){render();await settle();render();await settle();render()},
  async event(){sources[0].onmessage();await settle();render()},
  unmount(){slots.forEach(slot=>slot?.cleanup?.())},
 };
}
const connection=(extra:any={})=>({id:'classifier-1',connectionRevision:'synthetic-connection-1',name:'Synthetic classifier',kind:'typesafe-hosted',endpointUrl:'https://api.typesafe.ai/v1/systemone',model:'synthetic-model',format:'flat',timeoutMs:15000,enabled:true,hasCredential:true,class2Approved:false,policyEvidence:'',...extra});
const snapshot=(extra:any={})=>({revision:2,selectedId:null,connections:[connection()],...extra});

test('classifier setup keeps its model and data policy explicit and saves the full endpoint through CSRF',async()=>{
 let data=snapshot({connections:[]});
 const ui=harness((path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='POST'){const body=JSON.parse(options.body);data=snapshot({revision:3,connections:[connection({...body,hasCredential:!!body.apiKey,apiKey:undefined})]})}
  return response(data);
 });
 await ui.mount();expect(ui.control('classifier-endpoint').props.value).toBe('https://api.typesafe.ai/v1/systemone');expect(ui.control('classifier-model').props.value).toBe('');expect(ui.control('classifier-class2').props.checked).toBe(false);
 expect(ui.all(ui.control('classifier-kind')).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual(['typesafe-hosted','self-hosted-diffusion','custom-system-one']);
 ui.change('classifier-kind','self-hosted-diffusion');expect(ui.control('classifier-endpoint').props.value).toBe('');expect(ui.control('classifier-class2').props.checked).toBe(false);
 ui.change('classifier-name','Synthetic diffusion');ui.change('classifier-endpoint','https://classify.example.invalid/typesafe/v1/systemone');ui.change('classifier-model','fixture-model');ui.change('classifier-format','chat-envelope');ui.change('classifier-api-key','synthetic-key');
 expect(ui.control('classifier-api-key').props.type).toBe('password');expect(ui.control('classifier-save').props.disabled).toBe(false);await ui.control('classifier-save').props.onClick();ui.render();
 const saved=ui.requests.find(entry=>entry.options.method==='POST')!;expect(JSON.parse(saved.options.body)).toEqual({expectedRevision:2,name:'Synthetic diffusion',kind:'self-hosted-diffusion',endpointUrl:'https://classify.example.invalid/typesafe/v1/systemone',model:'fixture-model',format:'chat-envelope',enabled:true,timeoutMs:15000,class2Approved:false,policyEvidence:'',apiKey:'synthetic-key'});
 expect(saved.options.credentials).toBe('same-origin');expect(saved.options.headers['x-operon-csrf']).toBe('synthetic/token');expect(ui.requests[ui.requests.indexOf(saved)-1].path).toBe('/api/csrf');
 expect(ui.control('classifier-api-key').props.value).toBe('');expect(ui.text()).not.toContain('synthetic-key');expect(ui.text()).toContain('https://classify.example.invalid/typesafe/v1/systemone');
 expect(ui.control('classifier-default').props.value).toBe('');expect(ui.requests.some(entry=>entry.options.method==='PUT'||entry.path.endsWith('/test'))).toBe(false);expect(ui.text()).toContain('Classifiers are optional.');ui.unmount();
});

test('saved credential reuse at a changed endpoint requires confirmation, a replacement key or removal',async()=>{
 for(const mode of ['confirm','replace','remove']){
  let data=snapshot();const ui=harness((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='POST')data=snapshot({revision:3});return response(data)});await ui.mount();ui.button('Edit').props.onClick();ui.render();
  expect(ui.control('classifier-api-key').props.value).toBe('');ui.change('classifier-endpoint','https://new.example.invalid/systemone');expect(ui.control('classifier-save').props.disabled).toBe(true);
  if(mode==='confirm')ui.change('classifier-confirm-key',true);if(mode==='replace')ui.change('classifier-api-key','synthetic-new-key');if(mode==='remove')ui.change('classifier-clear-key',true);
  expect(ui.control('classifier-save').props.disabled).toBe(false);await ui.control('classifier-save').props.onClick();ui.render();
  const body=JSON.parse(ui.requests.find(entry=>entry.options.method==='POST')!.options.body);
  expect(body.confirmDestinationChange).toBe(mode==='confirm'?true:undefined);expect(body.apiKey).toBe(mode==='replace'?'synthetic-new-key':undefined);expect(body.clearCredential).toBe(mode==='remove'?true:undefined);ui.unmount();
 }
});

test('changing any approved classifier binding clears Class 2 until the user explicitly approves the new binding',async()=>{
 for(const [field,value] of [['endpoint','https://new.example.invalid/systemone'],['model','another-model'],['kind','custom-system-one'],['format','chat-envelope']]){
  const approved=connection({hasCredential:false,class2Approved:true,policyEvidence:'Synthetic approval applies to this endpoint and model.'});let data=snapshot({connections:[approved]});
  const ui=harness((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='POST')data=snapshot({revision:3,connections:[approved]});return response(data)});await ui.mount();ui.button('Edit').props.onClick();ui.render();
  expect(ui.control('classifier-class2').props.checked).toBe(true);ui.change('classifier-'+field,value);expect(ui.control('classifier-class2').props.checked).toBe(false);
  if(field==='kind'){ui.change('classifier-endpoint','https://custom.example.invalid/classify');ui.change('classifier-model','custom-fixture')}
  ui.change('classifier-class2',true);expect(ui.control('classifier-save').props.disabled).toBe(false);await ui.control('classifier-save').props.onClick();ui.render();
  const body=JSON.parse(ui.requests.find(entry=>entry.options.method==='POST')!.options.body);expect(body.class2Approved).toBe(true);expect(body.confirmPolicyChange).toBe(true);expect(body.policyEvidence).toBe(approved.policyEvidence);ui.unmount();
 }
});

test('default, synthetic test and removal use classifier-only IDs and revisioned requests; test answers render as text',async()=>{
 let data=snapshot();const message='Classifier returned a valid structured response to the synthetic test.';
 const ui=harness((path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path.endsWith('/test'))return response({ok:true,message,answers:{decision:'<img src=x onerror=alert(1)>'},model:'synthetic-model'});
  if(options.method==='PUT')data=snapshot({revision:3,selectedId:JSON.parse(options.body).selectedId});
  if(options.method==='DELETE')data=snapshot({revision:4,connections:[]});return response(data);
 });
 await ui.mount();await ui.control('classifier-default').props.onChange({target:{value:'classifier-1'}});ui.render();expect(ui.control('classifier-default').props.value).toBe('classifier-1');
 await ui.button('Test with synthetic text').props.onClick();ui.render();const tested=ui.requests.find(entry=>entry.path.endsWith('/test'))!;expect(JSON.parse(tested.options.body)).toEqual({id:'classifier-1',expectedRevision:3});expect(ui.text()).toContain(message);
 const pre=ui.find(node=>node.type==='pre');expect(pre.props.children).toContain('<img src=x onerror=alert(1)>');expect(ui.all().some(node=>node.type==='img'||node.props.dangerouslySetInnerHTML)).toBe(false);
 ui.button('Remove classifier').props.onClick();ui.render();expect(ui.requests.some(entry=>entry.options.method==='DELETE')).toBe(false);await ui.control('classifier-confirm-remove').props.onClick();ui.render();
 const removed=ui.requests.find(entry=>entry.options.method==='DELETE')!;expect(JSON.parse(removed.options.body)).toEqual({expectedRevision:3,id:'classifier-1'});expect(ui.text()).toContain('No classifier connections configured.');
 expect(ui.requests.some(entry=>entry.path.includes('/api/models'))).toBe(false);for(const entry of ui.requests.filter(entry=>['POST','PUT','DELETE'].includes(entry.options.method)))expect(entry.options.headers['x-operon-csrf']).toBe('synthetic/token');ui.unmount();expect(ui.sources[0].closed).toBe(true);
});

test('live classifier snapshots preserve drafts and their original revision when a concurrent change makes save stale',async()=>{
 let data=snapshot();const ui=harness((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='POST')return response({detail:'Classifier settings changed. Reload before saving.'},409);return response(data)});
 await ui.mount();ui.button('Edit').props.onClick();ui.render();ui.change('classifier-model','unsaved-model');
 data=snapshot({revision:3,connections:[connection({model:'external-model'})]});await ui.event();expect(ui.control('classifier-model').props.value).toBe('unsaved-model');
 await ui.control('classifier-save').props.onClick();ui.render();expect(JSON.parse(ui.requests.find(entry=>entry.options.method==='POST')!.options.body).expectedRevision).toBe(2);expect(ui.control('classifier-model').props.value).toBe('unsaved-model');expect(ui.render().props['data-chimeric-dirty']).toBe('true');expect(ui.text()).toContain('Reload before saving.');ui.unmount();
});

test('Class 2 requires evidence and valid endpoint/timeout, while Japanese copy states the limits of recorded approval',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 const ui=harness(()=>response(snapshot({connections:[]})),translations);await ui.mount();ui.change('classifier-name','テスト');ui.change('classifier-model','fixture');ui.change('classifier-class2',true);expect(ui.control('classifier-save').props.disabled).toBe(true);
 ui.change('classifier-policy-evidence','テスト用の承認記録');expect(ui.control('classifier-save').props.disabled).toBe(false);ui.change('classifier-timeout','999');expect(ui.control('classifier-save').props.disabled).toBe(true);ui.change('classifier-timeout','15000');ui.change('classifier-endpoint','not-a-url');expect(ui.control('classifier-save').props.disabled).toBe(true);
 expect(ui.text()).toContain('分類器');expect(ui.text()).toContain('利用方針の出典または承認の根拠');expect(ui.text()).toContain('データの隔離を保証するものではありません');expect(ui.requests.some(entry=>entry.options.method==='POST')).toBe(false);ui.unmount();
});

test('editing a disabled classifier preserves its disabled state and mutually excludes key replacement and removal',async()=>{
 const data=snapshot({connections:[connection({enabled:false})]});const ui=harness(()=>response(data));await ui.mount();ui.button('Edit').props.onClick();ui.render();
 ui.change('classifier-name','Renamed fixture');ui.change('classifier-api-key','synthetic-new-key');ui.change('classifier-clear-key',true);expect(ui.control('classifier-api-key').props.value).toBe('');
 ui.change('classifier-api-key','synthetic-new-key');expect(ui.control('classifier-clear-key').props.checked).toBe(false);
 await ui.control('classifier-save').props.onClick();ui.render();const body=JSON.parse(ui.requests.find(entry=>entry.options.method==='POST')!.options.body);
 expect(body.enabled).toBe(false);expect(body.apiKey).toBe('synthetic-new-key');expect(body.clearCredential).toBeUndefined();ui.unmount();
});

test('classifier endpoint validation matches the manager destination policy',async()=>{
 const ui=harness(()=>response(snapshot({connections:[]})));await ui.mount();ui.change('classifier-name','Fixture');ui.change('classifier-model','fixture');
 for(const endpoint of ['http://remote.example.invalid/systemone','https://user:password@example.invalid/systemone','https://example.invalid/systemone?key=synthetic','https://example.invalid/systemone#part','ftp://localhost/systemone']){ui.change('classifier-endpoint',endpoint);expect(ui.control('classifier-save').props.disabled).toBe(true)}
 for(const endpoint of ['https://remote.example.invalid/systemone','http://localhost:9876/systemone','http://127.0.0.1:9876/systemone','http://[::1]:9876/systemone']){ui.change('classifier-endpoint',endpoint);expect(ui.control('classifier-save').props.disabled).toBe(false)}
 ui.unmount();
});

test('turning off the default sends null, and changed connections discard the previous detailed test result',async()=>{
 let data=snapshot({selectedId:'classifier-1'});
 const ui=harness((path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path.endsWith('/test'))return response({ok:true,message:'Synthetic fixture response.',answers:{greeting:'greeting'}});
  if(options.method==='PUT')data=snapshot({revision:3,selectedId:JSON.parse(options.body).selectedId});return response(data);
 });
 await ui.mount();await ui.button('Test with synthetic text').props.onClick();ui.render();expect(ui.text()).toContain('Synthetic fixture response.');
 await ui.control('classifier-default').props.onChange({target:{value:''}});ui.render();expect(JSON.parse(ui.requests.find(entry=>entry.options.method==='PUT')!.options.body)).toEqual({expectedRevision:2,selectedId:null});expect(ui.text()).toContain('Synthetic fixture response.');
 data=snapshot({revision:4,connections:[connection({connectionRevision:'synthetic-connection-2'})]});await ui.event();expect(ui.text()).not.toContain('Synthetic fixture response.');expect(ui.all().some(node=>node.type==='pre')).toBe(false);ui.unmount();
});
