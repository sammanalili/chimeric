import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {SttSettingsManager,SttSettingsError} from './stt-settings';

/** Native session authentication and CSRF hooks must be installed first.
 * These routes configure destinations; they never accept or transcribe audio. */
export function installSttHttp(app:any,manager:Pick<SttSettingsManager,'snapshot'|'configure'|'safeError'|'close'>,moduleVersion:string){
 const handle=(action:(request:any)=>unknown)=>async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return await action(request)}catch(error){return reply.code(error instanceof SttSettingsError?error.status:400).send({detail:error instanceof z.ZodError?'Choose valid speech settings and reload if the connections changed.':manager.safeError(error)})}
 };
 app.get('/api/local/speech',handle(()=>manager.snapshot()));
 app.put('/api/local/speech',handle(request=>manager.configure(request.body)));
 app.get('/api/local/speech/component.js',async(_request:any,reply:any)=>reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(readFileSync(new URL('./voice-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion)));
 app.addHook('onClose',async()=>manager.close());
}
