import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import { Registry } from '../src/registry';
import { ProviderManager, ProviderChangeError } from '../src/provider-manager';
import { installProviderHttp } from '../src/providers-http';
import { startBridge } from '../src/bridge';
import { SubscriptionManager, SubscriptionVault } from '../src/subscription';

function testWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'science-adv-'));
  const registry = new Registry({
    envFile: '/missing',
    credentialRefsFile: '/missing',
    modelMetadataFile: '/missing',
    providers: {},
    defaultModel: 'unconfigured',
  }, dir);
  const manager = new ProviderManager(registry);
  return {
    dir,
    registry,
    manager,
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const jwt = (suffix = 'tok') =>
  'header.' +
  Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url') +
  '.' +
  suffix;

function mockApp(manager: ProviderManager) {
  const routes = new Map<string, (req: any, rep: any) => Promise<any>>();
  const app = {
    get(path: string, handler: any) { routes.set('GET ' + path, handler); },
    post(path: string, handler: any) { routes.set('POST ' + path, handler); },
    put(path: string, handler: any) { routes.set('PUT ' + path, handler); },
    delete(path: string, handler: any) { routes.set('DELETE ' + path, handler); },
    addHook() {},
  };
  installProviderHttp(app, manager, 'adv-test');

  const dispatch = async (method: string, path: string, body?: any, params: Record<string, string> = {}) => {
    let handler = routes.get(`${method} ${path}`);
    if (!handler) {
      for (const [key, fn] of routes.entries()) {
        const [m, p] = key.split(' ');
        if (m === method && p.includes(':')) {
          const pattern = new RegExp('^' + p.replace(/:([a-zA-Z0-9_-]+)/g, '(?<$1>[^/]+)') + '$');
          const match = path.match(pattern);
          if (match) {
            handler = fn;
            params = { ...params, ...(match.groups ?? {}) };
            break;
          }
        }
      }
    }
    if (!handler) throw new Error(`No route for ${method} ${path}`);
    let statusCode = 200;
    let payload: any;
    const reply = {
      code(c: number) { statusCode = c; return reply; },
      send(data: any) { payload = data; return reply; },
      type() { return reply; },
      header() { return reply; },
    };
    const req = { body, params };
    const res = await handler(req, reply);
    return { status: statusCode, body: payload ?? res };
  };

  return { dispatch };
}

// Minimal valid images
const valid1x1Png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const valid1x1Jpeg = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const valid1x1Gif = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const valid1x1Webp = 'UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD++ldotRJUvJ+iMAAA';

// =========================================================================
// Area 1: Concurrency & Revision Drift
// =========================================================================
test('Adv 1.1: Stale expectedRevision in upsert is rejected with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'Conn1',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    expect(saved.revision).toBe(1);

    // Attempt upsert with stale revision 0
    let err: any;
    try {
      await f.manager.upsert({
        expectedRevision: 0,
        name: 'Conn1 Update',
        baseUrl: 'http://127.0.0.1:9001/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: 'm1' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toContain('Connections changed in another window');

    // HTTP layer test
    const { dispatch } = mockApp(f.manager);
    const res = await dispatch('POST', '/api/local/connections', {
      expectedRevision: 0,
      name: 'Conn1 Via HTTP',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('Connections changed in another window');
  } finally {
    f.close();
  }
});

test('Adv 1.2: Stale expectedRevision in remove is rejected with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'Conn1',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    const connId = saved.connections[0].id;
    expect(f.registry.revision).toBe(1);

    // Call remove with stale revision 0
    let err: any;
    try {
      await f.manager.remove({ id: connId, expectedRevision: 0 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toContain('Connections changed in another window');

    // HTTP layer
    const { dispatch } = mockApp(f.manager);
    const res = await dispatch('DELETE', `/api/local/connections/${connId}`, { expectedRevision: 0 });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('Connections changed in another window');
  } finally {
    f.close();
  }
});

test('Adv 1.3: Stale expectedRevision in settings is rejected with 409', async () => {
  const f = testWorkspace();
  try {
    await f.manager.upsert({
      expectedRevision: 0,
      name: 'Conn1',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    expect(f.registry.revision).toBe(1);

    let err: any;
    try {
      await f.manager.settings({
        expectedRevision: 0,
        roles: {},
        headlineModels: [],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toContain('Connections changed in another window');

    // HTTP layer
    const { dispatch } = mockApp(f.manager);
    const res = await dispatch('PUT', '/api/local/connections/settings', {
      expectedRevision: 0,
      roles: {},
      headlineModels: [],
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('Connections changed in another window');
  } finally {
    f.close();
  }
});

test('Adv 1.4: Mismatched connectionRevision is rejected with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'Conn1',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    const connId = saved.connections[0].id;
    const realRevision = saved.connections[0].connectionRevision;

    // Mutate with a stale/drifted connectionRevision
    let err: any;
    try {
      await f.manager.upsert({
        expectedRevision: 1,
        id: connId,
        connectionRevision: 'stale-uuid-drifted',
        name: 'Conn1 Renamed',
        baseUrl: 'http://127.0.0.1:9001/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: 'm1' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toContain('This connection was edited in another window');

    // Via HTTP
    const { dispatch } = mockApp(f.manager);
    const res = await dispatch('POST', '/api/local/connections', {
      expectedRevision: 1,
      id: connId,
      connectionRevision: 'stale-uuid-drifted',
      name: 'Conn1 Renamed',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    expect(res.status).toBe(409);
    expect(res.body.detail).toContain('This connection was edited in another window');

    // With matching connectionRevision, it succeeds
    const ok = await f.manager.upsert({
      expectedRevision: 1,
      id: connId,
      connectionRevision: realRevision,
      name: 'Conn1 Renamed',
      baseUrl: 'http://127.0.0.1:9001/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }],
    });
    expect(ok.connections[0].name).toBe('Conn1 Renamed');
    expect(ok.revision).toBe(2);
  } finally {
    f.close();
  }
});

test('Adv 1.5: 10 concurrent racing saves with same revision allow exactly 1 success', async () => {
  const f = testWorkspace();
  try {
    const promises = Array.from({ length: 10 }, (_, i) =>
      f.manager.upsert({
        expectedRevision: 0,
        name: `Conn_${i}`,
        baseUrl: `http://127.0.0.1:900${i}/v1`,
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: `m_${i}` }],
      })
    );
    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(9);

    for (const rej of rejected as PromiseRejectedResult[]) {
      expect(rej.reason).toBeInstanceOf(ProviderChangeError);
      expect((rej.reason as ProviderChangeError).status).toBe(409);
    }
    expect(f.registry.revision).toBe(1);
  } finally {
    f.close();
  }
});

// =========================================================================
// Area 2: Active Reference Guard
// =========================================================================
test('Adv 2.1: Deleting connection providing active default model is blocked with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'ProviderA',
      baseUrl: 'http://127.0.0.1:9010/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'modelA' }],
    });
    const connId = saved.connections[0].id;
    const qualifiedModel = `${connId}::modelA`;
    f.registry.select(qualifiedModel);
    expect(f.registry.state.model).toBe(qualifiedModel);

    // Attempt removal
    let err: any;
    try {
      await f.manager.remove({ id: connId, expectedRevision: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Choose a different default model before removing the selected model.');

    // Connection and model must still exist intact
    expect(f.registry.models.has(qualifiedModel)).toBe(true);
    expect(f.registry.config.providers[connId]).toBeDefined();

    // Via HTTP
    const { dispatch } = mockApp(f.manager);
    const res = await dispatch('DELETE', `/api/local/connections/${connId}`, { expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(res.body.detail).toBe('Choose a different default model before removing the selected model.');
  } finally {
    f.close();
  }
});

test('Adv 2.2: Deleting connection providing background role model is blocked with 409', async () => {
  const f = testWorkspace();
  try {
    // Add Conn A
    const savedA = await f.manager.upsert({
      expectedRevision: 0,
      name: 'ProviderA',
      baseUrl: 'http://127.0.0.1:9010/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'modelA' }],
    });
    const connA = savedA.connections[0].id;

    // Add Conn B
    const savedB = await f.manager.upsert({
      expectedRevision: 1,
      name: 'ProviderB',
      baseUrl: 'http://127.0.0.1:9011/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'modelB' }],
    });
    const connB = savedB.connections[1].id;

    // Set default model to Conn B, and role 'small' to Conn A
    f.registry.select(`${connB}::modelB`);
    await f.manager.settings({
      expectedRevision: 2,
      roles: { small: `${connA}::modelA` },
      headlineModels: [],
    });

    // Attempt to remove Conn A without resetRoles
    let err: any;
    try {
      await f.manager.remove({ id: connA, expectedRevision: 3, resetRoles: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Choose a replacement for the background model role before removing this model.');

    // With resetRoles: true, Conn A can be safely removed because it is NOT the default model
    const after = await f.manager.remove({ id: connA, expectedRevision: 3, resetRoles: true });
    expect(after.roles.small).toBeUndefined();
    expect(f.registry.models.has(`${connA}::modelA`)).toBe(false);
  } finally {
    f.close();
  }
});

test('Adv 2.3: Deleting default model connection with resetRoles:true is STILL blocked with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'ProviderA',
      baseUrl: 'http://127.0.0.1:9010/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'modelA' }],
    });
    const connId = saved.connections[0].id;
    f.registry.select(`${connId}::modelA`);

    let err: any;
    try {
      await f.manager.remove({ id: connId, expectedRevision: 1, resetRoles: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Choose a different default model before removing the selected model.');
  } finally {
    f.close();
  }
});

test('Adv 2.4: Modifying connection to drop active default model is blocked with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'ProviderMulti',
      baseUrl: 'http://127.0.0.1:9010/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'm1' }, { id: 'm2' }],
    });
    const connId = saved.connections[0].id;
    f.registry.select(`${connId}::m1`);
    expect(f.registry.state.model).toBe(`${connId}::m1`);

    // Modify connection to keep only m2 (dropping m1)
    let err: any;
    try {
      await f.manager.upsert({
        expectedRevision: 1,
        id: connId,
        name: 'ProviderMulti',
        baseUrl: 'http://127.0.0.1:9010/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: 'm2' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Choose a different default model before removing the selected model.');

    // Original model m1 must still be in registry
    expect(f.registry.models.has(`${connId}::m1`)).toBe(true);
  } finally {
    f.close();
  }
});

test('Adv 2.5: Modifying connection to drop role model is blocked with 409', async () => {
  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'ProviderMulti',
      baseUrl: 'http://127.0.0.1:9010/v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'default_m' }, { id: 'role_m' }],
    });
    const connId = saved.connections[0].id;
    f.registry.select(`${connId}::default_m`);
    await f.manager.settings({
      expectedRevision: 1,
      roles: { small: `${connId}::role_m` },
      headlineModels: [],
    });

    // Modify connection to drop role_m
    let err: any;
    try {
      await f.manager.upsert({
        expectedRevision: 2,
        id: connId,
        name: 'ProviderMulti',
        baseUrl: 'http://127.0.0.1:9010/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: 'default_m' }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderChangeError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('Choose a replacement for the background model role before removing this model.');

    expect(f.registry.models.has(`${connId}::role_m`)).toBe(true);
  } finally {
    f.close();
  }
});

// =========================================================================
// Area 3: Reasoning Effort Boundary
// =========================================================================
test('Adv 3.1: OpenAI Completions suppresses reasoning fields when effort is off', async () => {
  let interceptedPayload: any = null;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      interceptedPayload = await req.json();
      const chunk = { id: 'chat_test', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'MockOpenAI',
      baseUrl: upstream.url.href + 'v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'reasoning-model' }],
      capabilities: {
        images: false,
        reasoning: true,
        efforts: ['low', 'medium', 'high', 'max'],
        thinkingFormat: 'chat-template',
      },
    });
    const modelId = `${saved.connections[0].id}::reasoning-model`;
    const bridge = startBridge(f.registry, 'adv-token');

    try {
      // 1. Request with output_config: { effort: 'off' }
      const res1 = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'adv-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'test' }],
          output_config: { effort: 'off' },
        }),
      });
      expect(res1.status).toBe(200);
      expect(interceptedPayload.reasoning_effort).toBeUndefined();
      expect(interceptedPayload.reasoning).toBeUndefined();

      // 2. Request with thinking: { type: 'disabled' }
      const res2 = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'adv-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'test' }],
          thinking: { type: 'disabled' },
        }),
      });
      expect(res2.status).toBe(200);
      expect(interceptedPayload.reasoning_effort).toBeUndefined();

      // 3. Request with output_config: { effort: 'max' }
      const res3 = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'adv-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'test' }],
          output_config: { effort: 'max' },
        }),
      });
      expect(res3.status).toBe(200);
      expect(interceptedPayload.reasoning_effort).toBe('max');
    } finally {
      bridge.stop(true);
    }
  } finally {
    upstream.stop(true);
    f.close();
  }
});

