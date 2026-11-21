import {afterEach,expect,test} from 'bun:test';
import {mkdtempSync,mkdirSync,rmSync,symlinkSync,linkSync,writeFileSync,readFileSync,chmodSync,existsSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {parse} from '@babel/parser';
import {ProtectedStorage,type ProtectedStorageScope} from '../src/protected-storage';
import {ProviderSecrets} from '../src/provider-secrets';
import {SubscriptionVault} from '../src/subscription';
import {nativeProtectedStorageEdits,nativeProtectedStorageBoundaries} from '../tools/native-protected-storage';
import {nativeExecutionPolicyEdits} from '../tools/native-execution-policy';
import {nativeKernelPolicyEdits} from '../tools/native-kernel-policy';
import {nativeRuntimeServicesEdits} from '../tools/native-runtime-services';
import {nativeResourcePolicyEdits} from '../tools/native-resource-policy';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function fixture(){const root=mkdtempSync(join(tmpdir(),'protected-store-'));roots.push(root);const data=join(root,'data'),auth=join(root,'legacy-auth');mkdirSync(data,{mode:0o700});mkdirSync(auth,{mode:0o700});const scope:ProtectedStorageScope={frameId:'frame',rootFrameId:'root',projectId:'project',ownerId:'owner',organizationId:'org',mode:'class2',revision:1,executionBinding:hash('one')},scopes=new Map([['frame',scope]]);const store=new ProtectedStorage(data,{authDir:auth,scopeForFrame:id=>scopes.get(id),assertCurrent:value=>{if(JSON.stringify(scopes.get(value.frameId))!==JSON.stringify(value))throw Error('stale scope')}}),layout=store.layout(scope),derived={config:{platform:'macos',network:{enabled:false,httpProxyPort:0,socksProxyPort:0,allowUnixSockets:[]},dataDir:data,authDir:auth,condaHome:join(root,'conda'),rSharedLibsBase:join(root,'r-shared'),userReadPaths:[root],userWritePaths:[root],filesystem:{allowWrite:['/tmp'],allowWriteUserGlob:[],pinDirents:[]}},daemonReadablePaths:[join(root,'conda'),root],writablePaths:[join(data,'workspace','frame')],daemonWritablePaths:[],readablePaths:[]};return {root,data,auth,store,layout,scope,scopes,derived}}

test('Protected categories share one private root and host credentials have a separate sibling',()=>{
 const f=fixture();for(const category of ['artifacts','uploads','derived','thumbnails','toolResults','converterJobs','imageJobs','broker','workspace','temp'] as const){const path=f.store.write(f.scope,category,'result.bin',Buffer.from('synthetic'));expect(path.startsWith(f.layout.root+'/')).toBe(true);expect(f.store.read(f.scope,category,'result.bin').toString()).toBe('synthetic')}
 const auth=f.store.writeAuth('provider-secrets.enc',Buffer.from('SYNTHETIC_ONLY'));expect(auth.startsWith(f.layout.hostAuth+'/')).toBe(true);expect(auth.startsWith(f.layout.root+'/')).toBe(false);expect(()=>f.store.write(f.scope,'root' as any,'x',Buffer.from('x'))).toThrow('category');expect(()=>f.store.authPath('../key')).toThrow('filename');
});

test('The actual provider and subscription vaults work in the separate private auth directory',()=>{
 const f=fixture(),secrets=new ProviderSecrets(f.store.authPath()),destination='https://synthetic.invalid/v1';const ref=secrets.put('SYNTHETIC_ONLY_KEY',destination);expect(secrets.get(ref,destination)).toBe('SYNTHETIC_ONLY_KEY');
 const vault=new SubscriptionVault(f.store.authPath());vault.write({session:'synthetic-session',version:'synthetic-version',credential:null});expect(vault.read()).toMatchObject({session:'synthetic-session',credential:null});expect(vault.path.startsWith(f.layout.hostAuth+'/')).toBe(true);
});

test('Authenticated owner binding isolates roots and keeps the current chat descendants together',()=>{
 const f=fixture(),child={...f.scope,frameId:'child'};f.scopes.set('child',child);expect(f.store.layout(child).root).toBe(f.layout.root);expect(f.store.layout(child).workspace).not.toBe(f.layout.workspace);const other={...f.scope,frameId:'other',rootFrameId:'other-root'};f.scopes.set('other',other);expect(f.store.layout(other).root).not.toBe(f.layout.root);writeFileSync(join(f.layout.root,'owner.json'),'forged');expect(()=>f.store.layout(f.scope)).toThrow('different research owner');
});

test('Symlink, hardlink, replaced directory and broad private permissions are refused',()=>{
 const f=fixture(),outside=join(f.root,'outside');writeFileSync(outside,'public');symlinkSync(outside,join(f.layout.derived,'symlink'));expect(()=>f.store.read(f.scope,'derived','symlink')).toThrow('Linked');expect(()=>f.store.write(f.scope,'derived','symlink',Buffer.from('private'))).toThrow('Linked');const source=f.store.write(f.scope,'derived','source',Buffer.from('private'));linkSync(source,join(f.root,'hardlink'));expect(()=>f.store.read(f.scope,'derived','source')).toThrow('Linked');expect(()=>f.store.write(f.scope,'derived','source',Buffer.from('replacement'))).toThrow('Linked');
 rmSync(f.layout.thumbnails,{recursive:true});symlinkSync(f.root,f.layout.thumbnails);expect(()=>f.store.layout(f.scope)).toThrow('link identity');const g=fixture();chmodSync(g.layout.artifacts,0o755);expect(()=>g.store.layout(g.scope)).toThrow('permissions');
});

test('Standard calls remain exact and serialized class flags cannot create a protected policy',()=>{
 const f=fixture(),env={},request={frameId:'standard',env},derived={...f.derived};expect(f.store.configureNativeSpawn({},request,derived)).toBe(derived);expect(f.store.workspacePath('standard','/ordinary')).toBe('/ordinary');expect(f.store.kernelBase({},'standard','/ordinary')).toBe('/ordinary');expect(f.store.appendNativePolicy({class2:true},'ORIGINAL')).toBe('ORIGINAL');expect(env).toEqual({});
});

test('Privileged host file handlers and grants must respect canonical private roots too',()=>{
 const f=fixture(),alias=join(f.root,'alias');symlinkSync(f.layout.hostAuth,alias);expect(()=>f.store.assertHostPath('standard',join(alias,'providers.key'))).toThrow('ordinary research');expect(()=>f.store.assertHostPath('frame',f.layout.hostAuth)).toThrow('outside');f.store.assertHostPath('frame',join(f.layout.workspace,'result.txt'),'write');expect(()=>f.store.assertHostPath('frame',join(f.layout.artifacts,'result.txt'),'write')).toThrow('outside');expect(()=>f.store.assertGrant(f.data)).toThrow('grant');expect(()=>f.store.assertGrant(f.layout.root)).toThrow('grant');f.store.assertHostPath('standard',join(f.root,'ordinary'));f.store.assertGrant(join(f.root,'ordinary'));
});

test('Protected resource staging chooses the reserve before bytes land and binds the exact project',async()=>{
 const f=fixture();let planned:any;
 await f.store.withResourceWrite('frame','artifact',async()=>{
  planned=f.store.resourceWritePath({kind:'artifact',projectId:'project',artifactId:'artifact-1',versionId:'version-1',filename:'user/name.png'});
  expect(planned.absolutePath.startsWith(f.layout.artifacts+'/')).toBe(true);expect(planned.storagePath).toBe(planned.absolutePath);writeFileSync(planned.absolutePath,'protected',{mode:0o600});return 'classified';
 });
 expect(readFileSync(planned.absolutePath,'utf8')).toBe('protected');expect(f.store.withResourceRead({artifactId:'artifact-1',versionId:'version-1',projectId:'project',ownerId:'owner',organizationId:'org',isUserUpload:false},['root'],()=>f.store.storedResourcePath(planned.storagePath))).toMatchObject({absolutePath:planned.absolutePath});
 await expect(f.store.withResourceWrite('frame','artifact',async()=>{f.store.resourceWritePath({kind:'artifact',projectId:'wrong-project',artifactId:'artifact-2',versionId:'version-2',filename:'x'});return null})).rejects.toThrow('identity');
 expect(()=>f.store.storedResourcePath(join(f.root,'ordinary'))).toThrow('outside the protected reserve');
 const forgedWorkspaceFile=join(f.layout.workspace,'forged-resource');writeFileSync(forgedWorkspaceFile,'not a retained resource',{mode:0o600});
 expect(()=>f.store.storedResourcePath(forgedWorkspaceFile)).toThrow('not minted');expect(()=>f.store.storedResourcePath(join(f.layout.root,'owner.json'))).toThrow('not minted');
 expect(()=>f.store.storedResourcePath(planned.storagePath)).toThrow('read lease');
 expect(()=>f.store.withResourceRead({artifactId:'artifact-1',versionId:'version-1',projectId:'wrong',ownerId:'owner',organizationId:'org',isUserUpload:false},['root'],()=>f.store.storedResourcePath(planned.storagePath))).toThrow('different research scope');
 expect(()=>f.store.withResourceRead({artifactId:'artifact-1',versionId:'version-1',projectId:'project',ownerId:'owner',organizationId:'org',isUserUpload:false},['other-root'],()=>f.store.storedResourcePath(planned.storagePath))).toThrow('different research scope');
});

test('A classification failure deletes staged bytes and their now-empty private directories',async()=>{
 const f=fixture();let path='';
 await expect(f.store.withResourceWrite('frame','upload',async()=>{const plan=f.store.resourceWritePath({kind:'upload',projectId:'project',artifactId:'upload-1',versionId:'version-1',filename:'sample.bin'})!;path=plan.absolutePath;writeFileSync(path,'must disappear',{mode:0o600});throw Error('classification failed')})).rejects.toThrow('classification failed');
 expect(existsSync(path)).toBe(false);expect(existsSync(dirname(path))).toBe(false);expect(existsSync(dirname(dirname(path)))).toBe(false);
 await expect(f.store.withResourceWrite('frame','artifact',async()=>null)).rejects.toThrow('did not request a protected write path');
});

test('Protected spawn removes user grants/shared temporary writes and binds its native policy token',()=>{
 const f=fixture(),env:any={},result=f.store.configureNativeSpawn({},{frameId:'frame',env,denyNetwork:true,untrustedArgs:false},f.derived);expect(result.config.userReadPaths).toEqual([]);expect(result.config.userWritePaths).toEqual([]);expect(result.config.filesystem.allowWrite).toEqual([]);expect(result.config.denyLinkCreation).toBe(true);expect(result.writablePaths).toEqual([f.layout.workspace,f.layout.temp]);expect(env.TMPDIR).toBe(f.layout.temp);expect(env.HOME.startsWith(f.layout.root+'/')).toBe(true);const policy=f.store.appendNativePolicy({...result.config},'(version 1)\n(deny default)');expect(policy).toContain('(deny file-link file-clone)');expect(policy).toContain('(deny file-write*)');expect(policy).toContain(JSON.stringify(f.layout.hostAuth));expect(policy).toContain(JSON.stringify(f.layout.workspace));expect(policy).not.toContain('(allow file-read* (subpath '+JSON.stringify(f.layout.hostAuth));f.scopes.set('frame',{...f.scope,revision:2});expect(()=>f.store.appendNativePolicy(result.config,'old')).toThrow('stale');
});

test('Unverified spawns or runtime grants covering private auth fail before launch',()=>{
 const f=fixture();expect(()=>f.store.configureNativeSpawn({},{frameId:'frame',env:{},denyNetwork:true},{...f.derived,config:{...f.derived.config,network:{...f.derived.config.network,enabled:true}}})).toThrow('network configuration');for(const changes of [{denyNetwork:false},{untrustedArgs:true},{frameSecretsDir:'/secrets'}])expect(()=>f.store.configureNativeSpawn({},{frameId:'frame',env:{},denyNetwork:true,...changes},f.derived)).toThrow('verified protected');for(const condaHome of [f.layout.reserve,join(f.layout.hostAuth,'child'),f.data])expect(()=>f.store.configureNativeSpawn({},{frameId:'frame',env:{},denyNetwork:true},{...f.derived,config:{...f.derived.config,condaHome}})).toThrow('read grant');
});

const nativePath=resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science');
test.skipIf(!existsSync(nativePath))('All native storage hooks compose with execution, kernel and service guards',()=>{
 const source=readFileSync(nativePath,'utf8'),ast=parse(source,{sourceType:'unambiguous'}),own=nativeProtectedStorageEdits(ast,source);expect(own.map(e=>e.label).sort()).toEqual([...nativeProtectedStorageBoundaries].sort());const edits=[...own,...nativeExecutionPolicyEdits(ast,source),...nativeKernelPolicyEdits(ast,source),...nativeRuntimeServicesEdits(ast,source),...nativeResourcePolicyEdits(ast,source)].sort((a,b)=>b.start-a.start);for(let i=1;i<edits.length;i++)expect(edits[i].end).toBeLessThanOrEqual(edits[i-1].start);let patched=source;for(const edit of edits)patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);parse(patched,{sourceType:'unambiguous'});expect(()=>nativeProtectedStorageEdits(parse(patched,{sourceType:'unambiguous'}),patched)).toThrow('already-patched');
 expect(patched).toContain('nativeProtectedHostPath');expect(patched).toContain('nativeProtectedGrantPath');expect(patched).toContain('nativeProtectedResourceWrite');expect(patched).toContain('nativeProtectedStoredPath');
},30000);

const linuxNativePath=resolve(import.meta.dir,'../../../work/chimeric-linux-probe/recovered-production-reader/claude-science');
test.skipIf(!existsSync(linuxNativePath))('The Linux native storage hooks bind the renamed seatbelt renderer exactly',()=>{
 const source=readFileSync(linuxNativePath,'utf8'),ast=parse(source,{sourceType:'unambiguous'});
 const edits=nativeProtectedStorageEdits(ast,source,{policy:'cti',render:'oKn'});
 expect(edits.map(edit=>edit.label).sort()).toEqual([...nativeProtectedStorageBoundaries].sort());
 expect(edits.filter(edit=>edit.label.startsWith('native-private-policy-')).map(edit=>edit.text)).toEqual([
  expect.stringContaining('nativeProtectedStoragePolicy'),
  expect.stringContaining('nativeProtectedStoragePolicy'),
 ]);
},30000);
