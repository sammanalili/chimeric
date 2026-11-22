import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {providerEventsPrelude} from './provider-events-fixture';
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const response=(value:any,status=200)=>({ok:status>=200&&status<300,json:async()=>value});
function fixture(handler:(url:string,options:any)=>any,initialProps:any={},translations:Record<string,string>={},initialTime=Date.parse('2026-11-20T01:00:00Z'),componentName='UsageIndicator'){
 const hooks:any[]=[],effects:Function[]=[],requests:any[]=[],sources:any[]=[],documentListeners=new Map<string,Set<Function>>(),windowListeners=new Map<string,Set<Function>>();let index=0,tree:any,props=initialProps;
 let now=initialTime,nextTimer=0;const timers=new Map<number,{at:number,callback:Function}>();
 class ClockDate extends Date{constructor(value?:any){super(value===undefined?now:value)}static now(){return now}}
 const schedule=(callback:Function,delay=0)=>{const id=++nextTimer;timers.set(id,{at:now+Math.max(0,Number(delay)||0),callback});return id};
 const cancel=(id:number)=>timers.delete(id);
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={Fragment:'Fragment',useState(value:any){const i=index++;hooks[i]??={value:typeof value==='function'?value():value};return [hooks[i].value,(value:any)=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value}]},useRef(value:any){const i=index++;return hooks[i]??={current:value}},useCallback(fn:Function,deps:any[]){const i=index++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn},useEffect(fn:Function,deps:any[]){const i=index++,slot=hooks[i]??={};if(!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()})}}};
 const add=(listeners:Map<string,Set<Function>>,type:string,fn:Function)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type)!.add(fn)};
 const document={visibilityState:'visible',addEventListener:(type:string,fn:Function)=>add(documentListeners,type,fn),removeEventListener:(type:string,fn:Function)=>documentListeners.get(type)?.delete(fn)};
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const source=readFileSync(new URL('../src/usage-indicator.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export function UsageIndicator','function UsageIndicator');
 const component=runInNewContext(providerEventsPrelude+'\n'+source+';'+componentName,{React,jsx,AbortController,document,Date:ClockDate,setTimeout:schedule,clearTimeout:cancel,globalThis:{innerWidth:390,innerHeight:844,ChimericI18n:{t:(value:string)=>translations[value]??value},addEventListener:(type:string,fn:Function)=>add(windowListeners,type,fn),removeEventListener:(type:string,fn:Function)=>windowListeners.get(type)?.delete(fn)},fetch:async(url:string,options:any)=>{requests.push({url,options});return handler(url,options)},EventSource:class{onmessage?:Function;closed=false;constructor(readonly url:string){sources.push(this)}close(){this.closed=true}}});
 const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const content=(node:any):string=>Array.isArray(node)?node.map(content).join(' '):node&&typeof node==='object'?content(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):'';
 const render=(next?:any)=>{if(next!==undefined)props=next;index=0;tree=component(props);while(effects.length)effects.shift()!();return tree};
 const all=()=>walk(tree),text=()=>content(tree),find=(predicate:(node:any)=>boolean)=>{const node=all().find(predicate);if(!node)throw Error('Missing usage control: '+text());return node};
 return {requests,sources,document,documentListeners,windowListeners,render,all,text,find,now:()=>now,pendingTimers:()=>[...timers.values()].map(value=>value.at),trigger:()=>find(node=>node.props['data-testid']==='usage-trigger'),async mount(){render();await settle();render()},async event(){sources.at(-1).onmessage();await settle();render()},async visibility(value:string){document.visibilityState=value;documentListeners.get('visibilitychange')?.forEach(fn=>fn());await settle();render()},async advance(milliseconds:number){const end=now+milliseconds;let fired=0;for(;;){const next=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next)break;if(++fired>100)throw Error('Usage timer loop');now=next[1].at;timers.delete(next[0]);next[1].callback();await settle();render()}now=end;render();await settle();render()},open(){this.trigger().props.onFocus();render()},unmount(){hooks.forEach(slot=>slot?.cleanup?.())}};
}
const tracked={requests:4,input:12000,output:3000,cacheRead:4000,cacheWrite:0,estimatedUsd:null,unpricedRequests:4,startedAt:'2026-11-20T00:00:00Z'};
const subscription=(extra:any={})=>({id:'sub',name:'Synthetic plan',subscription:true,connected:true,quota:{status:'available',modelId:'sub::model',windows:[{label:'Short window',usedPercent:20},{label:'Weekly',usedPercent:90,resetAt:Date.parse('2026-11-21T00:00:00Z')}],observedAt:Date.parse('2026-11-20T01:00:00Z'),source:'Synthetic cached account report'},models:[{id:'model',qualifiedId:'sub::model',name:'Synthetic model',pricing:null}],tracked,...extra});
const apiConnection=(extra:any={})=>({id:'api',name:'Synthetic API',subscription:false,connected:true,quota:{status:'unavailable',windows:[]},models:[{id:'api-model',qualifiedId:'api::api-model',name:'Synthetic API model',pricing:{currency:'USD',inputPerMillion:1.5,outputPerMillion:6,cacheReadPerMillion:0.2,source:'Synthetic provider docs',sourceUrl:'https://docs.example.invalid/pricing',checkedAt:'2026-11-20T00:00:00Z'}}],tracked:{...tracked,estimatedUsd:0.036,unpricedRequests:0},...extra});

