import {afterEach,expect,test} from 'bun:test';
import {parse} from '@babel/parser';
import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {nativeExecutionPolicyEdits,nativeExecutionPolicyBoundaries} from '../tools/native-execution-policy';

// Independent synthetic behaviors exercise the guarded native boundaries.
const source=`
class Kernels {
 async _getOrCreateKernel(frame,environment,cache,Constructor,workspace){if(cache.has(frame))return cache.get(frame);await this._dictLock.acquire();let context=this._frameContext.get(frame),child=new Constructor;await child.start();return child}
}
class Runner {
 async _handleRequestNetworkAccess(request){let value=await provider.validateNetworkTarget(request.args.domain);if("alreadyAllowed"in value)return value.alreadyAllowed;return value}
 async _executeToolCallsInner(calls,message){let dispatch=this._flattenedMcpDispatch;for(let call of calls){await this._executeComputeTool(call,message,[])}}
 async _executeComputeTool(call,message,files){try{let found=this._flattenedMcpDispatch.get(call.name);if(call.name==="compute_provider")events.push("remote-dispatch");events.push("tool:"+call.name);return found}catch(error){events.push("compute-denied");return {error:error.message}}}
 async invokeTool(agent,name,input,frame,root,project,environments,artifacts,id,signal,classifier,model,bio,pdf,saves,user){try{return await this._executeLocalTool(agent,name,input,frame,root,project)}catch(error){return {error:error.message}}}
}
class Sandbox {
 isAvailable(){events.push("availability");return false}
 async wrapCommand(command,frame,environment,shell,project){if(!this.isAvailable())return command;return command}
 async wrapCondaCommand(command,options){if(!this.isAvailable())return command;return command}
 async wrapCondaSubprocessArgs(argv,env,environment){if(!this.isAvailable())return argv;return argv}
 async wrapInternalEnvCommand(command,options){if(!this.isAvailable())return command;return command}
 async wrapInternalEnvRunArgs(argv,options){if(!this.isAvailable())return argv;return argv}
 async wrapOperonSubprocessArgs(argv,env,frame,project){if(!this.isAvailable())return argv;return argv}
 async wrapByocSubprocessArgs(argv,env,frame,environment){if(!this.isAvailable())return argv;return argv}
 async wrapSubprocessArgs(argv,env,frame,environment,untrusted=false,project=null,venv,trace,secrets,deny=false,extra){if(!this.isAvailable())return [argv,env];let {spec,config,writablePaths,readablePaths,daemonWritablePaths,daemonReadablePaths,result}=await this._deriveSubprocessWrap({argv,env,frameId:frame,frameSecretsDir:secrets,denyNetwork:deny});if(config.platform==="macos"){this.lastConfig=nativeProfile(config,writablePaths,readablePaths,[],daemonWritablePaths,[],daemonReadablePaths);let roots=this._macosPinnedRootsForProfile(spec,readablePaths);return roots}return result}
}
function nativeProfile(config,writes,reads,traces,daemonWrites,secrets,daemonReads){return {writes,reads,daemonWrites,daemonReads}}
async function processSetup(binary,argv,options){if(options.condaWrite)return sandbox().wrapCondaSubprocessArgs(argv,options.env,options.environment);if(options.kernelKind==="operon")return sandbox().wrapOperonSubprocessArgs(argv,options.env,options.frameId);if(options.kernelKind==="byoc")return sandbox().wrapByocSubprocessArgs(argv,options.env,options.frameId);return sandbox().wrapSubprocessArgs(argv,options.env,options.frameId,options.environment,false,null,null,null,options.frameSecretsDir,options.denyNetwork)}
async function shellSetup(command,options){let frame=options.frameId,env=options.extraEnv;return sandbox().wrapCommand(command,frame,options.environment)}
function hostFactory(services,context){return async(method,args,signal,token,softSignal,cell)=>{switch(method){case"credentials_request":return services.credentials();case"mcp":return services.mcp();case"model_endpoints_register":return services.register();default:return services.offline()}}}
`;
function patch(sourceText=source){
 const edits=nativeExecutionPolicyEdits(parse(sourceText,{sourceType:'unambiguous'}),sourceText);
 let output=sourceText;for(const edit of [...edits].sort((a,b)=>b.start-a.start))output=output.slice(0,edit.start)+edit.text+output.slice(edit.end);
 return {edits,source:output};
}
const original=(globalThis as any).__scienceLocal;
afterEach(()=>{if(original===undefined)delete(globalThis as any).__scienceLocal;else(globalThis as any).__scienceLocal=original});
function fixture(guard:(...args:any[])=>any){
 const events:string[]=[],received:any[]=[];
 (globalThis as any).__scienceLocal={guardNativeExecution:async(...args:any[])=>{received.push(args);return guard(...args)}};
 const provider={validateNetworkTarget:async()=>{events.push('network-validation');return {alreadyAllowed:{status:'already_allowed'}}}};
 let instance:any;const classes=Function('sandbox','provider','events',patch().source+';return {Kernels,Runner,Sandbox,processSetup,shellSetup,hostFactory}')(()=>instance,provider,events);
 instance=new classes.Sandbox;
 return {events,received,classes,sandbox:instance};
}
const denied=()=>{throw Error('Synthetic Class 2 lane is unverified')};

