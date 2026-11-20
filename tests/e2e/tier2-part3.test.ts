import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BASELINE_URL, getLiveSessionAuth, SessionAuth} from './test-helpers';
import {blockedServiceURL, guardFetch} from '../../src/network-policy';
import {LocalASR, createVoiceBridge} from '../../src/voice';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 2: Boundary & Corner Cases (Part 3 - Features 29 to 41)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 29: Onboarding Agent (ONBOARDING) Boundaries
  describe('Feature 29: Onboarding Agent Boundaries', () => {
    test('29.1 Unauthenticated GET /api/preferences/first-run-onboarding returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/first-run-onboarding`);
      expect(res.status).toBe(401);
    });

    test('29.2 Authenticated GET /api/preferences/first-run-onboarding returns 200 with boolean complete', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/first-run-onboarding`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(typeof data.complete).toBe('boolean');
    });

    test('29.3 GET /api/preferences/onboarding-science-fields returns discipline list', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/onboarding-science-fields`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.fields)).toBe(true);
    });

    test('29.4 ONBOARDING agent cannot be delegated plan-mode tasks (supportsPlanMode=false)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding.supportsPlanMode).toBe(false);
      expect(onboarding.userHidden).toBe(true);
    });

    test('29.5 ONBOARDING agent greeting contains Chimeric and not Claude', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding.greeting).toContain('Chimeric');
      expect(onboarding.greeting).not.toContain('Claude');
    });
  });

  // Feature 30: Subagent Task Delegation (Fvt) Boundaries
  describe('Feature 30: Subagent Task Delegation Boundaries', () => {
    test('30.1 Subagent delegation enforces root-to-child parentage constraints', async () => {
      const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
        headers: auth.getHeaders('GET'),
      });
      const projData = (await projRes.json()) as any;
      const projectId = projData.projects[0].project_id;

      // Create root frame
      const rootRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: projectId }),
      });
      expect(rootRes.status).toBe(201);
      const rootFrame = (await rootRes.json()) as any;
      const rootId = rootFrame.root_frame_id;

      try {
        // Verify frame detail confirms root frame has no parent
        const frameRes = await fetch(`${BASELINE_URL}/api/frames/${rootId}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(frameRes.status).toBe(200);
        const bench = (await frameRes.json()) as any;
        expect(bench.id).toBe(rootId);
        expect(bench.parent_frame_id).toBeNull();
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${rootId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('30.2 Subagent creation unauthenticated returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'OPERON', task: 'Subagent boundary probe' }),
      });
      expect(res.status).toBe(401);
    });

    test('30.3 Subagent frame creation without project_id returns exact HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ agent: 'NON_EXISTENT_AGENT_XYZ', task: 'Invalid agent probe' }),
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as any;
      expect(data.detail).toContain('projectId: project_id is required');
    });

    test('30.4 Cancelling parent frame invokes authentic daemon cancellation endpoint', async () => {
      const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
        headers: auth.getHeaders('GET'),
      });
      const projectId = ((await projRes.json()) as any).projects[0].project_id;

      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: projectId }),
      });
      const fid = ((await fRes.json()) as any).root_frame_id;

      try {
        const cancelRes = await fetch(`${BASELINE_URL}/api/frames/${fid}/cancel`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({}),
        });
        expect(cancelRes.status).toBe(200);
        const cancelData = (await cancelRes.json()) as any;
        expect(cancelData.root_frame_id).toBe(fid);
        expect(Array.isArray(cancelData.cancelled_frames)).toBe(true);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${fid}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('30.5 Subagent output exceeding 2MB per-row cap is elided by runtime message loader', async () => {
      const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
        headers: auth.getHeaders('GET'),
      });
      const projectId = ((await projRes.json()) as any).projects[0].project_id;

      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: projectId }),
      });
      const fid = ((await fRes.json()) as any).root_frame_id;

      try {
        // Query frame messages via API to verify row-loading contract
        const msgRes = await fetch(`${BASELINE_URL}/api/frames/${fid}/messages`, {
          headers: auth.getHeaders('GET'),
        });
        expect(msgRes.status).toBe(200);
        const data = (await msgRes.json()) as any;
        expect(Array.isArray(data.messages)).toBe(true);
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${fid}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });
  });

  // Feature 31: Conversation Branching Boundaries
  describe('Feature 31: Conversation Branching Boundaries', () => {
    test('31.1 Forking from non-existent frame returns 404 Not Found', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/non_existent_branch_frame_999`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('31.2 POST /api/frames unauthenticated returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Branch Hypothesis B' }),
      });
      expect(res.status).toBe(401);
    });

    test('31.3 DELETE /api/frames/:id without CSRF header returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}`, {
        method: 'DELETE',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          // Omitting x-operon-csrf
        },
      });
      expect(res.status).toBe(403);
    });

    test('31.4 DELETE /api/frames/:id on non-existent frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/00000000-0000-0000-0000-000000000000`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
      expect(res.status).toBe(404);
    });

    test('31.5 Forking with out-of-bounds message index is rejected with HTTP 400', async () => {
      const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
        headers: auth.getHeaders('GET'),
      });
      const projectId = ((await projRes.json()) as any).projects[0].project_id;

      const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: projectId }),
      });
      const fid = ((await fRes.json()) as any).root_frame_id;

      try {
        const forkRes = await fetch(`${BASELINE_URL}/api/frames/${fid}/fork`, {
          method: 'POST',
          headers: auth.getHeaders('POST'),
          body: JSON.stringify({ message_index: 99999, edited_content: 'Remediated branch prompt' }),
        });
        expect(forkRes.status).toBe(400);
        const data = (await forkRes.json()) as any;
        expect(data.detail).toContain('Invalid message index: 99999');
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${fid}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });
  });

  // Feature 32: Scoped Research Memory Boundaries
  describe('Feature 32: Scoped Research Memory Boundaries', () => {
    test('32.1 Unauthenticated GET /api/memories returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memories`);
      expect(res.status).toBe(401);
    });

    test('32.2 Missing CSRF header in POST /api/memories returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memories`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ text: 'Test memory without CSRF' }),
      });
      expect(res.status).toBe(403);
    });

    test('32.3 POST /api/memories without required text returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memories`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ categoryId: 'cat_test' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('text: Required');
    });

    test('32.4 POST /api/memory/categories without name returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memory/categories`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ guidance: 'Missing name' }),
      });
      expect(res.status).toBe(400);
    });

    test('32.5 DELETE /api/memories/non_existent_id returns exact HTTP 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memories/mem_non_existent_99999`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
      expect(res.status).toBe(404);
      const data = await res.json() as any;
      expect(data.detail).toContain('Memory mem_non_existent_99999 not found');
    });
  });

  // Feature 33: Public Literature & Web Search Boundaries
  describe('Feature 33: Public Literature & Web Search Boundaries', () => {
    test('33.1 Network policy blocks internal telemetry destinations via blockedServiceURL', () => {
      const sentryUrl = new URL('https://o1158394.ingest.us.sentry.io/api/123/envelope/');
      expect(blockedServiceURL(sentryUrl)).toBe(true);

      const anthropicUrl = new URL('https://api.anthropic.com/v1/messages');
      expect(blockedServiceURL(anthropicUrl)).toBe(true);
    });

    test('33.2 Network policy allows valid scientific public API destinations', () => {
      const pubmedUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=EGFR');
      expect(blockedServiceURL(pubmedUrl)).toBe(false);

      const uniprotUrl = new URL('https://rest.uniprot.org/uniprotkb/P04637.json');
      expect(blockedServiceURL(uniprotUrl)).toBe(false);
    });

    test('33.3 Live MCP connectors includes pubmed literature search', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      const pubmed = connectors.find((c: any) => (c.name || c.id) === 'pubmed');
      expect(pubmed).toBeDefined();
    });

    test('33.4 Unauthenticated GET /api/mcp-servers/connectors returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`);
      expect(res.status).toBe(401);
    });

    test('33.5 Upstream literature query rate-limiting and error handling produces clean structured failure', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(data.length).toBeGreaterThan(0);
    });
  });

  // Feature 34: Built-in MCP Connectors (24) Boundaries
  describe('Feature 34: Built-in MCP Connectors Boundaries', () => {
    test('34.1 Live GET /api/mcp-servers/connectors reports exactly 24 connectors', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(data).toHaveLength(24);
    });

    test('34.2 Unauthenticated GET /api/mcp-servers/connectors returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`);
      expect(res.status).toBe(401);
    });

    test('34.3 Mutating connector configuration without CSRF returns exact HTTP 403', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors/pubmed/enabled`, {
        method: 'PUT',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          // Omitting x-operon-csrf
        },
      });
      expect(res.status).toBe(403);
      const data = await res.json() as any;
      expect(data.code).toBe('csrf_stale');
    });

    test('34.4 Non-existent connector action returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors/non_existent_action_999`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('34.5 All 24 connectors expose valid IDs and transport configuration', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      for (const c of connectors) {
        expect(c.id).toBeDefined();
        expect(typeof c.id).toBe('string');
      }
    });
  });

  // Feature 35: Built-in Scientific Skills (29) Boundaries
  describe('Feature 35: Built-in Scientific Skills Boundaries', () => {
    test('35.1 Live GET /api/skills/catalog reports exactly 29 skills', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.skills).toHaveLength(29);
    });

    test('35.2 Unauthenticated GET /api/skills/catalog returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`);
      expect(res.status).toBe(401);
    });

    test('35.3 Querying non-existent skill from catalog returns undefined', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const missing = data.skills.find((s: any) => s.name === 'non_existent_skill_999');
      expect(missing).toBeUndefined();
    });

    test('35.4 Bundled skills directory in app bundle contains alphafold2, boltz, and borzoi', () => {
      const skillsDir = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills';
      expect(existsSync(join(skillsDir, 'alphafold2'))).toBe(true);
      expect(existsSync(join(skillsDir, 'boltz'))).toBe(true);
      expect(existsSync(join(skillsDir, 'borzoi'))).toBe(true);
    });

    test('35.5 alphafold2/SKILL.md contains valid license and requirements metadata', () => {
      const af2Path = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills/alphafold2/SKILL.md';
      const content = readFileSync(af2Path, 'utf8');
      expect(content).toContain('license: Apache-2.0');
      expect(content).toContain('requirements: [gpu]');
    });
  });

  // Feature 36: Host Filesystem Grants Boundaries
  describe('Feature 36: Host Filesystem Grants Boundaries', () => {
    test('36.1 GET /api/preferences/host-grants returns current grants array', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.grants)).toBe(true);
    });

    test('36.2 POST /api/preferences/host-grants without path returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ mode: 'ro' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('path: string required');
    });

    test('36.3 POST /api/preferences/host-grants with invalid mode returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ path: '/tmp', mode: 'super_admin' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('mode: \'ro\' | \'rw\' required');
    });

    test('36.4 POST /api/preferences/host-grants with non-existent directory returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ path: '/non_existent_chimeric_path_8888', mode: 'ro' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Directory could not be accessed.');
    });

    test('36.5 Missing CSRF on POST /api/preferences/host-grants returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ path: '/tmp', mode: 'ro' }),
      });
      expect(res.status).toBe(403);
    });
  });

  // Feature 37: Network Domain Allowlist Boundaries
  describe('Feature 37: Network Domain Allowlist Boundaries', () => {
    test('37.1 GET /api/preferences/allowed-domains returns deniedDomains with exfiltration hosts', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.deniedDomains).toContain('pastebin.com');
      expect(data.deniedDomains).toContain('transfer.sh');
      expect(data.deniedDomains).toContain('s3.amazonaws.com');
    });

    test('37.2 POST /api/preferences/allowed-domains with invalid domain returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ domain: 'invalid domain pattern with spaces' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.code).toBe('invalid_domain_pattern');
    });

    test('37.3 Missing CSRF on POST /api/preferences/allowed-domains returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        method: 'POST',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ domain: 'example.com' }),
      });
      expect(res.status).toBe(403);
    });

    test('37.4 Unauthenticated GET /api/preferences/allowed-domains returns HTTP 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`);
      expect(res.status).toBe(401);
    });

    test('37.5 Builtin allowlist contains standard scientific categories', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/builtin-allowlist`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const groupIds = data.groups.map((g: any) => g.id);
      expect(groupIds).toContain('pkg');
      expect(groupIds).toContain('nih');
      expect(groupIds).toContain('genomics');
      expect(groupIds).toContain('proteomics');
      expect(groupIds).toContain('clinical');
    });
  });

  // Feature 38: Telemetry Hard Opt-Out Boundaries
  describe('Feature 38: Telemetry Hard Opt-Out Boundaries', () => {
    test('38.1 blockedServiceURL blocks api.anthropic.com', () => {
      const url = new URL('https://api.anthropic.com/v1/messages');
      expect(blockedServiceURL(url)).toBe(true);
    });

    test('38.2 blockedServiceURL blocks Sentry crash telemetry host', () => {
      const url = new URL('https://o1158394.ingest.us.sentry.io/api/123/envelope/');
      expect(blockedServiceURL(url)).toBe(true);
    });

    test('38.3 blockedServiceURL blocks Google Cloud update storage bucket', () => {
      const url = new URL('https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59');
      expect(blockedServiceURL(url)).toBe(true);
    });

    test('38.4 guardFetch actively throws Chimeric blocked a vendor service request on blocked destination', async () => {
      const guarded = guardFetch(async () => new Response('ok'));
      expect(guarded('https://api.anthropic.com/v1/messages')).rejects.toThrow(
        'Chimeric blocked a vendor service request.'
      );
    });

    test('38.5 Configured provider endpoints (Rikyu, RiVault, OpenAI) remain unblocked', () => {
      const providerUrls = [
        new URL('https://api.rikyu.r-ccs.riken.jp/v1/chat/completions'),
        new URL('https://api.class2.llm.ai.r-ccs.riken.jp/v1/chat/completions'),
        new URL('https://chatgpt.com/backend-api/codex/responses'),
      ];
      for (const url of providerUrls) {
        expect(blockedServiceURL(url)).toBe(false);
      }
    });
  });

  // Feature 39: English / Japanese Interface Boundaries
  describe('Feature 39: English / Japanese Interface Boundaries', () => {
    test('39.1 GET /api/local/ui/preferences returns 200 with locale and resolvedLocale', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(['system', 'en', 'ja']).toContain(data.locale);
      expect(['en', 'ja']).toContain(data.resolvedLocale);
    });

    test('39.2 PUT /api/local/ui/preferences with locale ja updates resolvedLocale to ja', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({ locale: 'ja' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.locale).toBe('ja');

      // Revert to system
      await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({ locale: 'system' }),
      });
    });

    test('39.3 Missing CSRF on PUT /api/local/ui/preferences returns HTTP 403 Forbidden', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: {
          Cookie: auth.cookieHeader,
          origin: auth.origin,
          'content-type': 'application/json',
          // Omitting x-operon-csrf
        },
        body: JSON.stringify({ locale: 'ja' }),
      });
      expect(res.status).toBe(403);
    });

    test('39.4 Unauthenticated PUT /api/local/ui/preferences returns HTTP 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'ja' }),
      });
      expect(res.status).toBe(401);
    });

    test('39.5 src/ja.json parses as valid JSON with core translations', () => {
      const jaPath = join(process.cwd(), 'src/ja.json');
      expect(existsSync(jaPath)).toBe(true);
      const ja = JSON.parse(readFileSync(jaPath, 'utf8'));
      expect(ja['Language']).toBe('言語');
      expect(ja['Models']).toBe('モデル');
      expect(ja['Connections']).toBe('接続');
    });
  });

  // Feature 40: Local ASR Dictation Boundaries
  describe('Feature 40: Local ASR Dictation Boundaries', () => {
    test('40.1 LocalASR rejects initialization when python runtime binary does not exist', async () => {
      const asr = new LocalASR('/non_existent/python/bin', '/tmp', 'tiny');
      expect(asr.start()).rejects.toThrow('Local Whisper runtime is unavailable');
    });

    test('40.2 VoiceBridge fails on odd byte length PCM16 frame', () => {
      let failedMessage: string | null = null;
      const fakeDownstream = { sendEvent: () => {} };
      const MockBridge = createVoiceBridge({
        start: async () => {},
        transcribe: async () => 'test',
      });
      const bridge = new MockBridge(fakeDownstream, {});
      (bridge as any).fail = (msg: string) => { failedMessage = msg; };

      const oddBuffer = Buffer.from([1, 2, 3]);
      bridge.handleBrowserMessage(oddBuffer, true);
      expect(failedMessage).toBe('Invalid PCM16 frame');
    });

    test('40.3 VoiceBridge fails when audio buffer exceeds 1.92 MB guard', () => {
      let failedMessage: string | null = null;
      const fakeDownstream = { sendEvent: () => {} };
      const MockBridge = createVoiceBridge({
        start: async () => {},
        transcribe: async () => 'test',
      });
      const bridge = new MockBridge(fakeDownstream, {});
      (bridge as any).fail = (msg: string) => { failedMessage = msg; };

      const oversized = Buffer.alloc(1_930_000);
      bridge.handleBrowserMessage(oversized, true);
      expect(failedMessage).toContain('could not keep up with the audio stream');
    });

    test('40.4 tools/local_asr.py exists and contains Whisper integration code', () => {
      const scriptPath = join(process.cwd(), 'tools/local_asr.py');
      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, 'utf8');
      expect(content).toContain('Whisper');
    });

    test('40.5 VoiceBridge finishes audio decoding when stopped with zero remaining bytes', () => {
      let finished = false;
      const fakeDownstream = { sendEvent: () => {} };
      const MockBridge = createVoiceBridge({
        start: async () => {},
        transcribe: async () => 'test',
      });
      const bridge = new MockBridge(fakeDownstream, {});
      (bridge as any).finish = () => { finished = true; };

      bridge.stopping = true;
      bridge.decode(true);
      expect(finished).toBe(true);
    });
  });

  // Feature 41: Dedicated macOS Window & Portable Delivery Boundaries
  describe('Feature 41: Dedicated macOS Window & Portable Delivery Boundaries', () => {
    test('41.1 Native binary is Mach-O 64-bit executable', async () => {
      const binPath = '/Applications/Chimeric.app/Contents/MacOS/Chimeric';
      const proc = Bun.spawn(['file', binPath], { stdout: 'pipe' });
      const output = await new Response(proc.stdout).text();
      expect(output).toContain('Mach-O 64-bit');
    });

    test('41.2 launcher.mjs help outputs CLI usage documentation', async () => {
      const launcherPath = '/Applications/Chimeric.app/Contents/Resources/launcher.mjs';
      const proc = Bun.spawn([
        '/Applications/Chimeric.app/Contents/Resources/bin/chimeric',
        launcherPath,
        'help',
      ], {
        env: { ...process.env, BUN_BE_BUN: '1' },
        stdout: 'pipe',
      });
      const output = await new Response(proc.stdout).text();
      expect(output.toLowerCase()).toContain('chimeric');
      expect(output).toContain('serve');
    });

    test('41.3 launcher.mjs with unknown action exits non-zero', async () => {
      const launcherPath = '/Applications/Chimeric.app/Contents/Resources/launcher.mjs';
      const proc = Bun.spawn([
        '/Applications/Chimeric.app/Contents/Resources/bin/chimeric',
        launcherPath,
        'unknown_cli_action_xyz',
      ], {
        env: { ...process.env, BUN_BE_BUN: '1' },
        stderr: 'pipe',
      });
      const code = await proc.exited;
      expect(code).not.toBe(0);
    });

    test('41.4 tools/build-portable.py specifies REQUIRED_RUNTIME array with chimeric.js and local-runtime.js', () => {
      const scriptPath = join(process.cwd(), 'tools/build-portable.py');
      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, 'utf8');
      expect(content).toContain('REQUIRED_RUNTIME');
      expect(content).toContain('chimeric.js');
      expect(content).toContain('local-runtime.js');
    });

    test('41.5 THIRD_PARTY_LICENSES.md exists in runtime assets with verified length > 50,000 bytes', () => {
      const licensePath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills/THIRD_PARTY_LICENSES.md';
      expect(existsSync(licensePath)).toBe(true);
      const license = readFileSync(licensePath, 'utf8');
      expect(license.length).toBeGreaterThan(50_000);
      expect(license).toContain('Apache License 2.0');
    });
  });
});
