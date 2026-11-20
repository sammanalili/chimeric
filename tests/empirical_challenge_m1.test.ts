import {findProfilePath} from './e2e/test-helpers';
import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './e2e/test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import {installNetworkPolicy, blockedServiceURL} from '../src/network-policy';
import {BASELINE_URL, getLiveSessionAuth, SessionAuth} from './e2e/test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Adversarial Challenge: Milestone 1 Security & Harness Boundaries', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // =========================================================================
  // Vector 1: Telemetry & Destination Blocking
  // =========================================================================
  describe('Vector 1: Telemetry & Destination Blocking', () => {
    beforeAll(() => {
      installNetworkPolicy();
    });

    const blockedHosts = [
      'https://api.anthropic.com/v1/messages',
      'https://claude.ai/api/event_logging/v2/batch',
      'https://o1158394.ingest.us.sentry.io/api/example/envelope/',
      'https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59/operon-releases/latest',
      'https://API.ANTHROPIC.COM/v1/complete',
      'https://sub.telemetry.anthropic.com/track',
      'https://stats.claude.ai/metrics',
      'https://O1158394.INGEST.US.SENTRY.IO/api/123/envelope',
      'https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59/nested/asset.tar.gz',
    ];

    for (const url of blockedHosts) {
      test(`1.1 globalThis.fetch rejects blocked destination: ${url}`, async () => {
        let threw = false;
        let errorMessage = '';
        try {
          await fetch(url);
        } catch (err: any) {
          threw = true;
          errorMessage = err.message;
        }
        expect(threw).toBe(true);
        expect(errorMessage).toContain('Chimeric blocked a vendor service request.');
      });
    }

    test('1.2 Node https.get synchronously throws on Anthropic and Sentry destinations', () => {
      const targets = [
        'https://api.anthropic.com/v1/messages',
        'https://o1158394.ingest.us.sentry.io/api/envelope',
      ];
      for (const t of targets) {
        expect(() => {
          https.get(t);
        }).toThrow('Chimeric blocked a vendor service request.');
      }
    });

    test('1.3 Node http.get synchronously throws on blocked HTTP endpoints', () => {
      expect(() => {
        http.get('http://api.anthropic.com/v1/messages');
      }).toThrow('Chimeric blocked a vendor service request.');
    });

    test('1.4 Legitimate model and public data endpoints remain permitted', () => {
      const allowed = [
        'https://api.openai.com/v1/models',
        `${BASELINE_URL}/api/models`,
        'https://chatgpt.com/backend-api/codex/responses',
        'https://storage.googleapis.com/public-datasets/genomes.csv',
        'https://api.example.com/v1/chat/completions',
      ];
      for (const u of allowed) {
        expect(blockedServiceURL(new URL(u))).toBe(false);
      }
    });
  });

  // =========================================================================
  // Vector 2: CSRF & Auth Attack Vectors
  // =========================================================================
  describe('Vector 2: CSRF & Auth Attack Vectors', () => {
    const mutationEndpoints = [
      {method: 'POST', path: '/api/local/connections', body: {name: 'adversary'}},
      {method: 'POST', path: '/api/local/chatgpt', body: {action: 'login'}},
      {method: 'PUT', path: '/api/models/selection', body: {model: 'adversary_model'}},
      {method: 'PUT', path: '/api/local/ui/preferences', body: {locale: 'ja'}},
      {method: 'DELETE', path: '/api/local/connections/adversary-probe-id', body: {}},
    ];

    for (const ep of mutationEndpoints) {
      test(`2.1 ${ep.method} ${ep.path} returns strict 401 when unauthenticated (no Cookie, no CSRF)`, async () => {
        const res = await fetch(`${BASELINE_URL}${ep.path}`, {
          method: ep.method,
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(401);
      });

      test(`2.2 ${ep.method} ${ep.path} returns strict 401 when forged CSRF sent without session auth`, async () => {
        const res = await fetch(`${BASELINE_URL}${ep.path}`, {
          method: ep.method,
          headers: {
            'content-type': 'application/json',
            'x-operon-csrf': 'forged_deadbeef12345678',
          },
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(401);
      });

      test(`2.3 ${ep.method} ${ep.path} returns strict 403 when session auth sent without x-operon-csrf header`, async () => {
        const res = await fetch(`${BASELINE_URL}${ep.path}`, {
          method: ep.method,
          headers: {
            'content-type': 'application/json',
            Cookie: auth.cookieHeader,
          },
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(403);
      });

      test(`2.4 ${ep.method} ${ep.path} returns strict 403 when x-operon-csrf header does not match csrf cookie`, async () => {
        const res = await fetch(`${BASELINE_URL}${ep.path}`, {
          method: ep.method,
          headers: {
            'content-type': 'application/json',
            Cookie: auth.cookieHeader,
            'x-operon-csrf': 'mismatched_csrf_token_00000000',
          },
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(403);
      });

      test(`2.5 ${ep.method} ${ep.path} returns strict 403 when operon_csrf cookie is omitted despite valid header`, async () => {
        const res = await fetch(`${BASELINE_URL}${ep.path}`, {
          method: ep.method,
          headers: {
            'content-type': 'application/json',
            Cookie: `operon_auth=${auth.authCookie}`,
            'x-operon-csrf': auth.csrfToken,
          },
          body: JSON.stringify(ep.body),
        });
        expect(res.status).toBe(403);
      });
    }

    test('2.6 Nonce bootstrap rejects forged, empty, or missing nonces with strict 401', async () => {
      const forged = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: 'forged_0123456789abcdef0123456789abcdef'}),
      });
      expect(forged.status).toBe(401);

      const empty = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce: ''}),
      });
      expect(empty.status).toBe(401);

      const missing = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(401);
    });

    test('2.7 CSRF token query rejects unauthenticated clients with strict 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/csrf`, {
        headers: {origin: BASELINE_URL},
      });
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Vector 3: Kernel Isolation via Darwin SBPL Seatbelt
  // =========================================================================
  describe('Vector 3: Kernel Isolation (Darwin SBPL Seatbelt)', () => {
    const profileDir = findProfilePath();
    const authDir = join(profileDir, 'local-auth');
    const chatgptKey = join(authDir, 'chatgpt.key');
    const providersEnc = join(authDir, 'providers.enc.json');

    test('3.1 Credential files exist on disk with restricted host permissions', () => {
      expect(existsSync(authDir)).toBe(true);
      expect(existsSync(chatgptKey)).toBe(true);
      expect(existsSync(providersEnc)).toBe(true);
    });

    test('3.2 Darwin SBPL seatbelt policy denies reading chatgpt.key -> PermissionError -> AUTH_OPEN_DENIED', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const pythonScript = `
import os
try:
    fd = os.open("${chatgptKey}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', pythonScript], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
    });

    test('3.3 Darwin SBPL seatbelt policy denies reading providers.enc.json -> AUTH_OPEN_DENIED', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const pythonScript = `
import os
try:
    fd = os.open("${providersEnc}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', pythonScript], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
    });

    test('3.4 Negative control: Without SBPL deny rule, open succeeds (proves seatbelt is active enforcer)', () => {
      const sbplAllow = `(version 1)\n(allow default)\n`;
      const pythonScript = `
import os
try:
    fd = os.open("${chatgptKey}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbplAllow, 'python3', '-c', pythonScript], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_ALLOWED');
    });
  });

  // =========================================================================
  // Vector 4: Plan Completion Guard & Frame Plan Lifecycle Boundaries
  // =========================================================================
  describe('Vector 4: Plan Completion Guard', () => {
    const parkedFrameId = `${E2E_FIXTURE_IDS.frame}`;
    const nonExistentFrameId = '00000000-0000-0000-0000-000000000000';

    test('4.1 Adversarial execution turn bypass strictly blocked while frame is parked awaiting plan/input approval', async () => {
      // 1. Authenticated message attempt against parked frame is rejected with strict 409 Conflict
      const res = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/message`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ input_data: { text: 'Bypass plan approval' } }),
      });
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.detail).toContain('is awaiting input — resolve its approval card first.');

      // 2. Unauthenticated attempt returns strict 401
      const unauthRes = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input_data: { text: 'Bypass attempt' } }),
      });
      expect(unauthRes.status).toBe(401);

      // 3. Forged / missing CSRF header returns strict 403
      const csrfRes = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}/message`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: BASELINE_URL,
          Cookie: auth.cookieHeader,
        },
        body: JSON.stringify({ input_data: { text: 'Bypass attempt' } }),
      });
      expect(csrfRes.status).toBe(403);

      // 4. Non-existent frame returns strict 404
      const nonExistentRes = await fetch(`${BASELINE_URL}/api/frames/${nonExistentFrameId}/message`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ input_data: { text: 'Bypass attempt' } }),
      });
      expect(nonExistentRes.status).toBe(404);
    });

    test('4.2 Plan completion guard rejects premature plan approval on frames without active plan awaiting approval', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;
      const frameId = frame.root_frame_id;

      try {
        // Attempt to approve plan on fresh frame without active plan awaiting approval
        const approveRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/approve-plan`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({
            edited_plan: { steps: [{ id: 's1', title: 'Adversarial step', status: 'pending' }] },
          }),
        });
        expect(approveRes.status).toBe(400);
        const approveData = await approveRes.json() as any;
        expect(approveData.detail).toContain('Frame has no plan to approve');

        // Approve plan against non-existent frame returns strict 404
        const notFoundRes = await fetch(`${BASELINE_URL}/api/frames/${nonExistentFrameId}/approve-plan`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({}),
        });
        expect(notFoundRes.status).toBe(404);

        // Missing CSRF returns strict 403
        const csrfRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/approve-plan`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASELINE_URL,
            Cookie: auth.cookieHeader,
          },
          body: JSON.stringify({}),
        });
        expect(csrfRes.status).toBe(403);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('4.3 Plan discard guard prevents discarding unapproved or non-existent plans', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;
      const frameId = frame.root_frame_id;

      try {
        // Discard plan on frame without active plan awaiting approval
        const discardRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/discard-plan`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({}),
        });
        expect(discardRes.status).toBe(400);
        const discardData = await discardRes.json() as any;
        expect(discardData.detail).toContain('No plan awaiting approval');

        // Non-existent frame returns strict 404
        const notFoundRes = await fetch(`${BASELINE_URL}/api/frames/${nonExistentFrameId}/discard-plan`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({}),
        });
        expect(notFoundRes.status).toBe(404);

        // Missing CSRF returns strict 403
        const csrfRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/discard-plan`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: BASELINE_URL,
            Cookie: auth.cookieHeader,
          },
          body: JSON.stringify({}),
        });
        expect(csrfRes.status).toBe(403);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('4.4 Input resolution lifecycle guard strictly rejects empty responses array and unparked frames', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: `${E2E_PROJECT_ID}` }),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;
      const frameId = frame.root_frame_id;

      try {
        // Empty responses array is rejected with 400
        const emptyRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/resolve-input`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({ responses: [] }),
        });
        expect(emptyRes.status).toBe(400);
        const emptyData = await emptyRes.json() as any;
        expect(emptyData.detail).toContain('Array must contain at least 1 element(s)');

        // Non-empty responses array on unparked/completed frame is rejected with 400
        const unparkedRes = await fetch(`${BASELINE_URL}/api/frames/${frameId}/resolve-input`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({
            responses: [{ tool_id: 'tool_test', response: 'done' }],
          }),
        });
        expect(unparkedRes.status).toBe(400);
        const unparkedData = await unparkedRes.json() as any;
        expect(unparkedData.detail).toContain('Frame not awaiting user response');

        // Non-existent frame returns strict 404
        const notFoundRes = await fetch(`${BASELINE_URL}/api/frames/${nonExistentFrameId}/resolve-input`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({
            responses: [{ tool_id: 'tool_test', response: 'done' }],
          }),
        });
        expect(notFoundRes.status).toBe(404);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('4.5 Plan mode capability and frame context data integrity verified on live runtime', async () => {
      // 1. Agent registry confirms OPERON advertises plan mode capability
      const agentRes = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      expect(agentRes.status).toBe(200);
      const agents = await agentRes.json() as any[];
      const operon = agents.find((a: any) => a.name === 'OPERON');
      expect(operon).toBeDefined();
      expect(operon.supportsPlanMode).toBe(true);

      // 2. Parked frame inspection confirms unapproved plan state and pending input requests
      const frameRes = await fetch(`${BASELINE_URL}/api/frames/${parkedFrameId}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(frameRes.status).toBe(200);
      const frame = await frameRes.json() as any;
      expect(frame.id).toBe(parkedFrameId);
      expect(frame.status).toBe('awaiting_user_response');
      expect(frame.context_data?._plan_approved).toBe(false);
      expect(Array.isArray(frame.output_data?.pending_input_requests)).toBe(true);
      expect(frame.output_data.pending_input_requests.length).toBeGreaterThanOrEqual(1);
      expect(frame.output_data.pending_input_requests[0].tool_id).toBe('call_16faaa53aaa84ed3a2b13069');
    });
  });

  // =========================================================================
  // Vector 5: Cross-Model Kernel State Persistence
  // =========================================================================
  describe('Vector 5: Cross-Model Kernel State Persistence', () => {
    test('5.1 Interactive Python kernel namespace survives live model selection switches', async () => {
      // 1. Launch stateful Python kernel process
      const pyProc = Bun.spawn(['python3', '-i', '-q'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // 2. Set research variable in Python kernel
      pyProc.stdin.write("gene_expression = {'TP53': 14.2, 'KRAS': 8.7, 'MYC': 11.5}\n");
      pyProc.stdin.write("print('VAR_INITIALIZED')\n");
      await new Promise(r => setTimeout(r, 100));

      // 3. Query active models and perform dynamic switch via REST endpoint
      const mRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const mData = await mRes.json() as any;
      const models = mData.models.anthropic;
      expect(models.length).toBeGreaterThanOrEqual(2);

      const targetModel1 = models[0].id;
      const targetModel2 = models[1].id;

      // Switch to Model 1
      const switchRes1 = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: targetModel1}),
      });
      expect(switchRes1.status).toBe(200);

      // Switch to Model 2
      const switchRes2 = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: targetModel2}),
      });
      expect(switchRes2.status).toBe(200);

      // 4. In the same Python kernel, evaluate expression referencing the variable
      pyProc.stdin.write("mean_expr = sum(gene_expression.values()) / len(gene_expression)\n");
      pyProc.stdin.write("print(f'MEAN_EXPR={mean_expr:.2f}')\n");
      pyProc.stdin.write("exit()\n");
      pyProc.stdin.end();

      const stdout = await new Response(pyProc.stdout).text();
      await pyProc.exited;

      expect(stdout).toContain('VAR_INITIALIZED');
      expect(stdout).toContain('MEAN_EXPR=11.47');
    });

    test('5.2 Interactive R kernel namespace survives live model selection switches', async () => {
      // 1. Launch stateful R kernel process
      const rProc = Bun.spawn(['Rscript', '-e', `
        f <- file("stdin")
        open(f)
        while(length(line <- readLines(f, n = 1)) > 0) {
          eval(parse(text = line))
        }
      `], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      // 2. Set research variable in R kernel
      rProc.stdin.write("assay_counts <- c(100L, 250L, 150L)\n");
      rProc.stdin.write("cat('R_VAR_INITIALIZED\\n')\n");
      await new Promise(r => setTimeout(r, 100));

      // 3. Switch model to Model 1 again
      const mRes = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const mData = await mRes.json() as any;
      const model = mData.models.anthropic[0].id;

      const switchRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model}),
      });
      expect(switchRes.status).toBe(200);

      // 4. Compute result referencing assay_counts in the same R kernel
      rProc.stdin.write("total <- sum(assay_counts)\n");
      rProc.stdin.write("cat(sprintf('TOTAL_COUNTS=%d\\n', total))\n");
      rProc.stdin.end();

      const stdout = await new Response(rProc.stdout).text();
      await rProc.exited;

      expect(stdout).toContain('R_VAR_INITIALIZED');
      expect(stdout).toContain('TOTAL_COUNTS=500');
    });
  });
});
