import * as t from '@babel/types';
export type NativeProtectedStorageEdit={start:number;end:number;text:string;label:string};
export const nativeProtectedStorageBoundaries=Object.freeze(['native-private-workspace','native-private-kernel-base','native-private-spawn-layout','native-private-policy-1','native-private-policy-2','native-private-host-artifact-path','native-private-grant-validate','native-private-grant-browse','native-private-grant-change','native-private-grant-revoke']);
type InnerEdit={start:number;end:number;text:string};
const nodeText=(source:string,node:t.Node)=>{if(node.start==null||node.end==null)throw Error('Native protected resource boundary changed: range');return source.slice(node.start,node.end)};
const rewrite=(source:string,node:t.Node,edits:InnerEdit[])=>{let value=nodeText(source,node);for(const edit of [...edits].sort((a,b)=>b.start-a.start)){const start=edit.start-node.start!,end=edit.end-node.start!;value=value.slice(0,start)+edit.text+value.slice(end)}return value};
const inside=(outer:t.Node,inner:t.Node)=>outer.start!=null&&outer.end!=null&&inner.start!=null&&inner.end!=null&&outer.start<=inner.start&&outer.end>=inner.end;

/** Rewrite the body that native-resource-policy wraps. Keeping this transform
 * inside that outer authorization wrapper avoids overlapping source edits and
 * guarantees policy classification remains the last step before return. */
export function nativeProtectedResourceBody(method:t.ClassMethod,source:string,name:string){
 const fail=():never=>{throw Error('Native protected resource boundary changed: '+name)};
 const text=(node:t.Node)=>nodeText(source,node),edits:InnerEdit[]=[];
 const insert=(value:string)=>edits.push({start:method.body.start!+1,end:method.body.start!+1,text:value});
 if(name==='_saveArtifactCommon'||name==='save_user_upload_streaming'){
  const calls:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isThisExpression(node.callee.object)&&t.isIdentifier(node.callee.property,{name:'_versionPath'}))calls.push(node)});
  const version=calls[0];if(calls.length!==1||version.arguments.length!==4||version.arguments.some(value=>t.isSpreadElement(value)||t.isJSXNamespacedName(value)||t.isArgumentPlaceholder(value)))fail();
  const bindingFor=(expression:t.Expression)=>{const names:string[]=[];t.traverseFast(method.body,node=>{if(t.isAssignmentExpression(node)&&node.right===expression&&t.isIdentifier(node.left))names.push(node.left.name);if(t.isVariableDeclarator(node)&&node.init===expression&&t.isIdentifier(node.id))names.push(node.id.name)});if(names.length!==1)fail();return names[0]};
  const pathName=bindingFor(version),relatives:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'relative'})&&node.arguments.length===2&&t.isIdentifier(node.arguments[1],{name:pathName}))relatives.push(node)});if(relatives.length!==1)fail();
  const storageName=bindingFor(relatives[0]);
  insert('let __chimericProtectedWrite;');
  const args=version.arguments.map(value=>text(value as t.Node));
  edits.push({start:version.start!,end:version.end!,text:`((__chimericProtectedWrite=globalThis.__scienceLocal.nativeProtectedResourceWrite({kind:${JSON.stringify(name==='_saveArtifactCommon'?'artifact':'upload')},projectId:${args[0]},artifactId:${args[1]},versionId:${args[2]},filename:${args[3]}}))?.absolutePath??${text(version)})`});
  edits.push({start:relatives[0].start!,end:relatives[0].end!,text:`(__chimericProtectedWrite?.storagePath??${text(relatives[0])})`});
  const io:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&node.arguments.length>=2&&t.isMemberExpression(node.arguments[0])&&t.isThisExpression(node.arguments[0].object)&&t.isPrivateName(node.arguments[0].property)&&t.isIdentifier(node.arguments[1],{name:storageName}))io.push(node)});if(io.length!==3)fail();
  for(const call of io){edits.push({start:(call.arguments[0] as t.Node).start!,end:(call.arguments[0] as t.Node).end!,text:`(__chimericProtectedWrite?.basePath??${text(call.arguments[0] as t.Node)})`},{start:(call.arguments[1] as t.Node).start!,end:(call.arguments[1] as t.Node).end!,text:`(__chimericProtectedWrite?.relativePath??${storageName})`})}
  if(name==='_saveArtifactCommon'){
   for(const member of ['_preVerifyDedupCandidate','_pruneToVersion']){const found:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isThisExpression(node.callee.object)&&t.isIdentifier(node.callee.property,{name:member}))found.push(node)});if(found.length!==1)fail();const choices:t.IfStatement[]=[];t.traverseFast(method.body,node=>{if(t.isIfStatement(node)&&inside(node,found[0]))choices.push(node)});choices.sort((a,b)=>(a.end!-a.start!)-(b.end!-b.start!));if(!choices[0])fail();edits.push({start:choices[0].test.start!,end:choices[0].test.end!,text:`!__chimericProtectedWrite&&(${text(choices[0].test)})`})}
  }else{
   const removed:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'rmdir'}))removed.push(node)});if(removed.length!==1)fail();edits.push({start:removed[0].start!,end:removed[0].end!,text:`(__chimericProtectedWrite?Promise.resolve():${text(removed[0])})`});
  }
 }else if(name==='_readVersionContent'){
  if(method.params.length!==1||!t.isIdentifier(method.params[0]))fail();const input=method.params[0].name,branches=method.body.body.filter(value=>t.isIfStatement(value)) as t.IfStatement[];if(!branches[0])fail();
  insert(`const __chimericProtectedPath=globalThis.__scienceLocal.nativeProtectedStoredPath(${input}.storagePath);`);edits.push({start:branches[0].start!,end:branches[0].end!,text:`if(__chimericProtectedPath){t=__chimericProtectedPath.basePath;n=__chimericProtectedPath.relativePath;r=__chimericProtectedPath.absolutePath}else ${text(branches[0])}`});
 }else if(name==='_resolveVersionPath'||name==='open_version_fd_safe'){
  if(method.params.length!==1||!t.isIdentifier(method.params[0]))fail();const input=method.params[0].name;
  let protectedReturn='return __chimericProtectedPath.absolutePath;';if(name==='open_version_fd_safe'){const opens:t.CallExpression[]=[];t.traverseFast(method.body,node=>{if(t.isCallExpression(node)&&node.arguments.length===2&&t.isMemberExpression(node.arguments[0])&&t.isIdentifier(node.arguments[0].property,{name:'containRoot'})&&t.isMemberExpression(node.arguments[1])&&t.isIdentifier(node.arguments[1].property,{name:'abs'}))opens.push(node)});if(opens.length!==1)fail();protectedReturn=`try{return ${text(opens[0].callee)}(__chimericProtectedPath.basePath,__chimericProtectedPath.relativePath)}catch{return null}`}
  insert(`const __chimericProtectedPath=globalThis.__scienceLocal.nativeProtectedStoredPath(${name==='_resolveVersionPath'?input+'.storagePath':input});if(__chimericProtectedPath)${protectedReturn}`);
 }else return text(method.body);
 return rewrite(source,method.body,edits);
}
/** The full native revision is pinned by the builder. Standard callbacks must
 * return their original value unchanged. Protected values come from a daemon
 * branded storage plan, never from a serialized flag or model-supplied path. */
