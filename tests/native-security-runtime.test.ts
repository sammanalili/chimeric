import {afterEach,expect,test} from 'bun:test';
import {join} from 'node:path';
import {NativeSecurityRuntime} from '../src/native-security-runtime';
import {lookupFrame} from '../src/native-frame-context';
import {artifactFixture} from './helpers/native-artifact-fixture';

const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()});
function fixture(){
 const f=artifactFixture(),sessions:any[]=[];
 const context=async(frameId:string)=>{const frame=lookupFrame(f.profile,frameId);if(!frame)throw Error('missing synthetic frame');const rootFrameId=frame.rootFrameId??frame.frameId;return Object.freeze({frameId,rootFrameId,projectId:frame.projectId,ownerId:frame.ownerId,organizationId:frame.organizationId,readOnly:false})};
 const confidentiality:any={policy:{snapshot:()=>({sessions:structuredClone(sessions)}),policy:(value:any)=>{const found=sessions.find(session=>session.rootFrameId===value.rootFrameId);return structuredClone(found??{rootFrameId:value.rootFrameId,projectId:value.projectId,ownerId:value.ownerId,organizationId:value.organizationId,mode:'standard',revision:0})}},ownedContext:context,scope:{currentFrame:()=>undefined}};
 const runtime=new NativeSecurityRuntime({profileDir:f.profile,authDir:join(f.profile,'local-auth'),assetsRoot:f.storage,owner:{userId:'owner-a',organizationId:'org-a'},confidentiality});
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

test('a persisted protected policy selects a private workspace and stale scopes fail',()=>{
 const {runtime,sessions}=fixture();const before=runtime.scopeForFrame('protected');sessions.push({rootFrameId:'protected',projectId:'project-a',ownerId:'owner-a',organizationId:'org-a',mode:'class2',revision:1});
 const current=runtime.scopeForFrame('protected');expect(current.mode).toBe('class2');const workspace=(runtime.callbacks() as any).nativeProtectedWorkspacePath('protected','/ordinary/workspace');expect(workspace).toContain('/chimeric-private-v1/roots/');expect(workspace).not.toBe('/ordinary/workspace');
 expect(()=>runtime.kernels.beginModel(before)).toThrow('scope');
});
