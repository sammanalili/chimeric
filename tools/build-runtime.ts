import { parse } from '@babel/parser';
import traverse0 from '@babel/traverse';
import generate0 from '@babel/generator';
import * as t from '@babel/types';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import {nativeRevision} from './native-revisions';
import {patchDaemonIdentity} from './native-process';
import {memoryClassifierRequestEdits} from './native-memory';
import {nativeRequestOptionsEdit} from './native-session-context';
import {nativeScopeEdits} from './native-scope-patches';
import {nativeExecutionPolicyEdits} from './native-execution-policy';
import {nativeVoiceServerEdits} from './native-voice-context';
import {nativeKernelPolicyEdits} from './native-kernel-policy';
import {nativeRuntimeServicesEdits} from './native-runtime-services';
import {nativeProtectedStorageEdits} from './native-protected-storage';
import {nativeResourcePolicyEdits} from './native-resource-policy';
import {brandNativeUserText} from './product-branding';
import {CLASS2_REQUIRED_BOUNDARIES} from '../src/native-execution-attestation';
const traverse = (traverse0 as any).default ?? traverse0;
const generate = (generate0 as any).default ?? generate0;
const sourceDir = resolve(process.argv[2] ?? '../../work/runtime-recovery/original');
const out = resolve(process.argv[3] ?? '../../work/runtime-recovery/local'); mkdirSync(out, { recursive: true });
const original = readFileSync(join(sourceDir, 'claude-science'), 'utf8');
const sourceHash = createHash('sha256').update(original).digest('hex');
const revision = nativeRevision(sourceHash);
const symbol = (name:string) => revision.symbols[name] ?? name;
const reverseSymbols = new Map(Object.entries(revision.symbols).map(([a,b])=>[b,a]));
const logicalName = (name:string|undefined) => revision.platform==='linux-x64' ? reverseSymbols.get(name??'') : name;
const manifest = JSON.parse(readFileSync(join(sourceDir, 'recovery-manifest.json'), 'utf8'));
const archive = manifest.files.find((file:any)=>/^assets\.tar-[\w]+\.gz$/.test(file.path))?.path;
if (!archive) throw new Error('Recovered runtime does not contain one supported asset archive');
if(createHash('sha256').update(readFileSync(join(sourceDir,archive))).digest('hex')!==revision.archiveSha256)throw new Error('Native asset archive integrity check failed');
const workerHashes=Bun.spawnSync(['python3',resolve('tools/brand_skill_resources.py'),join(sourceDir,archive)],{stdout:'pipe',stderr:'pipe'});
if(workerHashes.exitCode!==0)throw new Error('Could not produce the branded Modal helper manifest');
const modalWorker=JSON.parse(workerHashes.stdout.toString());
let workerHashUpdates=0,productLogPrefixes=0;
const ast = parse(original, { sourceType: 'unambiguous' });
const localExpr = (expression: string) => parse(expression, { sourceType: 'module' }).program.body[0] as any;
const replacements: { start: number, end: number, text: string, label: string }[] = [];
const replace = (node: any, text: string, label: string) => replacements.push({ start: node.start, end: node.end, text, label });
const seen = new Set<string>();
for(const edit of [
  ...nativeScopeEdits(ast,original),...nativeExecutionPolicyEdits(ast,original),...nativeVoiceServerEdits(ast,original),
  ...nativeKernelPolicyEdits(ast,original),...nativeRuntimeServicesEdits(ast,original),
  ...nativeProtectedStorageEdits(ast,original,{policy:symbol('Eei'),render:symbol('zjn')}),...nativeResourcePolicyEdits(ast,original),
]){if(seen.has(edit.label))throw new Error('Duplicate native boundary '+edit.label);replacements.push(edit);seen.add(edit.label)}
let brandConstants=0;
traverse(ast, {
  FunctionDeclaration(path: any) {
    const node = path.node; const name = logicalName(node.id?.name);
    if(original.slice(node.body.start,node.body.end).includes('[memory] PI classifier truncated')){
      if(seen.has('memory-classifier-request'))throw new Error('Ambiguous native memory classifier boundary');
      replacements.push(...memoryClassifierRequestEdits(node,original));seen.add('memory-classifier-request');
    }
    if(name==='Y6'){replace(node.body,'{return true}','telemetry-hard-opt-out');seen.add('telemetry-hard-opt-out');path.skip();return}
    if(name==='g3t'){replace(node.body,'{return {logEvent(){},logError(){},logErrorRecord(){},isEnabled(){return false},setEnabled(){},async shutdown(){}}}','telemetry-noop-provider');seen.add('telemetry-noop-provider');path.skip();return}
    if(name==='Vrr'){replace(node.body,'{return {dsn:"",isCi:!!process.env.CI,isTelemetryDisabled:()=>true,hasAuthSession:()=>false}}','telemetry-no-crash-transport');seen.add('telemetry-no-crash-transport');path.skip();return}
    if(name==='Q_s'){replace(node.body,patchDaemonIdentity(original.slice(node.body.start,node.body.end)),'native-daemon-identity');seen.add('native-daemon-identity');path.skip();return}
    if (name === 'PP') { replace(node.body, `{return ${revision.factory}({apiKey:globalThis.__scienceLocal.token,authToken:null,baseURL:globalThis.__scienceLocal.baseUrl,maxRetries:0,timeout:${revision.timeout},fetch:${revision.fetch}})}`, name); seen.add(name); }
    if (name === 'cIt') { replace(node.body, '{return globalThis.__scienceLocal.catalog()}', name); seen.add(name); }
    if (name === 'Dp') { replace(node.body, '{return globalThis.__scienceLocal.assetsRoot}', 'local-asset-root'); seen.add('local-asset-root'); }
    if (name === 'Ugs') { replace(node.body, '{return globalThis.__scienceLocal.select(t)}', name); seen.add(name); }
    if (name === 'ERe') { replace(node.body, '{return {signedIn:true,tier:null,orgUuid:globalThis.__scienceLocal.identity.org_uuid}}', name); seen.add(name); }
    if (name === '$G') { replace(node.body, '{return {org_uuid:globalThis.__scienceLocal.identity.org_uuid}}', name); seen.add(name); }
    if (name === 'Fma') { replace(node.body, `{return new ${revision.classifier}({apiKey:globalThis.__scienceLocal.token,authToken:null,baseURL:globalThis.__scienceLocal.baseUrl,fetch:${revision.classifierFetch}(),maxRetries:0})}`, name); seen.add(name); }
    if (name === 'hre') { replace(node.body,'{const m=globalThis.__scienceLocal.modelInfo(e);if(m)return {maxInputTokens:m.contextWindow,maxOutputTokens:m.maxTokens,effortSupported:m.reasoning && m.compat?.supportsReasoningEffort!==false};return undefined}',name);seen.add(name); }
    if (name === 'BFr') { replace(node.body,'{return false}',name);seen.add(name); }
    if (name === 'oyt') { replace(node.body, `{const packages={pubmed:"mcp_pubmed","clinical-trials":"mcp_clinical_trials",chembl:"mcp_chembl",biorxiv:"mcp_biorxiv"};if(!packages[e.name])throw Error("Unmapped hosted science connector "+e.name);return ${symbol('kb')}({...e,pkg:packages[e.name]})}`, name); seen.add(name); }
    if (name === 'Yat') { replace(node.body, '{return {inputPerMTok:0,outputPerMTok:0,pricingSource:"unavailable"}}', name); seen.add(name); }
    if (name === 'qR' || name === 'd9') {
      const property = name === 'qR' ? 'maxTokens' : 'contextWindow';
      replacements.push({start:node.body.start!+1,end:node.body.start!+1,text:'if(e){const m=globalThis.__scienceLocal.modelInfo(e);if(m)return m.'+property+';}',label:name}); seen.add(name);
    }
    if (name === 'Ahe') {
      const paths = node.body.body.find((s:any)=>t.isVariableDeclaration(s) && s.declarations.some((d:any)=>t.isIdentifier(d.id,{name:'o'})) && s.declarations.some((d:any)=>t.isIdentifier(d.id,{name:'s'})));
      if (!paths) throw new Error('Ahe path-validation anchor changed');
      replacements.push({start:paths.end!,end:paths.end!,text:';globalThis.__scienceLocal.configurePaths(o);s=o.conda_envs_path;',label:'paths-before-validation'});
      const last = node.body.body.at(-1); if (!t.isReturnStatement(last) || !t.isIdentifier(last.argument, { name: 'c' })) throw new Error('Ahe return anchor changed');
      replace(last, 'return globalThis.__scienceLocal.configure(c);', name); seen.add(name);
    }
    if (name === 'pJc') {
      const first = node.body.body[0]; if (!t.isVariableDeclaration(first) || first.declarations[0]?.id.name !== 'n') throw new Error('pJc Fastify anchor changed');
      replacements.push({ start: first.end!, end: first.end!, text: ';globalThis.__scienceLocal.installHttp(n);', label: name }); seen.add(name);
    }
  },
  CallExpression(path:any){
    const n=path.node;
    if(t.isMemberExpression(n.callee)&&t.isIdentifier(n.callee.object,{name:'n'})&&t.isIdentifier(n.callee.property,{name:'addHook'})&&t.isStringLiteral(n.arguments[0],{value:'preHandler'})&&t.isIdentifier(n.arguments[1],{name:symbol('Qxs')})){
      replacements.push({start:n.end!,end:n.end!,text:',globalThis.__scienceLocal.installSubscriptionHttp(n)',label:'local-subscription-routes'});seen.add('local-subscription-routes');
    }
  },
  ClassDeclaration(path: any) {
    if (path.node.id?.name === symbol('dir')) {
      replace(path.node,`class ${symbol('dir')} extends globalThis.__scienceLocal.VoiceBridge {}`,'local-dictation');seen.add('local-dictation');
    }
    if (path.node.id?.name === symbol('Oqn')) {
      replace(path.node, `class ${symbol('Oqn')} {constructor(){} setReadDb(){} async resolve(){return globalThis.__scienceLocal.credential} onBearerRejected(){} }`, 'Oqn'); seen.add('Oqn');
    }
  },
  ClassMethod(path: any) {
    if(t.isIdentifier(path.node.key,{name:'_requestOptions'})&&path.findParent((p:any)=>p.isClassDeclaration())?.node.id?.name===symbol('pu')){
      replacements.push(nativeRequestOptionsEdit(path.node,original,revision.timeout));seen.add('native-session-request-options');
    }
    if(t.isIdentifier(path.node.key,{name:'_executeToolCallsInner'})){
      if(seen.has('native-image-plan-gate'))throw new Error('Ambiguous native image plan gate boundary');
      const thisMember=(node:any,name:string)=>t.isMemberExpression(node)&&!node.computed&&t.isThisExpression(node.object)&&t.isIdentifier(node.property,{name});
      const guards:any[]=[];
      path.traverse({IfStatement(candidate:any){
        const node=candidate.node,test=node.test;
        if(!t.isLogicalExpression(test,{operator:'&&'})||!t.isCallExpression(test.left)||!t.isCallExpression(test.right))return;
        const membership=test.left,policy=test.right,tool=membership.arguments[0];
        if(!t.isMemberExpression(membership.callee)||membership.callee.computed||!t.isIdentifier(membership.callee.object)||!t.isIdentifier(membership.callee.property,{name:'has'})||membership.arguments.length!==1||!t.isMemberExpression(tool)||tool.computed||!t.isIdentifier(tool.object)||!t.isIdentifier(tool.property,{name:'name'}))return;
        if(!t.isIdentifier(policy.callee)||policy.arguments.length!==2||!thisMember(policy.arguments[0],'state')||!t.isCallExpression(policy.arguments[1])||!thisMember(policy.arguments[1].callee,'_canPlan')||policy.arguments[1].arguments.length!==0)return;
        if(!t.isBlockStatement(node.consequent)||node.consequent.body.length!==2||!t.isExpressionStatement(node.consequent.body[0])||!t.isAwaitExpression(node.consequent.body[0].expression)||!t.isContinueStatement(node.consequent.body[1]))return;
        const result=node.consequent.body[0].expression.argument;
        if(!t.isCallExpression(result)||!thisMember(result.callee,'_appendToolResult')||result.arguments.length!==4||!t.isMemberExpression(result.arguments[1])||result.arguments[1].computed||!t.isIdentifier(result.arguments[1].object,{name:tool.object.name})||!t.isIdentifier(result.arguments[1].property,{name:'id'}))return;
        guards.push({membership,tool});
      }});
      if(guards.length!==1)throw new Error('Missing or ambiguous native plan-gated tool boundary');
      const {membership,tool}=guards[0];
      const condition=t.logicalExpression('||',t.cloneNode(membership),t.binaryExpression('===',t.cloneNode(tool),t.stringLiteral('generate_image')));
      replace(membership,'('+generate(condition,{compact:true}).code+')','native-image-plan-gate');seen.add('native-image-plan-gate');
    }
    if(t.isIdentifier(path.node.key,{name:'getTools'})&&original.slice(path.node.body.start,path.node.body.end).includes('this._flattenedMcpDispatch')){
      if(seen.has('native-image-tool-advertisement'))throw new Error('Ambiguous native image tool advertisement boundary');
      const declaration=path.node.body.body.find((node:any)=>t.isVariableDeclaration(node)&&node.declarations.some((d:any)=>t.isMemberExpression(d.init)&&t.isThisExpression(d.init.object)&&t.isIdentifier(d.init.property,{name:'_tools'})));
      const value=declaration?.declarations.find((d:any)=>t.isMemberExpression(d.init)&&t.isThisExpression(d.init.object)&&t.isIdentifier(d.init.property,{name:'_tools'}));
      if(!value)throw new Error('Native tool-list boundary changed');
      replace(value.init,'globalThis.__scienceLocal.nativeTools(this._tools,this)','native-image-tool-advertisement');seen.add('native-image-tool-advertisement');
    }
    if(t.isIdentifier(path.node.key,{name:'_pruneUnavailableTools'})){
      if(seen.has('native-image-tool-history'))throw new Error('Ambiguous native image tool history boundary');
      const declaration=path.node.body.body.find((node:any)=>t.isVariableDeclaration(node)&&node.declarations.some((d:any)=>t.isCallExpression(d.init)&&original.slice(d.init.start,d.init.end).includes('.map(')));
      const value=declaration?.declarations.find((d:any)=>t.isCallExpression(d.init)&&original.slice(d.init.start,d.init.end).includes('.map('));
      if(!value||!t.isIdentifier(value.id)||!original.slice(path.node.body.start,path.node.body.end).includes('tool_use'))throw new Error('Native tool-history pruning boundary changed');
      replacements.push({start:declaration.end!,end:declaration.end!,text:`${value.id.name}.add("generate_image");${value.id.name}.add("request_external_access");`,label:'native-image-tool-history'});seen.add('native-image-tool-history');
    }
    if(t.isIdentifier(path.node.key,{name:'_invokeTool'})){
      const n=path.node,params=n.params;
      const body=original.slice(n.body.start,n.body.end);
      if(params.length!==3||!params.every((p:any)=>t.isIdentifier(p))||!body.includes('this.registry.invokeTool(')||!body.includes('this.frameId'))throw new Error('Native image-generation dispatch boundary changed');
      if(seen.has('native-image-generation-dispatch'))throw new Error('Ambiguous native image-generation dispatch boundary');
      replacements.push({start:n.body.start!+1,end:n.body.start!+1,text:`if(${params[0].name}.name==="request_external_access")return globalThis.__scienceLocal.requestExternalAccess(this,${params[0].name},${params[1].name},${params[2].name}??this._signal??undefined);if(${params[0].name}.name==="generate_image")return globalThis.__scienceLocal.generateImage(this,${params[0].name},${params[1].name},${params[2].name}??this._signal??undefined);`,label:'native-image-generation-dispatch'});seen.add('native-image-generation-dispatch');
    }
    if (path.node.key?.name === '_toRaw' && path.findParent((p:any)=>p.isClassDeclaration())?.node.id?.name === symbol('pu')) {
      replace(path.node.body,'{return globalThis.__scienceLocal.normalizeNativeMessage(e)}','native-message-output');
      seen.add('native-message-output');
    }
    if (path.node.key?.name === '_withEnvPipLock') {
      path.traverse({ObjectExpression(p: any) {
        if (p.node.properties.length === 1 && t.isObjectProperty(p.node.properties[0]) && t.isIdentifier(p.node.properties[0].key, {name:'signal'})) {
          replace(p.node, '{signal:r,cwd:t}', 'pip-working-directory');
        }
      }});
    }
  },
  VariableDeclarator(path: any) {
    if(t.isStringLiteral(path.node.init,{value:'claude-science'})&&path.parentPath.isVariableDeclaration()&&path.parentPath.node.declarations.some((entry:any)=>t.isStringLiteral(entry.init,{value:'operon-modal'}))){
      replace(path.node.init,'"chimeric"','compute-app-brand');seen.add('compute-app-brand');
    }
    if(t.isIdentifier(path.node.id,{name:revision.useIntentDefault})){
      if(!t.isStringLiteral(path.node.init,{value:'commercial'}))throw new Error('Use-intent default boundary changed');
      replace(path.node.init,'"noncommercial"','noncommercial-use-default');seen.add('noncommercial-use-default');
    }
    if(t.isIdentifier(path.node.id)&&revision.brandConstants.includes(path.node.id.name)){
      if(!t.isStringLiteral(path.node.init,{value:'Claude Science'}))throw new Error('Native product-name boundary changed');
      replace(path.node.init,JSON.stringify('Chimeric'),'product-brand');brandConstants++;
    }
    if (t.isIdentifier(path.node.id, { name: symbol('AP') }) && t.isObjectExpression(path.node.init)) {
      replace(path.node.init, '{anthropic:globalThis.__scienceLocal.roles}', 'AP'); seen.add('AP');
    }
  },
  AssignmentExpression(path: any) {
    if (t.isIdentifier(path.node.left,{name:symbol('uR')}) && t.isArrayExpression(path.node.right)) {
      replace(path.node.right,'["off","minimal","low","medium","high","xhigh","max"]','provider-effort-levels');seen.add('provider-effort-levels');
    }
    if (t.isIdentifier(path.node.left, { name: symbol('AP') }) && t.isObjectExpression(path.node.right)) {
      replace(path.node.right, '{anthropic:globalThis.__scienceLocal.roles}', 'AP'); seen.add('AP');
    }
  },
  StringLiteral(path: any) {
    if(path.node.value===modalWorker.beforeSha256&&path.parentPath.isObjectProperty()&&(path.parentPath.node.key.name??path.parentPath.node.key.value)==='providerPy'){
      replace(path.node,JSON.stringify(modalWorker.afterSha256),'modal-provider-integrity');seen.add('modal-provider-integrity');workerHashUpdates++;
    }
    if(path.node.value.includes('[claude-science]')){replace(path.node,JSON.stringify(path.node.value.replaceAll('[claude-science]','[chimeric]').replaceAll('Claude Science','Chimeric').replaceAll('Anthropic bundled skills','Bundled skills')),'product-log-prefix');productLogPrefixes++;return}
    const brandedUserText=brandNativeUserText(path.node.value);
    if(brandedUserText!==path.node.value){replace(path.node,JSON.stringify(brandedUserText),'product-user-copy');return}
    if(path.node.value.includes('Primary use of Claude Science')){replace(path.node,JSON.stringify(path.node.value.replaceAll('Primary use of Claude Science','Primary use of Chimeric')),'product-copy');return}
    if(path.node.value.includes('claude-science sandbox approve')){replace(path.node,JSON.stringify(path.node.value.replaceAll('claude-science sandbox approve','chimeric sandbox approve')),'product-copy');return}
    if(path.node.value.includes('commercial use (the default)'))replace(path.node,JSON.stringify(path.node.value.replaceAll('commercial use (the default)','commercial use')),'use-intent-notice-copy');
    if (path.node.value === '/$bunfs/root/'+archive) replace(path.node, 'globalThis.__scienceLocal.assetArchive', 'assets');
    if (path.node.value === 'anthropic_hosted') replace(path.node, '"local"', 'connector-hosting');
    if (/^https:\/\/(?:pubmed\.mcp|hcls\.mcp)\.claude\.com\//.test(path.node.value)) replace(path.node, 'null', 'connector-url');
    if(path.node.value==='claude-science'&&path.parentPath.isReturnStatement())replace(path.node,'"chimeric"','cli-name');
    if((path.node.value.includes('Claude Science')||path.node.value.includes('Anthropic bundled skills'))&&!replacements.some(r=>r.start<=path.node.start&&r.end>=path.node.end)&&!revision.brandConstants.includes(path.parentPath.node.id?.name??'')&&!path.parentPath.isBinaryExpression({operator:'==='})&&!path.parentPath.isBinaryExpression({operator:'=='})){
      if(!/copyright|©/.test(path.node.value))replace(path.node,JSON.stringify(path.node.value.replaceAll('Claude Science','Chimeric').replaceAll('Anthropic bundled skills','Bundled skills')),'product-copy');
    }
    if (path.node.value.includes("let's set Claude up") || path.node.value.includes("set Claude up")) {
      replace(path.node, JSON.stringify(path.node.value.replaceAll("let's set Claude up", "let's set Chimeric up").replaceAll("Claude works best", "Chimeric works best")), 'onboarding-greeting');
    }
  },
  TemplateElement(path:any){
    const value=path.node.value.raw;
    if(value.includes('[claude-science]')||value.includes('reinstall or update Claude Science')){
      replace(path.node,value.replaceAll('[claude-science]','[chimeric]').replaceAll('Claude Science','Chimeric').replaceAll('Anthropic bundled skills','Bundled skills'),'product-log-prefix');if(value.includes('[claude-science]'))productLogPrefixes++;return
    }
    const brandedUserText=brandNativeUserText(value);
    if(brandedUserText!==value){replace(path.node,brandedUserText,'product-user-template');return}
    if(value.includes('claude-science sandbox approve')){replace(path.node,value.replaceAll('claude-science sandbox approve','chimeric sandbox approve'),'product-template');return}
    if(value.includes('commercial use (the default)')){replace(path.node,value.replaceAll('commercial use (the default)','commercial use'),'use-intent-notice-copy');return}
    if((value.includes('Claude Science')||value.includes('Anthropic bundled skills'))&&!replacements.some(r=>r.start<=path.node.start&&r.end>=path.node.end)&&!/copyright|©/i.test(value))replace(path.node,value.replaceAll('Claude Science','Chimeric').replaceAll('Anthropic bundled skills','Bundled skills'),'product-template');
  },
});
if(productLogPrefixes===0)throw new Error('Missing native product log prefixes');
seen.add('product-log-prefix');
if(brandConstants!==revision.brandConstants.length)throw new Error('Missing native product-name boundaries');
if(workerHashUpdates!==1)throw new Error('Missing or ambiguous Modal helper integrity boundary');
if(!seen.has('compute-app-brand'))throw new Error('Missing native compute app naming boundary');
for (const required of ['PP', 'cIt', 'Ugs', 'ERe', '$G', 'Fma', 'Ahe', 'pJc', 'Oqn', 'AP','hre','BFr','native-message-output','oyt','Yat','d9','qR','local-dictation','local-subscription-routes','local-asset-root','native-daemon-identity','telemetry-hard-opt-out','telemetry-noop-provider','telemetry-no-crash-transport','noncommercial-use-default','native-image-generation-dispatch','native-image-tool-advertisement','native-image-tool-history','native-image-plan-gate','memory-classifier-request','product-log-prefix']) if (!seen.has(required)) throw new Error('missing checked native boundary ' + required);
for(const required of CLASS2_REQUIRED_BOUNDARIES)if(!seen.has(required))throw new Error('missing Class 2 native boundary '+required);
let result = original;
replacements.sort((a,b) => b.start - a.start);
for (let i = 1; i < replacements.length; i++) if (replacements[i].end > replacements[i-1].start) throw new Error('overlapping native patches');
for (const edit of replacements) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
const primaryUse='Primary use of Claude Science';
if(result.split(primaryUse).length!==2)throw new Error('Missing or ambiguous native primary-use branding boundary');
result=result.replace(primaryUse,'Primary use of Chimeric');seen.add('product-primary-use');
const legacyMcpEnvironment='claude-science-mcp';
if(!result.includes(legacyMcpEnvironment))throw new Error('Missing native MCP environment branding boundary');
result=result.replaceAll(legacyMcpEnvironment,'chimeric-mcp');seen.add('product-mcp-environment');
result = result.replace(/^#![^\n]*\n/, '');
result = 'import "./local-runtime.js";\n' + result;
writeFileSync(join(out, 'claude-science'), result, { mode: 0o700 });
writeFileSync(join(out, 'chimeric.js'), result, { mode: 0o700 });
const bundle=await Bun.build({entrypoints:[resolve('src/local-runtime.ts')],target:'bun',outdir:out,naming:'local-runtime.js'});
if (!bundle.success) throw new Error('Local provider service bundle failed: '+bundle.logs.join('\n'));
copyFileSync(resolve('src/chatgpt-credentials.js'),join(out,'chatgpt-credentials.js'));
copyFileSync(resolve('src/provider-settings.js'),join(out,'provider-settings.js'));
copyFileSync(resolve('src/antigravity-settings.js'),join(out,'antigravity-settings.js'));
copyFileSync(resolve('src/image-generation-settings.js'),join(out,'image-generation-settings.js'));
copyFileSync(resolve('src/decision-settings.js'),join(out,'decision-settings.js'));
for(const name of ['usage-indicator.js','voice-settings.js','class2-settings.js','provider-events.js'])copyFileSync(resolve('src/'+name),join(out,name));
copyFileSync(resolve('src/protected-resource-view.js'),join(out,'protected-resource-view.js'));
copyFileSync(resolve('tools/local_asr.py'),join(out,'local_asr.py'));
for (const file of ['sqliteWorkerEntry.js', 'orgsImportWorker.js', 'sandbox/gitScanWorker.js', 'stallWatchdogEntry.js', archive]) {
  const target=join(out,file);mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(sourceDir, file), target);
  if(file.endsWith('.js')){const value=readFileSync(target,'utf8'),branded=value.replaceAll('[claude-science]','[chimeric]').replaceAll('Claude Science','Chimeric').replaceAll('claude-science-mcp','chimeric-mcp');if(branded!==value)writeFileSync(target,branded)}
  if (file.endsWith('.js') && !existsSync(join(out, file.replace(/\.js$/, '.ts')))) symlinkSync(file.split('/').at(-1)!, join(out, file.replace(/\.js$/, '.ts')));
}
const frontend=Bun.spawnSync(['python3',resolve('tools/build-frontend.py'),join(sourceDir,archive),join(out,archive),process.execPath],{stdout:'pipe',stderr:'pipe'});
if(frontend.exitCode!==0)throw new Error('Native frontend integration failed: '+frontend.stderr.toString());
writeFileSync(join(out, 'patch-manifest.json'), JSON.stringify({platform:revision.platform,sourceSha256: createHash('sha256').update(original).digest('hex'), outputSha256: createHash('sha256').update(result).digest('hex'), boundaries: [...seen], class2RequiredBoundaries:[...CLASS2_REQUIRED_BOUNDARIES], patches: [...replacements.map(x => x.label),'product-primary-use','product-mcp-environment'],integrityUpdates:[modalWorker] }, null, 2));
console.log(JSON.stringify({ out, boundaries: [...seen], patches: replacements.length }));
