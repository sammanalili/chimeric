import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {NativeKernelEnforcement,type NativeProcessInspector} from '../src/native-kernel-enforcement';
import {nativeRuntimeServicesEdits,nativeRuntimeServicesBoundaries} from '../tools/native-runtime-services';
import {nativeKernelPolicyEdits,type NativeKernelScope} from '../tools/native-kernel-policy';
import {nativeScopeEdits} from '../tools/native-scope-patches';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const base=(frameId='root'):NativeKernelScope=>({frameId,rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org',mode:'standard',revision:0,executionBinding:hash('standard')});
const closers:Array<()=>void>=[];afterEach(()=>{for(const f of closers.splice(0))f()});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>resolve=yes);return {promise,resolve}}
class Kernel {frameId='root';rootFrameId='root';projectId='project';isAlive=true;routableAlive=true;process:any={pid:123,alive:true};async shutdown(){this.isAlive=false;this.routableAlive=false;if(this.process)this.process.alive=false}}
function fixture(extra:any={}){
 const events:string[]=[],scopes=new Map([['root',base()],['child',base('child')]]),processes=new Map<number,boolean>();
 const inspector:NativeProcessInspector={capture:async pids=>{events.push('capture');return {pids:[...pids],groups:[],sessions:[],controls:pids.map(pid=>({pid,fd:'3u',type:'unix',identity:hash('synthetic-socket')}))}},drained:async receipt=>{events.push('verify-processes');return receipt.pids.every(pid=>!processes.get(pid))}};
 const manager:any={_frameContext:new Map([...scopes].map(([id,s])=>[id,{rootFrameId:s.rootFrameId,projectId:s.projectId,userId:s.ownerId}])),_kernels:new Map(),_rKernels:new Map(),_operonKernels:new Map(),_byocKernels:new Map(),_startingKernels:new Map(),_execStreams:new Map(),_userExecs:new Map(),async cleanup(frameId:string){events.push('cleanup:'+frameId);for(const name of ['_kernels','_rKernels','_operonKernels','_byocKernels']){for(const kernel of this[name].get(frameId)?.values()??[])await kernel.shutdown();this[name].delete(frameId)}this._execStreams.delete(frameId)},interruptUserExec(){},interruptExecStream(){}};
 const running=new Map(),tasks=new Map(),reviewers:any[]=[],signals:string[]=[],gateway:any={kernel_manager:manager,signals:{signalInterrupt:(id:string)=>signals.push(id)},task_registry:{_tasks:tasks,frameIds:(root:string)=>[...tasks.get(root)?.keys()??[]],cancelConversation:(root:string)=>{for(const t of tasks.get(root)?.values()??[])t.abortController.abort()}},active_frames:{_frames:new Map()}},keepalive={_inFlight:false};
 const agent:any={services:gateway,_running:running,betweenTurnsKeepalive:{_entries:new Map([['root',{ka:keepalive}]])},async cancelConversation(root:string){events.push('cancel-native');this.betweenTurnsKeepalive._entries.delete(root);for(const r of running.get(root)??[])r.abort.abort()}};
 const context={services:{gateway,signals:gateway.signals},agentSvc:agent},controls={reviewers:()=>reviewers,abortReviewers:()=>{events.push('abort-reviewers');for(const row of reviewers){row.controller.abort();row.hasTimer=false;row.pending=false}}};
 const enforcement=new NativeKernelEnforcement({resolveScope:async(id:string)=>{if(!scopes.has(id))throw Error('unknown frame');return scopes.get(id)!},assertScope:(s:NativeKernelScope)=>{if(JSON.stringify(s)!==JSON.stringify(scopes.get(s.frameId)))throw Error('scope changed')},assertNoUnconfinedHistory:async()=>{events.push('history')},allowProtectedKernel:(_scope,env,Constructor)=>env==='python'&&Constructor===Kernel,inspector,timeoutMs:100,...extra});
 enforcement.registerManager(manager);enforcement.registerRuntimeServices(context,controls);closers.push(()=>enforcement.close());
 const change=(mode:'class2'|'standard')=>{for(const [id,scope]of scopes)scopes.set(id,{...scope,mode,revision:scope.revision+1,executionBinding:hash(mode+String(scope.revision+1))})};
 return {events,scopes,manager,agent,gateway,context,controls,enforcement,change,processes,reviewers,keepalive,signals};
}

