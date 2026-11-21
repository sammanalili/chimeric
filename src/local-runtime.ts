import { mkdirSync, readFileSync, existsSync, appendFileSync, copyFileSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import {fileURLToPath} from 'node:url';
import { Registry, atomicJson } from './registry';
import {installNetworkPolicy} from './network-policy';
import { startBridge, clearBridgeReplay } from './bridge';
import { normalizeNativeMessage } from './protocol';
import {LocalASR} from './voice';
import {makeCatalog} from './catalog';
import {SubscriptionManager,SubscriptionVault} from './subscription';
import {ProviderManager} from './provider-manager';
import {installProviderHttp} from './providers-http';
import {Localization} from './localization';
import {installHelp} from './help';
import {localGate} from './local-gate';
import {isLocalLoginEntry,localLoginDocument} from './local-login';
import {AntigravityModels,ANTIGRAVITY_PROVIDER_ID,ANTIGRAVITY_BASE_URL} from './antigravity-models';
import {AntigravityHttpModels,ANTIGRAVITY_HTTP_PROVIDER_ID,ANTIGRAVITY_HTTP_BASE_URL} from './antigravity-http-models';
import {Provider} from './registry';
import {installAntigravityHttp} from './antigravity-http';
import {ImageGenerationManager} from './image-generation-manager';
import {installImageGenerationHttp} from './image-generation-http';
import {DecisionManager} from './decision-manager';
import {installDecisionHttp} from './decision-http';
import {memoryClassifierInput, memoryClassifierOptions} from './memory-classifier';
import {ClaudeCodeModels,CLAUDE_CODE_PROVIDER_ID,CLAUDE_CODE_BASE_URL} from './claude-code';
import {UsageManager} from './usage-manager';
import {installUsageHttp} from './usage-http';
import {AntigravityConnectionPolicy} from './antigravity-connection-policy';
import {ConfidentialityManager} from './confidentiality-manager';
import {createOutboundTransport} from './outbound-transport';
import {installClass2Http} from './class2-http';
import {connectionBindingDigest} from './session-policy';
import {createNativeSpeechManager} from './speech-manager';
import {installSttHttp} from './stt-http';
import {NativeSecurityRuntime} from './native-security-runtime';
import {installResourceHttp} from './resource-http';
import {NativeExecutionAttestation} from './native-execution-attestation';
import {latchProtectionEvidence} from './startup-protection';

process.env.DO_NOT_TRACK='1';
process.env.OPERON_DISABLE_TELEMETRY='1';
process.env.OPERON_DISABLE_NONESSENTIAL_TRAFFIC='1';
installNetworkPolicy();
const profile = resolve(process.env.SCIENCE_LOCAL_PROFILE ?? 'state');
const dataDirArg = process.argv.find((arg, i) => i > 0 && process.argv[i - 1] === '--data-dir')
  ?? process.argv.find((arg) => arg.startsWith('--data-dir='))?.slice(11);
const controlSock = join(resolve(process.env.SCIENCE_LOCAL_PROFILE ?? dataDirArg ?? 'state'), 'daemon.sock');
const assetManifest=resolve(process.env.SCIENCE_ASSET_MANIFEST ?? join(dirname(resolve(process.argv[1])),'asset-manifest.json'));
const assetInfo=JSON.parse(readFileSync(assetManifest,'utf8'));
const assetsRoot=assetInfo.rootRelative ? resolve(dirname(assetManifest),assetInfo.rootRelative) : assetInfo.root;
const packageResources=resolve(dirname(assetManifest),'..');
const productIcon=readFileSync(join(assetsRoot,'web-dist/favicon.svg'),'utf8');
if(!existsSync(join(assetsRoot,'drizzle/sqlite/meta/_journal.json')))throw new Error('Local runtime assets are incomplete. Run start.py build.');
mkdirSync(profile, { recursive: true, mode: 0o700 });
// Source-mode launches otherwise inherit the editor's checkout, which the
// original compute sandbox correctly cannot read. Provisioning needs a cwd
// already inside its compute dependency root, without expanding any grant.
mkdirSync(join(profile, 'conda'), { recursive: true, mode: 0o700 });
const mamba = join(profile,'conda','bin','micromamba');
if (!existsSync(mamba)) {
  const bundled=join(assetsRoot,'micromamba');
  const installed = resolve(dirname(process.execPath),'..','conda','bin','micromamba');
  const source=existsSync(bundled)?bundled:installed;
  if (existsSync(source)) { mkdirSync(dirname(mamba),{recursive:true,mode:0o700});copyFileSync(source,mamba);chmodSync(mamba,0o700); }
}
process.chdir(join(profile, 'conda'));
const identityPath = join(profile, 'local-identity.json');
const identity = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, 'utf8')) : { org_uuid: randomUUID(), account_uuid: randomUUID(), name: 'Local research workspace' };
if (!existsSync(identityPath)) atomicJson(identityPath, identity);
const authDir = join(profile, 'local-auth'); mkdirSync(authDir, { recursive: true, mode: 0o700 });
atomicJson(join(authDir, 'active-org.json'), { org_uuid: identity.org_uuid });
const executionAttestation=new NativeExecutionAttestation(profile,packageResources);
const evidenceLatch=latchProtectionEvidence(()=>executionAttestation.evidence());
const initialExecutionEvidence=evidenceLatch.initial;
const offlineExecution=initialExecutionEvidence.verified?executionAttestation.offlineExecution():undefined;
const protectionEvidence=evidenceLatch.current;

