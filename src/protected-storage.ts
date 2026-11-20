import {createHash,randomUUID} from 'node:crypto';
import {closeSync,constants,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {homedir,tmpdir} from 'node:os';

export type ProtectedStorageScope=Readonly<{frameId:string;rootFrameId:string;projectId:string;ownerId:string;organizationId:string;revision:number;executionBinding:string;mode:'class2'}>;
export type ProtectedStorageCategory='artifacts'|'uploads'|'derived'|'thumbnails'|'toolResults'|'converterJobs'|'imageJobs'|'broker'|'workspace'|'temp';
export type ProtectedStorageLayout=Readonly<{reserve:string;hostAuth:string;root:string;workspaceBase:string;workspace:string;temp:string;artifacts:string;uploads:string;derived:string;thumbnails:string;toolResults:string;converterJobs:string;imageJobs:string;broker:string}>;
export class ProtectedStorageError extends Error {constructor(message:string,readonly status=409){super(message)}}
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const under=(base:string,path:string)=>path===base||path.startsWith(base+sep);
const identity=(stat:any)=>`${stat.dev}:${stat.ino}`;
function canonical(path:string){let current=resolve(path);const missing:string[]=[];for(;;){try{return join(realpathSync(current),...missing)}catch(error:any){if(!['ENOENT','ENOTDIR'].includes(error?.code)||dirname(current)===current)throw new ProtectedStorageError('A native storage path could not be resolved.');missing.unshift(basename(current));current=dirname(current)}}}
const segment=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)&&value!=='.'&&value!=='..';
const categories=new Set(['artifacts','uploads','derived','thumbnails','toolResults','converterJobs','imageJobs','broker','workspace','temp']);
const filename=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=180&&!/[/\\\x00-\x1f\x7f]/.test(value)&&value!=='.'&&value!=='..';
type Plan={scope:ProtectedStorageScope;layout:ProtectedStorageLayout;config:any;readExceptions:string[]};
/** No credentials or research are migrated automatically. The native ops-stage
 * deny already applies to standard workers, including workers started before a
 * future protected file exists. The non-operon namespace is outside its GC regex. */
