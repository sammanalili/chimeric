import {test,expect} from 'bun:test';
import {encodePcm16Wav,transcribePcm16,createRecordedVoiceBridge,sttLimits,SttError,type SttTarget,type SttCapture,type SttChange,type RecordedVoiceDependencies} from '../src/stt';

const target:SttTarget={connectionId:'synthetic-stt',name:'Synthetic speech',baseUrl:'https://speech.example.invalid/v1',modelId:'synthetic-transcriber',connectionRevision:'revision-1',credentialRevision:'a'.repeat(64),modelRevision:'catalog-1'};
const audio=Buffer.from([0,0,1,0,255,127,0,128]);
const secret='synthetic-stt-key';
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return {resolve,promise}}
const capture=(extra:Partial<SttCapture>={}):SttCapture=>({frameId:'frame-1',rootFrameId:'root-1',policyRevision:3,dataClass:'class2',context:Object.freeze({trusted:true}),target:{kind:'remote',...target},...extra});
function bridgeFixture(extra:Partial<RecordedVoiceDependencies>={}){
 const events:any[]=[],requests:any[]=[],checks:string[]=[],listeners=new Set<(change?:SttChange)=>void>();let authCalls=0,closes=0;
 const deps:RecordedVoiceDependencies={capture:()=>capture(),assertCurrent:(_capture,phase)=>{checks.push(phase)},subscribeChanges:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}},resolveAuth:()=>{authCalls++;return {apiKey:secret}},fetch:(async(url:any,init:any)=>{requests.push({url,init});return Response.json({text:'Synthetic transcript'})}) as typeof fetch,...extra};
 const Bridge=createRecordedVoiceBridge(deps),voice=new Bridge({sendEvent:event=>events.push(event),close:()=>{closes++}},{language:'en-US',class2:false,rootFrameId:'forged-browser-root'});
 return {voice,Bridge,deps,events,requests,checks,listeners,get authCalls(){return authCalls},get closes(){return closes},async complete(){voice.handleBrowserMessage(audio,true);voice.handleBrowserMessage('{"type":"stop"}',false);for(let i=0;i<50&&!closes;i++)await settle();expect(closes).toBe(1)}};
}

test('PCM16 WAV encoding retains exact audio bytes and declares 16 kHz mono signed PCM',()=>{
 const wav=encodePcm16Wav(audio);expect(wav.subarray(0,4).toString()).toBe('RIFF');expect(wav.readUInt32LE(4)).toBe(36+audio.length);expect(wav.subarray(8,12).toString()).toBe('WAVE');expect(wav.readUInt16LE(20)).toBe(1);expect(wav.readUInt16LE(22)).toBe(1);expect(wav.readUInt32LE(24)).toBe(16000);expect(wav.readUInt32LE(28)).toBe(32000);expect(wav.readUInt16LE(34)).toBe(16);expect(wav.readUInt32LE(40)).toBe(audio.length);expect(wav.subarray(44)).toEqual(audio);
 for(const pcm of [Buffer.alloc(0),Buffer.alloc(3),Buffer.alloc(sttLimits.pcmBytes+2)])expect(()=>encodePcm16Wav(pcm)).toThrow(SttError);
});

test('remote transcription serializes one real multipart form with a WAV and pins authorization to the selected prefix',async()=>{
 let calls=0,assertions=0,verificationError:any;
 const result=await transcribePcm16({target,pcm:audio,language:'ja-JP'},{resolveAuth:bound=>{expect(bound).toMatchObject(target);return {apiKey:secret,assertCurrent(){assertions++}}},fetch:(async(url:any,init:any)=>{try{
  calls++;expect(url).toBe('https://speech.example.invalid/v1/audio/transcriptions');expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error');expect(init.cache).toBe('no-store');expect(new Headers(init.headers).get('authorization')).toBe('Bearer '+secret);
  expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);expect(((init.body as FormData).get('file') as File).type).toBe('audio/wav');const request=new Request(url,init);expect(request.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);const form=await request.formData();expect([...form.keys()].sort()).toEqual(['file','language','model','response_format']);expect(form.get('model')).toBe(target.modelId);expect(form.get('language')).toBe('ja');expect(form.get('response_format')).toBe('json');const file=form.get('file') as File;expect(file.name).toBe('recording.wav');expect(['audio/wav','audio/x-wav']).toContain(file.type);expect(Buffer.from(await file.arrayBuffer())).toEqual(encodePcm16Wav(audio));return Response.json({text:'テストの文章'});
 }catch(error){verificationError=error;throw error}}) as typeof fetch}).catch(error=>{throw verificationError??error});
 expect(result).toEqual({text:'テストの文章',connectionId:target.connectionId,model:target.modelId});expect(calls).toBe(1);expect(assertions).toBe(3);expect(audio).toEqual(Buffer.from([0,0,1,0,255,127,0,128]));
});