export function nativeProtectedStorageEdits(
 ast:t.Node,
 source:string,
 names:{policy:string;render:string}={policy:'Eei',render:'zjn'},
):NativeProtectedStorageEdit[]{
 const edits:NativeProtectedStorageEdit[]=[],seen=new Set<string>(),fail=(name:string):never=>{throw Error('Native protected storage boundary changed: '+name)};
 if(source.includes('nativeProtectedSpawnPaths(')||source.includes('nativeProtectedWorkspacePath('))fail('already-patched');
 const text=(node:t.Node)=>{if(node.start==null||node.end==null)fail('range');return source.slice(node.start!,node.end!)};
 const add=(node:t.Node,label:string,value:string)=>{if(seen.has(label)||node.start==null||node.end==null)fail(label);seen.add(label);edits.push({start:node.start!,end:node.end!,text:value,label})};
 const insert=(position:number,label:string,value:string)=>{if(seen.has(label))fail(label);seen.add(label);edits.push({start:position,end:position,text:value,label})};
 t.traverseFast(ast,node=>{
  if(t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name:'af'})){
   if(node.params.length!==1||!t.isIdentifier(node.params[0])||node.body.body.length!==1||!t.isReturnStatement(node.body.body[0]))fail('workspace');
   const value=(node.body.body[0] as t.ReturnStatement).argument;
   if(!t.isSequenceExpression(value)||value.expressions.length!==2||!text(value).includes('.workspaceBase,')||!t.isCallExpression(value.expressions[1]))fail('workspace');
   add(value.expressions[1],'native-private-workspace',`globalThis.__scienceLocal.nativeProtectedWorkspacePath(${(node.params[0] as t.Identifier).name},${text(value.expressions[1])})`);
  }
  if(t.isClassMethod(node)&&t.isIdentifier(node.key,{name:'_getOrCreateKernel'})){
   if(node.params.length!==5||!node.params.every(p=>t.isIdentifier(p)))fail('kernel');const frame=(node.params[0] as t.Identifier).name,Constructor=(node.params[3] as t.Identifier).name,found:t.NewExpression[]=[];
   t.traverseFast(node.body,value=>{if(t.isNewExpression(value)&&t.isIdentifier(value.callee,{name:Constructor}))found.push(value)});
   if(found.length!==1||found[0].arguments.length!==4||!t.isLogicalExpression(found[0].arguments[1],{operator:'??'})||!text(found[0].arguments[1]).endsWith('this._workspaceBase'))fail('kernel');
   const value=found[0].arguments[1] as t.Node;add(value,'native-private-kernel-base',`globalThis.__scienceLocal.nativeProtectedKernelBase(this,${frame},${text(value)})`);
  }
  if(t.isClassMethod(node)&&t.isIdentifier(node.key,{name:'_deriveSubprocessWrap'})){
   if(!node.async||node.params.length!==1||!t.isIdentifier(node.params[0])||!text(node.body).includes('frameSecretsDir:')||!text(node.body).includes('daemonReadablePaths:'))fail('spawn');
   const objects:t.ObjectExpression[]=[];t.traverseFast(node.body,value=>{if(t.isReturnStatement(value)&&t.isSequenceExpression(value.argument)&&t.isObjectExpression(value.argument.expressions.at(-1)))objects.push(value.argument.expressions.at(-1) as t.ObjectExpression)});
   if(objects.length!==1||!text(objects[0]).includes('caBundlePath:'))fail('spawn');add(objects[0],'native-private-spawn-layout',`globalThis.__scienceLocal.nativeProtectedSpawnPaths(this,${node.params[0].name},${text(objects[0])})`);
  }
  if(t.isClassMethod(node)&&t.isIdentifier(node.key)){
   const name=node.key.name,body=text(node.body),path=node.params[0];
   if(!t.isIdentifier(path))return;
   if(name==='validateHostTarget'&&body.includes('Already accessible: the path is inside an operon-managed')&&body.includes('realpathSync.native')){
    const declarations=node.body.body.filter(value=>t.isVariableDeclaration(value)&&text(value).includes('.homedir()')) as t.VariableDeclaration[];
    const binding=declarations[0]?.declarations.find(value=>t.isIdentifier(value.id));if(declarations.length!==1||!binding||!t.isIdentifier(binding.id))fail('grant-validate');
    insert(declarations[0].end!,'native-private-grant-validate',`;globalThis.__scienceLocal.nativeProtectedGrantPath(${binding.id.name});`);
   }else if(name==='listDirectory'&&body.includes('Directory is not under $HOME or a granted root.'))insert(node.body.start!+1,'native-private-grant-browse',`globalThis.__scienceLocal.nativeProtectedGrantPath(${path.name});`);
   else if(name==='changeMode'&&body.includes('holdPreflightInPlay')&&body.includes('probeRwRootHoldable'))insert(node.body.start!+1,'native-private-grant-change',`globalThis.__scienceLocal.nativeProtectedGrantPath(${path.name});`);
   else if(name==='revoke'&&body.includes('removeApprovalBind')&&body.includes('.revoke("host"'))insert(node.body.start!+1,'native-private-grant-revoke',`globalThis.__scienceLocal.nativeProtectedGrantPath(${path.name});`);
  }
  if(t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name:names.policy})){
   if(node.params.length!==8||!t.isIdentifier(node.params[0])||!text(node.body).includes('SBPL')&&!text(node.body).includes('profile size ceiling'))fail('policy');const render:t.CallExpression[]=[];
   t.traverseFast(node.body,value=>{if(t.isCallExpression(value)&&t.isIdentifier(value.callee,{name:names.render}))render.push(value)});
   if(render.length!==2)fail('policy');render.forEach((call,index)=>add(call,'native-private-policy-'+(index+1),`globalThis.__scienceLocal.nativeProtectedStoragePolicy(${(node.params[0] as t.Identifier).name},${text(call)})`));
  }
  if(t.isFunctionDeclaration(node)&&node.params.length===2&&node.params.every(value=>t.isIdentifier(value))&&text(node.body).includes('case"artifact_path"')&&text(node.body).includes('case"credentials_request"')){
   const cases:t.SwitchCase[]=[];t.traverseFast(node.body,value=>{if(t.isSwitchCase(value)&&t.isStringLiteral(value.test,{value:'artifact_path'}))cases.push(value)});if(cases.length!==1)fail('host-artifact-path');
   const returns:t.ReturnStatement[]=[];t.traverseFast(cases[0],value=>{if(t.isReturnStatement(value)&&t.isMemberExpression(value.argument)&&t.isIdentifier(value.argument.property,{name:'path'}))returns.push(value)});if(returns.length!==1||!returns[0].argument)fail('host-artifact-path');
   const owner=(node.params[1] as t.Identifier).name;add(returns[0].argument,'native-private-host-artifact-path',`globalThis.__scienceLocal.nativeProtectedHostPath(${owner}.frameId,${text(returns[0].argument)},"read")`);
  }
 });
 for(const name of nativeProtectedStorageBoundaries)if(!seen.has(name))fail(name);return edits;
}
