import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {providerEventsPrelude} from './provider-events-fixture';

type Node={type:string;props:any};
const response=(data:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
const defer=()=>{let resolve!:(value:any)=>void;const promise=new Promise<any>(done=>resolve=done);return {promise,resolve}};
const settle=()=>new Promise<void>(done=>setTimeout(done,0));
function harness(file:string,name:string,handler:(path:string,options:any)=>any,translations:Record<string,string>={},shared:any={},props:any=undefined){
 const slots:any[]=[],effects:Function[]=[],timers=new Map<number,Function>(),requests:Array<{path:string;options:any}>=[],sources:any[]=[];
 let index=0,timerId=0,tree:Node,invalidations=0;
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((value,i)=>Object.is(value,b[i]));
 const React={
  useState(initial:any){const i=index++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,(value:any)=>{slots[i].value=typeof value==='function'?value(slots[i].value):value}]},
  useRef(value:any){const i=index++;slots[i]??={current:value};return slots[i]},
  useCallback(fn:Function,deps:any[]){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn,deps};return slots[i].value},
  useEffect(fn:Function,deps:any[]){const i=index++;const slot=slots[i]??={};if(!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()})}},
 };
 const jsx={jsx:(type:string,props:any)=>({type,props}),jsxs:(type:string,props:any)=>({type,props})};
 const client={invalidateQueries:()=>{invalidations++}};
 const source=readFileSync(new URL('../src/'+file,import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace(/\bexport function /g,'function ');
 const component=runInNewContext(providerEventsPrelude+'\n'+source+';'+name,{
  React,jsx,ConnectionEligibility:'ConnectionEligibility',useQueryClient:()=>client,document:{cookie:'operon_csrf=token%2Fone'},globalThis:{...shared,ChimericI18n:{t:(value:string)=>translations[value]??value}},
  fetch:async(path:string,options:any)=>{requests.push({path,options});return handler(path,options)},
  EventSource:class{onmessage?:Function;closed=false;constructor(readonly url:string){sources.push(this)}close(){this.closed=true}},
  setTimeout:(fn:Function)=>{timers.set(++timerId,fn);return timerId},clearTimeout:(id:number)=>timers.delete(id),
 });
 const render=()=>{index=0;tree=component(props);while(effects.length)effects.shift()!();return tree};
 const walk=(node:any):Node[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const content=(node:any):string=>Array.isArray(node)?node.map(content).join(' '):node&&typeof node==='object'?content(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):'';
 const all=(node:any=tree)=>walk(node),text=(node:any=tree)=>content(node);
 const find=(predicate:(node:Node)=>boolean)=>{const node=all().find(predicate);if(!node)throw Error('Control not found in '+text());return node};
 return {render,all,text,requests,sources,find,get invalidations(){return invalidations},
  button:(label:string)=>find(node=>node.type==='button'&&text(node)===label),
  control:(id:string)=>find(node=>node.props['data-testid']===id),
  async mount(){render();await settle();render();await settle();render()},
  async poll(){const callbacks=[...timers.values()];timers.clear();callbacks.forEach(fn=>fn());await settle();render()},
  unmount(){slots.forEach(slot=>slot?.cleanup?.())},
 };
}
const agy=(extra:any={})=>({connected:false,executable:'/official/agy',version:'1.5.1',authState:'idle',authMethods:[],operation:false,allowSharedCustomizations:false,executionWarning:null,modelDiscovery:{state:'idle',count:0},...extra});
const subscriptionMessage='Uses your ChatGPT subscription limits. API billing is never used as a fallback.';
const images=(extra:any={})=>({revision:1,selected:null,providers:[{id:'openai',name:'My OpenAI',ready:true,billing:'api'},{id:'openai-codex',name:'ChatGPT subscription',ready:true,billing:'subscription'}],imageModels:[{id:'image-model',name:'Image model',billing:'api'},{id:'gpt-image-2',name:'GPT Image 2',billing:'subscription'}],subscription:{available:true,status:'available',message:subscriptionMessage},...extra});
const agyImageMessage='Uses your Google AI subscription limits. API billing is never used as a fallback.';
const imagesWithAgy=(extra:any={})=>images({
 providers:[{id:'openai',name:'My OpenAI',ready:true,billing:'api',kind:'openai-api'},{id:'openai-codex',name:'ChatGPT subscription',ready:true,billing:'subscription',kind:'chatgpt'},{id:'antigravity-http',name:'Antigravity subscription',ready:true,billing:'subscription',kind:'antigravity',message:agyImageMessage}],
 imageModels:[{id:'image-model',name:'Image model',billing:'api',kind:'openai-api'},{id:'gpt-image-2',name:'GPT Image 2',billing:'subscription',kind:'chatgpt'},{id:'gemini-image-other',name:'Other Gemini image model',billing:'subscription',kind:'antigravity'},{id:'gemini-3.1-flash-image',name:'Gemini 3.1 Flash Image',billing:'subscription',kind:'antigravity',default:true}],...extra,
});

test('image generation starts off and sends only the explicit API selection with its revision and CSRF token',async()=>{
 let status=images();
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='PUT'){const body=JSON.parse(options.body);status=images({revision:status.revision+1,selected:body.connectionId?{connectionId:body.connectionId,imageModel:body.imageModel}:null})}
  return response(status);
 });
 await ui.mount();expect(ui.control('image-generation-connection').props.value).toBe('');expect(ui.button('Save image generation').props.disabled).toBe(true);
 expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);expect(ui.text()).toContain('plan’s image generation');expect(ui.text()).toContain('API billing');
 ui.control('image-generation-connection').props.onChange({target:{value:'openai'}});ui.render();
 expect(ui.control('image-generation-model').props.value).toBe('image-model');await ui.button('Save image generation').props.onClick();ui.render();
 let mutation=ui.requests.find(entry=>entry.options.method==='PUT')!;
 expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:1,connectionId:'openai',imageModel:'image-model'});expect(mutation.options.headers['x-operon-csrf']).toBe('token/one');
 expect(ui.requests[ui.requests.indexOf(mutation)-1].path).toBe('/api/csrf');expect(ui.text()).toContain('Image generation connection configured.');
 ui.control('image-generation-connection').props.onChange({target:{value:''}});ui.render();await ui.button('Save image generation').props.onClick();ui.render();
 mutation=ui.requests.filter(entry=>entry.options.method==='PUT').at(-1)!;expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:2,connectionId:null});expect(ui.text()).toContain('Image generation is off.');
 ui.unmount();expect(ui.sources[0].closed).toBe(true);
});