test('Adv 3.2: ChatGPT Codex suppresses reasoning when off and passes max cleanly', async () => {
  let interceptedPayload: any = null;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const bytes = Buffer.from(await req.arrayBuffer());
      const text = req.headers.get('content-encoding') === 'zstd' ? zstdDecompressSync(bytes).toString() : bytes.toString();
      interceptedPayload = JSON.parse(text);
      const item = { id: 'msg', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CODEX_OK' }] };
      const resp = { id: 'resp', object: 'response', status: 'completed', model: 'gpt-codex', output: [item], usage: { input_tokens: 1, output_tokens: 1 } };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_text.delta', output_index: 0, delta: 'CODEX_OK' },
        { type: 'response.completed', response: resp },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const fDir = mkdtempSync(join(tmpdir(), 'science-codex-adv-'));
  const vault = new SubscriptionVault(join(fDir, 'auth'));
  vault.write({ session: randomUUID(), version: randomUUID(), credential: { type: 'oauth', access: jwt('active'), refresh: 'refr', expires: Date.now() + 3600_000 } });
  const subManager = new SubscriptionManager(vault, { endpoint: upstream.url.href + 'v1/codex/responses' });

  const registry = new Registry({
    envFile: '/missing',
    credentialRefsFile: '/missing',
    modelMetadataFile: '/missing',
    providers: {
      'openai-codex': {
        name: 'ChatGPT',
        baseUrl: upstream.url.href + 'v1',
        api: 'openai-codex-responses',
        models: [{ id: 'gpt-codex' }],
        modelOverrides: { 'gpt-codex': { reasoning: true } },
      },
    },
    defaultModel: 'openai-codex::gpt-codex',
  }, fDir);
  registry.subscription = subManager;
  await registry.refresh();
  const bridge = startBridge(registry, 'codex-adv-token');

  try {
    // 1. Off suppression
    const resOff = await fetch(bridge.url.href + 'v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'codex-adv-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-codex::gpt-codex',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'off' },
      }),
    });
    expect(resOff.status).toBe(200);
    // In Codex/Responses API, reasoning suppression is represented as effort: 'none'
    expect(interceptedPayload.reasoning).toEqual({ effort: 'none' });

    // 2. Max effort
    const resMax = await fetch(bridge.url.href + 'v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': 'codex-adv-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'openai-codex::gpt-codex',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
        output_config: { effort: 'max' },
      }),
    });
    expect(resMax.status).toBe(200);
    expect(interceptedPayload.reasoning).toMatchObject({ effort: 'max' });
  } finally {
    bridge.stop(true);
    upstream.stop(true);
    subManager.close();
    rmSync(fDir, { recursive: true, force: true });
  }
});

