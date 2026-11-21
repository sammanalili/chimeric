import {test, expect, afterAll} from 'bun:test';
import http from 'node:http';
import {startProxies, validateConfig, adaptHtml} from '../tools/tailnet-proxy.mjs';

const appOrigin = 'https://fixture.test.ts.net:18868';
const sandboxOrigin = 'https://fixture.test.ts.net:18869';
const user = 'fixture@example.test';
let hits = 0;
let releaseStream: (() => void) | undefined;
let streamFinished = false;
const bytes = Buffer.from(Array.from({length: 256 * 1024}, (_, i) => i % 256));
const app = Bun.serve({hostname: '127.0.0.1', port: 0,
  async fetch(req, server) {
    hits++;
    const path = new URL(req.url).pathname;
    if (path === '/ws') {
      if (req.headers.get('cookie') !== 'operon_auth=fixture' || req.headers.get('origin') !== `http://127.0.0.1:${server.port}` || req.headers.get('sec-websocket-protocol') !== 'test-csrf') return new Response('denied', {status: 403});
      if (server.upgrade(req, {headers: {'sec-websocket-protocol': 'test-csrf'}})) return;
      return new Response('not upgraded', {status: 400});
    }
    if (path === '/sse') {
      streamFinished = false;
      return new Response(new ReadableStream({start(controller) {
        controller.enqueue(new TextEncoder().encode('data: first\n\n'));
        releaseStream = () => { if (streamFinished) return; streamFinished = true; controller.enqueue(new TextEncoder().encode('data: last\n\n')); controller.close(); };
      }}), {headers: {'content-type': 'text/event-stream'}});
    }
    if (path === '/bytes') return new Response(await req.arrayBuffer(), {headers: {'content-type': 'application/octet-stream'}});
    if (path === '/range') return new Response(bytes.subarray(5, 15), {status: 206, headers: {'content-type': 'application/octet-stream', 'content-range': 'bytes 5-14/262144'}});
    if (path === '/redirect') return new Response(null, {status: 302, headers: {location: `http://localhost:${server.port}/projects/example`, 'set-cookie': 'operon_auth=fixture; HttpOnly; SameSite=Strict; Path=/'}});
    if (path === '/api/local/resources/policy') return Response.json({query: new URL(req.url).search, origin: req.headers.get('origin'), cookie: req.headers.get('cookie'), csrf: req.headers.get('x-operon-csrf')}, {headers: {'cache-control': 'no-store, private', 'x-content-type-options': 'nosniff', vary: 'Cookie'}});
    if (path === '/html') return new Response('<html><head><script nonce="fixture">globalThis.__OPERON__=Object.assign({},globalThis.__OPERON__,' + JSON.stringify({sandboxOrigin: `http://localhost:${sandbox.port}`, sandboxAltHosts: [], nested: {kept: true}}) + ')</script></head><body>native</body></html>', {headers: {'content-type': 'text/html', 'content-security-policy': `default-src 'self'; script-src 'nonce-fixture'; frame-src 'self' http://localhost:${sandbox.port}; frame-ancestors 'none'`, 'x-frame-options': 'DENY'}});
    if (path === '/unsafe-template') return new Response('<html>changed viewer</html>', {headers: {'content-type': 'text/html', 'content-security-policy': "frame-ancestors 'none'"}});
    return Response.json({method: req.method, origin: req.headers.get('origin'), host: req.headers.get('host'), cookie: req.headers.get('cookie'), csrf: req.headers.get('x-operon-csrf'), forwarded: req.headers.get('x-forwarded-host'), identity: req.headers.get('tailscale-user-login')});
  },
  websocket: {message(socket, message) {socket.send(message);}},
});
const sandbox = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(req) {
  hits++;
  if (new URL(req.url).searchParams.has('changed')) return new Response('changed', {headers: {'content-type': 'text/html'}});
  return new Response(`<html><script>inner.setAttribute('sandbox', 'allow-scripts allow-forms'); const ALLOWED_PARENT_ORIGINS = ["http://localhost:${app.port}","http://127.0.0.1:${app.port}"]; const SAFE_SANDBOX_TOKENS = ['allow-scripts','allow-forms'];</script></html>`, {headers: {'content-type': 'text/html', 'content-security-policy': `default-src 'self'; frame-ancestors http://localhost:${app.port} http://127.0.0.1:${app.port}; frame-src 'none'`}});
}});
const config = {schemaVersion: 1, allowedUser: user, appOrigin, sandboxOrigin, appUpstream: `http://127.0.0.1:${app.port}`, sandboxUpstream: `http://127.0.0.1:${sandbox.port}`, appListenPort: 0, sandboxListenPort: 0};
const proxy = await startProxies(config);
afterAll(async () => {releaseStream?.(); await proxy.close(); app.stop(true); sandbox.stop(true);});