test('Actual model completion and native job settlement are barriers before policy commit',async()=>{
 const f=fixture(),abort=new AbortController(),jobGate=deferred(),modelGate=deferred();
 const native=f.enforcement.withNativeAgentJob(f.agent,{root_frame_id:'root',frame_id:'root',project_id:'project',user_id:'owner'},async()=>{f.agent._running.set('root',new Set([{frameId:'root',abort}]));try{await jobGate.promise}finally{f.agent._running.delete('root')}});await Bun.sleep(0);
 const model=f.enforcement.withModel(base(),async signal=>{signal.addEventListener('abort',()=>f.events.push('abort-model'));await modelGate.promise});
 let committed=false;const transition=f.enforcement.transition(base(),'class2',()=>{committed=true;f.change('class2')});await Bun.sleep(0);
 expect(abort.signal.aborted).toBe(true);expect(committed).toBe(false);expect(()=>f.enforcement.beginModel(base())).toThrow('changing');
 jobGate.resolve();await native;expect(committed).toBe(false);modelGate.resolve();await model;await transition;
 expect(committed).toBe(true);expect(f.events).toContain('abort-model');expect(f.signals.sort()).toEqual(['child','root']);
});

test('Queued jobs cannot enter the barrier and a forged native request owner cannot run',async()=>{
 const f=fixture(),lease=f.enforcement.beginModel(base());let ran=false;
 const transition=f.enforcement.transition(base(),'class2',()=>f.change('class2'));await Bun.sleep(0);
 await expect(f.enforcement.withNativeAgentJob(f.agent,{root_frame_id:'root',frame_id:'child',project_id:'project',user_id:'owner'},()=>{ran=true})).rejects.toThrow('transition');expect(ran).toBe(false);lease.close();await transition;
 await expect(f.enforcement.withNativeAgentJob(f.agent,{root_frame_id:'root',frame_id:'child',project_id:'other',user_id:'owner'},()=>{ran=true})).rejects.toThrow('owner');expect(ran).toBe(false);
});

test('Detached reviewer promises and in-flight keepalive remain barriers after native map removal',async()=>{
 const f=fixture(),gate=deferred();let committed=false;f.keepalive._inFlight=true;
 const reviewer={frameId:'child',rootFrameId:'root',inFlight:[gate.promise],controller:new AbortController(),hasTimer:true,pending:true};f.reviewers.push(reviewer);
 const transition=f.enforcement.transition(base(),'class2',()=>{committed=true;f.change('class2')});await Bun.sleep(0);
 expect(reviewer.controller.signal.aborted).toBe(true);f.reviewers.splice(0);gate.resolve();await Bun.sleep(0);expect(committed).toBe(false);
 f.keepalive._inFlight=false;await transition;expect(committed).toBe(true);
});

test('Post-completion background work retains its root after its native parent job returns',async()=>{
 const f=fixture(),background=deferred();await f.enforcement.withNativeAgentJob(f.agent,{root_frame_id:'root',frame_id:'root',project_id:'project',user_id:'owner'},async()=>f.enforcement.trackNativeBackground(background.promise));
 let committed=false;const transition=f.enforcement.transition(base(),'class2',()=>{committed=true;f.change('class2')});await Bun.sleep(0);expect(committed).toBe(false);background.resolve();await transition;expect(committed).toBe(true);
});

test('Unknown history and prior unrestricted kernels fail before stopping a standard chat',async()=>{
 const unknown=fixture({assertNoUnconfinedHistory:undefined});await expect(unknown.enforcement.transition(base(),'class2',()=>{})).rejects.toThrow('history');expect(unknown.events).not.toContain('cancel-native');unknown.enforcement.beginModel(base()).close();
 const f=fixture(),lease=await f.enforcement.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.enforcement.processAttached(kernel,kernel.process);
 await expect(f.enforcement.transition(base(),'class2',()=>{})).rejects.toThrow('unrestricted');expect(f.events).not.toContain('cancel-native');f.enforcement.beginModel(base()).close();
});