test('Adv 3.3: Effort spectrum verification and invalid selection rejection', () => {
  const f = testWorkspace();
  try {
    const model = {
      id: 'spec-m',
      qualifiedId: 'p::spec-m',
      name: 'Spectrum Model',
      reasoning: true,
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      input: ['text'],
      mode: 'chat',
    };
    f.registry.models.set('p::spec-m', model as any);

    // Valid selections
    for (const lvl of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const snap = f.registry.select('p::spec-m', lvl);
      expect(snap.effort).toBe(lvl);
    }

    // Invalid selection
    expect(() => f.registry.select('p::spec-m', 'extreme-overdrive')).toThrow('Unsupported reasoning effort');
  } finally {
    f.close();
  }
});

// =========================================================================
// Area 4: Multimodal Format Validation
// =========================================================================
test('Adv 4.1: Non-vision model strictly rejects image content blocks', async () => {
  let calls = 0;
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      calls++;
      return Response.json({ id: 'ok', object: 'chat.completion', choices: [] });
    },
  });

  const f = testWorkspace();
  try {
    await f.manager.upsert({
      expectedRevision: 0,
      name: 'TextOnly',
      baseUrl: upstream.url.href + 'v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'text-model' }],
      capabilities: { images: false, reasoning: false, efforts: ['medium'], thinkingFormat: 'openai' },
    });
    const modelId = `${f.manager.snapshot().connections[0].id}::text-model`;
    const bridge = startBridge(f.registry, 'img-token');

    try {
      const res = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'img-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'look at this' },
                { type: 'image', source: { type: 'base64', media_type: 'image/png', data: valid1x1Png } },
              ],
            },
          ],
        }),
      });
      expect(res.status).toBe(400);
      const json = await res.json() as any;
      expect(json.error.message).toContain('no verified image capability');
      expect(calls).toBe(0); // Upstream was never called
    } finally {
      bridge.stop(true);
    }
  } finally {
    upstream.stop(true);
    f.close();
  }
});

