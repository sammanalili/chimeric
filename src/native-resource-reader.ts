import {closeSync,constants,fstatSync,lstatSync,openSync,readFileSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import type {NativeArtifactContext} from './native-artifact-context';

export class NativeResourceReadError extends Error {
 constructor(message:string,readonly status=409){super(message);this.name='NativeResourceReadError'}
}
const under=(base:string,path:string)=>path===base||path.startsWith(base+sep);
const identity=(stat:{dev:number|bigint;ino:number|bigint})=>`${stat.dev}:${stat.ino}`;
const segment=(value:string)=>value.length>0&&value!=='.'&&value!=='..'&&!value.includes('\0')&&!value.includes('/')&&!value.includes('\\');

/** Reads the exact native artifact version after ResourcePolicyStore grants a
 * lease. Relative paths must use the native org artifact layout. Absolute
 * paths are accepted only from the protected store and only after its owning
 * frame scope authorizes the path. No caller-supplied path reaches this class.
 */
export class NativeResourceReader {
 private profile:string;
 constructor(profileDir:string,private options:{
  protectedRoot:string;
  authorizeProtected:(resource:NativeArtifactContext,path:string)=>void;
 }){
  if(!isAbsolute(profileDir))throw new NativeResourceReadError('The native profile path is invalid.',503);
  const info=lstatSync(profileDir);if(!info.isDirectory()||info.isSymbolicLink())throw new NativeResourceReadError('The native profile path is unavailable.',503);
  this.profile=realpathSync(profileDir);
 }
 private standard(resource:NativeArtifactContext){
  if(isAbsolute(resource.storagePath)||resource.storagePath.includes('\\'))throw new NativeResourceReadError('The standard resource path is invalid.');
  const parts=resource.storagePath.split('/');
  if(parts.length<3||!parts.every(segment)||parts[0]!==resource.projectId||parts[1]!==resource.artifactId)throw new NativeResourceReadError('The standard resource path does not match its native identity.');
  const base=join(this.profile,'orgs',resource.organizationId,'artifacts');
  return {base,target:resolve(base,...parts)};
 }
 private protected(resource:NativeArtifactContext){
  const target=resolve(resource.storagePath);this.options.authorizeProtected(resource,target);
  return {base:this.options.protectedRoot,target};
 }
 private layout(resource:NativeArtifactContext){return isAbsolute(resource.storagePath)?this.protected(resource):this.standard(resource)}
 private directory(path:string){
  const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink()||process.geteuid&&info.uid!==process.geteuid())throw new NativeResourceReadError('A native resource directory is unavailable.');
  return realpathSync(path);
 }
 async read(resource:NativeArtifactContext,options:{maxBytes:number;signal:AbortSignal}){
  options.signal.throwIfAborted();
  if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<0||resource.sizeBytes>options.maxBytes)throw new NativeResourceReadError('The native resource exceeds the preview limit.',413);
  const selected=this.layout(resource),base=this.directory(selected.base),target=selected.target,rel=relative(base,target);
  if(!rel||rel.startsWith('..'+sep)||rel==='..'||isAbsolute(rel))throw new NativeResourceReadError('The native resource escaped its owning directory.');
  let cursor=base;const parts=rel.split(sep);for(const part of parts.slice(0,-1)){if(!segment(part))throw new NativeResourceReadError('The native resource path is invalid.');cursor=join(cursor,part);this.directory(cursor)}
  const before=lstatSync(target);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||process.geteuid&&before.uid!==process.geteuid()||before.size!==resource.sizeBytes||before.size>options.maxBytes)throw new NativeResourceReadError('The native resource file changed before it was opened.');
  const fd=openSync(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{
   const opened=fstatSync(fd),resolved=realpathSync(target);
   if(!opened.isFile()||opened.nlink!==1||identity(opened)!==identity(before)||opened.size!==before.size||!under(base,resolved)||resolved!==target)throw new NativeResourceReadError('The native resource file changed while it was opened.');
   options.signal.throwIfAborted();const bytes=readFileSync(fd);options.signal.throwIfAborted();const afterFd=fstatSync(fd),afterPath=lstatSync(target);
   if(bytes.length!==resource.sizeBytes||identity(afterFd)!==identity(opened)||afterFd.size!==opened.size||afterFd.mtimeMs!==opened.mtimeMs||afterPath.isSymbolicLink()||identity(afterPath)!==identity(opened)||afterPath.size!==opened.size||realpathSync(target)!==resolved)throw new NativeResourceReadError('The native resource file changed while it was read.');
   return bytes;
  }finally{closeSync(fd)}
 }
}
