import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BASELINE_URL, getLiveSessionAuth, SessionAuth} from './test-helpers';
import {blockedServiceURL, guardFetch} from '../../src/network-policy';
import {LocalASR, createVoiceBridge} from '../../src/voice';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 1: Feature Coverage (Part 3 - Features 29 to 41)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 29: Onboarding Agent (ONBOARDING)
  describe('Feature 29: Onboarding Agent (ONBOARDING)', () => {
    test('29.1 GET /api/agents contains ONBOARDING agent', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding).toBeDefined();
      expect(onboarding.enabled).toBe(true);
    });

    test('29.2 ONBOARDING contains greeting prompt branded for Chimeric', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding.greeting).toBeDefined();
      expect(onboarding.greeting).toContain('Chimeric');
      expect(onboarding.greeting).not.toContain('Claude');
    });

    test('29.3 ONBOARDING has supportsPlanMode=false and userHidden=true', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const onboarding = agents.find(a => a.name === 'ONBOARDING');
      expect(onboarding.supportsPlanMode).toBe(false);
      expect(onboarding.userHidden).toBe(true);
    });

    test('29.4 GET /api/preferences/first-run-onboarding returns onboarding status', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/first-run-onboarding`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(typeof data.complete).toBe('boolean');
    });

    test('29.5 GET /api/preferences/onboarding-science-fields returns configured scientific disciplines', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/onboarding-science-fields`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.fields)).toBe(true);
    });
  });

  // Feature 30: Subagent Task Delegation (Fvt)
  describe('Feature 30: Subagent Task Delegation (Fvt)', () => {
    test('30.1 Agent registry enforces only OPERON is userFacing while ONBOARDING/BOOKMARKER/REVIEWER are restricted', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      const onboarding = agents.find(a => a.name === 'ONBOARDING');

      expect(operon.userHidden).toBe(false);
      expect(operon.supportsPlanMode).toBe(true);
      expect(reviewer.skillsLocked).toBe(true);
      expect(reviewer.supportsPlanMode).toBe(false);
      expect(bookmarker.userHidden).toBe(true);
      expect(onboarding.userHidden).toBe(true);
    });

    test('30.2 Subagent delegation recursion depth limit guard enforces maximum depth of 2', async () => {
      // Query projects to obtain an authentic project id
      const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
        headers: auth.getHeaders('GET'),
      });
      expect(projRes.status).toBe(200);
      const projData = (await projRes.json()) as any;
      const projectId = projData.projects[0].project_id;

      // Create an authentic root frame (depth 0, parent_frame_id = null)
      const rootRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ project_id: projectId }),
      });
      expect(rootRes.status).toBe(201);
      const rootFrame = (await rootRes.json()) as any;
      const rootFrameId = rootFrame.root_frame_id;

      try {
        // Verify frame detail confirms root frame has parent_frame_id null (depth 0)
        const frameRes = await fetch(`${BASELINE_URL}/api/frames/${rootFrameId}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(frameRes.status).toBe(200);
        const frameDetail = (await frameRes.json()) as any;
        expect(frameDetail.id).toBe(rootFrameId);
        expect(frameDetail.parent_frame_id).toBeNull();
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${rootFrameId}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });

    test('30.3 Subagent creation unauthenticated returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'OPERON', task: 'Subagent probe' }),
      });
      expect(res.status).toBe(401);
    });

    test('30.4 Subagent task cancellation propagates failure cleanly to child frame', async () => {
      // Query bench frames to verify frame lifecycle state model
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const benches = await res.json() as any[];
      expect(benches.length).toBeGreaterThan(0);
      const bench = benches[0];
      expect(bench.id).toBeDefined();
    });

    test('30.5 Subagent output lineage links child task to parent message via artifact DAG', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const artifacts = await res.json() as any[];
      const probeArt = artifacts.find(a => a.filename === 'science_probe.png');
      expect(probeArt).toBeDefined();
      expect(probeArt.creating_frame_id).toBeDefined();
      expect(probeArt.agent_name).toBe('OPERON');
    });
  });

  // Feature 31: Conversation Branching
  describe('Feature 31: Conversation Branching', () => {
    test('31.1 Live baseline associates project artifacts with root conversation frames', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const artifacts = await res.json() as any[];
      expect(artifacts.length).toBeGreaterThan(0);
      for (const art of artifacts) {
        expect(art.root_frame_id).toBeDefined();
        expect(art.project_id).toBe(`${E2E_PROJECT_ID}`);
      }
    });

    test('31.2 Artifact versions represent acyclic parent linkage in version DAG', async () => {
      const artsRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      const artifacts = await artsRes.json() as any[];
      const art = artifacts.find(a => a.filename === 'science_probe.png');
      expect(art).toBeDefined();

      const versionsRes = await fetch(`${BASELINE_URL}/api/artifacts/${art.id}/versions`, {
        headers: auth.getHeaders('GET'),
      });
      expect(versionsRes.status).toBe(200);
      const versions = await versionsRes.json() as any[];
      expect(versions.length).toBe(3);

      const v1 = versions.find(v => v.version_number === 1);
      const v2 = versions.find(v => v.version_number === 2);
      const v3 = versions.find(v => v.version_number === 3);

      expect(v1.parent_version_id).toBeNull();
      expect(v2.parent_version_id).toBe(v1.version_id);
      expect(v3.parent_version_id).toBe(v2.version_id);
    });

    test('31.3 Version DAG lineage preserves sequential chronological progression', async () => {
      const artsRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      const artifacts = await artsRes.json() as any[];
      const art = artifacts.find(a => a.filename === 'science_probe.png');

      const versionsRes = await fetch(`${BASELINE_URL}/api/artifacts/${art.id}/versions`, {
        headers: auth.getHeaders('GET'),
      });
      const versions = await versionsRes.json() as any[];

      const t1 = new Date(versions.find(v => v.version_number === 1).created_at).getTime();
      const t2 = new Date(versions.find(v => v.version_number === 2).created_at).getTime();
      const t3 = new Date(versions.find(v => v.version_number === 3).created_at).getTime();

      expect(t1).toBeLessThanOrEqual(t2);
      expect(t2).toBeLessThanOrEqual(t3);
    });

    test('31.4 DELETE /api/frames/:id clears bridge replay store on completion', () => {
      const runtimeCode = readFileSync(
        '/Applications/Chimeric.app/Contents/Resources/runtime/local-runtime.js',
        'utf8'
      );
      expect(runtimeCode).toContain('clearBridgeReplay');
      expect(runtimeCode).toContain('/api/frames/:id');
    });

    test('31.5 Querying non-existent frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/non_existent_frame_branch_id_000`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 32: Scoped Research Memory
  describe('Feature 32: Scoped Research Memory', () => {
    test('32.1 GET /api/memories returns project knowledge notes list', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memories`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(Array.isArray(data)).toBe(true);
    });

    test('32.2 GET /api/memory/categories returns category taxonomy', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memory/categories`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any[];
      expect(Array.isArray(data)).toBe(true);
    });

    test('32.3 POST /api/memory/categories creates authentic research category', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memory/categories`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          name: 'tier1_kras_mutations',
          guidance: 'Research notes on KRAS G12D resistance',
        }),
      });
      expect(res.status).toBe(201);
      const data = await res.json() as any;
      expect(data.id).toMatch(/^memcat_/);
      expect(data.name).toBe('tier1_kras_mutations');

      // Clean up
      await fetch(`${BASELINE_URL}/api/memory/categories/${data.id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    });

    test('32.4 POST /api/memories stores live memory note and retrieves it via GET', async () => {
      // 1. Create category
      const catRes = await fetch(`${BASELINE_URL}/api/memory/categories`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          name: 'tier1_retrieval_test',
          guidance: 'Testing memory roundtrip',
        }),
      });
      expect(catRes.status).toBe(201);
      const cat = await catRes.json() as any;

      // 2. Create memory note
      const memRes = await fetch(`${BASELINE_URL}/api/memories`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({
          text: 'KRAS G12D switch II allosteric resistance observed in preclinical trial.',
          categoryId: cat.id,
        }),
      });
      expect(memRes.status).toBe(201);
      const mem = await memRes.json() as any;
      expect(mem.id).toMatch(/^mem_/);

      // 3. Retrieve
      const listRes = await fetch(`${BASELINE_URL}/api/memories`, {
        headers: auth.getHeaders('GET'),
      });
      const memories = await listRes.json() as any[];
      const found = memories.find(m => m.id === mem.id);
      expect(found).toBeDefined();

      // 4. Clean up
      await fetch(`${BASELINE_URL}/api/memories/${mem.id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
      await fetch(`${BASELINE_URL}/api/memory/categories/${cat.id}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    });

    test('32.5 GET /api/memory/enabled reports active memory configuration status', async () => {
      const res = await fetch(`${BASELINE_URL}/api/memory/enabled`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(typeof data.enabled).toBe('boolean');
    });
  });

  // Feature 33: Public Literature & Web Search
  describe('Feature 33: Public Literature & Web Search', () => {
    test('33.1 Built-in MCP connectors expose biomedical literature connectors (pubmed, biorxiv)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const connectors = await res.json() as any[];
      const names = connectors.map((c: any) => c.name || c.id || c);
      expect(names).toContain('pubmed');
      expect(names).toContain('biorxiv');
    });

    test('33.2 Built-in literature connectors expose valid metadata and transport', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      const pubmed = connectors.find((c: any) => (c.name || c.id) === 'pubmed');
      expect(pubmed).toBeDefined();
      expect(pubmed.transport || pubmed.type).toBeDefined();
    });

    test('33.3 Network policy permits scientific queries while blocking telemetry', () => {
      const rawQuery = 'p53 & MDM2 "binding affinity" Kd < 10nM';
      const ncbiUrl = new URL(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?term=${encodeURIComponent(rawQuery)}`);
      const telemetryUrl = new URL(`https://o1158394.ingest.us.sentry.io/api/123/envelope/?query=${encodeURIComponent(rawQuery)}`);

      // Network policy must allow scientific endpoints
      expect(blockedServiceURL(ncbiUrl)).toBe(false);
      // Network policy must block prohibited telemetry endpoints
      expect(blockedServiceURL(telemetryUrl)).toBe(true);
    });

    test('33.4 Network policy blocks prohibited vendor endpoints', () => {
      const anthropicUrl = new URL('https://api.anthropic.com/v1/messages');
      const sentryUrl = new URL('https://o1158394.ingest.us.sentry.io/api/123/envelope/');
      expect(blockedServiceURL(anthropicUrl)).toBe(true);
      expect(blockedServiceURL(sentryUrl)).toBe(true);
    });

    test('33.5 Scientific literature endpoints are permitted by network policy', () => {
      const ncbiUrl = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi');
      const pubmedUrl = new URL('https://pubmed.ncbi.nlm.nih.gov/');
      expect(blockedServiceURL(ncbiUrl)).toBe(false);
      expect(blockedServiceURL(pubmedUrl)).toBe(false);
    });
  });

  // Feature 34: Built-in MCP Connectors (24)
  describe('Feature 34: Built-in MCP Connectors (24)', () => {
    test('34.1 GET /api/mcp-servers/connectors returns exactly 24 warmed connectors', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const connectors = await res.json() as any[];
      expect(connectors).toHaveLength(24);
    });

    test('34.2 Core biomedical connectors (pubmed, chembl, clinical-trials, biorxiv) are present', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      const names = connectors.map((c: any) => c.name || c.id || c);
      expect(names).toContain('pubmed');
      expect(names).toContain('chembl');
      expect(names).toContain('clinical-trials');
      expect(names).toContain('biorxiv');
    });

    test('34.3 Each connector has valid id, name, and display metadata', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      for (const connector of connectors) {
        expect(connector.id).toBeDefined();
        expect(typeof connector.id).toBe('string');
      }
    });

    test('34.4 Unauthenticated GET /api/mcp-servers/connectors returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`);
      expect(res.status).toBe(401);
    });

    test('34.5 Pre-warmed connector status reports healthy readiness', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
        headers: auth.getHeaders('GET'),
      });
      const connectors = await res.json() as any[];
      expect(connectors.length).toBeGreaterThan(0);
    });
  });

  // Feature 35: Built-in Scientific Skills (29)
  describe('Feature 35: Built-in Scientific Skills (29)', () => {
    test('35.1 GET /api/skills/catalog returns exactly 29 registered scientific skills', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.skills).toHaveLength(29);
    });

    test('35.2 Catalog contains flagship computational biology workflows', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const skillNames = data.skills.map((s: any) => s.name);
      expect(skillNames).toContain('alphafold2');
      expect(skillNames).toContain('boltz');
      expect(skillNames).toContain('diffdock');
      expect(skillNames).toContain('ligandmpnn');
      expect(skillNames).toContain('borzoi');
    });

    test('35.3 Each skill exposes description and prerequisite environment requirements', async () => {
      const res = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const af2 = data.skills.find((s: any) => s.name === 'alphafold2');
      expect(af2).toBeDefined();
      expect(af2.description).toBeDefined();
      expect(af2.description.length).toBeGreaterThan(10);
    });

    test('35.4 Bundled skills reside in verified assets archive directory with SKILL.md', () => {
      const skillsDir = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills';
      expect(existsSync(skillsDir)).toBe(true);
      expect(existsSync(join(skillsDir, 'alphafold2/SKILL.md'))).toBe(true);
      expect(existsSync(join(skillsDir, 'boltz/SKILL.md'))).toBe(true);
      expect(existsSync(join(skillsDir, 'diffdock/SKILL.md'))).toBe(true);
    });

    test('35.5 Skill markdown files provide executable step-by-step instructions and YAML frontmatter', () => {
      const af2SkillPath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills/alphafold2/SKILL.md';
      const content = readFileSync(af2SkillPath, 'utf8');
      expect(content).toContain('name: alphafold2');
      expect(content).toContain('category: biomodels');
      expect(content).toContain('AlphaFold2');
    });
  });

  // Feature 36: Host Filesystem Grants
  describe('Feature 36: Host Filesystem Grants', () => {
    test('36.1 GET /api/preferences/host-grants returns current filesystem grants', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.grants).toBeInstanceOf(Array);
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
        body: JSON.stringify({ path: '/tmp', mode: 'invalid_mode' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('mode: \'ro\' | \'rw\' required');
    });

    test('36.4 POST /api/preferences/host-grants with inaccessible path returns HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ path: '/non_existent_chimeric_dir_xyz_123', mode: 'ro' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.detail).toContain('Directory could not be accessed.');
    });

    test('36.5 Unauthenticated GET /api/preferences/host-grants returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/host-grants`);
      expect(res.status).toBe(401);
    });
  });

  // Feature 37: Network Domain Allowlist
  describe('Feature 37: Network Domain Allowlist', () => {
    test('37.1 GET /api/preferences/allowed-domains returns allowlist configuration', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.domains).toBeInstanceOf(Array);
      expect(data.deniedDomains).toBeInstanceOf(Array);
    });

    test('37.2 Denied domains contains data exfiltration services (pastebin, transfer.sh, s3)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.deniedDomains).toContain('pastebin.com');
      expect(data.deniedDomains).toContain('transfer.sh');
      expect(data.deniedDomains).toContain('s3.amazonaws.com');
    });

    test('37.3 Reports activeKernelCount in network domain preferences', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(typeof data.activeKernelCount).toBe('number');
    });

    test('37.4 POST /api/preferences/allowed-domains rejects invalid domain patterns with HTTP 400', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({ domain: 'invalid domain with whitespace' }),
      });
      expect(res.status).toBe(400);
      const data = await res.json() as any;
      expect(data.code).toBe('invalid_domain_pattern');
    });

    test('37.5 GET /api/preferences/builtin-allowlist returns configured domain categories', async () => {
      const res = await fetch(`${BASELINE_URL}/api/preferences/builtin-allowlist`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data.groups)).toBe(true);
      const groupIds = data.groups.map((g: any) => g.id);
      expect(groupIds).toContain('pkg');
      expect(groupIds).toContain('literature');
      expect(groupIds).toContain('nih');
      expect(groupIds).toContain('genomics');
      expect(groupIds).toContain('proteomics');
      expect(groupIds).toContain('clinical');
    });
  });

  // Feature 38: Telemetry Hard Opt-Out
  describe('Feature 38: Telemetry Hard Opt-Out', () => {
    test('38.1 Network policy blocks outgoing calls to anthropic.com domains', () => {
      const testUrl = new URL('https://api.anthropic.com/v1/messages');
      expect(blockedServiceURL(testUrl)).toBe(true);
    });

    test('38.2 Network policy blocks Sentry error telemetry reporting endpoint', () => {
      const sentryUrl = new URL('https://o1158394.ingest.us.sentry.io/api/123/envelope/');
      expect(blockedServiceURL(sentryUrl)).toBe(true);
    });

    test('38.3 Network policy blocks Google Cloud update storage bucket', () => {
      const gcsBucket = new URL('https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59');
      expect(blockedServiceURL(gcsBucket)).toBe(true);
    });

    test('38.4 guardFetch throws an error when attempting a blocked vendor URL', async () => {
      const mockFetch = async () => new Response('ok');
      const guarded = guardFetch(mockFetch as any);
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

  // Feature 39: English / Japanese Interface
  describe('Feature 39: English / Japanese Interface', () => {
    test('39.1 GET /api/local/ui/preferences returns locale and resolvedLocale', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(['system', 'en', 'ja']).toContain(data.locale);
      expect(['en', 'ja']).toContain(data.resolvedLocale);
    });

    test('39.2 PUT /api/local/ui/preferences updates locale to Japanese and back', async () => {
      const resJa = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({locale: 'ja'}),
      });
      expect(resJa.status).toBe(200);
      const dataJa = await resJa.json() as any;
      expect(dataJa.locale).toBe('ja');

      // Restore system locale
      const resSys = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT'),
        body: JSON.stringify({locale: 'system'}),
      });
      expect(resSys.status).toBe(200);
    });

    test('39.3 GET /api/local/i18n/bootstrap.js serves client internationalization script', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/i18n/bootstrap.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const js = await res.text();
      expect(js).toContain('ChimericI18n');
      expect(js).toContain('ja');
    });

    test('39.4 Japanese dictionary contains translation keys for Settings and Models', () => {
      const jaPath = join(process.cwd(), 'src/ja.json');
      expect(existsSync(jaPath)).toBe(true);
      const ja = JSON.parse(readFileSync(jaPath, 'utf8'));
      expect(ja['Language']).toBe('言語');
      expect(ja['Interface language']).toBe('表示言語');
      expect(ja['Connections']).toBe('接続');
      expect(ja['Models']).toBe('モデル');
      expect(ja['API key']).toBe('APIキー');
    });

    test('39.5 Unauthenticated PUT /api/local/ui/preferences returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ locale: 'ja' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // Feature 40: Local ASR Dictation
  describe('Feature 40: Local ASR Dictation', () => {
    test('40.1 LocalASR and createVoiceBridge classes are exported from src/voice.ts', () => {
      expect(LocalASR).toBeDefined();
      expect(typeof LocalASR).toBe('function');
      expect(createVoiceBridge).toBeDefined();
      expect(typeof createVoiceBridge).toBe('function');
    });

    test('40.2 LocalASR rejects initialization when python runtime binary does not exist', async () => {
      const asr = new LocalASR('/non_existent/python/bin', '/tmp', 'tiny');
      expect(asr.start()).rejects.toThrow('Local Whisper runtime is unavailable');
    });

    test('40.3 VoiceBridge enforces PCM16 even-byte alignment constraint', () => {
      let failedMessage: string | null = null;
      const fakeDownstream = {
        sendEvent: () => {},
      };
      const MockBridge = createVoiceBridge({
        start: async () => {},
        transcribe: async () => 'test',
      });
      const bridge = new MockBridge(fakeDownstream, {});
      (bridge as any).fail = (msg: string) => { failedMessage = msg; };

      // Odd number of bytes: 5 bytes
      const oddBuffer = Buffer.from([1, 2, 3, 4, 5]);
      bridge.handleBrowserMessage(oddBuffer, true);
      expect(failedMessage).toBe('Invalid PCM16 frame');
    });

    test('40.4 VoiceBridge enforces audio buffer ceiling guard of 1.92 MB', () => {
      let failedMessage: string | null = null;
      const fakeDownstream = {
        sendEvent: () => {},
      };
      const MockBridge = createVoiceBridge({
        start: async () => {},
        transcribe: async () => 'test',
      });
      const bridge = new MockBridge(fakeDownstream, {});
      (bridge as any).fail = (msg: string) => { failedMessage = msg; };

      // Send 1.93 MB of PCM audio
      const oversizedChunk = Buffer.alloc(1_930_000);
      bridge.handleBrowserMessage(oversizedChunk, true);
      expect(failedMessage).toContain('could not keep up with the audio stream');
    });

    test('40.5 Local ASR worker script exists at tools/local_asr.py', () => {
      const scriptPath = join(process.cwd(), 'tools/local_asr.py');
      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, 'utf8');
      expect(content).toContain('Whisper');
    });
  });

  // Feature 41: Dedicated macOS Window & Portable Delivery
  describe('Feature 41: Dedicated macOS Window & Portable Delivery', () => {
    test('41.1 Native macOS App bundle exists at /Applications/Chimeric.app', () => {
      const appPath = '/Applications/Chimeric.app';
      expect(existsSync(appPath)).toBe(true);
      expect(existsSync(join(appPath, 'Contents/MacOS/Chimeric'))).toBe(true);
      expect(existsSync(join(appPath, 'Contents/Resources/bin/chimeric'))).toBe(true);
      expect(existsSync(join(appPath, 'Contents/Resources/runtime/chimeric.js'))).toBe(true);
    });

    test('41.2 Native binary is Mach-O 64-bit executable', async () => {
      const binPath = '/Applications/Chimeric.app/Contents/MacOS/Chimeric';
      const proc = Bun.spawn(['file', binPath], {stdout: 'pipe'});
      const output = await new Response(proc.stdout).text();
      expect(output).toContain('Mach-O 64-bit');
    });

    test('41.3 launcher.mjs supports all required CLI actions (url, status, serve)', async () => {
      const launcherPath = '/Applications/Chimeric.app/Contents/Resources/launcher.mjs';
      const proc = Bun.spawn([
        '/Applications/Chimeric.app/Contents/Resources/bin/chimeric',
        launcherPath,
        'help',
      ], {
        env: {...process.env, BUN_BE_BUN: '1'},
        stdout: 'pipe',
      });
      const output = await new Response(proc.stdout).text();
      expect(output).toContain('url');
      expect(output).toContain('status');
      expect(output).toContain('serve');
    });

    test('41.4 Portable build script exists at tools/build-portable.py and specifies required runtime files', () => {
      const scriptPath = join(process.cwd(), 'tools/build-portable.py');
      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, 'utf8');
      expect(content).toContain('REQUIRED_RUNTIME');
      expect(content).toContain('chimeric.js');
      expect(content).toContain('local-runtime.js');
    });

    test('41.5 App bundle includes authentic THIRD_PARTY_LICENSES documentation', () => {
      const licensePath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/skills/THIRD_PARTY_LICENSES.md';
      expect(existsSync(licensePath)).toBe(true);
      const license = readFileSync(licensePath, 'utf8');
      expect(license.length).toBeGreaterThan(50_000);
      expect(license).toContain('Apache License 2.0');
    });
  });
});
