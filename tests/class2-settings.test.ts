import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {providerEventsPrelude} from './provider-events-fixture';
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
const response=(value:any,status=200)=>({ok:status>=200&&status<300,json:async()=>structuredClone(value)});
const model=(id='approved',eligible=true)=>({qualifiedId:id+'::research',name:id+' research',connectionId:id,eligible});
const frame=(extra:any={})=>({revision:0,frameId:'frame',rootFrameId:'frame',mode:'standard',models:[model('blocked',false),model()],ready:true,reviews:[],...extra});
const connection=(extra:any={})=>({revision:0,connectionId:'approved',name:'Synthetic connection',allowedPurposes:[],automaticPurposes:[],eligible:false,...extra});
const review=(extra:any={})=>({id:'b8c206b3-a6d7-411b-9cbd-c72881930142',digest:'a'.repeat(64),status:'pending',createdAt:1800000000000,expiresAt:1800000060000,connection:{id:'approved',api:'openai-responses',endpoint:'https://external.example/api'},rationale:'Search a transformed synthetic query.',privacy:{kind:'decontextualized',summary:'Removed direct identifiers.',limitations:['A rare topic can still identify someone.'],notice:'This transformation does not guarantee anonymity.'},destination:{url:'https://external.example/api/search?q=visible',hostname:'external.example',encrypted:true},request:{method:'POST',headers:{accept:'application/json'},payload:{kind:'json',value:{query:'exact synthetic query'}},bodyBytes:33,bodySha256:'b'.repeat(64)},disclosures:{authentication:'The credential identifies your account.',ip:'The service receives your IP address.',location:'An approximate location may be inferred.',other:'Transport metadata is visible.'},...extra});
function fixture(name:string,initialProps:any,handler:(url:string,options:any)=>any=()=>response(frame())){
 let props=initialProps,tree:any,active:any,index=0,now=1800000000000,timerId=0;const records=new Map<string,any>(),effects:Function[]=[],requests:any[]=[],sources:any[]=[],events=new Map<string,Set<Function>>(),timers=new Map<number,Function>();
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((value,i)=>Object.is(value,b[i]));
 const React={Fragment:'Fragment',useState(value:any){const slot=active.hooks[index++]??={value:typeof value==='function'?value():value};return [slot.value,(next:any)=>{slot.value=typeof next==='function'?next(slot.value):next}]},useRef(value:any){return active.hooks[index++]??={current:value}},useCallback(fn:Function,deps:any[]){const i=index++;if(!active.hooks[i]||!same(active.hooks[i].deps,deps))active.hooks[i]={fn,deps};return active.hooks[i].fn},useEffect(fn:Function,deps:any[]){const slot=active.hooks[index++]??={};if(!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()})}}};
 const jsx={jsx:(type:any,props:any,key?:any)=>({type,props,key}),jsxs:(type:any,props:any,key?:any)=>({type,props,key})};
 const document:any={cookie:'operon_csrf=synthetic-csrf',visibilityState:'visible',createElement:()=>({click(){}})};
 const add=(type:string,fn:Function)=>{if(!events.has(type))events.set(type,new Set());events.get(type)!.add(fn)};
 class ClockDate extends Date{constructor(value?:any){super(value===undefined?now:value)}static now(){return now}}
 const source=readFileSync(new URL('../src/class2-settings.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replaceAll('export function ','function ');
 const module=runInNewContext(providerEventsPrelude+'\n'+source+';({PolicyModelPicker,ConfidentialityControl,OutboundReviews,ConnectionEligibility,ReviewDialog,ReviewContent,ExactPayload})',{React,jsx,AbortController,Date:ClockDate,Event:class{constructor(readonly type:string){}},globalThis:{ChimericI18n:{t:(value:string)=>value},addEventListener:add,removeEventListener:(type:string,fn:Function)=>events.get(type)?.delete(fn),dispatchEvent:(event:any)=>events.get(event.type)?.forEach(fn=>fn())},document,encodeURIComponent,decodeURIComponent,setTimeout:(fn:Function)=>{const id=++timerId;timers.set(id,fn);return id},clearTimeout:(id:number)=>timers.delete(id),fetch:async(url:string,options:any={})=>{requests.push({url,options});return handler(url,options)},EventSource:class{onmessage?:Function;closed=false;constructor(readonly url:string){sources.push(this)}close(){this.closed=true}},atob:(value:string)=>Buffer.from(value,'base64').toString('binary'),Uint8Array,Blob,URL:{createObjectURL:()=> 'blob:synthetic',revokeObjectURL(){}}});
 const renderNode=(node:any,path:string):any=>{
  if(Array.isArray(node))return node.map((child,i)=>renderNode(child,path+'/'+(child?.key??i)));
  if(!node||typeof node!=='object')return node;
  if(typeof node.type==='function'){
   const key=path+':'+node.type.name,slot=records.get(key)??{hooks:[],seen:0};records.set(key,slot);slot.seen=renderCount;active=slot;index=0;
   return renderNode(node.type(node.props),key);
  }
  if(node.props?.ref&&!node.props.ref.current)node.props.ref.current={open:false,showModal(){this.open=true},close(){this.open=false}};
  return {...node,props:{...node.props,children:renderNode(node.props?.children,path+'/children')}};
 };
 let renderCount=0;
 const render=(next?:any)=>{if(next!==undefined)props=next;++renderCount;tree=renderNode(jsx.jsx(module[name],props),'root');for(const [key,slot]of records)if(slot.seen!==renderCount){for(const hook of slot.hooks)hook?.cleanup?.();records.delete(key)}while(effects.length)effects.shift()!();return tree};
 const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const content=(node:any):string=>Array.isArray(node)?node.map(content).join(' '):node&&typeof node==='object'?content(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):'';
 const all=()=>walk(tree),text=()=>content(tree),find=(predicate:(node:any)=>boolean)=>{const found=all().find(predicate);if(!found)throw Error('Missing Class 2 node: '+text());return found};
 const checkbox=(label?:string)=>find(node=>node.type==='input'&&node.props.type==='checkbox'&&(!label||node.props['aria-label']===label));
 return {requests,sources,events,timers,document,render,all,text,find,checkbox,async mount(){render();await settle();render()},async act(fn:()=>any){await fn();render();await settle();render()},async event(){sources.at(-1)?.onmessage?.();await settle();render()},async advance(ms:number){now+=ms;const pending=[...timers.values()];timers.clear();for(const fn of pending)fn();await settle();render()},unmount(){for(const slot of records.values())for(const hook of slot.hooks)hook?.cleanup?.();records.clear()}};
}

test('the compact protected picker shows its actual model and keeps the original picker for standard mode',async()=>{
 let value=frame({mode:'class2',main:'approved::research',reviewer:'approved::research'});
 const fallback={type:'button',props:{'data-testid':'native-fallback',children:'outside-model'}},ui=fixture('PolicyModelPicker',{frameId:'frame',fallback},()=>response(value));
 await ui.mount();expect(ui.text()).toContain('approved research');expect(ui.text()).not.toContain('outside-model');const trigger=ui.find(node=>node.props['data-testid']==='protected-model-selector');expect(trigger.props['aria-label']).toBe('Class 2 model: approved research');
 await ui.act(()=>trigger.props.onClick());expect(ui.all().some(node=>node.type==='dialog')).toBe(true);expect(ui.all().some(node=>node.props['data-testid']==='confidentiality-control')).toBe(true);
 value=frame();await ui.event();expect(ui.text()).toContain('outside-model');expect(ui.all().some(node=>node.props['data-testid']==='protected-model-selector')).toBe(false);ui.unmount();
});
test('composer without a trusted frame stays disabled and makes no confidentiality or provider request',async()=>{
 const ui=fixture('ConfidentialityControl',{});await ui.mount();expect(ui.checkbox().props.disabled).toBe(true);expect(ui.text()).toContain('Start a research session');expect(ui.requests).toHaveLength(0);expect(ui.sources).toHaveLength(0);ui.unmount();
});
test('composer auto-selects only server-eligible models, uses revision CAS and turns Off without model overrides',async()=>{
 let state=frame();const ui=fixture('ConfidentialityControl',{frameId:'frame'},(_url,options)=>{if(options.method==='PUT'){const body=JSON.parse(options.body);state=frame({...body,revision:state.revision+1})}return response(state)});await ui.mount();
 const selects=ui.all().filter(node=>node.type==='select');expect(selects.map(node=>node.props.value)).toEqual(['approved::research','approved::research']);expect(ui.text()).not.toContain('blocked research');
 await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));expect(JSON.parse(ui.requests.find(call=>call.options.method==='PUT')!.options.body)).toEqual({frameId:'frame',expectedRevision:0,mode:'class2',main:'approved::research',reviewer:'approved::research'});expect(ui.checkbox().props.checked).toBe(true);
 await ui.act(()=>ui.checkbox().props.onChange({target:{checked:false}}));const writes=ui.requests.filter(call=>call.options.method==='PUT');expect(JSON.parse(writes.at(-1)!.options.body)).toEqual({frameId:'frame',expectedRevision:1,mode:'standard'});expect(writes.every(call=>call.options.headers['x-operon-csrf']==='synthetic-csrf'&&call.options.credentials==='same-origin'&&call.options.redirect==='error')).toBe(true);ui.unmount();expect(ui.sources.every(source=>source.closed)).toBe(true);expect([...ui.events.values()].every(listeners=>listeners.size===0)).toBe(true);expect(ui.timers.size).toBe(0);
});
test('a confidentiality mutation revokes browser resource leases before the PUT starts',async()=>{
 const order:string[]=[],ui=fixture('ConfidentialityControl',{frameId:'frame'},(_url,options)=>{let next={};if(options.method==='PUT'){order.push('put');next=JSON.parse(options.body)}return response(frame({...next,revision:1}))});await ui.mount();ui.events.set('chimeric-confidentiality-changing',new Set([()=>order.push('changing')]));
 await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));expect(order.slice(0,2)).toEqual(['changing','put']);ui.unmount();
});
test('connection permission starts denied and user approval does not claim retention or promote automatic STT permission',async()=>{
 let state=connection({automaticPurposes:['stt']});const ui=fixture('ConnectionEligibility',{connectionId:'approved'},(_url,options)=>{if(options.method==='PUT'){const body=JSON.parse(options.body);state=connection({allowedPurposes:body.purposes,automaticPurposes:['stt'],revision:1})}return response(state)});await ui.mount();
 expect(ui.all().filter(node=>node.type==='input').every(node=>node.props.checked===false)).toBe(true);expect(ui.text()).toContain('Unknown');expect(ui.text()).toContain('does not prove zero data retention');expect(ui.text()).toContain('selected transcription model');
 await ui.act(()=>ui.all().find(node=>node.type==='input')!.props.onChange({target:{checked:true}}));expect(JSON.parse(ui.requests.find(call=>call.options.method==='PUT')!.options.body)).toEqual({expectedRevision:0,purposes:['model']});ui.unmount();
});
test('late responses and immediate frame changes never expose the previous session review or permission',async()=>{
 let release:(value:any)=>void=()=>{};const pending=new Promise(resolve=>release=resolve),ui=fixture('ConfidentialityControl',{frameId:'old'},url=>url.endsWith('old')?pending:response(frame({frameId:'new',ready:false,reason:'New session has no approval.'})));
 ui.render();ui.render({frameId:'new'});expect(ui.checkbox().props.disabled).toBe(true);release(response(frame({frameId:'old',mode:'class2',reason:'OLD PRIVATE SESSION'})));await settle();ui.render();expect(ui.text()).not.toContain('OLD PRIVATE SESSION');expect(ui.text()).toContain('New session has no approval.');expect(ui.checkbox().props.checked).toBe(false);ui.unmount();
});
test('review consent is bound to exact digest and frame, expires, and never defaults to permission',async()=>{
 const actions:any[]=[],props={frameId:'frame',review:review(),busy:false,onSend:()=>actions.push('send'),onDeny:()=>actions.push('deny'),onClose:()=>actions.push('close')},ui=fixture('ReviewDialog',props);await ui.mount();
 const send=()=>ui.find(node=>node.type==='button'&&node.props.children==='Send once');expect(send().props.disabled).toBe(true);await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));expect(send().props.disabled).toBe(false);
 ui.render({...props,review:review({digest:'c'.repeat(64)})});expect(send().props.disabled).toBe(true);ui.render({...props,frameId:'other'});expect(send().props.disabled).toBe(true);
 ui.render(props);await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));await ui.advance(60001);expect(send().props.disabled).toBe(true);expect(ui.text()).toContain('expired');expect(actions).toHaveLength(0);ui.unmount();
});
test('review renders exact JSON and disclosures as text, with every upload available but no active HTML or unsafe image preview',async()=>{
 const file={fieldName:'upload',filename:'synthetic.svg',contentType:'image/svg+xml',base64:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')};
 const item=review({rationale:'<script>research</script>',request:{method:'POST',headers:{accept:'application/json'},payload:{kind:'multipart',fields:[{name:'query',value:' \n exact <b>query</b> '}],files:[file]},bodyBytes:50,bodySha256:'b'.repeat(64)}}),ui=fixture('ReviewContent',{review:item});await ui.mount();
 expect(ui.text()).toContain('<script>research</script>');expect(ui.text()).toContain(' \n exact <b>query</b> ');expect(ui.text()).toContain('approved · openai-responses');expect(ui.text()).toContain('https://external.example/api/search?q=visible');expect(ui.text()).toContain('credential identifies your account');expect(ui.text()).toContain('IP address');expect(ui.text()).toContain('approximate location');expect(ui.text()).toContain('rare topic');expect(ui.find(node=>node.type==='textarea').props.value).toBe(file.base64);expect(ui.all().some(node=>['script','iframe','img','a'].includes(node.type)||node.props.dangerouslySetInnerHTML)).toBe(false);expect(ui.requests).toHaveLength(0);ui.unmount();
 const json=fixture('ExactPayload',{payload:{kind:'json',value:{query:' exact\nquery ',nested:[1,2]}}});await json.mount();expect(json.text()).toBe('{"query":" exact\\nquery ","nested":[1,2]}');json.unmount();
});
test('send uses only server review ID, scope and digest; double clicks cannot launch another send',async()=>{
 let state=frame({mode:'class2',main:'approved::research',reviewer:'approved::research',reviews:[review()]}),release:(value:any)=>void=()=>{};const gate=new Promise(resolve=>release=resolve);
 const ui=fixture('OutboundReviews',{frameId:'frame'},(_url,options)=>options.method==='POST'?gate:response(state));await ui.mount();await ui.act(()=>ui.find(node=>node.type==='button'&&String(node.props.children).startsWith('Review outgoing request')).props.onClick());await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));
 const send=ui.find(node=>node.type==='button'&&node.props.children==='Send once'),first=send.props.onClick();send.props.onClick();await settle();expect(ui.requests.filter(call=>call.options.method==='POST')).toHaveLength(1);const request=ui.requests.find(call=>call.options.method==='POST')!;expect(request.url).toBe('/api/local/confidentiality/reviews/'+review().id+'/send');expect(JSON.parse(request.options.body)).toEqual({frameId:'frame',digest:'a'.repeat(64)});
 state=frame({...state,reviews:[review({status:'sent'})]});release(response(state));await first;await settle();ui.render();expect(ui.text()).toContain('no longer pending');ui.unmount();
});
test('unknown formats disable sending even after consent and the local CSRF bootstrap is required when no cookie exists',async()=>{
 const props={frameId:'frame',review:review({request:{...review().request,payload:{kind:'future'}}}),busy:false},ui=fixture('ReviewDialog',props);await ui.mount();await ui.act(()=>ui.checkbox().props.onChange({target:{checked:true}}));expect(ui.find(node=>node.type==='button'&&node.props.children==='Send once').props.disabled).toBe(true);expect(ui.text()).toContain('Sending is disabled');ui.unmount();
 const checks=fixture('ConnectionEligibility',{connectionId:'approved'},(url)=>url==='/api/csrf'?response({}):response(connection()));checks.document.cookie='';await checks.mount();await checks.act(()=>checks.checkbox().props.onChange({target:{checked:true}}));expect(checks.requests.filter(call=>call.options.method==='PUT')).toHaveLength(0);expect(checks.text()).toContain('Refresh the app');checks.unmount();
});
test('leaving a component aborts its pending write and late completion never starts another local fetch',async()=>{
 let release:(value:any)=>void=()=>{};const gate=new Promise(resolve=>release=resolve),ui=fixture('ConnectionEligibility',{connectionId:'approved'},(_url,options)=>options.method==='PUT'?gate:response(connection()));await ui.mount();
 const pending=ui.checkbox().props.onChange({target:{checked:true}});await settle();const write=ui.requests.find(call=>call.options.method==='PUT')!;ui.unmount();expect(write.options.signal.aborted).toBe(true);const count=ui.requests.length;release(response(connection({allowedPurposes:['model']})));await pending;await settle();expect(ui.requests).toHaveLength(count);expect(ui.sources.every(source=>source.closed)).toBe(true);
});
