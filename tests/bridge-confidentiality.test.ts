import {afterEach, expect, spyOn, test} from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startBridge} from '../src/bridge';
import {ConfidentialityManager} from '../src/confidentiality-manager';
import {ContentReader} from '../src/content';

const cleanup: Array<() => void> = [];
afterEach(() => {for (const close of cleanup.splice(0).reverse()) close();});
function deferred<T = void>() {let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};}
async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 2000) {
  let timer: ReturnType<typeof setTimeout>;
  try {return await Promise.race([promise, new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error(label + ' timed out')), milliseconds);})]);}
  finally {clearTimeout(timer!);}
}
function chat(model: string, events?: any[]) {
  const chunks = events ?? [{choices: [{index: 0, delta: {role: 'assistant', content: 'Synthetic response from ' + model}, finish_reason: null}]}, {choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 4, completion_tokens: 2, total_tokens: 6}}];
  return new Response(chunks.map(event => 'data: ' + JSON.stringify({id: 'synthetic-chat', object: 'chat.completion.chunk', created: 1, model, ...event}) + '\n\n').join('') + 'data: [DONE]\n\n', {headers: {'content-type': 'text/event-stream'}});
}
type Upstream = {request: Request; body: any};
function fixture(options: {upstream?: (record: Upstream, turn: number) => Response | Promise<Response>; auth?: (model: any, signal?: AbortSignal) => void | Promise<void>; content?: (block: any, signal?: AbortSignal) => Promise<any[]>} = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), 'chimeric-bridge-confidentiality-'));
  const upstream: Upstream[] = [], auth: string[] = [], conversions: Array<{type: string; signal?: AbortSignal}> = [], authorizedBodies: any[] = [], timeline: string[] = [], externalTools: any[] = [];
  const mock = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
    const record = {request, body: await request.json()}; upstream.push(record); timeline.push('provider');
    return options.upstream?.(record, upstream.length) ?? chat(record.body.model);
  }});
  const models = ['inside::main', 'inside::review', 'outside::other'].map(qualifiedId => {
    const [provider, id] = qualifiedId.split('::');
    return {provider, id, qualifiedId, name: id, mode: 'chat', api: 'openai-completions', baseUrl: `https://${provider}.example.invalid/v1`, replayKey: qualifiedId + '@synthetic-binding', input: ['text'], maxTokens: 512, contextWindow: 8192, reasoning: false, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, compat: {supportsStore: false, supportsDeveloperRole: false}, requestTimeoutMs: 2000};
  });
  const logicalRequests: Array<{url: string; headers: Headers}> = [];
  // Production OpenAI SDK serialization is preserved. Only this test transport
  // maps the approved logical HTTPS destination onto a synthetic loopback server.
  const fetcher = (async (input: any, init: any) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (!['https://inside.example.invalid', 'https://outside.example.invalid'].includes(url.origin)) throw new Error('Unexpected synthetic provider destination');
    logicalRequests.push({url: request.url, headers: new Headers(request.headers)});
    return await fetch(new URL(url.pathname + url.search, mock.url), {method: request.method, headers: request.headers, body: await request.arrayBuffer(), signal: request.signal});
  }) as typeof fetch;
  const registry: any = {
    profileDir, config: {searchUrl: 'https://search.example.invalid', providers: Object.fromEntries(['inside', 'outside'].map(id => [id, {name: 'Synthetic ' + id, api: 'openai-completions', baseUrl: `https://${id}.example.invalid/v1`, revision: '1', enabled: true}]))},
    state: {model: 'outside::other'}, statuses: {inside: {ready: true}, outside: {ready: true}}, models: new Map(models.map(model => [model.qualifiedId, model])),
    getPrivateCredential: (id: string) => 'synthetic-provider-key-' + id,
    resolve(id: string) {const model = models.find(model => model.qualifiedId === id); if (!model) throw new Error('Unknown synthetic model'); return model;},
    async requestAuth(model: any, signal?: AbortSignal) {timeline.push('auth'); auth.push(model.qualifiedId); await options.auth?.(model, signal); return {apiKey: 'synthetic-provider-key-' + model.provider, fetch: fetcher};},
    safeError: (error: any) => String(error?.message ?? error),
  };
  const manager = new ConfidentialityManager(registry, {protectionEvidence:()=>({verified:true}),owner: {userId: 'owner', organizationId: 'org'},
    lookupFrame: (_profile, id) => ['root', 'child', 'other', 'foreign'].includes(id) ? {frameId: id, rootFrameId: id === 'child' ? 'root' : id, parentFrameId: id === 'child' ? 'root' : null, projectId: 'synthetic-project', ownerId: id === 'foreign' ? 'different-owner' : 'owner', organizationId: 'org'} : undefined,
    transport: async () => {throw new Error('No reviewed HTTP request was authorized by this test');},
  });
  const originalContent = ContentReader.prototype.content;
  const contentSpy = spyOn(ContentReader.prototype, 'content').mockImplementation(async function(this: ContentReader, block: any, images: boolean, signal?: AbortSignal) {conversions.push({type: block?.type, signal}); timeline.push('convert'); return options.content ? options.content(block, signal) : originalContent.call(this, block, images, signal);});
  const token = 'synthetic-local-bridge-token';
  const bridge = startBridge(registry, token, 0, async (...args: any[]) => {externalTools.push(args); return {query: 'synthetic', results: []};}, {async authorize(request, body) {timeline.push('policy'); const result = await manager.authorize(request, body); authorizedBodies.push(structuredClone(body)); timeline.push('authorized'); return result;}});
  const client = new Anthropic({apiKey: token, baseURL: bridge.url.href, maxRetries: 0, timeout: 2500});
  cleanup.push(() => {contentSpy.mockRestore(); manager.close(); bridge.stop(true); mock.stop(true); rmSync(profileDir, {recursive: true, force: true});});
  const body = (extra: any = {}) => ({model: 'outside::other', max_tokens: 128, messages: [{role: 'user', content: 'Fixed synthetic confidentiality test.'}], ...extra});
  const headers = (frameId: string, callSite = 'main') => manager.scope.requestOptions({frameId, callSite}, {}, {}).headers;
  const call = async (frameId?: string, callSite = 'main', extra: any = {}, extraHeaders: any = {}) => await client.messages.create(body(extra) as any, {headers: {...frameId ? headers(frameId, callSite) : {}, ...extraHeaders}});
  const enable = async () => {await manager.approveConnection({connectionId: 'inside', expectedRevision: 0, purposes: ['model']}); await manager.setMode({frameId: 'root', mode: 'class2', expectedRevision: 0, main: 'inside::main', reviewer: 'inside::review'});};
  const revoke = () => manager.approveConnection({connectionId: 'inside', expectedRevision: manager.policy.snapshot().revision, purposes: []});
  return {manager, registry, client, bridge, upstream, logicalRequests, auth, conversions, authorizedBodies, timeline, externalTools, body, headers, call, enable, revoke};
}