export class ProtectedStorage {
 readonly dataDir:string;readonly reserve:string;readonly hostAuth:string;
 private marker=Symbol('daemon-protected-storage');private plans=new WeakSet<object>();private directories=new Map<string,string>();
 constructor(dataDir:string,private options:{scopeForFrame:(frameId:string)=>ProtectedStorageScope|undefined;assertCurrent:(scope:ProtectedStorageScope)=>void;safeReadRoots?:readonly string[];authDir?:string}){
  if(!isAbsolute(dataDir))throw new ProtectedStorageError('Private storage requires an absolute data directory.',400);
  const info=lstatSync(dataDir);if(!info.isDirectory()||info.isSymbolicLink())throw new ProtectedStorageError('Private storage requires a real data directory.');
  this.dataDir=realpathSync(dataDir);if(this.dataDir===sep||this.dataDir===realpathSync(homedir()))throw new ProtectedStorageError('Private storage cannot use a filesystem or home root.');
  this.reserve=join(this.dataDir,'sbx-bind-src','ops-stage','chimeric-private-v1');this.hostAuth=join(this.reserve,'auth');
  this.ensureDirectory(this.dataDir);for(const path of [join(this.dataDir,'sbx-bind-src'),join(this.dataDir,'sbx-bind-src','ops-stage'),this.reserve,this.hostAuth,join(this.reserve,'roots')])this.ensureDirectory(path);
 }
 private assertScope(scope:ProtectedStorageScope){
  if(!scope||scope.mode!=='class2'||!Number.isSafeInteger(scope.revision)||scope.revision<0||!/^[a-f0-9]{64}$/.test(scope.executionBinding)||!segment(scope.frameId)||!segment(scope.rootFrameId)||['projectId','ownerId','organizationId'].some(k=>typeof(scope as any)[k]!=='string'||!(scope as any)[k]||(scope as any)[k].length>255))throw new ProtectedStorageError('The protected storage owner could not be verified.');
  const result:any=this.options.assertCurrent(scope);if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});throw new ProtectedStorageError('Protected path assertions must complete synchronously.')}
 }
 private ensureDirectory(path:string){
  if(!under(this.dataDir,path))throw new ProtectedStorageError('A private directory escaped its owning data directory.');
  const rel=relative(this.dataDir,path),parts=rel?rel.split(sep):[];let current=this.dataDir;
  for(const part of ['',...parts]){if(part)current=join(current,part);let stat:any;try{stat=lstatSync(current)}catch(error:any){if(error?.code!=='ENOENT')throw new ProtectedStorageError('A private directory is unavailable.');mkdirSync(current,{mode:0o700});stat=lstatSync(current)}
   if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(current)!==current||process.geteuid&&stat.uid!==process.geteuid())throw new ProtectedStorageError('A private directory changed its filesystem owner or link identity.');
   const before=this.directories.get(current);if(before&&before!==identity(stat))throw new ProtectedStorageError('A private directory was replaced.');
   // Existing dataDir/bind roots belong to the native daemon; do not chmod them.
   // The store namespace itself must already be private or be newly created.
   if(under(this.reserve,current)&&(stat.mode&0o077)!==0)throw new ProtectedStorageError('Private storage permissions are too broad.');this.directories.set(current,identity(stat));
  }
  return path;
 }
 private assertFile(path:string){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||process.geteuid&&stat.uid!==process.geteuid())throw new ProtectedStorageError('Linked or non-regular private files cannot be used.');return stat}
 layout(scope:ProtectedStorageScope):ProtectedStorageLayout{
  this.assertScope(scope);const key=digest(JSON.stringify([scope.organizationId,scope.ownerId,scope.projectId,scope.rootFrameId])).slice(0,32),root=join(this.reserve,'roots',key),workspaceBase=join(root,'workspaces');
  const layout=Object.freeze({reserve:this.reserve,hostAuth:this.hostAuth,root,workspaceBase,workspace:join(workspaceBase,scope.frameId),temp:join(root,'tmp',scope.frameId),artifacts:join(root,'artifacts'),uploads:join(root,'uploads'),derived:join(root,'derived'),thumbnails:join(root,'thumbnails'),toolResults:join(root,'results',scope.frameId),converterJobs:join(root,'converters'),imageJobs:join(root,'images'),broker:join(root,'broker')});
  for(const path of new Set([root,...Object.values(layout).filter(path=>under(root,path))]))this.ensureDirectory(path);
  const meta=join(root,'owner.json'),owner=JSON.stringify([scope.organizationId,scope.ownerId,scope.projectId,scope.rootFrameId]);
  try{const stat=this.assertFile(meta);if(readFileSync(meta,'utf8')!==owner||stat.nlink!==1)throw new ProtectedStorageError('A private root belongs to a different research owner.')}
  catch(error:any){if(error?.code!=='ENOENT')throw error;this.writeAtomic(root,'owner.json',Buffer.from(owner))}
  return layout;
 }
 authPath(name?:string){this.ensureDirectory(this.hostAuth);if(name===undefined)return this.hostAuth;if(!filename(name))throw new ProtectedStorageError('Invalid private authentication filename.',400);const path=join(this.hostAuth,name);try{this.assertFile(path)}catch(error:any){if(error?.code!=='ENOENT')throw error}return path}
 private writeAtomic(directory:string,name:string,bytes:Uint8Array){
  if(!filename(name))throw new ProtectedStorageError('Private files require a plain filename.',400);this.ensureDirectory(directory);const target=join(directory,name);
  try{this.assertFile(target)}catch(error:any){if(error?.code!=='ENOENT')throw error}
  const temporary=join(directory,'.pending-'+randomUUID());let fd:number|undefined;
  try{fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);writeFileSync(fd,bytes);fsyncSync(fd);const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1)throw new ProtectedStorageError('The new private file changed link identity.');this.ensureDirectory(directory);renameSync(temporary,target)}finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temporary)}catch{}}
  return target;
 }
 writeAuth(name:string,bytes:Uint8Array){return this.writeAtomic(this.hostAuth,name,bytes)}
 write(scope:ProtectedStorageScope,category:ProtectedStorageCategory,name:string,bytes:Uint8Array){const layout=this.layout(scope),directory=layout[category];if(!categories.has(category)||typeof directory!=='string'||!under(layout.root,directory))throw new ProtectedStorageError('Invalid private storage category.',400);const path=this.writeAtomic(directory,name,bytes);this.assertScope(scope);return path}
 read(scope:ProtectedStorageScope,category:ProtectedStorageCategory,name:string){
  if(!filename(name))throw new ProtectedStorageError('Invalid private filename.',400);const layout=this.layout(scope),directory=layout[category];if(!categories.has(category)||typeof directory!=='string'||!under(layout.root,directory))throw new ProtectedStorageError('Invalid private storage category.',400);
  this.ensureDirectory(directory);const path=join(directory,name),before=this.assertFile(path),fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=fstatSync(fd);if(identity(opened)!==identity(before)||opened.nlink!==1||!opened.isFile())throw new ProtectedStorageError('The private file changed while being opened.');const bytes=readFileSync(fd);this.ensureDirectory(directory);const after=this.assertFile(path);if(identity(after)!==identity(opened)||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs)throw new ProtectedStorageError('The private file changed while being read.');this.assertScope(scope);return bytes}finally{closeSync(fd)}
 }
 workspacePath(frameId:string,standardPath:string){const scope=this.options.scopeForFrame(frameId);return scope?this.layout(scope).workspace:standardPath}
 kernelBase(_manager:any,frameId:string,standardBase:string){const scope=this.options.scopeForFrame(frameId);return scope?this.layout(scope).workspaceBase:standardBase}
 /** Host file tools bypass the child sandbox. Their owning handlers must check
  * each resolved item, including directory traversal, before opening any bytes. */
 assertHostPath(frameId:string,path:string,access:'read'|'write'='read'){
  if(!isAbsolute(path))throw new ProtectedStorageError('Host file checks require an absolute path.',400);const target=canonical(path),scope=this.options.scopeForFrame(frameId);
  if(!scope){if(under(this.reserve,target))throw new ProtectedStorageError('Private files are unavailable to an ordinary research session.',403);return}
  const layout=this.layout(scope);if(!under(layout.root,target)||access==='write'&&![layout.workspace,layout.temp].some(root=>under(root,target)))throw new ProtectedStorageError('This host file operation is outside the protected chat workspace.',403);
 }
 assertGrant(path:string){if(!isAbsolute(path))throw new ProtectedStorageError('Folder grants require an absolute path.',400);const target=canonical(path);if(under(target,this.reserve)||under(this.reserve,target))throw new ProtectedStorageError('A folder grant cannot include the private authentication or protected research reserve.',403)}
 configureNativeSpawn(_manager:any,request:any,derived:any){
  const scope=this.options.scopeForFrame(request?.frameId);if(!scope)return derived;this.assertScope(scope);
  if(scope.frameId!==request.frameId||derived?.config?.platform!=='macos'||request.denyNetwork!==true||request.untrustedArgs||request.frameSecretsDir)throw new ProtectedStorageError('This native spawn is not a verified protected analysis process.',403);
  const network=derived.config.network;if(network?.enabled!==false||network.httpProxyPort!==0||network.socksProxyPort!==0||network.allowUnixSockets?.length!==0)throw new ProtectedStorageError('The actual native network configuration is not isolated.',403);
  const layout=this.layout(scope),original=derived.config;if(realpathSync(original.dataDir)!==this.dataDir)throw new ProtectedStorageError('The native sandbox and private store have different data owners.');
  const safe=[original.condaHome,original.rSharedLibsBase,...this.options.safeReadRoots??[]].filter((p:any)=>typeof p==='string'&&p&&isAbsolute(p)).map((p:string)=>canonical(p));
  if(safe.some(path=>under(path,this.reserve)||under(this.reserve,path)||path===sep||path===homedir()))throw new ProtectedStorageError('A native runtime read grant would include private authentication or other protected roots.');
  const readable=(derived.daemonReadablePaths??[]).filter((path:string)=>safe.some(base=>under(base,canonical(path))));
  const writable=[layout.workspace,layout.temp],config={...original,workspaceBase:layout.workspaceBase,artifactsPath:layout.artifacts,toolResultsPath:join(layout.root,'results'),userReadPaths:[],userWritePaths:[],userPathOperatorSpellings:[],frameSecretsReallowPaths:[],denyLinkCreation:true,filesystem:{...original.filesystem,allowWrite:[],allowWriteUserGlob:[],pinDirents:[...original.filesystem.pinDirents,...writable]}};
  const plan:Plan={scope,layout,config:original,readExceptions:[layout.root,...safe]};this.plans.add(plan);Object.defineProperty(config,this.marker,{value:plan,enumerable:true});
  const env=request.env;for(const [key,value]of Object.entries({HOME:join(layout.root,'home'),TMPDIR:layout.temp,TMP:layout.temp,TEMP:layout.temp,XDG_CACHE_HOME:join(layout.temp,'cache'),MPLCONFIGDIR:join(layout.temp,'matplotlib'),IPYTHONDIR:join(layout.temp,'ipython'),PYTHONPYCACHEPREFIX:join(layout.temp,'pycache'),R_USER:join(layout.root,'home')}))env[key]=value;
  this.ensureDirectory(join(layout.root,'home'));env.OPERON_WRITABLE_ROOTS=writable.join(sep==='\\'?';':':');
  return {...derived,config,writablePaths:writable,daemonWritablePaths:writable,readablePaths:[...readable,layout.root],daemonReadablePaths:[...readable,layout.root],fsecDir:null,wtDir:null};
 }
 appendNativePolicy(config:any,policy:string){
  const plan=config?.[this.marker] as Plan|undefined;if(!plan)return policy;if(!this.plans.has(plan))throw new ProtectedStorageError('The native private-storage policy token is invalid.');this.assertScope(plan.scope);const layout=this.layout(plan.scope);if(layout.root!==plan.layout.root)throw new ProtectedStorageError('The protected root changed before sandbox launch.');
  const quote=(path:string)=>{if(!isAbsolute(path)||/[\\\x00-\x1f\x7f]/.test(path)||Buffer.byteLength(path)>240)throw new ProtectedStorageError('The private storage path cannot be represented safely by the native sandbox.');return JSON.stringify(path)};
  const sub=(path:string)=>`(subpath ${quote(path)})`,exceptions=plan.readExceptions.map(path=>`(require-not ${sub(path)})`).join(' ');
  const deniedReads=[homedir(),this.dataDir,plan.config.authDir,this.options.authDir,...plan.config.userReadPaths??[],...plan.config.userWritePaths??[],tmpdir(),'/tmp','/private/tmp','/private/var/tmp'].filter((p:any)=>typeof p==='string'&&p&&isAbsolute(p));
  const rows=['','; Chimeric private storage: exact daemon-minted root only','(deny file-write*)'];
  for(const root of new Set(deniedReads.flatMap(p=>[resolve(p),canonical(p)])))rows.push(`(deny file-read* (require-all ${sub(root)} ${exceptions}))`);
  rows.push(`(deny file-read* file-write* file-link file-clone ${sub(this.reserve)})`,`(allow file-read* ${sub(layout.root)})`,`(allow file-write* ${sub(layout.workspace)} ${sub(layout.temp)})`,`(deny file-read* file-write* file-link file-clone ${sub(this.hostAuth)})`);
  // Keep protocol/device output usable, without reopening any shared filesystem.
  rows.push('(allow file-read* file-write* (literal "/dev/stdin") (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))','(allow file-read* file-write* (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))','(deny file-link file-clone)');
  for(const path of [layout.workspace,layout.temp])rows.push(`(deny file-write-unlink file-write-create (literal ${quote(path)}))`);
  return policy+'\n'+rows.join('\n')+'\n';
 }
 callbacks(){return {nativeProtectedWorkspacePath:(frame:string,path:string)=>this.workspacePath(frame,path),nativeProtectedKernelBase:(manager:any,frame:string,path:string)=>this.kernelBase(manager,frame,path),nativeProtectedSpawnPaths:(manager:any,request:any,derived:any)=>this.configureNativeSpawn(manager,request,derived),nativeProtectedStoragePolicy:(config:any,policy:string)=>this.appendNativePolicy(config,policy)}}
}
