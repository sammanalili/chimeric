import * as t from '@babel/types';

export type NativeExecutionEdit={start:number;end:number;text:string;label:string};
export type NativeExecutionKind='kernel'|'network-grant'|'tool'|'host-call'|'process'|'shell'|
 'sandbox-process'|'sandbox-shell'|'sandbox-provisioning'|'sandbox-operon'|'sandbox-byoc';
/** The runtime resolves scope from the native owner/context. Tool-supplied
 * frame/root fields are never authentication. Only process/shell options and
 * verified sandbox-process overrides may be returned. */
export type NativeExecutionGuard=(kind:NativeExecutionKind,owner:any,details:any)=>
 void|Record<string,any>|Promise<void|Record<string,any>>;

const required=['native-policy-kernel','native-policy-network-grant','native-policy-tool-dispatch',
 'native-policy-compute-dispatch','native-policy-registry-tool','native-policy-host-call',
 'native-policy-process','native-policy-shell','native-policy-wrapCommand','native-policy-wrapSubprocessArgs',
 'native-policy-wrapCondaCommand','native-policy-wrapCondaSubprocessArgs','native-policy-wrapInternalEnvCommand',
 'native-policy-wrapInternalEnvRunArgs','native-policy-wrapOperonSubprocessArgs','native-policy-wrapByocSubprocessArgs',
 'native-policy-analysis-read-scope','native-policy-analysis-read-paths','native-policy-analysis-minted-reads'];
export const nativeExecutionPolicyBoundaries=Object.freeze([...required]);

/** Checked insertions only. The caller verifies the full supported native source
 * revision. This helper neither proves OS isolation nor grants a lane. */
