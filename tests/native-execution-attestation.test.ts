import {afterEach,expect,test} from 'bun:test';
import {chmodSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {CLASS2_OFFLINE_OVERRIDES,CLASS2_REQUIRED_BOUNDARIES,NativeExecutionAttestation} from '../src/native-execution-attestation';
import type {NativeKernelScope} from '../tools/native-kernel-policy';

const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0).reverse())cleanup()});
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
function fixture(platform:NodeJS.Platform='darwin'){
 const root=mkdtempSync(join(tmpdir(),'chimeric-attestation-')),profile=join(root,'profile'),app=join(root,'Chimeric.app'),resources=join(app,'Contents','Resources'),runtime=join(resources,'runtime');
 cleanups.push(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(profile);mkdirSync(join(resources,'bin'),{recursive:true});mkdirSync(runtime);
 const files:Record<string,string>={
  'runtime/chimeric.js':'runtime-core','runtime/local-runtime.js':'backend','bin/chimeric':'native-binary','runtime/assets.tar-test.gz':'asset-archive',
 };
 for(const [name,value]of Object.entries(files)){const path=join(resources,name);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,value);if(name==='bin/chimeric')chmodSync(path,0o755)}
 const assetTree=hash('asset-tree'),assetManifest={archive:'assets.tar-test.gz',rootRelative:'assets-test',sha256:assetTree,archiveSha256:hash('asset-archive')};
 writeFileSync(join(runtime,'asset-manifest.json'),JSON.stringify(assetManifest));
 const patch={platform:'darwin-arm64',sourceSha256:hash('source'),outputSha256:hash('runtime-core'),boundaries:[...CLASS2_REQUIRED_BOUNDARIES],class2RequiredBoundaries:[...CLASS2_REQUIRED_BOUNDARIES]};
 writeFileSync(join(runtime,'patch-manifest.json'),JSON.stringify(patch));
 const bound=['runtime/chimeric.js','runtime/local-runtime.js','bin/chimeric','runtime/patch-manifest.json','runtime/asset-manifest.json','runtime/assets.tar-test.gz'];
 const receipt={schemaVersion:1,platform:'darwin-arm64',attestationEpoch:1000,requiredBoundaries:[...CLASS2_REQUIRED_BOUNDARIES],assetTreeTarSha256:assetTree,
  files:Object.fromEntries(bound.map(name=>[name,hash(readFileSync(join(resources,name)))]))};
 writeFileSync(join(runtime,'class2-build-receipt.json'),JSON.stringify(receipt));
 let now=2000;const attestation=new NativeExecutionAttestation(profile,resources,{platform,now:()=>now,verifyCodeSignature:()=>true});
 return {root,profile,resources,runtime,attestation,setNow:(value:number)=>now=value};
}
const scope=(mode:'standard'|'class2'='class2'):NativeKernelScope=>Object.freeze({frameId:'root',rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org',mode,revision:1,executionBinding:'a'.repeat(64)});

test('a sealed macOS receipt binds the runtime, backend, native binary, patch journal and assets',()=>{
 const f=fixture(),evidence=f.attestation.evidence();expect(evidence).toMatchObject({verified:true,attestationEpoch:1000,activationEpoch:2000});expect(evidence.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
 writeFileSync(join(f.runtime,'local-runtime.js'),'tampered');expect(f.attestation.evidence()).toEqual({verified:false,reason:'This app package does not have a valid sealed Class 2 execution receipt.'});
});

test('sealed package verification is cached only while every bound file identity is unchanged',()=>{
 const f=fixture();let signatureChecks=0;const attestation=new NativeExecutionAttestation(f.profile,f.resources,{platform:'darwin',now:()=>2000,verifyCodeSignature:()=>{signatureChecks++;return true}});
 expect(attestation.evidence().verified).toBeTrue();expect(attestation.evidence().verified).toBeTrue();expect(signatureChecks).toBe(1);
 writeFileSync(join(f.runtime,'local-runtime.js'),'mutated');expect(attestation.evidence().verified).toBeFalse();expect(signatureChecks).toBe(2);
});

test('Class 2 attestation is macOS-only and requires the package code signature',()=>{
 expect(fixture('linux').attestation.evidence().verified).toBeFalse();
 const f=fixture();const denied=new NativeExecutionAttestation(f.profile,f.resources,{platform:'darwin',verifyCodeSignature:()=>false});expect(denied.evidence().verified).toBeFalse();
});

test('an unavailable Class 2 receipt does not block standard compute from recording its unrestricted marker',()=>{
 const f=fixture('linux');expect(()=>f.attestation.noteExecution('kernel',scope('standard'),1500)).not.toThrow();
 expect(JSON.parse(readFileSync(join(f.profile,'local-auth','native-execution-ledger.json'),'utf8'))).toMatchObject({roots:[{unrestrictedSeen:true,lastReceiptSha256:'0'.repeat(64)}]});
});

test('only roots created after the attestation epoch can enter protected execution',()=>{
 const f=fixture();expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),2000)).not.toThrow();expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),1999)).toThrow('predates');
 expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),undefined)).toThrow('predates');
});

