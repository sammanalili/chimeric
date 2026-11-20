import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {NativeKernelPolicy,NativeKernelPolicyError,type NativeKernelScope,type NativeKernelDrain,type NativeKernelLease} from '../tools/native-kernel-policy';

const runFile=promisify(execFile),kernelMaps=['_kernels','_rKernels','_operonKernels','_byocKernels'];
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/.test(value);
export type NativeProcessReceipt=Readonly<{pids:readonly number[];groups:readonly number[];sessions:readonly number[];controls:readonly Readonly<{pid:number;fd:string;type:string;identity:string}>[]}>;
export interface NativeProcessInspector {
 capture(pids:readonly number[],signal:AbortSignal):Promise<NativeProcessReceipt>;
 drained(receipt:NativeProcessReceipt,signal:AbortSignal):Promise<boolean>;
}
type ProcessRow={pid:number;parent:number;group:number;session:number};
/** Numeric process metadata and socket descriptors only. Descriptor names are
 * hashed immediately and never exposed in errors or application logs. This is
 * evidence for the captured tree, not proof of historical descendant coverage. */
export class MacNativeProcessInspector implements NativeProcessInspector {
 private async command(file:string,args:string[],signal:AbortSignal,empty=false){
  if(process.platform!=='darwin')throw new NativeKernelPolicyError('Native process teardown has not been verified on this platform.',403);
  try{return (await runFile(file,args,{encoding:'utf8',timeout:3000,maxBuffer:4*1024*1024,signal,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LC_ALL:'C'}})).stdout}
  catch(error:any){signal.throwIfAborted();if(empty&&error?.code===1&&error?.stdout==='')return '';throw new NativeKernelPolicyError('Native process or control-descriptor accounting failed. Protected execution remains blocked.')}
 }
 private async rows(signal:AbortSignal):Promise<ProcessRow[]>{
  const output=await this.command('/bin/ps',['-axo','pid=,ppid=,pgid=,sess='],signal),rows:ProcessRow[]=[];
  for(const line of output.trim().split('\n')){
   if(!line.trim())continue;const values=line.trim().split(/\s+/).map(Number);
   if(values.length!==4||values.some(value=>!Number.isSafeInteger(value)||value<0)||values[0]<1)throw new NativeKernelPolicyError('The native process census could not be verified.');
   rows.push({pid:values[0],parent:values[1],group:values[2],session:values[3]});
  }
  if(rows.length>65_536||new Set(rows.map(row=>row.pid)).size!==rows.length)throw new NativeKernelPolicyError('The native process census exceeded its verification limit.');return rows;
 }
 async capture(input:readonly number[],signal:AbortSignal):Promise<NativeProcessReceipt>{
  if(input.some(pid=>!Number.isSafeInteger(pid)||pid<2||pid===process.pid)||input.length>4096)throw new NativeKernelPolicyError('Invalid native process ownership metadata.');
  if(!input.length)return Object.freeze({pids:[],groups:[],sessions:[],controls:[]});
  const rows=await this.rows(signal),own=rows.find(row=>row.pid===process.pid);if(!own)throw new NativeKernelPolicyError('The native daemon process identity is unavailable.');
  const selected=new Set(input);let changed=true;while(changed){changed=false;for(const row of rows)if(selected.has(row.parent)&&!selected.has(row.pid)){selected.add(row.pid);changed=true}}
  if(selected.has(process.pid)||selected.has(process.ppid)||selected.size>4096)throw new NativeKernelPolicyError('The native child process tree exceeded its ownership boundary.');
  const groups=new Set<number>(),sessions=new Set<number>();for(const row of rows)if(selected.has(row.pid)){
   if(row.group>1&&row.group!==own.group)groups.add(row.group);if(row.session>1&&row.session!==own.session)sessions.add(row.session);
  }
  // Capture every process already sharing an owned child group/session too.
  for(const row of rows)if(groups.has(row.group)||sessions.has(row.session))selected.add(row.pid);
  if(selected.has(process.pid)||selected.has(process.ppid)||selected.size>4096)throw new NativeKernelPolicyError('The native child process group exceeded its ownership boundary.');
  const pids=[...selected].sort((a,b)=>a-b),present=pids.filter(pid=>rows.some(row=>row.pid===pid));
  const descriptors=present.length?await this.command('/usr/sbin/lsof',['-n','-P','-a','-p',present.join(','),'-F0pftn'],signal,true):'';
  const controls:Array<{pid:number;fd:string;type:string;identity:string}>=[];let pid=0,fd='',type='';
  for(const raw of descriptors.split('\0')){const field=raw.replace(/^\n/,''),key=field[0],value=field.slice(1);if(key==='p'){pid=Number(value);fd='';type=''}else if(key==='f'){fd=value;type=''}else if(key==='t')type=value;else if(key==='n'&&['IPv4','IPv6','unix','PIPE'].includes(type)){
   if(!selected.has(pid)||!fd||controls.length>=65_536)throw new NativeKernelPolicyError('The native control-descriptor census could not be verified.');controls.push({pid,fd,type,identity:hash(value)});
  }}
  return Object.freeze({pids:Object.freeze(pids),groups:Object.freeze([...groups]),sessions:Object.freeze([...sessions]),controls:Object.freeze(controls.map(row=>Object.freeze(row)))});
 }
 async drained(receipt:NativeProcessReceipt,signal:AbortSignal){
  if(!receipt.pids.length)return true;
  const rows=await this.rows(signal),pids=new Set(receipt.pids),groups=new Set(receipt.groups),sessions=new Set(receipt.sessions);
  // Any PID reuse is conservatively still busy. Once the entire captured tree,
  // owned groups and sessions are absent, the OS has closed their descriptors.
  return !rows.some(row=>pids.has(row.pid)||groups.has(row.group)||sessions.has(row.session));
 }
}
export type NativeReviewerSnapshot={frameId:string;rootFrameId:string;inFlight:Promise<unknown>[];controller:AbortController;hasTimer:boolean;pending:boolean};
export type NativeRuntimeControls={reviewers:(root:string)=>NativeReviewerSnapshot[];abortReviewers:(root:string)=>void};
export type NativeModelLease=Readonly<{signal:AbortSignal;assertCurrent:()=>void;close:()=>void}>;
type Work={kind:string;controller:AbortController;done:Promise<unknown>};
type ProcessOwner={scope:NativeKernelScope;kernel:any;process:any};
type Runtime={context:any;controls:NativeRuntimeControls};
export type NativeKernelEnforcementOptions={
 resolveScope:(frameId:string)=>NativeKernelScope|Promise<NativeKernelScope>;
 assertScope:(scope:NativeKernelScope)=>void;
 /** A trusted, conservative metadata check is mandatory before first entering
  * protected mode. Unknown pre-install/restart subprocess history must fail. */
 assertNoUnconfinedHistory?:(scope:NativeKernelScope)=>void|Promise<void>;
 allowProtectedKernel?:(scope:NativeKernelScope,environment:string,Constructor:any)=>boolean;
 inspector?:NativeProcessInspector;timeoutMs?:number;
};
/** Production glue for the checked native hooks. It grants no compute lane by
 * itself. Failed transitions keep their barrier; preflight failures do not stop
 * an otherwise standard chat. All callbacks live only in the daemon. */