test('invalid destinations, missing revisions and invalid audio fail before credential retrieval',async()=>{
 for(const change of [{baseUrl:'https://user:secret@example.invalid/v1'},{baseUrl:'https://speech.example.invalid/v1?key=x'},{baseUrl:'https://speech.example.invalid/v1#x'},{baseUrl:'http://remote.example.invalid/v1'},{baseUrl:'file:///tmp/audio'},{credentialRevision:'raw-secret'},{connectionRevision:''}]){
  let auth=0;await expect(transcribePcm16({target:{...target,...change},pcm:audio},{resolveAuth:()=>{auth++;return {apiKey:secret}}})).rejects.toBeInstanceOf(SttError);expect(auth).toBe(0);
 }
 let auth=0;await expect(transcribePcm16({target,pcm:Buffer.alloc(3)},{resolveAuth:()=>{auth++;return {}}})).rejects.toMatchObject({code:'invalid_request'});expect(auth).toBe(0);
});

test('HTTP failures, raw diagnostic errors and malformed responses never retry or expose audio or credentials',async()=>{
 for(const response of [new Response('synthetic raw audio '+secret,{status:429}),new Response('<html>Login</html>',{headers:{'content-type':'text/html'}}),Response.json({text:12}),Response.json({text:'x'.repeat(sttLimits.transcriptBytes+1)}),new Response('{broken',{headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'application/json','content-length':String(sttLimits.responseBytes+1)}})]){
  let requests=0;let error:any;try{await transcribePcm16({target,pcm:audio},{resolveAuth:()=>({apiKey:secret}),fetch:(async()=>{requests++;return response})as typeof fetch})}catch(value){error=value}
  expect(error).toBeInstanceOf(SttError);expect(error.message).not.toContain(secret);expect(error.message).not.toContain('synthetic raw audio');expect(requests).toBe(1);
 }
 await expect(transcribePcm16({target,pcm:audio},{resolveAuth:()=>({apiKey:secret}),fetch:(async()=>{throw Error(secret+' '+audio.toString('base64'))})as typeof fetch})).rejects.toMatchObject({code:'network',message:'The speech request could not complete at the selected endpoint. No request was retried.'});
});

test('timeouts cover credentials, headers and streamed JSON body; cancellation prevents transcript completion',async()=>{
 await expect(transcribePcm16({target,pcm:audio,timeoutMs:10},{resolveAuth:()=>new Promise(()=>{})})).rejects.toMatchObject({code:'timeout'});
 await expect(transcribePcm16({target,pcm:audio,timeoutMs:10},{resolveAuth:()=>({}),fetch:(async()=>new Promise(()=>{}))as typeof fetch})).rejects.toMatchObject({code:'timeout'});
 let cancelled=false;await expect(transcribePcm16({target,pcm:audio,timeoutMs:10},{resolveAuth:()=>({}),fetch:(async()=>new Response(new ReadableStream({start(stream){stream.enqueue(new TextEncoder().encode('{"text":'))},cancel(){cancelled=true}}),{headers:{'content-type':'application/json'}}))as typeof fetch})).rejects.toMatchObject({code:'timeout'});expect(cancelled).toBe(true);
 const account=new AbortController();await expect(transcribePcm16({target,pcm:audio},{resolveAuth:()=>({signal:account.signal}),fetch:(async()=>{account.abort();return Response.json({text:'Must not escape'})})as typeof fetch})).rejects.toMatchObject({code:'cancelled'});
});

