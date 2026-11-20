import {test,expect} from 'bun:test';
import {createVoiceBridge} from '../src/voice';

test('Native dictation protocol uses local audio processing without requesting OAuth',async()=>{
 const events:any[]=[];let seen:Buffer|undefined;let done!:()=>void;
 const closed=new Promise<void>(r=>done=r);
 const Bridge=createVoiceBridge({async start(){},async transcribe(pcm){seen=pcm;return 'science workspace'}});
 const voice=new Bridge({sendEvent(e:any){events.push(e)},close(){done()}},{getAccessToken(){throw new Error('OAuth must not be called')},language:'en'});
 await voice.start();voice.handleBrowserMessage(Buffer.alloc(3200,1),true);voice.handleBrowserMessage('{"type":"stop"}',false);await closed;
 expect(events.map(e=>e.type)).toEqual(['ready','transcript','closed']);expect(events[1].text).toBe('science workspace');expect(seen!.length).toBe(3200);
});

test('Unavailable local speech backend returns a concrete error and closes',async()=>{
 const events:any[]=[];const Bridge=createVoiceBridge({async start(){throw new Error('runtime missing')},async transcribe(){return ''}});
 const voice=new Bridge({sendEvent(e:any){events.push(e)},close(){}},{});await voice.start();expect(events[0]).toMatchObject({type:'error',code:'local_asr_error'});expect(events[1].type).toBe('closed');
});

test('Odd byte length PCM16 frame is rejected with Invalid PCM16 frame error',async()=>{
 const events:any[]=[];let done!:()=>void;
 const closed=new Promise<void>(r=>done=r);
 const Bridge=createVoiceBridge({async start(){},async transcribe(){return ''}});
 const voice=new Bridge({sendEvent(e:any){events.push(e)},close(){done()}},{language:'en'});
 await voice.start();
 voice.handleBrowserMessage(Buffer.alloc(3201,1),true); // Odd byte length
 await closed;
 expect(events.some(e=>e.type==='error'&&e.message==='Invalid PCM16 frame')).toBe(true);
 expect(events.some(e=>e.type==='closed')).toBe(true);
});

test('Audio stream exceeding buffer ceiling is rejected safely',async()=>{
 const events:any[]=[];let done!:()=>void;
 const closed=new Promise<void>(r=>done=r);
 const Bridge=createVoiceBridge({async start(){},async transcribe(){return ''}});
 const voice=new Bridge({sendEvent(e:any){events.push(e)},close(){done()}},{language:'en'});
 await voice.start();
 voice.handleBrowserMessage(Buffer.alloc(1_920_002,1),true); // Exceeds 1.92 MB ceiling
 await closed;
 expect(events.some(e=>e.type==='error'&&e.message==='Local speech worker could not keep up with the audio stream')).toBe(true);
 expect(events.some(e=>e.type==='closed')).toBe(true);
});
