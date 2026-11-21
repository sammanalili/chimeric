import http from 'node:http';
import {readFileSync, lstatSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {gunzipSync, brotliDecompressSync, inflateSync} from 'node:zlib';

const MAX_HTML = 8 * 1024 * 1024;
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function validateConfig(value) {
  if (value?.schemaVersion !== 1 || typeof value.allowedUser !== 'string' || !/^[^\s,\r\n]+@[^\s,\r\n]+$/.test(value.allowedUser)) throw new Error('Invalid tailnet account configuration.');
  const config = {...value};
  for (const field of ['appOrigin', 'sandboxOrigin']) {
    const u = new URL(config[field]);
    if (u.protocol !== 'https:' || !u.hostname.endsWith('.ts.net') || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Use an exact Tailscale HTTPS origin.');
    config[field] = u.origin;
  }
  if (config.appOrigin === config.sandboxOrigin || new URL(config.appOrigin).hostname !== new URL(config.sandboxOrigin).hostname) throw new Error('The artifact viewer needs a separate port on the same Tailscale device.');
  for (const field of ['appUpstream', 'sandboxUpstream']) {
    const u = new URL(config[field]);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw new Error('Upstreams must use an exact loopback HTTP port.');
    config[field] = u.origin;
  }
  for (const field of ['appListenPort', 'sandboxListenPort']) if (!Number.isInteger(config[field]) || config[field] < 0 || config[field] > 65535) throw new Error('Invalid proxy port.');
  const ports = [config.appListenPort, config.sandboxListenPort, Number(new URL(config.appUpstream).port), Number(new URL(config.sandboxUpstream).port)].filter(Boolean);
  if (new Set(ports).size !== ports.length) throw new Error('Proxy and upstream ports must be distinct.');
  return config;
}

function cleanHeaders(headers) {
  const nominated = String(headers.connection ?? '').toLowerCase().split(',').map(x => x.trim());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !hopHeaders.has(key.toLowerCase()) && !nominated.includes(key.toLowerCase())));
}

function admitted(req, config, kind) {
  const origin = kind === 'app' ? config.appOrigin : config.sandboxOrigin;
  const host = new URL(origin).host;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return false;
  // Serve removes caller-supplied identity headers and supplies this account.
  // These listeners are loopback-only and must never be placed behind Funnel.
  if (req.headers['tailscale-user-login'] !== config.allowedUser || req.headers['tailscale-funnel-request'] !== undefined) return false;
  if (req.headers.host !== host || req.headers['x-forwarded-host'] !== host || req.headers['x-forwarded-proto'] !== 'https') return false;
  const allowedOrigins = kind === 'app' ? [config.appOrigin] : [config.appOrigin, config.sandboxOrigin];
  if (req.headers.origin !== undefined && !allowedOrigins.includes(req.headers.origin)) return false;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin !== config.appOrigin) return false;
  return typeof req.url === 'string' && req.url.startsWith('/') && !req.url.startsWith('//') && !/[\r\n]/.test(req.url);
}

function requestHeaders(req, upstream, upgrade = false) {
  const headers = cleanHeaders(req.headers);
  for (const key of Object.keys(headers)) if (key.startsWith('tailscale-') || key.startsWith('x-forwarded-') || key === 'forwarded') delete headers[key];
  headers.host = upstream.host;
  headers['accept-encoding'] = 'identity';
  // Only an exact admitted external Origin reaches this translation. Native
  // cookie authentication, CSRF tokens and WebSocket checks still run upstream.
  if (req.headers.origin !== undefined) headers.origin = upstream.origin;
  if (upgrade) { headers.connection = 'Upgrade'; headers.upgrade = 'websocket'; }
  return headers;
}

function directive(csp, name, transform) {
  const entries = String(csp ?? '').split(';').map(x => x.trim()).filter(Boolean);
  let found = false;
  const result = entries.map(entry => {
    const [key, ...tokens] = entry.split(/\s+/);
    if (key.toLowerCase() !== name) return entry;
    if (found) throw new Error('Duplicate security directive.');
    found = true;
    return [key, ...transform(tokens)].join(' ');
  });
  if (!found) throw new Error('Missing native security directive.');
  return result.join('; ');
}

function remoteFramePolicy(csp, config) {
  const value = String(csp);
  const entries = value.split(';').map(x => x.trim().split(/\s+/));
  const transform = tokens => [...new Set([...tokens.filter(t => t !== "'none'" && t !== config.sandboxUpstream && t !== config.sandboxUpstream.replace('127.0.0.1', 'localhost')), config.sandboxOrigin])];
  if (entries.some(([key]) => key.toLowerCase() === 'frame-src')) return directive(value, 'frame-src', transform);
  // Browser mode may send only frame-ancestors. An absent frame/child/default
  // source directive already permits this renderer, so no policy edit is needed.
  const fallback = entries.find(([key]) => key.toLowerCase() === 'child-src') ?? entries.find(([key]) => key.toLowerCase() === 'default-src');
  return fallback ? value + '; frame-src ' + transform(fallback.slice(1)).join(' ') : value;
}

