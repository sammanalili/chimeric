import {createHash} from 'node:crypto';
import * as t from '@babel/types';

export type NativeVoiceEdit={start:number;end:number;text:string;label:string};
const hashes={
 J$t:'913c70eecd92b93ca4d0384847297818cfc6286927259177b65c42e6f09c1449',
 nFt:'60786ebf5b4264ab8497d2108c9c23a6eb856a9b03a8a342c9a06e31319a53b4',
 EFt:'166f89046a5fdeed40aec1a88a87a3345637baf4a69a2bbacc9701cb2cf3657e',
 Qj:'73847aaac56aa1d66931b5ea714e47ebfd038fa48f940083f63aa11858e760b3',
 gfi:'c95f7e1e707d550b6e78d1bbc7faa74423e6ba9b8d1adc48357daf4edd547d49',
 ehi:'49424ada594fc95c8ad9c49030479f33887d0c699a32049f33b02e378b88b19e',
};
const fail=(label:string):never=>{throw Error('Native voice context boundary changed: '+label)};
function range(node:t.Node,label:string){if(node.start==null||node.end==null)fail(label);return {start:node.start!,end:node.end!}}
function nodes<T extends t.Node>(root:t.Node,predicate:(node:t.Node)=>node is T):T[]{const values:T[]=[];t.traverseFast(root,node=>{if(predicate(node))values.push(node)});return values}
function only<T>(values:T[],label:string):T{if(values.length!==1)fail(label);return values[0]}
function declaration(root:t.Node,name:string){return only(nodes(root,(node):node is t.VariableDeclarator=>t.isVariableDeclarator(node)&&t.isIdentifier(node.id,{name})),name)}
function property(root:t.ObjectExpression|t.ObjectPattern,name:string){return only(root.properties.filter((node):node is t.ObjectProperty=>t.isObjectProperty(node)&&!node.computed&&(t.isIdentifier(node.key,{name})||t.isStringLiteral(node.key,{value:name}))),name)}
function callback(root:t.Node,name:string){const value=declaration(root,name).init;if(!t.isCallExpression(value)||!t.isArrowFunctionExpression(value.arguments[0]))fail(name);return value.arguments[0] as t.ArrowFunctionExpression}
function checkedFunction(ast:t.Node,source:string,name:keyof typeof hashes){
 const fn=only(nodes(ast,(node):node is t.FunctionDeclaration=>t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name})),name);
 if(createHash('sha256').update(source.slice(fn.start!,fn.end!)).digest('hex')!==hashes[name])fail(name+' integrity');return fn;
}
function sourceOf(source:string,node:t.Node){const bounds=range(node,'source');return source.slice(bounds.start,bounds.end)}

/** Compose these edits with existing branding edits against the same original
 * AST. No browser mode/endpoint/approval becomes server authority. Only the
 * composer's actual saved root is forwarded as a native datastore lookup key. */
