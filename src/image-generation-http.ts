import {readFileSync} from 'node:fs';
import {ImageGenerationManager,ImageGenerationSettingsError} from './image-generation-manager';
import {z} from 'zod';
export function installImageGenerationHttp(app:any,manager:ImageGenerationManager,moduleVersion:string){
 app.get('/api/local/image-generation',async(_request:any,reply:any)=>reply.header('cache-control','no-store').send(manager.snapshot()));
 app.put('/api/local/image-generation',async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return manager.configure(request.body)}catch(error){return reply.code(error instanceof ImageGenerationSettingsError?error.status:400).send({detail:error instanceof ImageGenerationSettingsError?error.message:error instanceof z.ZodError?'Choose a valid image-generation connection and model.':'Could not save image-generation settings.'})}
 });
 app.get('/api/local/image-generation/component.js',async(_request:any,reply:any)=>reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(readFileSync(new URL('./image-generation-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion)));
 app.addHook('onClose',async()=>manager.close());
}
