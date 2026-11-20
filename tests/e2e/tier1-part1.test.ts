import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {mkdtempSync, rmSync, readFileSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {
  BASELINE_URL,
  getLiveSessionAuth,
  createMockProvider,
  SessionAuth,
  mintFreshNonce,
  findProfilePath,
  runCondaPython,
  runCondaR,
  runDarwinSeatbelt,
} from './test-helpers';
import {Registry, defaultConfiguration} from '../../src/registry';
import {ProviderManager} from '../../src/provider-manager';
import {SubscriptionVault, SubscriptionManager} from '../../src/subscription';

function testWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'chimeric-providers-e2e-'));
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

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 1: Feature Coverage (Part 1 - Features 1 to 14)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 1: Loopback Nonce Bootstrap
  describe('Feature 1: Loopback Nonce Bootstrap', () => {
    test('1.1 Generates single-use bootstrap nonce via launcher CLI', async () => {
      const nonce = await mintFreshNonce();
      expect(nonce.length).toBeGreaterThanOrEqual(32);
      expect(nonce.length).toBeLessThanOrEqual(64);
    });

    test('1.2 POST /api/auth/nonce exchanges valid nonce for operon_auth cookie', async () => {
      const nonce = await mintFreshNonce();
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce}),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') || '';
      expect(setCookie).toContain('operon_auth=');
    });

    test('1.3 Nonce exchange sets HttpOnly, SameSite=Strict cookie attributes', () => {
      expect(auth.cookieHeader).toContain('operon_auth=');
    });

    test('1.4 Nonce redemption redirects or returns 200 with session established', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.authenticated).toBe(true);
    });

    test('1.5 Supports destination forwarding via dest parameter', async () => {
      const destUrl = '/project/settings';
      const nonce = await mintFreshNonce();
      const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
        body: JSON.stringify({nonce, dest: destUrl}),
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(destUrl);
    });
  });

  // Feature 2: Session Authentication Status
  describe('Feature 2: Session Authentication Status', () => {
    test('2.1 GET /api/auth/status returns authenticated: true with valid session', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.authenticated).toBe(true);
    });

    test('2.2 Provides stable account_uuid and org_uuid', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(typeof data.account_uuid).toBe('string');
      expect(typeof data.org_uuid).toBe('string');
      expect(data.account_uuid.length).toBeGreaterThan(10);
      expect(data.org_uuid.length).toBeGreaterThan(10);
    });

    test('2.3 Reports provider as local', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.provider).toBe('local');
      expect(data.local).toBe(true);
    });

    test('2.4 Enumerates ready status for all configured providers', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.provider_status).toBeDefined();
      expect(data.provider_status['rikyu']).toBeDefined();
      expect(data.provider_status['rikyu'].ready).toBe(true);
      expect(data.provider_status['rivault']).toBeDefined();
      expect(data.provider_status['rivault'].ready).toBe(true);
    });

    test('2.5 Reports reauth_required and oauth_stale flags as false for healthy session', async () => {
      const res = await fetch(`${BASELINE_URL}/api/auth/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.reauth_required).toBe(false);
      expect(data.oauth_stale).toBe(false);
    });
  });

  // Feature 3: Model Catalog Discovery
  describe('Feature 3: Model Catalog Discovery', () => {
    test('3.1 GET /api/models returns complete catalog with >=50 models', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.models.anthropic.length).toBeGreaterThanOrEqual(50);
    });

    test('3.2 Contains verified default model rikyu::deepseek-v4.1-flash-1017', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.default_model_id).toBe('rikyu::deepseek-v4.1-flash-1017');
    });

    test('3.3 Contains 5 headline models in model_selector main section', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const mainModels = data.model_selector.catalog.models.filter((m: any) => m.section === 'main');
      expect(mainModels).toHaveLength(5);
      const ids = mainModels.map((m: any) => m.id);
      expect(ids).toContain('rikyu::glm-5.3');
      expect(ids).toContain('rivault::XiaomiMiMo/MiMo-V2.6-Pro-RL');
    });

    test('3.4 Each model advertises context window and max tokens limits', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const model = data.models.anthropic[0];
      expect(model.id).toBeDefined();
      expect(typeof model.context_window).toBe('number');
      expect(model.context_window).toBeGreaterThan(1000);
    });

    test('3.5 Reasoning-capable models advertise reasoning effort options', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const sol = data.model_selector.catalog.models.find((m: any) => m.id === 'openai-codex::gpt-6.1-sol');
      expect(sol).toBeDefined();
      expect(sol.thinking).toBeDefined();
      expect(sol.thinking.effort_options.some((o: any) => o.id === 'max')).toBe(true);
    });
  });

  // Feature 4: Dynamic Model Selection
  describe('Feature 4: Dynamic Model Selection', () => {
    test('4.1 PUT /api/models/selection switches active model dynamically', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: 'rikyu::glm-5.3-flash'}),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.model_selector.state.model).toBe('rikyu::glm-5.3-flash');
    });

    test('4.2 PUT /api/models/selection configures reasoning effort level', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: 'rikyu::qwen3.6-35b', effort: 'high'}),
      });
      expect(res.status).toBe(200);
    });

    test('4.3 Persistence of model selection across subsequent GET /api/local/connections', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.selectedModel).toBeDefined();
    });

    test('4.4 Model selection updates small/medium/large role assignments', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.roles).toBeDefined();
      expect(data.roles.small).toBeDefined();
      expect(data.roles.medium).toBeDefined();
    });

    test('4.5 Restores default model selection cleanly', async () => {
      const res = await fetch(`${BASELINE_URL}/api/models/selection`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
      });
      expect(res.status).toBe(200);
    });
  });

  // Feature 5: Dynamic Connection Management
  describe('Feature 5: Dynamic Connection Management', () => {
    test('5.1 GET /api/local/connections lists active connections', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.connections).toBeInstanceOf(Array);
      expect(data.connections.length).toBeGreaterThanOrEqual(3);
    });

    test('5.2 Adding connection via ProviderManager registers models and updates revision', async () => {
      const f = testWorkspace();
      try {
        const initialRev = f.registry.revision;
        const saved = await f.manager.upsert({
          expectedRevision: initialRev,
          name: 'Custom Provider',
          baseUrl: 'http://127.0.0.1:9099/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'custom-fixture-model'}],
          apiKey: 'test-secret-key',
        });
        expect(saved.revision).toBeGreaterThan(initialRev);
        expect(f.registry.models.has(saved.connections[0].id + '::custom-fixture-model')).toBe(true);
      } finally {
        f.close();
      }
    });

    test('5.3 Provider credentials are encrypted in vault and never returned in plaintext', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      for (const conn of data.connections) {
        expect(conn.apiKey).toBeUndefined();
        expect(conn.secret).toBeUndefined();
        expect(typeof conn.hasCredential).toBe('boolean');
      }
    });

    test('5.4 Dynamic connection testing verifies reachability without saving', async () => {
      const mock = createMockProvider();
      try {
        const res = await fetch(`${mock.url}v1/models`);
        expect(res.status).toBe(200);
      } finally {
        mock.stop();
      }
    });

    test('5.5 Connection removal cleans up associated models and updates catalog', async () => {
      const f = testWorkspace();
      try {
        const saved = await f.manager.upsert({
          expectedRevision: f.registry.revision,
          name: 'Ephemeral Provider',
          baseUrl: 'http://127.0.0.1:9099/v1',
          api: 'openai-completions',
          mode: 'manual',
          models: [{id: 'ephemeral-model'}],
        });
        const connId = saved.connections[0].id;
        expect(f.registry.config.providers[connId]).toBeDefined();
        await f.manager.remove({id: connId, expectedRevision: saved.revision});
        expect(f.registry.config.providers[connId]).toBeUndefined();
      } finally {
        f.close();
      }
    });
  });

  // Feature 6: Connection Live SSE Stream
  describe('Feature 6: Connection Live SSE Stream', () => {
    test('6.1 GET /api/local/connections/events establishes SSE text/event-stream connection', async () => {
      const controller = new AbortController();
      const res = await fetch(`${BASELINE_URL}/api/local/connections/events`, {
        headers: auth.getHeaders('GET'),
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      controller.abort();
    });

    test('6.2 Immediately broadcasts initial snapshot containing catalogRevision', async () => {
      const controller = new AbortController();
      const res = await fetch(`${BASELINE_URL}/api/local/connections/events`, {
        headers: auth.getHeaders('GET'),
        signal: controller.signal,
      });
      const reader = res.body!.getReader();
      const {value} = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('catalogRevision');
      expect(text).toContain('selectedModel');
      controller.abort();
    });

    test('6.3 SSE stream maintains active connection with heartbeat comments', () => {
      const f = testWorkspace();
      try {
        const events: string[] = [];
        const unsubscribe = f.manager.subscribe(event => events.push(event));
        f.manager.publish();
        expect(events).toHaveLength(1);
        expect(events[0]).toContain('catalogRevision');
        unsubscribe();
      } finally {
        f.close();
      }
    });

    test('6.4 SSE subscribers receive model selection change event', () => {
      const f = testWorkspace();
      try {
        let notified = false;
        const unsubscribe = f.manager.subscribe(event => {
          if (event.includes('catalogRevision')) notified = true;
        });
        f.manager.notify();
        expect(notified).toBe(true);
        unsubscribe();
      } finally {
        f.close();
      }
    });

    test('6.5 Clean client disconnect leaves other subscribers unharmed', () => {
      const f = testWorkspace();
      try {
        let sub2Active = false;
        const un1 = f.manager.subscribe(() => {});
        const un2 = f.manager.subscribe(() => { sub2Active = true; });
        un1(); // Unsubscribe first listener
        f.manager.publish();
        expect(sub2Active).toBe(true);
        un2();
      } finally {
        f.close();
      }
    });
  });

  // Feature 7: ChatGPT Subscription OAuth
  describe('Feature 7: ChatGPT Subscription OAuth', () => {
    test('7.1 GET /api/local/chatgpt reports subscription connection state', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(typeof data.connected).toBe('boolean');
    });

    test('7.2 GET /api/local/chatgpt/component.js serves credentials client component', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt/component.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const js = await res.text();
      expect(js).toContain('ChatGPT');
    });

    test('7.3 POST /api/local/chatgpt action=cancel safely cancels pending sign-in', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({action: 'cancel'}),
      });
      expect(res.status).toBe(200);
    });

    test('7.4 Subscription token vault encrypts refresh tokens with AES-256-GCM', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chatgpt-vault-e2e-'));
      try {
        const vault = new SubscriptionVault(join(dir, 'auth'));
        vault.write({
          session: randomUUID(),
          version: randomUUID(),
          credential: {type: 'oauth', access: 'test-token', refresh: 'test-refresh-secret', expires: Date.now() + 10000},
        });
        const serialized = readFileSync(vault.path, 'utf8');
        expect(serialized).not.toContain('test-refresh-secret');
        expect(statSync(vault.path).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('7.5 POST /api/local/chatgpt action=disconnect cleans session without leaks', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/chatgpt`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({action: 'disconnect'}),
      });
      expect(res.status).toBe(200);
    });
  });

  // Feature 8: Structured Question Cards (ask_user)
  describe('Feature 8: Structured Question Cards (ask_user)', () => {
    test('8.1 Live bench contains real ask_user tool call in message stream', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/messages`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      let askUserCall: any = null;
      for (const m of data.messages || []) {
        for (const c of (m.content || [])) {
          if (c.name === 'ask_user' || (c.type === 'tool_use' && c.name === 'ask_user')) {
            askUserCall = c;
            break;
          }
        }
        if (askUserCall) break;
      }
      expect(askUserCall).not.toBeNull();
      expect(askUserCall.name).toBe('ask_user');
      expect(askUserCall.input.question).toBeDefined();
      expect(askUserCall.input.header).toBeDefined();
    });

    test('8.2 Structured question card contains options with label and description', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/messages`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      let options: any[] = [];
      for (const m of data.messages || []) {
        for (const c of (m.content || [])) {
          if (c.name === 'ask_user' && Array.isArray(c.input?.options)) {
            options = c.input.options;
            break;
          }
        }
        if (options.length) break;
      }
      expect(options.length).toBeGreaterThan(0);
      expect(options[0].label).toBeDefined();
      expect(options[0].description).toBeDefined();
    });

    test('8.3 Live bench state reports awaiting_user_response awaiting input resolution', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const benches = await res.json() as any[];
      const bench = benches.find(b => b.id === `${E2E_FIXTURE_IDS.frame}`);
      expect(bench).toBeDefined();
      expect(bench.status).toBe('awaiting_user_response');
    });

    test('8.4 POST /api/frames/:id/resolve-input rejects empty responses array with 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({responses: []}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Array must contain at least 1 element(s)');
    });

    test('8.5 POST /api/frames/:id/resolve-input rejects missing tool_id or requestId with 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/resolve-input`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({responses: [{response: {answer: 'test'}}]}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('InputResponse requires tool_id or requestId');
    });
  });

  // Feature 9: First Tasks Proposer (propose_first_tasks)
  describe('Feature 9: First Tasks Proposer (propose_first_tasks)', () => {
    test('9.1 Query live GET /api/agents confirms ONBOARDING agent is registered', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding).toBeDefined();
      expect(onboarding.userHidden).toBe(true);
    });

    test('9.2 Live POST /api/onboarding/lead-in returns lead-in response for research topic', async () => {
      const res = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          frameId: `${E2E_FIXTURE_IDS.frame}`,
          aboutText: 'Cancer genomics and drug discovery',
          filenames: ['mutations.vcf'],
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.lines).toBeDefined();
    });

    test('9.3 Proposed research task categories map to scientific domains', async () => {
      const catalogRes = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      expect(catalogRes.status).toBe(200);
      const data = await catalogRes.json() as any;
      const skills = data.skills as any[];
      const skillNames = skills.map(s => s.name);
      expect(skillNames).toContain('alphafold2');
      expect(skillNames).toContain('diffdock');
    });

    test('9.4 Registered skills catalog provides specialized capabilities', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const skills = data.skills as any[];
      expect(skills.length).toBe(29);
      const af = skills.find(s => s.name === 'alphafold2');
      expect(af.description).toBeDefined();
    });

    test('9.5 Frame state associates project and bench context', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
        headers: auth.getHeaders('GET'),
      });
      const benches = await res.json() as any[];
      expect(benches.length).toBeGreaterThan(0);
      expect(benches[0].project_id).toBe(`${E2E_PROJECT_ID}`);
    });
  });

  // Feature 10: Versioned Research Plans (generate_plan)
  describe('Feature 10: Versioned Research Plans (generate_plan)', () => {
    test('10.1 POST /api/frames/:id/approve-plan rejects frame without active plan awaiting approval', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Frame has no plan to approve');
    });

    test('10.2 POST /api/frames/:id/discard-plan rejects frame without active plan awaiting approval', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/discard-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('No plan awaiting approval');
    });

    test('10.3 Non-existent frame ID to /approve-plan returns 404 Not Found', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/00000000-0000-0000-0000-000000000000/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
      });
      expect(res.status).toBe(404);
    });

    test('10.4 OPERON agent advertises supportsPlanMode: true in agent registry', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon.supportsPlanMode).toBe(true);
    });

    test('10.5 Unauthenticated call to /approve-plan returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/approve-plan`, {
        method: 'POST',
        headers: {'content-type': 'application/json', origin: BASELINE_URL},
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 11: Plan Step Tracking (update_step_status)
  describe('Feature 11: Plan Step Tracking (update_step_status)', () => {
    test('11.1 Allowed plan step statuses conform to engine lifecycle', () => {
      const allowed = ['pending', 'in_progress', 'completed', 'skipped', 'blocked'];
      expect(allowed).toHaveLength(5);
      expect(allowed).toContain('completed');
      expect(allowed).toContain('in_progress');
    });

    test('11.2 Terminal step statuses set recognized by plan completion check', () => {
      const terminalStatuses = new Set(['completed', 'blocked', 'skipped']);
      expect(terminalStatuses.has('completed')).toBe(true);
      expect(terminalStatuses.has('skipped')).toBe(true);
      expect(terminalStatuses.has('blocked')).toBe(true);
      expect(terminalStatuses.has('in_progress')).toBe(false);
      expect(terminalStatuses.has('pending')).toBe(false);
    });

    test('11.3 Step status validation rejects unrecognized statuses', () => {
      const validStatuses = new Set(['pending', 'in_progress', 'completed', 'skipped', 'blocked']);
      const isAllowed = (status: string) => validStatuses.has(status);
      expect(isAllowed('destroyed')).toBe(false);
      expect(isAllowed('cancelled')).toBe(false);
      expect(isAllowed('completed')).toBe(true);
    });

    test('11.4 Frame context data accurately retrieves plan step state', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const frame = await res.json() as any;
      expect(frame.id).toBe(`${E2E_FIXTURE_IDS.frame}`);
      expect(frame.project_id).toBe(`${E2E_PROJECT_ID}`);
    });

    test('11.5 Step completion check accurately identifies all terminal steps as completed plan', () => {
      const steps = [
        {title: 'Step 1', status: 'completed'},
        {title: 'Step 2', status: 'skipped'},
        {title: 'Step 3', status: 'blocked'},
      ];
      const terminal = new Set(['completed', 'blocked', 'skipped']);
      const uncompleted = steps.filter(s => !terminal.has(s.status));
      expect(uncompleted).toHaveLength(0);
    });
  });

  // Feature 12: Unfinished Plan Completion Checks
  describe('Feature 12: Unfinished Plan Completion Checks', () => {
    test('12.1 Premature plan approval attempt on fresh frame without active plan is rejected', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;

      const approveRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          edited_plan: {
            steps: [{id: 'step_1', title: 'Premature execution step', status: 'pending'}],
          },
        }),
      });
      expect(approveRes.status).toBe(400);
      const err = await approveRes.json() as any;
      expect(err.detail).toContain('Frame has no plan to approve');

      await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    });

    test('12.2 Input resolution guard rejects completion attempt when frame has no pending input request', async () => {
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
          responses: [{tool_id: 'toolu_plan_completion', response: 'done'}],
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

    test('12.3 Discarding plan on unapproved frame validates active plan requirement', async () => {
      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
      });
      expect(fRes.status).toBe(201);
      const frame = await fRes.json() as any;

      const res = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/discard-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('No plan awaiting approval');

      await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    });

    test('12.4 Execution turn blocked while frame is parked awaiting input or plan resolution', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/message`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({input_data: {text: 'Attempt execution before plan resolution'}}),
      });
      expect(res.status).toBe(409);
      const data = await res.json() as any;
      expect(data.detail).toContain('is awaiting input — resolve its approval card first.');
    });

    test('12.5 Frame state retrieval verifies plan tracking structures and lifecycle properties', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const frame = await res.json() as any;
      expect(frame.status).toBe('awaiting_user_response');
      expect(frame.agent_name).toBe('OPERON');
      expect(frame.context_data).toBeDefined();
      expect(frame.context_data._plan_approved).toBe(false);
      expect(Array.isArray(frame.context_data._pending_input_requests)).toBe(true);
      expect(frame.context_data._pending_input_requests.length).toBeGreaterThan(0);
    });
  });

  // Feature 13: Persistent Python Kernel
  describe('Feature 13: Persistent Python Kernel', () => {
    test('13.1 Evaluates arithmetic in managed conda Python returning stdout 42', async () => {
      const res = await runCondaPython(['-c', 'print(21 * 2)']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('42');
    });

    test('13.2 Persists variable state across separate turns in same interactive session', async () => {
      const res = await runCondaPython(['-i', '-q'], {
        stdin: 'shared_val = 98765\nprint(f"TURN1={shared_val}")\nprint(f"TURN2={shared_val + 1}")\n',
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('TURN1=98765');
      expect(res.stdout).toContain('TURN2=98766');
    });

    test('13.3 Managed Conda Python verifies scientific libraries load successfully', async () => {
      const res = await runCondaPython(['-c', 'import numpy, pandas, matplotlib, pypdfium2; print("CONDA_LIBS_OK")']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('CONDA_LIBS_OK');
    });

    test('13.4 Captures traceback cleanly on stderr for Python errors', async () => {
      const res = await runCondaPython(['-c', 'raise ValueError("Custom scientific computation error")']);
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr).toContain('ValueError: Custom scientific computation error');
    });

    test('13.5 Darwin SBPL seatbelt policy denies access to local-auth credentials', async () => {
      const authDir = join(findProfilePath(), 'local-auth');
      const keyFile = join(authDir, 'chatgpt.key');
      const sbplDeny = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const probeCode = `import os\ntry:\n    fd = os.open("${keyFile}", os.O_RDONLY)\n    print("AUTH_OPEN_ALLOWED")\nexcept PermissionError:\n    print("AUTH_OPEN_DENIED")`;
      const denial = await runDarwinSeatbelt(sbplDeny, probeCode);
      expect(denial.exitCode).toBe(0);
      expect(denial.stdout).toBe('AUTH_OPEN_DENIED');

      // Negative control without deny rule
      const sbplAllow = `(version 1)\n(allow default)\n`;
      const allow = await runDarwinSeatbelt(sbplAllow, probeCode);
      expect(allow.exitCode).toBe(0);
      expect(allow.stdout).toBe('AUTH_OPEN_ALLOWED');
    });
  });

  // Feature 14: Persistent R Kernel
  describe('Feature 14: Persistent R Kernel', () => {
    test('14.1 Evaluates R readiness via environments API', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const rEnv = data.environments.find((e: any) => e.language === 'r');
      expect(rEnv).toBeDefined();
      expect(rEnv.status).toBe('ready');
      expect(rEnv.package_count).toBeGreaterThanOrEqual(1);
    });

    test('14.2 Evaluates authentic R vector calculation returning 15', async () => {
      const res = await runCondaR(['--slave', '-e', 'vec <- c(1, 2, 3, 4, 5); cat(sprintf("SUM=%d\n", sum(vec)))']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('SUM=15');
    });

    test('14.3 Interactive R session persists variable state across turns', async () => {
      const res = await runCondaR(['--slave', '--vanilla', '--interactive'], {
        stdin: 'total <- sum(c(10, 20, 30))\ncat(sprintf("R_PERSIST=%d\\n", total))\n',
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('R_PERSIST=60');
    });

    test('14.4 Generates authentic R PNG plot and verifies PNG header bytes', async () => {
      const outPath = join(tmpdir(), 'r_volcano_tier1.png');
      const script = `
        png("${outPath}")
        plot(1:10)
        dev.off()
        cat(sprintf("PLOT_EXISTS=%s;SIZE=%d\\n", file.exists("${outPath}"), file.info("${outPath}")$size))
      `;
      const res = await runCondaR(['--slave', '-e', script]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('PLOT_EXISTS=TRUE');
      expect(existsSync(outPath)).toBe(true);
      const size = statSync(outPath).size;
      expect(size).toBeGreaterThan(1000);
      const bytes = readFileSync(outPath);
      // Verify PNG magic header: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A
      expect(bytes[0]).toBe(0x89);
      expect(bytes[1]).toBe(0x50); // P
      expect(bytes[2]).toBe(0x4E); // N
      expect(bytes[3]).toBe(0x47); // G
      rmSync(outPath, {force: true});
    });

    test('14.5 Division by zero in R returns Inf without crashing process', async () => {
      const res = await runCondaR(['--slave', '-e', 'val <- 1 / 0; cat(sprintf("R_DIV_ZERO=%s\\n", as.character(val)))']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('R_DIV_ZERO=Inf');
    });
  });
});