test('removed image connections stay unavailable and stale revisions cannot silently select another billable provider',async()=>{
 const selected={connectionId:'deleted',imageModel:'retired-model'};let status=images({revision:5,selected});
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(status));
 await ui.mount();expect(ui.control('image-generation-connection').props.value).toBe('deleted');expect(ui.text()).toContain('saved image generation connection is unavailable');
 expect(ui.button('Save image generation').props.disabled).toBe(true);expect(ui.text()).toContain('Saved connection unavailable');
 status=images({revision:4,selected:{connectionId:'openai',imageModel:'image-model'}});ui.sources[0].onmessage();await settle();ui.render();
 expect(ui.control('image-generation-connection').props.value).toBe('deleted');expect(ui.control('image-generation-model').props.value).toBe('retired-model');
 ui.control('image-generation-connection').props.onChange({target:{value:''}});ui.render();expect(ui.button('Save image generation').props.disabled).toBe(false);ui.unmount();
});

test('image settings preserve an edit and its original revision after a concurrent update, then surface a save conflict',async()=>{
 let status=images();
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='PUT')return response({detail:'Settings changed. Cancel and try again.'},409);
  return response(status);
 });
 await ui.mount();ui.control('image-generation-connection').props.onChange({target:{value:'openai'}});ui.render();
 status=images({revision:2});ui.sources[0].onmessage();await settle();ui.render();
 expect(ui.control('image-generation-connection').props.value).toBe('openai');await ui.button('Save image generation').props.onClick();ui.render();
 expect(JSON.parse(ui.requests.find(entry=>entry.options.method==='PUT')!.options.body).expectedRevision).toBe(1);
 expect(ui.all().some(node=>node.props.role==='alert'&&ui.text(node)==='Settings changed. Cancel and try again.')).toBe(true);
 expect(ui.render().props['data-chimeric-dirty']).toBe('true');ui.button('Cancel').props.onClick();ui.render();expect(ui.control('image-generation-connection').props.value).toBe('');ui.unmount();
});

test('both native connection components render their Japanese setup and billing copy',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 const agyUi=harness('antigravity-settings.js','AntigravityConnection',()=>response(agyHttp()),translations);await agyUi.mount();agyUi.button('Google Antigravity').props.onClick();agyUi.render();
 expect(agyUi.text()).toContain('クライアントを確認');expect(agyUi.text()).toContain('直接接続');agyUi.unmount();
 const imageUi=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(images()),translations);await imageUi.mount();
 expect(imageUi.text()).toContain('画像生成');expect(imageUi.text()).toContain('API 料金');expect(imageUi.text()).toContain('ChatGPT プランの利用枠');imageUi.unmount();
});

test('ChatGPT subscription image settings choose the subscription model and persist that exact connection without API fallback',async()=>{
 let status=images();
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);status=images({revision:status.revision+1,selected:{connectionId:body.connectionId,imageModel:body.imageModel}});
  }
  return response(status);
 });
 await ui.mount();expect(ui.control('image-generation-connection').props.value).toBe('');expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
 const option=ui.all(ui.control('image-generation-connection')).find(node=>node.type==='option'&&node.props.value==='openai-codex')!;
 expect(ui.text(option)).toBe('ChatGPT subscription · ChatGPT plan limits');expect(option.props.disabled).toBe(false);
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();
 expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');
 expect(ui.all(ui.control('image-generation-model')).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual(['gpt-image-2']);
 expect(ui.text()).toContain(subscriptionMessage);expect(ui.text()).not.toContain('Selecting an API connection uses');
 await ui.button('Save image generation').props.onClick();ui.render();
 const mutations=ui.requests.filter(entry=>entry.options.method==='PUT');expect(mutations).toHaveLength(1);
 expect(JSON.parse(mutations[0].options.body)).toEqual({expectedRevision:1,connectionId:'openai-codex',imageModel:'gpt-image-2'});
 expect(mutations[0].options.headers['x-operon-csrf']).toBe('token/one');expect(mutations[0].options.credentials).toBe('same-origin');
 expect(ui.control('image-generation-connection').props.value).toBe('openai-codex');expect(ui.text()).toContain('Image generation connection configured.');ui.unmount();
});

test('image model choices follow the explicitly chosen billing connection',async()=>{
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(images()));await ui.mount();
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');
 ui.control('image-generation-connection').props.onChange({target:{value:'openai'}});ui.render();
 expect(ui.control('image-generation-model').props.value).toBe('image-model');
 expect(ui.all(ui.control('image-generation-model')).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual(['image-model']);
 expect(ui.text()).toContain('Selecting an API connection uses');expect(ui.text()).not.toContain(subscriptionMessage);
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');
 expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);ui.unmount();
});

