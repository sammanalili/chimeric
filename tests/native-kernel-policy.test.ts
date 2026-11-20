import {afterEach,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {NativeKernelPolicy,nativeKernelPolicyEdits,nativeKernelPolicyBoundaries,type NativeKernelScope} from '../tools/native-kernel-policy';

const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const base=(frameId='root'):NativeKernelScope=>({frameId,rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'organization',mode:'standard',revision:0,executionBinding:hash('standard')});
function deferred<T=void>(){let resolve!:(value:T|PromiseLike<T>)=>void;const promise=new Promise<T>(yes=>resolve=yes);return {promise,resolve}}
const closes:Array<()=>void>=[];afterEach(()=>{for(const close of closes.splice(0))close()});
class Kernel{
 frameId='root';rootFrameId='root';projectId='project';isAlive=true;routableAlive=true;
 process:any={alive:true,pid:123};shutdownCalls=0;
 async shutdown(){this.shutdownCalls++;this.isAlive=false;this.routableAlive=false;this.process.alive=false}
}
function fixture(extra:any={}){
 const scopes=new Map<string,NativeKernelScope>([['root',base()],['child',base('child')]]),events:string[]=[];
 const manager:any={_frameContext:new Map([...scopes].map(([id,s])=>[id,{rootFrameId:s.rootFrameId,projectId:s.projectId,userId:s.ownerId}])),_kernels:new Map(),_rKernels:new Map(),_operonKernels:new Map(),_byocKernels:new Map(),_startingKernels:new Map(),_execStreams:new Map(),_userExecs:new Map(),cleanupCalls:0,
  async cleanup(frameId:string,options:any){this.cleanupCalls++;events.push('cleanup:'+frameId);expect(options).toMatchObject({preserveWorkspace:true,preserveContext:true,dropExecStreams:true});for(const name of ['_kernels','_rKernels','_operonKernels','_byocKernels']){const kernels=[...this[name].get(frameId)?.values()??[]];this[name].delete(frameId);await Promise.allSettled(kernels.map((k:any)=>k.shutdown()))}this._execStreams.delete(frameId)},
  interruptUserExec(){events.push('interrupt-user')},interruptExecStream(){events.push('interrupt-exec')},
 };
 const policy=new NativeKernelPolicy({resolveScope:async(frameId:string)=>{if(!scopes.has(frameId))throw Error('Unknown synthetic frame');return scopes.get(frameId)!},
  assertScope:(scope:NativeKernelScope)=>{if(JSON.stringify(scopes.get(scope.frameId))!==JSON.stringify(scope))throw Error('Synthetic scope changed')},
  allowProtectedKernel:(_scope,environment,Constructor)=>environment==='python'&&Constructor===Kernel,
  quiesceRoot:async()=>{events.push('quiesce')},verifyDrained:async(_manager,_scope,drain)=>{events.push('verify:'+drain.frameId);return drain.kernels.every(k=>!k.isAlive&&!k.routableAlive)&&drain.processes.every(p=>!p.alive)},timeoutMs:100,...extra});
 policy.register(manager);closes.push(()=>policy.close());
 const protect=()=>{for(const [id,value]of scopes)scopes.set(id,{...value,mode:'class2',revision:value.revision+1,executionBinding:hash('class2')})};
 return {scopes,events,manager,policy,protect};
}

test('Standard cached kernels are bound without a destructive initial restart',async()=>{
 const f=fixture(),kernel=new Kernel;f.manager._kernels.set('root',new Map([['python',kernel]]));
 const lease=await f.policy.acquire(f.manager,'root','python',Kernel);
 expect(lease.cached(kernel)).toBe(kernel);f.policy.assertKernel(kernel);expect(f.manager.cleanupCalls).toBe(0);expect(f.events).toEqual([]);
});

test('A root transition revokes leases and drains root plus child before changing policy',async()=>{
 const gate=deferred(),entered=deferred(),f=fixture({quiesceRoot:async()=>{entered.resolve();await gate.promise}}),old=new Kernel,child=new Kernel;child.frameId='child';
 const lease=await f.policy.acquire(f.manager,'root','python',Kernel),childLease=await f.policy.acquire(f.manager,'child','python',Kernel);
 lease.bind(old);childLease.bind(child);f.manager._kernels.set('root',new Map([['python',old]]));f.manager._kernels.set('child',new Map([['python',child]]));
 let applied=false;const pending=f.policy.transition(base(),()=>{expect(old.process.alive).toBe(false);expect(child.process.alive).toBe(false);applied=true;f.protect()});
 await entered.promise;expect(()=>lease.assertCurrent()).toThrow();expect(()=>f.policy.assertKernel(old)).toThrow();expect(applied).toBe(false);
 gate.resolve();await pending;expect(applied).toBe(true);expect(lease.signal.aborted).toBe(true);expect(old.shutdownCalls).toBeGreaterThan(0);expect(child.shutdownCalls).toBeGreaterThan(0);
 const next=await f.policy.acquire(f.manager,'root','python',Kernel);expect(()=>next.cached(old)).toThrow('generation');expect(f.manager.cleanupCalls).toBe(2);
});

test('Concurrent protected acquisitions share one drain and cannot admit an unsupported kernel kind',async()=>{
 const f=fixture();f.protect();const leases=await Promise.all([f.policy.acquire(f.manager,'root','python',Kernel),f.policy.acquire(f.manager,'root','python',Kernel)]);
 expect(f.manager.cleanupCalls).toBe(1);const kernel=new Kernel;leases[0].bind(kernel);expect(leases[1].cached(kernel)).toBe(kernel);
 for(const [environment,Constructor]of [['r',Kernel],['python',class Other{}]] as const)await expect(f.policy.acquire(f.manager,'root',environment,Constructor)).rejects.toThrow('not been verified');
});

test('Kernel and host identities cannot be forged or moved to a different root or owner',async()=>{
 const f=fixture(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;
 expect(()=>f.policy.assertKernel(kernel)).toThrow('no authenticated');lease.bind(kernel);
 f.policy.assertHostContext({nativeKernel:kernel,frameId:'root',rootFrameId:'root',projectId:'project',userId:'owner'});
 for(const changes of [{nativeKernel:{...kernel}},{frameId:'child'},{rootFrameId:'other'},{projectId:'other'},{userId:'other'}])expect(()=>f.policy.assertHostContext({nativeKernel:kernel,frameId:'root',rootFrameId:'root',projectId:'project',userId:'owner',...changes})).toThrow();
 const wrong=new Kernel;wrong.frameId='child';expect(()=>lease.bind(wrong)).toThrow('identity');
});

test('Policy changes while a kernel boots reject its result and allow verified teardown of the unregistered process',async()=>{
 const f=fixture(),gate=deferred(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;kernel.isAlive=false;kernel.routableAlive=false;kernel.process=undefined;lease.bind(kernel);
 const boot=lease.start(kernel,async()=>{await gate.promise;kernel.isAlive=true;kernel.routableAlive=true;kernel.process={alive:true,pid:456}});
 f.protect();gate.resolve();await expect(boot).rejects.toThrow('scope changed');await lease.abort();expect(kernel.process.alive).toBe(false);expect(kernel.shutdownCalls).toBeGreaterThan(0);
});

test('Native cleanup clearing maps cannot conceal a live process from the transition verifier',async()=>{
 const f=fixture(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.manager._kernels.set('root',new Map([['python',kernel]]));
 kernel.shutdown=async()=>{kernel.isAlive=false;kernel.routableAlive=false;throw Error('Synthetic process resisted cleanup')};
 let applied=false;await expect(f.policy.transition(base(),()=>{applied=true;f.protect()})).rejects.toThrow('teardown could not be verified');
 expect(applied).toBe(false);expect(f.manager._kernels.has('root')).toBe(false);expect(kernel.process.alive).toBe(true);await expect(f.policy.acquire(f.manager,'root','python',Kernel)).rejects.toThrow('transition');
});

test('Native spawn references survive a failed start that clears kernel.process before returning',async()=>{
 const f=fixture(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;
 kernel.process=undefined;kernel.isAlive=false;kernel.routableAlive=false;lease.bind(kernel);
 const orphan={alive:true,pid:789};
 await expect(lease.start(kernel,async()=>{kernel.process=orphan;f.policy.processAttached(kernel,orphan);kernel.process=undefined;throw Error('Synthetic spawn abort')})).rejects.toThrow('spawn abort');
 await expect(lease.abort()).rejects.toThrow('fully drained');
 await expect(f.policy.acquire(f.manager,'root','python',Kernel)).rejects.toThrow('transition');
 expect(orphan.alive).toBe(true);orphan.alive=false;
});

test('Non-cancellable environment work prevents a transition without abandoning its bookkeeping',async()=>{
 const f=fixture();f.manager._execStreams.set('root',new Map([['install',{notAbortable:true,done:null,execReturned:false}]]));
 let applied=false;await expect(f.policy.transition(base(),()=>{applied=true})).rejects.toThrow('non-cancellable');
 expect(applied).toBe(false);expect(f.manager.cleanupCalls).toBe(0);expect(f.events).not.toContain('interrupt-exec');expect(f.manager._execStreams.get('root').has('install')).toBe(true);
});

test('Timeouts and a truthy non-boolean drain report never activate protected execution',async()=>{
 const hung=fixture({timeoutMs:10,quiesceRoot:()=>new Promise(()=>{})});let applied=false;
 await expect(hung.policy.transition(base(),()=>{applied=true})).rejects.toThrow('timed out');expect(applied).toBe(false);await expect(hung.policy.acquire(hung.manager,'root','python',Kernel)).rejects.toThrow('transition');
 const malformed=fixture({verifyDrained:async()=>({verified:false})});await expect(malformed.policy.transition(base(),()=>{})).rejects.toThrow('teardown could not be verified');
});

test('Async scope assertions and inconsistent native child ownership fail before execution',async()=>{
 const asyncScope=fixture({assertScope:async()=>{}});await expect(asyncScope.policy.acquire(asyncScope.manager,'root','python',Kernel)).rejects.toThrow('synchronously');
 const inconsistent=fixture();inconsistent.manager._frameContext.get('child').userId='other';let applied=false;
 await expect(inconsistent.policy.transition(base(),()=>{applied=true})).rejects.toThrow('inconsistent');expect(applied).toBe(false);
});

test('Closed managers invalidate their live leases and cannot be registered again',async()=>{
 const f=fixture(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.policy.release(f.manager);
 expect(()=>lease.assertCurrent()).toThrow();expect(()=>f.policy.register(f.manager)).toThrow();await expect(f.policy.acquire(f.manager,'root','python',Kernel)).rejects.toThrow();
});

test('A retired manager and a removed frame context cannot hide still-live owned descendants',async()=>{
 const f=fixture(),lease=await f.policy.acquire(f.manager,'root','python',Kernel),kernel=new Kernel;lease.bind(kernel);f.policy.processAttached(kernel,kernel.process);
 f.policy.release(f.manager);f.manager._frameContext.clear();kernel.shutdown=async()=>{kernel.isAlive=false;kernel.routableAlive=false;kernel.process=undefined};
 let applied=false;await expect(f.policy.transition(base(),()=>{applied=true;f.protect()})).rejects.toThrow('teardown could not be verified');expect(applied).toBe(false);
});

test('A stale transition scope cannot mutate policy after asynchronous quiescence',async()=>{
 const f=fixture({quiesceRoot:async()=>f.protect()});let applied=false;
 await expect(f.policy.transition(base(),()=>{applied=true})).rejects.toThrow('scope changed');expect(applied).toBe(false);
});

const nativePath=resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science');
test.skipIf(!existsSync(nativePath))('The actual Mac core accepts every kernel protocol/cache guard without overlap',()=>{
 const source=readFileSync(nativePath,'utf8'),edits=nativeKernelPolicyEdits(parse(source,{sourceType:'unambiguous'}),source);
 expect(edits.map(e=>e.label).sort()).toEqual([...nativeKernelPolicyBoundaries].sort());
 let patched=source;const ordered=[...edits].sort((a,b)=>b.start-a.start);for(let i=1;i<ordered.length;i++)expect(ordered[i].end).toBeLessThanOrEqual(ordered[i-1].start);
 for(const edit of ordered)patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);parse(patched,{sourceType:'unambiguous'});
 expect(()=>nativeKernelPolicyEdits(parse(patched,{sourceType:'unambiguous'}),patched)).toThrow('already-patched');
},30000);
