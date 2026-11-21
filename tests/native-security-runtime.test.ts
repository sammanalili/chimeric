import {afterEach,expect,test} from 'bun:test';
import {existsSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {NativeSecurityRuntime} from '../src/native-security-runtime';
import {lookupFrame} from '../src/native-frame-context';
import {artifactFixture} from './helpers/native-artifact-fixture';

const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()});
const verifiedAttestation={evidence:()=>({verified:true as const}),assertNoUnconfinedHistory:()=>{},noteExecution:()=>{},allowProtectedKernel:()=>true};
function fixture(overrides:Record<string,unknown>={}){
 const f=artifactFixture(),sessions:any[]=[];
 const context=async(frameId:string)=>{const frame=lookupFrame(f.profile,frameId);if(!frame)throw Error('missing synthetic frame');const rootFrameId=frame.rootFrameId??frame.frameId;return Object.freeze({frameId,rootFrameId,projectId:frame.projectId,ownerId:frame.ownerId,organizationId:frame.organizationId,readOnly:false})};
 const confidentiality:any={policy:{snapshot:()=>({sessions:structuredClone(sessions)}),policy:(value:any)=>{const found=sessions.find(session=>session.rootFrameId===value.rootFrameId);return structuredClone(found??{rootFrameId:value.rootFrameId,projectId:value.projectId,ownerId:value.ownerId,organizationId:value.organizationId,mode:'standard',revision:0})}},ownedContext:context,scope:{currentFrame:()=>undefined}};
 const runtime=new NativeSecurityRuntime({profileDir:f.profile,authDir:join(f.profile,'local-auth'),assetsRoot:f.storage,owner:{userId:'owner-a',organizationId:'org-a'},confidentiality,...overrides});
 cleanups.push(()=>runtime.close(),f.cleanup);return {f,runtime,sessions,context};
}

test('daemon callbacks preserve ordinary paths and bind model work to native identity',async()=>{
 const {runtime,context}=fixture(),callbacks:any=runtime.callbacks(),scope=runtime.scopeForFrame('ordinary');
 expect(scope).toMatchObject({frameId:'ordinary',rootFrameId:'ordinary',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'standard',revision:0});expect(scope.executionBinding).toMatch(/^[a-f0-9]{64}$/);
 expect(callbacks.nativeProtectedWorkspacePath('ordinary','/ordinary/workspace')).toBe('/ordinary/workspace');expect(typeof callbacks.registerNativeKernelManager).toBe('function');expect(typeof callbacks.resourcePolicy.metadata).toBe('function');
 expect(runtime.resourceViews).toBeDefined();
 const lease=runtime.beginModel(await context('ordinary'));lease.assertCurrent();expect(lease.signal.aborted).toBe(false);lease.close();
});

test('missing historical evidence blocks protected entry before policy mutation',async()=>{
 const {runtime,context,sessions}=fixture();let applied=false;
 await expect(runtime.transition(await context('ordinary'),'class2',()=>{applied=true;sessions.push({rootFrameId:'ordinary',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1})})).rejects.toThrow('history');
 expect(applied).toBe(false);expect(runtime.scopeForFrame('ordinary').mode).toBe('standard');
});