export function adaptHtml(html, headers, config, kind) {
  const output = {...headers};
  if (kind === 'sandbox') {
    const pattern = /const ALLOWED_PARENT_ORIGINS = (\[[^\r\n]*?\]);/g;
    const matches = [...html.matchAll(pattern)];
    if (matches.length !== 1 || !html.includes("inner.setAttribute('sandbox', 'allow-scripts allow-forms')") || !html.includes('SAFE_SANDBOX_TOKENS')) throw new Error('Unrecognized native artifact viewer.');
    const old = JSON.parse(matches[0][1]);
    if (!Array.isArray(old) || !old.includes(config.appUpstream) && !old.includes(config.appUpstream.replace('127.0.0.1', 'localhost'))) throw new Error('Unexpected native artifact parent.');
    html = html.replace(pattern, 'const ALLOWED_PARENT_ORIGINS = ' + JSON.stringify([config.appOrigin]) + ';');
    output['content-security-policy'] = directive(output['content-security-policy'], 'frame-ancestors', () => [config.appOrigin]);
  } else {
    const prefix = 'globalThis.__OPERON__=Object.assign({},globalThis.__OPERON__,';
    const begin = html.indexOf(prefix);
    if (begin < 0) return {html, headers: output};
    if (html.indexOf(prefix, begin + prefix.length) >= 0) throw new Error('Ambiguous native web configuration.');
    const start = begin + prefix.length;
    const end = html.indexOf(')</script>', start);
    if (end < 0) throw new Error('Incomplete native web configuration.');
    const native = JSON.parse(html.slice(start, end));
    const expected = new URL(config.sandboxUpstream);
    const current = new URL(native.sandboxOrigin);
    if (!['localhost', '127.0.0.1'].includes(current.hostname) || current.port !== expected.port) throw new Error('Unexpected native artifact origin.');
    const patched = {...native, sandboxOrigin: config.sandboxOrigin, sandboxAltHosts: []};
    const json = JSON.stringify(patched).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    html = html.slice(0, start) + json + html.slice(end);
    for (const key of ['content-security-policy', 'content-security-policy-report-only']) {
      if (!output[key]) continue;
      output[key] = remoteFramePolicy(output[key], config);
    }
  }
  delete output.etag;
  delete output['last-modified'];
  output['cache-control'] = 'no-store';
  return {html, headers: output};
}

function responseHeaders(headers, config, kind, requestPath = '') {
  const out = cleanHeaders(headers);
  if (out['set-cookie']) out['set-cookie'] = out['set-cookie'].map(cookie => /;\s*secure(?:;|$)/i.test(cookie) ? cookie : cookie + '; Secure');
  if (typeof out.location === 'string') {
    try {
      const url = new URL(out.location);
      if (url.origin === config.appUpstream || url.origin === config.appUpstream.replace('127.0.0.1', 'localhost')) out.location = config.appOrigin + url.pathname + url.search + url.hash;
    } catch { /* Relative and third-party destinations stay as supplied. */ }
  }
  // A no-referrer policy makes browser navigation POSTs send Origin: null,
  // including the native nonce form. Keep same-origin form provenance while
  // withholding the app URL from other sites. The opaque renderer stays private.
  out['referrer-policy'] = kind === 'sandbox' ? 'no-referrer' : 'same-origin';
  // Tailnet access uses the same authenticated native resource decision. Keep
  // its response private and non-cacheable without interpreting or widening
  // the upstream policy result.
  if (kind === 'app' && requestPath.split('?')[0].startsWith('/api/local/resources/')) {
    out['cache-control'] = 'no-store, private';
    out['x-content-type-options'] = 'nosniff';
    const vary = String(out.vary ?? '').split(',').map(value => value.trim()).filter(Boolean);
    if (!vary.some(value => value.toLowerCase() === 'cookie')) vary.push('Cookie');
    out.vary = vary.join(', ');
  }
  return out;
}