export function nativeExecutionPolicyEdits(ast:t.Node,source:string):NativeExecutionEdit[]{
 const edits:NativeExecutionEdit[]=[],seen=new Set<string>();
 const invalid=(label:string):never=>{throw Error('Native execution policy boundary changed: '+label)};
 if(source.includes('guardNativeExecution')||source.includes('__chimericNativeExecution'))invalid('already-patched');
 const text=(node:t.Node)=>{if(node.start==null||node.end==null)invalid('missing-range');return source.slice(node.start!,node.end!)};
 const insert=(body:t.BlockStatement,label:string,value:string)=>{
  if(seen.has(label)||body.start==null||source[body.start]!=='{')invalid(label);
  seen.add(label);edits.push({start:body.start!+1,end:body.start!+1,text:value,label});
 };
 const replace=(node:t.Node,label:string,value:string)=>{
  if(seen.has(label)||node.start==null||node.end==null)invalid(label);
  seen.add(label);edits.push({start:node.start!,end:node.end!,text:value,label});
 };
 const names=(node:t.FunctionDeclaration|t.ClassMethod)=>node.params.map(param=>{
  const value=t.isAssignmentPattern(param)?param.left:param;
  return t.isIdentifier(value)?value.name:invalid('parameters');
 });
 const calls=(node:t.Node,name:string)=>{
  const found:t.CallExpression[]=[];t.traverseFast(node,value=>{
   if(t.isCallExpression(value)&&t.isMemberExpression(value.callee)&&!value.callee.computed&&t.isIdentifier(value.callee.property,{name}))found.push(value);
  });return found;
 };
 const guard=(kind:NativeExecutionKind,owner:string,details:string)=>`globalThis.__scienceLocal.guardNativeExecution(${JSON.stringify(kind)},${owner},${details})`;
 // These names are the upstream first-party local tools.  They remain native
 // even when the runtime also advertises a same-named internal dispatch entry.
 // This classification never applies to arbitrary MCP names.
 const protectedNative=(name:string)=>`dEn.has(${name})||nNo.has(${name})||${JSON.stringify(['python','repl','save_artifacts','read_file'])}.includes(${name})`;
 const wrappers=new Map<string,NativeExecutionKind>([
  ['wrapCommand','sandbox-shell'],['wrapSubprocessArgs','sandbox-process'],
  ['wrapCondaCommand','sandbox-provisioning'],['wrapCondaSubprocessArgs','sandbox-provisioning'],
  ['wrapInternalEnvCommand','sandbox-provisioning'],['wrapInternalEnvRunArgs','sandbox-provisioning'],
  ['wrapOperonSubprocessArgs','sandbox-operon'],['wrapByocSubprocessArgs','sandbox-byoc'],
 ]);
 t.traverseFast(ast,node=>{
  if(t.isClassMethod(node)&&t.isIdentifier(node.key)){
   const name=node.key.name,body=text(node.body);
   if(!['_getOrCreateKernel','_handleRequestNetworkAccess','_executeToolCallsInner','_executeComputeTool'].includes(name)&&!wrappers.has(name)&&!(name==='invokeTool'&&body.includes('this._executeLocalTool(')))return;
   const args=names(node);
   if(name==='_getOrCreateKernel'){
    if(!node.async||args.length!==5||!body.includes('this._frameContext.get(')||!body.includes('this._dictLock.acquire(')||calls(node.body,'start').length<1)invalid('kernel');
    insert(node.body,'native-policy-kernel',`await ${guard('kernel','this',`{frameId:${args[0]},environment:${args[1]},kernelConstructor:${args[3]}}`)};`);
   }else if(name==='_handleRequestNetworkAccess'){
    if(!node.async||args.length!==1||calls(node.body,'validateNetworkTarget').length!==1||!body.includes('alreadyAllowed'))invalid('network-grant');
    insert(node.body,'native-policy-network-grant',`await ${guard('network-grant','this',`{request:${args[0]}}`)};`);
   }else if(name==='_executeToolCallsInner'){
    if(!node.async||args.length!==2||!body.includes('this._flattenedMcpDispatch')||!body.includes('this._executeComputeTool(')||!body.includes('dEn.has(')||!body.includes('nNo.has('))invalid('tool-dispatch');
    const loops:t.ForOfStatement[]=[];t.traverseFast(node.body,value=>{if(t.isForOfStatement(value)&&t.isIdentifier(value.right,{name:args[0]}))loops.push(value)});
    const loop=loops[0],binding=loop&&t.isVariableDeclaration(loop.left)&&loop.left.declarations.length===1?loop.left.declarations[0].id:undefined;
    if(loops.length!==1||!t.isIdentifier(binding)||!t.isBlockStatement(loop.body))invalid('tool-dispatch');
    const call=(binding as t.Identifier).name;
    // The native router classifies its own compute tools before calling this
    // loop.  A name supplied only by a flattened MCP server is absent from
    // both sets, even when an MCP name collides with a built-in name.
    insert(loop.body as t.BlockStatement,'native-policy-tool-dispatch',`try{await ${guard('tool','this',`{tool:${call},flattenedMcp:this._flattenedMcpDispatch.has(${call}.name),nativeTool:${protectedNative(call+'.name')},phase:"dispatch"}`)}}catch(__chimericNativeExecutionError){await this._appendToolResult(${args[1]},${call}.id,JSON.stringify({error:__chimericNativeExecutionError instanceof Error?__chimericNativeExecutionError.message:String(__chimericNativeExecutionError)}),{isError:true,provenance:"direct"});continue;}`);
   }else if(name==='_executeComputeTool'){
    const first=node.body.body[0];
    if(!node.async||args.length!==3||!t.isTryStatement(first)||!body.includes('this._flattenedMcpDispatch.get(')||!body.includes('compute_provider'))invalid('compute-dispatch');
    insert((first as t.TryStatement).block,'native-policy-compute-dispatch',`await ${guard('tool','this',`{tool:${args[0]},flattenedMcp:this._flattenedMcpDispatch.has(${args[0]}.name),nativeTool:${protectedNative(args[0]+'.name')},phase:"compute"}`)};`);
   }else if(name==='invokeTool'&&body.includes('this._executeLocalTool(')){
    const blocks=node.body.body.filter(value=>t.isTryStatement(value));
    if(!node.async||args.length!==16||blocks.length!==1||calls(node.body,'_executeLocalTool').length!==1)invalid('registry-tool');
    insert(blocks[0].block,'native-policy-registry-tool',`await ${guard('tool','this',`{tool:{name:${args[1]},input:${args[2]}},agentName:${args[0]},frameId:${args[3]},rootFrameId:${args[4]},projectId:${args[5]},phase:"registry"}`)};`);
   }
   if(wrappers.has(name)&&calls(node.body,'isAvailable').some(call=>t.isMemberExpression(call.callee)&&t.isThisExpression(call.callee.object))){
    if(!node.async||!body.includes('if(!this.isAvailable())return'))invalid(name);
    let details=`{method:${JSON.stringify(name)},args:Array.from(arguments)}`;
    if(name==='wrapSubprocessArgs'){
     if(args.length!==11||calls(node.body,'_deriveSubprocessWrap').length!==1||!body.includes('denyNetwork:'))invalid(name);
     details=`{method:${JSON.stringify(name)},frameId:${args[2]},environment:${args[3]},untrustedArgs:${args[4]},projectId:${args[5]},frameSecretsDir:${args[8]},denyNetwork:${args[9]}}`;
     insert(node.body,'native-policy-'+name,`const __chimericNativeExecution=await ${guard('sandbox-process','this',details)};if(__chimericNativeExecution?.denyNetwork===true)${args[9]}=true;if(__chimericNativeExecution?.hideFrameSecrets===true)${args[8]}=undefined;`);
     const declarations:t.VariableDeclarator[]=[];t.traverseFast(node.body,value=>{
      if(t.isVariableDeclarator(value)&&t.isObjectPattern(value.id)&&t.isAwaitExpression(value.init)&&t.isCallExpression(value.init.argument)&&t.isMemberExpression(value.init.argument.callee)&&t.isIdentifier(value.init.argument.callee.property,{name:'_deriveSubprocessWrap'}))declarations.push(value);
     });
     const derived=declarations[0],roots=calls(node.body,'_macosPinnedRootsForProfile');
     if(declarations.length!==1||roots.length!==1||!t.isObjectPattern(derived.id))invalid('analysis-read-scope');
     const binding=(name:string)=>{const property=(derived.id as t.ObjectPattern).properties.find(value=>t.isObjectProperty(value)&&!value.computed&&t.isIdentifier(value.key,{name}));return t.isObjectProperty(property)&&t.isIdentifier(property.value)?property.value.name:invalid('analysis-read-scope')};
     const spec=binding('spec'),readable=binding('readablePaths'),writable=binding('writablePaths'),root=roots[0];
     const config=binding('config'),daemonWritable=binding('daemonWritablePaths'),daemonReadable=binding('daemonReadablePaths');
     if(root.arguments.length!==2||!t.isIdentifier(root.arguments[0],{name:spec})||!t.isIdentifier(root.arguments[1],{name:readable}))invalid('analysis-read-scope');
     const profiles:t.CallExpression[]=[];t.traverseFast(node.body,value=>{
      if(t.isCallExpression(value)&&t.isIdentifier(value.callee)&&value.arguments.length===7&&t.isIdentifier(value.arguments[0],{name:config})&&t.isIdentifier(value.arguments[1],{name:writable})&&t.isIdentifier(value.arguments[2],{name:readable})&&t.isIdentifier(value.arguments[4],{name:daemonWritable})&&t.isIdentifier(value.arguments[6],{name:daemonReadable}))profiles.push(value);
     });
     if(profiles.length!==1)invalid('analysis-read-paths');
     // The native renderer only reallows declared read candidates. Add the
     // already-derived current-frame writable roots as native minted reads;
     // a pinned path alone would remove siblings but also block our own code.
     replace(profiles[0].arguments[2] as t.Node,'native-policy-analysis-read-paths',`(__chimericNativeExecution?.denyNetwork===true?[...${readable},...${writable}]:${readable})`);
     replace(profiles[0].arguments[6] as t.Node,'native-policy-analysis-minted-reads',`(__chimericNativeExecution?.denyNetwork===true?[...${daemonReadable},...${daemonWritable}]:${daemonReadable})`);
     // Reuse the native canonical/pinned path builder. Its normal analysis
     // roots include all frame workspaces; protected reads use only this
     // invocation's native readable/writable roots. Standard calls are exact.
     replace(root,'native-policy-analysis-read-scope',`((__chimericNativeRoots)=>__chimericNativeExecution?.denyNetwork===true?{...__chimericNativeRoots,read:this._macosPinnedRootsForProfile({...${spec},macosPinnedRoots:"profileReadList"},[...${readable},...${writable}]).read}:__chimericNativeRoots)(${text(root)})`);
    }else insert(node.body,'native-policy-'+name,`await ${guard(wrappers.get(name)!,'this',details)};`);
   }
  }else if(t.isFunctionDeclaration(node)){
   const body=text(node.body);
   if(!(calls(node.body,'wrapSubprocessArgs').length&&calls(node.body,'wrapByocSubprocessArgs').length)&&!(calls(node.body,'wrapCommand').length&&body.includes('.extraEnv')&&body.includes('.frameId'))&&!(body.includes('case"credentials_request"')&&body.includes('case"mcp"')&&body.includes('case"model_endpoints_register"')))return;
   const args=names(node);
   if(calls(node.body,'wrapSubprocessArgs').length&&calls(node.body,'wrapByocSubprocessArgs').length){
    const call=calls(node.body,'wrapCondaSubprocessArgs')[0];
    const owner=call&&t.isMemberExpression(call.callee)?call.callee.object:undefined;
    if(!node.async||args.length!==3||calls(node.body,'wrapSubprocessArgs').length!==1||!t.isCallExpression(owner)||owner.arguments.length||!t.isIdentifier(owner.callee)||!body.includes('.denyNetwork'))invalid('process');
    insert(node.body,'native-policy-process',`${args[2]}=(await ${guard('process',text(owner!),args[2])})??${args[2]};`);
   }else if(calls(node.body,'wrapCommand').length&&body.includes('.extraEnv')&&body.includes('.frameId')){
    const call=calls(node.body,'wrapCommand')[0],owner=t.isMemberExpression(call.callee)?call.callee.object:undefined;
    if(!node.async||args.length!==2||calls(node.body,'wrapCommand').length!==1||!t.isCallExpression(owner)||owner.arguments.length||!t.isIdentifier(owner.callee))invalid('shell');
    insert(node.body,'native-policy-shell',`${args[1]}=(await ${guard('shell',text(owner!),args[1])})??${args[1]};`);
   }
   const last=node.body.body.at(-1);
   if(body.includes('case"credentials_request"')&&body.includes('case"mcp"')&&body.includes('case"model_endpoints_register"')){
    const handler=t.isReturnStatement(last)?last.argument:undefined;
    if(args.length!==2||!t.isArrowFunctionExpression(handler)||!handler.async||!t.isBlockStatement(handler.body)||handler.params.length!==6||!handler.params.every(value=>t.isIdentifier(value)))invalid('host-call');
    const values=(handler!.params as t.Identifier[]).map(value=>value.name);
    insert((handler as t.ArrowFunctionExpression).body as t.BlockStatement,'native-policy-host-call',`await ${guard('host-call',args[1],`{method:${values[0]},args:${values[1]},signal:${values[2]},softSignal:${values[4]}}`)};`);
   }
  }
 });
 for(const label of required)if(!seen.has(label))invalid(label);
 return edits;
}
