import {expect,test} from 'bun:test';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {EventEmitter} from 'node:events';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {nativeVoiceFrontendEdits,nativeVoiceServerEdits,type NativeVoiceEdit} from '../tools/native-voice-context';

const archive=resolve(import.meta.dir,'../../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz'),core=resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science');
const nativeTest=existsSync(archive)&&existsSync(core)?test:test.skip;
let originalFrontend='',patchedFrontend='',patchedServer='';
const apply=(source:string,edits:NativeVoiceEdit[])=>{const sorted=[...edits].sort((a,b)=>b.start-a.start);for(let i=1;i<sorted.length;i++)expect(sorted[i].end).toBeLessThanOrEqual(sorted[i-1].start);for(const edit of sorted)source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);return source};
function frontend(){
 if(patchedFrontend)return patchedFrontend;
 const unpack=Bun.spawnSync(['/usr/bin/tar','-xOf',archive,'./web-dist/assets/index-BgpYmw3d.js'],{stdout:'pipe',stderr:'pipe'});expect(unpack.exitCode).toBe(0);originalFrontend=unpack.stdout.toString();
 patchedFrontend=apply(originalFrontend,nativeVoiceFrontendEdits(parse(originalFrontend,{sourceType:'module'}),originalFrontend));parse(patchedFrontend,{sourceType:'module'});return patchedFrontend;
}
const extracted=new Map<string,string>();
function fn(name:string){if(extracted.has(name))return extracted.get(name)!;const source=frontend(),ast=parse(source,{sourceType:'module'});for(const node of ast.program.body)if(t.isFunctionDeclaration(node)&&node.id)extracted.set(node.id.name,source.slice(node.start!,node.end!));return extracted.get(name)!}
const destination={kind:'remote',name:'Synthetic speech service',endpoint:'https://speech.example/v1/audio/transcriptions',model:'synthetic-whisper'};
const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
function streamFixture(late=false,translations:Record<string,string>={}){
 const sockets:any[]=[],captures:any[]=[],ready:any[]=[],errors:any[]=[],timers:any[]=[],sent:any[]=[];let stopped=0,complete:(value:any)=>void=()=>{};
 const captured=new Promise(resolve=>complete=resolve),handle={stop(){stopped++}};
 class Socket{static CONNECTING=0;static OPEN=1;readyState=0;binaryType='';closed=false;onopen?:Function;onmessage?:Function;onerror?:Function;onclose?:Function;constructor(readonly url:string,readonly protocol?:string){sockets.push(this)}send(value:any){sent.push(value)}close(){this.closed=true;this.readyState=3}open(){this.readyState=1;this.onopen?.()}message(value:any){this.onmessage?.({data:JSON.stringify(value)})}}
 const make=Function('ff','window','AO','WebSocket','Q$t','tFt','eFt','setTimeout','clearTimeout','globalThis',fn('J$t')+';'+fn('nFt')+';return nFt')(()=>'',{location:{protocol:'https:',host:'app.example'}},()=> 'synthetic-native-ws-protocol',Socket,(callback:Function)=>{captures.push(callback);return late?captured:Promise.resolve(handle)},1000,6000,(callback:Function,milliseconds:number)=>{const timer={callback,milliseconds,cleared:false};timers.push(timer);return timer},(timer:any)=>{if(timer)timer.cleared=true},{ChimericI18n:{t:(value:string)=>translations[value]??value}});
 const options={frameId:'root-native-123',language:'ja-JP',onReady:(value:any)=>ready.push(value),onInterim(){},onFinal(){},onError:(...value:any[])=>errors.push(value),onClose(){}};
 const bridge=make(options);return {bridge,sockets,captures,ready,errors,timers,sent,stopped:()=>stopped,complete:()=>complete(handle)};
}
function hookFixture(translations:Record<string,string>={}){
 const slots:any[]=[],effects:Function[]=[],events:any[]=[],options:any[]=[],bridges:any[]=[],released:any[]=[],texts:string[]=[];let index=0,props:any={frameId:'root-a',onText:(text:string)=>texts.push(text),getPrecedingText:()=>''},value:any;
 const same=(a:any[],b:any[])=>a?.length===b?.length&&a.every((entry,i)=>Object.is(entry,b[i]));
 const f={useState(initial:any){const slot=slots[index++]??={value:typeof initial==='function'?initial():initial};return [slot.value,(next:any)=>{slot.value=typeof next==='function'?next(slot.value):next}]},useReducer(reducer:Function,initial:any){const slot=slots[index++]??={value:initial};return [slot.value,(event:any)=>{events.push(event);slot.value=reducer(slot.value,event)}]},useRef(initial:any){return slots[index++]??={current:initial}},useCallback(callback:Function,deps:any[]){const i=index++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={callback,deps};return slots[i].callback},useEffect(callback:Function,deps?:any[]){const slot=slots[index++]??={};if(!deps||!same(slot.deps,deps)){slot.deps=deps;effects.push(()=>{slot.cleanup?.();slot.cleanup=callback()})}}};
 const globals:any={f,A9:()=>class{},K$t:(_state:any,event:any)=>({status:event.type==='start'?'starting':event.type==='recognition-started'?'listening':event.type==='fail'?'error':'idle',error:event.message}),q$t:{status:'idle'},Ud:null,L1:false,qf:(handle:any)=>released.push(handle),pFt(){},DMe(){},$Me(){},mFt(){},xFt(){},Dae:()=>0,bFt(){},e6:100,Iae:(value:any)=>value,J4:()=>false,Q4:(value:any)=>value,FMe(){},Lae(){},nFt:(option:any)=>{const bridge={cancellations:0,cancel(){this.cancellations++},stop(){}};options.push(option);bridges.push(bridge);return bridge},window:{clearTimeout(){},setTimeout(){return 1}},navigator:{language:'en-US'},globalThis:{ChimericI18n:{t:(value:string)=>translations[value]??value}}};
 const hook=Function(...Object.keys(globals),fn('EFt')+';return EFt')(...Object.values(globals));
 const render=(next?:any)=>{if(next)props={...props,...next};index=0;value=hook(props);while(effects.length)effects.shift()!();return value};
 return {render,events,options,bridges,released,texts,value:()=>value,unmount(){for(const slot of slots)slot?.cleanup?.()}};
}