function headers(kind = 'app') {
  const host = new URL(kind === 'app' ? appOrigin : sandboxOrigin).host;
  return {host, 'x-forwarded-host': host, 'x-forwarded-proto': 'https', 'tailscale-user-login': user};
}
function request(path: string, options: {kind?: string; method?: string; headers?: Record<string,string>; body?: Buffer} = {}) {
  return new Promise<{status: number; headers: http.IncomingHttpHeaders; bytes: Buffer; text: string}>((ok, fail) => {
    const req = http.request({hostname: '127.0.0.1', port: options.kind === 'sandbox' ? proxy.sandboxPort : proxy.appPort, path, method: options.method ?? 'GET', headers: options.headers ?? headers(options.kind)}, res => {
      const chunks: Buffer[] = []; res.on('data', c => chunks.push(c)); res.on('error', fail); res.on('end', () => {const bytes = Buffer.concat(chunks); ok({status: res.statusCode!, headers: res.headers, bytes, text: bytes.toString()});});
    });
    req.on('error', fail); req.end(options.body);
  });
}

test('untrusted identity, Funnel, host and origin are denied before upstream access', async () => {
  for (const patch of [{'tailscale-user-login': ''}, {'tailscale-user-login': 'other@example.test'}, {'tailscale-funnel-request': '1'}, {host: 'evil.example'}, {'x-forwarded-host': 'evil.example'}, {'x-forwarded-proto': 'http'}, {origin: 'https://evil.example'}, {origin: 'null'}]) {
    const before = hits;
    expect((await request('/', {headers: {...headers(), ...patch}})).status).toBe(403);
    expect(hits).toBe(before);
  }
  expect((await request('/', {method: 'POST'})).status).toBe(403);
});

test('authorized requests keep native cookies and CSRF with a validated upstream Origin', async () => {
  const response = await request('/', {method: 'POST', headers: {...headers(), origin: appOrigin, cookie: 'operon_auth=fixture', 'x-operon-csrf': 'same-token'}});
  expect(response.status).toBe(200);
  expect(JSON.parse(response.text)).toEqual({method: 'POST', origin: config.appUpstream, host: `127.0.0.1:${app.port}`, cookie: 'operon_auth=fixture', csrf: 'same-token', forwarded: null, identity: null});
});

test('Tailnet resource policy keeps the exact query, native session checks and private response boundary', async () => {
 const path='/api/local/resources/policy?versionId=version-a&consumerFrameId=frame-a',before=hits;
 const denied=await request(path,{headers:{...headers(),'tailscale-user-login':'other@example.test'}});expect(denied.status).toBe(403);expect(hits).toBe(before);
 const result=await request(path,{headers:{...headers(),origin:appOrigin,cookie:'operon_auth=fixture','x-operon-csrf':'same-token'}});expect(result.status).toBe(200);
 expect(JSON.parse(result.text)).toEqual({query:'?versionId=version-a&consumerFrameId=frame-a',origin:config.appUpstream,cookie:'operon_auth=fixture',csrf:'same-token'});
 expect(result.headers['cache-control']).toBe('no-store, private');expect(result.headers['x-content-type-options']).toBe('nosniff');expect(String(result.headers.vary).toLowerCase()).toContain('cookie');
 expect((await request(path,{kind:'sandbox'})).status).toBe(404);
});

