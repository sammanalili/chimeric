import {afterEach,expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installClass2Http,type Class2Backend,type Class2Snapshot} from '../src/class2-http';
import {SessionPolicyStore,type ConnectionBinding,type FrameIdentity} from '../src/session-policy';
import {OutboundBroker,type BrokerWireRequest} from '../src/outbound-broker';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const fn of cleanup.splice(0).reverse())fn()});
const base='/api/local/confidentiality';
const reviewId='b8c206b3-a6d7-411b-9cbd-c72881930142';
const snapshot=(extra:any={}):Class2Snapshot=>({revision:0,frameId:'frame',rootFrameId:'frame',mode:'standard',models:[],ready:false,reviews:[],...extra});
function http(backend:Class2Backend){
 const routes=new Map<string,Function>(),app:any={};for(const method of ['get','put','post'])app[method]=(path:string,handler:Function)=>routes.set(method.toUpperCase()+' '+path,handler);
 installClass2Http(app,backend,'?fixture=1');
 async function call(method:string,path:string,options:any={}){
  const raw=Object.assign(new EventEmitter(),{writableEnded:false}),request={query:{frameId:'frame'},params:{},raw:new EventEmitter(),...options};
  const reply:any={status:200,headers:{},raw,header(name:string,value:string){this.headers[name]=value;return this},type(value:string){return this.header('content-type',value)},code(value:number){this.status=value;return this},send(value:any){this.body=value;return value}};
  const value=await routes.get(method+' '+path)!(request,reply);return {status:reply.status,body:reply.body??value,headers:reply.headers,request,reply};
 }
 return {routes,call};
}
function stub(overrides:Partial<Class2Backend>={}){const calls:any[]=[];return {calls,backend:{snapshot:async(input:any)=>input.connectionId?{revision:0,connectionId:input.connectionId,name:'Synthetic',allowedPurposes:[],eligible:false}:snapshot({frameId:input.frameId}),setMode:(input:any)=>{calls.push(input)},approveConnection:(input:any)=>{calls.push(input)},sendOnce:(input:any)=>{calls.push(input)},deny:(input:any)=>{calls.push(input)},...overrides} as Class2Backend}}
async function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'chimeric-class2-http-')),model:ConnectionBinding={id:'model',endpoint:'https://model.example/v1',api:'openai-completions',revision:'one',credentialRevision:'a'.repeat(64)},external={...model,id:'external',endpoint:'https://external.example/api'};
 const connections=new Map([[model.id,model],[external.id,external]]),frames=new Map<string,FrameIdentity>(['frame','other'].map(id=>[id,{frameId:id,rootFrameId:id,projectId:'project',ownerId:'owner',organizationId:'org'}]));
 const policy=new SessionPolicyStore(directory,{lookupFrame:id=>frames.get(id),currentConnection:id=>connections.get(id),enforcement:()=>({verified:true})});
 const wires:BrokerWireRequest[]=[],broker=new OutboundBroker(policy,{transport:async wire=>{wire.assertCurrent();wires.push(wire);return {status:200,bodyBase64:''}}});
 cleanup.push(()=>{broker.close();policy.close();rmSync(directory,{recursive:true,force:true})});
 const backend:Class2Backend={
  async snapshot(input){if(input.connectionId){const state=policy.snapshot(),binding=connections.get(input.connectionId)!;return {revision:state.revision,connectionId:binding.id,name:'Synthetic model',allowedPurposes:state.approvals.find(a=>a.binding.id===binding.id)?.purposes??[],eligible:policy.isApproved(binding,'model')}};
   const context=await policy.contextForFrame(input.frameId!),state=policy.policy(context);return snapshot({...state,frameId:input.frameId,main:state.main?state.main.connection.id+'::'+state.main.modelId:undefined,reviewer:state.reviewer?state.reviewer.connection.id+'::'+state.reviewer.modelId:undefined,models:[{qualifiedId:'model::research',name:'Synthetic research',connectionId:model.id,eligible:policy.isApproved(model,'model')}],ready:policy.isApproved(model,'model'),reviews:broker.reviews(context),internalCredential:'MUST_NOT_SERIALIZE'});
  },
  async setMode(input){const context=await policy.contextForFrame(input.frameId),target=(value?:string)=>value?{connection:connections.get(value.split('::')[0])!,modelId:value.split('::')[1]}:undefined;return policy.setMode(context,{...input,main:target(input.main),reviewer:target(input.reviewer)})},
  approveConnection(input){return input.purposes.length?policy.approveConnection(connections.get(input.connectionId)!,input.purposes,input.expectedRevision):policy.revokeConnection(input.connectionId,input.expectedRevision)},
  async sendOnce(input,signal){const context=await policy.contextForFrame(input.frameId),permit=await broker.approve(context,input.reviewId,input.digest);const response=await broker.execute(permit,signal);return {permit,response,private:'MUST_NOT_SERIALIZE'}},
  async deny(input){return broker.deny(await policy.contextForFrame(input.frameId),input.reviewId)},
 };
 const api=http(backend),context=await policy.contextForFrame('frame');
 async function enable(){await api.call('PUT',base+'/connections/:connectionId',{params:{connectionId:'model'},body:{expectedRevision:policy.snapshot().revision,purposes:['model']}});return api.call('PUT',base,{body:{frameId:'frame',expectedRevision:policy.policy(context).revision,mode:'class2',main:'model::research',reviewer:'model::research'}})}
 async function prepare(intentId='synthetic'){return broker.prepare(context,{intentId,connection:external,rationale:'Search a transformed public query.',privacy:{kind:'decontextualized',summary:'Removed the synthetic name.'},request:{method:'POST',url:'https://external.example/api/search',payload:{kind:'json',value:{query:'Synthetic public context'}}}})}
 return {...api,policy,broker,connections,model,external,context,wires,enable,prepare};
}