test('sealed execution evidence is wired into transition, execution and protected-kernel guards',async()=>{
 const calls:any[]=[];const executionAttestation={
  evidence:()=>({verified:true as const}),
  assertNoUnconfinedHistory:(scope:any,created:any)=>calls.push(['history',scope.mode,created]),
  noteExecution:(kind:any,scope:any,created:any,settings:any)=>calls.push(['execution',kind,scope.mode,created,settings]),
  allowProtectedKernel:(scope:any,environment:any,Constructor:any,settings:any)=>{calls.push(['kernel',scope.mode,environment,Constructor,settings]);return false},
 };
 const baseLookup=(profile:string,frameId:string)=>{const value=lookupFrame(profile,frameId);return value&&{...value,rootCreatedAt:2500}};
 const {runtime,context,sessions}=fixture({executionAttestation,lookupFrame:baseLookup});
 await expect(runtime.transition(await context('uploads'),'class2',()=>{})).rejects.toThrow('services');
 expect(calls.some(row=>row[0]==='history'&&row[1]==='standard'&&row[2]===2500)).toBeTrue();
 runtime.noteExecution('kernel',await context('ordinary'));
 expect(calls.some(row=>JSON.stringify(row)===JSON.stringify(['execution','kernel','standard',2500,undefined]))).toBeTrue();
 sessions.push({rootFrameId:'protected',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1});
 runtime.noteExecution('kernel',await context('protected'));
 expect(calls.find(row=>row[0]==='execution'&&row[2]==='class2')).toEqual(['execution','kernel','class2',2500,{denyNetwork:true,hideFrameSecrets:true}]);
 const manager={cleanup:async()=>{},_frameContext:new Map(),_kernels:new Map(),_rKernels:new Map(),_operonKernels:new Map(),_byocKernels:new Map(),_startingKernels:new Map()};
 runtime.kernels.registerManager(manager);
 class PythonKernel{}
 await expect(runtime.kernels.acquire(manager,'protected','python',PythonKernel)).rejects.toThrow('kernel kind');
 expect(calls.some(row=>row[0]==='kernel'&&row[1]==='class2'&&row[2]==='python'&&row[3]===PythonKernel&&row[4].denyNetwork===true&&row[4].hideFrameSecrets===true)).toBeTrue();
});

test('a protected policy retained across an app update cannot bypass the new receipt activation epoch',async()=>{
 const stale={...verifiedAttestation,assertNoUnconfinedHistory:()=>{throw new Error('This chat predates the verified Class 2 execution boundary.')}};
 const {runtime,context,sessions}=fixture({executionAttestation:stale});
 sessions.push({rootFrameId:'protected',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1});
 const owned=await context('protected');expect(()=>runtime.beginModel(owned)).toThrow('predates');
 expect(()=>(runtime.callbacks() as any).nativeProtectedWorkspacePath('protected','/ordinary/workspace')).toThrow('predates');
});

test('a persisted protected policy selects a private workspace and stale scopes fail',()=>{
 const {runtime,sessions}=fixture({executionAttestation:verifiedAttestation});const before=runtime.scopeForFrame('protected');sessions.push({rootFrameId:'protected',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1});
 const current=runtime.scopeForFrame('protected');expect(current.mode).toBe('class2');const workspace=(runtime.callbacks() as any).nativeProtectedWorkspacePath('protected','/ordinary/workspace');expect(workspace).toContain('/chimeric-private-v1/roots/');expect(workspace).not.toBe('/ordinary/workspace');
 expect(()=>runtime.kernels.beginModel(before)).toThrow('scope');
});

test('failed protected classification removes staged bytes and never creates an ordinary-store copy',async()=>{
 const {f,runtime,sessions}=fixture({executionAttestation:verifiedAttestation});sessions.push({rootFrameId:'protected',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1});const callbacks:any=runtime.callbacks();let path='';
 await expect(runtime.resourceService.save({}, {frame_id:'protected',project_id:'project-a'},async()=>{const plan=callbacks.nativeProtectedResourceWrite({kind:'artifact',projectId:'project-a',artifactId:'artifact-staged',versionId:'version-missing',filename:'result.png'});path=plan.absolutePath;writeFileSync(path,'classified only after commit',{mode:0o600});return {artifact_id:'artifact-staged',version_id:'version-missing'}})).rejects.toThrow();
 expect(path).toContain('/chimeric-private-v1/roots/');expect(existsSync(path)).toBe(false);expect(existsSync(dirname(path))).toBe(false);expect(existsSync(join(f.storage,'project-a','artifact-staged','version-missing','result.png'))).toBe(false);
});
