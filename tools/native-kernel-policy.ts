import {createHash} from 'node:crypto';
import * as t from '@babel/types';

export type NativeKernelScope=Readonly<{frameId:string;rootFrameId:string;projectId:string;ownerId:string;organizationId:string;
 mode:'standard'|'class2';revision:number;executionBinding:string}>;
export type NativeKernelDrain={frameId:string;kernels:readonly any[];processes:readonly any[];executions:readonly any[]};
export type NativeKernelLease=Readonly<{scope:NativeKernelScope;signal:AbortSignal;assertCurrent:()=>void;
 cached:(kernel:any)=>any;bind:(kernel:any)=>void;start:(kernel:any,start:()=>Promise<unknown>)=>Promise<unknown>;abort:()=>Promise<void>}>;
type State={scope:NativeKernelScope;binding:string;epoch:number;controller:AbortController;queue:Promise<unknown>;owned:Map<object,Set<any>>};
type Binding={state:State;epoch:number;scope:NativeKernelScope};
export class NativeKernelPolicyError extends Error{constructor(message:string,readonly status=409){super(message)}}
const same=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const maps=['_kernels','_rKernels','_operonKernels','_byocKernels'] as const;

/** Kernel generations are owned in the daemon. Neither a worker JSON message nor
 * a persisted model transcript can mint a lease or change its scope.
 *
 * The injected resolver/assertion use authenticated native frame records. The
 * drain verifier must establish actual child-process/descriptor teardown on the
 * selected platform; empty JS maps alone are never sufficient evidence. */
