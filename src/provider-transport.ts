/** Capture the native sender before the preserved runtime's vendor-service
 * guard is installed. Only an explicitly configured inference URL can use it. */
const nativeFetch=globalThis.fetch;

export function anthropicProviderFetch(baseUrl:string,fetcher:typeof fetch=nativeFetch):typeof fetch{
 const base=new URL(baseUrl),prefix=base.pathname.replace(/\/+$/,'');
 if(base.username||base.password||base.search||base.hash)throw new Error('Invalid Anthropic API destination.');
 if(base.protocol!=='https:'&&!(base.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(base.hostname)))throw new Error('Anthropic API connections require HTTPS or loopback.');
 return ((input:any,init?:RequestInit)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
  const path=url.pathname.slice(prefix.length);
  if(url.origin!==base.origin||url.username||url.password||url.hash||!url.pathname.startsWith(prefix+'/')||!['/v1/messages','/v1/messages/count_tokens','/v1/models'].includes(path))return Promise.reject(new Error('The Anthropic request left its configured inference destination.'));
  return fetcher(input,{...init,redirect:'error'});
 }) as typeof fetch;
}