test('a disconnected saved subscription retains its image selection while an API connection remains available',async()=>{
 const selected={connectionId:'openai-codex',imageModel:'gpt-image-2'};
 const providers=images().providers.map(value=>value.billing==='subscription'?{...value,ready:false,reason:'Reconnect ChatGPT.'}:value);
 let status=images({revision:2,selected,providers,subscription:{available:false,status:'disconnected',message:subscriptionMessage}});
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(status));await ui.mount();
 expect(ui.control('image-generation-connection').props.value).toBe('openai-codex');expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');
 expect(ui.text()).toContain('saved image generation connection is unavailable');expect(ui.text()).toContain('Sign in with ChatGPT above');expect(ui.text()).toContain('Reconnect ChatGPT.');
 expect(ui.button('Save image generation').props.disabled).toBe(true);
 const subscription=ui.all(ui.control('image-generation-connection')).find(node=>node.type==='option'&&node.props.value==='openai-codex')!;
 expect(subscription.props.disabled).toBe(true);expect(ui.text(subscription)).toBe('ChatGPT subscription · ChatGPT plan limits · Unavailable');
 expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
 status=images({revision:3,selected});ui.sources[0].onmessage();await settle();ui.render();
 expect(ui.control('image-generation-connection').props.value).toBe('openai-codex');expect(ui.text()).toContain('Image generation connection configured.');
 expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);ui.unmount();
});

test('a saved subscription paired with an API model stays unavailable until the user repairs it',async()=>{
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(images({selected:{connectionId:'openai-codex',imageModel:'image-model'}})));await ui.mount();
 expect(ui.text()).toContain('saved image generation connection is unavailable');expect(ui.control('image-generation-model').props.value).toBe('image-model');
 const stale=ui.all(ui.control('image-generation-model')).find(node=>node.type==='option'&&node.props.value==='image-model')!;expect(stale.props.disabled).toBe(true);
 expect(ui.button('Save image generation').props.disabled).toBe(true);expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');expect(ui.button('Save image generation').props.disabled).toBe(false);ui.unmount();
});

test('Japanese subscription image settings identify plan limits and explain that API billing will never replace them',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(images({selected:{connectionId:'openai-codex',imageModel:'gpt-image-2'}})),translations);await ui.mount();
 expect(ui.text()).toContain('ChatGPT サブスクリプション');expect(ui.text()).toContain('ChatGPT プランの利用枠');expect(ui.text()).toContain('ChatGPT サブスクリプションの利用枠を使います。');expect(ui.text()).toContain('API 課金に自動で切り替わることはありません。');ui.unmount();
});

test('Antigravity image settings choose the advertised image default and save its exact subscription connection',async()=>{
 const base=imagesWithAgy();
 let status=imagesWithAgy({providers:base.providers.map(provider=>provider.kind==='chatgpt'?{...provider,ready:false}:provider),subscription:{available:false,status:'disconnected',message:subscriptionMessage}});
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);status={...status,revision:status.revision+1,selected:{connectionId:body.connectionId,imageModel:body.imageModel}};
  }
  return response(status);
 });
 await ui.mount();expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
 const option=ui.all(ui.control('image-generation-connection')).find(node=>node.type==='option'&&node.props.value==='antigravity-http')!;
 expect(ui.text(option)).toBe('Antigravity subscription · Google AI plan limits');expect(option.props.disabled).toBe(false);
 ui.control('image-generation-connection').props.onChange({target:{value:'antigravity-http'}});ui.render();
 expect(ui.control('image-generation-model').props.value).toBe('gemini-3.1-flash-image');
 expect(ui.all(ui.control('image-generation-model')).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual(['gemini-image-other','gemini-3.1-flash-image']);
 expect(ui.text()).toContain(agyImageMessage);expect(ui.text()).not.toContain(subscriptionMessage);
 expect(ui.text()).not.toContain('Sign in with ChatGPT above');expect(ui.button('Save image generation').props.disabled).toBe(false);
 await ui.button('Save image generation').props.onClick();ui.render();
 const mutation=ui.requests.find(entry=>entry.options.method==='PUT')!;
 expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:1,connectionId:'antigravity-http',imageModel:'gemini-3.1-flash-image'});
 expect(mutation.options.headers['x-operon-csrf']).toBe('token/one');expect(mutation.options.credentials).toBe('same-origin');
 expect(ui.text()).toContain('Image generation connection configured.');
 expect(ui.text()).toContain('Ask the research agent to generate an image.');
 expect(ui.text()).toContain('this session’s Files.');ui.unmount();
});

test('Antigravity and ChatGPT image choices stay separate even though both use subscription billing',async()=>{
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(imagesWithAgy()));await ui.mount();
 const options=()=>ui.all(ui.control('image-generation-model')).filter(node=>node.type==='option').map(node=>node.props.value);
 ui.control('image-generation-connection').props.onChange({target:{value:'antigravity-http'}});ui.render();
 expect(options()).toEqual(['gemini-image-other','gemini-3.1-flash-image']);expect(ui.control('image-generation-model').props.value).toBe('gemini-3.1-flash-image');
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();
 expect(options()).toEqual(['gpt-image-2']);expect(ui.control('image-generation-model').props.value).toBe('gpt-image-2');
 expect(ui.text()).toContain(subscriptionMessage);expect(ui.text()).not.toContain(agyImageMessage);
 ui.control('image-generation-connection').props.onChange({target:{value:'openai'}});ui.render();
 expect(options()).toEqual(['image-model']);expect(ui.control('image-generation-model').props.value).toBe('image-model');
 expect(ui.text()).toContain('Selecting an API connection uses');expect(ui.text()).not.toContain(agyImageMessage);
 expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);ui.unmount();
});

