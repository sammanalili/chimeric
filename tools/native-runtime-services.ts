import * as t from '@babel/types';
export type NativeRuntimeServicesEdit={start:number;end:number;text:string;label:string};
export const nativeRuntimeServicesBoundaries=Object.freeze(['native-runtime-services','native-runtime-agent-enter','native-runtime-agent-leave','native-runtime-task-enter','native-runtime-task-leave','native-runtime-background']);

/** Register the actual assembled native services and retain the actual promises,
 * rather than treating native abort counters or placeholder promises as drain. */
export function nativeRuntimeServicesEdits(ast:t.Node,source:string):NativeRuntimeServicesEdit[]{
 const edits:NativeRuntimeServicesEdit[]=[],seen=new Set<string>();
 const fail=(label:string):never=>{throw Error('Native runtime services boundary changed: '+label)};
 if(source.includes('registerNativeRuntimeServices(')||source.includes('withNativeAgentJob('))fail('already-patched');
 const text=(node:t.Node)=>{if(node.start==null||node.end==null)fail('range');return source.slice(node.start!,node.end!)};
 const add=(node:t.Node,label:string,value:string,where:'replace'|'start'|'end'='replace')=>{
  if(seen.has(label)||node.start==null||node.end==null)fail(label);seen.add(label);
  const start=where==='start'?node.start!+1:where==='end'?node.end!-1:node.start!;
  edits.push({start,end:where==='replace'?node.end!:start,text:value,label});
 };
 const properties=(node:t.ObjectExpression)=>node.properties.map(p=>t.isObjectProperty(p)&&t.isIdentifier(p.key)&&!p.computed?p.key.name:'?');
 let reviewerMap:string|undefined,abortReviewer:string|undefined,reviewerInit:string|undefined;
 t.traverseFast(ast,node=>{
  if(t.isFunctionDeclaration(node)&&node.id&&node.params.length===1&&t.isIdentifier(node.params[0])){
   const body=text(node.body);
   if(body.length<300&&body.includes('.regCtx?.rootFrameId===')&&node.body.body.length===1&&t.isForOfStatement(node.body.body[0])){
    const loop=node.body.body[0];if(!t.isIdentifier(loop.right)||!t.isIfStatement(loop.body)||!t.isExpressionStatement(loop.body.consequent)||!t.isCallExpression(loop.body.consequent.expression)||!t.isIdentifier(loop.body.consequent.expression.callee))fail('reviewer-map');
    if(reviewerMap)fail('reviewer-map');reviewerMap=loop.right.name;abortReviewer=node.id.name;
   }
  }
 });
 if(!reviewerMap||!abortReviewer)fail('reviewer-map');
 t.traverseFast(ast,node=>{
  if(t.isVariableDeclarator(node)&&t.isIdentifier(node.id)&&t.isCallExpression(node.init)&&node.init.arguments.some(a=>t.isArrowFunctionExpression(a))){
   const matches:t.AssignmentExpression[]=[];t.traverseFast(node.init,value=>{if(t.isAssignmentExpression(value)&&t.isIdentifier(value.left,{name:reviewerMap})&&t.isNewExpression(value.right)&&t.isIdentifier(value.right.callee,{name:'Map'}))matches.push(value)});
   if(matches.length){if(matches.length!==1||reviewerInit)fail('reviewer-initializer');reviewerInit=node.id.name}
  }
 });if(!reviewerInit)fail('reviewer-initializer');
 t.traverseFast(ast,node=>{
  if(t.isVariableDeclarator(node)&&t.isObjectExpression(node.init)){
   const keys=properties(node.init);
   if(keys.length===12&&['db','dbRo','openReadSnapshot','registry','services','agentSvc','log','credentialResolver','skillCatalogProvider','skillCacheRoot','orgDataDir'].every(k=>keys.includes(k)))fail('service-context-schema');
   if(keys.length===11&&['db','dbRo','openReadSnapshot','registry','services','agentSvc','log','credentialResolver','skillCatalogProvider','skillCacheRoot','orgDataDir'].every(k=>keys.includes(k))){
    const controls=`{reviewers(root){${reviewerInit}();return Array.from(${reviewerMap},([frameId,row])=>({frameId,rootFrameId:row.regCtx?.rootFrameId??frameId,inFlight:[...row.inFlight],controller:row.abort,hasTimer:row.holdTimer!=null,pending:row.pendingUnit!=null})).filter(row=>row.frameId===root||row.rootFrameId===root)},abortReviewers(root){${reviewerInit}();${abortReviewer}(root)}}`;
    add(node.init,'native-runtime-services',`globalThis.__scienceLocal.registerNativeRuntimeServices(${text(node.init)},${controls})`);
   }
  }
  if(t.isClassDeclaration(node)){
   const methods=node.body.body.filter(value=>t.isClassMethod(value)) as t.ClassMethod[];
   const selected=methods.find(value=>t.isIdentifier(value.key,{name:'executeRequest'}));
   if(selected&&methods.some(value=>t.isIdentifier(value.key,{name:'_executeRequestInner'}))&&methods.some(value=>t.isIdentifier(value.key,{name:'cancelConversation'}))){
    if(!selected.async||selected.params.length!==1||!t.isIdentifier(selected.params[0])||!text(selected.body).includes('this.services.providers')||!text(selected.body).includes('this._executeRequestInner('))fail('agent');
    add(selected.body,'native-runtime-agent-enter',`return globalThis.__scienceLocal.withNativeAgentJob(this,${selected.params[0].name},()=>{`,'start');add(selected.body,'native-runtime-agent-leave','});','end');
   }
  }
  if(t.isFunctionDeclaration(node)&&node.id){
   const body=text(node.body);
   if(body.length<200&&body.includes('.run({taskSource:e,rootFrameId:n},t)')){
    if(node.params.length!==3||!t.isAssignmentPattern(node.params[2])||!t.isIdentifier(node.params[2].left))fail('task');
    add(node.body,'native-runtime-task-enter',`return globalThis.__scienceLocal.withNativeRootTask(${node.params[2].left.name},()=>{`,'start');add(node.body,'native-runtime-task-leave','});','end');
   }
   if(body.length<150&&body.includes('.add(e)')&&body.includes('.then(t,t)')&&body.includes('.delete(e)')){
    if(node.params.length!==1||!t.isIdentifier(node.params[0]))fail('background');add(node.body,'native-runtime-background',`globalThis.__scienceLocal.trackNativeBackground(${node.params[0].name});`,'start');
   }
  }
 });
 for(const name of nativeRuntimeServicesBoundaries)if(!seen.has(name))fail(name);return edits;
}
