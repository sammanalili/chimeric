import {test,expect} from 'bun:test';
import {isLocalLoginEntry,localLoginDestination,localLoginDocument} from '../src/local-login';

const spa='<!doctype html><html><head><title>Chimeric</title></head><body><div id="root"></div><script src="/assets/index.js"></script></body></html>';
const nonce='a'.repeat(64);

test('the actual native SPA /login document is intercepted while ordinary app/API documents stay intact',()=>{
 expect(isLocalLoginEntry(spa,'/login?redirect=%2F','GET')).toBe(true);
 expect(isLocalLoginEntry(spa,'/','GET')).toBe(false);
 expect(isLocalLoginEntry(spa,'/projects/project','GET')).toBe(false);
 expect(isLocalLoginEntry(spa,'/login','POST')).toBe(false);
 expect(isLocalLoginEntry('{"ok":true}','/login','GET')).toBe(false);
});

test('local login preserves an internal research destination and removes spent bootstrap nonces',()=>{
 expect(localLoginDestination('/login?redirect='+encodeURIComponent('/projects/a/frames/b?panel=files&nonce=old#plot'))).toBe('/projects/a/frames/b?panel=files#plot');
 expect(localLoginDestination('/login?redirect=%2F')).toBe('/');
 expect(localLoginDestination('/login')).toBe('/');
});

test('external, ambiguous, control-character and recursive login destinations fail closed',()=>{
 for(const redirect of ['https://example.com/','//example.com/','/\\example.com/','/%2f%2fexample.com/','/line\nnext','/login?redirect=/login','/api/auth/login?provider=claude_ai','/%5cexample.com/'])expect(localLoginDestination('/login?redirect='+encodeURIComponent(redirect))).toBe('/');
});

test('rendered native login uses only the same-origin nonce handshake and escaped destination',()=>{
 const html=localLoginDocument('/login?redirect='+encodeURIComponent('/projects/a?query="<tag>&mode=read'),nonce,'en','<svg/>');
 expect(html).toContain('action="/api/auth/nonce"');expect(html).toContain('name="nonce" value="'+nonce+'"');expect(html).toContain('name="dest" value="/projects/a?query=%22%3Ctag%3E&amp;mode=read"');
 expect(html).not.toContain('claude_ai');expect(html).not.toContain('Paste code instead');expect(html).not.toContain('/assets/index.js');expect(html).not.toContain('http://127.0.0.1');expect(html).toContain('Open local workspace');
});

test('missing or malformed nonce gives local launch guidance and never a vendor login',()=>{
 for(const value of [undefined,'bad"nonce']){const html=localLoginDocument('/login',value,'en','<svg/>');expect(html).not.toContain('<form');expect(html).toContain('no external account sign-in is required');expect(html).not.toContain('claude_ai')}
 expect(localLoginDocument('/login',nonce,'ja','<svg/>')).toContain('ローカルワークスペースを開く');
});