test('saved image selections from another subscription kind stay unavailable until explicitly repaired',async()=>{
 for(const [connectionId,imageModel,repaired] of [['antigravity-http','gpt-image-2','gemini-3.1-flash-image'],['openai-codex','gemini-3.1-flash-image','gpt-image-2']]){
  const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(imagesWithAgy({selected:{connectionId,imageModel}})));await ui.mount();
  expect(ui.text()).toContain('saved image generation connection is unavailable');expect(ui.button('Save image generation').props.disabled).toBe(true);
  const stale=ui.all(ui.control('image-generation-model')).find(node=>node.type==='option'&&node.props.value===imageModel)!;
  expect(stale.props.disabled).toBe(true);expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
  ui.control('image-generation-connection').props.onChange({target:{value:connectionId}});ui.render();
  expect(ui.control('image-generation-model').props.value).toBe(repaired);expect(ui.button('Save image generation').props.disabled).toBe(false);ui.unmount();
 }
});

test('legacy ChatGPT provider metadata does not expose typed Antigravity image models',async()=>{
 const status=images();status.imageModels.push({id:'gemini-3.1-flash-image',name:'Gemini 3.1 Flash Image',billing:'subscription',kind:'antigravity'} as any);
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(status));await ui.mount();
 ui.control('image-generation-connection').props.onChange({target:{value:'openai-codex'}});ui.render();
 expect(ui.all(ui.control('image-generation-model')).filter(node=>node.type==='option').map(node=>node.props.value)).toEqual(['gpt-image-2']);ui.unmount();
});

test('Japanese Antigravity image settings show Google plan limits and the image invocation guidance',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 const base=imagesWithAgy();
 const status=imagesWithAgy({selected:{connectionId:'antigravity-http',imageModel:'gemini-3.1-flash-image'},providers:base.providers.map(provider=>provider.kind==='chatgpt'?{...provider,ready:false}:provider),subscription:{available:false,status:'disconnected',message:subscriptionMessage}});
 const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(status),translations);await ui.mount();
 expect(ui.text()).toContain('画像生成の接続先');expect(ui.text()).toContain('Antigravity サブスクリプション');expect(ui.text()).toContain('Google AI プランの利用枠');
 expect(ui.text()).toContain('Google AI サブスクリプションの利用枠を使います。');expect(ui.text()).toContain('API 課金に自動で切り替わることはありません。');
 expect(ui.text()).toContain('研究エージェントに画像の生成を依頼してください。');expect(ui.text()).toContain('このセッションの「ファイル」に表示されます。');
 expect(ui.text()).not.toContain('ChatGPT にログイン');ui.unmount();
});

test('Japanese Antigravity image settings translate the backend quota and connection-readiness messages',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 for(const [reason,expected] of [
  ['Sign in with Antigravity before generating images with your subscription.','先に Antigravity にログインしてください。'],
  ['Refresh Antigravity models before generating images with your subscription.','先に Antigravity のモデル一覧を更新してください。'],
 ]){
  const base=imagesWithAgy();
  const providers=base.providers.map(provider=>provider.kind==='antigravity'?{...provider,ready:false,reason,message:'Uses your Antigravity subscription limits. API billing is never used as a fallback.'}:provider);
  const status=imagesWithAgy({selected:{connectionId:'antigravity-http',imageModel:'gemini-3.1-flash-image'},providers,subscription:{available:false,status:'disconnected',message:subscriptionMessage}});
  const ui=harness('image-generation-settings.js','ImageGenerationSettings',()=>response(status),translations);await ui.mount();
  expect(ui.text()).toContain('Antigravity サブスクリプションの利用枠を使います。');expect(ui.text()).toContain(expected);
  expect(ui.text()).not.toContain('ChatGPT にログイン');expect(ui.button('画像生成の設定を保存').props.disabled).toBe(true);ui.unmount();
 }
});