export async function startProxies(rawConfig) {
  const config = validateConfig(rawConfig);
  const sockets = new Set();
  const servers = [];
  for (const kind of ['app', 'sandbox']) {
    const upstream = new URL(kind === 'app' ? config.appUpstream : config.sandboxUpstream);
    const server = http.createServer((req, res) => {
      if (!admitted(req, config, kind)) { res.writeHead(403, {'cache-control': 'no-store'}); res.end('Private Chimeric access requires your Tailscale account.'); return; }
      if (kind === 'sandbox' && (!['GET', 'HEAD'].includes(req.method) || req.url.split('?')[0] !== '/mcp_apps')) { res.writeHead(404); res.end('Not found'); return; }
      const pending = http.request({hostname: '127.0.0.1', port: upstream.port, path: req.url, method: req.method, headers: requestHeaders(req, upstream)}, answer => {
        let headers = responseHeaders(answer.headers, config, kind, req.url);
        if (req.method !== 'HEAD' && /\btext\/html\b/i.test(String(headers['content-type']))) {
          let length = 0; const chunks = [];
          answer.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_HTML) { pending.destroy(); answer.destroy(); if (!res.headersSent) res.writeHead(502); res.end('Native page exceeds proxy limit.'); }
            else chunks.push(chunk);
          });
          answer.on('end', () => {
            if (res.writableEnded) return;
            try {
              let bytes = Buffer.concat(chunks);
              const encoding = String(headers['content-encoding'] ?? '').toLowerCase();
              if (encoding === 'gzip') bytes = gunzipSync(bytes, {maxOutputLength: MAX_HTML});
              else if (encoding === 'br') bytes = brotliDecompressSync(bytes, {maxOutputLength: MAX_HTML});
              else if (encoding === 'deflate') bytes = inflateSync(bytes, {maxOutputLength: MAX_HTML});
              else if (encoding && encoding !== 'identity') throw new Error('Unsupported page encoding.');
              const adapted = adaptHtml(bytes.toString('utf8'), headers, config, kind);
              headers = adapted.headers; delete headers['content-encoding'];
              const body = Buffer.from(adapted.html);
              headers['content-length'] = String(body.length);
              res.writeHead(answer.statusCode ?? 502, headers); res.end(body);
            } catch {
              res.writeHead(502, {'cache-control': 'no-store'}); res.end('Chimeric page compatibility check failed. Local access remains available.');
            }
          });
        } else { res.writeHead(answer.statusCode ?? 502, headers); answer.pipe(res); }
        answer.on('error', () => res.destroy());
      });
      pending.on('error', () => { if (!res.headersSent) res.writeHead(502, {'cache-control': 'no-store'}); if (!res.writableEnded) res.end('Open Chimeric on this Mac to connect.'); });
      req.on('aborted', () => pending.destroy());
      res.on('close', () => { if (!res.writableEnded) pending.destroy(); });
      req.pipe(pending);
    });
    server.headersTimeout = 30_000; server.requestTimeout = 0;
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.on('upgrade', (req, socket, head) => {
      if (kind !== 'app' || !admitted(req, config, kind) || req.headers.origin !== config.appOrigin || req.headers.upgrade?.toLowerCase() !== 'websocket') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      const pending = http.request({hostname: '127.0.0.1', port: upstream.port, method: 'GET', path: req.url, headers: requestHeaders(req, upstream, true)});
      socket.on('error', () => pending.destroy());
      pending.on('upgrade', (answer, remote, remoteHead) => {
        sockets.add(remote); remote.on('close', () => sockets.delete(remote));
        const lines = answer.rawHeaders.reduce((result, key, index, all) => index % 2 ? result : [...result, `${key}: ${all[index + 1]}`], []);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join('\r\n')}\r\n\r\n`);
        if (head.length) remote.write(head); if (remoteHead.length) socket.write(remoteHead);
        socket.pipe(remote); remote.pipe(socket);
        remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
        socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
      });
      pending.on('response', answer => { socket.end(`HTTP/1.1 ${answer.statusCode ?? 502} Rejected\r\nConnection: close\r\n\r\n`); answer.resume(); });
      pending.on('error', () => { if (!socket.destroyed) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
      pending.end();
    });
    servers.push(server);
    try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(kind === 'app' ? config.appListenPort : config.sandboxListenPort, '127.0.0.1', ok); }); }
    catch (error) { for (const started of servers) started.close(); throw error; }
  }
  return {config, appPort: servers[0].address().port, sandboxPort: servers[1].address().port, close: () => new Promise(resolveClose => {
    for (const socket of sockets) socket.destroy();
    let remaining = servers.length; for (const server of servers) server.close(() => { if (--remaining === 0) resolveClose(); });
  })};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2]; const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Use a private, user-owned configuration file.');
    const proxy = await startProxies(JSON.parse(readFileSync(path, 'utf8')));
    console.info('[chimeric] private tailnet proxy ready; local research process unchanged');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await proxy.close(); process.exit(0); });
  } catch (error) { console.error('[chimeric] tailnet proxy could not start:', error instanceof Error ? error.message : 'invalid configuration'); process.exitCode = 1; }
}
