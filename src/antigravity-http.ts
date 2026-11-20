import {readFileSync} from 'node:fs';
import {z} from 'zod';
import {AntigravityError} from './antigravity';
import type {AntigravityModels} from './antigravity-models';
/** Installed behind the native session authentication and CSRF hooks. */
export function installAntigravityHttp(app:any,service:AntigravityModels,moduleVersion:string){
 const base='/api/local/antigravity';
 const handle=(action:(req:any,reply:any)=>unknown)=>async(req:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return await action(req,reply)}catch(error){return reply.code(error instanceof AntigravityError?error.status:400).send({detail:error instanceof AntigravityError?error.message:error instanceof z.ZodError?'Check the Antigravity request fields.':error instanceof Error?error.message:'Antigravity could not complete the operation. Reconnect using the official CLI.'})}
 };
 app.get(base,handle(()=>service.status()));
 app.put(base,handle(req=>service.configure(req.body)));
 app.put(base+'/settings',handle(req=>service.setSharedCustomizations(req.body)));
 app.post(base+'/connect',handle(()=>service.connect()));
 app.post(base+'/disconnect',handle(()=>service.disconnect()));
 app.post(base+'/authenticate',handle(req=>service.authenticate(req.body)));
 app.post(base+'/models/refresh',handle(()=>service.refresh()));
 app.get(base+'/component.js',handle((_req,reply)=>reply.type('text/javascript; charset=utf-8').send(readFileSync(new URL('./antigravity-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion))));
 app.addHook('onClose',()=>service.close());
}
