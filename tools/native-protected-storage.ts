import * as t from '@babel/types';
export type NativeProtectedStorageEdit={start:number;end:number;text:string;label:string};
export const nativeProtectedStorageBoundaries=Object.freeze(['native-private-workspace','native-private-kernel-base','native-private-spawn-layout','native-private-policy-1','native-private-policy-2']);
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
  if(t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name:names.policy})){
   if(node.params.length!==8||!t.isIdentifier(node.params[0])||!text(node.body).includes('SBPL')&&!text(node.body).includes('profile size ceiling'))fail('policy');const render:t.CallExpression[]=[];
   t.traverseFast(node.body,value=>{if(t.isCallExpression(value)&&t.isIdentifier(value.callee,{name:names.render}))render.push(value)});
   if(render.length!==2)fail('policy');render.forEach((call,index)=>add(call,'native-private-policy-'+(index+1),`globalThis.__scienceLocal.nativeProtectedStoragePolicy(${(node.params[0] as t.Identifier).name},${text(call)})`));
  }
 });
 for(const name of nativeProtectedStorageBoundaries)if(!seen.has(name))fail(name);return edits;
}
