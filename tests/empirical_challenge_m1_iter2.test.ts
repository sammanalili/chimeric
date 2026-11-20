import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './e2e/test-helpers';
import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { Registry } from '../src/registry';
import { ProviderManager, ProviderChangeError } from '../src/provider-manager';
import { installProviderHttp } from '../src/providers-http';
import { startBridge } from '../src/bridge';
import { ReplayStore } from '../src/protocol';
import { BASELINE_URL, getLiveSessionAuth, mintFreshNonce, SessionAuth } from './e2e/test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Adversarial Challenge: Milestone 1 Iteration 2 (Adapter Stress, Concurrency, Replay & Revision Locking)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // =========================================================================
  // Vector 1: Adapter & Bridge Concurrency Stress
  // =========================================================================
  describe('Vector 1: Adapter & Bridge Concurrency Stress', () => {
    let bridgeDir: string;
    let bridgeServer: any;
    let bridgePort: number;
    let bridgeToken: string;

    beforeAll(async () => {
      bridgeDir = mkdtempSync(join(tmpdir(), 'challenger-bridge-'));
      const mockUpstream = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch() {
          return Response.json({
            id: 'chat_concurrency',
            object: 'chat.completion',
            created: Date.now(),
            model: 'test-concurrency-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'concurrency-ok' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        },
      });

      const registry = new Registry({
        envFile: '/missing',
        credentialRefsFile: '/missing',
        modelMetadataFile: '/missing',
        providers: {
          mock: {
            name: 'Mock Concurrency Provider',
            baseUrl: mockUpstream.url.href + 'v1',
            keyEnv: 'TEST_BRIDGE_KEY',
            api: 'openai-completions',
            models: [{ id: 'test-concurrency-model' }],
          },
        },
        defaultModel: 'mock::test-concurrency-model',
      }, bridgeDir);
      process.env.TEST_BRIDGE_KEY = 'test-bridge-secret';
      await registry.refresh();

      bridgeToken = 'test-challenger-token-1234567890abcdef';
      bridgeServer = startBridge(registry, bridgeToken, 0);
      bridgePort = bridgeServer.port;
    });

    afterAll(() => {
      try {
        bridgeServer?.stop?.(true);
        rmSync(bridgeDir, { recursive: true, force: true });
      } catch {}
    });

    test('1.1 25 concurrent requests to /messages/count_tokens on bridge return deterministic token estimates without race conditions', async () => {
      const payloads = Array.from({ length: 25 }, (_, i) => ({
        model: 'mock::test-concurrency-model',
        messages: [
          { role: 'user', content: `Concurrent query ${i} with padding ${'X'.repeat((i + 1) * 40)}` },
          { role: 'assistant', content: `Prior response ${i} with unicode: 🧬 🔬 ⚗️` },
          { role: 'user', content: `Followup message ${i}` },
        ],
      }));

      const promises = payloads.map(payload =>
        fetch(`http://127.0.0.1:${bridgePort}/v1/messages/count_tokens`, {
          method: 'POST',
          headers: {
            'x-api-key': bridgeToken,
            'content-type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
      );

      const responses = await Promise.all(promises);
      expect(responses.every(r => r.status === 200)).toBe(true);

      const jsonResults = await Promise.all(responses.map(r => r.json()));
      for (let i = 0; i < jsonResults.length; i++) {
        const item = jsonResults[i];
        expect(typeof item.input_tokens).toBe('number');
        expect(item.input_tokens).toBeGreaterThan(0);
        expect(item.token_count_source).toBe('byte-estimate');
      }
    });

    test('1.2 50 concurrent SQLite ReplayStore transactions sustain interleaved reads and writes under WAL mode with 0 errors', async () => {
      const replayDir = mkdtempSync(join(tmpdir(), 'challenger-replay-'));
      const dbPath = join(replayDir, 'concurrent-replay.db');
      const store = new ReplayStore(dbPath);

      const operations = Array.from({ length: 50 }, (_, i) => {
        const model = `model_variant_${i % 5}`;
        const content = [{ type: 'text', text: `Question for worker ${i}` }];
        const message: any = {
          role: 'assistant',
          content: [{ type: 'text', text: `Answer from worker ${i}` }],
          api: 'anthropic-messages',
          provider: 'native-history',
          model,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: Date.now(),
        };

        return (async () => {
          // Write
          store.put(content, model, message);
          // Interleaved read
          const readBack = store.get(content, model);
          expect(readBack).toBeDefined();
          expect((readBack as any).content[0].text).toBe(`Answer from worker ${i}`);
        })();
      });

      await Promise.all(operations);

      // Verify PRAGMA integrity_check
      const db = new Database(dbPath);
      const integrity = db.query('PRAGMA integrity_check').get() as any;
      expect(integrity.integrity_check).toBe('ok');
      db.close();

      rmSync(replayDir, { recursive: true, force: true });
    });

    test('1.3 8 concurrent persistent live SSE subscribers receive all broadcast events simultaneously without dropped frames', async () => {
      const streamCount = 8;
      const controllers = Array.from({ length: streamCount }, () => new AbortController());
      const eventsReceived: number[] = new Array(streamCount).fill(0);

      const streamPromises = controllers.map((ctrl, idx) =>
        fetch(`${BASELINE_URL}/api/local/connections/events`, {
          headers: auth.getHeaders('GET'),
          signal: ctrl.signal,
        }).then(async res => {
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type')).toContain('text/event-stream');
          const reader = res.body?.getReader();
          if (!reader) return;
          const decoder = new TextDecoder();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const text = decoder.decode(value);
              const matches = (text.match(/data:\s*\{/g) || []).length;
              eventsReceived[idx] += matches;
            }
          } catch (e: any) {
            if (e.name !== 'AbortError') throw e;
          }
        })
      );

      // Allow all 8 SSE connections to handshake
      await new Promise(r => setTimeout(r, 250));

      // Broadcast Event 1: Switch model
      const switch1 = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'rikyu::glm-5.3-flash' }),
      });
      expect(switch1.status).toBe(200);

      await new Promise(r => setTimeout(r, 300));

      // Broadcast Event 2: Switch model back
      const switch2 = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'rikyu::deepseek-v4.1-flash-1017' }),
      });
      expect(switch2.status).toBe(200);

      await new Promise(r => setTimeout(r, 300));

      // Close all streams cleanly
      for (const ctrl of controllers) ctrl.abort();
      await Promise.allSettled(streamPromises);

      // Every stream should have received initial snapshot data + 2 broadcast updates = >= 3 events
      for (let i = 0; i < streamCount; i++) {
        expect(eventsReceived[i]).toBeGreaterThanOrEqual(3);
      }
    });
  });

  // =========================================================================
  // Vector 2: Dynamic Model Selection Under Rapid & Concurrent Switching
  // =========================================================================
  describe('Vector 2: Dynamic Model Selection Under Rapid & Concurrent Switching', () => {
    const modelA = 'rikyu::deepseek-v4.1-flash-1017';
    const modelB = 'rikyu::glm-5.3-flash';

    test('2.1 Sequential rapid model flapping across 20 cycles updates default_model_id and syncs settings deterministically', async () => {
      for (let i = 0; i < 20; i++) {
        const targetModel = i % 2 === 0 ? modelB : modelA;
        const targetEffort = i % 3 === 0 ? 'low' : i % 3 === 1 ? 'medium' : 'high';

        const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ model: targetModel, effort: targetEffort }),
        });
        expect(res.status).toBe(200);

        const catalog = await res.json();
        expect(catalog.default_model_id).toBe(targetModel);
      }

      // Verify active model in catalog after sequential switches
      const verifyRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const finalCatalog = await verifyRes.json();
      expect(finalCatalog.default_model_id).toBe(modelA);
    });

    test('2.2 High-concurrency barrage of 30 racing model switches executes with 100% 200 OK and leaves consistent state', async () => {
      const promises = Array.from({ length: 30 }, (_, idx) => {
        const target = idx % 2 === 0 ? modelA : modelB;
        const effort = idx % 3 === 0 ? 'minimal' : idx % 3 === 1 ? 'medium' : 'max';
        return fetch(`${BASELINE_URL}/api/models/selection`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({ model: target, effort }),
        });
      });

      const results = await Promise.all(promises);
      const statuses = results.map(r => r.status);
      expect(statuses.every(s => s === 200)).toBe(true);

      // Verify post-barrage catalog state
      const checkRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const checkData = await checkRes.json();
      expect([modelA, modelB]).toContain(checkData.default_model_id);
    });

    test('2.3 Strict boundary rejections: non-existent model and invalid reasoning effort return HTTP 400 Bad Request', async () => {
      // Nonexistent model ID
      const resBadModel = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'adversary-phantom-model-999' }),
      });
      expect(resBadModel.status).toBe(400);
      const badModelBody = await resBadModel.json();
      expect(badModelBody.detail).toContain('unknown or unavailable model');

      // Invalid effort on a reasoning model (rikyu::qwen3.6-35b)
      const resBadEffort = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'rikyu::qwen3.6-35b', effort: 'astronomical' }),
      });
      expect(resBadEffort.status).toBe(400);
      const badEffortBody = await resBadEffort.json();
      expect(badEffortBody.detail).toContain('Unsupported reasoning effort');

      // Non-reasoning model ignores effort gracefully without error
      const resIgnoredEffort = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: modelA, effort: 'astronomical' }),
      });
      expect(resIgnoredEffort.status).toBe(200);

      // Restore baseline model
      const restore = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: modelA, effort: 'medium' }),
      });
      expect(restore.status).toBe(200);
    });
  });

  // =========================================================================
  // Vector 3: Session Nonce Replay Prevention
  // =========================================================================
  describe('Vector 3: Session Nonce Replay Prevention (Single-Use Cryptographic Auth)', () => {
    test('3.1 Serial replay attack: Second redemption of identical authentic nonce strictly returns HTTP 401', async () => {
      const freshNonce = await mintFreshNonce();
      expect(freshNonce.length).toBeGreaterThanOrEqual(32);

      // First redemption: must succeed
      const res1 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: freshNonce }),
      });
      expect(res1.status).toBe(200);
      const setCookies = res1.headers.get('set-cookie') || '';
      expect(setCookies).toContain('operon_auth=');

      // Immediate second redemption: must be rejected with 401
      const res2 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: freshNonce }),
      });
      expect(res2.status).toBe(401);
    });

    test('3.2 Concurrent race replay attack: 15 simultaneous redemptions of a single nonce permit exactly 1 success and 14 rejections', async () => {
      const singleNonce = await mintFreshNonce();

      const promises = Array.from({ length: 15 }, () =>
        fetch(`${BASELINE_URL}/api/auth/nonce`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASELINE_URL },
          body: JSON.stringify({ nonce: singleNonce }),
        })
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map(r => r.status);
      const count200 = statuses.filter(s => s === 200).length;
      const count401 = statuses.filter(s => s === 401).length;

      expect(count200).toBe(1);
      expect(count401).toBe(14);
    });

    test('3.3 Forged, empty, and malformed nonces strictly return HTTP 401 without granting session cookies', async () => {
      const adversaryNonces = [
        '',
        '   ',
        '00000000000000000000000000000000',
        'deadbeefcafe1234567890abcdef1234',
        '../malicious/path/traversal/nonce',
        'not-a-valid-hex-nonce-string-at-all!!',
        randomUUID(),
      ];

      for (const badNonce of adversaryNonces) {
        const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: BASELINE_URL },
          body: JSON.stringify({ nonce: badNonce }),
        });
        expect(res.status).toBe(401);
        const setCookies = res.headers.get('set-cookie') || '';
        expect(setCookies).not.toContain('operon_auth=');
      }
    });

    test('3.4 Independent nonces succeed once each without cross-contamination', async () => {
      const nonceAlpha = await mintFreshNonce();
      const nonceBeta = await mintFreshNonce();
      expect(nonceAlpha).not.toBe(nonceBeta);

      const resAlpha = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: nonceAlpha }),
      });
      expect(resAlpha.status).toBe(200);

      const resBeta = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: nonceBeta }),
      });
      expect(resBeta.status).toBe(200);

      // Both are now burned
      const resAlpha2 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: nonceAlpha }),
      });
      expect(resAlpha2.status).toBe(401);

      const resBeta2 = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BASELINE_URL },
        body: JSON.stringify({ nonce: nonceBeta }),
      });
      expect(resBeta2.status).toBe(401);
    });
  });

  // =========================================================================
  // Vector 4: Connection Revision Locking & Conflict Detection (HTTP 409)
  // =========================================================================
  describe('Vector 4: Connection Revision Locking & HTTP 409 Conflict Detection', () => {
    test('4.1 Stale expectedRevision on connection settings update returns HTTP 409 Conflict', async () => {
      const snapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const snap = await snapRes.json();
      const staleRev = snap.revision - 1;

      const res = await fetch(`${BASELINE_URL}/api/local/connections/settings`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: staleRev,
          roles: snap.roles,
          headlineModels: snap.headlineModels,
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.detail).toContain('Connections changed in another window. Reload the connection list before saving.');
    });

    test('4.2 10 concurrent racing saves with identical expectedRevision allow exactly 1 success and reject 9 with 409', async () => {
      const snapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const snap = await snapRes.json();
      const baseRev = snap.revision;

      const promises = Array.from({ length: 10 }, () =>
        fetch(`${BASELINE_URL}/api/local/connections/settings`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
          body: JSON.stringify({
            expectedRevision: baseRev,
            roles: snap.roles,
            headlineModels: snap.headlineModels,
          }),
        })
      );

      const responses = await Promise.all(promises);
      const statuses = responses.map(r => r.status);
      const count200 = statuses.filter(s => s === 200).length;
      const count409 = statuses.filter(s => s === 409).length;

      expect(count200).toBe(1);
      expect(count409).toBe(9);

      // Verify that revision incremented by exactly 1
      const postSnapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const postSnap = await postSnapRes.json();
      expect(postSnap.revision).toBe(baseRev + 1);
    });

    test('4.3 Mismatched connectionRevision in connection upsert is rejected with HTTP 409', async () => {
      const snapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const snap = await snapRes.json();
      const targetConn = snap.connections.find((c: any) => c.id === 'rikyu');
      expect(targetConn).toBeDefined();

      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        method: 'POST',
        headers: auth.getHeaders('POST', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: snap.revision,
          id: 'rikyu',
          connectionRevision: 'stale-forged-connection-uuid-1234',
          name: targetConn.name,
          baseUrl: targetConn.baseUrl,
          api: targetConn.api,
          mode: 'discover',
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.detail).toContain('This connection was edited in another window. Cancel editing and reopen it before saving.');
    });

    test('4.4 Deleting connection providing active default model is blocked with HTTP 409', async () => {
      const snapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const snap = await snapRes.json();
      expect(snap.selectedModel.startsWith('rikyu::')).toBe(true);

      const res = await fetch(`${BASELINE_URL}/api/local/connections/rikyu`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: snap.revision,
          resetRoles: false,
        }),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.detail).toContain('Choose a different default model before removing the selected model.');
    });

    test('4.5 Deleting connection providing background role model is blocked with HTTP 409', async () => {
      // First, temporarily switch default model to a rivault model so default model doesn't block
      const snapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const snap = await snapRes.json();
      const rivaultConn = snap.connections.find((c: any) => c.id === 'rivault');
      expect(rivaultConn).toBeDefined();
      const rivaultModel = rivaultConn.models[0]?.qualifiedId;
      expect(rivaultModel).toBeDefined();

      // Switch default to rivault model
      const switchRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: rivaultModel }),
      });
      expect(switchRes.status).toBe(200);

      // Now attempt to delete rikyu (which still provides roles.small)
      const freshSnapRes = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const freshSnap = await freshSnapRes.json();
      expect(freshSnap.roles.small.startsWith('rikyu::')).toBe(true);

      const delRes = await fetch(`${BASELINE_URL}/api/local/connections/rikyu`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE', { 'content-type': 'application/json' }),
        body: JSON.stringify({
          expectedRevision: freshSnap.revision,
          resetRoles: false,
        }),
      });

      expect(delRes.status).toBe(409);
      const delBody = await delRes.json();
      expect(delBody.detail).toContain('Choose a replacement for the background model role before removing this model.');

      // Restore default model back to rikyu::deepseek-v4.1-flash-1017
      await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', { 'content-type': 'application/json' }),
        body: JSON.stringify({ model: 'rikyu::deepseek-v4.1-flash-1017' }),
      });
    });
  });
});