export class NativeKernelEnforcement {
 readonly kernels:NativeKernelPolicy;
 private storage=new AsyncLocalStorage<NativeKernelScope>();private runtimes=new Map<any,Runtime>();private managers=new Set<any>();
 private scopes=new WeakMap<object,NativeKernelScope>();private processes=new Map<string,Set<ProcessOwner>>();
 private work=new Map<string,Set<Work>>();private unknown=new Set<Promise<unknown>>();private blocked=new Set<string>();private uncontrolled=new Set<string>();
 private receipts=new Map<string,NativeProcessReceipt>();private inspector:NativeProcessInspector;private closed=false;
 constructor(private options:NativeKernelEnforcementOptions){
  this.inspector=options.inspector??new MacNativeProcessInspector();
  this.kernels=new NativeKernelPolicy({resolveScope:options.resolveScope,assertScope:options.assertScope,allowProtectedKernel:options.allowProtectedKernel,timeoutMs:options.timeoutMs??20_000,
   quiesceRoot:(scope,signal)=>this.quiesce(scope,signal),verifyDrained:(_manager,scope,drain,signal)=>this.verify(scope,drain,signal)});
 }
 private check(){if(this.closed)throw new NativeKernelPolicyError('The native execution boundary is closed.')}
 private assert(scope:NativeKernelScope){this.check();const result:any=this.options.assertScope(scope);if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});throw new NativeKernelPolicyError('Native execution assertions must be synchronous.')}}
 assertAvailable(scope:NativeKernelScope){this.assert(scope);if(this.blocked.has(scope.rootFrameId))throw new NativeKernelPolicyError('This chat is changing its confidentiality policy. Wait for the transition to finish.')}
 /** Called at the existing checked native execution guard, before the standard
  * early return. A later PID snapshot cannot erase this execution history. */
 noteNativeExecution(kind:string,scope:NativeKernelScope){
  this.assertAvailable(scope);
  if(scope.mode==='standard'&&['kernel','process','shell','sandbox-process','sandbox-shell','sandbox-provisioning','sandbox-operon','sandbox-byoc','host-call'].includes(kind))this.uncontrolled.add(scope.rootFrameId);
 }
 private sameRoot(a:NativeKernelScope,b:NativeKernelScope){return a.rootFrameId===b.rootFrameId&&a.ownerId===b.ownerId&&a.organizationId===b.organizationId&&a.projectId===b.projectId}
 registerManager(manager:any){this.kernels.register(manager);this.managers.add(manager)}
 releaseManager(manager:any){this.kernels.release(manager)}
 async acquire(manager:any,frameId:string,environment:string,Constructor:any):Promise<NativeKernelLease>{
  const lease=await this.kernels.acquire(manager,frameId,environment,Constructor);this.assertAvailable(lease.scope);
  return Object.freeze({...lease,bind:(kernel:any)=>{lease.bind(kernel);this.scopes.set(kernel,lease.scope);if(lease.scope.mode==='standard')this.uncontrolled.add(lease.scope.rootFrameId)}});
 }
 processAttached(kernel:any,process:any){
  const scope=this.scopes.get(kernel);if(!scope)throw new NativeKernelPolicyError('A native process has no verified generation owner.');
  let rows=this.processes.get(scope.rootFrameId);if(!rows)this.processes.set(scope.rootFrameId,rows=new Set());rows.add({scope,kernel,process});
  if(scope.mode==='standard')this.uncontrolled.add(scope.rootFrameId);this.kernels.processAttached(kernel,process);
 }
 registerRuntimeServices<T>(context:T,controls:NativeRuntimeControls):T{
  this.check();const value=context as any,gateway=value?.services?.gateway,agent=value?.agentSvc;
  if(!gateway||agent?.services!==gateway||!(agent._running instanceof Map)||typeof agent.cancelConversation!=='function'||
   !(gateway.task_registry?._tasks instanceof Map)||!(gateway.active_frames?._frames instanceof Map)||!this.managers.has(gateway.kernel_manager)||
   gateway.signals!==value.services.signals||typeof gateway.signals?.signalInterrupt!=='function'||typeof controls?.reviewers!=='function'||typeof controls.abortReviewers!=='function')
   throw new NativeKernelPolicyError('The native research service boundary could not be verified.');
  const existing=this.runtimes.get(agent);if(existing&&(existing.context!==context||existing.controls!==controls))throw new NativeKernelPolicyError('A native research service cannot change its ownership boundary.');
  this.runtimes.set(agent,{context,controls});return context;
 }
 private track<T>(root:string,kind:string,callback:(signal:AbortSignal)=>T,scope?:NativeKernelScope):Promise<Awaited<T>>{
  this.check();if(this.blocked.has(root))return Promise.reject(new NativeKernelPolicyError('The chat confidentiality transition is in progress.'));
  let resolve!:(value:unknown)=>void;const controller=new AbortController(),done=new Promise(yes=>resolve=yes),entry:Work={kind,controller,done};
  let rows=this.work.get(root);if(!rows)this.work.set(root,rows=new Set());rows.add(entry);
  const run=async()=>{try{return await callback(controller.signal)}finally{rows!.delete(entry);if(!rows!.size)this.work.delete(root);resolve(undefined)}};
  return (scope?this.storage.run(scope,run):run()) as Promise<Awaited<T>>;
 }
 withNativeAgentJob<T>(agent:any,request:any,callback:()=>T):Promise<Awaited<T>>{
  if(!this.runtimes.has(agent)||!validId(request?.frame_id)||!validId(request?.root_frame_id))return Promise.reject(new NativeKernelPolicyError('This native research job has no verified service or frame.'));
  return this.track(request.root_frame_id,'native-agent',async()=>{
   const scope=await this.options.resolveScope(request.frame_id);this.assertAvailable(scope);
   if(scope.rootFrameId!==request.root_frame_id||scope.projectId!==request.project_id||request.user_id!=null&&scope.ownerId!==request.user_id)throw new NativeKernelPolicyError('The native research request does not match its authenticated owner.');
   return await this.storage.run(scope,callback);
  });
 }
 withNativeRootTask<T>(root:string|null|undefined,callback:()=>T):T|Promise<Awaited<T>>{
  const inherited=this.storage.getStore(),selected=root??inherited?.rootFrameId;
  if(!selected){const result=callback();if(result&&typeof(result as any).then==='function')this.trackNativeBackground(result as Promise<unknown>);return result}
  return this.track(selected,'native-root-task',async()=>{
   const scope=inherited??await this.options.resolveScope(selected);this.assertAvailable(scope);
   if(scope.rootFrameId!==selected)throw new NativeKernelPolicyError('The native background task changed its owning root.');return await this.storage.run(scope,callback);
  },inherited);
 }
 trackNativeBackground(promise:Promise<unknown>){
  this.check();if(!promise||typeof promise.then!=='function')throw new NativeKernelPolicyError('The native background completion boundary changed.');
  const scope=this.storage.getStore();if(scope){
   const root=scope.rootFrameId,controller=new AbortController();let rows=this.work.get(root);if(!rows)this.work.set(root,rows=new Set());
   const entry:Work={kind:'native-background',controller,done:promise};rows.add(entry);const settle=()=>{rows!.delete(entry);if(!rows!.size)this.work.delete(root)};void promise.then(settle,settle);
  }else{this.unknown.add(promise);const settle=()=>this.unknown.delete(promise);void promise.then(settle,settle)}
 }
 beginModel(scope:NativeKernelScope):NativeModelLease{
  this.assertAvailable(scope);const controller=new AbortController();let finish!:()=>void;const done=new Promise<void>(yes=>finish=yes),entry:Work={kind:'model',controller,done};
  let rows=this.work.get(scope.rootFrameId);if(!rows)this.work.set(scope.rootFrameId,rows=new Set());rows.add(entry);let closed=false;
  return Object.freeze({signal:controller.signal,assertCurrent:()=>{controller.signal.throwIfAborted();this.assertAvailable(scope)},close:()=>{if(closed)return;closed=true;rows!.delete(entry);if(!rows!.size)this.work.delete(scope.rootFrameId);finish()}});
 }
 async withModel<T>(scope:NativeKernelScope,callback:(signal:AbortSignal)=>Promise<T>){const lease=this.beginModel(scope);try{return await callback(lease.signal)}finally{lease.close()}}
 private frameIds(scope:NativeKernelScope){
  const frames=new Set([scope.rootFrameId]);
  for(const manager of this.managers)for(const [id,context]of manager._frameContext)if(id===scope.rootFrameId||context.rootFrameId===scope.rootFrameId){
   if(context.projectId!==scope.projectId||context.userId!==scope.ownerId)throw new NativeKernelPolicyError('A native child context has an inconsistent project or owner.');frames.add(id);
  }
  for(const {context}of this.runtimes.values()){
   for(const row of context.agentSvc._running.get(scope.rootFrameId)??[])if(validId(row.frameId))frames.add(row.frameId);
   for(const id of context.services.gateway.task_registry.frameIds(scope.rootFrameId))if(validId(id))frames.add(id);else throw new NativeKernelPolicyError('Invalid native child task identity.');
  }
  return frames;
 }
 private collect(scope:NativeKernelScope,frames:Set<string>){
  const kernels=new Set<any>(),pids=new Set<number>();
  for(const row of this.processes.get(scope.rootFrameId)??[]){if(!frames.has(row.scope.frameId))continue;if(!this.sameRoot(scope,row.scope))throw new NativeKernelPolicyError('A retained native process has an inconsistent owner.');if(row.process?.pid)pids.add(row.process.pid);kernels.add(row.kernel)}
  for(const manager of this.managers)for(const id of frames){
   for(const name of kernelMaps)for(const kernel of manager[name].get(id)?.values()??[])kernels.add(kernel);
   for(const kernel of manager._startingKernels.get(id)??[])kernels.add(kernel);
   for(const row of manager._execStreams?.get(id)?.values()??[]){
    if(row.notAbortable&&!row.done&&!row.execReturned)throw new NativeKernelPolicyError('A non-cancellable environment operation is still running. Wait for it to finish before changing confidentiality.');
    if(!row.done&&!row.execReturned){if(row.kernel)kernels.add(row.kernel);else if(Number.isSafeInteger(row.pid)&&row.pid>1)pids.add(row.pid);else if(row.started)throw new NativeKernelPolicyError('A running native subprocess has no verifiable process identity.')}
   }
  }
  for(const kernel of kernels)if(kernel.process?.pid){
   if(!this.scopes.has(kernel))throw new NativeKernelPolicyError('An existing native kernel predates verified process accounting. Start a new protected chat.');pids.add(kernel.process.pid);
  }
  return {kernels,pids:[...pids]};
 }
 private async waitUntil(check:()=>boolean|Promise<boolean>,signal:AbortSignal){while(!await check()){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,10))}signal.throwIfAborted()}
 private async quiesce(scope:NativeKernelScope,signal:AbortSignal){
  if(!this.runtimes.size)throw new NativeKernelPolicyError('The native research services have not registered their execution boundary.');
  // A first protected kernel is requested from inside its current native agent
  // job. Do not cancel/wait for that same job. It may acquire only a clean frame;
  // replacement of any existing generation requires the root transition path.
  if(!this.blocked.has(scope.rootFrameId)){
   if(scope.mode!=='class2')throw new NativeKernelPolicyError('Kernel configuration changes require an authenticated root transition.');
   const collected=this.collect(scope,new Set([scope.frameId]));
   if(collected.kernels.size||collected.pids.length)throw new NativeKernelPolicyError('An existing kernel generation requires a root confidentiality transition.');
   this.receipts.set('frame:'+scope.frameId,await this.inspector.capture([],signal));return;
  }
  const frames=this.frameIds(scope);for(const id of frames){const child=await this.options.resolveScope(id);this.assert(child);if(!this.sameRoot(scope,child))throw new NativeKernelPolicyError('A native child task has an inconsistent authenticated owner.')}
  if(this.unknown.size)throw new NativeKernelPolicyError('An unscoped native background operation is still active. Wait for it to finish.');
  const collected=this.collect(scope,frames),receipt=await this.inspector.capture(collected.pids,signal);this.receipts.set('root:'+scope.rootFrameId,receipt);
  const reviewerPromises=new Set<Promise<unknown>>(),keepalives:any[]=[];
  for(const runtime of this.runtimes.values()){
   const {agentSvc:agent,services}=runtime.context,gateway=services.gateway;
   for(const row of runtime.controls.reviewers(scope.rootFrameId)){
    if(row.rootFrameId!==scope.rootFrameId&&row.frameId!==scope.rootFrameId||!Array.isArray(row.inFlight))throw new NativeKernelPolicyError('A native reviewer has an inconsistent root.');for(const promise of row.inFlight)reviewerPromises.add(promise);
   }
   const keepalive=agent.betweenTurnsKeepalive?._entries?.get(scope.rootFrameId)?.ka;if(keepalive)keepalives.push(keepalive);
   await agent.cancelConversation(scope.rootFrameId);gateway.task_registry.cancelConversation(scope.rootFrameId);runtime.controls.abortReviewers(scope.rootFrameId);
   for(const id of frames)gateway.signals.signalInterrupt(id);
  }
  for(const row of this.work.get(scope.rootFrameId)??[])row.controller.abort(new NativeKernelPolicyError('The chat confidentiality setting is changing.'));
  for(const manager of this.managers)for(const id of frames){for(const [execId,row]of manager._userExecs?.get(id)??[])if(!row.done)manager.interruptUserExec(id,execId);for(const [execId,row]of manager._execStreams?.get(id)??[])if(!row.done)manager.interruptExecStream(id,execId)}
  // Killing the actual kernel unblocks a native execute whose Python code ignores
  // a soft interrupt. The coordinator subsequently repeats checked cleanup.
  await Promise.allSettled([...collected.kernels].map(kernel=>kernel.shutdown({skipLibsRm:true,cause:'teardown'})));
  await Promise.allSettled([...reviewerPromises]);signal.throwIfAborted();
  await this.waitUntil(()=>!(this.work.get(scope.rootFrameId)?.size)&&keepalives.every(row=>row._inFlight===false),signal);
  for(const runtime of this.runtimes.values()){
   if(runtime.context.agentSvc._running.get(scope.rootFrameId)?.size||runtime.context.services.gateway.task_registry.frameIds(scope.rootFrameId).length)throw new NativeKernelPolicyError('Native research jobs have not fully settled.');
   if(runtime.controls.reviewers(scope.rootFrameId).some(row=>row.inFlight.length||row.hasTimer||row.pending))throw new NativeKernelPolicyError('A detached native reviewer remains active.');
  }
  await this.waitUntil(()=>this.inspector.drained(receipt,signal),signal);
 }
 private async verify(scope:NativeKernelScope,drain:NativeKernelDrain,signal:AbortSignal){
  const transitioning=this.blocked.has(scope.rootFrameId),receipt=this.receipts.get(transitioning?'root:'+scope.rootFrameId:'frame:'+scope.frameId);if(!receipt)return false;
  if(drain.processes.some(process=>!receipt.pids.includes(process.pid)))return false;
  return (!transitioning||!(this.work.get(scope.rootFrameId)?.size))&&!this.unknown.size&&await this.inspector.drained(receipt,signal);
 }
 async transition(scope:NativeKernelScope,target:'standard'|'class2',apply:()=>void|Promise<void>){
  this.assert(scope);if(!['standard','class2'].includes(target))throw new NativeKernelPolicyError('Invalid confidentiality target.',400);
  if(target==='class2'){
   if(this.uncontrolled.has(scope.rootFrameId))throw new NativeKernelPolicyError('This chat has run an unrestricted native kernel. Start a new protected chat so prior subprocesses cannot retain access.');
   if(!this.options.assertNoUnconfinedHistory)throw new NativeKernelPolicyError('Earlier native compute history has not been verified. Protected mode remains unavailable.');
   await this.options.assertNoUnconfinedHistory(scope);this.assert(scope);
   if(this.uncontrolled.has(scope.rootFrameId))throw new NativeKernelPolicyError('Native compute started while confidentiality was being checked. Start a new protected chat.');
   if(this.unknown.size)throw new NativeKernelPolicyError('An unscoped native background operation is still active. Wait for it to finish.');
   // Older kernels and shell streams may predate this component's hook ledger.
   // Existing bookkeeping is therefore disqualifying, even if the new service
   // has not yet seen its process spawn. Do this before cancelling standard work.
   if(scope.mode==='standard')for(const manager of this.managers)for(const [id,context]of manager._frameContext)if(id===scope.rootFrameId||context.rootFrameId===scope.rootFrameId){
    if(kernelMaps.some(name=>(manager[name].get(id)?.size??0)>0)||(manager._startingKernels.get(id)?.size??0)>0||(manager._execStreams?.get(id)?.size??0)>0||(manager._userExecs?.get(id)?.size??0)>0)
     throw new NativeKernelPolicyError('This chat has existing native compute history. Start a new protected chat so earlier subprocesses cannot retain access.');
   }
  }
  if(this.blocked.has(scope.rootFrameId)&&target!=='standard')throw new NativeKernelPolicyError('A prior confidentiality transition needs recovery before protected mode can start.');
  this.blocked.add(scope.rootFrameId);
  await this.kernels.transition(scope,async()=>{
   if(target==='class2'&&this.uncontrolled.has(scope.rootFrameId))throw new NativeKernelPolicyError('An unrestricted native process started before the confidentiality barrier completed.');
   if(this.work.get(scope.rootFrameId)?.size||this.unknown.size)throw new NativeKernelPolicyError('Native or model work restarted before the confidentiality transition completed.');
   await apply();const current=await this.options.resolveScope(scope.frameId);this.assert(current);if(!this.sameRoot(scope,current)||current.mode!==target)throw new NativeKernelPolicyError('The committed chat confidentiality policy does not match the verified transition.');
  });
  this.blocked.delete(scope.rootFrameId);this.receipts.delete('root:'+scope.rootFrameId);this.processes.delete(scope.rootFrameId);
 }
 callbacks(){return {registerNativeKernelManager:(manager:any)=>this.registerManager(manager),releaseNativeKernelManager:(manager:any)=>this.releaseManager(manager),nativeKernelLease:(manager:any,frame:string,environment:string,Constructor:any)=>this.acquire(manager,frame,environment,Constructor),assertNativeKernel:(kernel:any)=>this.kernels.assertKernel(kernel),nativeKernelProcessAttached:(kernel:any,process:any)=>this.processAttached(kernel,process),registerNativeRuntimeServices:<T>(context:T,controls:NativeRuntimeControls)=>this.registerRuntimeServices(context,controls),withNativeAgentJob:<T>(agent:any,request:any,callback:()=>T)=>this.withNativeAgentJob(agent,request,callback),withNativeRootTask:<T>(root:string|null,callback:()=>T)=>this.withNativeRootTask(root,callback),trackNativeBackground:(promise:Promise<unknown>)=>this.trackNativeBackground(promise)}}
 close(){if(this.closed)return;this.closed=true;for(const rows of this.work.values())for(const row of rows)row.controller.abort(new NativeKernelPolicyError('The app is closing.'));this.kernels.close();this.storage.disable()}
}