test('The checked patchset contains every distinct dispatch and fallback boundary exactly once',()=>{
 const value=patch();parse(value.source);
 expect(value.edits.map(edit=>edit.label).sort()).toEqual([...nativeExecutionPolicyBoundaries].sort());
 expect(new Set(value.edits.map(edit=>edit.start)).size).toBe(value.edits.length);
});

test('Kernel and standing network grants are denied before cache lookup or grant validation',async()=>{
 const f=fixture(denied),kernels=new f.classes.Kernels,runner=new f.classes.Runner,Constructor=class{};
 const cached={id:'warm-networked-kernel'},cache={has(){f.events.push('cache-read');return true},get(){return cached}};
 await expect(kernels._getOrCreateKernel('frame','python',cache,Constructor,'workspace')).rejects.toThrow('unverified');
 await expect(runner._handleRequestNetworkAccess({args:{domain:'already.example.invalid'}})).rejects.toThrow('unverified');
 expect(f.events).toEqual([]);expect(f.received[0]).toEqual(['kernel',kernels,{frameId:'frame',environment:'python',kernelConstructor:Constructor}]);
 expect(f.received[1][0]).toBe('network-grant');
});

test('Denied flattened connectors become tool errors and do not prevent a permitted offline tool',async()=>{
 const f=fixture((_kind,_owner,details)=>{if(details.tool?.name==='external_mcp')denied()}),runner=new f.classes.Runner;
 runner._flattenedMcpDispatch=new Map([['external_mcp',{}]]);runner.results=[];runner._appendToolResult=async(...args:any[])=>runner.results.push(args);
 await runner._executeToolCallsInner([{id:'blocked',name:'external_mcp'},{id:'local',name:'local_table'}],{id:'message'});
 expect(f.events).toEqual(['tool:local_table']);expect(runner.results).toHaveLength(1);
 expect(JSON.parse(runner.results[0][2]).error).toContain('unverified');expect(runner.results[0][3].isError).toBe(true);
 expect(f.received.find(row=>row[2].tool?.name==='external_mcp')[2].flattenedMcp).toBe(true);
});

test('Direct compute and registry invocations retain error handling but never reach denied implementations',async()=>{
 const f=fixture(denied),runner=new f.classes.Runner;runner._flattenedMcpDispatch=new Map;
 runner._executeLocalTool=()=>{throw Error('Must not run')};
 expect(await runner._executeComputeTool({name:'compute_provider'},null,[])).toMatchObject({error:expect.stringContaining('unverified')});
 expect(await runner.invokeTool('agent','python',{},'frame','root','project')).toMatchObject({error:expect.stringContaining('unverified')});
 expect(f.events).toEqual(['compute-denied']);
 expect(f.received[1][2]).toMatchObject({frameId:'frame',rootFrameId:'root',projectId:'project',phase:'registry'});
});

test('Every separate sandbox wrapper is gated before its unsandboxed availability fallback',async()=>{
 const f=fixture(denied);
 for(const method of ['wrapCommand','wrapSubprocessArgs','wrapCondaCommand','wrapCondaSubprocessArgs','wrapInternalEnvCommand','wrapInternalEnvRunArgs','wrapOperonSubprocessArgs','wrapByocSubprocessArgs'])
  await expect(f.sandbox[method](['synthetic'],{},'frame','python')).rejects.toThrow('unverified');
 expect(f.events).toEqual([]);expect(f.received.map(row=>row[0])).toEqual(['sandbox-shell','sandbox-process','sandbox-provisioning','sandbox-provisioning','sandbox-provisioning','sandbox-provisioning','sandbox-operon','sandbox-byoc']);
});

test('Verified offline overrides force actual denyNetwork and remove frame-secret reallow paths',async()=>{
 const f=fixture((kind)=>kind==='sandbox-process'?{denyNetwork:true,hideFrameSecrets:true}:undefined);
 f.sandbox.isAvailable=()=>true;f.sandbox._deriveSubprocessWrap=(details:any)=>({spec:{},config:{platform:'synthetic'},writablePaths:[],readablePaths:[],result:details});
 const env={SYNTHETIC:'retained'},result=await f.sandbox.wrapSubprocessArgs(['python'],env,'frame','python',false,'project',null,null,'must-not-be-mounted',false);
 expect(result).toEqual({argv:['python'],env,frameId:'frame',frameSecretsDir:undefined,denyNetwork:true});expect(result.env).toBe(env);
 expect(f.received[0][2]).toMatchObject({frameId:'frame',environment:'python',projectId:'project',denyNetwork:false,frameSecretsDir:'must-not-be-mounted'});
});

