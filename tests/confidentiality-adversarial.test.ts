import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ConfidentialityManager} from '../src/confidentiality-manager';
import type {BrokerWireRequest} from '../src/outbound-broker';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn()});
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));
function fixture(){
 const profileDir=mkdtempSync(join(tmpdir(),'chimeric-confidentiality-adversarial-'));
 const models=['inside::main','inside::review','other::outside'].map(qualifiedId=>{const [provider,id]=qualifiedId.split('::');return {provider,id,qualifiedId,name:id,mode:'chat',api:'openai-completions'}}),wires:BrokerWireRequest[]=[];
 const state={key:'synthetic-protected-key'},registry:any={profileDir,config:{providers:Object.fromEntries(['inside','other'].map(id=>[id,{name:id,api:'openai-completions',baseUrl:'https://'+id+'.example/v1',revision:'one',enabled:true}]))},state:{model:'other::outside'},statuses:{inside:{ready:true},other:{ready:true}},models:new Map(models.map(model=>[model.qualifiedId,model])),getPrivateCredential:()=>state.key,resolve:(id:string)=>{const model=models.find(model=>model.qualifiedId===id);if(!model)throw Error('Unknown synthetic model');return model}};
 const manager=new ConfidentialityManager(registry, {protectionEvidence:()=>({verified:true}),owner:{userId:'owner',organizationId:'org'},lookupFrame:(_profile,id)=>['root','child','other','foreign'].includes(id)?{frameId:id,rootFrameId:id==='child'?'root':id,parentFrameId:id==='child'?'root':null,projectId:'project',ownerId:id==='foreign'?'someone-else':'owner',organizationId:'org'}:undefined,transport:async wire=>{wire.assertCurrent();wires.push(wire);return {status:200,headers:{'content-type':'text/plain'},bodyBase64:Buffer.from('Synthetic public result').toString('base64')}}});
 cleanup.push(()=>{manager.close();rmSync(profileDir,{recursive:true,force:true})});
 const host={frameId:'child',rootFrameId:'root',projectId:'project',agentName:'research'},args={rationale:'Find a public constant.',privacy:{kind:'decontextualized' as const,summary:'Removed all synthetic names.'},request:{method:'GET' as const,url:'https://public.example/constant?q=water',payload:{kind:'none' as const}}};
 const enable=async()=>{await manager.approveConnection({connectionId:'inside',expectedRevision:0,purposes:['model']});await manager.setMode({frameId:'root',expectedRevision:0,mode:'class2',main:'inside::main',reviewer:'inside::review'})};
 async function waitReview(){for(let i=0;i<50;i++){const snapshot:any=await manager.snapshot({frameId:'root'});if(snapshot.reviews.length)return snapshot.reviews.at(-1);await pause()}throw Error('Synthetic review did not appear')}
 return {manager,state,registry,wires,host,args,enable,waitReview};
}
test('scope carrier in embedded metadata cannot leave the exact local bridge origin',async()=>{
 const f=fixture(),seen:any[]=[],fetcher=f.manager.scope.scopeFetch((async(input:any,init:any)=>{seen.push({input,init});return new Response('synthetic')}) as typeof fetch,'http://127.0.0.1:15555');
 const metadata=f.manager.scope.nativeMetadata({frameId:'root'},{user_id:'synthetic'});
 await expect(fetcher('https://unrelated.example/messages',{method:'POST',body:JSON.stringify({metadata,messages:[]})})).rejects.toThrow();expect(seen).toHaveLength(0);
});
test('cancelling a model waiting for human approval denies the pending review, resumes its tool and sends nothing',async()=>{
 const f=fixture();await f.enable();const controller=new AbortController(),pending=f.manager.executeOutgoing(f.host,{id:'cancelled-native-call'},f.args,controller.signal),review=await f.waitReview();
 controller.abort();const result:any=await pending;expect(result.status).toBe('error');expect(result.error).toContain('cancelled');expect(f.wires).toHaveLength(0);
 await expect(f.manager.sendOnce({frameId:'root',reviewId:review.id,digest:review.digest})).rejects.toThrow();expect(f.wires).toHaveLength(0);
});
test('changing protected policy while waiting revokes the review and releases the native tool without a retry',async()=>{
 const f=fixture();await f.enable();const pending=f.manager.executeOutgoing(f.host,{id:'policy-change'},f.args),review=await f.waitReview();
 await f.manager.setMode({frameId:'root',expectedRevision:1,mode:'standard'});expect((await pending as any).status).toBe('error');
 await expect(f.manager.sendOnce({frameId:'root',reviewId:review.id,digest:review.digest})).rejects.toThrow();expect(f.wires).toHaveLength(0);
});
test('revoking the protected model connection releases a waiting native tool instead of leaving it busy until expiry',async()=>{
 const f=fixture();await f.enable();let result:any;const pending=f.manager.executeOutgoing(f.host,{id:'connection-change'},f.args).then(value=>{result=value});const review=await f.waitReview();
 await f.manager.approveConnection({connectionId:'inside',expectedRevision:f.manager.policy.snapshot().revision,purposes:[]});await pause();
 try{expect(result?.status).toBe('error');expect((await f.manager.snapshot({frameId:'root'}) as any).reviews.find((item:any)=>item.id===review.id).status).not.toBe('pending');await expect(f.manager.sendOnce({frameId:'root',reviewId:review.id,digest:review.digest})).rejects.toThrow();expect(f.wires).toHaveLength(0)}finally{f.manager.close();await pending}
});
test('reviewer, aside and forged native tool contexts cannot prepare outbound content',async()=>{
 const f=fixture();await f.enable();
 for(const host of [{...f.host,agentName:'REVIEWER'},{...f.host,_isAside:true},{...f.host,agentName:'BOOKMARKER'}])expect((await f.manager.executeOutgoing(host,{id:'rejected-role'},f.args) as any).status).toBe('error');
 await expect(f.manager.executeOutgoing({...f.host,projectId:'wrong-project'},{id:'wrong-project'},f.args)).rejects.toThrow('does not match');
 await expect(f.manager.executeOutgoing({...f.host,frameId:'foreign',rootFrameId:'foreign'},{id:'foreign-owner'},f.args)).rejects.toThrow('different local workspace owner');
 expect((await f.manager.snapshot({frameId:'root'}) as any).reviews).toHaveLength(0);expect(f.wires).toHaveLength(0);
});
test('review snapshots do not cross native root scope, and approval rejects a different workspace owner',async()=>{
 const f=fixture();await f.enable();const review=await f.manager.prepareOutgoing('child',{...f.args,intentId:'scoped-review'});
 expect((await f.manager.snapshot({frameId:'root'}) as any).reviews).toHaveLength(1);expect((await f.manager.snapshot({frameId:'other'}) as any).reviews).toHaveLength(0);
 await expect(f.manager.snapshot({frameId:'foreign'})).rejects.toThrow('different local workspace owner');await expect(f.manager.sendOnce({frameId:'foreign',reviewId:review.id,digest:review.digest})).rejects.toThrow('different local workspace owner');expect(f.wires).toHaveLength(0);
});
test('credential changes abort an already authorized protected request and fail revalidation even without a notification',async()=>{
 const f=fixture();await f.enable();const headers=f.manager.scope.requestOptions({frameId:'child'},{},{}).headers,authorization=await f.manager.authorize(new Request('http://127.0.0.1/messages',{headers}),{model:'other::outside'});
 f.state.key='synthetic-replaced-key';await expect(authorization.assertCurrent()).rejects.toThrow('no longer approved');f.manager.connectionChanged('inside');expect(authorization.signal!.aborted).toBe(true);authorization.close();expect(f.wires).toHaveLength(0);
});
test('standalone image-generation tools and all unverified native paths remain blocked for protected frames',async()=>{
 const f=fixture();await f.enable();for(const name of ['generate_image','external_mcp','python','shell'])await expect(f.manager.guardNativeExecution('tool',f.host,{tool:{name},flattenedMcp:false})).rejects.toThrow('not yet verified');
 await expect(f.manager.guardNativeExecution('tool',f.host,{tool:{name:'request_external_access'},flattenedMcp:false})).resolves.toBeUndefined();await expect(f.manager.guardNativeExecution('tool',f.host,{tool:{name:'request_external_access'},flattenedMcp:true})).rejects.toThrow('not yet verified');expect(f.wires).toHaveLength(0);
});