export function nativeVoiceFrontendEdits(ast:t.Node,source:string):NativeVoiceEdit[]{
 const edits:NativeVoiceEdit[]=[],replace=(node:t.Node,text:string,label:string)=>edits.push({...range(node,label),text,label}),insert=(position:number|null|undefined,text:string,label:string)=>{if(position==null)fail(label);edits.push({start:position!,end:position!,text,label})};
 const url=checkedFunction(ast,source,'J$t'),stream=checkedFunction(ast,source,'nFt'),hook=checkedFunction(ast,source,'EFt'),control=checkedFunction(ast,source,'Qj');
 if(url.params.length!==1||!t.isIdentifier(url.params[0],{name:'e'}))fail('URL parameters');
 insert(url.params[0].end,',chimericFrameId','native-voice-url-frame-parameter');
 const path=declaration(url,'s');if(!path.init||!t.isTemplateLiteral(path.init))fail('URL path');
 replace(path.init,'"/api/voice/stream"+((chimericParams)=>chimericParams.size?"?"+chimericParams.toString():"")(new URLSearchParams({...e?{language:e}:{},...typeof chimericFrameId==="string"&&chimericFrameId?{frameId:chimericFrameId}:{}}))','native-voice-url-frame-query');
 const urlCall=only(nodes(stream,(node):node is t.CallExpression=>t.isCallExpression(node)&&t.isIdentifier(node.callee,{name:'J$t'})),'stream URL');
 if(urlCall.arguments.length!==1||!t.isMemberExpression(urlCall.arguments[0])||sourceOf(source,urlCall.arguments[0])!=='e.language')fail('stream URL arguments');
 insert(urlCall.arguments[0].end,',e.frameId','native-voice-stream-frame');
 insert(stream.body.start!+1,'let chimericCaptureStarted=!1;','native-voice-capture-once');
 const streamReturn=only(stream.body.body.filter(node=>t.isReturnStatement(node)),'stream return') as t.ReturnStatement;
 if(!t.isSequenceExpression(streamReturn.argument))fail('stream lifecycle');
 const capture=only(streamReturn.argument.expressions.filter(expression=>sourceOf(source,expression).startsWith('Q$t(m).then(')),'microphone lifecycle');
 const ready=only(nodes(stream,(node):node is t.SwitchCase=>t.isSwitchCase(node)&&t.isStringLiteral(node.test,{value:'ready'})),'stream readiness');
 if(ready.consequent.length!==2||!t.isExpressionStatement(ready.consequent[0])||sourceOf(source,ready.consequent[0])!=='e.onReady();'||!t.isBreakStatement(ready.consequent[1]))fail('readiness event');
 // Opening the WebSocket never opens the microphone. A legacy or malformed
 // ready event without a bound destination fails before collecting audio.
 const destinationValid='chimericDestination&&["local","remote"].includes(chimericDestination.kind)&&typeof chimericDestination.name==="string"&&chimericDestination.name.length>0&&chimericDestination.name.length<=512&&(chimericDestination.kind!=="remote"||typeof chimericDestination.endpoint==="string"&&chimericDestination.endpoint.length>0&&chimericDestination.endpoint.length<=8192&&typeof chimericDestination.model==="string"&&chimericDestination.model.length>0&&chimericDestination.model.length<=512)';
 replace(ready.consequent[0],`if(!t&&!n&&!chimericCaptureStarted){const chimericDestination=y.destination;if(!(${destinationValid})){t=!0,h(),e.onError(globalThis.ChimericI18n?.t?.("The speech destination could not be verified. No audio was captured.")??"The speech destination could not be verified. No audio was captured.","scope_changed");break}chimericCaptureStarted=!0;e.onReady(chimericDestination);${sourceOf(source,capture)}}`,'native-voice-ready-before-microphone');
 replace(capture,'void 0','native-voice-remove-eager-microphone');
 const drain=only(nodes(stream,(node):node is t.CallExpression=>t.isCallExpression(node)&&t.isIdentifier(node.callee,{name:'setTimeout'})&&t.isIdentifier(node.arguments[1],{name:'eFt'})),'stop drain timeout');
 replace(drain.arguments[1] as t.Node,'130000','native-voice-bounded-transcription-drain');

 insert(hook.body.start!+1,'const[chimericDestination,chimericSetDestination]=f.useState(null),chimericPreviousFrame=f.useRef(e.frameId);','native-voice-destination-state');
 const start=callback(hook,'q');if(!t.isBlockStatement(start.body)||!t.isIfStatement(start.body.body[0]))fail('hook start');
 insert(start.body.body[0].end,'chimericSetDestination(null);','native-voice-clear-start-destination');
 const streamCall=only(nodes(start,(node):node is t.CallExpression=>t.isCallExpression(node)&&t.isIdentifier(node.callee,{name:'nFt'})),'hook stream');
 if(streamCall.arguments.length!==1||!t.isObjectExpression(streamCall.arguments[0]))fail('hook stream options');
 const options=streamCall.arguments[0] as t.ObjectExpression;
 insert(options.start!+1,'frameId:e.frameId,','native-voice-hook-frame');
 const startInit=declaration(hook,'q').init as t.CallExpression,deps=startInit.arguments[1];if(!t.isArrayExpression(deps)||sourceOf(source,deps)!=='[L,$]')fail('hook dependencies');
 insert(deps.end!-1,',e.frameId','native-voice-hook-frame-dependency');
 const onReady=property(options,'onReady'),onClose=property(options,'onClose'),onError=property(options,'onError');
 if(!t.isArrowFunctionExpression(onReady.value)||sourceOf(source,onReady.value)!=='()=>{J()&&(G=!0,m({type:"recognition-started"}))}')fail('hook ready');
 replace(onReady.value,'chimericValue=>{J()&&(G=!0,chimericSetDestination(chimericValue),m({type:"recognition-started"}))}','native-voice-ready-destination');
 for(const [name,value]of [['close',onClose.value],['error',onError.value]] as const){if(!t.isArrowFunctionExpression(value)||!t.isBlockStatement(value.body))fail('hook '+name);insert(value.body.start!+1,'if(J())chimericSetDestination(null);'+(name==='error'?'if(typeof oe==="string")oe=globalThis.ChimericI18n?.t?.(oe)??oe;':''),'native-voice-clear-'+name+'-destination')}
 const earlyError=only(nodes(onError.value,(node):node is t.IfStatement=>t.isIfStatement(node)&&t.isUnaryExpression(node.test,{operator:'!'})&&t.isIdentifier(node.test.argument,{name:'G'})),'early server error');
 if(sourceOf(source,earlyError)!=='if(!G){ge(!j.current);return}')fail('early error handling');
 replace(earlyError,'if(!G){if(fe==="scope_changed"||typeof fe==="string"&&fe.startsWith("stt_")){E.current=!1,$(""),b.current=null,ne.cancel(),m({type:"fail",message:oe}),qf(H.current)}else ge(!j.current);return}','native-voice-preserve-preflight-error');
 const cancel=callback(hook,'V');if(!t.isBlockStatement(cancel.body))fail('hook cancel');insert(cancel.body.start!+1,'chimericSetDestination(null);','native-voice-clear-cancel-destination');
 const hookReturn=only(hook.body.body.filter(node=>t.isReturnStatement(node)),'hook return') as t.ReturnStatement;
 if(!t.isSequenceExpression(hookReturn.argument)||!t.isObjectExpression(hookReturn.argument.expressions.at(-1)))fail('hook result');
 const result=hookReturn.argument.expressions.at(-1) as t.ObjectExpression;
 insert(result.start!+1,'destination:chimericDestination,','native-voice-hook-destination');
 insert(hookReturn.start,'f.useEffect(()=>{if(chimericPreviousFrame.current!==e.frameId){chimericPreviousFrame.current=e.frameId;V();chimericSetDestination(null)}},[e.frameId,V]);','native-voice-cancel-frame-change');

 if(control.params.length!==1||!t.isObjectPattern(control.params[0]))fail('control props');
 insert(control.params[0].start!+1,'chimericFrameId,','native-voice-control-frame');
 const hookCall=only(nodes(control,(node):node is t.CallExpression=>t.isCallExpression(node)&&t.isIdentifier(node.callee,{name:'EFt'})),'control hook');
 if(hookCall.arguments.length!==1||!t.isObjectExpression(hookCall.arguments[0]))fail('control hook arguments');
 const hookOptions=hookCall.arguments[0];insert(hookOptions.start!+1,'frameId:chimericFrameId,','native-voice-control-hook-frame');
 const handoff=property(hookOptions,'handoffContextKey');if(!t.isIdentifier(handoff.value,{name:'i'}))fail('handoff context');
 replace(handoff.value,'chimericFrameId?chimericFrameId+":"+(i??""):void 0','native-voice-handoff-scope');
 const hookBinding=only(nodes(control,(node):node is t.VariableDeclarator=>t.isVariableDeclarator(node)&&node.init===hookCall),'control hook binding');
 if(!t.isObjectPattern(hookBinding.id))fail('control hook result');insert(hookBinding.id.start!+1,'destination:chimericVoiceDestination,','native-voice-control-destination');
 insert(control.body.start!+1,'const chimericVoiceLabel=chimericValue=>{if(!chimericValue)return"";const chimericText=globalThis.ChimericI18n?.t?.("Speech destination")??"Speech destination";if(chimericValue.kind==="local")return chimericText+": "+chimericValue.name;let chimericHost;try{chimericHost=new URL(chimericValue.endpoint).host}catch{chimericHost="Unknown destination"}return chimericText+": "+chimericValue.name+" · "+chimericHost+" · "+chimericValue.model;};','native-voice-visible-destination-formatter');
 const title=only(nodes(control,(node):node is t.ObjectProperty=>t.isObjectProperty(node)&&t.isIdentifier(node.key,{name:'title'})&&t.isIdentifier(node.value,{name:'D'})),'control title');
 replace(title.value,'D+(chimericVoiceDestination?" · "+chimericVoiceLabel(chimericVoiceDestination):"")','native-voice-destination-tooltip');
 const returned=only(control.body.body.filter(node=>t.isReturnStatement(node)),'control return') as t.ReturnStatement;if(!t.isCallExpression(returned.argument)||!t.isObjectExpression(returned.argument.arguments[1]))fail('control fragment');
 const children=property(returned.argument.arguments[1],'children').value;if(!t.isArrayExpression(children)||children.elements.length!==2||!children.elements[0])fail('control children');
 insert(children.elements[0].end,',chimericVoiceDestination&&a.jsx("span",{"data-testid":"voice-destination-label",className:"text-xs text-text-300",style:{maxWidth:"14rem",overflowWrap:"anywhere"},title:chimericVoiceDestination.kind==="remote"?chimericVoiceDestination.endpoint:void 0,children:chimericVoiceLabel(chimericVoiceDestination)})','native-voice-visible-destination');
 const status=only(nodes(children.elements[1]!,((node:t.Node):node is t.ObjectProperty=>t.isObjectProperty(node)&&t.isIdentifier(node.key,{name:'children'})&&t.isIdentifier(node.value,{name:'$'}))),'control live status');
 replace(status.value,'$+(chimericVoiceDestination?" "+chimericVoiceLabel(chimericVoiceDestination):"")','native-voice-accessible-destination');
 const composer=only(nodes(ast,(node):node is t.VariableDeclarator=>t.isVariableDeclarator(node)&&t.isIdentifier(node.id,{name:'Y9'})),'composer');
 const controlCall=only(nodes(composer,(node):node is t.CallExpression=>t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'jsx'})&&t.isIdentifier(node.arguments[0],{name:'Qj'})),'composer microphone');
 if(!t.isObjectExpression(controlCall.arguments[1])||sourceOf(source,property(controlCall.arguments[1],'data-testid').value)!=='"composer-mic-btn"')fail('composer microphone props');
 insert(controlCall.arguments[1].start!+1,'chimericFrameId:b,','native-voice-composer-scope');
 return edits;
}