test('the remote app gets its own renderer without changing script or frame-ancestor policy', async () => {
  const result = await request('/html');
  expect(result.status).toBe(200); expect(result.text).toContain('"sandboxOrigin":"' + sandboxOrigin + '"'); expect(result.text).toContain('"nested":{"kept":true}');
  expect(result.headers['content-security-policy']).toContain('frame-src \'self\' ' + sandboxOrigin);
  expect(result.headers['content-security-policy']).toContain("script-src 'nonce-fixture'"); expect(result.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(result.headers['x-frame-options']).toBe('DENY'); expect(Number(result.headers['content-length'])).toBe(result.bytes.length);
  expect(result.headers['referrer-policy']).toBe('same-origin');
});

test('renderer serves only its native bridge, exact remote parent, and opaque inner frame', async () => {
  const result = await request('/mcp_apps', {kind: 'sandbox'});
  expect(result.status).toBe(200); expect(result.text).toContain('const ALLOWED_PARENT_ORIGINS = ["' + appOrigin + '"];');
  expect(result.text).toContain("inner.setAttribute('sandbox', 'allow-scripts allow-forms')"); expect(result.text).not.toContain('allow-same-origin');
  expect(result.headers['content-security-policy']).toContain('frame-ancestors ' + appOrigin);
  expect(result.headers['referrer-policy']).toBe('no-referrer');
  expect((await request('/api/models', {kind: 'sandbox'})).status).toBe(404);
  expect((await request('/mcp_apps?changed=1', {kind: 'sandbox'})).status).toBe(502);
});

test('native browser-mode policy stays intact and fallback policies keep their scope', () => {
  const html = '<html><script>globalThis.__OPERON__=Object.assign({},globalThis.__OPERON__,' + JSON.stringify({sandboxOrigin: `http://localhost:${sandbox.port}`}) + ')</script></html>';
  const result = adaptHtml(html, {'content-security-policy': "frame-ancestors 'none'"}, config, 'app');
  expect(result.headers['content-security-policy']).toBe("frame-ancestors 'none'");
  expect(result.html).toContain(sandboxOrigin);
  const fallback = adaptHtml(html, {'content-security-policy': "default-src 'self'; script-src 'nonce-fixture'; frame-ancestors 'none'"}, config, 'app');
  expect(fallback.headers['content-security-policy']).toBe("default-src 'self'; script-src 'nonce-fixture'; frame-ancestors 'none'; frame-src 'self' " + sandboxOrigin);
});

test('binary uploads and partial downloads keep their exact bytes and status', async () => {
  const sent = await request('/bytes', {method: 'POST', headers: {...headers(), origin: appOrigin, 'content-type': 'application/octet-stream'}, body: bytes});
  expect(sent.bytes.equals(bytes)).toBe(true);
  const part = await request('/range'); expect(part.status).toBe(206); expect(part.bytes.equals(bytes.subarray(5,15))).toBe(true); expect(part.headers['content-range']).toBe('bytes 5-14/262144');
});

test('redirects return to the remote app and session cookies gain Secure', async () => {
  const result = await request('/redirect');
  expect(result.status).toBe(302); expect(result.headers.location).toBe(appOrigin + '/projects/example');
  expect(result.headers['set-cookie']?.[0]).toBe('operon_auth=fixture; HttpOnly; SameSite=Strict; Path=/; Secure');
});

test('SSE delivers its first event while the upstream response is still open', async () => {
  let release!: () => void;
  const first = new Promise<void>(ok => {release = ok;});
  const complete = new Promise<string>((ok, fail) => {
    http.get({hostname: '127.0.0.1', port: proxy.appPort, path: '/sse', headers: headers()}, res => {
      let text = ''; res.on('data', c => {text += c.toString(); release();}); res.on('end', () => ok(text)); res.on('error', fail);
    }).on('error', fail);
  });
  await first; expect(streamFinished).toBe(false); releaseStream!(); expect(await complete).toBe('data: first\n\ndata: last\n\n');
});

test('WebSocket upgrade retains cookie and CSRF subprotocol and carries messages both ways', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${proxy.appPort}/ws`, {protocols: ['test-csrf'], headers: {...headers(), origin: appOrigin, cookie: 'operon_auth=fixture'}});
  await new Promise<void>((ok, fail) => {socket.onopen = () => ok(); socket.onerror = () => fail(new Error('Upgrade failed'));});
  expect(socket.protocol).toBe('test-csrf');
  const echoed = new Promise(resolve => {socket.onmessage = event => resolve(event.data);});
  socket.send('streaming tool event'); expect(await echoed).toBe('streaming tool event'); socket.close();
});

test('configuration refuses broad origins, public upstreams, shared renderer origins and proxy loops', () => {
  for (const patch of [{appOrigin: 'http://fixture.test.ts.net:18868'}, {appOrigin: 'https://evil.example'}, {appOrigin: appOrigin + '/path'}, {sandboxOrigin: appOrigin}, {appUpstream: 'http://192.168.1.2:18868'}, {sandboxListenPort: Number(new URL(config.appUpstream).port)}]) expect(() => validateConfig({...config, ...patch})).toThrow();
});