test('a root created after build but before this exact package is activated is not treated as fresh',()=>{
 const f=fixture();expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),1500)).toThrow('predates');
 const path=join(f.runtime,'class2-build-receipt.json'),receipt=JSON.parse(readFileSync(path,'utf8'));receipt.attestationEpoch=1001;writeFileSync(path,JSON.stringify(receipt));
 f.setNow(3000);expect(f.attestation.evidence()).toMatchObject({verified:true,attestationEpoch:1001,activationEpoch:3000});
 expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),2500)).toThrow('predates');expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),3000)).not.toThrow();
});

test('the durable ledger is written before work and permanently records unrestricted history',()=>{
 const f=fixture();f.attestation.noteExecution('kernel',scope('standard'),2500);const ledger=join(f.profile,'local-auth','native-execution-ledger.json');
 expect(statSync(ledger).mode&0o777).toBe(0o600);const first=JSON.parse(readFileSync(ledger,'utf8'));expect(first).toMatchObject({revision:1,activations:[],roots:[{unrestrictedSeen:true,standardCount:1,protectedCount:0}]});
 expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),2500)).toThrow('unrestricted');
 f.setNow(2100);f.attestation.noteExecution('shell',scope('standard'),2500);const second=JSON.parse(readFileSync(ledger,'utf8'));expect(second).toMatchObject({revision:3,roots:[{standardCount:2,lastKind:'shell',lastExecutionAt:2100}]});
});

test('protected Python requires exactly the offline network and secret controls',()=>{
 const f=fixture(),protectedScope=scope();class Kernel{get _kernelType(){return 'python'}}class RKernel{get _kernelType(){return 'r'}}
 expect(f.attestation.offlineExecution()).toEqual({verified:true,platform:'darwin',overrides:{denyNetwork:true,hideFrameSecrets:true}});
 expect(f.attestation.allowProtectedKernel(protectedScope,'default',Kernel,CLASS2_OFFLINE_OVERRIDES)).toBeTrue();
 expect(f.attestation.allowProtectedKernel(protectedScope,'default',RKernel,CLASS2_OFFLINE_OVERRIDES)).toBeFalse();
 expect(f.attestation.allowProtectedKernel(protectedScope,'python',Kernel,{denyNetwork:true,hideFrameSecrets:true,extra:true})).toBeFalse();
 expect(()=>f.attestation.noteExecution('kernel',protectedScope,2500,{denyNetwork:true})).toThrow('offline sandbox');
 expect(()=>f.attestation.noteExecution('kernel',protectedScope,2500,CLASS2_OFFLINE_OVERRIDES)).not.toThrow();
 expect(JSON.parse(readFileSync(join(f.profile,'local-auth','native-execution-ledger.json'),'utf8'))).toMatchObject({roots:[{unrestrictedSeen:false,standardCount:0,protectedCount:1}]});
});

test('ledger corruption and scope reuse fail closed',()=>{
 const f=fixture();f.attestation.noteExecution('kernel',scope(),2500,CLASS2_OFFLINE_OVERRIDES);const ledger=join(f.profile,'local-auth','native-execution-ledger.json');
 const changed={...scope(),projectId:'another'};expect(()=>f.attestation.assertNoUnconfinedHistory(changed,2500)).toThrow('different research scope');
 writeFileSync(ledger,'not json');expect(()=>f.attestation.assertNoUnconfinedHistory(scope(),2500)).toThrow();
});