test('Standard shell/host execution and older shell streams cannot be relabeled as protected history',async()=>{
 for(const kind of ['process','shell','host-call']){const f=fixture();f.enforcement.noteNativeExecution(kind,base());await expect(f.enforcement.transition(base(),'class2',()=>{})).rejects.toThrow('unrestricted');expect(f.events).not.toContain('cancel-native')}
 const f=fixture();f.manager._execStreams.set('root',new Map([['shell',{started:true,pid:456,done:null,execReturned:false}]]));await expect(f.enforcement.transition(base(),'class2',()=>{})).rejects.toThrow('compute history');expect(f.events).not.toContain('cancel-native');
});

test('Unscoped native task promises are tracked before a protected transition can begin',async()=>{
 const f=fixture(),gate=deferred();f.enforcement.withNativeRootTask(null,()=>gate.promise);
 await expect(f.enforcement.transition(base(),'class2',()=>{})).rejects.toThrow('unscoped');f.enforcement.beginModel(base()).close();gate.resolve();
});

test('First protected acquisition inside the current native job does not cancel or wait for itself',async()=>{
 const f=fixture();f.change('class2');await f.enforcement.withNativeAgentJob(f.agent,{root_frame_id:'root',frame_id:'root',project_id:'project',user_id:'owner'},async()=>{
  const lease=await f.enforcement.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.enforcement.processAttached(kernel,kernel.process);f.enforcement.kernels.assertKernel(kernel);
 });expect(f.events).not.toContain('cancel-native');
});

test('A retained protected process prevents replacement after native maps clear',async()=>{
 const f=fixture();f.change('class2');const scope=f.scopes.get('root')!,lease=await f.enforcement.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.enforcement.processAttached(kernel,kernel.process);f.processes.set(123,true);f.manager._kernels.set('root',new Map([['python',kernel]]));
 let committed=false;await expect(f.enforcement.transition(scope,'standard',()=>{committed=true;f.change('standard')})).rejects.toThrow('timed out');expect(committed).toBe(false);expect(()=>f.enforcement.beginModel(scope)).toThrow('changing');
 f.processes.set(123,false);await f.enforcement.transition(scope,'standard',()=>f.change('standard'));f.enforcement.beginModel(f.scopes.get('root')!).close();
});

test('Unscoped work and non-cancellable package operations cannot produce a completed transition',async()=>{
 const f=fixture(),gate=deferred();f.enforcement.trackNativeBackground(gate.promise);let committed=false;await expect(f.enforcement.transition(base(),'class2',()=>{committed=true})).rejects.toThrow('unscoped');expect(committed).toBe(false);gate.resolve();
 const g=fixture();g.change('class2');g.manager._execStreams.set('root',new Map([['install',{notAbortable:true,done:null,execReturned:false}]]));await expect(g.enforcement.transition(g.scopes.get('root')!,'standard',()=>{})).rejects.toThrow('non-cancellable');expect(g.events).not.toContain('cancel-native');
});

const nativePath=resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science');
test.skipIf(!existsSync(nativePath))('Actual service/task/background hooks compose with native scope and kernel edits',()=>{
 const source=readFileSync(nativePath,'utf8'),ast=parse(source,{sourceType:'unambiguous'}),serviceEdits=nativeRuntimeServicesEdits(ast,source);expect(serviceEdits.map(e=>e.label).sort()).toEqual([...nativeRuntimeServicesBoundaries].sort());
 const edits=[...serviceEdits,...nativeScopeEdits(ast,source),...nativeKernelPolicyEdits(ast,source)].sort((a,b)=>b.start-a.start);for(let i=1;i<edits.length;i++)expect(edits[i].end).toBeLessThanOrEqual(edits[i-1].start);
 let patched=source;for(const edit of edits)patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);parse(patched,{sourceType:'unambiguous'});expect(()=>nativeRuntimeServicesEdits(parse(patched,{sourceType:'unambiguous'}),patched)).toThrow('already-patched');
},30000);