export class NativeKernelPolicy{
 private managers=new Set<any>();private closedManagers=new WeakSet<object>();private states=new WeakMap<object,Map<string,State>>();
 private bindings=new WeakMap<object,Binding>();private leases=new WeakSet<object>();private transitions=new Map<string,Promise<unknown>>();
 private blockedRoots=new Set<string>();private closed=false;
 constructor(private options:{resolveScope:(frameId:string)=>NativeKernelScope|Promise<NativeKernelScope>;
  assertScope:(scope:NativeKernelScope)=>void;
  allowProtectedKernel?:(scope:NativeKernelScope,environment:string,Constructor:any)=>boolean;
  quiesceRoot:(scope:NativeKernelScope,signal:AbortSignal)=>Promise<void>;
  verifyDrained:(manager:any,scope:NativeKernelScope,drain:NativeKernelDrain,signal:AbortSignal)=>Promise<boolean>;
  timeoutMs?:number}){
  if(!Number.isSafeInteger(options.timeoutMs??15000)||(options.timeoutMs??15000)<1||(options.timeoutMs??15000)>60000)throw new NativeKernelPolicyError('Invalid kernel transition timeout.',400);
 }
 private checkOpen(){if(this.closed)throw new NativeKernelPolicyError('The native kernel policy is closed.')}
 private validate(raw:NativeKernelScope):NativeKernelScope{
  const scope=structuredClone(raw);
  if(!scope||!['standard','class2'].includes(scope.mode)||!Number.isSafeInteger(scope.revision)||scope.revision<0||
    !/^[a-f0-9]{64}$/.test(scope.executionBinding)||['frameId','rootFrameId','projectId','ownerId','organizationId'].some(key=>typeof(scope as any)[key]!=='string'||!(scope as any)[key]||(scope as any)[key].length>255))
   throw new NativeKernelPolicyError('The native kernel scope could not be verified.');
  return Object.freeze(scope);
 }
 private root(scope:NativeKernelScope){return same([scope.organizationId,scope.ownerId,scope.projectId,scope.rootFrameId])}
 private assertScope(scope:NativeKernelScope){
  const result:any=this.options.assertScope(scope);
  if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});throw new NativeKernelPolicyError('Kernel scope assertions must complete synchronously before protocol writes.')}
 }
 private assertState(state:State,epoch:number){
  this.checkOpen();if(state.epoch!==epoch||state.controller.signal.aborted||this.blockedRoots.has(this.root(state.scope)))throw new NativeKernelPolicyError('The kernel belongs to an earlier confidentiality generation. Recreate it before executing.');
  this.assertScope(state.scope);
 }
 register(manager:any){
  this.checkOpen();if(!manager||typeof manager!=='object'||this.closedManagers.has(manager)||typeof manager.cleanup!=='function'||
   !(manager._frameContext instanceof Map)||maps.some(name=>!(manager[name] instanceof Map))||!(manager._startingKernels instanceof Map))throw new NativeKernelPolicyError('The native kernel manager boundary is unavailable.');
  this.managers.add(manager);if(!this.states.has(manager))this.states.set(manager,new Map());
 }
 release(manager:any){
  if(!manager||typeof manager!=='object')return;
  // Closing native managers use allSettled and clear their caches before child
  // teardown. Keep their owned process references in the transition boundary.
  this.closedManagers.add(manager);
  for(const state of this.states.get(manager)?.values()??[]){state.epoch++;state.controller.abort(new NativeKernelPolicyError('The native kernel manager closed.'))}
 }
 private snapshot(manager:any,frameId:string):NativeKernelDrain{
  const kernels=new Set<any>();for(const name of maps)for(const kernel of manager[name].get(frameId)?.values()??[])kernels.add(kernel);
  for(const kernel of manager._startingKernels.get(frameId)??[])kernels.add(kernel);
  const owned=this.states.get(manager)?.get(frameId)?.owned;
  for(const kernel of owned?.keys()??[])kernels.add(kernel);
  const executions=[...manager._execStreams?.get(frameId)?.values()??[]];for(const row of executions)if(row.kernel)kernels.add(row.kernel);
  return {frameId,kernels:[...kernels],processes:[...new Set([...kernels].map(kernel=>kernel.process).concat([...owned?.values()??[]].flatMap(values=>[...values])).filter(Boolean))],executions};
 }
 private async bounded<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(new NativeKernelPolicyError('Native kernel transition timed out; protected execution remains blocked.')),this.options.timeoutMs??15000);
  try{
   return await Promise.race([run(controller.signal),new Promise<never>((_yes,no)=>{controller.signal.addEventListener('abort',()=>no(controller.signal.reason),{once:true})})]);
  }finally{clearTimeout(timeout)}
 }
 private async drain(manager:any,scope:NativeKernelScope,signal:AbortSignal){
  signal.throwIfAborted();const before=this.snapshot(manager,scope.frameId);
  if(before.executions.some(row=>row.notAbortable&&!row.done&&!row.execReturned))throw new NativeKernelPolicyError('A non-cancellable package or environment operation is still running. Confidentiality cannot change until it finishes.');
  for(const [id,row]of manager._userExecs?.get(scope.frameId)??[])if(!row.done)manager.interruptUserExec?.(scope.frameId,id);
  for(const [id,row]of manager._execStreams?.get(scope.frameId)??[])if(!row.done)manager.interruptExecStream?.(scope.frameId,id);
  await manager.cleanup(scope.frameId,{preserveWorkspace:true,preserveContext:true,dropExecStreams:true,cause:'teardown'});
  // Native cleanup aborts starts and clears maps, but intentionally uses
  // allSettled for shutdown. Keep references and wait for queued boots as well.
  await Promise.allSettled(before.kernels.map(kernel=>kernel.shutdown({skipLibsRm:true,cause:'teardown'})));
  while((manager._startingKernels.get(scope.frameId)?.size??0)>0||(manager._freshSpawnsPending?.get(scope.frameId)??0)>0){signal.throwIfAborted();await new Promise(resolve=>setTimeout(resolve,5))}
  signal.throwIfAborted();
  const after=this.snapshot(manager,scope.frameId);
  if(after.kernels.some(kernel=>kernel.isAlive||kernel.routableAlive)||after.executions.some(row=>!row.done&&!row.execReturned)||
    before.kernels.some(kernel=>kernel.isAlive||kernel.routableAlive)||await this.options.verifyDrained(manager,scope,before,signal)!==true)
   throw new NativeKernelPolicyError('Native kernel process or control-channel teardown could not be verified. Protected execution remains blocked.');
  this.states.get(manager)?.get(scope.frameId)?.owned.clear();
 }
 async acquire(manager:any,frameId:string,environment:string,Constructor:any):Promise<NativeKernelLease>{
  this.checkOpen();if(!this.managers.has(manager)||this.closedManagers.has(manager))throw new NativeKernelPolicyError('Register the native kernel manager before requesting a kernel.');
  let scope=this.validate(await this.options.resolveScope(frameId));if(scope.frameId!==frameId)throw new NativeKernelPolicyError('The native kernel frame does not match its policy.');
  if(this.blockedRoots.has(this.root(scope)))throw new NativeKernelPolicyError('The chat confidentiality transition has not completed.');
  if(scope.mode==='class2'&&this.options.allowProtectedKernel?.(scope,environment,Constructor)!==true)throw new NativeKernelPolicyError('This persistent kernel kind has not been verified for protected execution.',403);
  const frames=this.states.get(manager)!;let state=frames.get(frameId);
  if(!state){state={scope,binding:'',epoch:0,controller:new AbortController(),queue:Promise.resolve(),owned:new Map()};frames.set(frameId,state)}
  const selected=state;
  const pending=selected.queue.catch(()=>{}).then(async()=>{
   scope=this.validate(await this.options.resolveScope(frameId));this.assertScope(scope);
   if(this.blockedRoots.has(this.root(scope)))throw new NativeKernelPolicyError('The chat confidentiality transition has not completed.');
   if(scope.mode==='class2'&&this.options.allowProtectedKernel?.(scope,environment,Constructor)!==true)throw new NativeKernelPolicyError('This persistent kernel kind has not been verified for protected execution.',403);
   const binding=same(scope);
   if(selected.binding!==binding){
    const requiresDrain=!!selected.binding||scope.mode==='class2';selected.epoch++;selected.controller.abort(new NativeKernelPolicyError('Kernel confidentiality changed.'));selected.controller=new AbortController();
    if(requiresDrain)await this.bounded(async signal=>{await this.options.quiesceRoot(scope,signal);await this.drain(manager,scope,signal)});
    this.assertScope(scope);const current=this.validate(await this.options.resolveScope(frameId));
    if(same(current)!==binding)throw new NativeKernelPolicyError('The chat policy changed while draining its kernel. Review the current setting.');
    selected.scope=scope;selected.binding=binding;
   }
   return this.lease(manager,selected,scope);
  });
  selected.queue=pending;return pending;
 }
 private lease(manager:any,state:State,scope:NativeKernelScope):NativeKernelLease{
  const epoch=state.epoch,created=new Set<any>(),current=()=>this.assertState(state,epoch);
  const bind=(kernel:any)=>{
   current();if(!kernel||typeof kernel!=='object'||kernel.frameId!==scope.frameId||kernel.projectId!==scope.projectId||kernel.rootFrameId!==scope.rootFrameId)throw new NativeKernelPolicyError('The native kernel identity does not match its authenticated frame.');
   const before=this.bindings.get(kernel);if(before&&(before.state!==state||before.epoch!==epoch))throw new NativeKernelPolicyError('A kernel cannot move between confidentiality generations.');
   this.bindings.set(kernel,{state,epoch,scope});if(!state.owned.has(kernel))state.owned.set(kernel,new Set());if(kernel.process)state.owned.get(kernel)!.add(kernel.process);created.add(kernel);
  };
  const cached=(kernel:any)=>{
   current();let binding=this.bindings.get(kernel);
   if(!binding&&scope.mode==='standard'){bind(kernel);created.delete(kernel);binding=this.bindings.get(kernel)}
   if(!binding||binding.state!==state||binding.epoch!==epoch)throw new NativeKernelPolicyError('The cached kernel belongs to another confidentiality generation.');
   return kernel;
  };
  const abort=async()=>{
   if(!created.size)return;
   const kernels=[...created];
   for(const kernel of kernels)if(kernel.process)state.owned.get(kernel)!.add(kernel.process);
   const processes=[...new Set(kernels.flatMap(kernel=>[...state.owned.get(kernel)??[]]).filter(Boolean))];
   await this.bounded(async signal=>{
    await Promise.allSettled(kernels.map(kernel=>kernel.shutdown({skipLibsRm:true,cause:'teardown'})));
    if(kernels.some(kernel=>kernel.isAlive||kernel.routableAlive)||await this.options.verifyDrained(manager,scope,{frameId:scope.frameId,kernels,processes,executions:[]},signal)!==true){
     this.blockedRoots.add(this.root(scope));throw new NativeKernelPolicyError('A failed kernel boot could not be fully drained. Protected execution remains blocked.');
    }
    for(const kernel of kernels)state.owned.delete(kernel);
   });
  };
  const lease:NativeKernelLease=Object.freeze({scope,signal:state.controller.signal,assertCurrent:current,cached,bind,
   start:async(kernel,start)=>{current();try{await start()}finally{if(kernel.process)state.owned.get(kernel)!.add(kernel.process)}current()},abort});
  this.leases.add(lease);return lease;
 }
 assertKernel(kernel:any){
  const binding=kernel&&typeof kernel==='object'?this.bindings.get(kernel):undefined;
  if(!binding)throw new NativeKernelPolicyError('This kernel has no authenticated policy-generation binding.');
  this.assertState(binding.state,binding.epoch);
 }
 /** Capture at the actual native spawn assignment, before abort/error paths can
  * clear kernel.process. Retain every generation until physical teardown. */
 processAttached(kernel:any,process:any){
  const binding=this.bindings.get(kernel);
  if(!binding||!process||typeof process!=='object')throw new NativeKernelPolicyError('A native process has no authenticated kernel owner.');
  binding.state.owned.get(kernel)!.add(process);this.assertKernel(kernel);
 }
 assertHostContext(owner:any){
  this.assertKernel(owner?.nativeKernel);const binding=this.bindings.get(owner.nativeKernel)!;
  if(owner.frameId!==binding.scope.frameId||owner.rootFrameId!==binding.scope.rootFrameId||owner.projectId!==binding.scope.projectId||owner.userId!==binding.scope.ownerId)
   throw new NativeKernelPolicyError('The kernel host-call context does not match its authenticated generation.');
 }
 /** Call around the authenticated mode mutation. Permission is withheld until
  * all affected native contexts, children and pending operations are drained. */
 async transition(scopeInput:NativeKernelScope,apply:()=>void|Promise<void>){
  this.checkOpen();const scope=this.validate(scopeInput),key=this.root(scope);this.assertScope(scope);
  if(this.transitions.has(key))throw new NativeKernelPolicyError('A confidentiality transition is already running.');
  this.blockedRoots.add(key);
  const pending=this.bounded(async signal=>{
   const affected:Array<{manager:any;scope:NativeKernelScope}>=[];
   for(const manager of this.managers){
    const contexts=new Map<string,any>(manager._frameContext);
    for(const [frameId,state]of this.states.get(manager)??[])if(!contexts.has(frameId))contexts.set(frameId,{rootFrameId:state.scope.rootFrameId,projectId:state.scope.projectId,userId:state.scope.ownerId});
    for(const [frameId,context]of contexts){
    if((context.rootFrameId??frameId)!==scope.rootFrameId)continue;
    if(context.projectId!==scope.projectId||context.userId!==scope.ownerId)throw new NativeKernelPolicyError('A native child context has an inconsistent project or owner.');
    const child=this.validate(await this.options.resolveScope(frameId));if(this.root(child)!==key)throw new NativeKernelPolicyError('A child kernel has an inconsistent owner or root.');
    const state=this.states.get(manager)?.get(frameId);if(state){state.epoch++;state.controller.abort(new NativeKernelPolicyError('The chat confidentiality setting is changing.'))}
    affected.push({manager,scope:child});
    }
   }
   await this.options.quiesceRoot(scope,signal);
   for(const target of affected)await this.drain(target.manager,target.scope,signal);
   signal.throwIfAborted();this.assertScope(scope);await apply();signal.throwIfAborted();
   for(const target of affected){
    const current=this.validate(await this.options.resolveScope(target.scope.frameId));
    if(this.root(current)!==key)throw new NativeKernelPolicyError('The native owner or root changed during confidentiality transition.');
    const state=this.states.get(target.manager)?.get(current.frameId);if(state){state.scope=current;state.binding=same(current);state.controller=new AbortController()}
   }
   this.blockedRoots.delete(key);
  });
  this.transitions.set(key,pending);try{await pending}finally{this.transitions.delete(key)}
 }
 close(){if(this.closed)return;for(const manager of [...this.managers])this.release(manager);this.managers.clear();this.closed=true}
}

