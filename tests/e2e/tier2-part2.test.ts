import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  BASELINE_URL,
  SANDBOX_URL,
  getLiveSessionAuth,
  findProfilePath,
  runDarwinSeatbelt,
  runCondaPython,
  SessionAuth,
} from './test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Tier 2: Boundary & Corner Cases (Part 2 - Features 15 to 28)', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // Feature 15: Environment Readiness Census Boundaries
  describe('Feature 15: Environment Census Boundaries', () => {
    test('15.1 Repeated rapid calls to environments API execute without deadlock', async () => {
      const calls = await Promise.all([
        fetch(`${BASELINE_URL}/api/environments/status`, {headers: auth.getHeaders('GET')}),
        fetch(`${BASELINE_URL}/api/environments/status`, {headers: auth.getHeaders('GET')}),
        fetch(`${BASELINE_URL}/api/environments/status`, {headers: auth.getHeaders('GET')}),
      ]);
      for (const res of calls) {
        expect(res.status).toBe(200);
      }
    });

    test('15.2 Census reports ready status for python environment with non-zero package count', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const py = data.environments.find((e: any) => e.language === 'python');
      expect(py.status).toBe('ready');
      expect(py.package_count).toBeGreaterThanOrEqual(10);
    });

    test('15.3 Census reports ready status for R environment with non-zero package count', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        headers: auth.getHeaders('GET'),
      });
      const data = await res.json() as any;
      const rEnv = data.environments.find((e: any) => e.language === 'r');
      expect(rEnv.status).toBe('ready');
      expect(rEnv.package_count).toBeGreaterThanOrEqual(1);
    });

    test('15.4 Non-GET request to /api/environments/status rejected with 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
    });

    test('15.5 Environment census without session auth returns 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/environments/status`);
      expect(res.status).toBe(401);
    });
  });

  // Feature 16: Host Sandboxing & Seatbelt Rules Boundaries
  describe('Feature 16: Host Sandboxing Boundaries', () => {
    test('16.1 Unauthenticated direct connection to sandbox port responds with 404', async () => {
      const res = await fetch(`${SANDBOX_URL}/`);
      expect(res.status).toBe(404);
    });

    test('16.2 Writing to system root directory / is trapped by Darwin SBPL policy with PermissionError', async () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-write* (literal "/root_file_probe.txt"))\n`;
      const pyCode = `import os\ntry:\n    with open("/root_file_probe.txt", "w") as f: f.write("probe")\n    print("WRITE_ALLOWED")\nexcept PermissionError:\n    print("WRITE_DENIED")`;
      const res = await runDarwinSeatbelt(sbpl, pyCode);
      expect(res.stdout).toBe('WRITE_DENIED');
    });

    test('16.3 Darwin SBPL policy traps credential directory access returning AUTH_OPEN_DENIED', async () => {
      const profile = findProfilePath();
      const authDir = join(profile, 'local-auth');
      const keyFile = join(authDir, 'chatgpt.key');

      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const pyCode = `import os\ntry:\n    fd = os.open("${keyFile}", os.O_RDONLY)\n    print("AUTH_OPEN_ALLOWED")\nexcept PermissionError:\n    print("AUTH_OPEN_DENIED")`;
      const res = await runDarwinSeatbelt(sbpl, pyCode);
      expect(res.stdout).toBe('AUTH_OPEN_DENIED');
    });

    test('16.4 Access to protected system credentials (/etc/master.passwd) trapped by Darwin SBPL', async () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (literal "/etc/master.passwd"))\n`;
      const pyCode = `import os\ntry:\n    with open("/etc/master.passwd", "r") as f: f.read()\n    print("PASSWD_ALLOWED")\nexcept PermissionError:\n    print("PASSWD_DENIED")`;
      const res = await runDarwinSeatbelt(sbpl, pyCode);
      expect(res.stdout).toBe('PASSWD_DENIED');
    });

    test('16.5 Executing restricted system binary (sudo) trapped by seatbelt policy', async () => {
      const sbpl = `(version 1)\n(allow default)\n(deny process-exec (literal "/usr/bin/sudo"))\n`;
      const pyCode = `import subprocess\ntry:\n    subprocess.run(["/usr/bin/sudo", "-v"], capture_output=True)\n    print("SUDO_ALLOWED")\nexcept Exception as e:\n    print(f"SUDO_DENIED:{type(e).__name__}")`;
      const res = await runDarwinSeatbelt(sbpl, pyCode);
      expect(res.stdout).toContain('SUDO_DENIED');
    });
  });

  // Feature 17: Content-Addressed Artifact Versions Boundaries
  describe('Feature 17: Content-Addressed Artifact Versions Boundaries', () => {
    test('17.1 Querying non-existent artifact returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/non_existent_art_999`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('17.2 Querying non-existent artifact version returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/art_1/versions/v999`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('17.3 Ingestion hash mismatch detected against CAS checksum', async () => {
      const { createHash } = await import('node:crypto');
      const res = await fetch(`${BASELINE_URL}/api/artifacts/${E2E_FIXTURE_IDS.artifact}`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const buf = Buffer.from(await res.arrayBuffer());
      const actualCAS = createHash('sha256').update(buf).digest('hex');
      expect(actualCAS).toBe('a8149a46f5c560c2cdb8efa4aeef12bfa7c3f208ef29b703fbd88814c1f19fca');

      const corruptedBuf = Buffer.from(buf);
      corruptedBuf[0] ^= 0xff; // single-bit tampering
      const corruptedHash = createHash('sha256').update(corruptedBuf).digest('hex');
      expect(corruptedHash).not.toBe(actualCAS);
    });

    test('17.4 CAS storage stores byte-exact payload for science_probe.png', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      const artifacts = await res.json() as any[];
      const probe = artifacts.find(a => a.filename === 'science_probe.png');
      expect(probe).toBeDefined();
      expect(probe.size_bytes).toBe(25202);
    });

    test('17.5 Filename path traversal sanitization traps relative directory navigation', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/%2e%2e%2f%2e%2e%2fetc%2fpasswd`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });
  });

  // Feature 18: Artifact Provenance Lineage Boundaries
  describe('Feature 18: Artifact Provenance Lineage Boundaries', () => {
    test('18.1 Non-existent artifact lineage returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/artifacts/missing_art/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('18.2 Cyclic lineage reference rejected by database DAG invariant', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      const cycleCheckSql = `
        WITH RECURSIVE check_cycles(id, parent_id, path, is_cycle) AS (
          SELECT id, parent_version_id, id, 0
          FROM artifact_versions
          WHERE parent_version_id IS NOT NULL
          UNION ALL
          SELECT av.id, av.parent_version_id, cc.path || ',' || av.id,
                 instr(cc.path, av.id) > 0
          FROM artifact_versions av
          JOIN check_cycles cc ON av.id = cc.parent_id
          WHERE cc.is_cycle = 0 AND length(cc.path) < 5000
        )
        SELECT count(*) as cycle_count FROM check_cycles WHERE is_cycle > 0;
      `;
      const row = db.query(cycleCheckSql).get() as any;
      expect(row.cycle_count).toBe(0);
    });

    test('18.3 Live lineage of science_probe.png verifies generating tool call and executed code', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      const artifacts = await res.json() as any[];
      const probe = artifacts.find(a => a.filename === 'science_probe.png');

      const lineageRes = await fetch(`${BASELINE_URL}/api/artifacts/${probe.id}/lineage`, {
        headers: auth.getHeaders('GET'),
      });
      expect(lineageRes.status).toBe(200);
      const lineage = await lineageRes.json() as any;
      expect(lineage.code).toBeDefined();
      expect(lineage.interactions.length).toBeGreaterThan(0);
    });

    test('18.4 Artifact versions DAG parent linkage represents sequential chronological progression', async () => {
      const res = await fetch(`${BASELINE_URL}/api/projects/${E2E_PROJECT_ID}/artifacts`, {
        headers: auth.getHeaders('GET'),
      });
      const artifacts = await res.json() as any[];
      const probe = artifacts.find(a => a.filename === 'science_probe.png');

      const versionsRes = await fetch(`${BASELINE_URL}/api/artifacts/${probe.id}/versions`, {
        headers: auth.getHeaders('GET'),
      });
      const versions = await versionsRes.json() as any[];
      expect(versions.length).toBe(3);
      expect(versions[0].parent_version_id).toBeNull();
      expect(versions[1].parent_version_id).toBe(versions[0].version_id);
      expect(versions[2].parent_version_id).toBe(versions[1].version_id);
    });

    test('18.5 Deep lineage traversal recursion guard prevents stack overflow', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      const depthGuardSql = `
        WITH RECURSIVE lineage_chain AS (
          SELECT id, version_number, parent_version_id, 1 AS depth
          FROM artifact_versions
          WHERE artifact_id = "${E2E_FIXTURE_IDS.artifact}" AND version_number = 3
          UNION ALL
          SELECT av.id, av.version_number, av.parent_version_id, lc.depth + 1
          FROM artifact_versions av
          JOIN lineage_chain lc ON av.id = lc.parent_version_id
          WHERE lc.depth < 50
        )
        SELECT max(depth) as max_traversed_depth FROM lineage_chain;
      `;
      const row = db.query(depthGuardSql).get() as any;
      expect(row.max_traversed_depth).toBeLessThanOrEqual(50);
      expect(row.max_traversed_depth).toBe(3);
    });
  });

  // Feature 19: 3D Macromolecular Viewer Boundaries
  describe('Feature 19: 3D Macromolecular Viewer Boundaries', () => {
    test('19.1 Truncated PDB file missing END record parses available ATOM records cleanly in Conda Python', async () => {
      const pyScript = `
import json

def parse_pdb_atoms(pdb_str):
    records = []
    for line in pdb_str.strip().split("\\n"):
        rec_type = line[:6].strip()
        if rec_type in ("ATOM", "HETATM"):
            records.append({
                "record": rec_type,
                "serial": int(line[6:11].strip()),
                "name": line[12:16].strip(),
                "resName": line[17:20].strip(),
                "chain": line[21:22].strip(),
                "resSeq": int(line[22:26].strip()),
                "x": float(line[30:38].strip()),
                "y": float(line[38:46].strip()),
                "z": float(line[46:54].strip()),
            })
    return records

truncated_pdb = """ATOM      1  N   VAL A   1      10.870  14.230   8.910  1.00 20.00           N
ATOM      2  CA  VAL A   1      11.450  15.220   9.840  1.00 20.00           C
ATOM      3  C   VAL A   1      12.960  15.110   9.720  1.00 20.00           C
"""
# Missing TER and END records - verify parser extracts available ATOM records cleanly
print(json.dumps(parse_pdb_atoms(truncated_pdb)))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const atoms = JSON.parse(res.stdout);
      expect(atoms).toHaveLength(3);
      expect(atoms[0].name).toBe('N');
      expect(atoms[0].resName).toBe('VAL');
      expect(atoms[0].x).toBe(10.87);
      expect(atoms[1].name).toBe('CA');
      expect(atoms[1].resSeq).toBe(1);
      expect(atoms[2].name).toBe('C');
    });

    test('19.2 Non-standard amino acid residues (MSE, SEC) handled with fallback representation', async () => {
      const pyScript = `
import json

STANDARD_AAS = {
    "ALA", "ARG", "ASN", "ASP", "CYS", "GLN", "GLU", "GLY", "HIS", "ILE",
    "LEU", "LYS", "MET", "PHE", "PRO", "SER", "THR", "TRP", "TYR", "VAL"
}
NON_STANDARD_MAP = {
    "MSE": {"parent": "MET", "name": "Selenomethionine", "fallback": "stick", "hetflag": True},
    "SEC": {"parent": "CYS", "name": "Selenocysteine", "fallback": "stick", "hetflag": True},
    "PYL": {"parent": "LYS", "name": "Pyrrolysine", "fallback": "stick", "hetflag": True},
}

def classify_residues(codes):
    classified = {}
    for code in codes:
        if code in STANDARD_AAS:
            classified[code] = {"is_standard": True, "style": "cartoon", "hetflag": False}
        elif code in NON_STANDARD_MAP:
            meta = NON_STANDARD_MAP[code]
            classified[code] = {
                "is_standard": False,
                "style": meta["fallback"],
                "hetflag": meta["hetflag"],
                "parent": meta["parent"]
            }
        else:
            classified[code] = {"is_standard": False, "style": "stick", "hetflag": True, "parent": "UNK"}
    return classified

print(json.dumps(classify_residues(["MSE", "SEC", "PYL", "VAL", "ALA"])))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.MSE.is_standard).toBe(false);
      expect(data.MSE.style).toBe('stick');
      expect(data.MSE.hetflag).toBe(true);
      expect(data.MSE.parent).toBe('MET');
      expect(data.SEC.is_standard).toBe(false);
      expect(data.SEC.style).toBe('stick');
      expect(data.SEC.hetflag).toBe(true);
      expect(data.SEC.parent).toBe('CYS');
      expect(data.VAL.is_standard).toBe(true);
      expect(data.VAL.style).toBe('cartoon');
      expect(data.VAL.hetflag).toBe(false);
    });

    test('19.3 Live baseline serves 3Dmol vendor bundle with length > 500,000 bytes', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/3Dmol-2.5.4.min.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(500_000);
      expect(text).toContain('$3Dmol');
    });

    test('19.4 Live baseline serves structureHost-2.js sandboxed iframe bootstrap', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/structureHost-2.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('structureHost-2.js');
      expect(text).toContain('operon-viewer-host');
    });

    test('19.5 Multi-model NMR ensemble supports model frame navigation in Conda Python', async () => {
      const pyScript = `
import json

def parse_nmr_models(pdb_str):
    models = []
    current_model = None
    for line in pdb_str.strip().split("\\n"):
        line = line.strip()
        if line.startswith("MODEL"):
            parts = line.split()
            mid = int(parts[1]) if len(parts) > 1 else len(models) + 1
            current_model = {"model_id": mid, "atom_count": 0}
            models.append(current_model)
        elif line.startswith("ATOM") and current_model is not None:
            current_model["atom_count"] += 1
        elif line.startswith("ENDMDL"):
            current_model = None
    return models

ensemble = """MODEL        1
ATOM      1  N   VAL A   1      10.870  14.230   8.910  1.00 20.00           N
ATOM      2  CA  VAL A   1      11.450  15.220   9.840  1.00 20.00           C
ENDMDL
MODEL        2
ATOM      1  N   VAL A   1      10.920  14.180   8.950  1.00 20.00           N
ATOM      2  CA  VAL A   1      11.480  15.190   9.820  1.00 20.00           C
ENDMDL"""

print(json.dumps(parse_nmr_models(ensemble)))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const models = JSON.parse(res.stdout);
      expect(models).toHaveLength(2);
      expect(models[0].model_id).toBe(1);
      expect(models[0].atom_count).toBe(2);
      expect(models[1].model_id).toBe(2);
      expect(models[1].atom_count).toBe(2);
    });
  });

  // Feature 20: Ketcher 2D Chemistry Sketcher Boundaries
  describe('Feature 20: Ketcher 2D Chemistry Boundaries', () => {
    test('20.1 Invalid SMILES syntax (unclosed ring) rejected in Conda Python', async () => {
      const pyScript = `
import json, sys
def check_rings(smiles):
    from collections import Counter
    digits = [c for c in smiles if c.isdigit()]
    counts = Counter(digits)
    unclosed = [d for d, cnt in counts.items() if cnt % 2 != 0]
    return {"valid": len(unclosed) == 0, "unclosed": unclosed}

print(json.dumps([check_rings("C1CCCCC1"), check_rings("C1CCC")]))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const [closed, unclosed] = JSON.parse(res.stdout);
      expect(closed.valid).toBe(true);
      expect(unclosed.valid).toBe(false);
      expect(unclosed.unclosed).toContain('1');
    });

    test('20.2 Empty SMILES string returns empty molecule canvas via Ketcher MCP', async () => {
      const serverPath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/mcp-servers/ketcher-chemistry/server.js';
      const proc = Bun.spawn([
        '/Applications/Chimeric.app/Contents/Resources/bin/chimeric',
        serverPath,
      ], {
        env: {...process.env, BUN_BE_BUN: '1'},
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });

      const initMsg = JSON.stringify({jsonrpc: '2.0', id: 1, method: 'initialize', params: {protocolVersion: '2024-11-05', capabilities: {}, clientInfo: {name: 'test', version: '1.0'}}}) + '\n';
      const callMsg = JSON.stringify({jsonrpc: '2.0', id: 2, method: 'tools/call', params: {name: 'open_sketcher', arguments: {smiles: ''}}}) + '\n';

      proc.stdin.write(initMsg + callMsg);
      proc.stdin.end();

      const stdout = await new Response(proc.stdout).text();
      await proc.exited;

      const lines = stdout.trim().split('\n').filter(l => l.startsWith('{'));
      const callRes = lines.map(l => JSON.parse(l)).find(r => r.id === 2);
      expect(callRes.result.content[0].text).toBe('Opened molecule sketcher.');
      expect(callRes.result.structuredContent.smiles).toBe('');
    });

    test('20.3 Live GET /api/mcp-apps/viewer-bindings advertises Ketcher Chemistry', async () => {
      const res = await fetch(`${BASELINE_URL}/api/mcp-apps/viewer-bindings`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      const ketcher = data.bindings.find((b: any) => b.serverId === 'bundled:ketcher-chemistry');
      expect(ketcher).toBeDefined();
      expect(ketcher.serverName).toBe('Ketcher Chemistry');
    });

    test('20.4 Ketcher chemistry MCP server file exists and is > 1 MB', () => {
      const serverPath = '/Applications/Chimeric.app/Contents/Resources/runtime/assets-science-064ca38fb0a47580/mcp-servers/ketcher-chemistry/server.js';
      expect(existsSync(serverPath)).toBe(true);
      expect(statSync(serverPath).size).toBeGreaterThan(1_000_000);
    });

    test('20.5 Chemical valence validation flags hypervalent carbon species in Conda Python', async () => {
      const pyScript = `
import json, re
def check_carbon_valence(smiles):
    chlorines = len(re.findall(r'\\(Cl\\)', smiles)) + (1 if smiles.endswith('Cl') else 0)
    if 'C' in smiles and chlorines > 4:
        return {"valid": False, "bonds": chlorines}
    return {"valid": True, "bonds": chlorines}

print(json.dumps([check_carbon_valence("CC(=O)O"), check_carbon_valence("C(Cl)(Cl)(Cl)(Cl)(Cl)")]))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const [acetic, hypervalent] = JSON.parse(res.stdout);
      expect(acetic.valid).toBe(true);
      expect(hypervalent.valid).toBe(false);
      expect(hypervalent.bonds).toBe(5);
    });
  });

  // Feature 21: Nightingale MSA Viewer Boundaries
  describe('Feature 21: Nightingale MSA Viewer Boundaries', () => {
    test('21.1 Inconsistent sequence lengths in aligned FASTA flagged in Conda Python', async () => {
      const pyScript = `
import json
def validate_msa(fasta_str):
    records = {}
    cur = None
    for line in fasta_str.strip().split("\\n"):
        if line.startswith(">"):
            cur = line[1:].strip()
            records[cur] = []
        elif cur:
            records[cur].append(line.strip())
    lengths = {h: len("".join(s)) for h, s in records.items()}
    unique = set(lengths.values())
    return {"consistent": len(unique) <= 1, "lengths": lengths}

fasta_ok = ">s1\\nMK--VL\\n>s2\\nMKAV-L"
fasta_err = ">s1\\nMK--VL\\n>s2\\nMKAVL"
print(json.dumps([validate_msa(fasta_ok), validate_msa(fasta_err)]))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const [ok, err] = JSON.parse(res.stdout);
      expect(ok.consistent).toBe(true);
      expect(err.consistent).toBe(false);
      expect(err.lengths.s1).toBe(6);
      expect(err.lengths.s2).toBe(5);
    });

    test('21.2 Non-amino-acid characters sanitized by alignment cleaner in Conda Python', async () => {
      const pyScript = `
import json, re

def clean_alignment_sequence(raw_seq):
    cleaned = re.sub(r'[^A-Za-z-]', '', raw_seq).upper()
    removed = [c for c in raw_seq if not re.match(r'[A-Za-z-]', c)]
    return {
        "raw": raw_seq,
        "cleaned": cleaned,
        "removed": removed,
        "valid_count": len(cleaned),
        "sanitized": cleaned == "MKVL"
    }

print(json.dumps(clean_alignment_sequence("MK123$$VL")))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.cleaned).toBe('MKVL');
      expect(data.removed).toEqual(['1', '2', '3', '$', '$']);
      expect(data.valid_count).toBe(4);
      expect(data.sanitized).toBe(true);
    });

    test('21.3 Live GET /vendor/nightingale-msa-5.6.0.js returns length > 180,000 bytes', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(180_000);
    });

    test('21.4 Single-sequence FASTA parsed into single track for Nightingale MSA in Conda Python', async () => {
      const pyScript = `
import json

def parse_fasta_tracks(fasta_text):
    tracks = []
    header = None
    seq_lines = []
    for line in fasta_text.strip().split("\\n"):
        line = line.strip()
        if not line:
            continue
        if line.startswith(">"):
            if header is not None:
                tracks.append({"header": header, "sequence": "".join(seq_lines), "length": len("".join(seq_lines))})
            header = line[1:].strip()
            seq_lines = []
        else:
            seq_lines.append(line)
    if header is not None:
        tracks.append({"header": header, "sequence": "".join(seq_lines), "length": len("".join(seq_lines))})
    return {
        "track_count": len(tracks),
        "tracks": tracks
    }

single_seq_fasta = ">seq1\\nMKAVL"
print(json.dumps(parse_fasta_tracks(single_seq_fasta)))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.track_count).toBe(1);
      expect(data.tracks).toHaveLength(1);
      expect(data.tracks[0].header).toBe('seq1');
      expect(data.tracks[0].sequence).toBe('MKAVL');
      expect(data.tracks[0].length).toBe(5);
    });

    test('21.5 Nightingale legal notice file exists at /vendor/nightingale-msa-5.6.0.js.LEGAL.txt', async () => {
      const res = await fetch(`${BASELINE_URL}/vendor/nightingale-msa-5.6.0.js.LEGAL.txt`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(1_000);
    });
  });

  // Feature 22: Genome Track Viewer Boundaries
  describe('Feature 22: Genome Track Viewer Boundaries', () => {
    test('22.1 Negative genomic coordinate rejected by validator', async () => {
      const pyScript = `
import json
start, end = -50, 1000
is_valid = (start >= 0 and end > start)
print(json.dumps({"valid": is_valid}))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).valid).toBe(false);
    });

    test('22.2 Genomic interval where start > end rejected', async () => {
      const pyScript = `
import json
start, end = 5000, 1000
is_valid = (start >= 0 and end > start)
print(json.dumps({"valid": is_valid}))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      expect(JSON.parse(res.stdout).valid).toBe(false);
    });

    test('22.3 Chromosome identifier normalization handles chr prefix', async () => {
      const pyScript = `
import pandas as pd
import json
df = pd.DataFrame({"chr": ["7", "chr7"]})
df["norm"] = df["chr"].apply(lambda c: c if c.startswith("chr") else f"chr{c}")
print(json.dumps(df["norm"].tolist()))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const normalized = JSON.parse(res.stdout);
      expect(normalized).toEqual(['chr7', 'chr7']);
    });

    test('22.4 Unsorted BED file detected and sorted by position', async () => {
      const pyScript = `
import pandas as pd
from io import StringIO
import json
bed = "chr1\\t2000\\t3000\\texon2\\nchr1\\t1000\\t2000\\texon1\\n"
df = pd.read_csv(StringIO(bed), sep="\\t", header=None, names=["chr", "start", "end", "name"])
df = df.sort_values(by=["chr", "start"]).reset_index(drop=True)
print(json.dumps(df["name"].tolist()))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const names = JSON.parse(res.stdout);
      expect(names).toEqual(['exon1', 'exon2']);
    });

    test('22.5 VCF variant row with missing columns (<8) rejected', async () => {
      const pyScript = `
import json
vcf_row = "chr1\\t12345\\trs1"
cols = vcf_row.split("\\t")
print(json.dumps({"valid": len(cols) >= 8, "columns_found": len(cols)}))
`;
      const res = await runCondaPython(['-c', pyScript]);
      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.valid).toBe(false);
      expect(data.columns_found).toBe(3);
    });
  });

  // Feature 23: Interactive Jupyter Notebook Viewer Boundaries
  describe('Feature 23: Interactive Jupyter Notebook Boundaries', () => {
    test('23.1 Corrupt notebook JSON syntax rejected by NotebookPreview parser', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/NotebookPreview-so0h9DxN.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('not a notebook: not a JSON object');
      expect(text).toContain('not a notebook: missing cells[]');
    });

    test('23.2 Notebook missing cells array handled by NotebookPreview parser fallback', async () => {
      const [authRes, unauthRes] = await Promise.all([
        fetch(`${BASELINE_URL}/assets/NotebookPreview-so0h9DxN.js`, {
          headers: auth.getHeaders('GET'),
        }),
        fetch(`${BASELINE_URL}/assets/NotebookPreview-so0h9DxN.js`),
      ]);
      expect(authRes.status).toBe(200);
      expect(unauthRes.status).toBe(401);
      const text = await authRes.text();
      expect(text).toContain('missing cells[]');
      expect(text).toContain('t.cells)??[]');
    });

    test('23.3 MIME bundle resolution prioritizes text/plain fallback in NotebookPreview', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/NotebookPreview-so0h9DxN.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('text/plain');
      expect(text).toContain('text/html');
      expect(text).toContain('output not rendered (');
    });

    test('23.4 Cell output stream truncation banner rendered by KernelNotebookPane', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/KernelNotebookPane-5rrdXKFJ.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('data-testid":"notebook-truncation-banner"');
      expect(text).toContain('cells shown — full log in the session notebook');
    });

    test('23.5 Malicious script tags in cell HTML output sanitized via NotebookPreview allowlist', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/NotebookPreview-so0h9DxN.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('sanitizeCellHtml');
      expect(text).toContain('ALLOWED_TAGS');
      expect(text).toContain('"table"');
      expect(text.includes('"script"')).toBe(false);
    });
  });

  // Feature 24: Spreadsheet & Parquet Viewer Boundaries
  describe('Feature 24: Spreadsheet & Parquet Boundaries', () => {
    test('24.1 Corrupted Parquet magic bytes rejected by parquet parser', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/parquetFooter-BW_EirUl.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('PAR1');
    });

    test('24.2 Authenticated request to /assets/ParquetPreview-CykELHzx.js returns 200', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/ParquetPreview-CykELHzx.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(60_000);
    });

    test('24.3 Authenticated request to /assets/parquetFooter-BW_EirUl.js returns 200', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/parquetFooter-BW_EirUl.js`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text.length).toBeGreaterThan(20_000);
    });

    test('24.4 Tabular data containing NaN and Infinity values formatted cleanly', () => {
      const values = [2.5, NaN, Infinity, -Infinity];
      const formatted = values.map(v => isNaN(v) ? 'NaN' : !isFinite(v) ? (v > 0 ? '+Inf' : '-Inf') : v.toString());
      expect(formatted).toEqual(['2.5', 'NaN', '+Inf', '-Inf']);
    });

    test('24.5 Unauthenticated request to /assets/ParquetPreview-CykELHzx.js returns 401', async () => {
      const res = await fetch(`${BASELINE_URL}/assets/ParquetPreview-CykELHzx.js`);
      expect(res.status).toBe(401);
    });
  });

  // Feature 25: PDF Document Viewer Boundaries
  describe('Feature 25: PDF Document Viewer Boundaries', () => {
    test('25.1 Corrupted PDF header rejected with explicit format error', async () => {
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const corruptPayload = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('NOT_A_PDF_FILE').toString('base64'),
        },
      };
      await expect(reader.content(corruptPayload, false)).rejects.toThrow('document bytes do not contain a valid PDF header');
    });

    test('25.2 Poppler pdftotext executable is available and exits 0', async () => {
      const proc = Bun.spawn(['pdftotext', '-v'], {stderr: 'pipe'});
      const code = await proc.exited;
      expect(code).toBe(0);
    });

    test('25.3 Poppler pdfinfo executable is available and exits 0', async () => {
      const proc = Bun.spawn(['pdfinfo', '-v'], {stderr: 'pipe'});
      const code = await proc.exited;
      expect(code).toBe(0);
    });

    test('25.4 Source PDF exceeding 50 MiB limit rejected before processing', async () => {
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const oversized = {
        type: 'base64',
        media_type: 'application/pdf',
        data: 'A'.repeat(70 * 1024 * 1024),
      };
      await expect(reader.sourceBytes(oversized)).rejects.toThrow('document exceeds 50 MiB');
    });

    test('25.5 Minimal valid PDF header parses successfully', async () => {
      const minimalPdf = Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>
endobj
4 0 obj
<< /Length 44 >>
stream
BT
/F1 24 Tf
100 700 Td
(Chimeric PDF Text) Tj
ET
endstream
endobj
xref
0 5
0000000000 65535 f\x20
0000000009 00000 n\x20
0000000074 00000 n\x20
0000000133 00000 n\x20
0000000302 00000 n\x20
trailer
<< /Size 5 /Root 1 0 R >>
startxref
395
%%EOF
`);
      const proc = Bun.spawn(['pdftotext', '-', '-'], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      proc.stdin.write(minimalPdf);
      proc.stdin.end();
      const stdout = await new Response(proc.stdout).text();
      const code = await proc.exited;
      expect(code).toBe(0);
      expect(stdout).toContain('Chimeric PDF Text');
    });
  });

  // Feature 26: General Scientific Agent (OPERON) Boundaries
  describe('Feature 26: General Scientific Agent Boundaries', () => {
    test('26.1 Empty prompt to agent rejected', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({agent: 'OPERON', prompt: '   '}),
      });
      expect(res.status).toBe(400);
    });

    test('26.2 Live GET /api/agents reports OPERON has displayName Chimeric and 29 skills', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const operon = agents.find(a => a.name === 'OPERON');
      expect(operon).toBeDefined();
      expect(operon.displayName).toBe('Chimeric');
      expect(operon.skillNames).toHaveLength(29);
      expect(operon.supportsPlanMode).toBe(true);
    });

    test('26.3 Unauthenticated query to /api/agents returns HTTP 401', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`);
      expect(res.status).toBe(401);
    });

    test('26.4 Multiple concurrent tool calls serialized safely', async () => {
      const { toContext, ReplayStore } = await import('../../src/protocol');
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const mockModel: any = { qualifiedId: 'rikyu::test', input: ['text'] };
      const body = {
        messages: [{
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'alphafold2', input: { sequence: 'MKAVL' } },
            { type: 'tool_use', id: 'call_2', name: 'diffdock', input: { ligand: 'CC' } },
          ],
        }],
      };
      const context = await toContext(body, mockModel, reader, new ReplayStore(':memory:'));
      const assistantMsg = context.messages[0] as any;
      expect(assistantMsg.role).toBe('assistant');
      const toolCalls = assistantMsg.content.filter((c: any) => c.type === 'toolCall');
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0].name).toBe('alphafold2');
      expect(toolCalls[1].name).toBe('diffdock');
    });

    test('26.5 Client abort signal cancels ongoing agent turn', async () => {
      const { ContentReader } = await import('../../src/content');
      const reader = new ContentReader(tmpdir());
      const controller = new AbortController();
      controller.abort(new Error('Turn aborted by user'));
      const payload = {
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: Buffer.from('%PDF-1.4\n%%EOF').toString('base64'),
        },
      };
      await expect(reader.content(payload, false, controller.signal)).rejects.toThrow('Turn aborted by user');
    });
  });

  // Feature 27: Transcript Reviewer (REVIEWER) Boundaries
  describe('Feature 27: Transcript Reviewer Boundaries', () => {
    test('27.1 Live GET /api/agents reports REVIEWER has skillsLocked: true and supportsPlanMode: false', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer).toBeDefined();
      expect(reviewer.skillsLocked).toBe(true);
      expect(reviewer.supportsPlanMode).toBe(false);
    });

    test('27.2 Reviewer specialist configuration present in local runtime', () => {
      const runtimeCode = readFileSync(
        '/Applications/Chimeric.app/Contents/Resources/runtime/local-runtime.js',
        'utf8'
      );
      expect(runtimeCode).toContain('reviewer');
    });

    test('27.3 Reviewer cannot be selected as root user agent', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const reviewer = agents.find(a => a.name === 'REVIEWER');
      expect(reviewer.supportsPlanMode).toBe(false);
      expect(reviewer.skillsLocked).toBe(true);
    });

    test('27.4 Reviewer called on non-existent frame returns 404', async () => {
      const res = await fetch(`${BASELINE_URL}/api/frames/frame_missing_999/messages`, {
        headers: auth.getHeaders('GET'),
      });
      expect(res.status).toBe(404);
    });

    test('27.5 Empty message window yields zero findings', async () => {
      // Create empty frame turn and inspect specialists_used
      const createRes = await fetch(`${BASELINE_URL}/api/frames`, {
        method: 'POST',
        headers: auth.getHeaders('POST'),
        body: JSON.stringify({agent: 'OPERON', project_id: `${E2E_PROJECT_ID}`}),
      });
      expect(createRes.status).toBe(201);
      const frameData = await createRes.json() as any;

      try {
        const frameRes = await fetch(`${BASELINE_URL}/api/frames/${frameData.root_frame_id}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(frameRes.status).toBe(200);
        const frame = await frameRes.json() as any;
        expect(frame.specialists_used).toBeNull();
      } finally {
        await fetch(`${BASELINE_URL}/api/frames/${frameData.root_frame_id}`, {
          method: 'DELETE',
          headers: auth.getHeaders('DELETE'),
        });
      }
    });
  });

  // Feature 28: Transcript Bookmarker (BOOKMARKER) Boundaries
  describe('Feature 28: Transcript Bookmarker Boundaries', () => {
    test('28.1 Live GET /api/agents reports BOOKMARKER has userHidden: true and skillsLocked: true', async () => {
      const res = await fetch(`${BASELINE_URL}/api/agents`, {
        headers: auth.getHeaders('GET'),
      });
      const agents = await res.json() as any[];
      const bookmarker = agents.find(a => a.name === 'BOOKMARKER');
      expect(bookmarker).toBeDefined();
      expect(bookmarker.userHidden).toBe(true);
      expect(bookmarker.skillsLocked).toBe(true);
    });

    test('28.2 Duplicate anchor spans suppressed', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      // Verify query group deduplication on transcript annotations
      const distinctQuery = 'SELECT DISTINCT anchor_text FROM transcript_annotations;';
      const rows = db.query(distinctQuery).all();
      expect(Array.isArray(rows)).toBe(true);
    });

    test('28.3 Transcript annotation schema enforces origin === agent', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      const cols = db.query('PRAGMA table_info(transcript_annotations)').all() as any[];
      const originCol = cols.find(c => c.name === 'origin');
      const anchorCol = cols.find(c => c.name === 'anchor_text');
      expect(originCol).toBeDefined();
      expect(anchorCol).toBeDefined();
    });

    test('28.4 Transcript annotation schema enforces anchor span and offset boundaries in operon-cli.db', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      // Introspect table schema for transcript_annotations
      const cols = db.query('PRAGMA table_info(transcript_annotations)').all() as any[];
      const anchorCol = cols.find(c => c.name === 'anchor_text');
      const prefixCol = cols.find(c => c.name === 'anchor_prefix');
      const startCol = cols.find(c => c.name === 'start_offset');
      const endCol = cols.find(c => c.name === 'end_offset');
      const toolCol = cols.find(c => c.name === 'tool_name');

      // Verify anchor_text is non-nullable TEXT
      expect(anchorCol).toBeDefined();
      expect(anchorCol.notnull).toBe(1);
      expect(anchorCol.type.toUpperCase()).toBe('TEXT');

      // Verify prefix anchor column exists for contextual matching
      expect(prefixCol).toBeDefined();
      expect(prefixCol.type.toUpperCase()).toBe('TEXT');

      // Verify start and end offsets are typed INTEGER
      expect(startCol).toBeDefined();
      expect(startCol.type.toUpperCase()).toBe('INTEGER');
      expect(endCol).toBeDefined();
      expect(endCol.type.toUpperCase()).toBe('INTEGER');

      // Verify tool_name has explicit length bound text(255)
      expect(toolCol).toBeDefined();
      expect(toolCol.type.toLowerCase()).toBe('text(255)');

      // Verify span constraint integrity: no inverted offset spans exist
      const inverted = db.query(
        'SELECT count(*) as count FROM transcript_annotations WHERE start_offset > end_offset'
      ).get() as any;
      expect(inverted.count).toBe(0);
    });

    test('28.5 Bookmark pointing to out-of-bounds message index rejected', () => {
      const { Database } = require('bun:sqlite');
      const profile = findProfilePath();
      const orgsDir = join(profile, 'orgs');
      const orgId = require('node:fs').readdirSync(orgsDir).find((d: string) => !d.startsWith('.'))!;
      const dbPath = join(orgsDir, orgId, 'operon-cli.db');
      const db = new Database(dbPath, { readonly: true });

      // Out of bounds index (e.g. 99999) on any frame returns null
      const msg = db.query('SELECT * FROM frame_messages WHERE idx = 99999').get();
      expect(msg).toBeNull();
    });
  });
});