test('HTTP accepts only scope lookup keys and explicit permission purposes, never caller authority or retention assertions',async()=>{
 const s=stub(),api=http(s.backend);
 for(const body of [{frameId:'frame',expectedRevision:0,mode:'class2',main:'model::test',class2:true},{frameId:'frame',rootFrameId:'other',expectedRevision:0,mode:'standard'},{frameId:'frame',expectedRevision:0,mode:'standard',main:'model::test'},{frameId:'frame',expectedRevision:0,mode:'class2'}])expect((await api.call('PUT',base,{body})).status).toBe(400);
 for(const body of [{expectedRevision:0,purposes:['model'],evidence:{zdr:true}},{expectedRevision:0,purposes:['model'],binding:{endpoint:'https://evil.example'}},{expectedRevision:0,purposes:['model','model']}])expect((await api.call('PUT',base+'/connections/:connectionId',{params:{connectionId:'model'},body})).status).toBe(400);
 expect(s.calls).toHaveLength(0);
 expect((await api.call('PUT',base+'/connections/:connectionId',{params:{connectionId:'model'},body:{expectedRevision:0,purposes:[]}})).status).toBe(200);expect(s.calls).toEqual([{connectionId:'model',expectedRevision:0,purposes:[]}]);
});
test('actual policy approval and protected main/reviewer routing require current allowed connection and revision',async()=>{
 const f=await fixture();expect((await f.call('PUT',base,{body:{frameId:'frame',expectedRevision:0,mode:'class2',main:'model::research'}})).status).toBe(403);
 const enabled=await f.enable();expect(enabled.status).toBe(200);expect(enabled.body).toMatchObject({mode:'class2',main:'model::research',reviewer:'model::research',revision:1});expect(JSON.stringify(enabled.body)).not.toContain('MUST_NOT_SERIALIZE');
 expect((await f.call('PUT',base,{body:{frameId:'frame',expectedRevision:0,mode:'standard'}})).status).toBe(409);
 expect((await f.call('PUT',base,{body:{frameId:'frame',expectedRevision:1,mode:'standard'}})).body.mode).toBe('standard');
});
test('exact server-held review sends once; payload replacement, cross-session approval and stale digest never dispatch',async()=>{
 const f=await fixture();await f.enable();const review=await f.prepare(),path=base+'/reviews/:id/send',params={id:review.id};
 const visible=await f.call('GET',base);expect(visible.body.reviews[0].request.payload).toEqual({kind:'json',value:{query:'Synthetic public context'}});expect(visible.body.reviews[0].scope).toBeUndefined();expect(visible.body.reviews[0].connection).toEqual({id:'external',api:'openai-completions',endpoint:'https://external.example/api'});expect(visible.body.reviews[0].connection.credentialRevision).toBeUndefined();
 expect((await f.call('POST',path,{params,body:{frameId:'frame',digest:review.digest,payload:{query:'MUTATION'}}})).status).toBe(400);
 expect((await f.call('POST',path,{params,body:{frameId:'other',digest:review.digest}})).status).not.toBe(200);
 expect((await f.call('POST',path,{params,body:{frameId:'frame',digest:'0'.repeat(64)}})).status).toBe(409);expect(f.wires).toHaveLength(0);
 const sent=await f.call('POST',path,{params,body:{frameId:'frame',digest:review.digest}});expect(sent.status).toBe(200);expect(sent.body.reviews[0].status).toBe('sent');expect(JSON.stringify(sent.body)).not.toContain('MUST_NOT_SERIALIZE');expect(f.wires).toHaveLength(1);expect(Buffer.from(f.wires[0].bodyBase64,'base64').toString()).toBe('{"query":"Synthetic public context"}');
 expect((await f.call('POST',path,{params,body:{frameId:'frame',digest:review.digest}})).status).not.toBe(200);expect(f.wires).toHaveLength(1);
});
test('connection changes and human denial revoke pending review without network',async()=>{
 const f=await fixture();await f.enable();const review=await f.prepare();f.connections.set('external',{...f.external,credentialRevision:'b'.repeat(64)});
 expect((await f.call('POST',base+'/reviews/:id/send',{params:{id:review.id},body:{frameId:'frame',digest:review.digest}})).status).toBe(409);expect(f.wires).toHaveLength(0);
 f.connections.set('external',f.external);const next=await f.prepare('second');expect((await f.call('POST',base+'/reviews/:id/deny',{params:{id:next.id},body:{frameId:'frame'}})).body.reviews.at(-1).status).toBe('denied');expect(f.wires).toHaveLength(0);
});
test('scope mismatches and unexpected backend failures expose no private diagnostics',async()=>{
 const wrong=stub({snapshot:()=>snapshot({frameId:'other'})});expect((await http(wrong.backend).call('GET',base)).body.code).toBe('scope_changed');
 const secret=stub({setMode:()=>{throw Error('SYNTHETIC_PRIVATE_KEY')}}),result=await http(secret.backend).call('PUT',base,{body:{frameId:'frame',expectedRevision:0,mode:'standard'}});expect(result.status).toBe(500);expect(JSON.stringify(result.body)).not.toContain('SYNTHETIC');expect(result.headers['cache-control']).toBe('no-store');
});
test('client abort cancels the server-held send and removes native listeners without serializing its result',async()=>{
 let observed:AbortSignal|undefined,release:()=>void=()=>{},entered:()=>void=()=>{};const ready=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve);
 const s=stub({sendOnce:async(_input,signal)=>{observed=signal;entered();await gate;return {privatePermit:'MUST_NOT_SERIALIZE'}}}),api=http(s.backend),raw=new EventEmitter();
 const pending=api.call('POST',base+'/reviews/:id/send',{params:{id:reviewId},body:{frameId:'frame',digest:'a'.repeat(64)},raw});await ready;raw.emit('aborted');expect(observed!.aborted).toBe(true);release();const result=await pending;expect(raw.listenerCount('aborted')).toBe(0);expect(result.reply.raw.listenerCount('close')).toBe(0);expect(JSON.stringify(result.body)).not.toContain('MUST_NOT_SERIALIZE');
});
test('successful response close does not cancel an already completed send, and the component is current and non-cacheable',async()=>{
 let observed:AbortSignal|undefined;const s=stub({sendOnce:async(_input,signal)=>{observed=signal}}),api=http(s.backend),result=await api.call('POST',base+'/reviews/:id/send',{params:{id:reviewId},body:{frameId:'frame',digest:'a'.repeat(64)}});result.reply.raw.writableEnded=true;result.reply.raw.emit('close');expect(observed!.aborted).toBe(false);
 const component=await api.call('GET',base+'/component.js',{query:{}});expect(component.body).toContain('vendor-CED4rDjN.js?fixture=1');expect(component.body).not.toContain('?science_local=chatgpt-v1');expect(component.headers['cache-control']).toBe('no-store');
});
test('an already disconnected request reaches the trusted backend with an aborted signal',async()=>{
 let signal:AbortSignal|undefined;const s=stub({sendOnce:async(_input,value)=>{signal=value;value!.throwIfAborted()}}),raw=Object.assign(new EventEmitter(),{aborted:true});
 const result=await http(s.backend).call('POST',base+'/reviews/:id/send',{params:{id:reviewId},body:{frameId:'frame',digest:'a'.repeat(64)},raw});expect(signal!.aborted).toBe(true);expect(result.status).not.toBe(200);expect(raw.listenerCount('aborted')).toBe(0);
});
