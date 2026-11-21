import {createHash,randomUUID} from 'node:crypto';
import {chmodSync,closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,statSync,unlinkSync,writeFileSync} from 'node:fs';
import {relative,resolve,join,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {z} from 'zod';
import type {NativeKernelScope} from '../tools/native-kernel-policy';

const sha256=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const fileSha256=(path:string)=>sha256(readFileSync(path));
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const id=z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const executionKind=z.string().min(1).max(128).regex(/^[a-z][a-z0-9._:-]*$/);

/** These labels are the native hooks that make the offline Python claim true.
 * The build fails if one disappears from the recovered runtime. */
export const CLASS2_REQUIRED_BOUNDARIES=Object.freeze([
 'native-scope-task','native-scope-metadata','native-scope-sdk-fetch','native-scope-runner','native-scope-agent-job',
 'native-policy-registry-tool','native-policy-host-call','native-policy-kernel','native-policy-tool-dispatch','native-policy-compute-dispatch','native-policy-network-grant','native-policy-process','native-policy-shell',
 'native-kernel-execute-entry','native-kernel-start-entry','native-kernel-host-dispatch','native-kernel-process-attached','native-kernel-manager-registration','native-kernel-manager-release','native-kernel-acquire','native-kernel-bind','native-kernel-start-generation','native-kernel-host-context',
 'native-runtime-task-enter','native-runtime-task-leave','native-runtime-background','native-runtime-agent-enter','native-runtime-agent-leave','native-runtime-services',
 'native-private-workspace','native-private-kernel-base','native-private-policy-1','native-private-policy-2','native-private-spawn-layout',
 'native-resource-save-_saveArtifactCommon','native-resource-save-save_user_upload_streaming','native-resource-http-read','native-resource-upload-request',
] as const);

export const CLASS2_OFFLINE_OVERRIDES=Object.freeze({denyNetwork:true,hideFrameSecrets:true});
const overridesDigest=sha256(JSON.stringify(CLASS2_OFFLINE_OVERRIDES));

type BuildReceipt={schemaVersion:1;platform:'darwin-arm64';attestationEpoch:number;requiredBoundaries:string[];
 assetTreeTarSha256:string;files:Record<string,string>};
export type NativeBuildEvidence=Readonly<{verified:boolean;reason?:string;attestationEpoch?:number;activationEpoch?:number;receiptSha256?:string}>;
type RootIdentity=Pick<NativeKernelScope,'rootFrameId'|'projectId'|'ownerId'|'organizationId'>;
type RootLedger=RootIdentity&{rootCreatedAt:number|null;unrestrictedSeen:boolean;standardCount:number;protectedCount:number;
 firstExecutionAt:number;lastExecutionAt:number;lastKind:string;lastReceiptSha256:string;lastOverridesSha256:string|null};
type Activation={receiptSha256:string;activatedAt:number};
type Ledger={schemaVersion:1;revision:number;activations:Activation[];roots:RootLedger[]};

const rootSchema=z.object({rootFrameId:id,projectId:id,ownerId:id,organizationId:id,rootCreatedAt:z.number().int().nonnegative().nullable(),
 unrestrictedSeen:z.boolean(),standardCount:z.number().int().nonnegative(),protectedCount:z.number().int().nonnegative(),
 firstExecutionAt:z.number().int().nonnegative(),lastExecutionAt:z.number().int().nonnegative(),lastKind:executionKind,
 lastReceiptSha256:hex,lastOverridesSha256:hex.nullable()}).strict();
const ledgerSchema=z.object({schemaVersion:z.literal(1),revision:z.number().int().nonnegative(),
 activations:z.array(z.object({receiptSha256:hex,activatedAt:z.number().int().nonnegative()}).strict()).max(1024),roots:z.array(rootSchema).max(16_384)}).strict();

function contained(root:string,path:string){const value=relative(root,path);return value===''||!value.startsWith('..')&&!isAbsolute(value)}
function safeFile(root:string,path:string){
 const resolved=realpathSync(path);if(!contained(root,resolved))throw Error('attestation-path-escape');
 const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink())throw Error('attestation-unsafe-file');return resolved;
}
function sameScope(row:RootIdentity,scope:RootIdentity){return row.rootFrameId===scope.rootFrameId&&row.projectId===scope.projectId&&row.ownerId===scope.ownerId&&row.organizationId===scope.organizationId}
function exactOverrides(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))return false;const row=value as Record<string,unknown>,keys=Object.keys(row).sort();
 return keys.length===2&&keys[0]==='denyNetwork'&&keys[1]==='hideFrameSecrets'&&row.denyNetwork===true&&row.hideFrameSecrets===true;
}