test('Adv 4.2: Vision model cleanly rejects truncated and corrupted image headers', async () => {
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const f = testWorkspace();
  try {
    await f.manager.upsert({
      expectedRevision: 0,
      name: 'Vision',
      baseUrl: upstream.url.href + 'v1',
      api: 'openai-completions',
      mode: 'manual',
      models: [{ id: 'vision-model' }],
      capabilities: { images: true, reasoning: false, efforts: ['medium'], thinkingFormat: 'openai' },
    });
    const modelId = `${f.manager.snapshot().connections[0].id}::vision-model`;
    const bridge = startBridge(f.registry, 'vision-token');

    const testImage = async (data: string, mediaType: string) => {
      const res = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'vision-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 64,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data } }] }],
        }),
      });
      return res;
    };

    try {
      // 1. Truncated PNG (only 20 bytes)
      const pngBytes = Buffer.from(valid1x1Png, 'base64');
      const truncatedPng = pngBytes.subarray(0, 20).toString('base64');
      const res1 = await testImage(truncatedPng, 'image/png');
      expect(res1.status).toBe(400);
      expect((await res1.json() as any).error.message).toContain('do not match');

      // 2. Corrupted PNG Magic Header (replace 0x89 with 0x00)
      const badMagicPng = Buffer.from(pngBytes);
      badMagicPng[0] = 0x00;
      const res2 = await testImage(badMagicPng.toString('base64'), 'image/png');
      expect(res2.status).toBe(400);

      // 3. Corrupted PNG width = 0 (bytes 16..19)
      const zeroWidthPng = Buffer.from(pngBytes);
      zeroWidthPng.writeUInt32BE(0, 16);
      const res3 = await testImage(zeroWidthPng.toString('base64'), 'image/png');
      expect(res3.status).toBe(400);

      // 4. Truncated JPEG (missing EOI 0xFF 0xD9)
      const jpegBytes = Buffer.from(valid1x1Jpeg, 'base64');
      const truncatedJpeg = jpegBytes.subarray(0, jpegBytes.length - 2).toString('base64');
      const res4 = await testImage(truncatedJpeg, 'image/jpeg');
      expect(res4.status).toBe(400);

      // 5. Truncated GIF (< 14 bytes)
      const gifBytes = Buffer.from(valid1x1Gif, 'base64');
      const truncatedGif = gifBytes.subarray(0, 10).toString('base64');
      const res5 = await testImage(truncatedGif, 'image/gif');
      expect(res5.status).toBe(400);

      // 6. Truncated WebP (< 20 bytes)
      const webpBytes = Buffer.from(valid1x1Webp, 'base64');
      const truncatedWebp = webpBytes.subarray(0, 15).toString('base64');
      const res6 = await testImage(truncatedWebp, 'image/webp');
      expect(res6.status).toBe(400);

      // 7. Invalid Base64 data string
      const res7 = await testImage('not---valid$$$base64', 'image/png');
      expect(res7.status).toBe(400);
      expect((await res7.json() as any).error.message).toContain('invalid base64');

      // 8. Media type mismatch (JPEG bytes declared as PNG)
      const res8 = await testImage(valid1x1Jpeg, 'image/png');
      expect(res8.status).toBe(400);
    } finally {
      bridge.stop(true);
    }
  } finally {
    upstream.stop(true);
    f.close();
  }
});

