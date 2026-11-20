import {localGate} from './local-gate';

const origin='http://localhost';
const attribute=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function requestURL(value:unknown){
 if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\x00-\x1f\x7f]/.test(value))return new URL('/',origin);
 try{return new URL(value,origin)}catch{return new URL('/',origin)}
}

/** The native SPA's /login route is distinct from its server nonce document. */
export function isLocalLoginEntry(payload:unknown,url:unknown,method:unknown){
 return method==='GET'&&typeof payload==='string'&&/<(?:!doctype|html)\b/i.test(payload)&&requestURL(url).pathname==='/login';
}

export function localLoginDestination(rawURL:unknown){
 const requested=requestURL(rawURL);
 const raw=requested.pathname==='/login'?requested.searchParams.get('redirect')??'/':requested.pathname+requested.search+requested.hash;
 if(!raw.startsWith('/')||raw.startsWith('//')||/[\\\x00-\x1f\x7f]/.test(raw))return'/';
 try{
  const parsed=new URL(raw,origin),decoded=decodeURIComponent(parsed.pathname);
  if(parsed.origin!==origin||decoded.startsWith('//')||/[\\\x00-\x1f\x7f]/.test(decoded)||parsed.pathname==='/login'||parsed.pathname.startsWith('/api/auth/'))return'/';
  parsed.searchParams.delete('nonce');
  return parsed.pathname+parsed.search+parsed.hash;
 }catch{return'/'}
}

/** Never serve the upstream account-login SPA at the local login entry. */
export function localLoginDocument(rawURL:unknown,nonce:unknown,locale:string,icon:string){
 const valid=typeof nonce==='string'&&/^[a-f0-9]{16,128}$/i.test(nonce);
 const form=valid?'<form method="post" action="/api/auth/nonce"><input type="hidden" name="nonce" value="'+nonce+'"><input type="hidden" name="dest" value="'+attribute(localLoginDestination(rawURL))+'"><button type="submit">Open local workspace</button></form>':'';
 return localGate('<!doctype html><html><title>Open local workspace</title><body>'+form+'</body></html>',locale,icon);
}
