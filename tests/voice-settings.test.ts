import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {providerEventsPrelude} from './provider-events-fixture';
const response=(value:any,status=200)=>({ok:status>=200&&status<300,status,json:async()=>value});
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function uiFixture(handler:(path:string,options:any)=>any,translations:Record<string,string>={}){
 const hooks:any[]=[],effects:Function[]=[],events:any[]=[],requests:any[]=[];let index=0,tree:any;
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((v,i)=>Object.is(v,b[i]));
 const React={useState(value:any){const i=index++;hooks[i]??={value:typeof value==='function'?value():value};return [hooks[i].value,(value:any)=>{hooks[i].value=typeof value==='function'?value(hooks[i].value):value}]},useRef(value:any){const i=index++;return hooks[i]??={current:value}},useCallback(fn:Function,deps:any[]){const i=index++;if(!hooks[i]||!same(hooks[i].deps,deps))hooks[i]={fn,deps};return hooks[i].fn},useEffect(fn:Function,deps:any[]){const i=index++,slot=hooks[i]??={};if(!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=fn()})}}};
 const jsx={jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})};
 const source=readFileSync(new URL('../src/voice-settings.js',import.meta.url),'utf8').replace(/^import[^\n]+\n/gm,'').replace('export function VoiceSettings','function VoiceSettings');
 const renderComponent=runInNewContext(providerEventsPrelude+'\n'+source+';VoiceSettings',{React,jsx,useQueryClient:()=>({invalidateQueries(){}}),globalThis:{ChimericI18n:{t:(value:string)=>translations[value]??value}},document:{cookie:'operon_csrf=synthetic%2Fvoice'},fetch:async(path:string,options:any)=>{requests.push({path,options});return handler(path,options)},EventSource:class{onmessage?:Function;closed=false;constructor(){events.push(this)}close(){this.closed=true}}});
 const walk=(node:any):any[]=>Array.isArray(node)?node.flatMap(walk):node&&typeof node==='object'?[node,...walk(node.props?.children)]:[];
 const content=(node:any):string=>Array.isArray(node)?node.map(content).join(' '):node&&typeof node==='object'?content(node.props?.children):typeof node==='string'||typeof node==='number'?String(node):'';
 const render=()=>{index=0;tree=renderComponent();while(effects.length)effects.shift()!();return tree};
 const all=()=>walk(tree),text=()=>content(tree),find=(predicate:(node:any)=>boolean)=>{const node=all().find(predicate);if(!node)throw Error('Missing voice control: '+text());return node};
 return {requests,events,render,all,text,control:(id:string)=>find(node=>node.props['data-testid']===id),button:(label:string)=>find(node=>node.type==='button'&&content(node)===label),async mount(){render();await settle();render()},async changed(){events[0].onmessage();await settle();render()},unmount(){hooks.forEach(slot=>slot?.cleanup?.())}};
}
const state=(extra:any={})=>({revision:1,selected:null,local:{ready:true,name:'Local recognizer'},connections:[{id:'speech-a',name:'Synthetic speech',endpointUrl:'https://speech.example.invalid/v1/audio/transcriptions',ready:true,models:[{id:'fixture-stt',name:'Fixture STT'}]}],...extra});

test('speech UI displays the actual destination and saves only an explicit model selection through CSRF',async()=>{
 let snapshot=state();const ui=uiFixture((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='PUT'){const body=JSON.parse(options.body);snapshot=state({revision:2,selected:body.connectionId?{connectionId:body.connectionId,modelId:body.modelId}:null})}return response(snapshot)});
 await ui.mount();expect(ui.control('speech-connection').props.value).toBe('');expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);expect(ui.button('Save speech settings').props.disabled).toBe(true);
 ui.control('speech-connection').props.onChange({target:{value:'speech-a'}});ui.render();expect(ui.control('speech-model').props.value).toBe('fixture-stt');expect(ui.text()).toContain('https://speech.example.invalid/v1/audio/transcriptions');expect(ui.text()).toContain('Outside Class 2, speech recognition stays local.');
 await ui.button('Save speech settings').props.onClick();ui.render();const mutation=ui.requests.find(entry=>entry.options.method==='PUT')!;expect(JSON.parse(mutation.options.body)).toEqual({expectedRevision:1,connectionId:'speech-a',modelId:'fixture-stt'});expect(mutation.options.credentials).toBe('same-origin');expect(mutation.options.headers['x-operon-csrf']).toBe('synthetic/voice');expect(ui.requests[ui.requests.indexOf(mutation)-1].path).toBe('/api/csrf');expect(ui.requests.every(entry=>['/api/csrf','/api/local/speech'].includes(entry.path))).toBe(true);ui.unmount();expect(ui.events[0].closed).toBe(true);
});

test('speech settings preserve a draft and its original revision after a live update or conflict',async()=>{
 let snapshot=state();const ui=uiFixture((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='PUT')return response({detail:'Speech settings changed in another window. Reload before saving.'},409);return response(snapshot)});await ui.mount();ui.control('speech-connection').props.onChange({target:{value:'speech-a'}});ui.render();snapshot=state({revision:2});await ui.changed();expect(ui.control('speech-connection').props.value).toBe('speech-a');await ui.button('Save speech settings').props.onClick();ui.render();expect(JSON.parse(ui.requests.find(entry=>entry.options.method==='PUT')!.options.body).expectedRevision).toBe(1);expect(ui.text()).toContain('Reload before saving.');expect(ui.render().props['data-chimeric-dirty']).toBe('true');ui.unmount();
});

test('an unavailable saved speech destination stays selected until the user explicitly selects local recognition',async()=>{
 let snapshot=state({selected:{connectionId:'removed',modelId:'old-stt'}});const ui=uiFixture((path,options)=>{if(path==='/api/csrf')return response({});if(options.method==='PUT')snapshot=state({revision:2});return response(snapshot)});await ui.mount();expect(ui.control('speech-connection').props.value).toBe('removed');expect(ui.control('speech-model').props.value).toBe('old-stt');expect(ui.text()).toContain('It will not switch to another connection.');expect(ui.button('Save speech settings').props.disabled).toBe(true);expect(ui.requests.some(entry=>entry.options.method==='PUT')).toBe(false);
 ui.control('speech-connection').props.onChange({target:{value:''}});ui.render();await ui.button('Save speech settings').props.onClick();ui.render();expect(JSON.parse(ui.requests.find(entry=>entry.options.method==='PUT')!.options.body)).toEqual({expectedRevision:1,connectionId:null});ui.unmount();
});

test('Japanese speech settings explain the destination and permit an explicit resave after interrupted commit recovery',async()=>{
 const translations=JSON.parse(readFileSync(new URL('../src/ja.json',import.meta.url),'utf8'));const ui=uiFixture(()=>response(state({selected:{connectionId:'speech-a',modelId:'fixture-stt'},warning:'The speech selection needs to be saved again before protected recording.'})),translations);await ui.mount();expect(ui.text()).toContain('録音データの送信先');expect(ui.text()).toContain('クラス 2 以外のセッションでは');expect(ui.text()).toContain('もう一度保存してください');expect(ui.button('音声認識の設定を保存').props.disabled).toBe(false);ui.unmount();
});
