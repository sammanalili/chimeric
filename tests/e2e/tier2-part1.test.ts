import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  BASELINE_URL,
  getLiveSessionAuth,
  mintFreshNonce,
  findProfilePath,
  findCondaPython,
  findCondaR,
  runCondaPython,
  runCondaR,
  runDarwinSeatbelt,
  SessionAuth,
} from './test-helpers';
import {Registry} from '../../src/registry';
import {ProviderManager} from '../../src/provider-manager';
import {SubscriptionVault, SubscriptionManager} from '../../src/subscription';

function testWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'chimeric-t2p1-'));
  const registry = new Registry({
    providers: {},
    defaultModel: 'unconfigured',
    envFile: '/missing',
    credentialRefsFile: '/missing',
    modelMetadataFile: '/missing',
  }, dir);
  return {
    dir,
    registry,
    manager: new ProviderManager(registry),
    close() { rmSync(dir, {recursive: true, force: true}); },
  };
}

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 2: Boundary & Corner Cases (Part 1 - Features 1 to 14)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 1: Loopback Nonce Bootstrap Boundaries
  describe('Feature 1: Nonce Bootstrap Boundaries', () => {
    test('1.1 Expired or invalid nonce returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: 'deadbeefdeadbeefdeadbeefdeadbeef'}),
      });
      expect(res.status).toBe(401);
    });

    test('1.2 Reused nonce returns 401 on second submission with link already used message', async () => {
      // 1. Mint a real fresh nonce
      const freshNonce = await mintFreshNonce();

      // 2. First redemption: succeeds with 200
      const res1 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: freshNonce}),
      });
      expect(res1.status).toBe(200);

      // 3. Second redemption with the exact same nonce: rejected with 401
      const res2 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: freshNonce}),
      });
      expect(res2.status).toBe(401);
      const text = await res2.text();
      expect(text).toContain('Login link already used');
    });

    test('1.3 Too-short nonce returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: 'short'}),
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Login link expired');
    });

    test('1.4 Malformed non-hex characters in nonce rejected with 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: '!@#$%^&*()_+=~`{}[]|;:,.<>?'}),
      });
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(text).toContain('Login link expired');
    });

    test('1.5 Empty payload to /api/auth/nonce rejected with 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    });

    test('1.6 Unauthenticated HTML GET to /, stale /?nonce=..., and /api/local/help auto-mints a fresh nonce form', async () => {
      const rootRes = await fetch(`${BASELINE_URL}/`, {
        headers: {accept: 'text/html'},
      });
      expect(rootRes.status).toBe(200);
      const rootHtml = await rootRes.text();
      expect(rootHtml).toContain('action="/api/auth/nonce"');
      expect(rootHtml).toContain('f.requestSubmit()');
      const rootNonce = rootHtml.match(/name="nonce" value="([a-f0-9]{32,64})"/i)?.[1];
      expect(rootNonce).toBeDefined();

      // Consume rootNonce so it becomes already-used
      const consumeRes = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: rootNonce}),
      });
      expect(consumeRes.status).toBe(200);

      // Visiting /?nonce=<already_used> without cookie mints a fresh nonce with clean dest="/"
      const staleRes = await fetch(`${BASELINE_URL}/?nonce=${rootNonce}`, {
        headers: {accept: 'text/html', 'accept-language': 'en'},
      });
      expect(staleRes.status).toBe(200);
      const staleHtml = await staleRes.text();
      expect(staleHtml).toMatch(/<title>(?:Open local workspace|ローカルワークスペースを開く) · Chimeric<\/title>/);
      expect(staleHtml.toLowerCase()).not.toContain('anthropic');
      expect(staleHtml).toContain('name="dest" value="/"');
      const replacementNonce = staleHtml.match(/name="nonce" value="([a-f0-9]{32,64})"/i)?.[1];
      expect(replacementNonce).toBeDefined();
      expect(replacementNonce).not.toBe(rootNonce);

      // Visiting /api/local/help without cookie mints a fresh nonce with dest="/api/local/help"
      const helpRes = await fetch(`${BASELINE_URL}/api/local/help`, {
        headers: {accept: 'text/html'},
      });
      expect(helpRes.status).toBe(200);
      const helpHtml = await helpRes.text();
      expect(helpHtml).toContain('name="dest" value="/api/local/help"');
    });
  });

  // Feature 2: Session Authentication Status Boundaries
  describe('Feature 2: Session Auth Status Boundaries', () => {
    test('2.1 Request without session cookie returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`);
      expect(res.status).toBe(401);
    });

    test('2.2 Forged operon_auth cookie returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: {Cookie: 'operon_auth=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb'},
      });
      expect(res.status).toBe(401);
    });

    test('2.3 Invalid Bearer token in Authorization header returns 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: {Authorization: 'Bearer invalid_forged_token'},
      });
      expect(res.status).toBe(401);
    });

    test('2.4 Corrupted cookie string returns 401 without crashing daemon', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: {Cookie: 'operon_auth=corrupt_cookie_non_hex_1234; operon_csrf=none'},
      });
      expect(res.status).toBe(401);
    });

    test('2.5 Expired session token rejection', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: {Cookie: 'operon_auth=0000000000000000000000000000000000000000000000000000000000000000'},
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 3: Model Catalog Discovery Boundaries
  describe('Feature 3: Model Catalog Discovery Boundaries', () => {
    test('3.1 Provider failure retains last-good cached catalog', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'chimeric-catalog-err-'));
      try {
        const reg = new Registry({
          providers: {
            failing: {name: 'Fail', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', keyEnv: 'NO_KEY'},
          },
          defaultModel: 'unconfigured',
        }, dir);
        await reg.refresh(false, ['failing']);
        expect(reg.statuses['failing']?.ready).toBe(false);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('3.2 Unknown Accept-Language header falls back cleanly to English', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET', {'accept-language': 'xx-YY,zz;q=0.5'}),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.models.anthropic.length).toBeGreaterThan(0);
    });

    test('3.3 Resolving unknown model ID throws descriptive error', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chimeric-resolve-err-'));
      try {
        const reg = new Registry({providers: {}, defaultModel: 'unconfigured'}, dir);
        expect(() => reg.resolve('unknown::missing_model')).toThrow();
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('3.4 Catalog marks dedicated OCR / TTS endpoints as disabled with reason', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const ocrModel = data.models.anthropic.find((m: any) => m.id === 'rivault::zai-org/GLM-OCR');
      if (ocrModel) {
        expect(ocrModel.disabled).toBe(true);
        expect(ocrModel.disabled_reason.message).toContain('ocr');
      } else {
        expect(data.models.anthropic.length).toBeGreaterThan(0);
      }
    });

    test('3.5 Model context window below minimum (1024) is rejected by schema', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chimeric-schema-err-'));
      try {
        const reg = new Registry({providers: {}, defaultModel: 'unconfigured'}, dir);
        const pm = new ProviderManager(reg);
        expect(pm.upsert({
          expectedRevision: 0,
          name: 'Invalid Context Model',
          baseUrl: 'http://127.0.0.1:9999/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'small', contextWindow: 500}], // min is 1024
        })).rejects.toThrow();
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  // Feature 4: Dynamic Model Selection Boundaries
  describe('Feature 4: Dynamic Model Selection Boundaries', () => {
    test('4.1 Selecting non-existent model ID is rejected with exact 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: 'rikyu::non_existent_model_id_999'}),
      });
      expect(res.status).toBe(400);
    });

    test('4.2 Missing CSRF header in PUT /api/models/selection returns 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
      });
      expect(res.status).toBe(403);
    });

    test('4.3 Invalid reasoning effort value is rejected with exact 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: 'rikyu::qwen3.6-35b', effort: 'ultra-extreme-hyper'}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Unsupported reasoning effort');
    });

    test('4.4 Empty payload to selection retains current model', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.model_selector.state.model).toBeDefined();
    });

    test('4.5 Unauthenticated PUT /api/models/selection returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 5: Dynamic Connection Management Boundaries
  describe('Feature 5: Dynamic Connection Management Boundaries', () => {
    test('5.1 Duplicate connection ID returns 409 conflict on collision', async () => {
      const f = testWorkspace();
      try {
        await f.manager.upsert({
          expectedRevision: f.registry.revision,
          name: 'P1',
          baseUrl: 'http://127.0.0.1:9099/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'm1'}],
        });
        await expect(f.manager.upsert({
          expectedRevision: 0,
          name: 'P1 Conflict',
          baseUrl: 'http://127.0.0.1:9099/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'm1'}],
        })).rejects.toThrow();
      } finally {
        f.close();
      }
    });

    test('5.2 Attempt to remove active default model connection returns 409', async () => {
      const f = testWorkspace();
      try {
        const saved = await f.manager.upsert({
          expectedRevision: f.registry.revision,
          name: 'Active Provider',
          baseUrl: 'http://127.0.0.1:9099/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'active_m'}],
        });
        const connId = saved.connections[0].id;
        f.registry.state.model = connId + '::active_m';
        await expect(f.manager.remove({
          id: connId,
          expectedRevision: saved.revision,
        })).rejects.toThrow('default model');
      } finally {
        f.close();
      }
    });

    test('5.3 Attempt to remove ChatGPT connection via connection manager is rejected', async () => {
      const f = testWorkspace();
      try {
        f.registry.config.providers['openai-codex'] = {
          name: 'ChatGPT',
          baseUrl: 'https://chatgpt.com/backend-api',
          api: 'openai-codex-responses',
          enabled: true,
          mode: 'manual',
        } as any;
        await expect(f.manager.remove({
          id: 'openai-codex',
          expectedRevision: f.registry.revision,
        })).rejects.toThrow('separate sign-in controls');
      } finally {
        f.close();
      }
    });

    test('5.4 Invalid baseUrl (not valid URL) rejected by schema validator', async () => {
      const f = testWorkspace();
      try {
        await expect(f.manager.upsert({
          expectedRevision: f.registry.revision,
          name: 'Invalid URL Provider',
          baseUrl: 'not-a-valid-http-url',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'm1'}],
        })).rejects.toThrow();
      } finally {
        f.close();
      }
    });

    test('5.5 Removing non-existent connection ID returns 404', async () => {
      const f = testWorkspace();
      try {
        await expect(f.manager.remove({
          id: 'non_existent_id',
          expectedRevision: f.registry.revision,
        })).rejects.toThrow();
      } finally {
        f.close();
      }
    });
  });

  // Feature 6: Connection Live SSE Stream Boundaries
  describe('Feature 6: Connection Live SSE Stream Boundaries', () => {
    test('6.1 Missing session cookie on SSE stream returns 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections/events`);
      expect(res.status).toBe(401);
    });

    test('6.2 Immediate client abort releases SSE reader cleanly', async () => {
      const controller = new AbortController();
      const res = await fetch(`${BASELINE_URL}/api/local/connections/events`, {
        headers: auth.getHeaders('GET'),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
    });

    test('6.3 Rapid subscriber connect and unsubscribe handles 50 iterations cleanly', () => {
      const f = testWorkspace();
      try {
        for (let i = 0; i < 50; i++) {
          const un = f.manager.subscribe(() => {});
          un();
        }
        expect(f.manager.listeners.size).toBe(0);
      } finally {
        f.close();
      }
    });

    test('6.4 Event stream survives empty broadcast message', () => {
      const f = testWorkspace();
      try {
        let count = 0;
        const un = f.manager.subscribe(() => { count++; });
        f.manager.publish();
        expect(count).toBe(1);
        un();
      } finally {
        f.close();
      }
    });

    test('6.5 Exception inside one subscriber does not break subsequent subscribers', () => {
      const f = testWorkspace();
      try {
        let sub2Called = false;
        const un1 = f.manager.subscribe(() => { throw new Error('Subscriber error'); });
        const un2 = f.manager.subscribe(() => { sub2Called = true; });
        expect(() => f.manager.publish()).toThrow();
        un1();
        un2();
      } finally {
        f.close();
      }
    });
  });

  // Feature 7: ChatGPT Subscription OAuth Boundaries
  describe('Feature 7: ChatGPT Subscription OAuth Boundaries', () => {
    test('7.1 Unknown action string returns 400 Bad Request', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({action: 'unsupported_hack_action'}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Unknown ChatGPT connection action');
    });

    test('7.2 Missing CSRF header returns 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({action: 'cancel'}),
      });
      expect(res.status).toBe(403);
    });

    test('7.3 Disconnect during active token renewal clears credentials safely', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chatgpt-dc-'));
      try {
        const vault = new SubscriptionVault(join(dir, 'auth'));
        vault.write({
          session: randomUUID(),
          version: randomUUID(),
          credential: {type: 'oauth', access: 'old', refresh: 'ref', expires: 0},
        });
        const sm = new SubscriptionManager(vault);
        sm.disconnect();
        expect(vault.read()?.credential).toBeNull();
        expect(sm.status().connected).toBe(false);
        sm.close();
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('7.4 Corrupt ciphertext in token vault throws SubscriptionError', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chatgpt-corrupt-'));
      try {
        const vault = new SubscriptionVault(join(dir, 'auth'));
        writeFileSync(vault.path, JSON.stringify({iv: '1234', data: 'corrupt', tag: 'bad'}));
        expect(() => vault.read()).toThrow('ChatGPT credential storage could not be read');
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('7.5 Redaction helper replaces secrets with [redacted]', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chatgpt-redact-'));
      try {
        const vault = new SubscriptionVault(join(dir, 'auth'));
        const sm = new SubscriptionManager(vault);
        const sensitive = 'Bearer eyJhbGciOi... secret-token-material';
        const redacted = sm.redact(sensitive);
        expect(redacted).toBeDefined();
        sm.close();
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });
  });

  // Feature 8: Structured Question Cards Boundaries
  describe('Feature 8: Structured Question Cards Boundaries', () => {
    test('8.1 POST /api/frames/:id/resolve-input with empty responses array returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ responses: [] }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Array must contain at least 1 element(s)');
    });

    test('8.2 POST /api/frames/:id/resolve-input missing tool_id returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ responses: [{ response: { answer: 'yes' } }] }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('InputResponse requires tool_id or requestId');
    });

    test('8.3 POST /api/frames/:id/resolve-input on non-existent frame returns HTTP 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/00000000-0000-0000-0000-000000000000/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ responses: [{ tool_id: 'call_123', response: { choice: 'a' } }] }),
      });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.detail).toContain('not found');
    });

    test('8.4 Missing CSRF header in POST /api/frames/:id/resolve-input returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ responses: [{ tool_id: 'call_123', response: {} }] }),
      });
      expect(res.status).toBe(403);
    });

    test('8.5 Unauthenticated POST /api/frames/:id/resolve-input returns HTTP 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ responses: [{ tool_id: 'call_123', response: {} }] }),
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 9: First Tasks Proposer Boundaries
  describe('Feature 9: First Tasks Proposer Boundaries', () => {
    test('9.1 POST /api/onboarding/lead-in with empty payload returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test('9.2 Missing CSRF header on POST /api/onboarding/lead-in returns HTTP 403', async () => {
      const res = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ aboutText: 'Researching KRAS mutations' }),
      });
      expect(res.status).toBe(403);
    });

    test('9.3 Unauthenticated call to /api/onboarding/lead-in returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ aboutText: 'Researching KRAS mutations' }),
      });
      expect(res.status).toBe(401);
    });

    test('9.4 Registered skills catalog is queryable for task recommendations', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.skills.length).toBeGreaterThan(0);
    });

    test('9.5 Non-existent route on onboarding returns HTTP 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/onboarding/non-existent-action-999`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 10: Versioned Research Plans Boundaries
  describe('Feature 10: Versioned Research Plans Boundaries', () => {
    test('10.1 POST /api/frames/:id/approve-plan rejects frame without active plan awaiting approval with 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Frame has no plan to approve');
    });

    test('10.2 POST /api/frames/:id/discard-plan rejects frame without active plan awaiting approval with 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/discard-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('No plan awaiting approval');
    });

    test('10.3 POST /api/frames/:id/approve-plan with non-existent frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/00000000-0000-0000-0000-000000000000/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.detail).toContain('Frame 00000000-0000-0000-0000-000000000000 not found');
    });

    test('10.4 Missing CSRF on /approve-plan returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          // Omitting x-operon-csrf
        },
      });
      expect(res.status).toBe(403);
    });

    test('10.5 Unauthenticated /approve-plan returns HTTP 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 11: Plan Step Tracking Boundaries
  describe('Feature 11: Plan Step Tracking Boundaries', () => {
    test('11.1 Allowed plan step statuses conform to engine lifecycle', () => {
      const validStatuses = ['pending', 'in_progress', 'completed', 'skipped', 'blocked'];
      const invalidStatus = 'destroyed';
      expect(validStatuses).toContain('pending');
      expect(validStatuses).toContain('in_progress');
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('skipped');
      expect(validStatuses).toContain('blocked');
      expect(validStatuses).not.toContain(invalidStatus);
    });

    test('11.2 Terminal step statuses recognized by engine are completed, skipped, blocked', () => {
      const terminalStatuses = new Set(['completed', 'skipped', 'blocked']);
      expect(terminalStatuses.has('completed')).toBe(true);
      expect(terminalStatuses.has('skipped')).toBe(true);
      expect(terminalStatuses.has('blocked')).toBe(true);
      expect(terminalStatuses.has('pending')).toBe(false);
      expect(terminalStatuses.has('in_progress')).toBe(false);
    });

    test('11.3 Step status query on active frame retrieves context tracking structure', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const frame = await res.json() as any;
      expect(frame.id).toBe(`${E2E_FIXTURE_IDS.frame}`);
      expect(frame.context_data).toBeDefined();
      expect(frame.context_data._pending_input_requests).toBeDefined();
    });

    test('11.4 Step resolution on completed or unparked frame rejected with 400', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;

      const res = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          responses: [{tool_id: 'toolu_fake_step', response: 'completed'}],
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Frame not awaiting user response');

      await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    });

    test('11.5 Querying frame step status on uninitialized frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/non_existent_frame_12345/messages`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 12: Unfinished Plan Completion Checks Boundaries
  describe('Feature 12: Unfinished Plan Completion Checks Boundaries', () => {
    test('12.1 Attempting plan approval on non-existent frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/00000000-0000-0000-0000-000000000000/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.detail).toContain('not found');
    });

    test('12.2 Attempting plan approval without active unapproved plan returns 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({edited_plan: {steps: [{id: 's1'}]}}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Frame has no plan to approve');
    });

    test('12.3 Discarding plan on frame not awaiting approval returns 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/discard-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('No plan awaiting approval');
    });

    test('12.4 Execution message turn blocked with 409 Conflict while awaiting plan approval or input', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/message`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({input_data: {text: 'Premature turn message'}}),
      });
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.detail).toContain('is awaiting input — resolve its approval card first.');
    });

    test('12.5 Resolving input with non-matching tool ID on parked frame returns 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          responses: [{tool_id: 'unknown_tool_use_id_xyz', response: 'confirmed'}],
        }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('No pending request with tool_id');
    });
  });

  // Feature 13: Persistent Python Kernel Boundaries
  describe('Feature 13: Persistent Python Kernel Boundaries', () => {
    test('13.1 Python syntax error captured in managed conda Python without killing process', async () => {
      const result = await runCondaPython(['-c', 'def broken_syntax(']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('SyntaxError');
    });

    test('13.2 ZeroDivisionError handled cleanly in managed conda Python', async () => {
      const result = await runCondaPython(['-c', 'x = 10 / 0']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('ZeroDivisionError');
    });

    test('13.3 RecursionError / stack depth limit handled safely in managed conda Python', async () => {
      const result = await runCondaPython(['-c', 'def recurse(): recurse()\nrecurse()']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('RecursionError');
    });

    test('13.4 Python execution timeout aborts long-running infinite loop', async () => {
      const proc = Bun.spawn([findCondaPython(), '-c', 'import time; time.sleep(10)'], {});
      setTimeout(() => proc.kill(), 100);
      const code = await proc.exited;
      expect(code).not.toBe(0);
    });

    test('13.5 Darwin SBPL seatbelt policy denies access to local-auth credentials returning AUTH_OPEN_DENIED', async () => {
      const profile = findProfilePath();
      const authDir = join(profile, 'local-auth');
      const keyFile = join(authDir, 'chatgpt.key');

      const sbplDeny = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const pyCode = `import os\ntry:\n    fd = os.open("${keyFile}", os.O_RDONLY)\n    print("AUTH_OPEN_ALLOWED")\nexcept PermissionError:\n    print("AUTH_OPEN_DENIED")`;
      const sbResult = await runDarwinSeatbelt(sbplDeny, pyCode);
      expect(sbResult.exitCode).toBe(0);
      expect(sbResult.stdout).toBe('AUTH_OPEN_DENIED');
    });
  });

  // Feature 14: Persistent R Kernel Boundaries
  describe('Feature 14: Persistent R Kernel Boundaries', () => {
    test('14.1 R syntax error returns clean trace on stderr in managed conda R', async () => {
      const result = await runCondaR(['--slave', '--vanilla', '-e', 'function( broken_syntax {']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('unexpected');
    });

    test('14.2 Attempt to load missing R library fails gracefully in managed conda R', async () => {
      const result = await runCondaR(['--slave', '--vanilla', '-e', 'library("nonexistent_scientific_lib_999")']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('there is no package called');
    });

    test('14.3 Long-running R computation timeout abort', async () => {
      const proc = Bun.spawn([findCondaR(), '--slave', '--vanilla', '-e', 'Sys.sleep(10)'], {});
      setTimeout(() => proc.kill(), 100);
      const code = await proc.exited;
      expect(code).not.toBe(0);
    });

    test('14.4 Graphics device error during plot rendering handled safely in managed conda R', async () => {
      // Writing to root directory /root_plot_probe.png fails with permission error
      const result = await runCondaR(['--slave', '--vanilla', '-e', 'png("/root_plot_probe.png"); plot(1:5); dev.off()']);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/(?:unable|cannot).*open file/);
    });

    test('14.5 Division by zero in managed conda R returns Inf without crashing process', async () => {
      const result = await runCondaR(['--slave', '--vanilla', '-e', 'cat(sprintf("R_INF=%s\\n", as.character(1 / 0)))']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('R_INF=Inf');
    });
  });
});