test('compact quota uses symbols, the tightest reported window, and keeps local token counts distinct',async()=>{
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[subscription()]}));await ui.mount();expect(ui.trigger().props['aria-label']).toBe('Model usage and pricing: ◔ 10%');expect(ui.all().some(node=>node.props.role==='region')).toBe(false);ui.open();expect(ui.text()).toContain('◔ 80%');expect(ui.text()).toContain('◔ 10%');expect(ui.text()).toContain('↥ 12,000');expect(ui.requests.every(entry=>entry.url==='/api/local/usage'&&entry.options.credentials==='same-origin')).toBe(true);ui.unmount();
});

test('API price summary uses the selected model input/output rates and shows their source in the detail popover',async()=>{
 const ui=fixture(()=>response({selectedModel:'api::api-model',connections:[apiConnection()]}));await ui.mount();expect(ui.trigger().props['aria-label']).toContain('↥$1.5 ↧$6');ui.open();expect(ui.text()).toContain('↥ $1.5');expect(ui.text()).toContain('↧ $6');expect(ui.find(node=>node.type==='a').props.href).toBe('https://docs.example.invalid/pricing');expect(ui.text()).toContain('$0.036');expect(ui.all().some(node=>node.type==='span'&&node.props.className==='md:hidden')).toBe(true);ui.unmount();
});
test('protected chat pricing follows its server-verified effective model and never another frame snapshot',async()=>{
 let frame='protected';const ui=fixture(()=>response({frameId:frame,effectiveModelId:'api::api-model',selectedModel:'sub::model',connections:[subscription(),apiConnection()]}),{modelId:'sub::model',frameId:'protected'});
 await ui.mount();expect(ui.requests[0].url).toBe('/api/local/usage?frameId=protected');expect(ui.trigger().props['aria-label']).toContain('↥$1.5 ↧$6');ui.open();expect(ui.text()).toContain('Synthetic API model');
 ui.render({modelId:'sub::model',frameId:'other'});expect(ui.trigger().props['aria-label']).toContain('—');await settle();ui.render();expect(ui.trigger().props['aria-label']).toContain('—');
 frame='other';await ui.event();expect(ui.trigger().props['aria-label']).toContain('↥$1.5 ↧$6');ui.unmount();
});

test('unknown prices and unavailable quota remain unknown even when tracked token counts are large',async()=>{
 for(const connection of [subscription({quota:{status:'unavailable',windows:[]},tracked:{...tracked,input:90000000}}),apiConnection({models:[{id:'api-model',qualifiedId:'api::api-model',name:'Unpriced model',pricing:null}],tracked:{...tracked,estimatedUsd:null}})]){
  const ui=fixture(()=>response({selectedModel:connection.models[0].qualifiedId,connections:[connection]}));await ui.mount();expect(ui.trigger().props['aria-label']).toBe('Model usage and pricing: —');ui.open();expect(ui.text()).not.toContain('$0');expect(ui.text()).toContain('—');ui.unmount();
 }
});

test('stale and disconnected account states never present a fresh quota percentage',async()=>{
 let connection=subscription();const ui=fixture(()=>response({selectedModel:'sub::model',connections:[connection]}));await ui.mount();connection=subscription({quota:{status:'stale',modelId:'sub::model',windows:[{label:'Last window',usedPercent:10}]}});await ui.event();expect(ui.trigger().props['aria-label']).toContain('◌');ui.open();expect(ui.text()).toContain('◔ 90%');connection=subscription({connected:false});await ui.event();expect(ui.trigger().props['aria-label']).toContain('⊘');ui.unmount();
});

