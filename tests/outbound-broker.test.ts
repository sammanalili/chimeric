import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {SessionPolicyStore,type ConnectionBinding,type FrameIdentity,type PolicyLane} from '../src/session-policy';
import {OutboundBroker,type BrokerWireRequest,type BrokerResponse,type OutboundIntent} from '../src/outbound-broker';
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const f of cleanups.splice(0).reverse())f()});
const deferred=()=>{let resolve!:(value:BrokerResponse)=>void;const promise=new Promise<BrokerResponse>(yes=>resolve=yes);return {promise,resolve}};
async function fixture(options:{transport?:(wire:BrokerWireRequest)=>Promise<BrokerResponse>;verified?:boolean;timeoutMs?:number;reviewTtlMs?:number;maxPending?:number;maxLedgerEntries?:number}={}){
 const directory=mkdtempSync(join(tmpdir(),'chimeric-outbound-broker-'));
 const model:ConnectionBinding={id:'approved-model',endpoint:'https://institution.example/v1',api:'openai-completions',revision:'revision-1',credentialRevision:'a'.repeat(64)},external:ConnectionBinding={...model,id:'external-search',endpoint:'https://search.example/api',api:'reviewed-http'};
 const connections=new Map([[model.id,model],[external.id,external]]),frames=new Map<string,FrameIdentity>([
  ['root',{frameId:'root',rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org'}],
  ['other',{frameId:'other',rootFrameId:'other',projectId:'project',ownerId:'owner',organizationId:'org'}],
 ]);
 let now=Date.now(),blocked:PolicyLane|undefined;
 const store=new SessionPolicyStore(directory,{lookupFrame:id=>frames.get(id),currentConnection:id=>connections.get(id),enforcement:(_scope,lane)=>({verified:options.verified!==false&&lane!==blocked}),now:()=>now});
 const context=await store.contextForFrame('root');store.approveConnection(model,['model'],0);store.setMode(context,{expectedRevision:0,mode:'class2',main:{connection:model,modelId:'research-model'}});
 const calls:BrokerWireRequest[]=[],brokerOptions={...options,now:()=>now,transport:async(wire:BrokerWireRequest)=>{calls.push(wire);wire.assertCurrent();return options.transport?options.transport(wire):{status:200,bodyBase64:Buffer.from('Synthetic result').toString('base64')}}};
 const broker=new OutboundBroker(store,brokerOptions);cleanups.push(()=>{broker.close();store.close();rmSync(directory,{recursive:true,force:true})});
 const intent=(intentId='synthetic-intent'):OutboundIntent=>({intentId,connection:external,rationale:'Find public background information using a transformed query.',privacy:{kind:'decontextualized',summary:'Names and unpublished identifiers removed.',limitations:['The topic can still be identifying.']},request:{method:'POST',url:'https://search.example/api/search?q=public+topic',headers:{accept:'application/json'},payload:{kind:'json',value:{query:'Synthetic public topic'}}}});
 return {directory,store,context,model,external,connections,frames,calls,broker,brokerOptions,intent,advance:(ms:number)=>{now+=ms},block:(lane:PolicyLane)=>{blocked=lane}};
}

test('Preparing an anonymized/decontextualized draft never sends; the human review contains actual disclosures',async()=>{
 const f=await fixture(),review=await f.broker.prepare(f.context,f.intent());
 expect(f.calls).toHaveLength(0);expect(review.status).toBe('pending');expect(review.destination).toMatchObject({hostname:'search.example',path:'/api/search',query:[['q','public topic']],encrypted:true});
 expect(review.request.payload).toEqual({kind:'json',value:{query:'Synthetic public topic'}});expect(review.rationale).toContain('background');
 expect(review.privacy.notice).toContain('guarantees anonymity');expect(review.disclosures.ip).toContain('has not been looked up');expect(review.disclosures.location).toContain('approximate');
 expect(f.store.isApproved(f.external,'model')).toBe(false);
});

test('Only the exact reviewed snapshot can be approved and sent once',async()=>{
 const f=await fixture(),intent=f.intent(),review=await f.broker.prepare(f.context,intent);
 (intent.request.payload as any).value.query='MUTATED AFTER REVIEW';intent.request.url='https://evil.example/';(review.request.payload as any).value.query='UI COPY MUTATION';
 await expect(f.broker.approve(f.context,review.id,'0'.repeat(64))).rejects.toThrow('review changed');
 const permit=await f.broker.approve(f.context,review.id,review.digest);
 await expect(f.broker.execute({...permit})).rejects.toThrow('unavailable');
 const result=await f.broker.execute(permit);expect(result.status).toBe(200);expect(f.calls).toHaveLength(1);
 expect(f.calls[0].url).toBe('https://search.example/api/search?q=public+topic');expect(Buffer.from(f.calls[0].bodyBase64,'base64').toString()).toBe('{"query":"Synthetic public topic"}');
 await expect(f.broker.execute(permit)).rejects.toThrow('consumed');await expect(f.broker.prepare(f.context,f.intent())).rejects.toThrow('already used');
});

test('Multipart reviews retain exact uploads, deterministic wire bytes and idempotent pending review',async()=>{
 const f=await fixture(),intent=f.intent();intent.request.payload={kind:'multipart',fields:[{name:'query',value:'Synthetic public query'}],files:[{fieldName:'image',filename:'synthetic.txt',contentType:'text/plain',base64:Buffer.from('SYNTHETIC_UPLOAD_BYTES').toString('base64')}]};
 const first=await f.broker.prepare(f.context,intent),again=await f.broker.prepare(f.context,intent);expect(again.id).toBe(first.id);
 expect(first.request.payload).toEqual(intent.request.payload);await f.broker.execute(await f.broker.approve(f.context,first.id,first.digest));
 const body=Buffer.from(f.calls[0].bodyBase64,'base64').toString();expect(body).toContain('SYNTHETIC_UPLOAD_BYTES');expect(body).toContain('name="image"; filename="synthetic.txt"');expect(f.calls[0].headers['content-type']).toContain('boundary=chimeric-');
});

test('The connection API path prefix and credential/transport headers cannot be bypassed',async()=>{
 const f=await fixture();
 for(const url of ['https://evil.example/api/search','https://search.example/apix/search','https://search.example/other','https://secret:key@search.example/api/search','https://search.example/api/%2fsecret']){
  const intent=f.intent(url);intent.request.url=url;await expect(f.broker.prepare(f.context,intent)).rejects.toThrow();
 }
 for(const name of ['authorization','Cookie','X-Api-Key','Host','Content-Length','Transfer-Encoding']){
  const intent=f.intent(name);intent.request.headers={[name]:'SYNTHETIC_SECRET'};await expect(f.broker.prepare(f.context,intent)).rejects.toThrow('Authentication and transport');
 }
 expect(f.calls).toHaveLength(0);
});

test('Changed binding invalidates approval even when no notification is delivered',async()=>{
 const f=await fixture(),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 f.connections.set(f.external.id,{...f.external,credentialRevision:'b'.repeat(64)});
 await expect(f.broker.execute(permit)).rejects.toThrow('connection URL, credential');expect(f.calls).toHaveLength(0);
 await expect(f.broker.execute(permit)).rejects.toThrow('consumed');
});

test('Policy or connection changes revoke pending reviews and abort in-flight requests',async()=>{
 const gate=deferred(),f=await fixture({transport:()=>gate.promise});const review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest),pending=f.broker.execute(permit);
 while(!f.calls.length)await Promise.resolve();f.store.connectionsChanged(f.external.id);
 await expect(pending).rejects.toThrow('cancelled');expect(f.calls[0].signal.aborted).toBe(true);expect(f.broker.review(f.context,review.id).status).toBe('revoked');
 const next=await f.broker.prepare(f.context,f.intent('fresh-intent'));f.store.setMode(f.context,{expectedRevision:1,mode:'standard'});
 await expect(f.broker.approve(f.context,next.id,next.digest)).rejects.toThrow('policy changed');
 gate.resolve({status:200,bodyBase64:''});
});

test('A stalled transport times out without retry and cannot reuse its consumed approval',async()=>{
 const f=await fixture({timeoutMs:15,transport:()=>new Promise(()=>{})}),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 await expect(f.broker.execute(permit)).rejects.toThrow('timed out');expect(f.calls).toHaveLength(1);await expect(f.broker.execute(permit)).rejects.toThrow('consumed');
});

test('Denial, expiry, unsupported confinement and scope forgery send nothing',async()=>{
 const f=await fixture({reviewTtlMs:50}),first=await f.broker.prepare(f.context,f.intent());f.broker.deny(f.context,first.id);
 await expect(f.broker.approve(f.context,first.id,first.digest)).rejects.toThrow();
 const expired=await f.broker.prepare(f.context,f.intent('expired'));f.advance(51);await expect(f.broker.approve(f.context,expired.id,expired.digest)).rejects.toThrow('expired');
 f.block('brokered-http');await expect(f.broker.prepare(f.context,f.intent('unsupported'))).rejects.toThrow('not been verified');
 await expect(f.broker.prepare({...f.context},f.intent('forged'))).rejects.toThrow('verified native');expect(f.calls).toHaveLength(0);
});

test('Redirects require a new exact-destination review rather than following automatically',async()=>{
 const f=await fixture({transport:async()=>({status:302,headers:{location:'https://other.example/new'},bodyBase64:''})}),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 await expect(f.broker.execute(permit)).rejects.toMatchObject({code:'redirect_requires_review',redirectUrl:'https://other.example/new'});expect(f.calls).toHaveLength(1);expect(f.calls[0].redirect).toBe('error');
});

test('Receipts survive restart, never persist payloads, and pending approvals cannot be replayed',async()=>{
 const f=await fixture(),review=await f.broker.prepare(f.context,f.intent());await f.broker.approve(f.context,review.id,review.digest);f.broker.close();
 const disk=readFileSync(join(f.directory,'local-auth/outbound-approvals.json'),'utf8');expect(disk).not.toContain('Synthetic public topic');expect(disk).not.toContain('Names and unpublished');
 const restarted=new OutboundBroker(f.store,f.brokerOptions);cleanups.push(()=>restarted.close());await expect(restarted.prepare(f.context,f.intent())).rejects.toThrow('already used');expect(f.calls).toHaveLength(0);
});

test('Review and receipt bounds fail closed without evicting consumed identifiers',async()=>{
 const f=await fixture({maxPending:1,maxLedgerEntries:2}),one=await f.broker.prepare(f.context,f.intent('one'));
 await expect(f.broker.prepare(f.context,f.intent('two'))).rejects.toThrow('Too many');f.broker.deny(f.context,one.id);
 const two=await f.broker.prepare(f.context,f.intent('two'));f.broker.deny(f.context,two.id);
 await expect(f.broker.prepare(f.context,f.intent('three'))).rejects.toThrow('receipt store is full');expect(f.calls).toHaveLength(0);
});

test('A consumed permit cannot dispatch twice under concurrency',async()=>{
 const gate=deferred(),f=await fixture({transport:()=>gate.promise}),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 const first=f.broker.execute(permit);await expect(f.broker.execute(permit)).rejects.toThrow('consumed');
 while(!f.calls.length)await Promise.resolve();gate.resolve({status:200,bodyBase64:''});expect((await first).status).toBe(200);expect(f.calls).toHaveLength(1);
});

test('Approval expiry applies before dispatch, while an already dispatched response remains usable',async()=>{
 const f=await fixture({reviewTtlMs:25}),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 f.advance(26);await expect(f.broker.execute(permit)).rejects.toThrow('expired');expect(f.calls).toHaveLength(0);
 const gate=deferred(),active=await fixture({reviewTtlMs:25,transport:()=>gate.promise}),next=await active.broker.prepare(active.context,active.intent()),allowed=await active.broker.approve(active.context,next.id,next.digest),pending=active.broker.execute(allowed);
 while(!active.calls.length)await Promise.resolve();active.advance(26);gate.resolve({status:200,bodyBase64:''});expect((await pending).status).toBe(200);
});

test('Owner changes after review fail before transport, and old transformed payloads have bounded retention',async()=>{
 const f=await fixture(),review=await f.broker.prepare(f.context,f.intent()),permit=await f.broker.approve(f.context,review.id,review.digest);
 f.frames.set('root',{frameId:'root',rootFrameId:'root',projectId:'project',ownerId:'replacement-owner',organizationId:'org'});
 await expect(f.broker.execute(permit)).rejects.toThrow('scope changed');expect(f.calls).toHaveLength(0);
 const bounded=await fixture();
 for(let index=0;index<20;index++){const r=await bounded.broker.prepare(bounded.context,bounded.intent('retention-'+index));bounded.broker.deny(bounded.context,r.id)}
 expect(bounded.broker.reviews(bounded.context)).toHaveLength(16);
 expect(bounded.broker.reviews(bounded.context).at(-1)?.status).toBe('denied');
});
