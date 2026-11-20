import {readFileSync} from 'node:fs';
import {UsageManager,UsageSettingsError} from './usage-manager';
export function installUsageHttp(app:any,manager:UsageManager,moduleVersion:string,scope?:{effectiveModel:(frameId:string)=>Promise<string|undefined>}){
 app.get('/api/local/usage',async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{const frameId=request.query?.frameId;if(frameId!==undefined&&(typeof frameId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(frameId)))return reply.code(400).send({detail:'Choose a valid research chat.'});
   const effectiveModelId=frameId?await scope?.effectiveModel(frameId):undefined;
   return reply.send({...manager.snapshot(),...frameId?{frameId,effectiveModelId}:{}});
  }catch(error:any){return reply.code(error?.status??400).send({detail:'Usage could not be matched to this research chat.'})}
 });
 app.put('/api/local/usage/pricing',async(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{return manager.configure(request.body)}catch(error){return reply.code(error instanceof UsageSettingsError?error.status:400).send({detail:error instanceof UsageSettingsError?error.message:'Enter valid USD rates per million tokens.'})}
 });
 app.get('/api/local/usage/component.js',async(_request:any,reply:any)=>reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(readFileSync(new URL('./usage-indicator.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion)));
}