test('managed CLI connections expose model preferences without editable HTTP connection cards',async()=>{
 const managedId='antigravity::gemini-4-argon';
 const normal={id:'api',name:'My API',baseUrl:'https://api.example.com/v1',api:'openai-completions',managed:false,connectionRevision:1,requestTimeoutMs:600000,status:{ready:true},models:[{id:'chat',qualifiedId:'api::chat',name:'API Chat',mode:'chat',input:['text'],available:true,selectorEligible:true}]};
 const managed={id:'antigravity',name:'Antigravity',api:'antigravity-cli',managed:true,baseUrl:'https://antigravity.local.invalid',connectionRevision:1,status:{ready:true},models:[{id:'gemini-4-argon',qualifiedId:managedId,name:'Gemini 4 Argon',mode:'chat',input:['text'],available:true,selectorEligible:true}]};
 let data:any={revision:1,connections:[normal,managed],roles:{},headlineModels:[],hiddenModels:[],selectedModel:'api::chat',probeJobs:[]};
 const ui=harness('provider-settings.js','ModelConnections',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path==='/api/models/selection'&&options.method==='PUT'){data={...data,selectedModel:JSON.parse(options.body).model};return response({})}
  if(path==='/api/local/connections/settings'&&options.method==='PUT'){const body=JSON.parse(options.body);data={...data,revision:data.revision+1,roles:body.roles,headlineModels:body.headlineModels,hiddenModels:body.hiddenModels??data.hiddenModels};return response({})}
  return response(data);
 });
 await ui.mount();
 expect(ui.text()).not.toContain('antigravity.local.invalid');
 expect(ui.all().filter(node=>node.type==='button'&&ui.text(node)==='Edit')).toHaveLength(1);
 expect(ui.all().filter(node=>node.type==='button'&&ui.text(node)==='Remove connection')).toHaveLength(1);
 const preferences=ui.control('managed-model-preferences');expect(ui.text(preferences)).toContain('Antigravity · Gemini 4 Argon');
 expect(ui.text(preferences)).not.toContain('Edit');expect(ui.text(preferences)).not.toContain('Refresh models');expect(ui.text(preferences)).not.toContain('Probe');
 const pin=ui.all(preferences).find(node=>node.type==='button'&&ui.text(node)==='Pin')!;expect(pin.props.disabled).toBe(false);await pin.props.onClick();ui.render();
 const headline=ui.requests.find(entry=>entry.path==='/api/local/connections/settings'&&entry.options.method==='PUT')!;
 expect(JSON.parse(headline.options.body)).toEqual({expectedRevision:1,roles:{},headlineModels:[managedId],hiddenModels:[]});
 const visibility=()=>ui.all(ui.control('managed-model-preferences')).find(node=>node.type==='input'&&node.props['data-testid']==='model-selector-visibility')!;
 expect(visibility().props.checked).toBe(true);expect(visibility().props.disabled).toBe(false);
 await visibility().props.onChange({target:{checked:false}});ui.render();
 const hide=ui.requests.filter(entry=>entry.path==='/api/local/connections/settings'&&entry.options.method==='PUT').at(-1)!;
 expect(JSON.parse(hide.options.body)).toEqual({expectedRevision:2,roles:{},headlineModels:[],hiddenModels:[managedId]});
 expect(visibility().props.checked).toBe(false);expect(data.headlineModels).toEqual([]);
 const repin=ui.all(ui.control('managed-model-preferences')).find(node=>node.type==='button'&&ui.text(node)==='Pin')!;expect(repin.props.disabled).toBe(false);await repin.props.onClick();ui.render();
 const show=ui.requests.filter(entry=>entry.path==='/api/local/connections/settings'&&entry.options.method==='PUT').at(-1)!;
 expect(JSON.parse(show.options.body)).toEqual({expectedRevision:3,roles:{},headlineModels:[managedId],hiddenModels:[]});
 expect(visibility().props.checked).toBe(true);expect(data.hiddenModels).toEqual([]);
 const roles=ui.all().filter(node=>node.type==='select'&&ui.all(node).some(option=>option.type==='option'&&option.props.value===managedId));expect(roles).toHaveLength(3);
 roles[0].props.onChange({target:{value:managedId}});ui.render();await ui.button('Save background models').props.onClick();ui.render();
 const settings=ui.requests.filter(entry=>entry.path==='/api/local/connections/settings'&&entry.options.method==='PUT').at(-1)!;
 expect(JSON.parse(settings.options.body)).toEqual({expectedRevision:4,roles:{small:managedId},headlineModels:[managedId]});
 const defaults=ui.all(ui.control('managed-model-preferences')).find(node=>node.type==='button'&&ui.text(node)==='Use as default')!;await defaults.props.onClick();ui.render();
 const selection=ui.requests.find(entry=>entry.path==='/api/models/selection')!;expect(JSON.parse(selection.options.body)).toEqual({model:managedId});
 expect(ui.all(ui.control('managed-model-preferences')).some(node=>node.type==='button'&&ui.text(node)==='Default'&&node.props.disabled)).toBe(true);
 expect(ui.text()).not.toContain('antigravity.local.invalid');
 for(const entry of [headline,hide,show,settings,selection])expect(entry.options.headers['x-operon-csrf']).toBe('token/one');
 ui.unmount();
});

test('a managed-only registry keeps the CLI marker and connection editing out of the rendered settings',async()=>{
 const model={id:'opus-5-5',qualifiedId:'antigravity::opus-5-5',name:'Claude Opus 5.5',mode:'chat',input:['text'],available:true,selectorEligible:true};
 const data={revision:1,connections:[{id:'antigravity',name:'Antigravity',api:'antigravity-cli',managed:true,baseUrl:'https://antigravity.local.invalid',models:[model]}],roles:{},headlineModels:[model.qualifiedId],selectedModel:model.qualifiedId,probeJobs:[]};
 const ui=harness('provider-settings.js','ModelConnections',()=>response(data));await ui.mount();
 expect(ui.text()).not.toContain('antigravity.local.invalid');expect(ui.all().some(node=>node.type==='button'&&['Edit','Remove connection','Probe image input','Probe all chat models'].includes(ui.text(node)))).toBe(false);
 expect(ui.all(ui.control('managed-model-preferences')).some(node=>node.type==='button'&&ui.text(node)==='Unpin')).toBe(true);
 expect(ui.all().filter(node=>node.type==='option'&&node.props.value===model.qualifiedId)).toHaveLength(3);ui.unmount();
});

test('each API connection mounts its own Class 2 permission control without duplicating subscription or managed cards',async()=>{
 const api=(id:string)=>({id,name:'Synthetic '+id,api:'openai-completions',baseUrl:'https://'+id+'.example.invalid/v1',models:[{id:'chat',qualifiedId:id+'::chat',name:'Synthetic chat',mode:'chat',input:['text'],selectorEligible:true}],status:{ready:true},hasCredential:true});
 const data={revision:1,connections:[api('api-one'),{...api('api-two'),api:'anthropic-messages'},{...api('managed'),managed:true,api:'claude-code'},{...api('subscription'),subscription:true}],roles:{},headlineModels:[],selectedModel:'api-one::chat',probeJobs:[]};
 const ui=harness('provider-settings.js','ModelConnections',()=>response(data));await ui.mount();
 const controls=ui.all().filter(node=>node.type==='ConnectionEligibility');expect(controls.map(node=>node.props.connectionId)).toEqual(['api-one','api-two']);
 for(const node of controls){const card=ui.all().find(card=>card.type==='details'&&ui.all(card).includes(node))!;expect(ui.text(card)).toContain('Synthetic '+node.props.connectionId)}
 expect(ui.requests.every(entry=>!entry.options.method||entry.options.method==='GET')).toBe(true);ui.unmount();
});

