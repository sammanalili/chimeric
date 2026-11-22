import {Database} from 'bun:sqlite';
import {mkdirSync,chmodSync,readFileSync,existsSync,realpathSync,statSync} from 'node:fs';
import {join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Registry,ModelEntry} from './registry';
import {atomicJson} from './registry';
import {generateImage,OPENAI_IMAGE_MODELS,OPENAI_SUBSCRIPTION_IMAGE_MODEL,supportsImageReferenceTransport} from './image-generation';
import {generateAntigravityImage} from './antigravity-image-generation';
import {imageReferenceVersionIdsSchema,type ImageReferenceResolver,type ResolvedImageReferences} from './native-image-references';

type Selected={connectionId:string;imageModel:string};
type ImageProviderKind='openai-api'|'chatgpt'|'antigravity';
const providerKind=(api:string):ImageProviderKind=>api==='antigravity-http'?'antigravity':api==='openai-codex-responses'?'chatgpt':'openai-api';
type NativeHost={frameId:string;rootFrameId:string;projectId:string;agentName:string;_isAside?:boolean;_artifactSvcImpl:{save_artifact:(input:any)=>Promise<any>};_fullStore:{_base_path:string;resolve_storage_path:(path:string)=>string;get_version_metadata_lite:(id:string)=>Promise<any>}};
export class ImageGenerationSettingsError extends Error{constructor(message:string,readonly status=400){super(message)}}
const requestSchema=z.object({prompt:z.string().trim().min(1).max(32000),filename:z.string().max(160).optional(),size:z.enum(['auto','1024x1024','1536x1024','1024x1536']).optional(),quality:z.enum(['auto','low','medium','high']).optional(),background:z.enum(['auto','opaque','transparent']).optional(),reference_image_version_ids:imageReferenceVersionIdsSchema.optional()});
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Explicit provider choice and durable tool-call receipts prevent silent billing changes. */
export class ImageGenerationManager{
 private selected:Selected|null=null;
 private revision=0;
 private file:string;
 private db:Database;
 private active=new Map<string,Promise<any>>();
 private controllers=new Set<AbortController>();
 private jobs=0;
 private closed=false;
 constructor(private registry:Registry,private options:{generate?:typeof generateImage;generateAntigravity?:typeof generateAntigravityImage;resolveReferenceImages?:ImageReferenceResolver;changed?:()=>void}={}){
  const dir=join(registry.profileDir,'image-generation');mkdirSync(dir,{recursive:true,mode:0o700});this.file=join(dir,'settings.json');
  if(existsSync(this.file)){
   const saved=z.object({revision:z.number().int().nonnegative(),selected:z.object({connectionId:z.string(),imageModel:z.string()}).nullable()}).parse(JSON.parse(readFileSync(this.file,'utf8')));
   this.selected=saved.selected;this.revision=saved.revision;
  }
  const file=join(dir,'jobs.sqlite');this.db=new Database(file,{create:true});chmodSync(file,0o600);
  this.db.exec("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,inputHash TEXT NOT NULL,phase TEXT NOT NULL,result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL)");
  this.db.query("UPDATE jobs SET phase='interrupted',updatedAt=? WHERE phase='generating'").run(Date.now());
 }
 /** Every selectable image model carries an exact connection binding.  A model
  * name alone never selects a provider or its billing source. */
 private models(){
  const models:any[]=[];
  for(const [connectionId,provider] of Object.entries(this.registry.config.providers) as Array<[string,any]>){
   const kind=providerKind(provider.api),base=provider.baseUrl.replace(/\/+$/,'');
   if(kind==='chatgpt')models.push({id:OPENAI_SUBSCRIPTION_IMAGE_MODEL,name:'GPT Image 2',billing:'subscription' as const,kind,connectionId});
   else if(kind==='antigravity')models.push(...(this.registry.antigravityHttp?.imageCatalog?.()??[]).map(model=>({...model,billing:'subscription' as const,kind,connectionId})));
   else if(['openai-completions','openai-responses'].includes(provider.api)&&base==='https://api.openai.com/v1')models.push(...OPENAI_IMAGE_MODELS.map(id=>({id,name:id,billing:'api' as const,kind,connectionId})));
  }
  models.push(...[...this.registry.models.values()]
   .filter(model=>model.imageGenerationCandidate===true&&['openai-completions','openai-responses'].includes(model.api)&&model.baseUrl.replace(/\/+$/,'')!=='https://api.openai.com/v1')
   .map(model=>({id:model.id,name:model.name,billing:'api' as const,kind:'openai-api' as const,connectionId:model.provider,advertised:model.imageGenerationAdvertised===true})));
  return models;
 }
 private subscriptionSession(model:ModelEntry){return model.api==='antigravity-http'?this.registry.antigravityHttp?.auth.vault.read()?.session:model.api==='openai-codex-responses'?this.registry.subscription?.vault.read()?.session:undefined}
 private binding(selected=this.selected):ModelEntry|undefined{
  if(!selected)return;
  const provider=this.registry.config.providers[selected.connectionId];
  if(!provider?.enabled)return;
  if(provider.api==='antigravity-http'){
   const images=this.registry.antigravityHttp?.imageCatalog?.()??[],image=selected.imageModel?images.find(model=>model.id===selected.imageModel):images[0];
   if(!image)return;
   const qualifiedId=selected.connectionId+'::'+image.id;
   return {id:image.id,qualifiedId,provider:selected.connectionId,providerName:provider.name,api:provider.api,baseUrl:provider.baseUrl,input:['text'],reasoning:false,efforts:[],contextWindow:128000,maxTokens:65536,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},mode:'image-generation',capabilitiesVerified:false,requestTimeoutMs:provider.requestTimeoutMs,replayKey:qualifiedId+'@'+provider.revision,available:this.registry.antigravityHttp?.available()===true,antigravityProject:this.registry.antigravityHttp?.project()} as ModelEntry;
  }
  const models=[...this.registry.models.values()].filter(model=>model.provider===selected.connectionId);
  if(provider.api==='openai-codex-responses'){if(provider.baseUrl.replace(/\/+$/,'')!=='https://chatgpt.com/backend-api')return;return models[0]}
  if(provider.baseUrl.replace(/\/+$/,'')==='https://api.openai.com/v1')return models[0];
  return models.find(model=>model.id===selected.imageModel&&model.imageGenerationCandidate===true)??(!selected.imageModel?models.find(model=>model.imageGenerationCandidate===true):undefined);
 }
 snapshot(){
  const connected=this.registry.subscription?.status().connected===true;
  const providers=Object.entries(this.registry.config.providers).filter(([id,p])=>p.api==='antigravity-http'||p.api==='openai-codex-responses'||p.baseUrl.replace(/\/+$/,'')==='https://api.openai.com/v1'||[...this.registry.models.values()].some(model=>model.provider===id&&model.imageGenerationCandidate===true&&['openai-completions','openai-responses'].includes(model.api))).map(([id,p])=>{
   const kind=providerKind(p.api),subscription=kind!=='openai-api';
   const ready=!!p.enabled&&!!this.binding({connectionId:id,imageModel:''})&&(kind==='antigravity'?this.registry.antigravityHttp?.available()===true:kind==='chatgpt'?connected:!!this.registry.statuses[id]?.ready&&!!this.registry.getPrivateCredential(id));
   const reason=kind==='antigravity'?(this.registry.antigravityHttp?.auth.status().connected?'Refresh Antigravity models before generating images with your subscription.':'Sign in with Antigravity before generating images with your subscription.'):kind==='chatgpt'?'Sign in with ChatGPT before generating images with your subscription.':'Configure this OpenAI API connection and its API key before generating images.';
   const message=kind==='antigravity'?'Uses your Antigravity subscription limits. API billing is never used as a fallback.':kind==='chatgpt'?'Uses your ChatGPT subscription limits. API billing is never used as a fallback.':undefined;
   return {id,name:kind==='chatgpt'&&p.name==='ChatGPT'?'ChatGPT subscription':p.name,kind,billing:subscription?'subscription' as const:'api' as const,ready,...message?{message}:{},...!ready?{reason}:{}};
  });
  const available=providers.some(provider=>provider.kind==='chatgpt'&&provider.ready);
  const imageModels=this.models();
  const quickChoices=providers.flatMap(provider=>imageModels.filter(model=>model.connectionId===provider.id).map(model=>{
   const ready=provider.ready;
   return {id:`image:${provider.id}:${model.id}`,label:provider.name+' · '+model.name,connectionId:provider.id,imageModel:model.id,connectionName:provider.name,billing:provider.billing,ready,...(!ready?{reason:provider.reason??'Connect this image provider in Settings → Connections.'}:{})};
  }));
  const selectedChoice=this.selected?(quickChoices.find(value=>value.connectionId===this.selected!.connectionId&&value.imageModel===this.selected!.imageModel)??(()=>{
   const provider=providers.find(value=>value.id===this.selected!.connectionId);
   return {id:'configured',label:(provider?.name??this.selected!.connectionId)+' · '+this.selected!.imageModel,connectionId:this.selected!.connectionId,imageModel:this.selected!.imageModel,connectionName:provider?.name,billing:provider?.billing??'api',ready:false,reason:provider?.ready?'This image model is no longer available. Choose a current model in Connections.':provider?.reason??'This saved image connection is unavailable.'};
  })()):null;
  const selectedQuickChoice=selectedChoice?.id==='configured'?null:selectedChoice?.id??null;
  return {revision:this.revision,selected:this.selected,providers,imageModels,quickChoices,selectedChoice,selectedQuickChoice,subscription:{available,status:available?'available':'disconnected',message:'Uses your ChatGPT subscription limits. API billing is never used as a fallback.'}};
 }
 configure(raw:unknown){
  const input=z.object({expectedRevision:z.number().int().nonnegative(),connectionId:z.string().nullable(),imageModel:z.string().optional()}).parse(raw);
  if(input.expectedRevision!==this.revision)throw new ImageGenerationSettingsError('Image-generation settings changed in another window. Reload before saving.',409);
  let selected:Selected|null=null;
  if(input.connectionId){
   const source=this.snapshot().providers.find(provider=>provider.id===input.connectionId&&provider.ready);
   if(!source)throw new ImageGenerationSettingsError('Choose a ready image-generation connection.');
   if(!this.models().some(model=>model.id===input.imageModel&&model.kind===source.kind&&(!(model as any).connectionId||(model as any).connectionId===source.id)))throw new ImageGenerationSettingsError('Choose an image model from the supported image-generation list.');
   selected={connectionId:input.connectionId,imageModel:input.imageModel!};
  }
  const revision=this.revision+1;atomicJson(this.file,{schemaVersion:1,revision,selected});this.selected=selected;this.revision=revision;
  try{this.options.changed?.()}catch{/* The committed choice remains authoritative. */}
  return this.snapshot();
 }
 toolDefinition(){
  const model=this.binding();
  if(!this.selected||!model||!this.snapshot().providers.some(provider=>provider.id===this.selected!.connectionId&&provider.ready))return;
  const kind=providerKind(model.api);
  const quota=kind==='antigravity'?'This uses the signed-in Antigravity subscription quota.':kind==='chatgpt'?'This uses the signed-in ChatGPT subscription quota.':'This uses separate OpenAI API billing.';
  return {name:'generate_image',description:'Generate an image requested by the user using the explicitly configured image connection. Selected connection: '+model.provider+'. Image model: '+this.selected.imageModel+'. '+quota+' The image is saved directly into this session’s Files. Return its artifact_ref to the user. Use this for image creation; use ordinary plotting tools for scientific plots based on data.',input_schema:{type:'object',properties:{prompt:{type:'string',description:'A complete image description including labels, style and requested constraints.'},filename:{type:'string',description:'Optional image filename; the output extension is selected by the generator.'},size:{type:'string',enum:['auto','1024x1024','1536x1024','1024x1536'],description:kind==='antigravity'?'Select aspect ratio: auto/square, landscape 3:2 or portrait 2:3. Antigravity chooses native pixel dimensions.':'Requested image dimensions.'},...kind!=='antigravity'?{quality:{type:'string',enum:['auto','low','medium','high']},background:{type:'string',enum:['auto','opaque','transparent']}}:{},...supportsImageReferenceTransport(model)&&this.options.resolveReferenceImages?{reference_image_version_ids:{type:'array',items:{type:'string',format:'uuid'},minItems:1,maxItems:4,uniqueItems:true,description:'Optional pinned native version IDs for 1–4 PNG, JPEG or WebP reference images in this research chat. Use existing Files version IDs. Paths and URLs are not accepted. These images will be sent to the selected image provider.'}}:{}},required:['prompt']}};
 }
 async execute(host:NativeHost,call:{id:string},raw:unknown,signal?:AbortSignal){
  if(this.closed)return {status:'error',error:'The image-generation manager is closed.'};
  if(host._isAside||['REVIEWER','AUDITOR','BOOKMARKER'].includes(host.agentName.toUpperCase()))return {status:'error',error:'Image generation is available in the main research session. Reviewer and aside frames remain read-only.'};
  const input=requestSchema.parse(raw);const model=this.binding(),selected=this.selected;
  if(!selected||!model||!this.toolDefinition())return {status:'error',error:'Configure image generation in Settings → Connections before using this tool.'};
  const antigravity=model.api==='antigravity-http',subscription=antigravity||model.api==='openai-codex-responses',subscriptionSession=subscription?this.subscriptionSession(model):undefined;
  if(subscription&&!subscriptionSession)return {status:'error',error:'The image subscription connection is unavailable. Sign in again before generating an image.'};
  let references:ResolvedImageReferences|undefined;
  if(input.reference_image_version_ids){
   if(subscription||!supportsImageReferenceTransport(model))return {status:'error',error:'Reference images require a compatible API image connection that supports image edits.'};
   if(!this.options.resolveReferenceImages)return {status:'error',error:'Native reference image access is unavailable.'};
   const controller=new AbortController();this.controllers.add(controller);
   const preflightSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
   try{references=await this.options.resolveReferenceImages(host,{versionIds:input.reference_image_version_ids,signal:preflightSignal});await references.assertCurrent();preflightSignal.throwIfAborted()}
   catch(error){return {status:'error',error:preflightSignal.aborted?'Image generation was cancelled before dispatch.':this.registry.safeError(error)}}
   finally{this.controllers.delete(controller)}
  }
  const id=fingerprint({project:host.projectId,frame:host.frameId,tool:call.id}),inputHash=fingerprint({input,selected,connectionRevision:model.replayKey,rootFrameId:host.rootFrameId,...subscription?{subscriptionSession}: {},...references?{references:references.references}: {}});
  const row=this.db.query('SELECT * FROM jobs WHERE id=?').get(id) as any;
  if(row){
   if(row.inputHash!==inputHash)return {status:'error',error:'This image request ID was already used with different content or settings.'};
   if(this.active.has(id))return this.active.get(id)!;
   if(row.phase==='completed'){
    const result=JSON.parse(row.result);
    for(const artifact of result.artifacts??[]){
     let valid=false;
     try{
      const metadata=await host._fullStore.get_version_metadata_lite(artifact.version_id);
      if(metadata&&metadata.project_id===host.projectId&&metadata.root_frame_id===host.rootFrameId&&metadata.frame_id===host.frameId&&metadata.checksum===artifact.checksum){
       const base=realpathSync(host._fullStore._base_path),path=realpathSync(host._fullStore.resolve_storage_path(metadata.storage_path)),within=relative(base,path),info=statSync(path);
       valid=!!within&&!isAbsolute(within)&&!within.split(sep).includes('..')&&info.isFile()&&info.size===artifact.size_bytes&&info.size<=32*1024*1024&&createHash('sha256').update(readFileSync(path)).digest('hex')===artifact.checksum;
      }
     }catch{valid=false}
     if(!valid)return {status:'error',error:'This image was generated previously, but its saved artifact is unavailable or changed. It has not been generated again.'};
    }
    if(references)try{await references.assertCurrent()}catch(error){return {status:'error',error:this.registry.safeError(error)}}
    return {status:'success',result};
   }
   return {status:'error',error:'The previous image request ended without a saved result. It has not been sent again. Request a new image explicitly if you want to retry.'};
  }
  if(signal?.aborted)return {status:'error',error:'Image generation was cancelled before dispatch.'};
  if(this.jobs>=2)return {status:'error',error:'Two image generations are already running. Wait for one to finish.'};
  const now=Date.now();this.db.query("INSERT INTO jobs VALUES (?,?, 'generating',NULL,?,?)").run(id,inputHash,now,now);this.jobs++;
  const controller=new AbortController();this.controllers.add(controller);
  const effectiveSignal=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
  const pending=Promise.resolve().then(async()=>{
   try{
    const generator=antigravity?(this.options.generateAntigravity??generateAntigravityImage):(this.options.generate??generateImage);
    await references?.assertCurrent();
    const request={model,prompt:input.prompt,...references?{referenceImages:references.images}:{},route:antigravity?'antigravity' as const:subscription?'subscription' as const:'images' as const,imageModel:selected.imageModel,...input.size?{size:input.size}:{},...input.quality?{quality:input.quality}:{},...input.background?{background:input.background}:{},...antigravity?{project:model.antigravityProject}:{format:'png' as const},signal:effectiveSignal};
    const deps={resolveAuth:async(bound:any,abort:AbortSignal)=>{
     await references?.assertCurrent();
     if(bound.api==='antigravity-http'){
      const auth=await this.registry.antigravityHttp!.auth.requestAuth(abort);
      if(this.subscriptionSession(model)!==subscriptionSession)throw new Error('The Antigravity connection changed before image generation.');
      return {apiKey:auth.apiKey,assertCurrent:auth.assertCurrent,project:model.antigravityProject};
     }
     if(bound.api==='openai-codex-responses'){
      const auth=await this.registry.subscription!.requestAuth(abort,'images');
      if(this.subscriptionSession(model)!==subscriptionSession)throw new Error('The ChatGPT connection changed before image generation.');
      return auth;
     }
     const auth=await this.registry.requestAuth(bound as ModelEntry,abort);
     await references?.assertCurrent();
     if(!references?.assertDispatchCurrent)return auth;
     let dispatched=false;
     return {...auth,assertCurrent:()=>{auth.assertCurrent?.();if(!dispatched){references.assertDispatchCurrent!();dispatched=true}}};
    },redact:(error:any)=>this.registry.safeError(error)};
    const generated=antigravity?await this.registry.antigravityHttp!.runRequest(signal=>generator({...request,signal},deps),effectiveSignal):await generator(request,deps);
    effectiveSignal.throwIfAborted();await references?.assertCurrent();
    if(subscription&&(!(antigravity?this.registry.antigravityHttp?.available():this.registry.subscription?.status().connected)||this.subscriptionSession(model)!==subscriptionSession))throw new Error('The '+(antigravity?'Antigravity':'ChatGPT')+' connection changed during image generation. The result was not saved and no request was resubmitted.');
    if(generated.images.length!==1)throw new Error('The image endpoint must return exactly one image for this request.');
    const image=generated.images[0],stem=(input.filename??'generated-image').replace(/\.[a-zA-Z0-9]{1,8}$/,'').replace(/[^\p{L}\p{N}._ -]/gu,'_').replace(/^\.+/,'').slice(0,100)||'generated-image';
    await references?.assertCurrent();effectiveSignal.throwIfAborted();
    const saved=await host._artifactSvcImpl.save_artifact({project_id:host.projectId,root_frame_id:host.rootFrameId,frame_id:host.frameId,filename:stem+'-'+randomUUID().slice(0,8)+'.'+image.extension,content:Buffer.from(image.bytes),content_type:image.mimeType,agent_name:host.agentName,is_user_upload:false});
    const artifact={...saved,file_path:host._fullStore.resolve_storage_path(saved.storage_path),artifact_ref:'{{artifact:'+saved.version_id+'}}'};
    const result={artifacts:[artifact],...references?{reference_images:references.references}:{},...generated.operation?{operation:generated.operation}:{},...generated.referenceImageCount!==undefined?{reference_image_count:generated.referenceImageCount}:{},provider:generated.provider,model:generated.imageModel,source_model:generated.model,billing:generated.billing,route:generated.route,...image.generationId?{generation_id:image.generationId}:{},...generated.responseId?{response_id:generated.responseId}:{},...generated.usage?{usage:generated.usage}:{}};
    this.db.query("UPDATE jobs SET phase='completed',result=?,updatedAt=? WHERE id=?").run(JSON.stringify(result),Date.now(),id);
    if(effectiveSignal.aborted)return {status:'error',error:'Image generation was cancelled after the image had been saved. The saved artifact remains available: '+artifact.artifact_ref,result};
    return {status:'success',result};
   }catch(error){
    this.db.query("UPDATE jobs SET phase=?,updatedAt=? WHERE id=?").run(effectiveSignal.aborted?'cancelled':'failed',Date.now(),id);
    return {status:'error',error:effectiveSignal.aborted?'Image generation was cancelled.':this.registry.safeError(error)};
   }finally{this.jobs--;this.active.delete(id);this.controllers.delete(controller)}
  });this.active.set(id,pending);return pending;
 }
 async close(){if(this.closed)return;this.closed=true;for(const controller of this.controllers)controller.abort();await Promise.allSettled(this.active.values());this.db.close()}
}