test('Central process options are awaited before branch selection and shell denial precedes wrapping',async()=>{
 const f=fixture((kind,_owner,details)=>{
  if(kind==='shell')denied();
  if(kind==='process')return {...details,condaWrite:false,kernelKind:undefined,denyNetwork:true,frameSecretsDir:undefined};
 });
 f.sandbox.isAvailable=()=>true;f.sandbox._deriveSubprocessWrap=(details:any)=>({spec:{},config:{platform:'synthetic'},writablePaths:[],readablePaths:[],result:details});
 const result=await f.classes.processSetup('python',['synthetic'],{frameId:'frame',environment:'python',condaWrite:true,kernelKind:'byoc',env:{},frameSecretsDir:'private'});
 expect(result.denyNetwork).toBe(true);expect(result.frameSecretsDir).toBeUndefined();
 await expect(f.classes.shellSetup('synthetic',{frameId:'frame'})).rejects.toThrow('unverified');
 expect(f.received.map(row=>row[0])).toEqual(['process','sandbox-process','shell']);
});

test('Host IPC gates MCP, credentials, endpoint registration and unknown dynamic methods before handlers',async()=>{
 const f=fixture(denied),invoked:string[]=[],context={frameId:'frame',rootFrameId:'root',userId:'owner'};
 const host=f.classes.hostFactory(Object.fromEntries(['mcp','credentials','register','offline'].map(name=>[name,()=>invoked.push(name)])),context);
 for(const method of ['mcp','credentials_request','model_endpoints_register','unknown_dynamic'])await expect(host(method,[{synthetic:true}])).rejects.toThrow('unverified');
 expect(invoked).toEqual([]);expect(f.received.every(row=>row[0]==='host-call'&&row[1]===context)).toBe(true);
});

test('Protected Mac reads use native per-invocation roots while standard reads retain the original scope',async()=>{
 for(const protectedMode of [false,true]){
  const f=fixture(()=>protectedMode?{denyNetwork:true}:undefined);f.sandbox.isAvailable=()=>true;
  f.sandbox._deriveSubprocessWrap=()=>({spec:{kind:'analysis'},config:{platform:'macos'},writablePaths:['/fixture/current-frame'],readablePaths:['/fixture/conda'],daemonWritablePaths:['/fixture/current-frame'],daemonReadablePaths:['/fixture/conda'],result:null});
  const selected:any[]=[];f.sandbox._macosPinnedRootsForProfile=(spec:any,paths:any)=>{selected.push({spec,paths});return {write:['native-write-scope'],internal:['native-internal-scope'],read:spec.macosPinnedRoots==='profileReadList'?paths:['/fixture/all-workspaces']}};
  const result=await f.sandbox.wrapSubprocessArgs([],{},'frame','python');
  expect(result.write).toEqual(['native-write-scope']);expect(result.internal).toEqual(['native-internal-scope']);
  expect(result.read).toEqual(protectedMode?['/fixture/conda','/fixture/current-frame']:['/fixture/all-workspaces']);
  expect(f.sandbox.lastConfig.reads).toEqual(protectedMode?['/fixture/conda','/fixture/current-frame']:['/fixture/conda']);
  expect(f.sandbox.lastConfig.daemonReads).toEqual(protectedMode?['/fixture/conda','/fixture/current-frame']:['/fixture/conda']);
  expect(selected).toHaveLength(protectedMode?2:1);
 }
});

test('Missing, ambiguous and already-patched execution boundaries fail closed',()=>{
 for(const altered of [source.replace('_handleRequestNetworkAccess','_renamedNetworkAccess'),source.replace('this._frameContext.get(frame)','this._otherContext.get(frame)'),source.replace('denyNetwork:deny','network:deny'),source+'class Duplicate {async _handleRequestNetworkAccess(x){let v=await provider.validateNetworkTarget(x);return v.alreadyAllowed}}',patch().source])
  expect(()=>patch(altered)).toThrow('boundary changed');
});

const nativePath=resolve(import.meta.dir,'../../../work/runtime-recovery/original/claude-science');
test.skipIf(!existsSync(nativePath))('The actual supported Mac core accepts checked guards and the conditional read-scope boundary',()=>{
 const originalSource=readFileSync(nativePath,'utf8'),result=patch(originalSource);parse(result.source,{sourceType:'unambiguous'});
 expect(result.edits).toHaveLength(nativeExecutionPolicyBoundaries.length);
 for(const edit of [...result.edits].sort((a,b)=>a.start-b.start)){
  const offset=result.edits.filter(other=>other.start<edit.start).reduce((sum,other)=>sum+other.text.length-(other.end-other.start),0);
  expect(result.source.slice(edit.start+offset,edit.start+offset+edit.text.length)).toBe(edit.text);
 }
 expect(result.source.length-originalSource.length).toBe(result.edits.reduce((sum,edit)=>sum+edit.text.length-(edit.end-edit.start),0));
},30000);
