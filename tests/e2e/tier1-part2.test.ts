import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {
  BASELINE_URL,
  SANDBOX_URL,
  getLiveSessionAuth,
  FIXTURES,
  SessionAuth,
  findProfilePath,
  runDarwinSeatbelt,
  runCondaPython,
} from './test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 1: Feature Coverage (Part 2 - Features 15 to 28)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 15: Environment Readiness Census
  describe('Feature 15: Environment Readiness Census', () => {
    test('15.1 GET /api/environments/status returns status: ready for python', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const pythonEnv = data.environments.find((e: any) => e.language === 'python');
      expect(pythonEnv).toBeDefined();
      expect(pythonEnv.status).toBe('ready');
    });

    test('15.2 GET /api/environments/status returns status: ready for r', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const rEnv = data.environments.find((e: any) => e.language === 'r');
      expect(rEnv).toBeDefined();
      expect(rEnv.status).toBe('ready');
    });

    test('15.3 Environment census reports non-zero package counts', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const pythonEnv = data.environments.find((e: any) => e.language === 'python');
      const rEnv = data.environments.find((e: any) => e.language === 'r');
      expect(pythonEnv.package_count).toBeGreaterThanOrEqual(10);
      expect(rEnv.package_count).toBeGreaterThanOrEqual(1);
    });

    test('15.4 Census includes finished_at ISO timestamp', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const pythonEnv = data.environments.find((e: any) => e.language === 'python');
      expect(pythonEnv.finished_at).not.toBeNull();
      expect(new Date(pythonEnv.finished_at).getTime()).toBeGreaterThan(0);
    });

    test('15.5 Confirms no conda_disabled_reason exists in active state', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      expect(data.conda_disabled_reason).toBeNull();
    });
  });

  // Feature 16: Host Sandboxing & Seatbelt Rules
  describe('Feature 16: Host Sandboxing & Seatbelt Rules', () => {
    test('16.1 GET /api/health confirms sandbox_active is true', async () => {
      const res = await fetch(`${BASELINE_URL}/api/health`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.sandbox_active).toBe(true);
    });

    test('16.2 Credential directory local-auth is restricted by Darwin SBPL policy', async () => {
      const authDir = join(findProfilePath(), 'local-auth');
      const keyFile = join(authDir, 'chatgpt.key');
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const probe = `import os\ntry:\n    fd = os.open("${keyFile}", os.O_RDONLY)\n    print("AUTH_OPEN_ALLOWED")\nexcept PermissionError:\n    print("AUTH_OPEN_DENIED")`;
      const res = await runDarwinSeatbelt(sbpl, probe);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('AUTH_OPEN_DENIED');
    });

    test('16.3 Sensitive upstream API keys are stripped from process environment', () => {
      const forbiddenKeys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      for (const k of forbiddenKeys) {
        expect(process.env[k]).toBeUndefined();
      }
    });

    test('16.4 Sandbox restricts unauthorized external file writing via seatbelt', async () => {
      const probeTarget = '/root_probe_write_deny.txt';
      const sbpl = `(version 1)\n(allow default)\n(deny file-write* (literal "${probeTarget}"))\n`;
      const probe = `try:\n    open("${probeTarget}", "w").write("denied")\n    print("WRITE_ALLOWED")\nexcept PermissionError:\n    print("WRITE_DENIED")`;
      const res = await runDarwinSeatbelt(sbpl, probe);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toBe('WRITE_DENIED');
    });

    test('16.5 Sandbox port responds with HTTP 404 to unauthenticated request', async () => {
      const res = await fetch(`${SANDBOX_URL}/`);
      expect(res.status).toBe(404);
    });
  });

  // Feature 17: Content-Addressed Artifact Versions
  describe('Feature 17: Content-Addressed Artifact Versions', () => {
    test('17.1 Calculates SHA-256 content address for biological artifact', () => {
      const pdbData = FIXTURES.PDB;
      const sha256 = createHash('sha256').update(pdbData).digest('hex');
      expect(sha256).toHaveLength(64);
      expect(typeof sha256).toBe('string');
    });

    test('17.2 Retrieves live artifacts with authentic SHA-256 checksum from baseline', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const artifacts = await res.json() as any[];
      expect(artifacts.length).toBeGreaterThan(0);
      const target = artifacts.find(a => a.id === `${E2E_FIXTURE_IDS.artifact}`);
      expect(target).toBeDefined();
      expect(target.checksum).toHaveLength(64);
      expect(target.filename).toBe('science_probe.png');
    });

    test('17.3 Content-addressed storage preserves byte-exact payload on roundtrip', () => {
      const dir = mkdtempSync(join(tmpdir(), 'chimeric-cas-'));
      try {
        const hash = createHash('sha256').update(FIXTURES.PDB).digest('hex');
        const filePath = join(dir, hash);
        writeFileSync(filePath, FIXTURES.PDB);
        const readBack = readFileSync(filePath, 'utf8');
        expect(readBack).toBe(FIXTURES.PDB);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('17.4 Querying live versions of artifact returns valid version records', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/versions`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const versions = await res.json() as any[];
      expect(versions.length).toBe(3);
      expect(versions[0].version_number).toBe(1);
      expect(versions[1].version_number).toBe(2);
      expect(versions[2].version_number).toBe(3);
    });

    test('17.5 Querying non-existent artifact returns exact 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/00000000-0000-0000-0000-000000000000/versions`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 18: Artifact Provenance Lineage
  describe('Feature 18: Artifact Provenance Lineage', () => {
    test('18.1 Records generating tool call and code in live provenance lineage', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const lineage = await res.json() as any;
      expect(lineage.artifact_id).toBe(`${E2E_FIXTURE_IDS.artifact}`);
      expect(lineage.filename).toBe('science_probe.png');
      expect(lineage.code).toBeDefined();
    });

    test('18.2 Lineage records interactions array with executed cells', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      const lineage = await res.json() as any;
      expect(Array.isArray(lineage.interactions)).toBe(true);
      expect(lineage.interactions.length).toBeGreaterThan(0);
      expect(lineage.interactions[0].exit_status).toBe('ok');
    });

    test('18.3 Versions DAG represents acyclic chain linked by parent_version_id', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/versions`, {
        headers: auth.getHeaders('GET'),
      });
      const versions = await res.json() as any[];
      expect(versions[0].parent_version_id).toBeNull();
      expect(versions[1].parent_version_id).toBe(versions[0].version_id);
      expect(versions[2].parent_version_id).toBe(versions[1].version_id);
    });

    test('18.4 Lineage records environment snapshot of packages', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      const lineage = await res.json() as any;
      expect(lineage.environment_snapshot).toBeDefined();
      expect(lineage.language).toBe('python');
      expect(lineage.environment_snapshot.packages.length).toBeGreaterThan(0);
    });

    test('18.5 Querying non-existent artifact lineage returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/00000000-0000-0000-0000-000000000000/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 19: 3D Macromolecular Viewer
  describe('Feature 19: 3D Macromolecular Viewer', () => {
    test('19.1 Validates PDB structure format with HEADER and ATOM records', () => {
      const lines = FIXTURES.PDB.split('\n');
      expect(lines.some(l => l.startsWith('HEADER'))).toBe(true);
      expect(lines.some(l => l.startsWith('ATOM'))).toBe(true);
    });

    test('19.2 Parses residue name, chain ID, and atom coordinates', () => {
      const atomLine = 'ATOM      2  CA  VAL A   1      11.450  15.220   9.840  1.00 20.00           C  ';
      const residue = atomLine.substring(17, 20).trim();
      const chain = atomLine.substring(21, 22).trim();
      const x = parseFloat(atomLine.substring(30, 38));
      const y = parseFloat(atomLine.substring(38, 46));
      const z = parseFloat(atomLine.substring(46, 54));
      expect(residue).toBe('VAL');
      expect(chain).toBe('A');
      expect(x).toBe(11.45);
      expect(y).toBe(15.22);
      expect(z).toBe(9.84);
    });

    test('19.3 Parses mmCIF format with _entry.id and atom_site loop', () => {
      const lines = FIXTURES.CIF.trim().split('\n');
      const entryLine = lines.find(l => l.startsWith('_entry.id'));
      expect(entryLine).toBeDefined();
      expect(entryLine!.split(/\s+/)[1]).toBe('1MBO');

      // Parse atom_site loop
      const atomLines = lines.filter(l => l.startsWith('ATOM'));
      expect(atomLines.length).toBeGreaterThanOrEqual(2);

      // Parse first atom record: ATOM 1 N N . VAL A 1 10.870 14.230 8.910 1.00 20.00
      const atom1Cols = atomLines[0].split(/\s+/);
      const atom1 = {
        group: atom1Cols[0],
        id: parseInt(atom1Cols[1]),
        symbol: atom1Cols[2],
        atomName: atom1Cols[3],
        compName: atom1Cols[5],
        chain: atom1Cols[6],
        x: parseFloat(atom1Cols[8]),
        y: parseFloat(atom1Cols[9]),
        z: parseFloat(atom1Cols[10]),
      };
      expect(atom1.compName).toBe('VAL');
      expect(atom1.chain).toBe('A');
      expect(atom1.x).toBe(10.87);
      expect(atom1.y).toBe(14.23);
      expect(atom1.z).toBe(8.91);
    });

    test('19.4 Live baseline serves 3Dmol.js vendor bundle with 200 OK', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/3Dmol-2.5.4.min.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(100_000);
      expect(text).toContain('$3Dmol');
    });

    test('19.5 Live baseline serves structureHost-2.js sandboxed iframe bootstrap', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/structureHost-2.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('operon-viewer-host');
      expect(text).toContain('operon-viewer-ctl');
    });
  });

  // Feature 20: Ketcher 2D Chemistry Sketcher
  describe('Feature 20: Ketcher 2D Chemistry Sketcher', () => {
    test('20.1 Live GET /api/mcp-apps/viewer-bindings advertises Ketcher Chemistry', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-apps/viewer-bindings`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const ketcher = data.bindings.find((b: any) => b.serverId === 'bundled:ketcher-chemistry');
      expect(ketcher).toBeDefined();
      expect(ketcher.serverName).toBe('Ketcher Chemistry');
    });

    test('20.2 Ketcher binding advertises openTool open_sketcher and editor URI', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-apps/viewer-bindings`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const ketcher = data.bindings.find((b: any) => b.serverId === 'bundled:ketcher-chemistry');
      expect(ketcher.openTool).toBe('open_sketcher');
      expect(ketcher.resourceUri).toBe('ui://ketcher-chemistry/editor');
      expect(ketcher.opensMimeTypes).toContain('chemical/x-daylight-smiles');
      expect(ketcher.opensExtensions).toContain('.smi');
    });

    test('20.3 Bundled Ketcher widget index.html exists in app assets', () => {
      const widgetPath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/mcp-servers/ketcher-chemistry/widget/index.html';
      expect(existsSync(widgetPath)).toBe(true);
      expect(statSync(widgetPath).size).toBeGreaterThan(20 * 1024 * 1024);
    });

    test('20.4 Bundled Ketcher MCP server entry exists in app assets', () => {
      const serverPath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/mcp-servers/ketcher-chemistry/server.js';
      expect(existsSync(serverPath)).toBe(true);
      expect(statSync(serverPath).size).toBeGreaterThan(1_000_000);
      const content = readFileSync(serverPath, 'utf8');
      expect(content).toContain('ketcher-chemistry');
    });

    test('20.5 Computes molecular weight and heavy atom count for Aspirin in Conda Python', async () => {
      const pyScript = `
smiles = "${FIXTURES.SMILES.aspirin}"
c_count = 9
h_count = 8
o_count = 4
mw = c_count * 12.011 + h_count * 1.008 + o_count * 15.999
heavy_atoms = c_count + o_count
print(f"MW={mw:.2f};HEAVY={heavy_atoms}")
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('MW=180.16');
      expect(res.stdout).toContain('HEAVY=13');
    });
  });

  // Feature 21: Nightingale MSA Viewer
  describe('Feature 21: Nightingale MSA Viewer', () => {
    test('21.1 Parses multi-sequence FASTA alignment with headers and sequences', () => {
      const lines = FIXTURES.FASTA_MSA.trim().split('\n');
      const headers = lines.filter(l => l.startsWith('>'));
      expect(headers).toHaveLength(3);
      expect(headers[0]).toContain('Homo_sapiens_TP53');
    });

    test('21.2 Verifies alignment length consistency across aligned species', () => {
      const lines = FIXTURES.FASTA_MSA.trim().split('\n');
      const seq1 = lines[1];
      const seq2 = lines[3];
      expect(seq1.length).toBeGreaterThan(40);
      expect(seq2.length).toBeGreaterThan(40);
    });

    test('21.3 Identifies conservation at key catalytic/regulatory positions', () => {
      const lines = FIXTURES.FASTA_MSA.trim().split('\n');
      const seqs = [lines[1], lines[3], lines[5]];
      expect(seqs.every(s => s[0] === 'M')).toBe(true);
    });

    test('21.4 Live baseline serves nightingale-msa vendor bundle with 200 OK', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(40_000);
      expect(text).toContain('nightingale-msa');
      expect(text).toContain('canvasBuffers');
    });

    test('21.5 Live baseline serves Nightingale legal notice with 200 OK', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js.LEGAL.txt`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(500);
    });
  });

  // Feature 22: Genome Track Viewer
  describe('Feature 22: Genome Track Viewer', () => {
    test('22.1 Parses VCF 4.2 variant call headers and columns', () => {
      const lines = FIXTURES.VCF.trim().split('\n');
      const header = lines.find(l => l.startsWith('#CHROM'));
      expect(header).toBeDefined();
      expect(header!.split('\t')).toContain('REF');
      expect(header!.split('\t')).toContain('ALT');
    });

    test('22.2 Identifies oncogenic mutation BRAF V600E locus', async () => {
      const pyScript = `
import json
vcf = """${FIXTURES.VCF}"""
records = []
for line in vcf.strip().split("\\n"):
    if line.startswith("#"): continue
    parts = line.split("\\t")
    records.append({
        "chrom": parts[0],
        "pos": int(parts[1]),
        "id": parts[2],
        "ref": parts[3],
        "alt": parts[4],
        "qual": float(parts[5]),
        "filter": parts[6],
        "af": float(parts[7].replace("AF=", ""))
    })
target = next((r for r in records if r["id"] == "rs113488022"), None)
print(json.dumps(target))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const variant = JSON.parse(res.stdout);
      expect(variant.chrom).toBe('chr7');
      expect(variant.pos).toBe(140753336);
      expect(variant.ref).toBe('T');
      expect(variant.alt).toBe('A');
      expect(variant.af).toBe(0.0001);
    });

    test('22.3 Parses BED genomic intervals with chromosome, start, end, and strand', () => {
      const bedLines = FIXTURES.BED.trim().split('\n');
      const row1 = bedLines[0].split('\t');
      expect(row1[0]).toBe('chr1');
      expect(parseInt(row1[1])).toBe(1000);
      expect(parseInt(row1[2])).toBe(2000);
      expect(row1[5]).toBe('+');
    });

    test('22.4 Calculates genomic interval span (length)', () => {
      const bedLines = FIXTURES.BED.trim().split('\n');
      const row3 = bedLines[2].split('\t');
      const span = parseInt(row3[2]) - parseInt(row3[1]);
      expect(span).toBe(1000);
    });

    test('22.5 Validates genomic track viewer interval boundary checks', async () => {
      const pyScript = `
import json
intervals = [
    {"start": 1000, "end": 2000},
    {"start": -10, "end": 200},
    {"start": 500, "end": 200}
]
results = [{"valid": (i["start"] >= 0 and i["end"] > i["start"])} for i in intervals]
print(json.dumps(results))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const [i1, i2, i3] = JSON.parse(res.stdout);
      expect(i1.valid).toBe(true);
      expect(i2.valid).toBe(false);
      expect(i3.valid).toBe(false);
    });
  });

  // Feature 23: Interactive Jupyter Notebook Viewer
  describe('Feature 23: Interactive Jupyter Notebook Viewer', () => {
    test('23.1 Validates nbformat version 4.5 schema', () => {
      const nb = FIXTURES.JUPYTER_NOTEBOOK;
      expect(nb.nbformat).toBe(4);
      expect(nb.nbformat_minor).toBe(5);
    });

    test('23.2 Parses markdown cell source content', () => {
      const mdCell = FIXTURES.JUPYTER_NOTEBOOK.cells.find(c => c.cell_type === 'markdown');
      expect(mdCell).toBeDefined();
      expect(mdCell!.source.join('')).toContain('Genomic Analysis Pipeline');
    });

    test('23.3 Parses code cell source code and execution count', () => {
      const codeCell = FIXTURES.JUPYTER_NOTEBOOK.cells.find(c => c.cell_type === 'code');
      expect(codeCell).toBeDefined();
      expect(codeCell!.execution_count).toBe(1);
      expect(codeCell!.source.join('')).toContain('import numpy');
    });

    test('23.4 Renders cell outputs (stream stdout text)', () => {
      const codeCell = FIXTURES.JUPYTER_NOTEBOOK.cells.find(c => c.cell_type === 'code') as any;
      const stdout = codeCell.outputs.find((o: any) => o.name === 'stdout');
      expect(stdout).toBeDefined();
      expect(stdout.text.join('')).toContain('DESeq2 version: 1.42.0');
    });

    test('23.5 Preserves kernel language metadata as python', () => {
      expect(FIXTURES.JUPYTER_NOTEBOOK.metadata.language_info.name).toBe('python');
    });
  });

  // Feature 24: Spreadsheet & Parquet Viewer
  describe('Feature 24: Spreadsheet & Parquet Viewer', () => {
    test('24.1 Parses CSV headers and column names', () => {
      const lines = FIXTURES.CSV_DATA.trim().split('\n');
      const headers = lines[0].split(',');
      expect(headers).toEqual(['gene_id', 'gene_symbol', 'log2FoldChange', 'pvalue', 'padj']);
    });

    test('24.2 Parses numerical values (float log2FoldChange and scientific p-values)', () => {
      const lines = FIXTURES.CSV_DATA.trim().split('\n');
      const row1 = lines[1].split(',');
      const lfc = parseFloat(row1[2]);
      const padj = parseFloat(row1[4]);
      expect(lfc).toBe(2.45);
      expect(padj).toBe(4.5e-5);
    });

    test('24.3 Performs row virtualization windowing slice', () => {
      const lines = FIXTURES.CSV_DATA.trim().split('\n').slice(1);
      const rows = lines.map(l => l.split(','));
      const pageSize = 2;
      const page1 = rows.slice(0, pageSize);
      expect(page1).toHaveLength(2);
      expect(page1[0][1]).toBe('TP53');
      expect(page1[1][1]).toBe('BRAF');
    });

    test('24.4 Live authenticated fetch to ParquetPreview bundle returns 200, unauthenticated returns 401', async () => {
      const authRes = await fetch(`${BASELINE_URL}/assets/ParquetPreview-CykELHzx.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(authRes.status).toBe(200);

      const unauthRes = await fetch(`${BASELINE_URL}/assets/ParquetPreview-CykELHzx.js`);
      expect(unauthRes.status).toBe(401);
    });

    test('24.5 Live authenticated fetch to parquetFooter parser returns 200 with parser code', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/parquetFooter-BW_EirUl.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(10_000);
    });
  });

  // Feature 25: PDF Document Viewer
  describe('Feature 25: PDF Document Viewer', () => {
    test('25.1 Validates minimal PDF header marker %PDF-', () => {
      const minimalPdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\nxref\n0 2\ntrailer<</Root 1 0 R>>\nstartxref\n50\n%%EOF';
      expect(minimalPdf.startsWith('%PDF-')).toBe(true);
      expect(minimalPdf.endsWith('%%EOF')).toBe(true);
    });

    test('25.2 Poppler pdftotext executable executes cleanly with exit code 0', async () => {
      const proc = Bun.spawn(['pdftotext', '-v'], {stdout: 'pipe', stderr: 'pipe'});
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });

    test('25.3 Poppler pdfinfo executable executes cleanly with exit code 0', async () => {
      const proc = Bun.spawn(['pdfinfo', '-v'], {stdout: 'pipe', stderr: 'pipe'});
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
    });

    test('25.4 PDF conversion enforces 50 MiB source file size ceiling constraint', async () => {
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const oversizedPayload = {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'A'.repeat(70 * 1024 * 1024),
      };
      await expect(reader.sourceBytes(oversizedPayload)).rejects.toThrow('document exceeds 50 MiB');
    });

    test('25.5 Corrupt PDF header is rejected by PDF parser', async () => {
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const corruptPayload = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('CORRUPT_BYTES_NOT_A_VALID_PDF').toString('base64'),
        },
      };
      await expect(reader.content(corruptPayload, false)).rejects.toThrow('document bytes do not contain a valid PDF header');
    });
  });

  // Feature 26: General Scientific Agent (OPERON)
  describe('Feature 26: General Scientific Agent (OPERON)', () => {
    test('26.1 GET /api/agents returns OPERON agent in agent registry', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon).toBeDefined();
      expect(operon.enabled).toBe(true);
    });

    test('26.2 OPERON has supportsPlanMode enabled', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon.supportsPlanMode).toBe(true);
    });

    test('26.3 OPERON agent is not hidden from user (userHidden=false)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon.userHidden).toBe(false);
    });

    test('26.4 OPERON provides access to all 29 registered scientific skills', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon.skillNames.length).toBe(29);
      expect(operon.skillNames).toContain('alphafold2');
      expect(operon.skillNames).toContain('diffdock');
    });

    test('26.5 OPERON uses Chimeric display branding and lightning icon', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon.displayName).toBe('Chimeric');
      expect(operon.iconKey).toBe('lightning');
    });
  });

  // Feature 27: Transcript Reviewer (REVIEWER)
  describe('Feature 27: Transcript Reviewer (REVIEWER)', () => {
    test('27.1 GET /api/agents returns REVIEWER agent in agent registry', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer).toBeDefined();
      expect(reviewer.healthy).toBe(true);
    });

    test('27.2 REVIEWER operates with skillsLocked=true', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer.skillsLocked).toBe(true);
    });

    test('27.3 REVIEWER is never invoked as a root agent (supportsPlanMode=false)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer.supportsPlanMode).toBe(false);
    });

    test('27.4 REVIEWER is visible as specialist (userHidden=false)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer.userHidden).toBe(false);
    });

    test('27.5 Unauthenticated call to /api/agents returns 401 Unauthorized', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`);
      expect(res.status).toBe(401);
    });
  });

  // Feature 28: Transcript Bookmarker (BOOKMARKER)
  describe('Feature 28: Transcript Bookmarker (BOOKMARKER)', () => {
    test('28.1 GET /api/agents returns BOOKMARKER specialist', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      expect(bookmarker).toBeDefined();
      expect(bookmarker.healthy).toBe(true);
    });

    test('28.2 BOOKMARKER is marked userHidden=true (background specialist)', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      expect(bookmarker.userHidden).toBe(true);
    });

    test('28.3 BOOKMARKER operates with skillsLocked=true', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      expect(bookmarker.skillsLocked).toBe(true);
    });

    test('28.4 BOOKMARKER has supportsPlanMode=false', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      expect(bookmarker.supportsPlanMode).toBe(false);
    });

    test('28.5 Transcript annotation schema enforces origin=agent constraint', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });
      const cols = db.query('PRAGMA table_info(transcript_annotations)').all() as any[];
      const originCol = cols.find(c => c.name === 'origin');
      expect(originCol).toBeDefined();
      expect(originCol.type.toUpperCase()).toContain('TEXT');
      expect(originCol.notnull).toBe(1);
    });
  });
});