const agyHttp=(extra:any={})=>({connected:false,reauthRequired:false,oauthConfigured:false,email:null,project:null,expiresAt:null,tier:'free',paidTier:null,modelDiscovery:{state:'idle',count:0},models:[],prerequisite:{installed:true,compatible:true,signedIn:true},experimental:{enabled:false,transport:'direct'},...extra});
const connectionList=()=>({revision:1,connections:[],roles:{},headlineModels:[],selectedModel:'',probeJobs:[]});
const connectionsAnd=(status:()=>any)=>(path:string,options:any)=>{
 if(path==='/api/csrf')return response({});
 if(path==='/api/local/antigravity-http')return response(status());
 if(path==='/api/local/connections')return response(connectionList());
 return response({});
};

test('Google collapses to its name and warning icon, and its caution opens on hover, focus and tap',async()=>{
 const ui=harness('antigravity-settings.js','AntigravityConnection',connectionsAnd(()=>agyHttp()));await ui.mount();
 expect(ui.text().trim()).toBe('Google Antigravity');expect(ui.text()).not.toContain('Experimental');
 expect(ui.all().some(node=>node.props.id==='google-antigravity-controls')).toBe(false);
 const warning=ui.control('antigravity-warning');warning.props.onFocus();ui.render();expect(ui.find(node=>node.props.role==='tooltip').props.children).toContain('Google may change access');
 ui.control('antigravity-warning').props.onClick();ui.render();expect(ui.all().some(node=>node.props.role==='tooltip')).toBe(true);
 ui.control('antigravity-warning').props.onKeyDown({key:'Escape'});ui.render();expect(ui.all().some(node=>node.props.role==='tooltip')).toBe(false);
 ui.control('antigravity-warning').props.onBlur();ui.render();
 const wrapper=ui.find(node=>node.props.onMouseEnter&&node.props.onMouseLeave);wrapper.props.onMouseEnter();ui.render();expect(ui.all().some(node=>node.props.role==='tooltip')).toBe(true);wrapper.props.onMouseLeave();ui.render();expect(ui.all().some(node=>node.props.role==='tooltip')).toBe(false);
 ui.control('antigravity-warning').props.onClick();ui.render();expect(ui.all().some(node=>node.props.role==='tooltip')).toBe(true);ui.unmount();
});

test('Google requires installed compatible signed-in client evidence and enables Direct only through explicit configuration',async()=>{
 let status=agyHttp({prerequisite:{installed:false,compatible:false,signedIn:false}});
 const ui=harness('antigravity-settings.js','AntigravityConnection',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='POST'){const body=JSON.parse(options.body);if(body.action==='check-client')status=agyHttp();if(body.action==='configure')status=agyHttp({experimental:{enabled:body.enabled,transport:body.transport}})}
  return response(status);
 });await ui.mount();ui.button('Google Antigravity').props.onClick();ui.render();
 expect(ui.control('antigravity-enabled').props.checked).toBe(false);expect(ui.control('antigravity-enabled').props.disabled).toBe(true);expect(ui.control('antigravity-transport').props.value).toBe('direct');
 expect(ui.requests.some(entry=>entry.options.method==='POST')).toBe(false);await ui.button('Check client').props.onClick();ui.render();expect(ui.control('antigravity-enabled').props.disabled).toBe(false);
 await ui.control('antigravity-enabled').props.onChange({target:{checked:true}});ui.render();expect(ui.control('antigravity-enabled').props.checked).toBe(true);
 const actions=ui.requests.filter(entry=>entry.options.method==='POST');expect(actions.map(entry=>JSON.parse(entry.options.body))).toEqual([{action:'check-client'},{action:'configure',enabled:true,transport:'direct'}]);expect(actions[1].options.headers['x-operon-csrf']).toBe('token/one');ui.unmount();
});

test('Anthropic stays unavailable when its backend route is absent, then reports only verified connected status',async()=>{
 const absent=harness('provider-settings.js','AnthropicCredentials',()=>response({detail:'Not found'},404));await absent.mount();expect(absent.text()).toContain('Claude Code connection is not available in this build.');expect(absent.button('Connect').props.disabled).toBe(true);expect(absent.requests.some(entry=>entry.options.method==='POST')).toBe(false);absent.unmount();
 const unready=harness('provider-settings.js','AnthropicCredentials',()=>response({installed:true,connected:true,ready:false,detail:'Synthetic unsupported client.'}));await unready.mount();expect(unready.text()).toContain('Sign-in found · connection unavailable');expect(unready.text()).not.toContain('Connected');unready.unmount();
});

test('Anthropic API starts as a separate Messages connection and never changes the subscription card',async()=>{
 const ui=harness('provider-settings.js','ModelConnections',()=>response(connectionList()));await ui.mount();
 await ui.button('Add Anthropic API').props.onClick();ui.render();
 expect(ui.control('llm-provider-name').props.value).toBe('Anthropic API');expect(ui.control('llm-base-url').props.value).toBe('https://api.anthropic.com');
 expect(ui.all().some(node=>node.type==='select'&&node.props.value==='anthropic-messages')).toBe(true);
 expect(ui.text()).toContain('uses API billing separately from Claude Code');ui.unmount();
});

const quickImages=(extra:any={})=>imagesWithAgy({selected:null,selectedQuickChoice:null,imageModels:[...imagesWithAgy().imageModels,{id:'gpt-image-latest',name:'GPT-Image-Latest',resolvedId:'gpt-image-2',kind:'chatgpt',billing:'subscription'},{id:'nano-banana-latest',name:'Nano-Banana-Latest',resolvedId:'gemini-3.1-flash-image',kind:'antigravity',billing:'subscription'}],quickChoices:[{id:'gpt-image-latest',label:'GPT-Image-Latest',connectionId:'openai-codex',connectionName:'ChatGPT subscription',imageModel:'gpt-image-latest',ready:true,billing:'subscription'},{id:'nano-banana-latest',label:'Nano-Banana-Latest',connectionId:'antigravity-http',connectionName:'Google Antigravity',imageModel:'nano-banana-latest',ready:true,billing:'subscription'}],...extra});

