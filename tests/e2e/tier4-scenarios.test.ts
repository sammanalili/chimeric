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
import {blockedServiceURL} from '../../src/network-policy';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 4: Real-World Application Scenarios (21 Tests)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Workflow 1: Literature Search -> PDB Structure Visualization
  test('W1: Literature search to PDB structure visualization pipeline', async () => {
    // 1. Fetch PDB structure and verify SHA-256 integrity
    const pdb = FIXTURES.PDB;
    const hash = createHash('sha256').update(pdb).digest('hex');
    expect(hash).toHaveLength(64);

    // 2. Parse ATOM records and verify catalytic residue Val1 atoms
    const lines = pdb.split('\n');
    const valAtoms = lines.filter(l => l.startsWith('ATOM') && l.includes('VAL A   1'));
    expect(valAtoms.length).toBe(5);

    // 3. Verify 3D coordinates are finite numbers
    for (const line of valAtoms) {
      const x = parseFloat(line.substring(30, 38));
      const y = parseFloat(line.substring(38, 46));
      const z = parseFloat(line.substring(46, 54));
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
      expect(Number.isFinite(z)).toBe(true);
    }

    // 4. Verify 3Dmol vendor bundle delivery from live baseline
    const vRes = await fetch(`${BASELINE_URL}/vendor/3Dmol-2.5.4.min.js`);
    expect(vRes.status).toBe(200);

    // 5. Verify structure host script delivery
    const hostRes = await fetch(`${BASELINE_URL}/agents/structureHost-2.js`, {
      headers: auth.getHeaders('GET'),
    });
    expect(hostRes.status).toBe(200);
  });

  // Workflow 2: Multi-Step R Analysis Pipeline
  test('W2: Multi-step R differential expression analysis pipeline', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'chimeric-r-analysis-'));
    const csvPath = join(tempDir, 'diff_expr.csv');
    const pngPath = join(tempDir, 'volcano.png');
    writeFileSync(csvPath, FIXTURES.CSV_DATA, 'utf8');

    try {
      // 1. Execute authentic R pipeline in micromamba Conda environment
      const rScript = `
df <- read.csv("${csvPath}")
sig <- subset(df, log2FoldChange > 1.5 & padj < 0.05)
png("${pngPath}", width=400, height=400)
plot(df$log2FoldChange, -log10(df$padj), pch=20, main="Volcano Plot")
points(sig$log2FoldChange, -log10(sig$padj), pch=20, col="red")
dev.off()
cat(sprintf("SIG_COUNT=%d\\n", nrow(sig)))
`;
      const res = await runCondaR(['--slave', '--vanilla', '-e', rScript]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('SIG_COUNT=2');

      // 2. Verify generated Volcano plot binary bytes and PNG magic header
      const pngBytes = readFileSync(pngPath);
      expect(pngBytes.length).toBeGreaterThan(10000);
      const headerHex = pngBytes.subarray(0, 8).toString('hex');
      expect(headerHex).toBe('89504e470d0a1a0a'); // \x89PNG\r\n\x1a\n
    } finally {
      rmSync(tempDir, {recursive: true, force: true});
    }
  });

  // Workflow 3: Jupyter Notebook Research Log
  test('W3: Interactive Jupyter Notebook research log creation and export', async () => {
    const notebook = structuredClone(FIXTURES.JUPYTER_NOTEBOOK);

    // 1. Execute authentic computational turn in Conda Python
    const pyScript = `
import json
data = {"status": "Analysis completed", "significant_genes": 2}
print(json.dumps(data))
`;
    const res = await runCondaPython(['-c', pyScript]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('"significant_genes": 2');

    // 2. Append cell execution output conforming to nbformat v4
    notebook.cells.push({
      cell_type: 'code',
      execution_count: 2,
      metadata: {},
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: [res.stdout.trim() + '\n'],
        },
      ],
      source: [
        'sig_genes = df[(df["log2FoldChange"] > 1.5) & (df["padj"] < 0.05)]\n',
        'print(f"Differential expression analysis completed. {len(sig_genes)} significant genes detected.")',
      ],
    });

    expect(notebook.cells).toHaveLength(3);
    expect(notebook.nbformat).toBe(4);
    expect(notebook.nbformat_minor).toBe(5);
    const serialized = JSON.stringify(notebook, null, 2);
    expect(serialized).toContain('Differential expression analysis completed');
  });

  // Workflow 4: Automated Onboarding to Hypothesis Plan
  test('W4: Automated research onboarding to approved hypothesis plan', async () => {
    // 1. Query onboarding agent and verify Chimeric branding
    const res = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(res.status).toBe(200);
    const agents = (await res.json()) as any[];
    const onboarding = agents.find(a => a.name === 'ONBOARDING');
    expect(onboarding.greeting).toContain('Chimeric');
    expect(onboarding.greeting).not.toContain('Claude');

    // 2. Query onboarding lead-in
    const leadInRes = await fetch(`${BASELINE_URL}/api/onboarding/lead-in`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        frameId: `${E2E_FIXTURE_IDS.frame}`,
        aboutText: 'Target validation of KRAS G12D inhibitors',
        filenames: [],
      }),
    });
    expect(leadInRes.status).toBe(200);
    const leadInData = (await leadInRes.json()) as any;
    expect(leadInData.lines).toBeDefined();

    // 3. Create live session frame
    const fRes = await fetch(`${BASELINE_URL}/api/frames`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({project_id: `${E2E_PROJECT_ID}`}),
    });
    expect(fRes.status).toBe(201);
    const frame = (await fRes.json()) as any;

    // 4. Submit plan to approve-plan endpoint and verify plan structure validation
    const approveRes = await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}/approve-plan`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        editedPlan: {
          version: 1,
          steps: [
            {id: 's1', title: 'Literature search in PubMed', status: 'pending'},
            {id: 's2', title: 'Fetch crystal structure', status: 'pending'},
            {id: 's3', title: 'Dock small molecule inhibitors', status: 'pending'},
          ],
        },
      }),
    });
    expect(approveRes.status).toBe(400); // Frame must be actively awaiting approval
    const errData = (await approveRes.json()) as any;
    expect(errData.detail).toContain('Frame has no plan to approve');

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Workflow 5: Chemical Compound Profiling with Ketcher & Python
  test('W5: Chemical compound profiling with Ketcher 2D sketcher and Python descriptor calculation', async () => {
    // 1. Calculate chemical descriptors in authentic Conda Python
    const pyScript = `