const registry = Registry.fromFile(process.env.SCIENCE_PROVIDER_CONFIG, profile);
const claudeCode=new ClaudeCodeModels(profile);registry.claudeCode=claudeCode;
registry.config.providers[CLAUDE_CODE_PROVIDER_ID]??=Provider.parse({name:'Anthropic',api:'claude-code',baseUrl:CLAUDE_CODE_BASE_URL});
const antigravity=new AntigravityModels(profile);registry.antigravity=antigravity;
registry.config.providers[ANTIGRAVITY_PROVIDER_ID]??=Provider.parse({name:'Antigravity',api:'antigravity-cli',baseUrl:ANTIGRAVITY_BASE_URL});
let antigravityPolicy:AntigravityConnectionPolicy;
const antigravityHttp=new AntigravityHttpModels(profile,{assertAccess:()=>{if(!antigravityPolicy)throw Error('The Antigravity connection is starting.');antigravityPolicy.assertAvailable('direct')},accessSignal:()=>antigravityPolicy.signal()});registry.antigravityHttp=antigravityHttp;
antigravityPolicy=new AntigravityConnectionPolicy(profile,{direct:antigravityHttp,cli:antigravity});registry.antigravityPolicy=antigravityPolicy;
registry.config.providers[ANTIGRAVITY_HTTP_PROVIDER_ID]??=Provider.parse({name:'Antigravity (Google AI subscription)',api:'antigravity-http',baseUrl:ANTIGRAVITY_HTTP_BASE_URL});
registry.config.providers[ANTIGRAVITY_HTTP_PROVIDER_ID].name='Google Antigravity';
registry.config.providers[ANTIGRAVITY_PROVIDER_ID].name='Google Antigravity (CLI)';
const imageGeneration=new ImageGenerationManager(registry,{changed:()=>connections?.notifyServiceChange()});registry.imageGeneration=imageGeneration;
const localization=new Localization(profile);
let connections:ProviderManager;
let nativeSecurity:NativeSecurityRuntime|undefined;
const requireNativeSecurity=()=>{if(!nativeSecurity)throw new Error('The native security boundary is not ready.');return nativeSecurity};
const subscription=new SubscriptionManager(new SubscriptionVault(authDir),{autoDiscover:true,onChange:()=>connections?.notify(),onModelsChanged:()=>connections?.refreshSubscriptions()});
registry.subscription=subscription;
if (!['url','status','stop','--help','--version','help'].includes(process.argv[2])) await registry.refresh();
const token = randomUUID() + randomUUID();
// This verified single-user native revision uses local-dev as getUser().user_id.
// A provider account_uuid is a separate display/auth identity.
const confidentiality=new ConfidentialityManager(registry,{owner:{userId:'local-dev',organizationId:identity.org_uuid},transport:createOutboundTransport({credential:binding=>registry.getPrivateCredential(binding.id)}),changed:()=>connections?.notifyServiceChange(),protectionEvidence,offlineExecution,nativeBoundary:{
 transition:(context,target,apply)=>requireNativeSecurity().transition(context,target,apply),
 noteExecution:(kind,context)=>requireNativeSecurity().noteExecution(kind,context),
 assertHostContext:owner=>requireNativeSecurity().assertHostContext(owner),
 beginModel:context=>requireNativeSecurity().beginModel(context),
}});
nativeSecurity=new NativeSecurityRuntime({profileDir:profile,authDir,assetsRoot,owner:{userId:'local-dev',organizationId:identity.org_uuid},confidentiality,executionAttestation:initialExecutionEvidence.verified?executionAttestation:undefined,onResourcePolicyChange:()=>connections?.notifyServiceChange()});
const bridge = startBridge(registry, token,0,undefined,confidentiality);
const baseUrl = 'http://127.0.0.1:' + bridge.port;
// Only a loopback session token enters the original daemon. Provider keys stay
// in the Registry closure and are never exported to research subprocesses.
process.env.ANTHROPIC_BASE_URL = baseUrl;
delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
delete process.env.UPSTREAM_API_KEY;
for (const p of Object.values(registry.config.providers)) delete process.env[p.keyEnv];
const roles = new Proxy({} as Record<string,string>,{
  get:(target,key)=>typeof key==='string'&&['small','medium','large'].includes(key)?registry.config.roles[key]??registry.state.model:Reflect.get(target,key),
  ownKeys:()=>['small','medium','large'],
  getOwnPropertyDescriptor:(target,key)=>typeof key==='string'&&['small','medium','large'].includes(key)?({enumerable:true,configurable:true}):Reflect.getOwnPropertyDescriptor(target,key),
});
const voiceConfig = registry.config.voice;
const speech=createNativeSpeechManager(registry,confidentiality,new LocalASR(voiceConfig.python,voiceConfig.runtimeRoot,voiceConfig.model),{changed:()=>connections?.notifyServiceChange()});
const VoiceBridge=speech.VoiceBridge;
let activeSettings: any;
let derivedRoles:Record<string,string>={};
function syncSettings(settings=activeSettings){
  if(!settings)return;
  settings.default_model=registry.state.model;
  settings.llm.kernel_default_model=registry.state.model;
  // Pinning a model or editing credentials must preserve an independently
  // chosen native reviewer. Apply role values only when those roles change.
  if(derivedRoles.small!==roles.small){settings.lineage_extraction_model=roles.small;settings.verification.terminal_sniff_model=roles.small}
  if(derivedRoles.large!==roles.large){settings.llm.kernel_reasoning_model=roles.large;settings.verification.reviewer_model=roles.large}
  derivedRoles={small:roles.small,medium:roles.medium,large:roles.large};
}
connections=new ProviderManager(registry,()=>syncSettings());
const connectionPolicyStamps=()=>new Map(Object.keys(registry.config.providers).map(id=>{const binding=confidentiality.binding(id);return [id,JSON.stringify([binding?connectionBindingDigest(binding):null,registry.config.providers[id].enabled,registry.statuses[id]?.ready])] }));
let policyStamps=connectionPolicyStamps();
connections.subscribe(()=>{const previous=policyStamps,next=connectionPolicyStamps();policyStamps=next;for(const id of new Set([...previous.keys(),...next.keys()]))if(previous.get(id)!==next.get(id))confidentiality.connectionChanged(id)});
const decisions=new DecisionManager(profile,{changed:()=>connections.notifyServiceChange()});
const usage=new UsageManager(registry,{changed:()=>connections.notifyServiceChange()});registry.usage=usage;
claudeCode.onChange(()=>{void connections.refreshSubscriptions().catch(error=>console.error('Claude Code connection refresh:',registry.safeError(error)))});
antigravity.onChange(()=>{void connections.refreshAntigravity().catch(error=>console.error('Antigravity catalog refresh:',registry.safeError(error)))});
antigravityHttp.onChange(()=>{void connections.refreshAntigravity().catch(error=>console.error('Antigravity HTTP catalog refresh:',registry.safeError(error)))});
antigravityPolicy.onChange(()=>{void connections.refreshAntigravity().catch(error=>console.error('Antigravity connection refresh:',registry.safeError(error)))});
if(!['url','status','stop','--help','--version','help'].includes(process.argv[2])){
 void claudeCode.restore();
 void antigravityPolicy.restore().then(async()=>{try{antigravityPolicy.assertAvailable(antigravityPolicy.selectedTransport());if(antigravityPolicy.selectedTransport()==='direct')await antigravityHttp.restore();else await antigravity.restore()}catch{/* Prerequisite status explains why this optional connection remains unavailable. */}});
}
if(!['url','status','stop','--help','--version','help'].includes(process.argv[2])&&subscription.status().connected)void subscription.discoverModels(false).catch(()=>undefined);
function catalog(locale=localization.resolve()) { return makeCatalog(registry,locale); }

