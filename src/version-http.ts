import {closeSync,constants,fstatSync,openSync,readFileSync} from 'node:fs';
import packageInfo from '../package.json';

const versionPattern=/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
export type ChimericVersion={product:'Chimeric';version:string};

/** The package version is bundled with the backend; packaged metadata lives one directory above it. */
export function chimericVersion(moduleUrl:string=import.meta.url):Readonly<ChimericVersion>{
 let version=packageInfo.version;
 let descriptor:number|undefined;
 try{
  descriptor=openSync(new URL('../chimeric-version.json',moduleUrl),constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  const info=fstatSync(descriptor);
  if(info.isFile()&&info.size<=65536){
   const metadata=JSON.parse(readFileSync(descriptor,'utf8'));
   if(metadata&&typeof metadata==='object'&&!Array.isArray(metadata)&&typeof metadata.version==='string'&&metadata.version.length<=96&&versionPattern.test(metadata.version))version=metadata.version;
  }
 }catch{/* Source checkouts and malformed metadata use the bundled package version. */}
 finally{if(descriptor!==undefined)closeSync(descriptor)}
 return Object.freeze({product:'Chimeric',version});
}

/** Mount after the native workspace session handler. No profile or account data is exposed. */
export function installVersionHttp(app:any,moduleVersion:string,options:{moduleUrl?:string}={}){
 const snapshot=chimericVersion(options.moduleUrl);
 const authorized=(request:any,reply:any)=>{
  reply.header('cache-control','no-store');
  try{if(app.getUser(request)?.user_id==='local-dev')return true}catch{/* The native session is missing or expired. */}
  reply.code(401).send({detail:'Open your local workspace again to continue.'});return false;
 };
 app.get('/api/local/version',async(request:any,reply:any)=>{
  if(!authorized(request,reply))return;
  return reply.send(snapshot);
 });
 app.get('/api/local/version/component.js',async(request:any,reply:any)=>{
  if(!authorized(request,reply))return;
  return reply.type('text/javascript; charset=utf-8').send(readFileSync(new URL('./version-settings.js',import.meta.url),'utf8').replaceAll('?science_local=chatgpt-v1',moduleVersion));
 });
}