/**
 * Verifies the sealed macOS package and maintains a durable, per-root compute
 * ledger. The ledger is written synchronously before native work is allowed to
 * start, so a later process census cannot erase unrestricted history.
 */
export class NativeExecutionAttestation {
 private resources:string;private receiptFile:string;private ledgerFile:string;private authDir:string;
 private buildCache?:{value:{receipt:BuildReceipt;raw:Buffer;receiptSha256:string};files:Array<{path:string;fingerprint:string}>};
 constructor(readonly profileDir:string,resourcesDir:string,private options:{platform?:NodeJS.Platform;now?:()=>number;verifyCodeSignature?:(appPath:string)=>boolean}={}){
  this.authDir=join(profileDir,'local-auth');mkdirSync(this.authDir,{recursive:true,mode:0o700});chmodSync(this.authDir,0o700);
  this.resources=resolve(resourcesDir);this.receiptFile=join(this.resources,'runtime','class2-build-receipt.json');
  this.ledgerFile=join(this.authDir,'native-execution-ledger.json');
 }
 private now(){return this.options.now?.()??Date.now()}
 private fingerprint(path:string){const info=lstatSync(path,{bigint:true});if(!info.isFile()||info.isSymbolicLink())throw Error('attestation-unsafe-file');return [info.dev,info.ino,info.size,info.mtimeNs,info.ctimeNs].join(':')}
 private readReceipt():{receipt:BuildReceipt;raw:Buffer;receiptSha256:string}{
  if((this.options.platform??process.platform)!=='darwin')throw Error('unsupported-platform');
  const root=realpathSync(this.resources),parts=this.resources.split('/');
  if(parts.at(-1)!=='Resources'||parts.at(-2)!=='Contents'||!parts.at(-3)?.endsWith('.app'))throw Error('unsealed-resource-layout');
  if(this.buildCache&&this.buildCache.files.every(value=>this.fingerprint(value.path)===value.fingerprint))return this.buildCache.value;
  const app=resolve(this.resources,'..','..'),verify=this.options.verifyCodeSignature??((path:string)=>{
   const result=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',path],{stdio:'ignore',timeout:10_000});return result.status===0;
  });
  if(!verify(app))throw Error('invalid-code-signature');
  const receiptPath=safeFile(root,this.receiptFile),info=statSync(receiptPath);if(info.size<2||info.size>128*1024)throw Error('invalid-receipt-size');
  const raw=readFileSync(receiptPath),value=JSON.parse(raw.toString('utf8')) as BuildReceipt;
  if(!value||value.schemaVersion!==1||value.platform!=='darwin-arm64'||!Number.isSafeInteger(value.attestationEpoch)||value.attestationEpoch<0||!hex.safeParse(value.assetTreeTarSha256).success)throw Error('invalid-receipt');
  if(!Array.isArray(value.requiredBoundaries)||value.requiredBoundaries.length!==CLASS2_REQUIRED_BOUNDARIES.length||value.requiredBoundaries.some((name,index)=>name!==CLASS2_REQUIRED_BOUNDARIES[index]))throw Error('invalid-receipt-boundaries');
  const manifestPath='runtime/asset-manifest.json',patchPath='runtime/patch-manifest.json';
  const manifest=JSON.parse(readFileSync(safeFile(root,join(root,manifestPath)),'utf8')) as any,archive=manifest?.archive;
  if(typeof archive!=='string'||!/^[A-Za-z0-9._-]+$/.test(archive)||archive.includes('..')||manifest.sha256!==value.assetTreeTarSha256)throw Error('invalid-asset-binding');
  const expected=['runtime/chimeric.js','runtime/local-runtime.js','bin/chimeric',patchPath,manifestPath,'runtime/'+archive].sort();
  const names=Object.keys(value.files??{}).sort();if(JSON.stringify(names)!==JSON.stringify(expected))throw Error('invalid-receipt-files');
  for(const name of expected){if(!hex.safeParse(value.files[name]).success||fileSha256(safeFile(root,join(root,name)))!==value.files[name])throw Error('receipt-file-mismatch')}
  const patch=JSON.parse(readFileSync(safeFile(root,join(root,patchPath)),'utf8')) as any;
  if(patch.platform!=='darwin-arm64'||patch.outputSha256!==value.files['runtime/chimeric.js']||JSON.stringify(patch.class2RequiredBoundaries)!==JSON.stringify(CLASS2_REQUIRED_BOUNDARIES))throw Error('invalid-patch-binding');
  const boundaries=new Set(Array.isArray(patch.boundaries)?patch.boundaries:[]);if(CLASS2_REQUIRED_BOUNDARIES.some(name=>!boundaries.has(name)))throw Error('missing-protected-boundary');
  const result={receipt:value,raw,receiptSha256:sha256(raw)},bound=[receiptPath,...expected.map(name=>join(root,name))];
  this.buildCache={value:result,files:bound.map(path=>({path,fingerprint:this.fingerprint(path)}))};return result;
 }
 evidence():NativeBuildEvidence{
  try{const {receipt,receiptSha256}=this.readReceipt(),activationEpoch=this.ensureActivation(receiptSha256);return Object.freeze({verified:true,attestationEpoch:receipt.attestationEpoch,activationEpoch,receiptSha256})}
  catch{return Object.freeze({verified:false,reason:'This app package does not have a valid sealed Class 2 execution receipt.'})}
 }
 private verified(){const value=this.readReceipt(),activationEpoch=this.ensureActivation(value.receiptSha256);return {...value,activationEpoch}}
 private readLedger():Ledger{
  if(!existsSync(this.ledgerFile))return {schemaVersion:1,revision:0,activations:[],roots:[]};
  const info=lstatSync(this.ledgerFile);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw Error('execution-ledger-unreadable');
  return ledgerSchema.parse(JSON.parse(readFileSync(this.ledgerFile,'utf8')));
 }
 private writeLedger(value:Ledger){
  const checked=ledgerSchema.parse(value),temporary=this.ledgerFile+'.'+randomUUID()+'.tmp';
  let file:number|undefined;
  try{file=openSync(temporary,'wx',0o600);writeFileSync(file,JSON.stringify(checked),'utf8');fsyncSync(file);closeSync(file);file=undefined;
   if(existsSync(this.ledgerFile)){const prior=lstatSync(this.ledgerFile);if(!prior.isFile()||prior.isSymbolicLink())throw Error('execution-ledger-unreadable')}
   renameSync(temporary,this.ledgerFile);chmodSync(this.ledgerFile,0o600);const committed=lstatSync(this.ledgerFile);if(!committed.isFile()||committed.isSymbolicLink()||(committed.mode&0o777)!==0o600)throw Error('execution-ledger-commit-failed');
   const directory=openSync(this.authDir,'r');try{fsyncSync(directory)}finally{closeSync(directory)}
  }catch(error){if(file!==undefined)try{closeSync(file)}catch{};try{unlinkSync(temporary)}catch{};throw error}
 }
 private ensureActivation(receiptSha256:string){
  const ledger=this.readLedger(),existing=ledger.activations.find(value=>value.receiptSha256===receiptSha256);if(existing)return existing.activatedAt;
  const activatedAt=this.now();ledger.activations.push({receiptSha256,activatedAt});ledger.revision++;this.writeLedger(ledger);return activatedAt;
 }
 assertNoUnconfinedHistory(scope:NativeKernelScope,rootCreatedAt:number|undefined){
  const {receipt,activationEpoch}=this.verified(),freshAfter=Math.max(receipt.attestationEpoch,activationEpoch);
  if(!Number.isSafeInteger(rootCreatedAt)||rootCreatedAt! < freshAfter)throw Error('This chat predates the verified Class 2 execution boundary. Start a new protected chat.');
  const row=this.readLedger().roots.find(value=>value.rootFrameId===scope.rootFrameId);if(!row)return;
  if(!sameScope(row,scope)||row.rootCreatedAt!==rootCreatedAt)throw Error('The native execution ledger belongs to a different research scope.');
  if(row.unrestrictedSeen||row.standardCount>0)throw Error('This chat has run unrestricted native compute. Start a new protected chat.');
 }
 noteExecution(kind:string,scope:NativeKernelScope,rootCreatedAt:number|undefined,overrides?:Readonly<Record<string,unknown>>){
  executionKind.parse(kind);const protectedRun=scope.mode==='class2';let receiptSha256='0'.repeat(64);
  if(protectedRun){const verified=this.verified();receiptSha256=verified.receiptSha256;this.assertNoUnconfinedHistory(scope,rootCreatedAt);if(!exactOverrides(overrides))throw Error('Protected Python requires the verified offline sandbox settings.');}
  else try{receiptSha256=this.readReceipt().receiptSha256}catch{/* Standard compute still records an irreversible unrestricted marker. */}
  const ledger=this.readLedger(),now=this.now();let row=ledger.roots.find(value=>value.rootFrameId===scope.rootFrameId);
  if(row&&!sameScope(row,scope))throw Error('The native execution ledger belongs to a different research scope.');
  if(row&&row.rootCreatedAt!==null&&rootCreatedAt!==undefined&&row.rootCreatedAt!==rootCreatedAt)throw Error('The native execution root identity changed.');
  if(!row){row={rootFrameId:scope.rootFrameId,projectId:scope.projectId,ownerId:scope.ownerId,organizationId:scope.organizationId,rootCreatedAt:Number.isSafeInteger(rootCreatedAt)?rootCreatedAt!:null,
    unrestrictedSeen:!protectedRun,standardCount:protectedRun?0:1,protectedCount:protectedRun?1:0,firstExecutionAt:now,lastExecutionAt:now,lastKind:kind,lastReceiptSha256:receiptSha256,lastOverridesSha256:protectedRun?overridesDigest:null};ledger.roots.push(row)}
  else{row.rootCreatedAt??=Number.isSafeInteger(rootCreatedAt)?rootCreatedAt!:null;row.unrestrictedSeen||=!protectedRun;
    if(protectedRun)row.protectedCount++;else row.standardCount++;if(!Number.isSafeInteger(row.protectedCount)||!Number.isSafeInteger(row.standardCount))throw Error('Native execution ledger counter overflow.');
    row.lastExecutionAt=now;row.lastKind=kind;row.lastReceiptSha256=receiptSha256;row.lastOverridesSha256=protectedRun?overridesDigest:null}
  ledger.revision++;this.writeLedger(ledger);
 }
 offlineExecution(){this.verified();return Object.freeze({verified:true as const,platform:'darwin' as const,overrides:CLASS2_OFFLINE_OVERRIDES})}
 allowProtectedKernel(scope:NativeKernelScope,environment:string,Constructor:unknown,overrides:Readonly<Record<string,unknown>>=CLASS2_OFFLINE_OVERRIDES){
  // The kernel manager passes the selected conda environment here, not the
  // language. Authorize the concrete Python kernel class, never an arbitrary
  // persistent kernel or an R/operon/byoc implementation.
  const kernelType=typeof Constructor==='function'&&Constructor.prototype?Constructor.prototype._kernelType:undefined;
  // The sealed core passes its class value through a generated wrapper on this
  // path. Keep the structural check as a second, equally narrow identity test.
  const pythonKernel=kernelType==='python'||typeof Constructor==='function'&&/get _kernelType\(\)\{return["']python["']\}/.test(Function.prototype.toString.call(Constructor));
  if(scope.mode!=='class2'||!environment.trim()||!pythonKernel||!exactOverrides(overrides))return false;
  return this.evidence().verified===true;
 }
}
