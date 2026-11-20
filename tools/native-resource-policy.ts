import {createHash} from 'node:crypto';
import * as t from '@babel/types';
import {nativeRevision} from './native-revisions';

export type NativeResourceEdit={start:number;end:number;text:string;label:string};
/** These are server callbacks, not browser-provided permissions. The adapter
 * resolves current native actor scope and exact resource identities.
 *
 * metadata: authorize exact ID BEFORE calling read; revalidate on completion.
 * materialize: content uses a version ID. Path-only operations must resolve all
 * native references or require an already bound lease; never infer standard
 * status from a path. Raw HTTP/thumbnail/archive access is not inert preview.
 * filter: authorize each exact native version BEFORE returning any metadata.
 * save/saveUpload: capture trusted native context BEFORE write, await native
 * commit, then recordCreated BEFORE returning/broadcasting the result. Missing
 * context may pass only explicit disabled/no-history legacy compatibility.
 * withUploadRequest: resolve authenticated real composer root before file().
 * withConsumer: scope only the actual native submit frame and native user.
 * visible: use the current authorized metadata scope, never a Promise or a
 * browser flag. httpRead runs after original owner authorization.
 * None of these callbacks constitutes protectionEvidence or an OS sandbox. */
export interface NativeResourceCallbacks{
 metadata(owner:unknown,operation:{method:string;args:unknown[]},read:()=>Promise<unknown>):Promise<unknown>;
 materialize(owner:unknown,operation:{method:string;args:unknown[]},read:()=>Promise<unknown>):Promise<unknown>;
 filter(owner:unknown,operation:{method:string;args:unknown[]},rows:unknown):Promise<unknown>;
 save(owner:unknown,input:unknown,write:()=>Promise<unknown>):Promise<unknown>;
 saveUpload(owner:unknown,input:unknown,write:()=>Promise<unknown>):Promise<unknown>;
 /** Authenticate/resolve the actual composer frame before multipart iteration.
  * Feature-off unclassified draft compatibility is an explicit parent policy. */
 withUploadRequest(app:unknown,request:unknown,operation:()=>Promise<unknown>):Promise<unknown>;
 withConsumer(owner:unknown,input:{frameId:string|null;user:unknown},operation:()=>Promise<unknown>):Promise<unknown>;
 httpRead(owner:unknown,input:{user:unknown;metadata:unknown;id:unknown;label:unknown}):Promise<void>;
 /** Synchronous and fail-closed. Promise results must never be truthy permits. */
 visible(row:unknown,rootId:unknown,referencedArtifacts:unknown):boolean;
}
const prefix='globalThis.__scienceLocal.resourcePolicy';
const metadata=new Set(['get_artifact_metadata','get_version_metadata','get_artifact_metadata_lite','get_version_metadata_lite']);
const materializers=new Set(['_readVersionContent','_resolveVersionPath','open_version_fd_safe','resolve_storage_path_contained']);
const lists=new Set(['list_artifacts_for_project','list_artifacts_for_conversation','list_uploads_for_project','list_versions','list_versions_for_frame','list_versions_for_frame_subtree','list_artifact_lookup_rows']);
export const nativeResourcePolicyBoundaries=Object.freeze([
 ...[...metadata].map(n=>'native-resource-metadata-'+n),...[...materializers].map(n=>'native-resource-materialize-'+n),...[...lists].map(n=>'native-resource-filter-'+n),
 'native-resource-save-_saveArtifactCommon','native-resource-save-save_user_upload_streaming','native-resource-automatic-attachments','native-resource-conversation-predicate','native-resource-http-read','native-resource-upload-request',
]);

/** Guard actual native store/materialization and browser upload/auto-attachment
 * boundaries. No file is migrated, no lane is granted, and no runtime is edited
 * here. Callbacks must be installed before these edits can be used. */
