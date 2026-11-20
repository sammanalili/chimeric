import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP,BlockList} from 'node:net';
import {blockedServiceURL} from './network-policy';
import {OutboundBrokerError,type BrokerWireRequest,type BrokerResponse} from './outbound-broker';

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
/** One HTTPS request, pinned to the DNS result inspected after approval. No
 * cookies, environment proxies, provider credentials, redirect or retry. */
export function createOutboundTransport(deps:{lookup?:typeof lookup;request?:typeof https.request}={}){
 return async(wire:BrokerWireRequest):Promise<BrokerResponse>=>{
  wire.assertCurrent();const url=new URL(wire.url),base=new URL(wire.binding.endpoint);
  if(url.protocol!=='https:'||url.username||url.password||url.origin!==base.origin||wire.binding.api!=='reviewed-http'||wire.binding.credentialRevision!=='keyless'||blockedServiceURL(url))throw new OutboundBrokerError('unsupported_destination','This destination is not supported by the reviewed public HTTPS transport.',403);
  const addresses=await (deps.lookup??lookup)(url.hostname.replace(/^\[|\]$/g,''),{all:true});wire.assertCurrent();
  if(!addresses.length||addresses.some(a=>!isPublicOutboundAddress(a.address)))throw new OutboundBrokerError('private_destination','Reviewed public requests cannot access loopback, private or reserved network addresses.',403);
  const selected=addresses.find(a=>a.family===4)??addresses[0],body=Buffer.from(wire.bodyBase64,'base64');
  return await new Promise((resolve,reject)=>{
   wire.assertCurrent();
   const request=(deps.request??https.request)(url,{
    method:wire.method,headers:{...wire.headers,'content-length':String(body.length)},agent:false,signal:wire.signal,timeout:30_000,
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
