import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync,realpathSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ANTIGRAVITY_CONTROL_URL,ANTIGRAVITY_INFERENCE_URL} from './antigravity-http-auth';

/**
 * Client for the Go transport bridge (`tools/antigravity-http-bridge`).
 *
 * Why this exists: the Antigravity inference service is spoken to by Google's Go
 * client, and the TLS/HTTP2 ClientHello is a client-identification signal. A
 * JS fetch presents a different fingerprint (measured in
 * work/agy-http-20261111/packets/PACKETS.md). The bridge is a small Go program
 * whose stack produces the same ClientHello as the official client, so Chimeric
 * can stream through it while keeping its own auth, parsing and safety rules.
 *
 * Protocol (NDJSON on stdin/stdout):
 *   -> {"id","url","token","body"}            start a POST
 *   -> {"id","cancel":true}                  abort an in-flight POST
 *   <- {"id","status","headers"}             exactly once, first
 *   <- {"id","data"}                         base64 body chunks, in order
 *   <- {"id","done"} | {"id","error"}        terminal
 */

export const BRIDGE_BINARY_NAME=process.platform==='win32'?'agy-http-bridge.exe':'agy-http-bridge';

/** Candidate locations, in priority order. */
function candidatePaths():string[]{
 const fromEnv=process.env.CHIMERIC_ANTIGRAVITY_BRIDGE;
 const roots=[dirname(process.argv[1]??''),dirname(process.execPath),process.cwd()];
 const out:string[]=[];
 if(fromEnv)out.push(resolve(fromEnv));
 for(const root of roots)out.push(join(root,BRIDGE_BINARY_NAME),join(root,'bin',BRIDGE_BINARY_NAME),join(root,'..','bin',BRIDGE_BINARY_NAME));
 return out;
}

/** Locates the compiled bridge binary. Returns undefined when absent. */
export function findBridgeBinary():string|undefined{
 const executable=(path:string)=>{
  try{
   const real=realpathSync(path),info=statSync(real);
   if(!info.isFile())return undefined;
   if(process.platform!=='win32'&&(info.mode&0o111)===0)return undefined;
   return real;
  }catch{return undefined}
 };
 // An explicit override is authoritative: a broken override fails closed
 // instead of silently substituting a different binary.
 const fromEnv=process.env.CHIMERIC_ANTIGRAVITY_BRIDGE;
 if(fromEnv)return executable(resolve(fromEnv));
 for(const path of candidatePaths()){
  const found=executable(path);
  if(found)return found;
 }
 return undefined;
}

/** Test seam: replaces the real process transport. */
export type BridgeLike={
 start(url:string,token:string,body:string,signal?:AbortSignal):Promise<Response>;
 close():void;
 readonly alive:boolean;
};
/** Test seam: set `factory` to replace the real process transport in tests. */
export const bridgeTest:{factory?:()=>BridgeLike|undefined}={};

type Pending={
 resolveResponse:(response:Response)=>void;
 reject:(error:Error)=>void;
 push:(chunk:Uint8Array)=>void;
 fail:(error:Error)=>void;
 finish:()=>void;
 cleanup:()=>void;
};