test('unverified and foreign native scopes fail before credential resolution or document preparation', async () => {
  const f = fixture(); await f.enable();
  const extra = {class2: false, metadata: {user_id: '{"frame_id":"root"}'}, messages: [{role: 'user', content: [{type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: 'invalid-base64'}}]}]};
  await expect(f.call(undefined, 'main', extra)).rejects.toThrow('no verified chat scope');
  await expect(f.call(undefined, 'main', extra, {'x-chimeric-session-scope': 'forged-proof'})).rejects.toThrow('verified native session scope');
  await expect(f.call('child', 'main', {...extra, metadata: {__chimeric_scope: 'forged-proof'}})).rejects.toThrow('verified native session scope');
  await expect(f.call('child', 'main', {...extra, metadata: f.manager.scope.nativeMetadata({frameId: 'other'}, {})})).rejects.toThrow('scopes disagree');
  await expect(f.call('foreign', 'main', extra)).rejects.toThrow('different local workspace owner');
  expect(f.auth).toHaveLength(0); expect(f.conversions).toHaveLength(0); expect(f.upstream).toHaveLength(0); expect(f.logicalRequests).toHaveLength(0);
});

test('protected attachment URLs and unconfined binary conversion are rejected before auth or content preparation', async () => {
  const f = fixture(); await f.enable();
  for (const block of [
    {type: 'image', source: {type: 'url', url: 'https://attachment.example.invalid/synthetic.png'}},
    {type: 'document', source: {type: 'url', url: 'https://attachment.example.invalid/synthetic.pdf'}},
    {type: 'document', source: {type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-synthetic').toString('base64')}},
  ]) await expect(f.call('child', 'main', {messages: [{role: 'user', content: [block]}]})).rejects.toThrow(block.source.type === 'url' ? 'reviewed outgoing request' : 'conversion is disabled');
  expect(f.auth).toHaveLength(0); expect(f.conversions).toHaveLength(0); expect(f.upstream).toHaveLength(0); expect(f.logicalRequests).toHaveLength(0);
});

test('protected descendants inherit approved routing for every model role through the real OpenAI SDK', async () => {
  const f = fixture(); await f.enable();
  for (const role of ['main', 'reviewer', 'small', 'medium', 'large', 'memory', 'classifier', 'compaction', 'lineage']) {
    const result: any = await f.call('child', role), target = role === 'reviewer' ? 'review' : 'main';
    expect(result.model).toBe('inside::' + target); expect(result.content).toEqual([{type: 'text', text: 'Synthetic response from ' + target}]);
    expect(f.upstream.at(-1)!.body.model).toBe(target); expect(f.logicalRequests.at(-1)!.url).toBe('https://inside.example.invalid/v1/chat/completions');
    expect(f.upstream.at(-1)!.request.headers.has('x-chimeric-session-scope')).toBe(false);
  }
  expect(new Set(f.auth)).toEqual(new Set(['inside::main', 'inside::review']));
  expect(f.timeline.indexOf('authorized')).toBeLessThan(f.timeline.indexOf('auth')); expect(f.timeline.indexOf('auth')).toBeLessThan(f.timeline.indexOf('convert')); expect(f.timeline.indexOf('convert')).toBeLessThan(f.timeline.indexOf('provider'));
  const ordinary: any = await f.call('other'); expect(ordinary.model).toBe('outside::other'); expect(f.upstream.at(-1)!.body.model).toBe('other'); expect(f.logicalRequests.at(-1)!.url).toBe('https://outside.example.invalid/v1/chat/completions');
});

test('metadata-only native proof establishes scope and is stripped before OpenAI serialization and upstream headers', async () => {
  const f = fixture(); await f.enable();
  const metadata = f.manager.scope.nativeMetadata({frameId: 'child', lane: 'memory'}, {user_id: 'synthetic-user-metadata'}), proof = metadata.__chimeric_scope;
  expect(typeof proof).toBe('string');
  const result: any = await f.call(undefined, 'main', {metadata}); expect(result.model).toBe('inside::main');
  expect(f.authorizedBodies[0].metadata).toEqual({user_id: 'synthetic-user-metadata'});
  const record = f.upstream[0], serialized = JSON.stringify(record.body);
  expect(serialized).not.toContain('__chimeric_scope'); expect(serialized).not.toContain(proof); expect(record.request.headers.has('x-chimeric-session-scope')).toBe(false);
  expect(record.request.headers.get('authorization')).toBe('Bearer synthetic-provider-key-inside'); expect(serialized).not.toContain('synthetic-local-bridge-token');
});

test('revoking the approved connection aborts an in-flight provider stream without another dispatch', async () => {
  const remoteClosed = deferred(), textSeen = deferred(); let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const f = fixture({upstream(record) {
    record.request.signal.addEventListener('abort', () => {remoteClosed.resolve(); try {controller?.close();} catch {}}, {once: true});
    return new Response(new ReadableStream<Uint8Array>({start(value) {controller = value; value.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({id: 'synthetic-idle', object: 'chat.completion.chunk', model: record.body.model, choices: [{index: 0, delta: {role: 'assistant', content: 'synthetic pending'}, finish_reason: null}]}) + '\n\n'));}, cancel() {remoteClosed.resolve();}}), {headers: {'content-type': 'text/event-stream'}});
  }}); await f.enable();
  const stream = f.client.messages.stream(f.body() as any, {headers: f.headers('child')}), result = stream.finalMessage().then(value => ({ok: true, value}), error => ({ok: false, error}));
  stream.on('text', () => textSeen.resolve()); await bounded(textSeen.promise, 'First synthetic provider text');
  await f.revoke(); const final = await bounded(result, 'Native cancellation'); await bounded(remoteClosed.promise, 'Upstream cancellation');
  expect(final.ok).toBe(false); expect(f.upstream).toHaveLength(1); expect(f.auth).toEqual(['inside::main']);
  await expect(f.call('child')).rejects.toThrow('no longer approved'); expect(f.upstream).toHaveLength(1); expect(f.auth).toHaveLength(1);
}, 8000);