test('actual composer model changes, visibility and service events refresh only the local usage snapshot',async()=>{
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[subscription(),apiConnection()]}),{modelId:'anthropic/api::api-model'});await ui.mount();expect(ui.trigger().props['aria-label']).toContain('↥$1.5 ↧$6');const initial=ui.requests.length;
 ui.render({modelId:'sub::model'});await settle();ui.render();expect(ui.trigger().props['aria-label']).toContain('◔ 10%');expect(ui.requests.length).toBe(initial+1);const beforeHidden=ui.requests.length;await ui.visibility('hidden');expect(ui.requests.length).toBe(beforeHidden);await ui.visibility('visible');expect(ui.requests.length).toBe(beforeHidden+1);await ui.event();expect(ui.requests.length).toBe(beforeHidden+2);expect(ui.requests.every(entry=>entry.url==='/api/local/usage'&&!entry.options.method)).toBe(true);ui.unmount();expect(ui.sources.every(source=>source.closed)).toBe(true);expect([...ui.documentListeners.values(),...ui.windowListeners.values()].every(listeners=>listeners.size===0)).toBe(true);
});

test('usage popover supports focus, tap, Escape and safe source links',async()=>{
 const connection=apiConnection();connection.models[0].pricing.sourceUrl='javascript:alert(1)';const ui=fixture(()=>response({selectedModel:'api::api-model',connections:[connection]}));await ui.mount();ui.trigger().props.onFocus();ui.render();expect(ui.trigger().props['aria-expanded']).toBe(true);ui.trigger().props.onClick();ui.render();expect(ui.trigger().props['aria-expanded']).toBe(true);ui.trigger().props.onClick();ui.render();expect(ui.trigger().props['aria-expanded']).toBe(false);ui.open();ui.find(node=>node.props['data-testid']==='usage-indicator').props.onKeyDown({key:'Escape'});ui.render();expect(ui.trigger().props['aria-expanded']).toBe(false);ui.open();expect(ui.all().some(node=>node.type==='a')).toBe(false);expect(ui.all().some(node=>node.props.dangerouslySetInnerHTML)).toBe(false);ui.unmount();
});

test('Japanese compact usage preserves numeric symbols without verbose copy',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));const ui=fixture(()=>response({selectedModel:'sub::model',connections:[subscription()]}),{},translations);await ui.mount();ui.open();expect(ui.text()).toContain('◔ 10%');expect(ui.text()).toContain('↥ 12,000');ui.unmount();
});

test('quota without the exact selected model binding never supplies an allowance or starts a timer',async()=>{
 for(const modelId of [undefined,'sub::different-model','model']){
  const connection=subscription();connection.quota.modelId=modelId;
  const ui=fixture(()=>response({selectedModel:'sub::model',connections:[connection]}));await ui.mount();
  expect(ui.trigger().props['aria-label']).toBe('Model usage and pricing: —');expect(ui.pendingTimers()).toHaveLength(0);
  ui.open();expect(ui.text()).not.toContain('◔ 80%');expect(ui.text()).not.toContain('Synthetic cached account report');expect(ui.text()).toContain('↺');ui.unmount();
 }
 const connection=subscription();connection.models.push({id:'another',qualifiedId:'sub::another',name:'Another model',pricing:null});
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[connection]}),{modelId:'sub::another'});await ui.mount();
 expect(ui.trigger().props['aria-label']).toBe('Model usage and pricing: —');expect(ui.pendingTimers()).toHaveLength(0);
 ui.render({modelId:'anthropic/sub::model'});await settle();ui.render();expect(ui.trigger().props['aria-label']).toContain('◔ 10%');expect(ui.pendingTimers()).toHaveLength(1);ui.unmount();
});

test('a five-minute observation deadline refreshes local usage once and marks repeated available snapshots stale',async()=>{
 // Return new objects on every request, as a real JSON response does.
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[subscription()]}));await ui.mount();
 expect(ui.pendingTimers()).toEqual([ui.now()+300010]);
 await ui.advance(299999);expect(ui.trigger().props['aria-label']).toContain('◔ 10%');expect(ui.requests).toHaveLength(1);
 await ui.advance(11);expect(ui.requests).toHaveLength(2);expect(ui.trigger().props['aria-label']).toContain('◌');expect(ui.pendingTimers()).toHaveLength(0);
 ui.open();expect(ui.text()).toContain('◔ 10%');
 await ui.advance(86400000);expect(ui.requests).toHaveLength(2);expect(ui.pendingTimers()).toHaveLength(0);
 expect(ui.requests.every(entry=>entry.url==='/api/local/usage'&&entry.options.credentials==='same-origin')).toBe(true);ui.unmount();
});

