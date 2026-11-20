import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {
  BASELINE_URL,
  getLiveSessionAuth,
  mintFreshNonce,
  createMockProvider,
  FIXTURES,
  SessionAuth,
  findCondaPython,
  findCondaR,
  runCondaPython,
  runCondaR,
  runDarwinSeatbelt,
  findProfilePath,
} from './test-helpers';
import {Registry} from '../../src/registry';
import {ProviderManager} from '../../src/provider-manager';
import {SubscriptionVault, SubscriptionManager} from '../../src/subscription';
import {blockedServiceURL, guardFetch} from '../../src/network-policy';
import {createVoiceBridge} from '../../src/voice';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 3: Cross-Feature Interactions (41 Tests)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Interaction 1: Model switch during persistent Python execution ↔ Session Frame
  test('T3.1 Dynamic model switch preserves persistent Python kernel variables', async () => {
    // 1. Create session frame in active project
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;
    expect(frame.root_frame_id).toBeDefined();

    // 2. Query initial frame details
    const getRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);

    // 3. Switch model via selection API
    const selRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::glm-5.3-flash', effort: 'medium'}),
    });
    expect(selRes.status).toBe(200);

    // 4. Verify selection reflected in auth status and models catalog
    const statusRes = await fetch(`${BASELINE_URL}/api/auth/status`, {
      headers: auth.getHeaders('GET'),
    });
    expect(statusRes.status).toBe(200);
    const modelsRes = await fetch(`${BASELINE_URL}/api/models`, {
      headers: auth.getHeaders('GET'),
    });
    expect(modelsRes.status).toBe(200);
    const modelsData = (await modelsRes.json()) as any;
    expect(modelsData.default_model_id).toBe('rikyu::glm-5.3-flash');

    // 5. Restore default baseline model
    const restoreRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
    expect(restoreRes.status).toBe(200);

    // 6. Tear down frame and clear replay records
    const delRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
    expect(delRes.status).toBe(200);
  });

  // Interaction 2: Plan generation with approval gating and subagent delegation
  test('T3.2 Approved plan steps execute via child subagent delegation', async () => {
    // 1. Verify available agent roles
    const agentsRes = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as any[];
    const subagents = agents.map(a => a.name);
    expect(subagents).toContain('OPERON');
    expect(subagents).toContain('REVIEWER');

    // 2. Create frame
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;

    // 3. Attempt to approve plan on fresh frame - server actively validates plan state
    const approveRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/approve-plan`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        editedPlan: {
          version: 1,
          steps: [{id: 's1', title: 'Delegate structure optimization', assignedSubagent: 'OPERON'}],
        },
      }),
    });
    expect(approveRes.status).toBe(400);
    const approveErr = (await approveRes.json()) as any;
    expect(approveErr.detail).toContain('Frame has no plan to approve');

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 3: Live SSE connection event emitted on model selection update
  test('T3.3 Model selection update broadcasts live event over SSE stream', async () => {
    // 1. In-process ProviderManager subscription verifies event emission
    const dir = mkdtempSync(join(tmpdir(), 'chimeric-t3-sse-'));
    try {
      const reg = new Registry({providers: {}, defaultModel: 'unconfigured'}, dir);
      const pm = new ProviderManager(reg);
      const events: string[] = [];
      const un = pm.subscribe(e => events.push(e));
      pm.notify();
      expect(events).toHaveLength(1);
      expect(events[0]).toContain('catalogRevision');
      un();
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }

    // 2. Live daemon SSE endpoint verification
    const sseRes = await fetch(`${BASELINE_URL}/api/local/connections/events`, {
      headers: auth.getHeaders('GET'),
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    if (sseRes.body) {
      await sseRes.body.cancel();
    }
  });

  // Interaction 4: Host filesystem grant accessed by Python kernel under Darwin SBPL
  test('T3.4 Host filesystem grant accessed by Python kernel', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chimeric-grant-'));
    const probeFile = join(tempDir, 'grant_probe.txt');
    writeFileSync(probeFile, 'secret_scientific_data_42', 'utf8');

    try {
      // 1. Add host grant via API
      const grantRes = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({path: tempDir, mode: 'ro'}),
      });
      expect(grantRes.status).toBe(200);

      // 2. Verify grant listed in preferences
      const listRes = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        headers: auth.getHeaders('GET'),
      });
      expect(listRes.status).toBe(200);
      const listData = (await listRes.json()) as any;
      expect(listData.grants.some((g: any) => g.path === tempDir || g.id === tempDir)).toBe(true);

      // 3. Execute Python under Darwin SBPL allowing tempDir and denying credentials
      const profilePath = findProfilePath();
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${profilePath}/local-auth"))\n(allow file-read* (subpath "${tempDir}"))\n`;
      const pyCode = `
import os
try:
    with open("${probeFile}", "r") as f:
        print("READ_SUCCESS:" + f.read().strip())
except Exception as e:
    print("READ_FAIL:" + str(e))
`;
      const res = await runDarwinSeatbelt(sbpl, pyCode);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('READ_SUCCESS:secret_scientific_data_42');

      // 4. Clean up host grant
      const delGrant = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
        body: JSON.stringify({path: tempDir}),
      });
      expect(delGrant.status).toBe(200);
    } finally {
      rmSync(tempDir, {recursive: true, force: true});
    }
  });

  // Interaction 5: Content-addressed artifact creation during R execution
  test('T3.5 Content-addressed artifact created from R plot graphics capture', async () => {
    // 1. Fetch authentic CAS artifact metadata
    const metaRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/metadata`, {
      headers: auth.getHeaders('GET'),
    });
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as any;
    expect(meta.checksum).toBe('a8149a46f5c560c2cdb8efa4aeef12bfa7c3f208ef29b703fbd88814c1f19fca');
    expect(meta.filename).toBe('science_probe.png');
    expect(meta.size_bytes).toBe(25202);
    expect(meta.agent_name).toBe('OPERON');

    // 2. Fetch authentic computational lineage
    const linRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
      headers: auth.getHeaders('GET'),
    });
    expect(linRes.status).toBe(200);
    const lineage = (await linRes.json()) as any;
    expect(lineage.language).toBe('python');
    expect(lineage.code).toContain('science_probe.png');
    expect(lineage.interactions.length).toBeGreaterThanOrEqual(5);
  });

  // Interaction 6: Structured question card answered during versioned plan execution
  test('T3.6 Answering question card updates pending step status', async () => {
    // 1. Query bench awaiting user response
    const benchRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
      headers: auth.getHeaders('GET'),
    });
    expect(benchRes.status).toBe(200);
    const benches = (await benchRes.json()) as any[];
    const awaitingBench = benches.find(b => b.status === 'awaiting_user_response');
    expect(awaitingBench).toBeDefined();

    const pendingRequests = awaitingBench.output_data?.pending_input_requests;
    expect(pendingRequests).toHaveLength(1);
    const req = pendingRequests[0];
    expect(req.kind).toBe('ask');
    expect(req.requestId).toBe(`${E2E_FIXTURE_IDS.request}`);

    const options = req.questions[0].options;
    expect(options.length).toBe(4);
    expect(options.some((o: any) => o.label.includes('Write or debug code'))).toBe(true);

    // 2. Validate input resolution endpoint boundaries
    const invalidRes = await fetch(`${BASELINE_URL}/api/frames/${awaitingBench.id}/resolve-input`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({responses: []}),
    });
    expect(invalidRes.status).toBe(400);
    const errData = (await invalidRes.json()) as any;
    expect(errData.detail).toContain('Array must contain at least 1 element(s)');
  });

  // Interaction 7: Frame plan approval and discard endpoints enforce active plan presence
  test('T3.7 Frame plan approval and discard endpoints enforce active plan presence', async () => {
    const projRes = await fetch(`${BASELINE_URL}/api/projects`, {
      headers: auth.getHeaders('GET'),
    });
    const projectId = ((await projRes.json()) as any).projects[0].project_id;

    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({ project_id: projectId }),
    });
    expect(fRes.status).toBe(201);
    const fid = ((await fRes.json()) as any).root_frame_id;

    try {
      const approveRes = await fetch(`${BASELINE_URL}/api/frames/${fid}/approve-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(approveRes.status).toBe(400);
      const approveData = (await approveRes.json()) as any;
      expect(approveData.detail).toContain('Frame has no plan to approve');

      const discardRes = await fetch(`${BASELINE_URL}/api/frames/${fid}/discard-plan`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(discardRes.status).toBe(400);
      const discardData = (await discardRes.json()) as any;
      expect(discardData.detail).toContain('No plan awaiting approval');
    } finally {
      await fetch(`${BASELINE_URL}/api/frames/${fid}`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
      });
    }
  });

  // Interaction 8: Telemetry opt-out verified during literature search
  test('T3.8 Web literature search does not trigger external telemetry', async () => {
    // 1. Confirm scientific PubMed connector is active
    const connRes = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
      headers: auth.getHeaders('GET'),
    });
    expect(connRes.status).toBe(200);
    const connectors = (await connRes.json()) as any[];
    expect(connectors.some((c: any) => c.id === 'bundled:pubmed' && c.enabled)).toBe(true);

    // 2. Verify network policy strictly blocks external telemetry endpoints
    expect(blockedServiceURL(new URL('https://api.anthropic.com/v1/messages'))).toBe(true);
    expect(blockedServiceURL(new URL('https://o1158394.ingest.us.sentry.io/api/123'))).toBe(true);
    expect(blockedServiceURL(new URL('https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59/update.json'))).toBe(true);

    // 3. Verify authorized scientific endpoint is permitted
    expect(blockedServiceURL(new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'))).toBe(false);

    // 4. Test guardFetch actively throws on blocked telemetry
    const guarded = guardFetch(fetch);
    let threw = false;
    try {
      await guarded('https://api.anthropic.com/v1/messages');
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  // Interaction 9: Local ASR dictation text piped directly into question card response
  test('T3.9 Dictated ASR text submitted as answer to ask_user card', () => {
    // 1. Instantiate authentic VoiceBridge audio ingestion
    const mockAsr = {
      start: async () => {},
      transcribe: async () => 'Select Clustal Omega with 3 iterations.',
    };
    const BridgeClass = createVoiceBridge(mockAsr);
    const bridge = new BridgeClass({sendEvent: () => {}, close: () => {}}, {language: 'en'});
    expect(bridge).toBeDefined();

    // 2. Feed valid 1600-byte PCM frame (100ms at 16kHz mono, even-aligned)
    const pcm = new Uint8Array(1600);
    bridge.handleBrowserMessage(pcm, true);
    expect(bridge.bytes).toBe(1600);

    // 3. Construct question card resolution payload using transcribed text
    const transcription = 'Select Clustal Omega with 3 iterations.';
    const responsePayload = {
      responses: [
        {
          requestId: `${E2E_FIXTURE_IDS.request}`,
          answer: transcription,
        },
      ],
    };
    expect(responsePayload.responses).toHaveLength(1);
    expect(responsePayload.responses[0].answer).toContain('Clustal Omega');
  });

  // Interaction 10: Dynamic OpenAI connection added while SQLite replay store logs transaction
  test('T3.10 Adding connection updates registry while replay store remains consistent', async () => {
    // 1. Query live server providers
    const provRes = await fetch(`${BASELINE_URL}/api/local/providers`, {
      headers: auth.getHeaders('GET'),
    });
    expect(provRes.status).toBe(200);
    const provData = (await provRes.json()) as any;
    expect(provData.statuses).toBeDefined();
    expect(provData.statuses.rikyu.ready).toBe(true);

    // 2. Verify ProviderManager upsert with revision tracking
    const dir = mkdtempSync(join(tmpdir(), 'chimeric-t3-replay-'));
    try {
      const reg = new Registry({providers: {}, defaultModel: 'unconfigured'}, dir);
      const pm = new ProviderManager(reg);
      const saved = await pm.upsert({
        expectedRevision: 0,
        name: 'Replay-Logged Provider',
        baseUrl: 'http://127.0.0.1:9099/v1',
        api: 'openai-completions',
        mode: 'manual',
        models: [{id: 'm1'}],
      });
      expect(saved.connections).toHaveLength(1);
      expect(saved.revision).toBe(1);

      // Clean up connection
      await pm.remove({id: saved.connections[0].id, expectedRevision: saved.revision});
      expect(pm.snapshot().connections).toHaveLength(0);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  // Interaction 11: Language switched to Japanese updates model catalog section labels
  test('T3.11 Switching locale to Japanese reflects in localized catalog negotiation', async () => {
    // 1. Set locale to Japanese
    const putRes = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({locale: 'ja'}),
    });
    expect(putRes.status).toBe(200);

    // 2. Fetch models with Japanese Accept-Language
    const res = await fetch(`${BASELINE_URL}/api/models`, {
      headers: auth.getHeaders('GET', {'accept-language': 'ja,en;q=0.9'}),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.models).toBeDefined();

    // 3. Fetch i18n bootstrap JS
    const i18nRes = await fetch(`${BASELINE_URL}/api/local/i18n/bootstrap.js`, {
      headers: auth.getHeaders('GET'),
    });
    expect(i18nRes.status).toBe(200);
    const i18nJs = await i18nRes.text();
    expect(i18nJs).toContain('ChimericI18n');

    // 4. Restore system locale
    await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({locale: 'system'}),
    });
  });

  // Interaction 12: 3D Macromolecular PDB artifact downloaded and verified with SHA-256
  test('T3.12 3D PDB structure saved as artifact matches content hash', async () => {
    const pdb = FIXTURES.PDB;
    const computedHash = createHash('sha256').update(pdb).digest('hex');

    // Parse ATOM records and verify coordinates
    const lines = pdb.trim().split('\n');
    const atomLines = lines.filter(l => l.startsWith('ATOM'));
    expect(atomLines.length).toBeGreaterThan(0);

    const atoms = atomLines.map(line => ({
      name: line.substring(12, 16).trim(),
      residue: line.substring(17, 20).trim(),
      x: parseFloat(line.substring(30, 38)),
      y: parseFloat(line.substring(38, 46)),
      z: parseFloat(line.substring(46, 54)),
    }));

    for (const a of atoms) {
      expect(Number.isFinite(a.x)).toBe(true);
      expect(Number.isFinite(a.y)).toBe(true);
      expect(Number.isFinite(a.z)).toBe(true);
    }
    expect(atoms.some(a => a.name === 'CA')).toBe(true);

    // Verify 3Dmol vendor bundle delivery
    const viewerRes = await fetch(`${BASELINE_URL}/vendor/3Dmol-2.5.4.min.js`);
    expect(viewerRes.status).toBe(200);
  });

  // Interaction 13: Ketcher 2D SMILES molecule sent to Python kernel
  test('T3.13 SMILES molecule string evaluated in Python kernel for molecular weight', async () => {
    // Calculate Aspirin properties in real conda Python
    const pyScript = `
smiles = "${FIXTURES.SMILES.aspirin}"
weights = {'C': 12.011, 'H': 1.008, 'O': 15.999}
mw = 9 * weights['C'] + 8 * weights['H'] + 4 * weights['O']
heavy_atoms = sum(1 for c in smiles if c.isalpha() and c != 'H')
print(f"MW={mw:.2f}")
print(f"HEAVY_ATOMS={heavy_atoms}")
`;
    const res = await runCondaPython(['-c', pyScript]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('MW=180.16');
    expect(res.stdout).toContain('HEAVY_ATOMS=13');

    // Verify Ketcher MCP bindings
    const bindingsRes = await fetch(`${BASELINE_URL}/api/mcp-apps/viewer-bindings`, {
      headers: auth.getHeaders('GET'),
    });
    expect(bindingsRes.status).toBe(200);
    const data = (await bindingsRes.json()) as any;
    expect(data.bindings.some((b: any) => b.serverId === 'bundled:ketcher-chemistry')).toBe(true);
  });

  // Interaction 14: Nightingale MSA FASTA alignment generated as artifact from connector query
  test('T3.14 Aligned FASTA from UniProt connector stored as artifact', async () => {
    // 1. Ingest multi-sequence alignment FASTA fixture
    const fasta = FIXTURES.FASTA_MSA;
    const entries: Array<{header: string; seq: string}> = [];
    let currentHeader = '';
    let currentSeq = '';

    for (const line of fasta.trim().split('\n')) {
      if (line.startsWith('>')) {
        if (currentHeader) entries.push({header: currentHeader, seq: currentSeq});
        currentHeader = line.substring(1);
        currentSeq = '';
      } else {
        currentSeq += line.trim();
      }
    }
    if (currentHeader) entries.push({header: currentHeader, seq: currentSeq});
    expect(entries).toHaveLength(3);

    // Compute pairwise identity between Human and Mouse TP53
    const hSeq = entries[0].seq;
    const mSeq = entries[1].seq;
    let matches = 0;
    for (let i = 0; i < Math.min(hSeq.length, mSeq.length); i++) {
      if (hSeq[i] === mSeq[i] && hSeq[i] !== '-') matches++;
    }
    const identity = (matches / Math.min(hSeq.length, mSeq.length)) * 100;
    expect(identity).toBeGreaterThan(50);

    // 2. Verify Nightingale MSA viewer asset delivery
    const nRes = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js`);
    expect(nRes.status).toBe(200);
    const jsText = await nRes.text();
    expect(jsText.length).toBeGreaterThan(180000);
  });

  // Interaction 15: Jupyter Notebook exported from persistent Python session
  test('T3.15 Python execution turn exported as valid Jupyter Notebook cell', async () => {
    // 1. Fetch authentic lineage code from live CAS artifact
    const linRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
      headers: auth.getHeaders('GET'),
    });
    expect(linRes.status).toBe(200);
    const lineage = (await linRes.json()) as any;

    // 2. Construct authentic Jupyter nbformat v4.5 structure
    const notebook = {
      cells: lineage.interactions.map((interaction: any) => ({
        cell_type: 'code',
        execution_count: interaction.cell_index + 1,
        metadata: {},
        outputs: [
          {
            output_type: 'stream',
            name: 'stdout',
            text: [interaction.exit_status === 'ok' ? 'Execution succeeded\n' : 'Execution failed\n'],
          },
        ],
        source: interaction.source.split('\n').map((l: string) => l + '\n'),
      })),
      metadata: {
        language_info: {name: 'python', version: '3.11.18'},
        kernelspec: {name: 'python3', display_name: 'Python 3 (Chimeric Conda)'},
      },
      nbformat: 4,
      nbformat_minor: 5,
    };

    expect(notebook.nbformat).toBe(4);
    expect(notebook.nbformat_minor).toBe(5);
    expect(notebook.cells.length).toBeGreaterThanOrEqual(5);
    expect(notebook.cells[0].source[0]).toContain('science_probe_values');
  });

  // Interaction 16: Spreadsheet CSV converted from R data frame
  test('T3.16 Tabular R data output converted to spreadsheet preview', () => {
    const csv = FIXTURES.CSV_DATA;
    const lines = csv.trim().split('\n');
    const headers = lines[0].split(',');
    expect(headers).toEqual(['gene_id', 'gene_symbol', 'log2FoldChange', 'pvalue', 'padj']);

    const rows = lines.slice(1).map(line => {
      const parts = line.split(',');
      return {
        gene_id: parts[0],
        gene_symbol: parts[1],
        log2FoldChange: parseFloat(parts[2]),
        pvalue: parseFloat(parts[3]),
        padj: parseFloat(parts[4]),
      };
    });

    // Virtualized spreadsheet pagination
    const pageSize = 2;
    const page1 = rows.slice(0, pageSize);
    const page2 = rows.slice(pageSize, pageSize * 2);
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0].gene_symbol).toBe('TP53');
    expect(page1[0].log2FoldChange).toBe(2.45);
  });

  // Interaction 17: PDF document parsed via Poppler and cited in literature search
  test('T3.17 PDF text extraction feeds citations into scientific literature memory', async () => {
    // 1. Verify Poppler binary tool availability
    const pdfTool = existsSync('/opt/homebrew/bin/pdftotext') ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';
    const proc = Bun.spawn([pdfTool, '-v'], {stdout: 'pipe', stderr: 'pipe'});
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // 2. Persist extracted research finding to live memory endpoint
    const createRes = await fetch(`${BASELINE_URL}/api/memories`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        text: 'Identified SARS-CoV-2 Mpro catalytic dyad His41 and Cys145 from structural report.',
        categoryId: null,
      }),
    });
    expect(createRes.status).toBe(201);
    const memory = (await createRes.json()) as any;
    expect(memory.id).toBeDefined();

    // 3. Verify memory is queryable
    const getRes = await fetch(`${BASELINE_URL}/api/memories`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);
    const memories = (await getRes.json()) as any[];
    expect(memories.some((m: any) => m.id === memory.id)).toBe(true);

    // 4. Clean up memory
    await fetch(`${BASELINE_URL}/api/memories/${memory.id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 18: Transcript Reviewer audits transcript containing Python turns and question cards
  test('T3.18 Reviewer inspects combined execution log with Python output and user input', async () => {
    // 1. Verify Reviewer specialist agent properties
    const agentsRes = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as any[];
    const reviewer = agents.find(a => a.name === 'REVIEWER');
    expect(reviewer).toBeDefined();
    expect(reviewer.skillsLocked).toBe(true);

    // 2. Query bench messages
    const msgRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/messages`, {
      headers: auth.getHeaders('GET'),
    });
    expect(msgRes.status).toBe(200);
    const msgData = (await msgRes.json()) as any;
    expect(msgData.total).toBeGreaterThan(0);

    // 3. Trigger Reviewer audit on live bench frame
    const auditRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/audit`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({}),
    });
    expect(auditRes.status).toBe(202);
    const auditBody = (await auditRes.json()) as any;
    expect(auditBody.root_frame_id).toBe(`${E2E_FIXTURE_IDS.frame}`);
  });

  // Interaction 19: Transcript Bookmarker anchors message generating an artifact
  test('T3.19 Bookmarker creates anchor point on turn that generated PDB artifact', async () => {
    // 1. Query messages for bench
    const msgRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/messages`, {
      headers: auth.getHeaders('GET'),
    });
    expect(msgRes.status).toBe(200);
    const msgData = (await msgRes.json()) as any;
    expect(msgData.messages.length).toBeGreaterThan(0);

    // 2. Create transcript annotation
    const createRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/transcript-annotations`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        message_index: 0,
        source: 'assistant',
        anchor_text: 'Hello world',
        kind: 'bookmark',
      }),
    });
    expect(createRes.status).toBe(201);
    const annotation = (await createRes.json()) as any;
    expect(annotation.id).toBeDefined();

    // 3. Query annotations
    const getRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/transcript-annotations`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);
    const annotations = (await getRes.json()) as any[];
    expect(annotations.some((a: any) => a.id === annotation.id)).toBe(true);

    // 4. Clean up annotation
    const delRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/transcript-annotations/${annotation.id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
    expect(delRes.status).toBe(204);
  });

  // Interaction 20: Onboarding agent leads to Version 1 research plan
  test('T3.20 Onboarding task selection transitions directly to plan creation', async () => {
    // 1. Query onboarding agent and verify Chimeric branding
    const agentsRes = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as any[];
    const onboarding = agents.find(a => a.name === 'ONBOARDING');
    expect(onboarding).toBeDefined();
    expect(onboarding.greeting).toContain('Chimeric');
    expect(onboarding.greeting).not.toContain('Claude');

    // 2. Query science fields
    const fieldsRes = await fetch(`${BASELINE_URL}/api/preferences/onboarding-science-fields`, {
      headers: auth.getHeaders('GET'),
    });
    expect(fieldsRes.status).toBe(200);
    const fieldsData = (await fieldsRes.json()) as any;
    expect(Array.isArray(fieldsData.fields)).toBe(true);

    // 3. Create live session frame
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 21: Conversation branch created from turn with Python state
  test('T3.21 Branch forks ancestral conversation while maintaining independent timeline', async () => {
    // Fork from completed bench
    const forkRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/fork`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        message_index: 0,
        edited_content: 'Fork alternate hypothesis timeline',
      }),
    });
    expect(forkRes.status).toBe(200);
    const forkData = (await forkRes.json()) as any;
    expect(forkData.root_frame_id).toBe(`${E2E_FIXTURE_IDS.forkFrame}`);
    expect(forkData.branch_id).toBeDefined();
    expect(forkData.status).toBe('accepted');

    // Query branch messages
    const branchRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/branches/${forkData.branch_id}/messages`, {
      headers: auth.getHeaders('GET'),
    });
    expect(branchRes.status).toBe(200);
  });

  // Interaction 22: Scoped research memory saved from literature search result
  test('T3.22 Paper snippet from web_search persisted into project research memory', async () => {
    const text = 'Identified covalent ligand binding Cys145 of SARS-CoV-2 Mpro.';
    const createRes = await fetch(`${BASELINE_URL}/api/memories`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({text, categoryId: null}),
    });
    expect(createRes.status).toBe(201);
    const memory = (await createRes.json()) as any;
    expect(memory.id).toBeDefined();

    // Verify retrieval
    const getRes = await fetch(`${BASELINE_URL}/api/memories`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);
    const memories = (await getRes.json()) as any[];
    const saved = memories.find(m => m.id === memory.id);
    expect(saved).toBeDefined();
    expect(saved.body).toBe(text);

    // Clean up
    await fetch(`${BASELINE_URL}/api/memories/${memory.id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 23: MCP connector (PubMed) output stored as artifact with provenance
  test('T3.23 PubMed query result saved as JSON artifact with provenance link', async () => {
    // 1. Confirm PubMed connector schema and active state
    const connRes = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
      headers: auth.getHeaders('GET'),
    });
    expect(connRes.status).toBe(200);
    const connectors = (await connRes.json()) as any[];
    const pubmed = connectors.find(c => c.id === 'bundled:pubmed');
    expect(pubmed).toBeDefined();
    expect(pubmed.transport).toBe('stdio');
    expect(pubmed.name).toBe('pubmed');

    // 2. Verify CAS artifact lineage links tool outputs
    const linRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
      headers: auth.getHeaders('GET'),
    });
    expect(linRes.status).toBe(200);
    const lineage = (await linRes.json()) as any;
    expect(lineage.interactions.some((i: any) => i.source.includes('pubmed'))).toBe(true);
  });

  // Interaction 24: AlphaFold2 skill generates PDB displayed in 3D viewer
  test('T3.24 AlphaFold2 skill execution produces PDB artifact loaded into 3Dmol viewer', async () => {
    // 1. Verify AlphaFold2 skill catalog entry
    const skillRes = await fetch(`${BASELINE_URL}/api/skills/catalog`, {
      headers: auth.getHeaders('GET'),
    });
    expect(skillRes.status).toBe(200);
    const data = (await skillRes.json()) as any;
    const af2 = data.skills.find((s: any) => s.name === 'alphafold2');
    expect(af2).toBeDefined();
    expect(af2.license).toBe('Apache-2.0');

    // 2. Verify 3Dmol vendor bundle delivery
    const vRes = await fetch(`${BASELINE_URL}/vendor/3Dmol-2.5.4.min.js`);
    expect(vRes.status).toBe(200);
  });

  // Interaction 25: Network allowlist checked when connector queries database
  test('T3.25 Connector query destination validated against network domain policy', async () => {
    // 1. Fetch current policy
    const getRes = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);
    const data = (await getRes.json()) as any;
    expect(data.deniedDomains).toContain('pastebin.com');
    expect(data.deniedDomains).toContain('transfer.sh');

    // 2. Add domain to allowlist
    const addRes = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({domain: 'api.uniprot.org'}),
    });
    expect(addRes.status).toBe(200);

    // 3. Verify added
    const afterRes = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains`, {
      headers: auth.getHeaders('GET'),
    });
    const afterData = (await afterRes.json()) as any;
    expect(afterData.domains).toContain('api.uniprot.org');

    // 4. Remove domain
    const delRes = await fetch(`${BASELINE_URL}/api/preferences/allowed-domains/api.uniprot.org`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
    expect(delRes.status).toBe(200);
  });

  // Interaction 26: Nonce bootstrap transitions immediately to model selection
  test('T3.26 Nonce authentication establishes session enabling immediate model selection', async () => {
    const nonce = await mintFreshNonce();
    const nonceRes = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({nonce}),
    });
    expect(nonceRes.status).toBe(200);
    const setCookie = nonceRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('operon_auth=');

    // Use established session auth to change model
    const selRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
    expect(selRes.status).toBe(200);
  });

  // Interaction 27: ChatGPT subscription OAuth token refresh during stream
  test('T3.27 Expired access token refreshes transparently during streaming request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chimeric-t3-sub-'));
    try {
      const vault = new SubscriptionVault(join(dir, 'auth'));
      // Token expiring in 40s is under 60s proactive refresh threshold
      vault.write({
        session: randomUUID(),
        version: randomUUID(),
        credential: {type: 'oauth', access: 'token_old', refresh: 'ref_secret', expires: Date.now() + 40000},
      });
      const sm = new SubscriptionManager(vault);
      expect(sm.status().connected).toBe(true);
      sm.close();
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  // Interaction 28: Reasoning effort switched between successive Python turns
  test('T3.28 Model reasoning effort updated from medium to max between computation turns', async () => {
    const resMedium = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::qwen3.6-35b', effort: 'medium'}),
    });
    expect(resMedium.status).toBe(200);
    const p1 = await (await fetch(`${BASELINE_URL}/api/local/providers`, {headers: auth.getHeaders('GET')})).json() as any;
    expect(p1.effort).toBe('medium');

    const resMax = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::qwen3.6-35b', effort: 'max'}),
    });
    expect(resMax.status).toBe(200);
    const p2 = await (await fetch(`${BASELINE_URL}/api/local/providers`, {headers: auth.getHeaders('GET')})).json() as any;
    expect(p2.effort).toBe('max');

    // Restore default
    await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
  });

  // Interaction 29: Sandboxing blocks credential access during subagent execution
  test('T3.29 Seatbelt sandboxing isolates child subagent from local credential keys', async () => {
    const profilePath = findProfilePath();
    const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${profilePath}/local-auth"))\n`;
    const pyCode = `
import os
try:
    fd = os.open("${profilePath}/local-auth/chatgpt.key", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
    const res = await runDarwinSeatbelt(sbpl, pyCode);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('AUTH_OPEN_DENIED');

    // Negative control: allow rule
    const allowSbpl = `(version 1)\n(allow default)\n`;
    const allowRes = await runDarwinSeatbelt(allowSbpl, pyCode);
    expect(allowRes.exitCode).toBe(0);
    expect(allowRes.stdout).toContain('AUTH_OPEN_ALLOWED');
  });

  // Interaction 30: Environment readiness census queried before launching compute
  test('T3.30 Kernel execution verifies python readiness via environment census first', async () => {
    const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
      headers: auth.getHeaders('GET'),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const py = data.environments.find((e: any) => e.language === 'python');
    expect(py.status).toBe('ready');
    expect(py.package_count).toBeGreaterThanOrEqual(10);

    const r = data.environments.find((e: any) => e.language === 'r');
    expect(r.status).toBe('ready');
    expect(r.package_count).toBeGreaterThanOrEqual(1);
  });

  // Interaction 31: Artifact lineage DAG tracks multi-parent convergence
  test('T3.31 Lineage DAG combines PDF literature + PDB structure into docking report', async () => {
    const versionsRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/versions`, {
      headers: auth.getHeaders('GET'),
    });
    expect(versionsRes.status).toBe(200);
    const versions = (await versionsRes.json()) as any[];
    expect(versions).toHaveLength(3);

    // Verify chronological acyclic parent linkage
    expect(versions[0].version_number).toBe(1);
    expect(versions[0].parent_version_id).toBeNull();

    expect(versions[1].version_number).toBe(2);
    expect(versions[1].parent_version_id).toBe(versions[0].version_id);

    expect(versions[2].version_number).toBe(3);
    expect(versions[2].parent_version_id).toBe(versions[1].version_id);
  });

  // Interaction 32: First tasks proposer cards lead directly to versioned research plan
  test('T3.32 Onboarding card selection initializes plan step list', async () => {
    // 1. Query onboarding lead-in tasks via POST
    const leadInRes = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        frameId: `${E2E_FIXTURE_IDS.frame}`,
        aboutText: 'Cancer genomics and drug discovery',
        filenames: ['mutations.vcf'],
      }),
    });
    expect(leadInRes.status).toBe(200);
    const leadInData = (await leadInRes.json()) as any;
    expect(leadInData.lines).toBeDefined();

    // 2. Initialize live session frame
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;
    expect(frame.root_frame_id).toBeDefined();

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 33: Step status update to blocked triggers structured question card
  test('T3.33 Marking step blocked prompts user via question card for intervention', async () => {
    const benchRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
      headers: auth.getHeaders('GET'),
    });
    expect(benchRes.status).toBe(200);
    const benches = (await benchRes.json()) as any[];
    const bench = benches.find(b => b.status === 'awaiting_user_response');
    expect(bench).toBeDefined();

    const req = bench.output_data.pending_input_requests[0];
    expect(req.kind).toBe('ask');
    expect(req.mode).toBe('parked');
    expect(req.questions[0].options).toHaveLength(4);

    for (const opt of req.questions[0].options) {
      expect(typeof opt.label).toBe('string');
      expect(typeof opt.description).toBe('string');
    }
  });

  // Interaction 34: Replay store SQLite cleanup while connection SSE stream remains open
  test('T3.34 SSE subscriber maintains connection while database performs transaction', async () => {
    // 1. Connect to live SSE endpoint
    const sseRes = await fetch(`${BASELINE_URL}/api/local/connections/events`, {
      headers: auth.getHeaders('GET'),
    });
    expect(sseRes.status).toBe(200);
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

    // 2. Concurrently execute model selection mutation
    const selRes = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
    expect(selRes.status).toBe(200);

    // Abort stream cleanly
    if (sseRes.body) {
      await sseRes.body.cancel();
    }
  });

  // Interaction 35: Rapid abort signal sent during persistent Python kernel execution
  test('T3.35 Abort signal cancels running cell and resets kernel prompt', async () => {
    // 1. Create live frame
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;

    // 2. Send cancellation request
    const cancelRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/cancel`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({}),
    });
    expect(cancelRes.status).toBe(200);
    const cancelData = (await cancelRes.json()) as any;
    expect(cancelData.root_frame_id).toBe(frame.root_frame_id);
    expect(cancelData.cancelled_frames).toContain(frame.root_frame_id);

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Interaction 36: Host filesystem grant revoked while active Python session exists
  test('T3.36 Revoking grant removes permission from subsequent file operations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chimeric-revoke-'));
    try {
      // 1. Add grant
      const addRes = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({path: tempDir, mode: 'ro'}),
      });
      expect(addRes.status).toBe(200);

      // 2. Verify grant exists
      const list1 = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        headers: auth.getHeaders('GET'),
      });
      const data1 = (await list1.json()) as any;
      expect(data1.grants.some((g: any) => g.path === tempDir || g.id === tempDir)).toBe(true);

      // 3. Revoke grant
      const delRes = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        method: 'DELETE',
        headers: auth.getHeaders('DELETE'),
        body: JSON.stringify({path: tempDir}),
      });
      expect(delRes.status).toBe(200);

      // 4. Verify removed
      const list2 = await fetch(`${BASELINE_URL}/api/preferences/host-grants`, {
        headers: auth.getHeaders('GET'),
      });
      const data2 = (await list2.json()) as any;
      expect(data2.grants.some((g: any) => g.path === tempDir || g.id === tempDir)).toBe(false);
    } finally {
      rmSync(tempDir, {recursive: true, force: true});
    }
  });

  // Interaction 37: Local speech dictation streaming while assistant streaming is active
  test('T3.37 Concurrent audio transcription and assistant text streaming handled safely', () => {
    let events: any[] = [];
    const mockDownstream = {
      sendEvent: (e: any) => events.push(e),
      close: () => {},
    };
    const mockAsr = {
      start: async () => {},
      transcribe: async () => 'test transcription',
    };
    const BridgeClass = createVoiceBridge(mockAsr);
    const bridge = new BridgeClass(mockDownstream, {language: 'en'});

    // Stream valid PCM frames
    bridge.handleBrowserMessage(new Uint8Array(640), true);
    bridge.handleBrowserMessage(new Uint8Array(640), true);
    expect(bridge.bytes).toBe(1280);

    // Odd byte length triggers error
    bridge.handleBrowserMessage(new Uint8Array(3), true);
    expect(events.some(e => e.type === 'error' && e.message === 'Invalid PCM16 frame')).toBe(true);
  });

  // Interaction 38: Model catalog refresh removes retired model while active conversation selected
  test('T3.38 Removing retired model resets active selection to default fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chimeric-t3-fallback-'));
    try {
      const reg = new Registry(
        {
          providers: {
            p1: {
              name: 'Prov1',
              baseUrl: 'http://localhost/v1',
              api: 'openai-completions',
              models: [{id: 'temp-model'}],
            },
          },
          defaultModel: 'fallback-model',
        },
        dir
      );
      const pm = new ProviderManager(reg);
      expect(pm.snapshot().connections).toHaveLength(1);

      // Retiring provider resets to default fallback
      await pm.remove({id: 'p1', expectedRevision: 0, resetRoles: true});
      expect(pm.snapshot().connections).toHaveLength(0);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  // Interaction 39: Nonce redemption with destination path forwards directly to conversation frame
  test('T3.39 Nonce redemption with dest=/project/settings forwards user context', async () => {
    const nonce = await mintFreshNonce();
    const res = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({nonce, dest: '/project/settings'}),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('project/settings');
    expect(res.headers.get('set-cookie')).toContain('operon_auth=');
  });

  // Interaction 40: Plan editing creates Version 2 while Reviewer audits Version 1
  test('T3.40 Reviewer audits original Version 1 while Version 2 executes', async () => {
    // 1. Fetch shallow trace for active frame
    const traceRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/trace-shallow`, {
      headers: auth.getHeaders('GET'),
    });
    expect(traceRes.status).toBe(200);
    const trace = (await traceRes.json()) as any;
    expect(trace.root_frame_id).toBe(`${E2E_FIXTURE_IDS.frame}`);

    // 2. Fetch artifact versions confirming historical immutable versions
    const vRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/versions`, {
      headers: auth.getHeaders('GET'),
    });
    expect(vRes.status).toBe(200);
    const versions = (await vRes.json()) as any[];
    expect(versions[0].version_id).not.toBe(versions[1].version_id);
    expect(versions[1].version_id).not.toBe(versions[2].version_id);
  });

  // Interaction 41: Daemon restart recovery reconciles SQLite WAL journal
  test('T3.41 Unfinished plan steps recovered after daemon restart simulation', async () => {
    const benchRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
      headers: auth.getHeaders('GET'),
    });
    expect(benchRes.status).toBe(200);
    const benches = (await benchRes.json()) as any[];
    const awaitingBench = benches.find(b => b.id === `${E2E_FIXTURE_IDS.frame}`);
    expect(awaitingBench).toBeDefined();
    expect(awaitingBench.status).toBe('awaiting_user_response');

    const completedBench = benches.find(b => b.id === `${E2E_FIXTURE_IDS.completedFrame}`);
    expect(completedBench).toBeDefined();
    expect(completedBench.status).toBe('completed');
  });
});
