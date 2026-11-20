import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inflateSync,zstdDecompressSync} from 'node:zlib';
import {Registry} from '../src/registry';
import {ProviderManager} from '../src/provider-manager';
import {SubscriptionManager,SubscriptionVault} from '../src/subscription';
import {IMAGE_PROBE_GLYPHS} from '../src/model-probe';

const deferred=()=>{let resolve!:(value?:any)=>void;const promise=new Promise<any>(accept=>resolve=accept);return{promise,resolve}};
function answerFromImage(body:any){
 const images:string[]=[],texts:string[]=[];
 const walk=(value:any)=>{if(typeof value==='string'&&value.startsWith('data:image/png;base64,'))images.push(value);else if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object'){if(['text','input_text'].includes(value.type))texts.push(value.text);Object.values(value).forEach(walk)}};walk(body);
 expect(images).toHaveLength(1);expect(texts.join(' ')).not.toMatch(/\d{6}/);
 const png=Buffer.from(images[0].split(',')[1],'base64');expect(png.subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
 const idat:Buffer[]=[];for(let offset=8;offset<png.length;){const length=png.readUInt32BE(offset),type=png.subarray(offset+4,offset+8).toString();if(type==='IDAT')idat.push(png.subarray(offset+8,offset+8+length));offset+=12+length}
 const bytes=inflateSync(Buffer.concat(idat)),width=png.readUInt32BE(16),row=1+width*3;
 return Array.from({length:6},(_,index)=>{const glyph=Array.from({length:7},(_,gy)=>Array.from({length:5},(_,gx)=>bytes[(12+gy*6)*row+1+(12+index*36+gx*6)*3]===0?'1':'0').join(''));const digit=Object.keys(IMAGE_PROBE_GLYPHS).find(key=>IMAGE_PROBE_GLYPHS[key].join('')===glyph.join(''));expect(digit).toBeDefined();return digit}).join('');
}
function stream(text:string,api:string){
 if(api==='openai-completions')return new Response('data: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({id:'probe',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
 const item={id:'probe-message',type:'message',role:'assistant',content:[{type:'output_text',text,annotations:[]}]};
 const response={id:'probe',object:'response',created_at:1,status:'completed',model:'fixture',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
 const events=[{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...item,content:[]}},{type:'response.content_part.added',output_index:0,content_index:0,item_id:item.id,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',output_index:0,content_index:0,item_id:item.id,delta:text},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response}];
 return new Response(events.map(event=>'event: '+event.type+'\ndata: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
}
async function body(request:Request){const raw=Buffer.from(await request.arrayBuffer());return JSON.parse((request.headers.get('content-encoding')==='zstd'?zstdDecompressSync(raw):raw).toString())}
async function fixture(api='openai-completions',handler?:(request:Request,data:any)=>Promise<Response>|Response,models=[{id:'fixture'}],options:any={}){
 const seen:any[]=[];const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(request){const data=await body(request);seen.push({path:new URL(request.url).pathname,body:data});return handler?handler(request,data):stream(answerFromImage(data),api)}});
 const dir=mkdtempSync(join(tmpdir(),'chimeric-image-probe-')),registry=new Registry({providers:{},defaultModel:'unconfigured'},dir),manager=new ProviderManager(registry,()=>{},options);
 const config={expectedRevision:0,name:'Synthetic',baseUrl:server.url.href+'v1',api,mode:'manual',models};
 // Subscription connections are normally registered by their own sign-in UI.
 let id:string,subscription:SubscriptionManager|undefined;
 if(api==='openai-codex-responses'){
  id='subscription';registry.config.providers[id]={name:'Synthetic subscription',baseUrl:server.url.href+'v1',api,revision:'subscription-v1',enabled:true,keyEnv:'',allowInsecureHttp:false,requestTimeoutMs:600000,models,modelOverrides:{}};
  const vault=new SubscriptionVault(join(dir,'local-auth'));vault.write({session:'synthetic-session',version:'one',credential:{type:'oauth',access:'header.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'synthetic'}})).toString('base64url')+'.signature',refresh:'synthetic-refresh',expires:Date.now()+3600000}});
  subscription=new SubscriptionManager(vault,{endpoint:server.url.href+'v1/codex/responses'});registry.subscription=subscription;await registry.refresh();
 }else{id=(await manager.upsert(config)).connections[0].id}
 const start=(extra:any={})=>manager.probe({id,expectedRevision:registry.revision,connectionRevision:registry.config.providers[id].revision,...extra});
 const done=async()=>{const deadline=Date.now()+5000;while(manager.snapshot().probeJobs.some(job=>job.status==='running')){if(Date.now()>deadline)throw Error('Probe fixture did not finish.');await Bun.sleep(5)}return manager.snapshot().connections.find(connection=>connection.id===id)!};
 return{dir,registry,manager,server,id,seen,config,start,done,async close(){await manager.close();subscription?.close();server.stop(true);rmSync(dir,{recursive:true,force:true})}};
}

for(const api of ['openai-completions','openai-responses','openai-codex-responses'])test('Synthetic image challenge traverses '+api+' and becomes usable without restart',async()=>{
 const f=await fixture(api);try{const revision=f.registry.revision,port=f.server.port;const result=await f.start({modelId:'fixture'});expect(result.probeJobId).toBeDefined();expect(result.probeJobs[0].status).toBe('running');const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe('supported');expect(model.input).toContain('image');expect(model.declaredInput).toEqual(['text']);expect(f.registry.revision).toBe(revision);expect(f.server.port).toBe(port);expect(f.seen[0].path).toBe(api==='openai-completions'?'/v1/chat/completions':api==='openai-responses'?'/v1/responses':'/v1/codex/responses');expect(readFileSync(join(f.dir,'model-probes.json'),'utf8')).not.toContain('synthetic-refresh')}finally{await f.close()}
});

test('A reasoning subscription image probe uses the lowest declared supported effort',async()=>{
 const f=await fixture('openai-codex-responses',(_request,data)=>data.reasoning?.effort==='low'?stream(answerFromImage(data),'openai-codex-responses'):Response.json({error:{message:"Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model. Supported values are: 'low', 'medium', 'high', 'xhigh', and 'max'."}},{status:400}));
 try{
  f.registry.config.providers[f.id].modelOverrides={fixture:{reasoning:true,reasoningEfforts:{low:'low',medium:'medium',high:'high',xhigh:'xhigh',max:'max'}}};await f.registry.refresh(false);
  await f.start({modelId:'fixture'});expect((await f.done()).models[0].imageProbe?.status).toBe('supported');expect(f.seen).toHaveLength(1);expect(f.seen[0].body.reasoning.effort).toBe('low');
 }finally{await f.close()}
});

test('Wrong answers remain inconclusive and never grant image support after HTTP success',async()=>{
 const f=await fixture('openai-completions',(_request,data)=>{answerFromImage(data);return stream('I cannot inspect images.','openai-completions')});try{await f.start();const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe('inconclusive');expect(model.input).toEqual(['text'])}finally{await f.close()}
});

test('A transient quota failure retains earlier image support and evidence survives restart',async()=>{
 let quota=false;const f=await fixture('openai-completions',(_request,data)=>quota?new Response('quota reached',{status:429}):stream(answerFromImage(data),'openai-completions'));
 try{await f.start();expect((await f.done()).models[0].imageProbe?.status).toBe('supported');quota=true;await f.start();const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe('inconclusive');expect(model.input).toContain('image');const restored=Registry.fromFile(undefined,f.dir);await restored.refresh(false);expect(restored.resolve(f.id+'::fixture').imageProbe?.status).toBe('inconclusive');expect(restored.resolve(f.id+'::fixture').input).toContain('image')}finally{await f.close()}
});

test('A connection edit during inference invalidates completion without holding the configuration queue',async()=>{
 const arrived=deferred(),release=deferred();const f=await fixture('openai-completions',async(_request,data)=>{const answer=answerFromImage(data);arrived.resolve();await release.promise;return stream(answer,'openai-completions')});
 try{await f.start();await arrived.promise;await f.manager.upsert({...f.config,expectedRevision:1,id:f.id,name:'Edited while probe runs'});expect(f.registry.revision).toBe(2);release.resolve();const model=(await f.done()).models[0];expect(model.imageProbe).toBeUndefined();expect(model.input).toEqual(['text']);expect(()=>readFileSync(join(f.dir,'model-probes.json'))).toThrow()}finally{release.resolve();await f.close()}
});

test('Removing a connection during inference prevents evidence from restoring it',async()=>{
 const arrived=deferred(),release=deferred();const f=await fixture('openai-completions',async(_request,data)=>{const answer=answerFromImage(data);arrived.resolve();await release.promise;return stream(answer,'openai-completions')});
 try{await f.start();await arrived.promise;await f.manager.remove({expectedRevision:1,id:f.id});release.resolve();await f.done();expect(f.registry.models.size).toBe(0);expect(f.manager.snapshot().connections).toEqual([]);expect(()=>readFileSync(join(f.dir,'model-probes.json'))).toThrow()}finally{release.resolve();await f.close()}
});

test('Model batch concurrency stays at two and publishes retained progress',async()=>{
 let active=0,peak=0;const f=await fixture('openai-completions',async(_request,data)=>{active++;peak=Math.max(peak,active);const answer=answerFromImage(data);await Bun.sleep(30);active--;return stream(answer,'openai-completions')},Array.from({length:6},(_,index)=>({id:'model-'+index})));let publications=0;f.manager.subscribe(()=>publications++);
 try{await f.start();const connection=await f.done();expect(peak).toBe(2);expect(connection.models.every(model=>model.imageProbe?.status==='supported')).toBe(true);expect(f.manager.snapshot().probeJobs[0]).toMatchObject({status:'completed',completed:6,total:6});expect(publications).toBeGreaterThan(6)}finally{await f.close()}
});

test('Raw input metadata is recognized and explicit image declarations remain unverified until tested',async()=>{
 const f=await fixture();try{(f.registry.config.providers[f.id].models![0] as any).input=['text','image'];await f.registry.refresh(false);expect(f.registry.resolve(f.id+'::fixture').input).toEqual(['text','image']);expect(f.registry.resolve(f.id+'::fixture').imageProbe).toBeUndefined();expect(f.registry.resolve(f.id+'::fixture').capabilitiesVerified).toBe(false)}finally{await f.close()}
});

test('Timeout is inconclusive and manual vision opt-in remains available',async()=>{
 const f=await fixture('openai-completions',()=>new Promise<Response>(()=>{}),[{id:'fixture'}],{timeoutMs:80});
 try{await f.manager.upsert({...f.config,id:f.id,expectedRevision:1,capabilities:{images:true,reasoning:false,efforts:['low']}});await f.start();const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe('inconclusive');expect(model.input).toContain('image');expect(model.capabilitiesVerified).toBe(false)}finally{await f.close()}
});

test('Endpoint or credential changes remove previous verification without removing explicit declarations',async()=>{
 const f=await fixture();try{await f.start();expect((await f.done()).models[0].imageProbe?.status).toBe('supported');await f.manager.upsert({...f.config,id:f.id,expectedRevision:1,apiKey:'new-synthetic-key',capabilities:{images:true,reasoning:false,efforts:['low']}});const model=f.manager.snapshot().connections[0].models[0];expect(model.imageProbe).toBeUndefined();expect(model.input).toContain('image');expect(model.capabilitiesVerified).toBe(false);const restored=Registry.fromFile(undefined,f.dir);await restored.refresh(false);expect(restored.resolve(f.id+'::fixture').imageProbe).toBeUndefined()}finally{await f.close()}
});

test('Subscription session changes invalidate earlier evidence',async()=>{
 const f=await fixture('openai-codex-responses');try{await f.start();expect((await f.done()).models[0].imageProbe?.status).toBe('supported');f.registry.subscription!.disconnect();f.manager.notify();expect(f.manager.snapshot().connections[0].models[0].imageProbe).toBeUndefined()}finally{await f.close()}
});


test('Only an explicit endpoint image rejection is classified as rejected',async()=>{
 const f=await fixture('openai-completions',()=>new Response('This model does not support image input.',{status:400}));try{await f.start();const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe('rejected');expect(model.input).toEqual(['text'])}finally{await f.close()}
});


// Exact bounded safe-error text observed in the live RiVault image probe.
const rivaultNonMultimodalError="400: {\"message\":\"litellm.BadRequestError: Hosted_vllmException - {\\\"error\\\":{\\\"message\\\":\\\"deepseek-ai/DeepSeek-V4-Flash is not a multimodal model\\\",\\\"type\\\":\\\"BadRequestError\\\",\\\"param\\\":null,\\\"code\\\":400}}\\n\\nLiteLLM: model group 'RiVault/Agentic-Medium' failed with the error above and no fallback";
for(const [status,expected] of [[400,'rejected'],[401,'inconclusive'],[429,'inconclusive'],[503,'inconclusive']] as const)test('RiVault non-multimodal rejection stays distinct from HTTP '+status+' availability failures',async()=>{
 const f=await fixture('openai-completions',()=>Response.json({message:rivaultNonMultimodalError},{status}));
 try{await f.start();const model=(await f.done()).models[0];expect(model.imageProbe?.status).toBe(expected);expect(model.input).toEqual(['text'])}finally{await f.close()}
});