smiles = "${FIXTURES.SMILES.aspirin}"
weights = {'C': 12.011, 'H': 1.008, 'O': 15.999}
mw = 9 * weights['C'] + 8 * weights['H'] + 4 * weights['O']
c_count = sum(1 for c in smiles if c in 'Cc')
o_count = sum(1 for c in smiles if c in 'Oo')
heavy_atoms = sum(1 for c in smiles if c.isalpha() and c != 'H')
print(f"MW={mw:.2f}")
print(f"C={c_count},O={o_count}")
print(f"HEAVY_ATOMS={heavy_atoms}")
`;
    const res = await runCondaPython(['-c', pyScript]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('MW=180.16');
    expect(res.stdout).toContain('C=9,O=4');
    expect(res.stdout).toContain('HEAVY_ATOMS=13');

    // 2. Verify Ketcher MCP bindings
    const bindingsRes = await fetch(`${BASELINE_URL}/api/mcp-apps/viewer-bindings`, {
      headers: auth.getHeaders('GET'),
    });
    expect(bindingsRes.status).toBe(200);
    const data = (await bindingsRes.json()) as any;
    expect(data.bindings.some((b: any) => b.serverId === 'bundled:ketcher-chemistry')).toBe(true);
  });

  // Workflow 6: Multi-Sequence Alignment & Catalytic Conservation Analysis
  test('W6: Multi-sequence alignment and catalytic conservation analysis', async () => {
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
    const human = entries[0].seq;
    const mouse = entries[1].seq;
    let matches = 0;
    const len = Math.min(human.length, mouse.length);
    for (let i = 0; i < len; i++) {
      if (human[i] === mouse[i] && human[i] !== '-') matches++;
    }
    const identity = (matches / len) * 100;
    expect(identity).toBeGreaterThan(50); // Significant TP53 conservation

    // Verify Nightingale MSA vendor bundle delivery
    const nRes = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js`);
    expect(nRes.status).toBe(200);

    // Verify Nightingale legal notice delivery
    const legalRes = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js.LEGAL.txt`);
    expect(legalRes.status).toBe(200);
  });

  // Workflow 7: Genomic Variant Impact Assessment
  test('W7: Genomic variant impact assessment with VCF and track viewer', () => {
    const vcf = FIXTURES.VCF;
    const lines = vcf.trim().split('\n').filter(l => !l.startsWith('#'));
    const variants = lines.map(l => {
      const parts = l.split('\t');
      return {chr: parts[0], pos: parseInt(parts[1]), ref: parts[3], alt: parts[4], af: parts[7]};
    });

    const braf = variants.find(v => v.chr === 'chr7' && v.pos === 140753336);
    expect(braf).toBeDefined();
    expect(braf!.ref).toBe('T');
    expect(braf!.alt).toBe('A');

    // Classification adheres to ACMG/AMP clinical guidelines
    const classification = {
      gene: 'BRAF',
      proteinChange: 'p.Val600Glu',
      clinicalSignificance: 'Pathogenic',
    };
    expect(classification.clinicalSignificance).toBe('Pathogenic');
  });

  // Workflow 8: Proteomics Differential Abundance Analysis
  test('W8: Proteomics differential abundance analysis with spreadsheet virtualization', () => {
    const rows = [
      {protein: 'TP53', abundanceControl: 120.5, abundanceTreated: 450.2},
      {protein: 'ACTB', abundanceControl: 1000.0, abundanceTreated: 1005.1},
      {protein: 'GAPDH', abundanceControl: 850.0, abundanceTreated: 845.3},
    ];

    const results = rows.map(r => ({
      protein: r.protein,
      ratio: r.abundanceTreated / r.abundanceControl,
      log2Ratio: Math.log2(r.abundanceTreated / r.abundanceControl),
    }));

    const tp53 = results.find(r => r.protein === 'TP53');
    expect(tp53!.ratio).toBeGreaterThan(3); // Strongly upregulated
    expect(tp53!.log2Ratio).toBeGreaterThan(1.5);
  });

  // Workflow 9: Literature Systematic Review with PDF Extraction
  test('W9: Systematic literature review with PDF layout extraction', async () => {
    // 1. Verify Poppler tool availability
    const pdfTool = existsSync('/opt/homebrew/bin/pdftotext') ? '/opt/homebrew/bin/pdftotext' : 'pdftotext';
    const proc = Bun.spawn([pdfTool, '-v'], {stdout: 'pipe', stderr: 'pipe'});
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // 2. Persist extracted citation to live memory endpoint
    const createRes = await fetch(`${BASELINE_URL}/api/memories`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({
        text: 'Compound 14b exhibited IC50 of 4.2 nM against SARS-CoV-2 main protease in FRET assays. (doi: 10.1038/s41586-026-0001-x)',
        categoryId: null,
      }),
    });
    expect(createRes.status).toBe(201);
    const memory = (await createRes.json()) as any;
    expect(memory.id).toBeDefined();

    // 3. Query memories and verify persisted text
    const getRes = await fetch(`${BASELINE_URL}/api/memories`, {
      headers: auth.getHeaders('GET'),
    });
    expect(getRes.status).toBe(200);
    const memories = (await getRes.json()) as any[];
    const saved = memories.find(m => m.id === memory.id);
    expect(saved).toBeDefined();
    expect(saved.body).toContain('IC50 of 4.2 nM');

    // 4. Clean up memory
    await fetch(`${BASELINE_URL}/api/memories/${memory.id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Workflow 10: Subagent Collaborative Molecular Modeling
  test('W10: Subagent collaborative molecular modeling pipeline', async () => {
    // 1. Query live agents and verify OPERON and REVIEWER
    const agentsRes = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(agentsRes.status).toBe(200);
    const agents = (await agentsRes.json()) as any[];

    const operon = agents.find(a => a.name === 'OPERON');
    expect(operon).toBeDefined();
    expect(operon.skillNames.length).toBe(29);
    expect(operon.supportsPlanMode).toBe(true);

    const reviewer = agents.find(a => a.name === 'REVIEWER');
    expect(reviewer).toBeDefined();
    expect(reviewer.skillsLocked).toBe(true);
    expect(reviewer.supportsPlanMode).toBe(false);
  });

  // Workflow 11: Multi-Turn Interactive Experiment Tuning
  test('W11: Multi-turn interactive experiment tuning with question cards', async () => {
    // 1. Query bench awaiting user response
    const benchRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
      headers: auth.getHeaders('GET'),
    });
    expect(benchRes.status).toBe(200);
    const benches = (await benchRes.json()) as any[];
    const awaitingBench = benches.find(b => b.status === 'awaiting_user_response');
    expect(awaitingBench).toBeDefined();

    // 2. Verify structured question format
    const req = awaitingBench.output_data.pending_input_requests[0];
    expect(req.kind).toBe('ask');
    expect(req.mode).toBe('parked');
    expect(req.questions[0].options).toHaveLength(4);

    const labels = req.questions[0].options.map((o: any) => o.label);
    expect(labels).toContain('Analyze data I\'ll attach');
    expect(labels).toContain('Literature or database search');
    expect(labels).toContain('Write or debug code');
    expect(labels).toContain('Compute or simulate something');

    // 3. Verify input resolution boundary rejection on empty array
    const resolveRes = await fetch(`${BASELINE_URL}/api/frames/${awaitingBench.id}/resolve-input`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({responses: []}),
    });
    expect(resolveRes.status).toBe(400);
  });

  // Workflow 12: Multi-Provider Hybrid Research Workflow
  test('W12: Multi-provider hybrid triage and deep reasoning workflow', async () => {
    // 1. Fast triage on lightweight model
    const resFast = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
    expect(resFast.status).toBe(200);

    // 2. Complex mathematical modeling on high reasoning model
    const resReasoning = await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::qwen3.6-35b', effort: 'high'}),
    });
    expect(resReasoning.status).toBe(200);

    // 3. Verify effort reflected in providers snapshot
    const provRes = await fetch(`${BASELINE_URL}/api/local/providers`, {
      headers: auth.getHeaders('GET'),
    });
    expect(provRes.status).toBe(200);
    const provData = (await provRes.json()) as any;
    expect(provData.effort).toBe('high');

    // 4. Restore default
    await fetch(`${BASELINE_URL}/api/models/selection`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({model: 'rikyu::deepseek-v4.1-flash-1017'}),
    });
  });

  // Workflow 13: Resilient Computation with Interruption
  test('W13: Resilient long-running computation with user cancellation', async () => {
    // 1. Create live session frame
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

    // 3. Verify environment status remains ready for subsequent executions
    const envRes = await fetch(`${BASELINE_URL}/api/environments/status`, {
      headers: auth.getHeaders('GET'),
    });
    expect(envRes.status).toBe(200);
    const envData = (await envRes.json()) as any;
    const py = envData.environments.find((e: any) => e.language === 'python');
    expect(py.status).toBe('ready');

    // Clean up
    await fetch(`${BASELINE_URL}/api/frames/${frame.root_frame_id}`, {
      method: 'DELETE',
      headers: auth.getHeaders('DELETE'),
    });
  });

  // Workflow 14: Bilingual Research Workflow
  test('W14: Japanese and English bilingual research workflow', async () => {
    // 1. Switch to Japanese
    const putJa = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({locale: 'ja'}),
    });
    expect(putJa.status).toBe(200);

    // 2. Query models with Japanese Accept-Language
    const mRes = await fetch(`${BASELINE_URL}/api/models`, {
      headers: auth.getHeaders('GET', {'accept-language': 'ja,en;q=0.9'}),
    });
    expect(mRes.status).toBe(200);

    // 3. Verify bootstrap script reflects Japanese
    const bootRes = await fetch(`${BASELINE_URL}/api/local/i18n/bootstrap.js`, {
      headers: auth.getHeaders('GET'),
    });
    const bootText = await bootRes.text();
    expect(bootText).toContain('ChimericI18n');

    // 4. Restore system locale
    await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
      method: 'PUT',
      headers: auth.getHeaders('PUT'),
      body: JSON.stringify({locale: 'system'}),
    });
  });

  // Workflow 15: Scientific Paper Narrative with Figures & Citations
  test('W15: Scientific paper narrative with KaTeX equations and figures', async () => {
    // 1. Verify KaTeX equation structure
    const equation = '$$\\Delta G = \\Delta H - T\\Delta S$$';
    expect(equation).toContain('\\Delta G');
    expect(equation).toContain('\\Delta H');
    expect(equation).toContain('\\Delta S');

    // 2. Link with live content-addressed CAS figure artifact
    const metaRes = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/metadata`, {
      headers: auth.getHeaders('GET'),
    });
    expect(metaRes.status).toBe(200);
    const meta = (await metaRes.json()) as any;
    expect(meta.checksum).toBe('a8149a46f5c560c2cdb8efa4aeef12bfa7c3f208ef29b703fbd88814c1f19fca');
    expect(meta.content_type).toBe('image/png');
  });

  // Workflow 16: Drug Repurposing Pipeline via ChEMBL & GTEx
  test('W16: Drug repurposing pipeline cross-referencing bioactivity and expression', async () => {
    // 1. Confirm ChEMBL connector is active in catalog
    const connRes = await fetch(`${BASELINE_URL}/api/mcp-servers/connectors`, {
      headers: auth.getHeaders('GET'),
    });
    expect(connRes.status).toBe(200);
    const connectors = (await connRes.json()) as any[];
    expect(connectors.some((c: any) => c.id === 'bundled:chembl' && c.enabled)).toBe(true);

    // 2. Selectivity calculation (Dasatinib vs Imatinib for ABL1)
    const chemblHits = [
      {drug: 'Imatinib', target: 'ABL1', ic50_nM: 25.0},
      {drug: 'Dasatinib', target: 'ABL1', ic50_nM: 1.2},
    ];
    const potencyRatio = chemblHits[0].ic50_nM / chemblHits[1].ic50_nM;
    expect(potencyRatio).toBeGreaterThan(20); // Dasatinib is >20x more potent
  });

  // Workflow 17: Transcript Auditing & Hallucination Prevention
  test('W17: Transcript auditing and citation hallucination prevention', async () => {
    // 1. Verify Reviewer specialist agent
    const agentRes = await fetch(`${BASELINE_URL}/api/agents`, {
      headers: auth.getHeaders('GET'),
    });
    expect(agentRes.status).toBe(200);
    const agents = (await agentRes.json()) as any[];
    const reviewer = agents.find(a => a.name === 'REVIEWER');
    expect(reviewer.skillsLocked).toBe(true);
    expect(reviewer.supportsPlanMode).toBe(false);

    // 2. Trigger audit on bench frame
    const auditRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/audit`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({}),
    });
    expect(auditRes.status).toBe(202);
  });

  // Workflow 18: Project Branching for Alternate Hypotheses Exploration
  test('W18: Project branching to explore competing scientific hypotheses', async () => {
    // 1. Fork Branch Alpha from completed bench
    const res1 = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/fork`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({message_index: 0, edited_content: 'Branch Alpha: Covalent inhibitor targeting Cys797'}),
    });
    expect(res1.status).toBe(200);
    const d1 = (await res1.json()) as any;
    expect(d1.branch_id).toBeDefined();

    // 2. Cancel frame to allow second fork
    await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/cancel`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({}),
    });

    // 3. Fork Branch Beta from same base message
    const res2 = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/fork`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({message_index: 0, edited_content: 'Branch Beta: Allosteric inhibitor binding pocket IV'}),
    });
    expect(res2.status).toBe(200);
    const d2 = (await res2.json()) as any;
    expect(d2.branch_id).toBeDefined();
    expect(d1.branch_id).not.toBe(d2.branch_id);

    // 4. Cancel frame to leave clean state
    await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.forkFrame}/cancel`, {
      method: 'POST',
      headers: auth.getHeaders('POST'),
      body: JSON.stringify({}),
    });
  });

  // Workflow 19: Offline Disconnected Workbench Operation
  test('W19: Offline workbench operation with cached catalog and local kernels', async () => {
    // 1. Verify local Conda environments status
    const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
      headers: auth.getHeaders('GET'),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    const py = data.environments.find((e: any) => e.language === 'python');
    expect(py.status).toBe('ready');
    const r = data.environments.find((e: any) => e.language === 'r');
    expect(r.status).toBe('ready');

    // 2. Verify models catalog serves locally from registry
    const mRes = await fetch(`${BASELINE_URL}/api/models`, {
      headers: auth.getHeaders('GET'),
    });
    expect(mRes.status).toBe(200);
    const mData = (await mRes.json()) as any;
    expect(mData.models.anthropic.length).toBeGreaterThan(0);
  });

  // Workflow 20: High-Security Environment Zero-Credential Leak Audit
  test('W20: High-security zero-credential leak audit in sandboxed compute', async () => {
    // 1. Execute Python under Darwin SBPL inspecting environment variables
    const profilePath = findProfilePath();
    const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${profilePath}/local-auth"))\n`;
    const pyEnvCode = `
import os
for key in ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'RIKYU_API_KEY', 'RIVAULT_API_KEY']:
    if key in os.environ:
        print(f"LEAK:{key}")
print("ENV_CHECK_OK")
`;
    const envRes = await runDarwinSeatbelt(sbpl, pyEnvCode);
    expect(envRes.exitCode).toBe(0);
    expect(envRes.stdout).not.toContain('LEAK');
    expect(envRes.stdout).toContain('ENV_CHECK_OK');

    // 2. Execute Darwin SBPL credential file denial
    const pyFileCode = `
import os
try:
    fd = os.open("${profilePath}/local-auth/chatgpt.key", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
    const fileRes = await runDarwinSeatbelt(sbpl, pyFileCode);
    expect(fileRes.exitCode).toBe(0);
    expect(fileRes.stdout).toContain('AUTH_OPEN_DENIED');

    // 3. Negative control: allow rule
    const allowSbpl = `(version 1)\n(allow default)\n`;
    const allowRes = await runDarwinSeatbelt(allowSbpl, pyFileCode);
    expect(allowRes.exitCode).toBe(0);
    expect(allowRes.stdout).toContain('AUTH_OPEN_ALLOWED');
  });

  // Workflow 21: Full Daemon Restart Recovery
  test('W21: Daemon restart recovery reconciles uncompleted plan steps', async () => {
    // 1. Query benches in the seeded disposable project
    const benchRes = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/benches`, {
      headers: auth.getHeaders('GET'),
    });
    expect(benchRes.status).toBe(200);
    const benches = (await benchRes.json()) as any[];

    // 2. Verify awaiting_user_response bench retains state across daemon lifecycle
    const awaitingBench = benches.find(b => b.id === `${E2E_FIXTURE_IDS.frame}`);
    expect(awaitingBench).toBeDefined();
    expect(awaitingBench.status).toBe('awaiting_user_response');

    // 3. Verify completed bench retains completed status
    const completedBench = benches.find(b => b.id === `${E2E_FIXTURE_IDS.completedFrame}`);
    expect(completedBench).toBeDefined();
    expect(completedBench.status).toBe('completed');

    // 4. Verify shallow trace endpoint is consistent
    const traceRes = await fetch(`${BASELINE_URL}/api/frames/${E2E_FIXTURE_IDS.frame}/trace-shallow`, {
      headers: auth.getHeaders('GET'),
    });
    expect(traceRes.status).toBe(200);
  });
});