export type NativeKernelEdit={start:number;end:number;text:string;label:string};
export const nativeKernelPolicyBoundaries=Object.freeze(['native-kernel-manager-registration','native-kernel-manager-release',
 'native-kernel-acquire','native-kernel-failure-cleanup','native-kernel-cache-1','native-kernel-cache-2','native-kernel-cache-3',
 'native-kernel-bind','native-kernel-start-generation','native-kernel-host-context','native-kernel-execute-entry',
 'native-kernel-execute-queue','native-kernel-execute-write','native-kernel-host-dispatch','native-kernel-start-entry','native-kernel-process-attached']);

/** Called only after the full native revision is checked. Synchronous assertions
 * immediately before stdin writes close the await/queue policy-change window. */
export function nativeKernelPolicyEdits(ast:t.Node,source:string):NativeKernelEdit[]{
 const edits:NativeKernelEdit[]=[],seen=new Set<string>(),fail=(label:string):never=>{throw Error('Native kernel policy boundary changed: '+label)};
 if(source.includes('__chimericKernelLease')||source.includes('registerNativeKernelManager'))fail('already-patched');
 const text=(node:t.Node)=>{if(node.start==null||node.end==null)fail('range');return source.slice(node.start!,node.end!)};
 const add=(node:t.Node,label:string,value:string,where:'replace'|'start'|'end'='replace')=>{
  if(seen.has(label)||node.start==null||node.end==null)fail(label);seen.add(label);
  edits.push({start:where==='start'?node.start!+1:where==='end'?node.end!-1:node.start!,end:where==='start'?node.start!+1:where==='end'?node.end!-1:node.end!,text:value,label});
 };
 const member=(node:t.Node|undefined,name:string)=>t.isMemberExpression(node)&&!node.computed&&t.isThisExpression(node.object)&&t.isIdentifier(node.property,{name});
 const calls=(node:t.Node,name:string)=>{const values:t.CallExpression[]=[];t.traverseFast(node,value=>{if(t.isCallExpression(value)&&t.isMemberExpression(value.callee)&&!value.callee.computed&&t.isIdentifier(value.callee.property,{name}))values.push(value)});return values};
 t.traverseFast(ast,node=>{
  if(t.isClassDeclaration(node)&&node.body.body.some(value=>t.isClassMethod(value)&&t.isIdentifier(value.key,{name:'_getOrCreateKernel'}))){
   const methods=node.body.body.filter(value=>t.isClassMethod(value)) as t.ClassMethod[],method=methods.find(value=>t.isIdentifier(value.key,{name:'_getOrCreateKernel'}))!,constructor=methods.find(value=>value.kind==='constructor'),close=methods.find(value=>t.isIdentifier(value.key,{name:'close'}));
   if(!method.async||method.params.length!==5||!method.params.every(value=>t.isIdentifier(value))||!constructor||!close?.async||!text(constructor.body).includes('this._spawnProvider=')||!text(close.body).includes('this._closeGeneration++'))fail('manager');
   const [frame,environment,_map,Constructor]=method.params as t.Identifier[];
   add(constructor.body,'native-kernel-manager-registration',';globalThis.__scienceLocal.registerNativeKernelManager(this);','end');
   add(close.body,'native-kernel-manager-release','globalThis.__scienceLocal.releaseNativeKernelManager(this);','start');
   add(method.body,'native-kernel-acquire',`const __chimericKernelLease=await globalThis.__scienceLocal.nativeKernelLease(this,${frame.name},${environment.name},${Constructor.name});try{`,'start');
   add(method.body,'native-kernel-failure-cleanup','}catch(__chimericKernelFailure){await __chimericKernelLease.abort();throw __chimericKernelFailure;}','end');
   const caches:t.Identifier[]=[];t.traverseFast(method.body,value=>{
    if(t.isReturnStatement(value)&&t.isSequenceExpression(value.argument)&&value.argument.expressions.length===2){const [left,right]=value.argument.expressions;if(t.isCallExpression(left)&&member(left.callee,'_cancelIdleTimer')&&t.isIdentifier(right))caches.push(right)}
   });if(caches.length!==3)fail('cache');caches.forEach((value,index)=>add(value,'native-kernel-cache-'+(index+1),`__chimericKernelLease.cached(${value.name})`));
   const constructions:t.VariableDeclarator[]=[];t.traverseFast(method.body,value=>{if(t.isVariableDeclarator(value)&&t.isIdentifier(value.id)&&t.isNewExpression(value.init)&&t.isIdentifier(value.init.callee,{name:Constructor.name}))constructions.push(value)});
   if(constructions.length!==1)fail('construction');const kernel=(constructions[0].id as t.Identifier).name;
   const starts=calls(method.body,'start').filter(value=>t.isMemberExpression(value.callee)&&t.isIdentifier(value.callee.object,{name:kernel}));
   const additions=calls(method.body,'add').filter(value=>value.arguments.length===1&&t.isIdentifier(value.arguments[0],{name:kernel})&&t.isMemberExpression(value.callee)&&t.isIdentifier(value.callee.object));
   if(starts.length!==1||additions.length!==1)fail('start');
   add(additions[0],'native-kernel-bind',`(__chimericKernelLease.bind(${kernel}),${text(additions[0])})`);
   add(starts[0],'native-kernel-start-generation',`__chimericKernelLease.start(${kernel},()=>${text(starts[0])})`);
   const contexts:t.ObjectExpression[]=[];t.traverseFast(method.body,value=>{if(t.isCallExpression(value)&&value.arguments.length===2&&member(value.arguments[0] as t.Node,'_hostCallServices')&&t.isObjectExpression(value.arguments[1]))contexts.push(value.arguments[1])});
   if(contexts.length!==1||!text(contexts[0]).includes('sessionModel:'))fail('host-context');add(contexts[0],'native-kernel-host-context',`nativeKernel:${kernel},`,'start');
  }
  if(t.isClassDeclaration(node)&&node.body.body.some(value=>t.isClassMethod(value)&&t.isIdentifier(value.key,{name:'_serviceHostCall'}))&&node.body.body.some(value=>t.isClassMethod(value)&&t.isIdentifier(value.key,{name:'_armProcessAttached'}))){
   const methods=node.body.body.filter(value=>t.isClassMethod(value)) as t.ClassMethod[],execute=methods.find(value=>t.isIdentifier(value.key,{name:'execute'})),start=methods.find(value=>t.isIdentifier(value.key,{name:'start'})),host=methods.find(value=>t.isIdentifier(value.key,{name:'_serviceHostCall'}));
   if(!execute?.async||!start?.async||!host?.async||!text(execute.body).includes('this._readProtocolResponse(')||!text(start.body).includes('this._prepareStart('))fail('base-kernel');
   const assertion='globalThis.__scienceLocal.assertNativeKernel(this);';add(execute.body,'native-kernel-execute-entry',assertion,'start');add(start.body,'native-kernel-start-entry',assertion,'start');
   const queue=calls(execute.body,'runExclusive');if(queue.length!==1||queue[0].arguments.length!==1||!t.isArrowFunctionExpression(queue[0].arguments[0])||!t.isBlockStatement(queue[0].arguments[0].body))fail('execute-queue');add((queue[0].arguments[0] as t.ArrowFunctionExpression).body as t.BlockStatement,'native-kernel-execute-queue',assertion,'start');
   const writes=calls(execute.body,'write').filter(value=>t.isMemberExpression(value.callee)&&t.isMemberExpression(value.callee.object)&&t.isIdentifier(value.callee.object.property,{name:'stdin'}));if(writes.length!==1)fail('execute-write');add(writes[0],'native-kernel-execute-write',`(globalThis.__scienceLocal.assertNativeKernel(this),${text(writes[0])})`);
   const dispatch=calls(host.body,'hostCallHandler');if(dispatch.length!==1)fail('host-dispatch');add(dispatch[0],'native-kernel-host-dispatch',`(globalThis.__scienceLocal.assertNativeKernel(this),${text(dispatch[0])})`);
   const afterPrepare=methods.find(value=>t.isIdentifier(value.key,{name:'_startAfterPrepare'}));if(!afterPrepare?.async)fail('process-attach');
   const spawns:t.AssignmentExpression[]=[];t.traverseFast(afterPrepare!.body,value=>{if(t.isAssignmentExpression(value)&&member(value.left,'process')&&t.isAwaitExpression(value.right))spawns.push(value)});
   if(spawns.length!==1||!text(spawns[0]).includes('.spawn('))fail('process-attach');add(spawns[0],'native-kernel-process-attached',`(${text(spawns[0])},globalThis.__scienceLocal.nativeKernelProcessAttached(this,this.process),this.process)`);
  }
 });
 for(const label of nativeKernelPolicyBoundaries)if(!seen.has(label))fail(label);return edits;
}