export function nativeResourcePolicyEdits(ast:t.Node,source:string):NativeResourceEdit[]{
 const revision=nativeRevision(createHash('sha256').update(source).digest('hex'));
 const edits:NativeResourceEdit[]=[],seen=new Map<string,number>();
 const bad=(label:string):never=>{throw Error('Native resource policy boundary changed: '+label)};
 if(source.includes(prefix))bad('already-patched');
 const text=(node:t.Node)=>{if(node.start==null||node.end==null)bad('range');return source.slice(node.start!,node.end!)};
 const add=(node:t.Node,label:string,value:string)=>{seen.set(label,(seen.get(label)??0)+1);edits.push({start:node.start!,end:node.end!,label,text:value})};
 const wrap=(node:t.ClassMethod|t.ArrowFunctionExpression,label:string,call:string)=>{
  if(!t.isBlockStatement(node.body)||!node.async)bad(label);
  const body=node.body as t.BlockStatement;
  add(body,label,`{return await ${call}async()=>${text(body)})}`);
 };
 const storeClasses:Array<t.ClassDeclaration|t.ClassExpression>=[];
 t.traverseFast(ast,node=>{if((t.isClassDeclaration(node)||t.isClassExpression(node))&&['_readVersionContent','_saveArtifactCommon','save_user_upload_streaming'].every(name=>node.body.body.some(m=>t.isClassMethod(m)&&t.isIdentifier(m.key,{name}))))storeClasses.push(node)});
 if(storeClasses.length!==1)bad('store');
 const store=storeClasses[0];
 for(const node of store.body.body){
  if(!t.isClassMethod(node)||!t.isIdentifier(node.key))continue;const name=node.key.name;
  if(metadata.has(name))wrap(node,'native-resource-metadata-'+name,`${prefix}.metadata(this,{method:${JSON.stringify(name)},args:Array.from(arguments)},`);
  else if(materializers.has(name))wrap(node,'native-resource-materialize-'+name,`${prefix}.materialize(this,{method:${JSON.stringify(name)},args:Array.from(arguments)},`);
  else if(lists.has(name)){
   if(!node.async)bad(name);const body=text(node.body);add(node.body,'native-resource-filter-'+name,`{const __chimericResourceRows=await(async()=>${body})();return await ${prefix}.filter(this,{method:${JSON.stringify(name)},args:Array.from(arguments)},__chimericResourceRows)}`);
  }else if(name==='_saveArtifactCommon'||name==='save_user_upload_streaming'){
   if(node.params.length!==1||!t.isIdentifier(node.params[0]))bad(name);wrap(node,'native-resource-save-'+name,`${prefix}.${name==='_saveArtifactCommon'?'save':'saveUpload'}(this,${node.params[0].name},`);
  }
 }
 const functions:t.FunctionDeclaration[]=[];t.traverseFast(ast,node=>{if(t.isFunctionDeclaration(node)&&node.id)functions.push(node)});
 // Match original structure rather than transplanting platform-specific names.
 const submit=functions.filter(node=>text(node).includes('._attachments=')&&text(node).includes('.list_uploads_for_project('));
 if(submit.length!==1)bad('automatic-attachments');
 const calls:t.CallExpression[]=[];t.traverseFast(submit[0],node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'list_uploads_for_project'}))calls.push(node)});
 if(calls.length!==1||calls[0].arguments.length!==1||!t.isMemberExpression(calls[0].arguments[0])||!t.isIdentifier(calls[0].arguments[0].object))bad('automatic-attachments');
 const state=(calls[0].arguments[0] as t.MemberExpression).object as t.Identifier,owner=submit[0].params[0];if(!t.isIdentifier(owner))bad('automatic-attachments');
 const destructures=submit[0].body.body.filter(n=>t.isVariableDeclaration(n)).flatMap(n=>(n as t.VariableDeclaration).declarations).filter(n=>t.isObjectPattern(n.id));
 let user:string|undefined;for(const declaration of destructures){for(const field of (declaration.id as t.ObjectPattern).properties)if(t.isObjectProperty(field)&&t.isIdentifier(field.key,{name:'user'})&&t.isIdentifier(field.value))user=field.value.name}
 if(!user)bad('automatic-attachment-user');
 add(calls[0],'native-resource-automatic-attachments',`${prefix}.withConsumer(${(owner as t.Identifier).name},{frameId:${state.name}.frame_id??${state.name}.root_frame_id,user:${user}},()=>${text(calls[0])})`);
 const predicates=functions.filter(node=>text(node).includes('.root_frame_id===')&&text(node).includes('.is_user_upload||')&&text(node).length<250);
 if(predicates.length!==1||predicates[0].params.length!==2)bad('conversation-predicate');
 const predicate=predicates[0],returned=predicate.body.body[0];if(!t.isReturnStatement(returned)||!t.isArrowFunctionExpression(returned.argument)||!t.isExpression(returned.argument.body)||returned.argument.params.length!==1||![...predicate.params,...returned.argument.params].every(p=>t.isIdentifier(p)))bad('conversation-predicate');
 const root=(predicate.params[0] as t.Identifier).name,refs=(predicate.params[1] as t.Identifier).name,row=(returned.argument.params[0] as t.Identifier).name;
 add(returned.argument.body,'native-resource-conversation-predicate',`(${prefix}.visible(${row},${root},${refs})===true&&(${text(returned.argument.body)}))`);
 const ownership=functions.filter(node=>node.async&&node.params.length===5&&text(node).includes('e.dbRo')&&text(node).includes('"not_found"')&&text(node).includes('await lS('));
 // Linux has renamed symbols; match the authorizing try statement shape there.
 const candidates=revision.platform==='darwin-arm64'?ownership:functions.filter(node=>node.async&&node.params.length===5&&text(node).includes('.dbRo')&&text(node).includes('"not_found"')&&text(node).length<300);
 if(candidates.length!==1)bad('http-owner');const nativeOwner=candidates[0];if(!nativeOwner.params.every(p=>t.isIdentifier(p)))bad('http-owner');
 const guardBlock=nativeOwner.body.body[0];if(!t.isTryStatement(guardBlock)||guardBlock.block.body.length!==1||!t.isExpressionStatement(guardBlock.block.body[0])||!t.isAwaitExpression(guardBlock.block.body[0].expression))bad('http-owner');
 const [a,b,c,d,e]=nativeOwner.params as t.Identifier[],statement=guardBlock.block.body[0];
 edits.push({start:statement.end!,end:statement.end!,label:'native-resource-http-read',text:`;await ${prefix}.httpRead(${a.name},{user:${b.name},metadata:${c.name},id:${d.name},label:${e.name}});`});seen.set('native-resource-http-read',1);
 const uploadHandlers:t.ArrowFunctionExpression[]=[];t.traverseFast(ast,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'post'})&&t.isStringLiteral(node.arguments[0],{value:'/api/projects/:pid/attachments'})&&t.isArrowFunctionExpression(node.arguments[1]))uploadHandlers.push(node.arguments[1])});
 if(uploadHandlers.length!==1||uploadHandlers[0].params.length!==2||!uploadHandlers[0].params.every(p=>t.isIdentifier(p)))bad('upload-request');const handler=uploadHandlers[0];
 let app:string|undefined;t.traverseFast(handler.body,node=>{if(t.isCallExpression(node)&&t.isMemberExpression(node.callee)&&t.isIdentifier(node.callee.property,{name:'getUser'})&&t.isIdentifier(node.callee.object))app=node.callee.object.name});if(!app)bad('upload-request');
 wrap(handler,'native-resource-upload-request',`${prefix}.withUploadRequest(${app},${(handler.params[0] as t.Identifier).name},`);
 for(const label of nativeResourcePolicyBoundaries)if(seen.get(label)!==1)bad(label);
 const sorted=[...edits].sort((a,b)=>a.start-b.start);for(let i=1;i<sorted.length;i++)if(sorted[i].start<sorted[i-1].end)bad('overlap');return edits;
}