nativeTest('checked frontend edits compose without overlap and bind the actual saved composer root along the complete voice chain',()=>{
 const source=frontend();expect(source).toContain('chimericFrameId:b,ref:kl');expect(source).toContain('frameId:chimericFrameId,onText:e');expect(source).toContain('frameId:e.frameId,language:');expect(source).toContain('J$t(e.language,e.frameId)');
 expect(fn('nFt')).toContain('130000');expect(fn('J$t')).toContain('new URLSearchParams');
},30000);
nativeTest('WebSocket open never collects audio; only one ready event with a verified destination opens the microphone',async()=>{
 const f=streamFixture();expect(f.captures).toHaveLength(0);const socket=f.sockets[0],url=new URL(socket.url);expect(url.protocol).toBe('wss:');expect(url.searchParams.get('frameId')).toBe('root-native-123');expect(url.searchParams.get('language')).toBe('ja-JP');
 socket.open();expect(f.captures).toHaveLength(0);expect(f.sent).toHaveLength(0);socket.message({type:'ready',destination});await settle();expect(f.ready).toEqual([destination]);expect(f.captures).toHaveLength(1);socket.message({type:'ready',destination});expect(f.captures).toHaveLength(1);
 f.captures[0](new Int16Array([1,2]));expect(f.sent).toHaveLength(1);f.bridge.stop();expect(f.sent.at(-1)).toBe('{"type":"stop"}');expect(f.timers.at(-1).milliseconds).toBe(130000);f.bridge.cancel();expect(f.stopped()).toBe(1);
});
nativeTest('legacy or malformed readiness, pre-ready stop and cancellation collect no microphone data',async()=>{
 for(const value of [undefined,{kind:'remote',name:'Synthetic',endpoint:'https://speech.example'},{kind:'local',name:''}]){const f=streamFixture();f.sockets[0].open();f.sockets[0].message({type:'ready',destination:value});await settle();expect(f.captures).toHaveLength(0);expect(f.ready).toHaveLength(0);expect(f.errors[0][1]).toBe('scope_changed');expect(f.sockets[0].closed).toBe(true)}
 for(const action of ['stop','cancel']){const f=streamFixture();f.bridge[action]();f.sockets[0].open();f.sockets[0].message({type:'ready',destination});await settle();expect(f.captures).toHaveLength(0);expect(f.ready).toHaveLength(0)}
});
nativeTest('a microphone acquisition resolving after cancellation stops its tracks and sends no samples',async()=>{
 const f=streamFixture(true);f.sockets[0].open();f.sockets[0].message({type:'ready',destination});expect(f.captures).toHaveLength(1);f.bridge.cancel();f.complete();await settle();expect(f.stopped()).toBe(1);f.captures[0](new Int16Array([1]));expect(f.sent).toHaveLength(0);
});
nativeTest('URL construction retains native base paths and supports a frame without a language',()=>{
 const make=(base:string)=>Function('ff','window',fn('J$t')+';return J$t')(()=>base,{location:{protocol:'https:',host:'app.example'}});
 const local=new URL(make('')(undefined,'saved-root'));expect(local.searchParams.get('frameId')).toBe('saved-root');expect(local.searchParams.has('language')).toBe(false);
 const prefixed=new URL(make('/workbench')('ja-JP','saved-root'));expect(prefixed.pathname).toBe('/workbench/api/voice/stream');expect(prefixed.searchParams.get('language')).toBe('ja-JP');expect(prefixed.searchParams.get('frameId')).toBe('saved-root');
 const remote=new URL(make('https://native.example/prefix')('en-US','saved-root'));expect(remote.protocol).toBe('wss:');expect(remote.pathname).toBe('/prefix/api/voice/stream');
});
nativeTest('the existing hook forwards frame scope and destination, then cancels on the real frame change',()=>{
 const f=hookFixture();f.render();f.value().start();expect(f.options[0].frameId).toBe('root-a');f.options[0].onReady(destination);f.render();expect(f.value().destination).toEqual(destination);
 f.render({frameId:'root-b'});f.render();expect(f.bridges[0].cancellations).toBe(1);expect(f.value().destination).toBeNull();expect(f.value().isActive()).toBe(false);
 f.value().start();expect(f.options[1].frameId).toBe('root-b');f.unmount();
});
nativeTest('server policy failure before microphone readiness preserves its actual reason and releases native capture ownership',()=>{
 const f=hookFixture();f.render();f.value().start();f.options[0].onError('This chat policy changed. Start recording again.','stt_scope_changed');f.render();expect(f.value().error).toBe('This chat policy changed. Start recording again.');expect(f.value().destination).toBeNull();expect(f.value().isActive()).toBe(false);expect(f.bridges[0].cancellations).toBe(1);expect(f.released).toHaveLength(1);f.unmount();
});
nativeTest('Japanese voice errors translate trusted fixed messages without translating transcript or destination data',async()=>{
 const ja=JSON.parse(readFileSync(resolve(import.meta.dir,'../src/ja.json'),'utf8')),message='The speech permission changed during recording.';
 const malformed=streamFixture(false,ja);malformed.sockets[0].open();malformed.sockets[0].message({type:'ready'});await settle();expect(malformed.errors[0][0]).toBe(ja['The speech destination could not be verified. No audio was captured.']);expect(malformed.captures).toHaveLength(0);
 const before=hookFixture(ja);before.render();before.value().start();before.options[0].onError(message,'stt_scope_changed');before.render();expect(before.value().error).toBe(ja[message]);before.unmount();
 const after=hookFixture(ja);after.render();after.value().start();const exact={...destination,name:'Speech model',model:'Unknown'};after.options[0].onReady(exact);after.render();expect(after.value().destination).toEqual(exact);after.options[0].onFinal(message);expect(after.texts).toEqual([message]);after.options[0].onError(message,'stt_scope_changed');after.render();expect(after.value().error).toBe(ja[message]);after.unmount();
});
nativeTest('visible native microphone label shows the ready destination and root-scopes the existing focus handoff',()=>{
 const options:any[]=[],a={Fragment:'fragment',jsx:(type:any,props:any)=>({type,props}),jsxs:(type:any,props:any)=>({type,props})},f={useEffect(){},useRef:(value:any)=>({current:value})};
 const globals:any={f,a,EFt:(value:any)=>{options.push(value);return {supported:true,engine:'server',status:'listening',listening:true,destination,error:null,isActive:()=>true,isForeignSessionActive:()=>false}},kFt:()=>({active:false}),Jo:()=>({doc:{}}),t6:'Shortcut',an:(...parts:any[])=>parts.join(' '),irt:'error-icon',ort:'microphone-icon'};
 const control=Function(...Object.keys(globals),fn('Qj')+';return Qj')(...Object.values(globals)),tree=control({chimericFrameId:'root-a',handoffContextKey:'composer'});
 const children=tree.props.children,label=children.find((child:any)=>child?.props?.['data-testid']==='voice-destination-label');expect(label.props.children).toBe('Speech destination: Synthetic speech service · speech.example · synthetic-whisper');expect(label.props.className).not.toContain('sr-only');expect(label.props.title).toBe(destination.endpoint);expect(options[0].frameId).toBe('root-a');expect(options[0].handoffContextKey).toBe('root-a:composer');
});
nativeTest('checked native server forwards only a string frame lookup key into the existing bridge constructor',async()=>{
 const original=readFileSync(core,'utf8'),edits=nativeVoiceServerEdits(parse(original,{sourceType:'unambiguous'}),original);expect(edits.map(edit=>edit.label)).toEqual(['native-voice-server-frame']);
 patchedServer=apply(original,edits);const ast=parse(patchedServer,{sourceType:'unambiguous'}),node=ast.program.body.find((entry:any)=>t.isFunctionDeclaration(entry)&&entry.id?.name==='gfi')!;expect(node).toBeDefined();const source=patchedServer.slice(node.start!,node.end!),options:any[]=[],routes:any[]=[];
 class Bridge{constructor(_downstream:any,value:any){options.push(value)}handleBrowserMessage(){}handleBrowserClose(){}async start(){}}
 const install=Function('ov','EUt','dir','e8c',source+';return gfi')(()=>()=>{},()=>true,Bridge,()=>{throw Error('Credential resolution must not run in this test')});
 install({get:(...args:any[])=>routes.push(args),log:{warn(){}}});
 for(const frameId of ['root-native-123',undefined,['root-a','root-b']]){const socket=Object.assign(new EventEmitter(),{readyState:1,send(){},close(){}});routes[0][2](socket,{headers:{origin:'https://app.example'},query:{frameId,language:'ja-JP',class2:false,rootFrameId:'FORGED'}})}
 expect(options.map(value=>value.frameId)).toEqual(['root-native-123',undefined,undefined]);expect(options[0].rootFrameId).toBeUndefined();expect(options[0].class2).toBeUndefined();expect(options.every(value=>value.language==='ja-JP')).toBe(true);await settle();
},30000);
nativeTest('any readiness/capture integrity drift or duplicate helper application fails closed',()=>{
 frontend();const changed=originalFrontend.replace('case"ready":e.onReady();break','case"ready":e.onReady({});break');expect(changed).not.toBe(originalFrontend);expect(()=>nativeVoiceFrontendEdits(parse(changed,{sourceType:'module'}),changed)).toThrow('integrity');
 expect(()=>nativeVoiceFrontendEdits(parse(patchedFrontend,{sourceType:'module'}),patchedFrontend)).toThrow('integrity');
},30000);
const linuxCore=resolve(import.meta.dir,'../../../work/chimeric-linux-probe/recovered-production-reader/claude-science');
(existsSync(linuxCore)?test:test.skip)('the independently verified Linux native voice route receives the same scoped lookup key without guessing aliases',()=>{
 const source=readFileSync(linuxCore,'utf8'),edits=nativeVoiceServerEdits(parse(source,{sourceType:'unambiguous'}),source);expect(edits).toHaveLength(1);expect(edits[0].text).toBe('frameId:typeof a.frameId==="string"?a.frameId:void 0,');parse(apply(source,edits),{sourceType:'unambiguous'});
 const changed=source.replace('d=new xir(c,{getAccessToken:', 'd=new xir(c,{changedToken:');expect(changed).not.toBe(source);expect(()=>nativeVoiceServerEdits(parse(changed,{sourceType:'unambiguous'}),changed)).toThrow('integrity');
},30000);