test('recorded bridge receives trusted scope before ready, buffers without uploads, and repeated Stop sends one final request',async()=>{
 const f=bridgeFixture();await f.voice.start();expect(f.checks).toEqual(['capture']);expect(f.events).toEqual([{type:'ready',destination:{kind:'remote',name:'Synthetic speech',connectionId:target.connectionId,endpoint:'https://speech.example.invalid/v1/audio/transcriptions',model:target.modelId}}]);
 f.voice.handleBrowserMessage(audio.subarray(0,4),true);f.voice.handleBrowserMessage(audio.subarray(4),true);await settle();expect(f.requests).toHaveLength(0);expect(f.authCalls).toBe(0);
 f.voice.handleBrowserMessage('{"type":"stop"}',false);f.voice.handleBrowserMessage('{"type":"stop"}',false);f.voice.handleBrowserMessage(audio,true);
 for(let i=0;i<30&&!f.closes;i++)await settle();expect(f.requests).toHaveLength(1);expect(f.authCalls).toBe(1);expect(f.events.map(event=>event.type)).toEqual(['ready','transcript','closed']);expect(f.checks).toEqual(['capture','upload','upload','completion']);expect(f.listeners.size).toBe(0);expect(f.closes).toBe(1);
});

test('explicit local capture uses only the local recognizer and never resolves an external credential',async()=>{
 let local=0;const f=bridgeFixture({capture:()=>capture({dataClass:'standard',target:{kind:'local'}}),transcribeLocal:(pcm,language)=>{local++;expect(pcm).toEqual(audio);expect(language).toBe('en');return 'Local synthetic transcript'}});await f.voice.start();await f.complete();expect(local).toBe(1);expect(f.authCalls).toBe(0);expect(f.requests).toHaveLength(0);expect(f.events[1]).toMatchObject({type:'transcript',text:'Local synthetic transcript'});
 const missing=bridgeFixture({capture:()=>capture({dataClass:'standard',target:{kind:'local'}})});await missing.voice.start();await missing.complete();expect(missing.requests).toHaveLength(0);expect(missing.events.some(event=>event.type==='error'&&event.message.includes('No external fallback'))).toBe(true);
});

test('Class 2 rejects insecure HTTP even with a trusted ordinary-mode opt-in',async()=>{
 const unsafe={kind:'remote' as const,...target,baseUrl:'http://private.example.invalid/v1',allowInsecureHttp:true};
 const f=bridgeFixture({capture:()=>capture({target:unsafe})});await f.voice.start();expect(f.events[0]).toMatchObject({type:'error',code:'stt_unavailable'});expect(f.authCalls).toBe(0);expect(f.requests).toHaveLength(0);
 const ordinary=bridgeFixture({capture:()=>capture({dataClass:'standard',target:unsafe})});await ordinary.voice.start();await ordinary.complete();expect(ordinary.requests[0].url).toBe('http://private.example.invalid/v1/audio/transcriptions');
});

test('changes and a stale pre-upload check cancel a buffered recording before credentials or audio leave',async()=>{
 const f=bridgeFixture();await f.voice.start();f.voice.handleBrowserMessage(audio,true);for(const listener of [...f.listeners])listener({kind:'session',rootFrameId:'root-1'});f.voice.handleBrowserMessage('{"type":"stop"}',false);await settle();expect(f.authCalls).toBe(0);expect(f.requests).toHaveLength(0);expect(f.events.some(event=>event.code==='stt_scope_changed')).toBe(true);
 const stale=bridgeFixture({assertCurrent:(_capture,phase)=>{if(phase==='upload')throw Error('Synthetic scope changed')}});await stale.voice.start();await stale.complete();expect(stale.authCalls).toBe(0);expect(stale.requests).toHaveLength(0);expect(stale.events.some(event=>event.type==='transcript')).toBe(false);
});

test('policy changes during upload abort the request and suppress late transcripts',async()=>{
 const pending=deferred<Response>();let signal!:AbortSignal;
 const f=bridgeFixture({fetch:(async(_url:any,init:any)=>{signal=init.signal;return pending.promise})as typeof fetch});await f.voice.start();f.voice.handleBrowserMessage(audio,true);f.voice.handleBrowserMessage('{"type":"stop"}',false);for(let i=0;i<20&&!signal;i++)await settle();expect(signal.aborted).toBe(false);
 for(const listener of [...f.listeners])listener({kind:'connection',connectionId:target.connectionId});expect(signal.aborted).toBe(true);pending.resolve(Response.json({text:'Late transcript'}));await settle();await settle();expect(f.events.some(event=>event.type==='transcript')).toBe(false);expect(f.closes).toBe(1);
});