// =========================================================================
// Area 5: In-flight Request Stability
// =========================================================================
test('Adv 5.1: Connection updates during in-flight stream do not crash or corrupt the active turn', async () => {
  let releaseChunk!: () => void;
  const chunkGate = new Promise<void>((r) => { releaseChunk = r; });
  let firstChunkSent!: () => void;
  const firstChunkGate = new Promise<void>((r) => { firstChunkSent = r; });

  const headersReceived: string[] = [];
  const upstream1 = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      headersReceived.push(req.headers.get('authorization')!);
      return new Response(
        new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const chunk1 = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'START_' }, finish_reason: null }] };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk1)}\n\n`));
            firstChunkSent();

            // Wait for admin connection update
            await chunkGate;

            const chunk2 = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'MIDDLE_' }, finish_reason: null }] };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk2)}\n\n`));

            const chunk3 = { id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'END' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk3)}\n\n`));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    },
  });

  const upstream2 = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      headersReceived.push(req.headers.get('authorization')!);
      const done = { id: 'c2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'NEW_UPSTREAM' }, finish_reason: 'stop' }] };
      return new Response(`data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    },
  });

  const f = testWorkspace();
  try {
    const saved = await f.manager.upsert({
      expectedRevision: 0,
      name: 'DynamicConn',
      baseUrl: upstream1.url.href + 'v1',
      api: 'openai-completions',
      apiKey: 'key-v1',
      mode: 'manual',
      models: [{ id: 'stream-model' }],
    });
    const connId = saved.connections[0].id;
    const modelId = `${connId}::stream-model`;

    const bridge = startBridge(f.registry, 'stream-token');

    try {
      // 1. Start streaming request
      const streamReq = fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'stream-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 128,
          stream: true,
          messages: [{ role: 'user', content: 'stream please' }],
        }),
      });

      // Wait until upstream1 has begun streaming
      await firstChunkGate;

      // 2. While stream is in flight, perform a connection update to upstream2 with new key
      const updated = await f.manager.upsert({
        expectedRevision: 1,
        id: connId,
        name: 'DynamicConn',
        baseUrl: upstream2.url.href + 'v1',
        api: 'openai-completions',
        apiKey: 'key-v2',
        confirmDestinationChange: true,
        mode: 'manual',
        models: [{ id: 'stream-model' }],
      });
      expect(updated.revision).toBe(2);

      // Also add another connection concurrently
      await f.manager.upsert({
        expectedRevision: 2,
        name: 'AnotherConn',
        baseUrl: 'http://127.0.0.1:9099/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{ id: 'm_extra' }],
      });
      expect(f.registry.revision).toBe(3);

      // 3. Release the in-flight stream's next chunks
      releaseChunk();

      // 4. In-flight stream completes cleanly
      const streamRes = await streamReq;
      expect(streamRes.status).toBe(200);

      const reader = streamRes.body!.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value);
      }

      expect(fullText).toContain('START_');
      expect(fullText).toContain('MIDDLE_');
      expect(fullText).toContain('END');
      expect(fullText).toContain('message_stop');

      // 5. Subsequent request immediately targets upstream2 with key-v2
      const nextRes = await fetch(bridge.url.href + 'v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'stream-token', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          max_tokens: 128,
          stream: false,
          messages: [{ role: 'user', content: 'next' }],
        }),
      });
      expect(nextRes.status).toBe(200);
      const nextJson = await nextRes.json() as any;
      expect(nextJson.content[0].text).toBe('NEW_UPSTREAM');

      expect(headersReceived).toEqual(['Bearer key-v1', 'Bearer key-v2']);
    } finally {
      bridge.stop(true);
    }
  } finally {
    releaseChunk();
    upstream1.stop(true);
    upstream2.stop(true);
    f.close();
  }
});