test('revocation while auth is pending prevents subsequent document preparation and provider dispatch', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({async auth() {entered.resolve(); await release.promise;}}); await f.enable();
  const pending = f.call('child', 'main', {messages: [{role: 'user', content: [{type: 'document', source: {type: 'text', data: 'Fixed synthetic document.'}}]}]}).then(value => ({ok: true, value}), error => ({ok: false, error}));
  try {await bounded(entered.promise, 'Synthetic auth gate'); await f.revoke(); release.resolve(); const result = await bounded(pending, 'Revoked auth response'); expect(result.ok).toBe(false); expect(f.conversions).toHaveLength(0); expect(f.upstream).toHaveLength(0);}
  finally {release.resolve(); await pending;}
});

test('revocation reaches an active content-preparation signal and prevents provider dispatch after it returns', async () => {
  const entered = deferred(), release = deferred(); let contentSignal: AbortSignal | undefined;
  const f = fixture({async content(_block, signal) {contentSignal = signal; entered.resolve(); await release.promise; return [{type: 'text', text: 'Synthetic prepared text.'}];}}); await f.enable();
  const pending = f.call('child', 'main', {messages: [{role: 'user', content: [{type: 'document', source: {type: 'text', data: 'Fixed synthetic document.'}}]}]}).then(value => ({ok: true, value}), error => ({ok: false, error}));
  try {await bounded(entered.promise, 'Synthetic content gate'); expect(contentSignal?.aborted).toBe(false); await f.revoke(); expect(contentSignal?.aborted).toBe(true); release.resolve(); expect((await bounded(pending, 'Revoked preparation response')).ok).toBe(false); expect(f.upstream).toHaveLength(0);}
  finally {release.resolve(); await pending;}
});

test('a protected model cannot trigger unreviewed server search through the bridge continuation loop', async () => {
  const f = fixture({upstream(record, turn) {
    if (turn === 1) return chat(record.body.model, [
      {choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: 'synthetic-search', type: 'function', function: {name: 'web_search', arguments: '{"query":"fixed synthetic public query"}'}}]}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}]},
    ]);
    expect(JSON.stringify(record.body.messages)).toContain('reviewed outgoing request'); return chat(record.body.model);
  }}); await f.enable();
  const result: any = await f.call('child', 'main', {tools: [{type: 'web_search_20250305', name: 'web_search'}], tool_choice: {type: 'tool', name: 'web_search'}});
  expect(f.externalTools).toHaveLength(0); expect(f.upstream).toHaveLength(2); expect(f.upstream.every(record => record.body.model === 'main')).toBe(true);
  expect(result.content.find((block: any) => block.type === 'web_search_tool_result')).toMatchObject({is_error: true, content: {type: 'web_search_tool_result_error', error_code: 'unavailable'}});
});