test('malformed control messages cannot override the capture policy, and recording resource failures upload nothing',async()=>{
 for(const message of ['{"type":"stop","class2":false}','{"type":"set_target","endpoint":"https://other.invalid"}']){const f=bridgeFixture();await f.voice.start();f.voice.handleBrowserMessage(audio,true);f.voice.handleBrowserMessage(message,false);expect(f.requests).toHaveLength(0);expect(f.authCalls).toBe(0);expect(f.events.some(event=>event.code==='stt_invalid_request')).toBe(true)}
 const large=bridgeFixture({limits:{pcmBytes:4}});await large.voice.start();large.voice.handleBrowserMessage(audio,true);expect(large.events.some(event=>event.code==='stt_resource_limit')).toBe(true);expect(large.requests).toHaveLength(0);
 const odd=bridgeFixture();await odd.voice.start();odd.voice.handleBrowserMessage(Buffer.alloc(3),true);expect(odd.events.some(event=>event.code==='stt_invalid_request')).toBe(true);expect(odd.requests).toHaveLength(0);
 const idle=bridgeFixture({limits:{idleMs:10}});await idle.voice.start();await new Promise(resolve=>setTimeout(resolve,20));expect(idle.events.some(event=>event.code==='stt_timeout')).toBe(true);expect(idle.requests).toHaveLength(0);
});

test('browser close and explicit Cancel discard audio without upload; unrelated session changes do not cancel the recording',async()=>{
 const closed=bridgeFixture();await closed.voice.start();closed.voice.handleBrowserMessage(audio,true);closed.voice.handleBrowserClose();closed.voice.handleBrowserMessage('{"type":"stop"}',false);expect(closed.requests).toHaveLength(0);expect(closed.listeners.size).toBe(0);
 const cancelled=bridgeFixture();await cancelled.voice.start();cancelled.voice.handleBrowserMessage(audio,true);cancelled.voice.handleBrowserMessage('{"type":"cancel"}',false);expect(cancelled.requests).toHaveLength(0);expect(cancelled.authCalls).toBe(0);expect(cancelled.closes).toBe(1);
 const valid=bridgeFixture();await valid.voice.start();for(const listener of [...valid.listeners])listener({kind:'session',rootFrameId:'another-root'});await valid.complete();expect(valid.requests).toHaveLength(1);
});

test('recorded bridge deadlines also bound stalled policy checks before upload and before accepting a transcript',async()=>{
 for(const phase of ['upload','completion']){
  const f=bridgeFixture({limits:{timeoutMs:10},assertCurrent:(_capture,current)=>current===phase?new Promise(()=>{}):undefined});await f.voice.start();await f.complete();expect(f.events.some(event=>event.code==='stt_timeout')).toBe(true);expect(f.events.some(event=>event.type==='transcript')).toBe(false);expect(f.requests).toHaveLength(phase==='upload'?0:1);expect(f.listeners.size).toBe(0);
 }
});

test('recorded bridge releases capture capacity after a failed policy subscription or a preparing-capture timeout',async()=>{
 const failure=bridgeFixture({limits:{captures:1},subscribeChanges:()=>{throw Error('Synthetic closed policy service')}});await failure.voice.start();expect(failure.closes).toBe(1);expect(failure.events[0]).toMatchObject({type:'error',code:'stt_unavailable'});
 let captures=0;const f=bridgeFixture({limits:{captures:1,captureMs:10},capture:()=>++captures===1?new Promise(()=>{}):capture()});await f.voice.start();expect(f.closes).toBe(1);expect(f.events.some(event=>event.code==='stt_timeout')).toBe(true);
 const events:any[]=[];const next=new f.Bridge({sendEvent:event=>events.push(event),close(){}},{});await next.start();expect(events[0].type).toBe('ready');next.handleBrowserClose();
});