test('the earliest reset uses millisecond timestamps and cannot loop when the server returns the old reset with a newer observation',async()=>{
 const base=Date.parse('2026-11-20T01:00:00Z'),resetAt=base+60000;let observedAt=base;
 const ui=fixture(()=>{const connection=subscription();connection.quota.observedAt=observedAt;connection.quota.windows=[{label:'Resets first',usedPercent:90,resetAt},{label:'Resets later',usedPercent:20,resetAt:base+120000}];return response({selectedModel:'sub::model',connections:[connection]})});
 await ui.mount();expect(ui.pendingTimers()).toEqual([resetAt+10]);await ui.advance(59999);expect(ui.requests).toHaveLength(1);
 observedAt=base+60010;await ui.advance(11);expect(ui.requests).toHaveLength(2);expect(ui.trigger().props['aria-label']).toContain('◌');expect(ui.pendingTimers()).toHaveLength(0);
 await ui.advance(300000);expect(ui.requests).toHaveLength(2);ui.unmount();
});

test('already expired reports refresh once, and a genuinely newer observation can schedule its own later refresh',async()=>{
 const base=Date.parse('2026-11-20T01:00:00Z');let observedAt=base-400000;
 const ui=fixture(()=>{const connection=subscription();connection.quota.observedAt=observedAt;return response({selectedModel:'sub::model',connections:[connection]})});
 await ui.mount();expect(ui.trigger().props['aria-label']).toContain('◌');await ui.advance(0);expect(ui.requests).toHaveLength(2);expect(ui.pendingTimers()).toHaveLength(0);
 observedAt=ui.now();await ui.event();expect(ui.requests).toHaveLength(3);expect(ui.trigger().props['aria-label']).toContain('◔ 10%');expect(ui.pendingTimers()).toEqual([observedAt+300010]);
 await ui.advance(300010);expect(ui.requests).toHaveLength(4);expect(ui.trigger().props['aria-label']).toContain('◌');expect(ui.pendingTimers()).toHaveLength(0);ui.unmount();
});

test('model changes and unmount cancel pending deadlines without background provider polling',async()=>{
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[subscription(),apiConnection()]}),{modelId:'sub::model'});await ui.mount();expect(ui.pendingTimers()).toHaveLength(1);
 ui.render({modelId:'api::api-model'});await settle();ui.render();expect(ui.pendingTimers()).toHaveLength(0);const requests=ui.requests.length;await ui.advance(400000);expect(ui.requests).toHaveLength(requests);
 ui.render({modelId:'sub::model'});await settle();ui.render();expect(ui.pendingTimers()).toHaveLength(1);ui.unmount();expect(ui.pendingTimers()).toHaveLength(0);expect(ui.sources.every(source=>source.closed)).toBe(true);
});

test('a far-future corrupt observation cannot overflow a browser timer into rapid requests',async()=>{
 const connection=subscription();connection.quota.observedAt=Date.parse('2099-01-01T00:00:00Z');connection.quota.windows=[{label:'Future report',usedPercent:20}];
 const ui=fixture(()=>response({selectedModel:'sub::model',connections:[connection]}));await ui.mount();expect(ui.trigger().props['aria-label']).toContain('◌');expect(ui.pendingTimers()).toHaveLength(0);await ui.advance(600000);expect(ui.requests).toHaveLength(1);ui.unmount();
});

