import {expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {createOutboundTransport,isPublicOutboundAddress} from '../src/outbound-transport';
import type {BrokerWireRequest} from '../src/outbound-broker';

const publicV4={address:'8.8.8.8',family:4},publicV6={address:'2606:4700:4700::1111',family:6};
function wire(overrides:Partial<BrokerWireRequest>={}):BrokerWireRequest{
 const controller=new AbortController();return {url:'https://public.example/api/search?query=synthetic',method:'POST',headers:Object.freeze({accept:'application/json','content-type':'application/json'}),bodyBase64:Buffer.from('{"query":"Synthetic public information"}').toString('base64'),binding:Object.freeze({id:'public-search',endpoint:'https://public.example/api',api:'reviewed-http',revision:'one',credentialRevision:'keyless'}),signal:controller.signal,redirect:'error',assertCurrent:()=>controller.signal.throwIfAborted(),...overrides};
}
function fixture(options:{addresses?:Array<{address:string;family:number}>;lookup?:(host:string,options:any)=>Promise<any>;onConstruct?:()=>void;onEnd?:(fixture:any)=>void;status?:number;headers?:Record<string,string|string[]>;chunks?:Buffer[]}={}){
 const lookups:any[]=[],requests:any[]=[],responses:any[]=[];
 const dns=async(host:string,lookupOptions:any)=>{lookups.push({host,options:lookupOptions});return options.lookup?options.lookup(host,lookupOptions):options.addresses??[publicV6,publicV4]};
 const request=(url:URL,requestOptions:any,callback:Function)=>{
  const raw:any=new EventEmitter(),response:any=Object.assign(new EventEmitter(),{headers:options.headers??{'content-type':'application/json'},statusCode:options.status??200,destroyed:false,destroy(error:Error){if(this.destroyed)return;this.destroyed=true;queueMicrotask(()=>this.emit('error',error))}});
  const entry:any={url:url.href,options:requestOptions,raw,response,ended:false,destroyed:false,body:undefined,destruction:undefined,start(){callback(response)},chunk(value:Buffer){if(!response.destroyed)response.emit('data',value)},finish(){if(!response.destroyed)response.emit('end')}};
  raw.destroy=(error:Error)=>{if(entry.destroyed)return;entry.destroyed=true;entry.destruction=error;response.destroyed=true;queueMicrotask(()=>raw.emit('error',error));return raw};
  const abort=()=>raw.destroy(requestOptions.signal.reason??new Error('Synthetic cancellation'));requestOptions.signal.addEventListener('abort',abort,{once:true});
  raw.end=(body:Buffer)=>{entry.ended=true;entry.body=Buffer.from(body);queueMicrotask(()=>{
   if(requestOptions.signal.aborted){abort();return}if(options.onEnd){options.onEnd(entry);return}
   entry.start();for(const chunk of options.chunks??[Buffer.from('{"ok":true}')])entry.chunk(chunk);entry.finish();
  });return raw};
  requests.push(entry);responses.push(response);options.onConstruct?.();return raw;
 };
 const transport=createOutboundTransport({lookup:dns as any,request:request as any});return {transport,lookups,requests,responses};
}

test('one HTTPS request preserves exact reviewed body and headers, without cookies, auth, proxy, agent reuse or retries',async()=>{
 const f=fixture(),value=wire(),result=await f.transport(value);expect(f.lookups).toEqual([{host:'public.example',options:{all:true}}]);expect(f.requests).toHaveLength(1);
 const request=f.requests[0];expect(request.url).toBe(value.url);expect(request.options).toMatchObject({method:'POST',agent:false,signal:value.signal,timeout:30000});expect(request.options.headers).toEqual({...value.headers,'content-length':String(Buffer.from(value.bodyBase64,'base64').length)});expect(request.body.toString('base64')).toBe(value.bodyBase64);
 for(const field of ['auth','proxy','cookie','credentials'])expect(request.options[field]).toBeUndefined();for(const name of Object.keys(request.options.headers))expect(/^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(name)).toBe(false);
 expect(result).toEqual({status:200,headers:{'content-type':'application/json'},bodyBase64:Buffer.from('{"ok":true}').toString('base64')});
});
test('DNS selection is pinned for both lookup signatures and cannot resolve again during TLS connection',async()=>{
 const f=fixture();await f.transport(wire());const lookup=f.requests[0].options.lookup,results:any[]=[];
 lookup('an-attacker-changed-host.example',{},(...values:any[])=>results.push(values));lookup('public.example',{all:true},(...values:any[])=>results.push(values));
 expect(results).toEqual([[null,publicV4.address,4],[null,[publicV4]]]);expect(f.lookups).toHaveLength(1);
 const v6=fixture({addresses:[publicV6]});await v6.transport(wire());v6.requests[0].options.lookup('public.example',{},(...values:any[])=>results.push(values));expect(results.at(-1)).toEqual([null,publicV6.address,6]);
});
test('redirects are returned for a new broker review and never followed; unreviewed response headers are dropped',async()=>{
 const f=fixture({status:307,headers:{location:'https://different.example/new','content-type':'text/plain','set-cookie':'synthetic-session=blocked','x-private':'not-retained'},chunks:[Buffer.from('Redirect')]});
 expect(await f.transport(wire())).toEqual({status:307,headers:{location:'https://different.example/new','content-type':'text/plain'},bodyBase64:Buffer.from('Redirect').toString('base64')});expect(f.requests).toHaveLength(1);expect(f.lookups).toHaveLength(1);
});
test('all DNS answers must be public: private, loopback, mapped, invalid, reserved and mixed results fail before request construction',async()=>{
 for(const address of ['127.0.0.1','10.1.2.3','172.16.1.1','192.168.1.1','100.64.0.1','169.254.169.254','0.0.0.0','224.0.0.1','255.255.255.255','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','::1','::ffff:8.8.8.8','::ffff:127.0.0.1','fe80::1','fc00::1','ff02::1','64:ff9b::808:808','2001:db8::1','2001::1','2002:808:808::1','invalid']){
  expect(isPublicOutboundAddress(address)).toBe(false);const f=fixture({addresses:[publicV4,{address,family:address.includes(':')?6:4}]});await expect(f.transport(wire())).rejects.toMatchObject({code:'private_destination',status:403});expect(f.requests).toHaveLength(0);
 }
 const empty=fixture({addresses:[]});await expect(empty.transport(wire())).rejects.toMatchObject({code:'private_destination'});expect(empty.requests).toHaveLength(0);
});
test('documentation, transition and special-purpose ranges remain denied across equivalent IPv6 spellings',()=>{
 // IANA special-purpose registries: 2001::/23, Teredo 2001::/32,
 // documentation 3fff::/20 and deprecated 192.88.99.0/24 relay anycast.
 for(const address of ['2001:100::1','2001:0100:0:0:0:0:0:1','2001:0:0:0:0:0:0:1','3fff::1','3fff:0fff:0:0:0:0:0:1','192.88.99.1','192.88.99.2'])expect(isPublicOutboundAddress(address)).toBe(false);
});
test('transport accepts only the reviewed public keyless HTTPS adapter and same approved origin',async()=>{
 const good=wire();for(const input of [wire({url:'http://public.example/api'}),wire({url:'https://evil.example/api'}),wire({url:'https://user:synthetic@public.example/api'}),wire({binding:{...good.binding,api:'openai-completions'}}),wire({binding:{...good.binding,credentialRevision:'a'.repeat(64)}})]){
  const f=fixture();await expect(f.transport(input)).rejects.toMatchObject({code:'unsupported_destination'});expect(f.lookups).toHaveLength(0);expect(f.requests).toHaveLength(0);
 }
});
test('policy changes before DNS, after DNS and after request construction all stop before request bytes are written',async()=>{
 let valid=false;const current=()=>{if(!valid)throw Error('Synthetic policy revoked')},before=fixture();await expect(before.transport(wire({assertCurrent:current}))).rejects.toThrow('policy revoked');expect(before.lookups).toHaveLength(0);
 valid=true;const after=fixture({lookup:async()=>{valid=false;return [publicV4]}});await expect(after.transport(wire({assertCurrent:current}))).rejects.toThrow('policy revoked');expect(after.requests).toHaveLength(0);
 valid=true;const prewrite=fixture({onConstruct:()=>{valid=false}});await expect(prewrite.transport(wire({assertCurrent:current}))).rejects.toThrow('policy revoked');expect(prewrite.requests).toHaveLength(1);expect(prewrite.requests[0].ended).toBe(false);expect(prewrite.requests[0].destroyed).toBe(true);
});
test('policy checks continue during response reads and immediately before returning a response',async()=>{
 let valid=true;const current=()=>{if(!valid)throw Error('Synthetic policy revoked')},reading=fixture({onEnd:entry=>{entry.start();entry.chunk(Buffer.from('first'));valid=false;entry.chunk(Buffer.from('second'));entry.finish()}});
 await expect(reading.transport(wire({assertCurrent:current}))).rejects.toThrow('policy revoked');expect(reading.responses[0].destroyed).toBe(true);expect(reading.requests).toHaveLength(1);
 valid=true;const ending=fixture({onEnd:entry=>{entry.start();entry.chunk(Buffer.from('first'));valid=false;entry.finish()}});await expect(ending.transport(wire({assertCurrent:current}))).rejects.toThrow('policy revoked');expect(ending.requests).toHaveLength(1);
});
test('response limit counts bytes across chunks, accepts exactly 8 MiB and stops on the first excess byte',async()=>{
 const block=Buffer.alloc(4*1024*1024,0x41),allowed=fixture({chunks:[block,block]});const result=await allowed.transport(wire());expect(Buffer.from(result.bodyBase64,'base64').length).toBe(8*1024*1024);
 const rejected=fixture({chunks:[block,block,Buffer.from('!')]});await expect(rejected.transport(wire())).rejects.toMatchObject({code:'response_limit',status:502});expect(rejected.responses[0].destroyed).toBe(true);expect(rejected.requests).toHaveLength(1);
});
test('cancellation while reading destroys the request without retries or a usable partial response',async()=>{
 const controller=new AbortController(),f=fixture({onEnd:entry=>{entry.start();entry.chunk(Buffer.from('partial synthetic'));controller.abort(new Error('Synthetic cancellation'))}});
 await expect(f.transport(wire({signal:controller.signal,assertCurrent:()=>controller.signal.throwIfAborted()}))).rejects.toThrow('Synthetic cancellation');expect(f.requests).toHaveLength(1);expect(f.requests[0].destroyed).toBe(true);expect(f.requests[0].options.signal).toBe(controller.signal);
});
test('cancel during DNS and timeout/error/response interruption each stop with one attempt at most',async()=>{
 const controller=new AbortController(),dns=fixture({lookup:async()=>{controller.abort(new Error('Stopped during DNS'));return [publicV4]}});await expect(dns.transport(wire({signal:controller.signal,assertCurrent:()=>controller.signal.throwIfAborted()}))).rejects.toThrow('Stopped during DNS');expect(dns.requests).toHaveLength(0);
 const timeout=fixture({onEnd:entry=>entry.raw.emit('timeout')});await expect(timeout.transport(wire())).rejects.toThrow('timed out');expect(timeout.requests[0].destroyed).toBe(true);expect(timeout.requests).toHaveLength(1);
 const error=fixture({onEnd:entry=>entry.raw.emit('error',new Error('Synthetic TLS failure'))});await expect(error.transport(wire())).rejects.toThrow('TLS failure');expect(error.requests).toHaveLength(1);
 const aborted=fixture({onEnd:entry=>{entry.start();entry.response.emit('aborted')}});await expect(aborted.transport(wire())).rejects.toThrow('interrupted');expect(aborted.requests).toHaveLength(1);
});
