import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {DecisionManager,DecisionSettingsError} from './decision-manager';

/** Install after native session/CSRF handlers. Tests use synthetic input only. */
export function installDecisionHttp(app:any,manager:DecisionManager,moduleVersion:string){
 const handle=(action:(request:any,reply:any)=>unknown)=>async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return await action(request,reply)}catch(error){return reply.code(error instanceof DecisionSettingsError?error.status:400).send({detail:error instanceof z.ZodError?'Choose valid classifier settings and reload if the connections changed.':manager.safeError(error)})}
 };
 app.get('/api/local/classifiers',handle(()=>manager.snapshot()));
 app.post('/api/local/classifiers',handle(request=>manager.upsert(request.body)));
 app.put('/api/local/classifiers',handle(request=>manager.select(request.body)));
 app.delete('/api/local/classifiers',handle(request=>manager.remove(request.body)));
 app.post('/api/local/classifiers/test',handle(async(request,reply)=>{
  const cancel=new AbortController(),aborted=()=>cancel.abort(),closed=()=>{if(!reply.raw?.writableEnded)cancel.abort()};
  request.raw?.once?.('aborted',aborted);reply.raw?.once?.('close',closed);
  try{return await manager.test(request.body,cancel.signal)}finally{request.raw?.removeListener?.('aborted',aborted);reply.raw?.removeListener?.('close',closed)}
 }));
 app.get('/api/local/classifiers/component.js',async(_request:any,reply:any)=>reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(readFileSync(new URL('./decision-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion)));
 app.addHook('onClose',async()=>manager.close());
}