/** The query value is merely a lookup key from an authenticated native
 * WebSocket request. The injected capture resolver must check its owner and
 * current policy before emitting ready or collecting any audio. */
export function nativeVoiceServerEdits(ast:t.Node,source:string):NativeVoiceEdit[]{
 const candidate=only(nodes(ast,(node):node is t.FunctionDeclaration=>t.isFunctionDeclaration(node)&&!!node.id&&['gfi','ehi'].includes(node.id.name)&&sourceOf(source,node.body).includes('"/api/voice/stream"')),'server voice route');
 const name=candidate.id!.name as 'gfi'|'ehi',fn=checkedFunction(ast,source,name),bridge=name==='gfi'?'dir':'xir';
 const constructor=only(nodes(fn,(node):node is t.NewExpression=>t.isNewExpression(node)&&t.isIdentifier(node.callee,{name:bridge})),'server bridge constructor');
 if(constructor.arguments.length!==2||!t.isObjectExpression(constructor.arguments[1]))fail('server bridge options');
 const options=constructor.arguments[1];property(options,'getAccessToken');property(options,'language');property(options,'log');
 return [{start:options.start!+1,end:options.start!+1,text:'frameId:typeof a.frameId==="string"?a.frameId:void 0,',label:'native-voice-server-frame'}];
}