test('composer image aliases save only the server-provided explicit destination and retain unavailable selections',async()=>{
 let status=quickImages();
 const ui=harness('image-generation-settings.js','ImageGenerationChoice',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(options.method==='PUT'){const body=JSON.parse(options.body);status=quickImages({revision:2,selected:body.connectionId?{connectionId:body.connectionId,imageModel:body.imageModel}:null,selectedQuickChoice:body.imageModel??null})}
  return response(status);
 },{}, {},{compact:true});await ui.mount();expect(ui.control('composer-image-choice')).toBeDefined();expect(ui.control('image-quick-select').props.value).toBe('');
 expect(ui.all(ui.control('image-quick-select')).filter(node=>node.type==='option').map(node=>ui.text(node))).toEqual(['Off','GPT-Image-Latest','Nano-Banana-Latest']);
 await ui.control('image-quick-select').props.onChange({target:{value:'nano-banana-latest'}});ui.render();let mutation=ui.requests.find(entry=>entry.options.method==='PUT')!;expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:1,connectionId:'antigravity-http',imageModel:'nano-banana-latest'});expect(mutation.options.headers['x-operon-csrf']).toBe('token/one');
 status=quickImages({revision:2,selected:status.selected,selectedQuickChoice:'nano-banana-latest',quickChoices:status.quickChoices.map((choice:any)=>choice.id==='nano-banana-latest'?{...choice,ready:false,reason:'Synthetic unavailable Google connection.'}:choice)});ui.sources[0].onmessage();await settle();ui.render();expect(ui.control('image-quick-select').props.value).toBe('nano-banana-latest');expect(ui.text()).toContain('Synthetic unavailable Google connection.');
 expect(ui.requests.filter(entry=>entry.options.method==='PUT')).toHaveLength(1);await ui.control('image-quick-select').props.onChange({target:{value:''}});ui.render();mutation=ui.requests.filter(entry=>entry.options.method==='PUT').at(-1)!;expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:2,connectionId:null});ui.unmount();
});

test('committed image choices update both mounted selectors immediately without discarding a Connections draft',async()=>{
 const listeners=new Map<string,Set<Function>>();const bus={CustomEvent:class{constructor(readonly type:string,readonly detailObject:any){}get detail(){return this.detailObject.detail}},addEventListener:(type:string,listener:Function)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(listener)},removeEventListener:(type:string,listener:Function)=>listeners.get(type)?.delete(listener),dispatchEvent:(event:any)=>listeners.get(event.type)?.forEach(fn=>fn(event))};
 let status=quickImages();const handler=(path:string,options:any)=>{if(path==='/api/csrf')return response({});if(options.method==='PUT'){const body=JSON.parse(options.body);status=quickImages({revision:status.revision+1,selected:body.connectionId?{connectionId:body.connectionId,imageModel:body.imageModel}:null,selectedQuickChoice:body.imageModel??null})}return response(status)};
 const settings=harness('image-generation-settings.js','ImageGenerationSettings',handler,{},bus),composer=harness('image-generation-settings.js','ImageGenerationChoice',handler,{},bus,{compact:true});await settings.mount();await composer.mount();
 settings.control('image-generation-connection').props.onChange({target:{value:'openai'}});settings.render();
 await composer.control('image-quick-select').props.onChange({target:{value:'gpt-image-latest'}});composer.render();settings.render();expect(settings.text()).toContain('Image generation connection configured.');expect(settings.control('image-generation-connection').props.value).toBe('openai');expect(settings.render().props['data-chimeric-dirty']).toBe('true');
 settings.button('Cancel').props.onClick();settings.render();expect(settings.control('image-generation-connection').props.value).toBe('openai-codex');settings.unmount();composer.unmount();expect([...listeners.values()].every(value=>value.size===0)).toBe(true);
});

test('the Antigravity subscription card offers the existing-session import before browser sign-in while disconnected',async()=>{
 const ui=harness('antigravity-settings.js','AntigravityConnection',connectionsAnd(()=>agyHttp()));
 await ui.mount();ui.button('Google Antigravity').props.onClick();ui.render();
 const card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('Google Antigravity');
 expect(ui.text(card)).toContain('Disconnected');
 const labels=ui.all(card).filter(node=>node.type==='button').map(node=>ui.text(node)).filter(label=>['Check client','Use existing Antigravity session','Sign in with Google'].includes(label));
 expect(labels).toEqual(['Check client','Use existing Antigravity session','Sign in with Google']);
 expect(ui.button('Use existing Antigravity session').props.disabled).toBe(false);
 expect(ui.button('Sign in with Google').props.disabled).toBe(true);
 expect(ui.text(card)).toContain('Browser sign-in needs a local OAuth client configuration.');
 expect(ui.all(card).some(node=>ui.text(node)==='Disconnect')).toBe(false);
 expect(ui.requests.some(entry=>entry.path==='/api/local/antigravity-http'&&entry.options.method==='POST')).toBe(false);
 ui.unmount();
});

