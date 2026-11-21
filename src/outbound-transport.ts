import https from 'node:https';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
import {blockedServiceURL} from './network-policy';
import {OutboundBrokerError,type BrokerWireRequest,type BrokerResponse} from './outbound-broker';

// local-runtime installs a process-wide vendor-service guard after module
// initialization. Keep the original sender for this narrower reviewed path;
// every request still passes the binding, DNS, one-shot and size checks below.
const nativeRequest=https.request.bind(https) as typeof https.request;

/** Only globally routed addresses. Reject mapped, link-local, private,
 * multicast, documentation, transition and carrier NAT ranges as well. */
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
const specialV6=new BlockList();for(const [network,prefix]of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)specialV6.addSubnet(network,prefix,'ipv6');
export function isPublicOutboundAddress(address:string){
 if(isIP(address)===6)return globalV6.check(address,'ipv6')&&!specialV6.check(address,'ipv6');
 if(isIP(address)!==4)return false;
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===100&&b>=64&&b<=127||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
const credentialApis=new Set(['openai-completions','openai-responses','anthropic-messages']);
const credentialRevision=(value:string)=>createHash('sha256').update(value).digest('hex');
/** One HTTPS request, pinned to the DNS result inspected after approval. No
 * cookies, environment proxies, redirects or retries. A configured API
 * credential is resolved only inside this consumed, approved transport call.
 * It is never added to the broker review or its digest. */
export function createOutboundTransport(deps:{lookup?:typeof lookup;request?:typeof https.request;credential?:(binding:BrokerWireRequest['binding'])=>string|undefined}={}){
 return async(wire:BrokerWireRequest):Promise<BrokerResponse>=>{
  wire.assertCurrent();const url=new URL(wire.url),base=new URL(wire.binding.endpoint);
  const prefix=base.pathname.replace(/\/+$/,''),keyless=wire.binding.credentialRevision==='keyless';
  // Public reviewed-http destinations are deliberately keyless. Configured
  // API adapters must have a credential fingerprint and resolve the matching
  // secret only after the permit is consumed.
  const supported=wire.binding.api==='reviewed-http'?keyless:credentialApis.has(wire.binding.api)&&!keyless;
  // Anthropic's configured inference API is the sole vendor-host exception.
  // Product, telemetry and every other vendor destination remain blocked.
  const anthropicApi=wire.binding.api==='anthropic-messages'&&url.hostname.toLowerCase().replace(/\.$/,'')==='api.anthropic.com';
  if(url.protocol!=='https:'||url.username||url.password||url.origin!==base.origin||prefix&&url.pathname!==prefix&&!url.pathname.startsWith(prefix+'/')||!supported||blockedServiceURL(url)&&!anthropicApi)throw new OutboundBrokerError('unsupported_destination','This destination is not supported by the reviewed public HTTPS transport.',403);
  const addresses=await (deps.lookup??lookup)(url.hostname.replace(/^\[|\]$/g,''),{all:true});wire.assertCurrent();
  if(!addresses.length||addresses.some(a=>!isPublicOutboundAddress(a.address)))throw new OutboundBrokerError('private_destination','Reviewed public requests cannot access loopback, private or reserved network addresses.',403);
  const selected=addresses.find(a=>a.family===4)??addresses[0],body=Buffer.from(wire.bodyBase64,'base64'),authentication:Record<string,string>={};
  if(!keyless){
   wire.assertCurrent();const credential=deps.credential?.(wire.binding);
   if(typeof credential!=='string'||!credential||credentialRevision(credential)!==wire.binding.credentialRevision)throw new OutboundBrokerError('credential_changed','The selected connection credential changed after review. Review the request again.',409);
   wire.assertCurrent();
   if(wire.binding.api==='anthropic-messages')authentication['x-api-key']=credential;
   else authentication.authorization='Bearer '+credential;
  }
  return await new Promise((resolve,reject)=>{
   wire.assertCurrent();
   const request=(deps.request??nativeRequest)(url,{
    method:wire.method,headers:{...wire.headers,...authentication,'content-length':String(body.length)},agent:false,signal:wire.signal,timeout:30_000,
    lookup:((_host:any,options:any,callback:any)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family)) as any,
   },response=>{
    const chunks:Buffer[]=[];let size=0;
    response.on('data',(chunk:Buffer)=>{try{wire.assertCurrent();size+=chunk.length;if(size>8*1024*1024)throw new OutboundBrokerError('response_limit','The response exceeds the approved transport limit.',502);chunks.push(Buffer.from(chunk))}catch(error){response.destroy(error as Error)}});
    response.on('error',reject);response.on('aborted',()=>reject(new Error('The reviewed response was interrupted.')));
    response.on('end',()=>{try{wire.assertCurrent();const headers:Record<string,string>={};for(const name of ['content-type','location']){const value=response.headers[name];if(typeof value==='string')headers[name]=value}resolve({status:response.statusCode??502,headers,bodyBase64:Buffer.concat(chunks).toString('base64')})}catch(error){reject(error)}});
   });
   request.once('timeout',()=>request.destroy(new Error('The reviewed request timed out.')));request.once('error',reject);
   try{wire.assertCurrent();request.end(body)}catch(error){request.destroy(error as Error);reject(error)}
  });
 };
}