const local = {
  ...nativeSecurity.callbacks(),
  withFrame(frameId:any,callback:()=>any){return typeof frameId==='string'&&frameId?confidentiality.scope.withFrame(frameId,callback):callback()},
  nativeMetadata(input:any,result:any){return confidentiality.scope.nativeMetadata(input,result)},
  requestOptions(input:any,settings:any,result:any){return confidentiality.scope.requestOptions(input,settings,result)},
  scopeFetch(fetcher:typeof fetch){return confidentiality.scope.scopeFetch(fetcher,baseUrl)},
  guardNativeExecution(kind:string,owner:any,details:any){return confidentiality.guardNativeExecution(kind,owner,details)},
  requestExternalAccess(host:any,call:any,args:any,signal?:AbortSignal){return confidentiality.executeOutgoing(host,call,args,signal)},
  memoryClassifierInput,
  memoryClassifierOptions(options:any){return memoryClassifierOptions(options,id=>registry.resolve(id))},
  nativeTools(tools:any[],owner:any){
    const outgoing=confidentiality.outgoingTool();
    if(!['REVIEWER','AUDITOR','BOOKMARKER'].includes(String(owner.agentName).toUpperCase())&&!tools.some(tool=>tool.name===outgoing.name))tools=[...tools,outgoing];
    const image=imageGeneration.toolDefinition();
    if(!image||['REVIEWER','AUDITOR','BOOKMARKER'].includes(String(owner.agentName).toUpperCase())||tools.some(tool=>tool.name===image.name))return tools;
    return [...tools,image];
  },
  async generateImage(host:any,call:any,args:any,signal?:AbortSignal){await confidentiality.guardNativeExecution('image-generation',host,{});return imageGeneration.execute(host,call,args,signal)},
  identity, authDir, token, baseUrl, roles, catalog, normalizeNativeMessage, VoiceBridge, assetsRoot,
  assetArchive:join(dirname(assetManifest),assetInfo.archive??'assets.tar-j2zctwzf.gz'),
  modelInfo(id: string) { try { return registry.resolve(id); } catch { return null; } },
  credential: { api_key: token, auth_token: null, source: 'api_key', org_uuid: identity.org_uuid, account_uuid: identity.account_uuid, subscription_tier: null, rate_limit_tier: null },
  configurePaths(paths:any) {
    paths.auth_dir = authDir;
    paths.conda_home = join(profile,'conda');
    paths.conda_envs_path = join(profile,'conda','envs');
    return paths;
  },
  configure(settings: any) {
    activeSettings = settings;
    settings.disable_telemetry=true;
    settings.update={...settings.update,auto_update:false};
    settings.max_tokens = 16_384;
    syncSettings(settings);
    return settings;
  },
  select(input: any,locale=localization.resolve()) {
    registry.select(input.model ?? registry.state.model, input.effort);
    syncSettings();connections.publish();
    return catalog(locale);
  },
  installSubscriptionHttp(app:any){
    app.addHook('preHandler',async(request:any,reply:any)=>{if(request.url?.startsWith('/api/local/confidentiality')&&app.getUser(request)?.user_id!=='local-dev')return reply.code(403).send({detail:'This local confidentiality service requires the native workspace owner.'})});
    installClass2Http(app,confidentiality,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    installResourceHttp(app,requireNativeSecurity().resourceViews,{ownerUserId:'local-dev',moduleVersion:assetInfo.moduleVersion??'?science_local=chatgpt-v1'});
    installSttHttp(app,speech.settings,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    installProviderHttp(app,connections,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    installAntigravityHttp(app,antigravity,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    installImageGenerationHttp(app,imageGeneration,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    installDecisionHttp(app,decisions,assetInfo.moduleVersion??'?science_local=chatgpt-v1');
    localization.install(app);
    installHelp(app,localization);
    installUsageHttp(app,usage,assetInfo.moduleVersion??'?science_local=chatgpt-v1',{effectiveModel:async frameId=>{const snapshot=await confidentiality.snapshot({frameId});return 'mode' in snapshot&&snapshot.mode==='class2'?snapshot.main:undefined}});
    app.get('/api/local/claude-code',async(_request:any,reply:any)=>reply.header('cache-control','no-store').send(claudeCode.status()));
    app.post('/api/local/claude-code',async(request:any,reply:any)=>{
      reply.header('cache-control','no-store');
      try{return await claudeCode.action(request.body)}catch(error:any){return reply.code(error?.status??400).send({detail:'Could not change the official Claude Code connection. Check the installed client and try again.'})}
    });
    app.get('/api/local/antigravity-http',async(_request:any,reply:any)=>reply.header('cache-control','no-store').send(antigravityPolicy.status()));
    app.post('/api/local/antigravity-http',async(request:any,reply:any)=>{
      try{
        const body=request.body??{};
        if(body.action==='configure')return await antigravityPolicy.configure({enabled:body.enabled,transport:body.transport});
        if(body.action==='check-client')return await antigravityPolicy.checkClient();
        if(body.action==='signin')return await antigravityPolicy.signin(antigravityPolicy.selectedTransport()==='cli'?undefined:{method:body.method==='import'?'import':'browser'});
        if(body.action==='refresh')return await antigravityPolicy.refresh();
        if(body.action==='cancel')return await antigravityPolicy.cancel();
        else if(body.action==='disconnect')return await antigravityPolicy.disconnect();
        else if(body.action!=='signin'&&body.action!=='refresh')return reply.code(400).send({detail:'Unknown Antigravity subscription action.'});
        return antigravityPolicy.status();
      }catch(error:any){return reply.code(error?.status??400).send({detail:error instanceof Error?antigravityHttp.auth.redact(error.message):'Antigravity subscription operation failed.'});}
    });
    app.get('/api/local/chatgpt',async()=>subscription.status());
    app.post('/api/local/chatgpt',async(request:any,reply:any)=>{
      try{
        const body=request.body??{};
        if(body.action==='start')return await subscription.start(body.method??'browser');
        if(body.action==='discover')return await subscription.discoverModels();
        if(body.action==='check'){const preferred=[...registry.models.values()].find(m=>m.qualifiedId===registry.state.model&&m.api==='openai-codex-responses'&&m.subscriptionAvailable!==false)??[...registry.models.values()].find(m=>m.api==='openai-codex-responses'&&m.subscriptionAvailable!==false);const model=registry.resolve(body.model??preferred?.qualifiedId??'openai-codex::gpt-6.1-sol');if(model.api!=='openai-codex-responses'||model.subscriptionAvailable===false)return reply.code(400).send({detail:'Choose an available ChatGPT subscription model.'});return await subscription.check(model);}
        if(body.action==='cancel')subscription.cancel();
        else if(body.action==='disconnect')subscription.disconnect();
        else return reply.code(400).send({detail:'Unknown ChatGPT connection action.'});
        return subscription.status();
      }catch(e:any){return reply.code(400).send({detail:e instanceof Error?subscription.redact(e.message):'ChatGPT connection failed.'});}
    });
    app.get('/api/local/chatgpt/component.js',async(_request:any,reply:any)=>{
      const component=readFileSync(new URL('./chatgpt-credentials.js',import.meta.url),'utf8')
        .replaceAll('?science_local=chatgpt-v1',assetInfo.moduleVersion??'?science_local=chatgpt-v1');
      return reply.type('text/javascript; charset=utf-8').header('cache-control','no-store').send(component);
    });
    app.addHook('onClose',async()=>{speech.close();nativeSecurity?.close();confidentiality.close();await antigravityPolicy.close();await Promise.all([subscription.close(),antigravityHttp.close(),claudeCode.close()]);});
  },
  installHttp(app: any) {
    app.addHook('preHandler',async(request:any,reply:any)=>{
      if(request.routeOptions?.url==='/api/voice/stream'&&request.query?.frameId!==undefined&&typeof request.query.frameId!=='string')return reply.code(400).send({detail:'Choose a valid research chat before recording.'});
      if(request.routeOptions?.url==='/api/voice/stream'&&confidentiality.policy.snapshot().sessions.some(session=>session.mode==='class2')&&!(typeof request.query?.frameId==='string'&&request.query.frameId))return reply.code(403).send({detail:'This microphone connection has no verified chat scope. Open a saved research chat before recording.'});
    });
    app.addHook('onRoute', (route: any) => {
      if (route.url === '/api/auth/status') route.handler = async () => ({ authenticated: true, provider: 'local', account_uuid: identity.account_uuid, org_uuid: identity.org_uuid, reauth_required: false, oauth_stale: false, local: true, provider_status: registry.statuses });
      else if (['/api/auth/login', '/api/auth/logout'].includes(route.url)) route.handler = async () => ({ authenticated: true, provider: 'local', local: true });
      else if (route.url === '/api/models') route.handler = async (request:any) => catalog(localization.resolve(request.headers?.['accept-language']));
      else if (route.url === '/api/models/selection') route.handler = async (request: any, reply: any) => {
        try {
          return local.select(request.body ?? {}, localization.resolve(request.headers?.['accept-language']));
        } catch (err: any) {
          return reply.code(400).send({ detail: err instanceof Error ? err.message : 'Invalid model selection.' });
        }
      };
      else if (['/api/usage','/api/usage/credits-balance','/api/usage/extra-usage'].includes(route.url)) route.handler = async () => ({ok:false,reason:'not_applicable',message:'Usage and billing limits are managed by your selected model provider. Local token counts are available in session details.'});
      else if (route.url === '/api/feedback/available') route.handler = async () => ({safety_available:true});
      else if (route.url === '/api/feedback/safety') route.handler = async (request:any,reply:any) => {
        const report = request.body ?? {};
        if (typeof report.root_frame_id !== 'string' || !report.root_frame_id.trim()) return reply.code(400).send({detail:'root_frame_id is required'});
        const id = randomUUID();
        appendFileSync(join(profile,'local-feedback.jsonl'),JSON.stringify({id,time:new Date().toISOString(),root_frame_id:report.root_frame_id,model:report.model,reason:report.reason})+'\n',{mode:0o600});
        return reply.code(201).send({id,status:'saved_locally',sent:false});
      };
      if(route.url==='/api/request'){
        const nativeHandler=route.handler;
        route.handler=async function(this:any,request:any,reply:any){
          if(app.getUser(request)?.user_id!=='local-dev')return reply.code(403).send({detail:'The native research owner could not be verified.'});
          const run=()=>nativeHandler.call(this,request,reply),body=request.body;
          const frameId=typeof body?.frame_id==='string'&&body.frame_id?body.frame_id:typeof body?.root_frame_id==='string'&&body.root_frame_id?body.root_frame_id:undefined;
          try{return frameId?await confidentiality.scope.withFrame(frameId,run):await confidentiality.scope.withNewStandardRequest(run)}
          catch(error:any){return reply.code(error?.status??400).send({detail:registry.safeError(error)})}
        };
      }
    });
    app.addHook('onSend', async (_request: any, _reply: any, payload: any) => {
      // ACP transcripts and server-provided labels retain their exact content.
      if(_request.url?.startsWith('/api/local/antigravity'))return payload;
      if (typeof payload === 'string') {
        if (_request.url?.startsWith('/api/agents') || payload.includes("let's set Claude up")) {
          payload = payload.replaceAll(
            "Hi, let's set Claude up for your science.\n\nClaude works best when it understands what you research and how you research it.",
            "Hi, let's set Chimeric up for your science.\n\nChimeric works best when it understands what you research and how you research it."
          ).replaceAll("set Claude up", "set Chimeric up").replaceAll("Claude works best", "Chimeric works best");
        }
        const localLogin=isLocalLoginEntry(payload,_request.url,_request.method);
        if(localLogin){
          let nonce:unknown;
          try{
            const res=await fetch('http://localhost/nonce',{method:'POST',unix:controlSock,signal:AbortSignal.timeout(3000)} as any);
            if(res.ok)nonce=((await res.json()) as {nonce?:unknown}).nonce;
          }catch{console.warn('[chimeric] local session entry is temporarily unavailable; use the local launcher.');}
          _reply.code(200).header('cache-control','no-store');
          payload=localLoginDocument(_request.url,nonce,localization.resolve(_request.headers?.['accept-language']),productIcon);
        }
        if (
          !localLogin &&
          !payload.includes('<form') &&
          /<title>(?:Sign in|Open local workspace|Login link (?:expired|already used))[^<]*<\/title>/i.test(payload) &&
          _request.method === 'GET' &&
          (!_request.url?.startsWith('/api/') || _request.url?.startsWith('/api/local/help')) &&
          !_request.url?.startsWith('/assets/') &&
          existsSync(controlSock)
        ) {
          try {
            const res = await fetch('http://localhost/nonce', { method: 'POST', unix: controlSock } as any);
            if (res.ok) {
              const data = (await res.json()) as { nonce?: string };
              if (typeof data?.nonce === 'string' && /^[a-f0-9]{16,}$/i.test(data.nonce)) {
                const rawUrl = typeof _request.url === 'string' && _request.url.startsWith('/') && !_request.url.startsWith('//') ? _request.url : '/';
                const parsedUrl = new URL(rawUrl, 'http://localhost');
                parsedUrl.searchParams.delete('nonce');
                const cleanUrl = parsedUrl.pathname + parsedUrl.search;
                const safeDest = cleanUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                _reply.code(200).header('cache-control', 'no-store');
                payload = payload.replace(/<title>Login link (?:expired|already used)[^<]*<\/title>/i, '<title>Sign in — Chimeric</title>');
                payload += `<form method="post" action="/api/auth/nonce"><input type="hidden" name="nonce" value="${data.nonce}"><input type="hidden" name="dest" value="${safeDest}"><button type="submit">Sign in</button></form>`;
              }
            }
          } catch {}
        }
        const gated = localGate(payload, localization.resolve(_request.headers?.['accept-language']), productIcon);
        if (gated.includes('<form') && gated.includes('api/auth/nonce') && !gated.includes('f.requestSubmit()')) {
          return gated.replace(
            '</main>',
            `<script>(() => { const f = document.querySelector('form[action$="api/auth/nonce"]'); if (f && !f.dataset.submitted) { f.dataset.submitted = '1'; f.requestSubmit(); } })()</script></main>`,
          );
        }
        return gated;
      }
      return payload;
    });
    app.addHook('onResponse',async(request:any,reply:any)=>{
      if (request.method === 'DELETE' && reply.statusCode < 300 && ['/api/frames/:id','/api/projects/:pid'].includes(request.routeOptions?.url)) clearBridgeReplay(bridge);
    });
    app.get('/api/local/providers', async () => registry.snapshot());
  },
};
(globalThis as any).__scienceLocal = local;
console.info('[chimeric] loaded ' + registry.models.size + ' models with local account services');
