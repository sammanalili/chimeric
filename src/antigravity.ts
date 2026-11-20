import {ClientApp,ndJsonStream,type ClientConnection,type InitializeResponse,type SessionConfigOption,RequestError} from '@agentclientprotocol/sdk';
import {Database} from 'bun:sqlite';
import {spawn,type ChildProcessWithoutNullStreams,spawnSync} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {mkdirSync,chmodSync,readFileSync,writeFileSync,existsSync,statSync,realpathSync,readdirSync,lstatSync,createReadStream,openSync,constants} from 'node:fs';
import {join,resolve,relative,isAbsolute,basename,dirname,delimiter,sep} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';

export class AntigravityError extends Error{constructor(message:string,readonly status=400){super(message)}}
type Session={id:string;remoteId:string|null;title:string;status:string;createdAt:number;updatedAt:number;configOptions:SessionConfigOption[];error:string|null};
type Permission={id:string;sessionId:string;turnId:string;title:string;toolCall:any;options:Array<{optionId:string;name:string;kind:string}>;createdAt:number;settle:(outcome:any)=>void};
const idSchema=z.string().uuid();
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const personalMethods=new Set(['oauth-personal','oauth-business']);
const MAX_EVENT_BYTES=8*1024*1024;

/** Only OS/session variables enter agy. Model keys and Chimeric's auth stay here. */
export function antigravityEnvironment(env:NodeJS.ProcessEnv=process.env){
 const allowed=['HOME','USERPROFILE','USER','LOGNAME','PATH','TMPDIR','TMP','TEMP','SystemRoot','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','LANG','LC_ALL','LC_CTYPE','TERM','XDG_RUNTIME_DIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','DBUS_SESSION_BUS_ADDRESS'];
 return Object.fromEntries(allowed.flatMap(key=>env[key]===undefined?[]:[[key,env[key]!]]));
}
function publicError(error:any){
 if(error?.code===-32000||/authentication required|not authenticated/i.test(String(error?.message)))return 'Sign in through Antigravity to continue.';
 if(/quota|rate.?limit|resource.?exhausted|429/i.test(String(error?.message)))return 'Antigravity reported a quota or rate limit. This turn has stopped. Try again when your account is available.';
 if(/permission.?denied|suspend|account.*disabled|403/i.test(String(error?.message)))return 'Antigravity denied access. This connection has stopped. Check your account in the official app.';
 if(error instanceof AntigravityError)return error.message;
 return 'Antigravity could not complete this operation. Check the official CLI, then reconnect. No request was retried.';
}
/** Render server-advertised models and retain explicit permission modes. */
export function permittedOptions(raw:unknown):SessionConfigOption[]{
 if(!Array.isArray(raw))return [];
 return raw.filter(c=>c&&typeof c.id==='string'&&typeof c.name==='string'&&['model','thought_level','mode'].includes(c.category??c.id)&&c.type==='select').map(c=>{
  const entries=(Array.isArray(c.options)?c.options:[]).flatMap((option:any)=>Array.isArray(option.options)?option.options:[option]);
  const category=c.category??c.id;
  const options=entries.filter((v:any)=>typeof v.value==='string'&&typeof v.name==='string'&&(category!=='mode'||['default','plan'].includes(v.value))).map((v:any)=>({value:v.value,name:v.name,...typeof v.description==='string'?{description:v.description}:{}}));
  return {id:c.id,name:c.name,category,type:'select' as const,currentValue:c.currentValue,options};
 }).filter(c=>c.options.length);
}