class BridgeProcess implements BridgeLike{
 private child?:ChildProcessWithoutNullStreams;
 private pending=new Map<string,Pending>();
 private starting?:Promise<void>;
 private closed=false;
 constructor(private binary:string){}
 get alive(){return !!this.child&&!this.child.killed&&!this.closed}
 private ensure():Promise<void>{
  if(this.alive)return Promise.resolve();
  if(this.closed)throw new Error('The Antigravity transport bridge was closed.');
  if(this.starting)return this.starting;
  this.starting=new Promise<void>((startResolve,startReject)=>{
   let child:ChildProcessWithoutNullStreams;
   try{child=spawn(this.binary,[],{stdio:['pipe','pipe','ignore'],env:{...process.env}}) as ChildProcessWithoutNullStreams}
   catch(error){this.starting=undefined;return startReject(new Error('The Antigravity transport bridge could not start.'))}
   this.child=child;
   let buffer='';
   const deliver=(line:string)=>{
    let message:any;try{message=JSON.parse(line)}catch{return}
    const id=typeof message?.id==='string'?message.id:'';
    const pending=this.pending.get(id);
    if(!pending)return;
    if(typeof message.error==='string'){this.pending.delete(id);pending.cleanup();pending.fail(new Error(message.error))}
    else if(message.done===true){this.pending.delete(id);pending.cleanup();pending.finish()}
    else if(typeof message.status==='number'){
     const headers=new Headers();
     if(message.headers&&typeof message.headers==='object')for(const [name,value] of Object.entries<string>(message.headers))headers.set(name,value);
     pending.resolveResponse(new Response(this.bodyFor(id,pending),{status:message.status,headers}));
    }
    else if(typeof message.data==='string')pending.push(Buffer.from(message.data,'base64'));
   };
   child.stdout.setEncoding('utf8');
   child.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;
    let newline:number;
    while((newline=buffer.indexOf('\n'))!==-1){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(line.trim())deliver(line)}
   });
   child.on('error',()=>{this.child=undefined;this.starting=undefined;this.failAll(new Error('The Antigravity transport bridge is unavailable.'))});
   child.on('exit',()=>{
    this.child=undefined;this.starting=undefined;
    this.failAll(new Error('The Antigravity transport bridge exited unexpectedly.'));
   });
   startResolve();
  });
  return this.starting;
 }
 private bodyFor(id:string,pending:Pending):ReadableStream<Uint8Array>{
  const self=this;
  return new ReadableStream<Uint8Array>({
   start(controller){
    pending.push=chunk=>{try{controller.enqueue(new Uint8Array(chunk))}catch{/* consumer already gone */}};
    pending.fail=error=>{try{controller.error(error)}catch{/* consumer already gone */}};
    pending.finish=()=>{try{controller.close()}catch{/* consumer already gone */}};
   },
   cancel(){
    // The consumer stopped reading. Abort the in-flight request so the remote
    // stream does not keep consuming quota after a user cancellation.
    try{self.write({id,cancel:true})}catch{/* bridge already gone */}
    self.pending.delete(id);pending.cleanup();
   },
  });
 }
 private failAll(error:Error){
  for(const [id,pending] of [...this.pending]){this.pending.delete(id);pending.cleanup();pending.fail(error)}
 }
 private write(message:Record<string,unknown>){
  if(!this.child)throw new Error('The Antigravity transport bridge is not running.');
  this.child.stdin.write(JSON.stringify(message)+'\n');
 }
 async start(url:string,token:string,body:string,signal?:AbortSignal):Promise<Response>{
  signal?.throwIfAborted();
  // The bridge carries the raw access token, so host confinement happens here
  // as well: no other origin may ever receive it.
  let origin:string;
  try{origin=new URL(url).origin}catch{throw new Error('The Antigravity transport bridge requires an absolute URL.')}
  if(origin!==ANTIGRAVITY_INFERENCE_URL&&origin!==ANTIGRAVITY_CONTROL_URL)throw new Error('Antigravity credentials can only be sent to the Antigravity model service.');
  await this.ensure();
  signal?.throwIfAborted();
  signal?.throwIfAborted();
  const id=randomUUID();
  return await new Promise<Response>((resolve,reject)=>{
   let settled=false;
   const pending:Pending={
    resolveResponse:response=>{if(!settled){settled=true;resolve(response)}},
    reject:error=>{if(!settled){settled=true;signal?.removeEventListener('abort',abort);reject(error)}},
    push:()=>{},
    fail:error=>pending.reject(error),
    finish:()=>{},
    cleanup:()=>signal?.removeEventListener('abort',abort),
   };
   const abort=()=>{
    try{this.write({id,cancel:true})}catch{/* bridge gone; the rejection below covers it */}
    this.pending.delete(id);pending.cleanup();
    pending.fail(new Error('The Antigravity request was cancelled.'));
   };
   signal?.addEventListener('abort',abort,{once:true});
   this.pending.set(id,pending);
   try{this.write({id,url,token,body})}
   catch(error){this.pending.delete(id);signal?.removeEventListener('abort',abort);reject(error instanceof Error?error:new Error('The Antigravity transport bridge could not accept the request.'))}
  });
 }
 close(){
  if(this.closed)return;
  this.closed=true;
  this.child?.stdin.end();
  this.child?.kill('SIGTERM');
  this.child=undefined;
  this.failAll(new Error('The Antigravity transport bridge was closed.'));
 }
}

let shared:BridgeProcess|undefined;

/** Shared bridge process; nil until first use so no process spawns in tests. */
export function bridgeTransport():BridgeLike|undefined{
 if(bridgeTest.factory)return bridgeTest.factory();
 const binary=findBridgeBinary();
 if(!binary)return undefined;
 if(!shared||!shared.alive)shared=new BridgeProcess(binary);
 return shared;
}

/** Stops the shared bridge process. Called when the connection closes. */
export function closeBridge(){shared?.close();shared=undefined}

/** Explicit transport choice for a request. */
export function transportPreference(injected:boolean):'bridge'|'fetch'{
 const override=process.env.CHIMERIC_ANTIGRAVITY_TRANSPORT;
 if(override==='bridge'||override==='fetch')return override;
 // An injected fetch (tests, fixtures) always wins: no real process traffic.
 if(injected)return 'fetch';
 return 'bridge';
}