test('local accounting warnings remain visible as plain text in the details popover',async()=>{
 const warning='Saved usage could not be read. <script>not executable</script>';
 const ui=fixture(()=>response({selectedModel:'api::api-model',connections:[apiConnection()],warning}));await ui.mount();expect(ui.text()).not.toContain(warning);ui.open();
 expect(ui.find(node=>node.props.role==='status').props.children).toBe(warning);expect(ui.all().some(node=>node.type==='script'||node.props.dangerouslySetInnerHTML)).toBe(false);ui.unmount();
});
test('custom API price editing saves explicit USD units and optional cache rates to the chosen model only',async()=>{
 let saved=0;const ui=fixture((_url,options)=>response({ok:true}),{model:{qualifiedId:'api::custom'},price:null,revision:3,onSaved:async()=>{saved++}},{},undefined,'PriceEditor');
 (ui.document as any).cookie='operon_csrf=synthetic-csrf';await ui.mount();ui.find(n=>n.type==='button'&&n.props.children==='Edit API prices').props.onClick();ui.render();
 const input=(label:string)=>ui.find(n=>n.type==='input'&&n.props['aria-label']===label+' USD per 1M tokens');
 input('Input').props.onChange({target:{value:'0'}});input('Output').props.onChange({target:{value:'7.5'}});input('Cache read').props.onChange({target:{value:'0.25'}});ui.render();
 await ui.find(n=>n.type==='button'&&n.props.children==='Save prices').props.onClick();ui.render();expect(saved).toBe(1);expect(ui.requests).toHaveLength(1);const request=ui.requests[0];expect(request.url).toBe('/api/local/usage/pricing');expect(request.options.headers['x-operon-csrf']).toBe('synthetic-csrf');expect(JSON.parse(request.options.body)).toEqual({expectedRevision:3,model:'api::custom',pricing:{currency:'USD',inputPerMillion:0,outputPerMillion:7.5,cacheReadPerMillion:.25}});ui.unmount();
});
test('blank or invalid API prices never become free rates and stale edits keep their original revision',async()=>{
 let revision=3;const props={model:{qualifiedId:'api::custom'},price:null,revision,onSaved:async()=>{}};
 const ui=fixture((_url,options)=>{const body=JSON.parse(options.body);return body.expectedRevision===revision?response({ok:true}):response({detail:'Prices changed. Reload before saving.'},409)},props,{},undefined,'PriceEditor');(ui.document as any).cookie='operon_csrf=synthetic';await ui.mount();ui.find(n=>n.type==='button'&&n.props.children==='Edit API prices').props.onClick();ui.render();
 await ui.find(n=>n.type==='button'&&n.props.children==='Save prices').props.onClick();ui.render();expect(ui.requests).toHaveLength(0);expect(ui.text()).toContain('Enter nonnegative');
 for(const field of ui.all().filter(n=>n.type==='input').slice(0,2))field.props.onChange({target:{value:'2'}});ui.render();revision=4;ui.render({...props,revision});await ui.find(n=>n.type==='button'&&n.props.children==='Save prices').props.onClick();ui.render();expect(JSON.parse(ui.requests[0].options.body).expectedRevision).toBe(3);expect(ui.text()).toContain('Prices changed.');
 ui.find(n=>n.type==='button'&&n.props.children==='Reload prices').props.onClick();ui.render();expect(ui.text()).not.toContain('Prices changed.');ui.unmount();
});
test('clearing custom prices sends null and subscription chips expose no token-price editor',async()=>{
 const ui=fixture(()=>response({ok:true}),{model:{qualifiedId:'api::custom'},price:{source:'manual',inputPerMillion:2,outputPerMillion:4},revision:4,onSaved:async()=>{}},{},undefined,'PriceEditor');(ui.document as any).cookie='operon_csrf=synthetic';await ui.mount();await ui.find(n=>n.type==='button'&&n.props.children==='Clear custom prices').props.onClick();expect(JSON.parse(ui.requests[0].options.body)).toEqual({expectedRevision:4,model:'api::custom',pricing:null});ui.unmount();
 const sub=fixture(()=>response({selectedModel:'sub::model',connections:[subscription()]}));await sub.mount();sub.open();expect(sub.all().some(n=>n.type?.name==='PriceEditor')).toBe(false);sub.unmount();
});
test('the details popover stays open while an editor control has focus and closes when focus leaves',async()=>{
 const ui=fixture(()=>response({selectedModel:'api::api-model',connections:[apiConnection()]}));await ui.mount();const root=ui.find(n=>n.props['data-testid']==='usage-indicator'),inside={};root.props.ref.current={contains:(target:any)=>target===inside,getBoundingClientRect:()=>({left:20,top:700})};
 root.props.onMouseEnter();ui.render();root.props.onFocusCapture();root.props.onMouseLeave();ui.render();expect(ui.all().some(n=>n.props.role==='region')).toBe(true);
 root.props.onBlurCapture({relatedTarget:inside});ui.render();expect(ui.all().some(n=>n.props.role==='region')).toBe(true);root.props.onBlurCapture({relatedTarget:null});ui.render();expect(ui.all().some(n=>n.props.role==='region')).toBe(false);ui.unmount();
});
test('price editing bootstraps the native CSRF cookie before its single local mutation',async()=>{
 let ui:any;ui=fixture((url,options)=>{if(url==='/api/csrf'){ui.document.cookie='operon_csrf=synthetic-new';return response({},204)}expect(options.headers['x-operon-csrf']).toBe('synthetic-new');return response({ok:true})},{model:{qualifiedId:'api::custom'},price:{source:'manual',inputPerMillion:2,outputPerMillion:3},revision:1,onSaved:async()=>{}},{},undefined,'PriceEditor');ui.document.cookie='';await ui.mount();await ui.find((n:any)=>n.type==='button'&&n.props.children==='Clear custom prices').props.onClick();expect(ui.requests.map((r:any)=>r.url)).toEqual(['/api/csrf','/api/local/usage/pricing']);ui.unmount();
});