test('importing the existing Antigravity session posts the import action through CSRF and reveals the signed-in plan',async()=>{
 let status=agyHttp({oauthConfigured:true});
 const ui=harness('antigravity-settings.js','AntigravityConnection',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path==='/api/local/antigravity-http'){
   if(options.method==='POST'){
    const body=JSON.parse(options.body);
    if(body.action==='signin'&&body.method==='import')status=agyHttp({connected:true,email:'ada@example.com',project:'demo',tier:'free',paidTier:'Google AI Pro',modelDiscovery:{state:'ready',count:3},models:[{id:'gemini-4',name:'Gemini 4'}]});
   }
   return response(status);
  }
  return response(connectionList());
 });
 await ui.mount();ui.button('Google Antigravity').props.onClick();ui.render();
 await ui.button('Use existing Antigravity session').props.onClick();ui.render();
 const mutation=ui.requests.find(entry=>entry.path==='/api/local/antigravity-http'&&entry.options.method==='POST')!;
 expect(JSON.parse(mutation.options.body)).toEqual({action:'signin',method:'import'});
 expect(mutation.options.credentials).toBe('same-origin');
 expect(mutation.options.headers['x-operon-csrf']).toBe('token/one');
 expect(ui.requests[ui.requests.indexOf(mutation)-1].path).toBe('/api/csrf');
 const card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('ada@example.com');
 expect(ui.text(card)).toContain('Google AI Pro');
 expect(ui.text(card)).toContain('Discovered models: 3');
 expect(ui.all(card).some(node=>node.type==='button'&&ui.text(node)==='Disconnect')).toBe(true);
 expect(ui.control('antigravity-enabled').props.checked).toBe(false);
 ui.unmount();
});

test('the connected Antigravity card shows the paid plan, email and model count and can disconnect',async()=>{
 let status=agyHttp({connected:true,email:'ada@example.com',tier:'free',paidTier:'Google AI Pro',modelDiscovery:{state:'ready',count:4},models:[{id:'m1',name:'M1'}]});
 const ui=harness('antigravity-settings.js','AntigravityConnection',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path==='/api/local/antigravity-http'){
   if(options.method==='POST'&&JSON.parse(options.body).action==='disconnect')status=agyHttp();
   return response(status);
  }
  return response(connectionList());
 });
 await ui.mount();ui.button('Google Antigravity').props.onClick();ui.render();
 let card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('Signed in as: ada@example.com');
 expect(ui.text(card)).toContain('Plan: Google AI Pro');
 expect(ui.text(card)).not.toContain('Plan: free');
 expect(ui.text(card)).toContain('Discovered models: 4');
 expect(ui.button('Refresh models').props.disabled).toBe(false);
 await ui.button('Disconnect').props.onClick();ui.render();
 const mutation=ui.requests.find(entry=>entry.path==='/api/local/antigravity-http'&&entry.options.method==='POST')!;
 expect(JSON.parse(mutation.options.body)).toEqual({action:'disconnect'});
 expect(mutation.options.headers['x-operon-csrf']).toBe('token/one');
 card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('Disconnected');
 expect(ui.control('antigravity-enabled').props.checked).toBe(false);
 ui.unmount();
});

test('a pending Antigravity browser sign-in shows the authorization link and cancels through the same endpoint',async()=>{
 const authorizationUrl='https://accounts.google.com/o/oauth2/v2/auth?client_id=demo';
 let status=agyHttp();
 const ui=harness('antigravity-settings.js','AntigravityConnection',(path,options)=>{
  if(path==='/api/csrf')return response({});
  if(path==='/api/local/antigravity-http'){
   if(options.method==='POST'){
    const body=JSON.parse(options.body);
    if(body.action==='signin')status=agyHttp({oauthConfigured:true,login:{phase:'waiting',authorizationUrl,message:'Waiting for Google sign-in.'}});
    if(body.action==='cancel')status=agyHttp({oauthConfigured:true});
   }
   return response(status);
  }
  return response(connectionList());
 });
 await ui.mount();ui.button('Google Antigravity').props.onClick();ui.render();
 await ui.button('Sign in with Google').props.onClick();ui.render();
 let card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('Waiting for sign-in');
 const link=ui.all(card).find(node=>node.type==='a'&&node.props.href===authorizationUrl)!;
 expect(ui.text(link)).toBe('Continue to Google');
 expect(ui.all(card).some(node=>node.type==='button'&&ui.text(node)==='Cancel sign-in')).toBe(true);
 await ui.button('Cancel sign-in').props.onClick();ui.render();
 const posts=ui.requests.filter(entry=>entry.path==='/api/local/antigravity-http'&&entry.options.method==='POST');
 expect(posts.map(entry=>JSON.parse(entry.options.body))).toEqual([{action:'signin',method:'browser'},{action:'cancel'}]);
 card=ui.control('antigravity-subscription');
 expect(ui.text(card)).toContain('Disconnected');
 expect(ui.all(card).some(node=>node.type==='a')).toBe(false);
 ui.unmount();
});

test('the Antigravity subscription card, plan label and actions are localized in Japanese',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));
 const disconnected=harness('antigravity-settings.js','AntigravityConnection',connectionsAnd(()=>agyHttp()),translations);
 await disconnected.mount();disconnected.button('Google Antigravity').props.onClick();disconnected.render();
 const card=disconnected.control('antigravity-subscription');
 expect(disconnected.text(card)).toContain('Google Antigravity');
 expect(disconnected.text(card)).toContain('未接続');
 expect(disconnected.text(card)).toContain('既存の Antigravity セッションを使用');
 expect(disconnected.text(card)).toContain('Google でログイン');
 disconnected.unmount();
 const connected=harness('antigravity-settings.js','AntigravityConnection',connectionsAnd(()=>agyHttp({connected:true,email:'ada@example.com',paidTier:'Google AI Pro',modelDiscovery:{state:'ready',count:2}})),translations);
 await connected.mount();connected.button('Google Antigravity').props.onClick();connected.render();
 const connectedCard=connected.control('antigravity-subscription');
 expect(connected.text(connectedCard)).toContain('ログイン済み・接続は無効');
 expect(connected.text(connectedCard)).toContain('プラン: Google AI Pro');
 expect(connected.text(connectedCard)).toContain('検出されたモデル: 2');
 expect(connected.text(connectedCard)).toContain('モデルを更新');
 expect(connected.text(connectedCard)).toContain('切断');
 connected.unmount();
});
