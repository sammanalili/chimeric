import {createHash} from 'node:crypto';
import * as t from '@babel/types';

export type NativeUploadEdit={start:number;end:number;text:string;label:string};
const methodHashes={
 uploadProjectAttachment:'02b3f1d0927f2cc086406962914da859dbc5c964917cd062385f4ae65f48ce33',
 _uploadProjectAttachmentChunked:'277d86a77f5c1d962edb33520f0e23322e0cd218e3b44ec6f6e131b52280946e',
 sessionActions:'200bc2d193c60ec9380663bfe12ccb1b12d84bbbffb53ac3360e35a30fa6b9a2',
};
const fail=(label:string):never=>{throw Error('Native upload context boundary changed: '+label)};
const sourceOf=(source:string,node:t.Node)=>{if(node.start==null||node.end==null)fail('source range');return source.slice(node.start,node.end)};
const checked=(source:string,node:t.Node,hash:string,label:string)=>{const value=sourceOf(source,node);if(createHash('sha256').update(value).digest('hex')!==hash)fail(label+' integrity');return value};
const once=(source:string,from:string,to:string,label:string)=>{if(source.split(from).length!==2)fail(label);return source.replace(from,to)};

/** Bind every browser upload request to the active saved composer frame. The
 * server resolves that frame against native ownership before reading multipart
 * bytes. A browser-supplied ID is a lookup key, never authority. */
export function nativeUploadContextEdits(ast:t.Node,source:string,fileName:string):NativeUploadEdit[]{
 const file=fileName.split('/').at(-1),edits:NativeUploadEdit[]=[];
 if(file==='index-BgpYmw3d.js'){
  const methods=new Map<string,t.ClassMethod[]>();
  t.traverseFast(ast,node=>{if(t.isClassMethod(node)&&t.isIdentifier(node.key)&&Object.hasOwn(methodHashes,node.key.name)){const rows=methods.get(node.key.name)??[];rows.push(node);methods.set(node.key.name,rows)}});
  const upload=methods.get('uploadProjectAttachment')??[],chunked=methods.get('_uploadProjectAttachmentChunked')??[];
  if(upload.length!==1||chunked.length!==1)fail('upload methods');
  let value=checked(source,upload[0],methodHashes.uploadProjectAttachment,'uploadProjectAttachment');
  value=once(value,'async uploadProjectAttachment(t,n,r=!1,s,o){','async uploadProjectAttachment(t,n,r=!1,s,o,chimericFrameId){','upload parameter');
  value=once(value,'bytes:d,ephemeral:r})','bytes:d,ephemeral:r,frame_id:chimericFrameId})','EIPC frame binding');
  value=once(value,'this._uploadProjectAttachmentChunked(t,n,s,o)','this._uploadProjectAttachmentChunked(t,n,s,o,chimericFrameId)','chunked frame binding');
  value=once(value,'r&&c.searchParams.set("ephemeral","true"),s==null||s(0,n.size);','chimericFrameId&&c.searchParams.set("frameId",chimericFrameId),r&&c.searchParams.set("ephemeral","true"),s==null||s(0,n.size);','multipart frame binding');
  edits.push({start:upload[0].start!,end:upload[0].end!,text:value,label:'native-upload-api-frame'});
  value=checked(source,chunked[0],methodHashes._uploadProjectAttachmentChunked,'_uploadProjectAttachmentChunked');
  value=once(value,'async _uploadProjectAttachmentChunked(t,n,r,s){const o=','async _uploadProjectAttachmentChunked(t,n,r,s,chimericFrameId){const chimericUploadUrl=h=>{const y=new URL(hs(h),window.location.origin);chimericFrameId&&y.searchParams.set("frameId",chimericFrameId);return y.toString()},o=','chunked parameter and URL');
  value=once(value,'$u(hs(h),','$u(chimericUploadUrl(h),','chunk request frame binding');
  value=once(value,'$u(hs(`/artifacts/upload/${ze(l)}`),','$u(chimericUploadUrl(`/artifacts/upload/${ze(l)}`),','chunk cancel frame binding');
  edits.push({start:chunked[0].start!,end:chunked[0].end!,text:value,label:'native-upload-chunks-frame'});
 }else if(file==='useSessionActions-B0Qf6PUm.js'){
  const functions:t.FunctionDeclaration[]=[];t.traverseFast(ast,node=>{if(t.isFunctionDeclaration(node)&&t.isIdentifier(node.id,{name:'Ys'}))functions.push(node)});
  if(functions.length!==1)fail('saved session actions');const fn=functions[0],original=checked(source,fn,methodHashes.sessionActions,'saved session actions');
  const first=fn.params[1];if(!t.isIdentifier(fn.params[0],{name:'e'})||!t.isIdentifier(first,{name:'s'}))fail('session action parameters');
  const active=original.includes('activeRootFrameId:a');if(!active)fail('active root binding');
  const value=once(original,'g.uploadProjectAttachment(e,t,n,r,d)','g.uploadProjectAttachment(e,t,n,r,d,a)','composer upload binding');
  edits.push({start:fn.start!,end:fn.end!,text:value,label:'native-composer-upload-frame'});
 }
 return edits;
}