export class Antigravity {
 readonly root:string;
 private db:Database;
 private connection?:ClientConnection;
 private child?:ChildProcessWithoutNullStreams;
 private initialized?:InitializeResponse;
 private executable='';
 private version='';
 private error?:string;
 private connecting?:Promise<void>;
 private operation=false;
 private operationFinished?:Promise<void>;
 private closing?:Promise<void>;
 private loaded=new Set<string>();
 private replaying=new Set<string>();
 private pending=new Map<string,Permission>();
 private active?:{sessionId:string;turnId:string;cancelled:boolean;done:Promise<void>};
 private listeners=new Set<()=>void>();
 private authState:'idle'|'waiting'|'ready'|'error'='idle';
 private closed=false;
 private authTimer?:ReturnType<typeof setTimeout>;
 private processClosed=new WeakMap<ChildProcessWithoutNullStreams,Promise<void>>();
 private processCleanups=new Set<Promise<void>>();
 constructor(profile:string,private options:{launch?:(cwd:string)=>ChildProcessWithoutNullStreams;operationTimeoutMs?:number;cancelTimeoutMs?:number;permissionTimeoutMs?:number;turnTimeoutMs?:number;killGraceMs?:number}={}){
  this.root=join(resolve(profile),'antigravity');mkdirSync(this.root,{recursive:true,mode:0o700});
  mkdirSync(join(this.root,'workspaces'),{recursive:true,mode:0o700});
  const config=join(this.root,'connection.json');if(existsSync(config))this.executable=z.object({executable:z.string()}).parse(JSON.parse(readFileSync(config,'utf8'))).executable;
  const file=join(this.root,'sessions.sqlite');this.db=new Database(file,{create:true});chmodSync(file,0o600);
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
   CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,remoteId TEXT,title TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,configOptions TEXT NOT NULL DEFAULT '[]',error TEXT);
   CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,sessionId TEXT NOT NULL REFERENCES sessions(id),kind TEXT NOT NULL,data TEXT NOT NULL,createdAt INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS turns(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),inputHash TEXT NOT NULL,status TEXT NOT NULL,createdAt INTEGER NOT NULL,finishedAt INTEGER,result TEXT);
   CREATE INDEX IF NOT EXISTS events_session ON events(sessionId,seq);
   CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,sessionId TEXT NOT NULL REFERENCES sessions(id),name TEXT NOT NULL,mimeType TEXT NOT NULL,path TEXT NOT NULL,bytes INTEGER NOT NULL);
  `);
  this.db.query("UPDATE sessions SET status='interrupted',error='Chimeric restarted. Resume this session explicitly.' WHERE status IN ('running','waiting','connecting')").run();
  this.db.query("UPDATE turns SET status='interrupted',finishedAt=? WHERE status='running'").run(Date.now());
 }
 subscribe(listener:()=>void){this.listeners.add(listener);return()=>this.listeners.delete(listener)}
 private changed(){for(const listener of this.listeners)listener()}
 private session(id:string):Session{
  idSchema.parse(id);const row=this.db.query('SELECT * FROM sessions WHERE id=?').get(id) as any;
  if(!row)throw new AntigravityError('Antigravity session not found.',404);
  return {...row,configOptions:JSON.parse(row.configOptions)};
 }
 private update(id:string,changes:Partial<Session>){
  const row={...this.session(id),...changes,updatedAt:Date.now()};
  this.db.query('UPDATE sessions SET remoteId=?,title=?,status=?,updatedAt=?,configOptions=?,error=? WHERE id=?').run(row.remoteId,row.title,row.status,row.updatedAt,JSON.stringify(row.configOptions),row.error,id);this.changed();
 }
 private event(id:string,kind:string,data:any){
  const serialized=JSON.stringify(data);if(Buffer.byteLength(serialized)>MAX_EVENT_BYTES)throw new AntigravityError('Antigravity sent an event larger than 8 MB. The connection has stopped.');
  this.db.query('INSERT INTO events(sessionId,kind,data,createdAt) VALUES (?,?,?,?)').run(id,kind,serialized,Date.now());this.changed();
 }
 private cwd(id:string){this.session(id);return join(this.root,'workspaces',id)}
 status(){
  const sessions=this.db.query('SELECT * FROM sessions ORDER BY updatedAt DESC').all().map((r:any)=>({...r,configOptions:permittedOptions(JSON.parse(r.configOptions))}));
  return {connected:!!this.connection&&!this.connection.signal.aborted,executable:this.executable||this.findExecutable()||'',version:this.version,agent:this.initialized?.agentInfo??null,
   authState:this.authState,authMethods:this.initialized?.authMethods?.filter(m=>personalMethods.has(m.id)).map(m=>({id:m.id,name:m.name}))??[],
   imageInput:this.initialized?.agentCapabilities?.promptCapabilities?.image===true,operation:this.operation,activeSessionId:this.active?.sessionId??null,error:this.error??null,sessions};
 }
 snapshot(id:string,after=0){
  const session=this.session(id);const events=this.db.query('SELECT * FROM events WHERE sessionId=? AND seq>? ORDER BY seq LIMIT 2000').all(id,Math.max(0,after)).map((r:any)=>({...r,data:JSON.parse(r.data)}));
  const permissions=[...this.pending.values()].filter(p=>p.sessionId===id).map(({settle,...p})=>p);
  return {session:{...session,configOptions:permittedOptions(session.configOptions)},events,permissions,hasMore:events.length===2000,nextCursor:events.at(-1)?.seq??after,attachments:this.db.query('SELECT id,name,mimeType,bytes FROM attachments WHERE sessionId=?').all(id)};
 }
 private findExecutable(){
  const suffix=process.platform==='win32'?'agy.exe':'agy';
  const candidates=[join(homedir(),'.local','bin',suffix),join(homedir(),'AppData','Local','agy','bin',suffix),...(process.env.PATH??'').split(delimiter).filter(Boolean).map(dir=>join(dir,suffix))];
  return candidates.find(path=>existsSync(path)&&statSync(path).isFile());
 }
 private verifyExecutable(path:string){
  if(!isAbsolute(path))throw new AntigravityError('Choose an absolute path to the official agy executable.');
  const actual=realpathSync(path),info=statSync(actual);
  if(!info.isFile()||(process.platform!=='win32'&&((info.mode&0o022)!==0||(info.mode&0o111)===0)))throw new AntigravityError('The agy executable must be executable and must not be writable by other users.');
  if(process.platform==='darwin'){
   const verify=spawnSync('/usr/bin/codesign',['--verify','--strict','-R','=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',actual],{encoding:'utf8',timeout:10000});
   if(verify.status!==0)throw new AntigravityError('The agy executable must have a valid Google code signature. Install it from antigravity.google.');
  }
  const version=spawnSync(actual,['--version'],{encoding:'utf8',timeout:10000,env:antigravityEnvironment(),maxBuffer:65536});
  if(version.status!==0||!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/.test(version.stdout))throw new AntigravityError('The selected executable did not report an Antigravity CLI version.');
  this.version=version.stdout.trim();return actual;
 }
 async configure(raw:unknown){
  return this.exclusive(async()=>{
   const {executable}=z.object({executable:z.string().trim().min(1).max(4096)}).parse(raw);const verified=this.verifyExecutable(executable);
   await this.disconnect();this.executable=verified;
   writeFileSync(join(this.root,'connection.json'),JSON.stringify({schemaVersion:1,executable:verified})+'\n',{mode:0o600});return this.status();
  });
 }
 private async exclusive<T>(fn:()=>Promise<T>){
  if(this.closed)throw new AntigravityError('Antigravity is shutting down.',503);
  if(this.operation||this.active||this.authState==='waiting')throw new AntigravityError('Finish or stop the active Antigravity operation first.',409);
  let finish!:()=>void;const finished=new Promise<void>(done=>finish=done);this.operationFinished=finished;
  this.operation=true;try{this.changed();return await fn()}finally{this.operation=false;try{this.changed()}finally{finish();if(this.operationFinished===finished)this.operationFinished=undefined}}
 }
 private async request(method:string,params:any,timeoutMs=this.options.operationTimeoutMs??30000){
  const connection=this.connection;if(!connection)throw new AntigravityError('Connect Antigravity first.',409);
  const signal=AbortSignal.timeout(timeoutMs);
  try{return await connection.agent.request<any>(method,params,{cancellationSignal:signal,stopWaitingOnCancel:true})}
  catch(error){if(signal.aborted){this.breakConnection('Antigravity did not respond in time. Reconnect before trying again.');throw new AntigravityError('Antigravity did not respond in time. Reconnect before trying again.',504)}throw error}
 }
 private async ensure(){
  await this.drainProcesses();
  if(this.closed)throw new AntigravityError('Antigravity is shutting down.',503);
  if(this.connection&&!this.connection.signal.aborted)return;
  if(this.connecting)return this.connecting;
  this.connecting=(async()=>{
   const path=this.options.launch?'':this.verifyExecutable(this.executable||this.findExecutable()||'');
   const child=this.options.launch?.(this.root)??spawn(path,['acp','--sandbox','--disable-telemetry'],{cwd:this.root,stdio:['pipe','pipe','pipe'],env:antigravityEnvironment(),windowsHide:true,detached:process.platform!=='win32'});
   this.processClosed.set(child,new Promise<void>(done=>child.once('close',()=>done())));
   child.stderr.resume();this.child=child;this.error=undefined;
   const app=new ClientApp()
    .onNotification('session/update',ctx=>this.onUpdate(ctx.params as any))
    .onRequest('session/request_permission',ctx=>this.onPermission(ctx.params as any,ctx.signal))
    .onRequest('*',ctx=>{throw RequestError.methodNotFound(ctx.method)});
   const stream=ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,{maxMessageBytes:MAX_EVENT_BYTES});
   const connection=app.connect(stream);this.connection=connection;
   child.once('error',()=>{if(this.child===child)this.breakConnection('Could not start the official Antigravity CLI. Check its path and permissions.')});
   child.once('exit',()=>{if(this.child===child)this.breakConnection('Antigravity exited. Resume explicitly after reconnecting.')});
   void connection.closed.then(()=>{if(this.connection===connection)this.breakConnection('The Antigravity connection closed. Resume explicitly after reconnecting.')});
   try{
    const init=await this.request('initialize',{protocolVersion:1,clientInfo:{name:'chimeric',title:'Chimeric',version:'0.1.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
    if(this.closed||this.connection!==connection)throw new AntigravityError('Antigravity is shutting down.',503);
    if(init.protocolVersion!==1||init.agentInfo?.name!=='Antigravity ACP Server')throw new AntigravityError('This executable is not a compatible Antigravity ACP server.');
    this.initialized=init;this.version=init.agentInfo.version??this.version;this.authState='idle';this.changed();
   }catch(error){const message=publicError(error);this.breakConnection(message);throw new AntigravityError(message)}
  })();
  try{await this.connecting}finally{this.connecting=undefined}
 }
 connect(){return this.exclusive(async()=>{await this.ensure();return this.status()})}
 private stopProcess(child:ChildProcessWithoutNullStreams){
  const closed=this.processClosed.get(child)??Promise.resolve();
  const directAlive=()=>child.exitCode===null&&child.signalCode===null;
  const groupAlive=()=>{if(process.platform==='win32'||!child.pid)return false;try{process.kill(-child.pid,0);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error}};
  const kill=(signal:NodeJS.Signals)=>{
   try{if(process.platform!=='win32'&&child.pid){process.kill(-child.pid,signal);return}}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error}
   if(directAlive())child.kill(signal);
  };
  const task=(async()=>{
   let graceTimer:ReturnType<typeof setTimeout>|undefined,closeTimer:ReturnType<typeof setTimeout>|undefined;
   try{
    // An owned process group can remain after its leader has exited. Its other
    // processes still receive TERM and the full KILL escalation when needed.
    kill('SIGTERM');
    const grace=new Promise<void>(done=>{graceTimer=setTimeout(done,this.options.killGraceMs??2000)});
    await Promise.race([closed,grace]);
    if(groupAlive()||directAlive()){await grace;kill('SIGKILL')}
    await Promise.race([closed,new Promise<never>((_done,reject)=>{closeTimer=setTimeout(()=>reject(new AntigravityError('Antigravity process shutdown could not be confirmed.',503)),1000)})]);
   }finally{clearTimeout(graceTimer);clearTimeout(closeTimer)}
  })();
  this.processCleanups.add(task);
  void task.catch(()=>{this.error='Antigravity process shutdown could not be confirmed.';if(!this.closed)this.changed()});
 }
 private async drainProcesses(){
  const pending=[...this.processCleanups],results=await Promise.allSettled(pending);
  for(const task of pending)this.processCleanups.delete(task);
  if(results.some(result=>result.status==='rejected'))throw new AntigravityError('Antigravity process shutdown could not be confirmed.',503);
 }
 private breakConnection(message?:string){
  const connection=this.connection,child=this.child;this.connection=undefined;this.child=undefined;this.initialized=undefined;this.loaded.clear();this.replaying.clear();
  clearTimeout(this.authTimer);if(this.authState==='waiting')this.authState='error';
  if(message)this.error=message;
  for(const p of [...this.pending.values()])p.settle({outcome:'cancelled'});
  if(this.active){const active=this.active;this.update(active.sessionId,{status:'interrupted',error:message??'Disconnected.'});}
  connection?.close();
  if(child)this.stopProcess(child);
  this.changed();
 }
 async authenticate(raw:unknown){
  return this.exclusive(async()=>{
   await this.ensure();const {methodId}=z.object({methodId:z.string().max(80)}).parse(raw);
   if(!personalMethods.has(methodId)||!this.initialized?.authMethods?.some(m=>m.id===methodId))throw new AntigravityError('Choose a sign-in method offered by Antigravity.');
   this.authState='waiting';this.error=undefined;this.changed();const connection=this.connection!;
   this.authTimer=setTimeout(()=>{if(this.connection===connection&&this.authState==='waiting')this.breakConnection('Sign-in timed out. Reconnect and start sign-in again.')},300000);
   void connection.agent.request('authenticate',{methodId}).then(()=>{if(this.connection===connection){clearTimeout(this.authTimer);this.authState='ready';this.changed()}}).catch(error=>{if(this.connection===connection){clearTimeout(this.authTimer);this.authState='error';this.error=publicError(error);this.changed()}});
   return this.status();
  });
 }
 private onUpdate(params:any){
  const row=this.db.query('SELECT id FROM sessions WHERE remoteId=?').get(params.sessionId) as any;if(!row)return;
  const update=params.update;
  if(update.sessionUpdate==='config_option_update')this.update(row.id,{configOptions:permittedOptions(update.configOptions)});
  if(update.sessionUpdate==='session_info_update'&&typeof update.title==='string')this.update(row.id,{title:update.title.slice(0,200)});
  if(this.replaying.has(params.sessionId))return;
  try{this.event(row.id,'agent',update)}catch(error){this.breakConnection(publicError(error))}
 }
 private onPermission(params:any,signal:AbortSignal){
  const active=this.active,session=active?this.session(active.sessionId):undefined;
  if(!active||!session||session.remoteId!==params.sessionId||active.cancelled)return {outcome:{outcome:'cancelled'}};
  const choices=(params.options??[]).filter((p:any)=>['allow_once','reject_once'].includes(p.kind));
  if(!choices.length)return {outcome:{outcome:'cancelled'}};
  return new Promise<any>(resolvePermission=>{
   const id=randomUUID();let settled=false;let timer:ReturnType<typeof setTimeout>;
   const cancel=()=>settle({outcome:'cancelled'});
   const settle=(outcome:any)=>{
    if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);this.pending.delete(id);
    this.event(active.sessionId,'permission_result',{id,outcome});if(this.active?.turnId===active.turnId&&!active.cancelled)this.update(active.sessionId,{status:'running'});
    resolvePermission({outcome});
   };
   const permission:Permission={id,sessionId:active.sessionId,turnId:active.turnId,title:String(params.toolCall?.title??'Antigravity requests permission'),toolCall:params.toolCall,options:choices,createdAt:Date.now(),settle};
   this.pending.set(id,permission);this.event(active.sessionId,'permission',{id,title:permission.title,toolCall:permission.toolCall,options:permission.options});this.update(active.sessionId,{status:'waiting'});
   timer=setTimeout(cancel,this.options.permissionTimeoutMs??600000);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
 }
 permission(id:string,raw:unknown){
  const {permissionId,optionId,turnId}=z.object({permissionId:idSchema,optionId:z.string().max(512),turnId:idSchema}).parse(raw);this.session(id);
  const p=this.pending.get(permissionId);
  if(!p||p.sessionId!==id||p.turnId!==turnId||this.active?.turnId!==turnId||this.active.cancelled)throw new AntigravityError('This permission request has ended. Refresh the session.',409);
  if(!p.options.some(o=>o.optionId===optionId))throw new AntigravityError('Choose an available one-time permission option.');
  p.settle({outcome:'selected',optionId});return this.snapshot(id);
 }
 async create(raw:unknown){
  return this.exclusive(async()=>{
   const {title}=z.object({title:z.string().trim().min(1).max(200).default('Antigravity research')}).parse(raw??{});await this.ensure();
   const id=randomUUID(),cwd=join(this.root,'workspaces',id);mkdirSync(cwd,{recursive:true,mode:0o700});
   const now=Date.now();this.db.query("INSERT INTO sessions(id,title,status,createdAt,updatedAt) VALUES (?,?,'connecting',?,?)").run(id,title,now,now);
   try{
    const remote=await this.request('session/new',{cwd,mcpServers:[]});
    this.update(id,{remoteId:remote.sessionId,configOptions:permittedOptions(remote.configOptions),status:'idle',error:null});this.loaded.add(id);this.authState='ready';return this.snapshot(id);
   }catch(error){this.update(id,{status:'error',error:publicError(error)});throw new AntigravityError(publicError(error))}
  });
 }
 private async load(id:string){
  const session=this.session(id);if(this.loaded.has(id))return session;
  if(!session.remoteId)throw new AntigravityError('This session was not created in Antigravity. Start a new session.');
  const caps=this.initialized?.agentCapabilities;
  const resume=!!caps?.sessionCapabilities?.resume;
  if(!resume&&!caps?.loadSession)throw new AntigravityError('This CLI cannot resume saved sessions. Update the official CLI.');
  this.replaying.add(session.remoteId);
  try{
   const result=await this.request(resume?'session/resume':'session/load',{sessionId:session.remoteId,cwd:this.cwd(id),mcpServers:[]});
   if(result?.configOptions)this.update(id,{configOptions:permittedOptions(result.configOptions)});this.loaded.add(id);this.authState='ready';return this.session(id);
  }finally{this.replaying.delete(session.remoteId)}
 }
 refresh(id:string){return this.exclusive(async()=>{await this.ensure();this.loaded.delete(id);await this.load(id);return this.snapshot(id)})}
 setConfig(id:string,raw:unknown){
  return this.exclusive(async()=>{
   const {configId,value}=z.object({configId:z.string().max(256),value:z.string().max(512)}).parse(raw);await this.ensure();const session=await this.load(id);
   const option=permittedOptions(session.configOptions).find(c=>c.id===configId) as any;
   if(!option||!option.options.some((o:any)=>o.value===value))throw new AntigravityError('Choose a model, thinking level or permission mode offered to this client.');
   const result=await this.request('session/set_config_option',{sessionId:session.remoteId,configId,value});
   this.update(id,{configOptions:permittedOptions(result.configOptions)});return this.snapshot(id);
  });
 }
 async prompt(id:string,raw:unknown){
  const input=z.object({requestId:idSchema,text:z.string().max(256000),attachmentIds:z.array(idSchema).max(8).default([])}).parse(raw);this.session(id);
  if(!input.text.trim()&&!input.attachmentIds.length)throw new AntigravityError('Write a message or attach a file.');
  const fingerprint=hash(JSON.stringify({text:input.text,attachmentIds:input.attachmentIds}));
  const prior=this.db.query('SELECT * FROM turns WHERE id=?').get(input.requestId) as any;
  if(prior){if(prior.sessionId!==id||prior.inputHash!==fingerprint)throw new AntigravityError('This request ID belongs to a different message.',409);return {requestId:prior.id,status:prior.status,replayed:true}}
  return this.exclusive(async()=>{
   await this.ensure();const session=await this.load(id);
   const selected=session.configOptions.find(c=>(c.category??c.id)==='model') as any;
   if(!selected||!selected.options.some((o:any)=>o.value===selected.currentValue))throw new AntigravityError('Select a model advertised by the official Antigravity server.');
   const prompt:any[]=[];if(input.text.trim())prompt.push({type:'text',text:input.text});
   const attachments=input.attachmentIds.map(a=>this.attachment(id,a));
   for(const file of attachments){
    if(file.mimeType.startsWith('image/')){
     if(this.initialized?.agentCapabilities?.promptCapabilities?.image!==true)throw new AntigravityError('This CLI does not advertise image input.');
     prompt.push({type:'image',mimeType:file.mimeType,data:readFileSync(this.filePath(id,file.path)).toString('base64')});
    }else prompt.push({type:'text',text:'The user attached a file in this session workspace: '+file.path+' ('+file.mimeType+'). Read it only if relevant to the user request.'});
   }
   this.db.transaction(()=>{this.db.query("INSERT INTO turns(id,sessionId,inputHash,status,createdAt) VALUES (?,?,?,'running',?)").run(input.requestId,id,fingerprint,Date.now());this.event(id,'user',{text:input.text,attachments:attachments.map(({id,name,mimeType,bytes})=>({id,name,mimeType,bytes})),turnId:input.requestId})})();
   const active={sessionId:id,turnId:input.requestId,cancelled:false,done:Promise.resolve()};this.active=active;this.update(id,{status:'running',error:null});
   const connection=this.connection!;
   active.done=(async()=>{
    try{
     const result=await this.request('session/prompt',{sessionId:session.remoteId,prompt},this.options.turnTimeoutMs??3600000);
     const status=active.cancelled?'cancelled':result.stopReason==='end_turn'?'completed':result.stopReason??'completed';
     this.db.query('UPDATE turns SET status=?,finishedAt=?,result=? WHERE id=?').run(status,Date.now(),JSON.stringify(result),active.turnId);
     this.event(id,'turn_end',{turnId:active.turnId,stopReason:status});this.update(id,{status:active.cancelled?'interrupted':'idle',error:null});
    }catch(error){
     const message=publicError(error),status=active.cancelled?'cancelled':'error';
     this.db.query('UPDATE turns SET status=?,finishedAt=?,result=? WHERE id=?').run(status,Date.now(),JSON.stringify({error:message}),active.turnId);
     this.event(id,'error',{turnId:active.turnId,message});this.update(id,{status:active.cancelled||this.connection!==connection?'interrupted':'error',error:message});
     if(this.connection===connection)this.breakConnection(message);
    }finally{if(this.active===active)this.active=undefined;for(const p of [...this.pending.values()])if(p.turnId===active.turnId)p.settle({outcome:'cancelled'});this.changed()}
   })();
   return {requestId:input.requestId,status:'running',replayed:false};
  });
 }
 async cancel(id:string){
  const session=this.session(id),active=this.active;if(!active||active.sessionId!==id)return this.snapshot(id);
  active.cancelled=true;for(const p of [...this.pending.values()])if(p.sessionId===id)p.settle({outcome:'cancelled'});
  if(this.connection)await this.connection.agent.notify('session/cancel',{sessionId:session.remoteId!}).catch(()=>this.breakConnection('Antigravity disconnected during cancellation.'));
  let timer:ReturnType<typeof setTimeout>;
  await Promise.race([active.done,new Promise<void>(done=>{timer=setTimeout(()=>{this.breakConnection('Antigravity did not stop promptly. Its connection was closed.');done()},this.options.cancelTimeoutMs??15000)})]);clearTimeout(timer!);
  await active.done;return this.snapshot(id);
 }
 private attachment(id:string,attachmentId:string){
  const row=this.db.query('SELECT * FROM attachments WHERE sessionId=? AND id=?').get(id,attachmentId) as any;
  if(!row)throw new AntigravityError('An attachment is unavailable in this session.',404);return row;
 }
 upload(id:string,raw:unknown){
  this.session(id);if(this.active?.sessionId===id)throw new AntigravityError('Wait for this turn to finish before adding files.',409);
  const input=z.object({name:z.string().min(1).max(240),mimeType:z.string().max(128),data:z.string().max(14*1024*1024)}).parse(raw);
  if(!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)||input.data.length%4)throw new AntigravityError('The attachment encoding is invalid.');
  const bytes=Buffer.from(input.data,'base64');if(!bytes.length||bytes.length>10*1024*1024)throw new AntigravityError('Choose a file between 1 byte and 10 MB.');
  if(bytes.toString('base64')!==input.data)throw new AntigravityError('The attachment encoding is invalid.');
  let mimeType=input.mimeType||'application/octet-stream';
  if(mimeType.startsWith('image/')){
   const valid=mimeType==='image/png'&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||mimeType==='image/jpeg'&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255||mimeType==='image/webp'&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'||mimeType==='image/gif'&&/^GIF8[79]a$/.test(bytes.subarray(0,6).toString());
   if(!valid)throw new AntigravityError('Use a valid PNG, JPEG, WebP or GIF image.');
  }
  const attachmentId=randomUUID(),name=basename(input.name.replaceAll('\\','/')).replace(/[^\p{L}\p{N}._ -]/gu,'_').slice(0,160)||'attachment';
  const directory=join(this.cwd(id),'attachments');mkdirSync(directory,{recursive:true,mode:0o700});
  const path='attachments/'+attachmentId+'-'+name;
  writeFileSync(join(this.cwd(id),path),bytes,{mode:0o600,flag:'wx'});
  this.db.query('INSERT INTO attachments(id,sessionId,name,mimeType,path,bytes) VALUES (?,?,?,?,?,?)').run(attachmentId,id,name,mimeType,path,bytes.length);return {id:attachmentId,name,mimeType,bytes:bytes.length};
 }
 private filePath(id:string,path:string){
  const cwd=this.cwd(id),target=resolve(cwd,path);if(!path||isAbsolute(path)||relative(cwd,target).startsWith('..')||target===cwd)throw new AntigravityError('Choose a file inside this session workspace.');
  let parent=target;while(parent!==cwd){if(lstatSync(parent).isSymbolicLink())throw new AntigravityError('Symbolic links cannot be opened from the workbench.');parent=dirname(parent)}
  if(!statSync(target).isFile())throw new AntigravityError('This path is not a regular file.');return target;
 }
 files(id:string){
  const cwd=this.cwd(id),files:Array<{path:string;bytes:number;modifiedAt:number}>=[];
  const walk=(dir:string,depth:number)=>{if(depth>8||files.length>=1000)return;for(const item of readdirSync(dir,{withFileTypes:true})){if(item.isSymbolicLink()||item.name.startsWith('.'))continue;const path=join(dir,item.name);if(item.isDirectory())walk(path,depth+1);else if(item.isFile()){const info=statSync(path);files.push({path:relative(cwd,path).split(sep).join('/'),bytes:info.size,modifiedAt:info.mtimeMs})}if(files.length>=1000)break}};
  walk(cwd,0);return {files,limited:files.length>=1000};
 }
 download(id:string,path:string){
  const target=this.filePath(id,path),fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);return {name:basename(target),stream:createReadStream(target,{fd,autoClose:true})};
 }
 async disconnect(){if(this.active)await this.cancel(this.active.sessionId);this.breakConnection();this.authState='idle';this.error=undefined;await this.drainProcesses();return this.status()}
 close(){
  if(this.closing)return this.closing;
  this.closed=true;const operation=this.operationFinished;
  this.closing=(async()=>{try{
   const [disconnected]=await Promise.allSettled([this.disconnect()]);
   await this.connecting?.catch(()=>undefined);await operation;
   const [cleaned]=await Promise.allSettled([this.drainProcesses()]);
   if(disconnected.status==='rejected')throw disconnected.reason;
   if(cleaned.status==='rejected')throw cleaned.reason;
  }finally{this.db.close()}})();return this.closing;
 }
}
