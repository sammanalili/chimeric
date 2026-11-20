import {mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, lstatSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, isAbsolute} from 'node:path';
import {Registry} from '../../src/registry';
import {startBridge} from '../../src/bridge';

// Live suites are destructive fixture tests. Importing this module never discovers
// or authenticates against a developer's running workspace.
export const LIVE_E2E_ENABLED = process.env.CHIMERIC_LIVE_E2E === '1';
export const BASELINE_URL = process.env.CHIMERIC_E2E_URL || 'http://127.0.0.1:1';
export const SANDBOX_URL = process.env.CHIMERIC_E2E_SANDBOX_URL || 'http://127.0.0.1:2';
export const E2E_PROJECT_ID = process.env.CHIMERIC_E2E_PROJECT_ID || '';
export const E2E_FIXTURE_IDS = {
  frame: process.env.CHIMERIC_E2E_FRAME_ID || '',
  artifact: process.env.CHIMERIC_E2E_ARTIFACT_ID || '',
  request: process.env.CHIMERIC_E2E_REQUEST_ID || '',
  forkFrame: process.env.CHIMERIC_E2E_FORK_FRAME_ID || '',
  completedFrame: process.env.CHIMERIC_E2E_COMPLETED_FRAME_ID || '',
};

export function liveE2EConfiguration(environment: Record<string, string | undefined> = process.env) {
  if (environment.CHIMERIC_LIVE_E2E !== '1') {
    throw new Error('Live E2E is disabled. Set CHIMERIC_LIVE_E2E=1 only for a disposable fixture workspace.');
  }
  function origin(name: string): string {
    const value = environment[name];
    if (!value) throw new Error(`${name} must explicitly identify an isolated loopback origin.`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} must be a valid loopback origin.`); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || !url.port || ['18868', '18869'].includes(url.port) || url.username || url.password
        || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} must use an isolated HTTP loopback port, outside the normal app ports.`);
    }
    return url.origin;
  }
  const baseline = origin('CHIMERIC_E2E_URL');
  const sandbox = origin('CHIMERIC_E2E_SANDBOX_URL');
  if (baseline === sandbox) throw new Error('Live E2E requires separate app and renderer origins.');
  const candidate = environment.CHIMERIC_E2E_PROFILE;
  if (!candidate || !isAbsolute(candidate)) throw new Error('CHIMERIC_E2E_PROFILE must explicitly name an absolute disposable profile directory.');
  if (!existsSync(candidate) || !lstatSync(candidate).isDirectory() || lstatSync(candidate).isSymbolicLink()) {
    throw new Error('CHIMERIC_E2E_PROFILE must be an existing disposable profile directory.');
  }
  const profile = realpathSync(candidate);
  const marker = join(profile, '.chimeric-e2e-disposable');
  if (!existsSync(marker) || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink()) {
    throw new Error('The disposable profile must contain a regular .chimeric-e2e-disposable marker file.');
  }
  if (!environment.CHIMERIC_E2E_PROJECT_ID?.match(/^[A-Za-z0-9_-]+$/)) {
    throw new Error('CHIMERIC_E2E_PROJECT_ID must identify a seeded project in the disposable profile.');
  }
  for (const name of ['CHIMERIC_E2E_FRAME_ID', 'CHIMERIC_E2E_ARTIFACT_ID', 'CHIMERIC_E2E_REQUEST_ID',
    'CHIMERIC_E2E_FORK_FRAME_ID', 'CHIMERIC_E2E_COMPLETED_FRAME_ID']) {
    if (!environment[name]?.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)) {
      throw new Error(`${name} must identify the corresponding seeded disposable fixture.`);
    }
  }
  return {
    baseline, sandbox, profile,
    binary: environment.CHIMERIC_E2E_BINARY || '/Applications/Chimeric.app/Contents/Resources/bin/chimeric',
    launcher: environment.CHIMERIC_E2E_LAUNCHER || '/Applications/Chimeric.app/Contents/Resources/launcher.mjs',
  };
}

export interface SessionAuth {
  authCookie: string;
  csrfCookie: string;
  cookieHeader: string;
  csrfToken: string;
  origin: string;
  getHeaders: (method?: string, extra?: Record<string, string>) => Record<string, string>;
}

let cachedAuth: SessionAuth | null = null;

/**
 * Requires an explicitly selected disposable profile. No local profile search.
 */
export function findProfilePath(): string {
  return liveE2EConfiguration().profile;
}

/**
 * Mint a fresh authentic single-use session nonce via the Chimeric launcher.
 */
export async function mintFreshNonce(): Promise<string> {
  const configuration = liveE2EConfiguration();
  const profilePath = configuration.profile;
  const proc = Bun.spawn([
    configuration.binary,
    configuration.launcher,
    'session',
    '--profile',
    profilePath,
    '--port',
    new URL(configuration.baseline).port,
  ], {
    env: {...process.env, BUN_BE_BUN: '1'},
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  try {
    if (exitCode !== 0) throw new Error('launcher failed');
    const session = JSON.parse(stdout);
    const url = new URL(session.url);
    const nonce = url.searchParams.get('nonce');
    if (url.origin !== configuration.baseline || !nonce?.match(/^[a-f0-9]{32,64}$/i)) throw new Error('invalid session');
    return nonce;
  } catch {
    // Launcher output can contain a bearer nonce. Never include it in errors.
    throw new Error('Failed to obtain a session for the disposable E2E workspace.');
  }
}

/**
 * Obtain a valid authenticated session with CSRF from the live running baseline.
 * Throws immediately if authentication fails (NO mock fallbacks allowed).
 */
export async function getLiveSessionAuth(): Promise<SessionAuth> {
  const configuration = liveE2EConfiguration();
  if (cachedAuth) return cachedAuth;
  const origin = configuration.baseline;
  const nonce = await mintFreshNonce();

  const nonceRes = await fetch(`${BASELINE_URL}/api/auth/nonce`, {
    method: 'POST',
    headers: {'content-type': 'application/json', origin},
    body: JSON.stringify({nonce}),
  });

  if (nonceRes.status !== 200) {
    throw new Error(`Failed to redeem bootstrap nonce: HTTP ${nonceRes.status}`);
  }

  const setCookies = nonceRes.headers.get('set-cookie') || '';
  const authMatch = setCookies.match(/operon_auth=([a-f0-9]+)/);
  if (!authMatch) {
    throw new Error('Missing operon_auth cookie in nonce response');
  }
  const authCookie = authMatch[1];

  // Fetch /api/csrf to obtain operon_csrf cookie
  const csrfRes = await fetch(`${BASELINE_URL}/api/csrf`, {
    headers: {
      Cookie: `operon_auth=${authCookie}`,
      origin,
    },
  });

  if (!csrfRes.ok && csrfRes.status !== 204) {
    throw new Error(`Failed to fetch CSRF token: HTTP ${csrfRes.status}`);
  }

  const csrfSetCookies = csrfRes.headers.get('set-cookie') || '';
  const csrfMatch = csrfSetCookies.match(/operon_csrf=([a-f0-9]+)/);
  if (!csrfMatch) {
    throw new Error('Missing operon_csrf cookie in CSRF response');
  }
  const csrfCookie = csrfMatch[1];
  const csrfToken = csrfCookie;

  const cookieHeader = `operon_auth=${authCookie}; operon_csrf=${csrfCookie}`;

  const getHeaders = (method: string = 'GET', extra: Record<string, string> = {}) => {
    const h: Record<string, string> = {
      Cookie: cookieHeader,
      origin,
      ...extra,
    };
    const upper = method.toUpperCase();
    if (upper === 'POST' || upper === 'PUT' || upper === 'DELETE' || upper === 'PATCH') {
      h['x-operon-csrf'] = csrfToken;
      if (!h['content-type']) {
        h['content-type'] = 'application/json';
      }
    }
    return h;
  };

  cachedAuth = {authCookie, csrfCookie, cookieHeader, csrfToken, origin, getHeaders};
  return cachedAuth;
}

/**
 * Resolve path to the managed Conda Python binary.
 */
export function findCondaPython(): string {
  const profilePath = findProfilePath();
  const candidate = join(profilePath, 'conda/envs/python/bin/python');
  if (existsSync(candidate)) return candidate;
  throw new Error(`Conda python binary not found at ${candidate}`);
}

/**
 * Resolve path to the managed Conda R binary.
 */
export function findCondaR(): string {
  const profilePath = findProfilePath();
  const candidate = join(profilePath, 'conda/envs/r/bin/R');
  if (existsSync(candidate)) return candidate;
  throw new Error(`Conda R binary not found at ${candidate}`);
}

/**
 * Execute Python code in the authentic Conda Python environment.
 */
export async function runCondaPython(args: string[], options: {stdin?: string; env?: Record<string, string>} = {}): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const pythonBin = findCondaPython();
  const proc = Bun.spawn([pythonBin, ...args], {
    stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {...process.env, ...options.env},
  });

  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {stdout: stdout.trim(), stderr: stderr.trim(), exitCode};
}

/**
 * Execute R code in the authentic Conda R environment.
 */
export async function runCondaR(args: string[], options: {stdin?: string; env?: Record<string, string>} = {}): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const rBin = findCondaR();
  const proc = Bun.spawn([rBin, ...args], {
    stdin: options.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {...process.env, ...options.env},
  });

  if (options.stdin !== undefined && proc.stdin) {
    proc.stdin.write(options.stdin);
    proc.stdin.end();
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {stdout: stdout.trim(), stderr: stderr.trim(), exitCode};
}

/**
 * Execute a Darwin SBPL seatbelt command via sandbox-exec.
 */
export async function runDarwinSeatbelt(sbpl: string, pythonCode: string): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const proc = Bun.spawn(['sandbox-exec', '-p', sbpl, 'python3', '-c', pythonCode], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return {stdout: stdout.trim(), stderr: stderr.trim(), exitCode};
}

/**
 * Creates an ephemeral mock OpenAI-compatible provider server.
 */
export function createMockProvider(options: {
  models?: Array<{id: string; input?: string[]; reasoning?: boolean}>;
  customHandler?: (req: Request) => Promise<Response> | Response;
} = {}) {
  const models = options.models ?? [{id: 'e2e-model', input: ['text', 'image'], reasoning: true}];
  const requests: any[] = [];

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: any = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          body = await req.json();
          requests.push({method: req.method, path: url.pathname, body, headers: Object.fromEntries(req.headers)});
        } catch {
          requests.push({method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers)});
        }
      } else {
        requests.push({method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers)});
      }

      if (options.customHandler) {
        return options.customHandler(req);
      }

      if (url.pathname === '/v1/models') {
        return Response.json({
          object: 'list',
          data: models.map(m => ({id: m.id, object: 'model', created: Date.now(), owned_by: 'e2e-test'})),
        });
      }

      if (url.pathname === '/v1/chat/completions') {
        const isStream = body?.stream;
        if (isStream) {
          const enc = new TextEncoder();
          return new Response(new ReadableStream({
            start(controller) {
              const chunk = {
                id: 'chunk_e2e',
                object: 'chat.completion.chunk',
                created: Date.now(),
                model: body?.model || 'e2e-model',
                choices: [{index: 0, delta: {role: 'assistant', content: 'E2E mock stream chunk'}, finish_reason: null}],
              };
              controller.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }), {headers: {'content-type': 'text/event-stream'}});
        }

        return Response.json({
          id: 'chatcmpl_e2e',
          object: 'chat.completion',
          created: Date.now(),
          model: body?.model || 'e2e-model',
          choices: [{
            index: 0,
            message: {role: 'assistant', content: 'E2E mock assistant completion'},
            finish_reason: 'stop',
          }],
          usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15},
        });
      }

      return new Response('Not Found', {status: 404});
    },
  });

  return {
    server,
    url: server.url.href,
    requests,
    stop: () => server.stop(true),
  };
}

/**
 * Scientific test fixtures.
 */
export const FIXTURES = {
  PDB: `HEADER    OXIDOREDUCTASE                          01-NOV-26   1MBO\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
TITLE     STRUCTURE OF SPERM WHALE MYOGLOBIN\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
COMPND    MOL_ID: 1; MOLECULE: MYOGLOBIN; CHAIN: A; SYNONYM: MB\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
SOURCE    MOL_ID: 1; ORGANISM_SCIENTIFIC: PHYSETER CATODON\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
ATOM      1  N   VAL A   1      10.870  14.230   8.910  1.00 20.00           N\x20\x20
ATOM      2  CA  VAL A   1      11.450  15.220   9.840  1.00 20.00           C\x20\x20
ATOM      3  C   VAL A   1      12.960  15.110   9.720  1.00 20.00           C\x20\x20
ATOM      4  O   VAL A   1      13.560  14.130  10.150  1.00 20.00           O\x20\x20
ATOM      5  CB  VAL A   1      10.890  16.630   9.520  1.00 20.00           C\x20\x20
TER       6      VAL A   1\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20\x20
END
`,

  CIF: `data_1MBO
#\x20
_entry.id   1MBO\x20
#\x20
_audit_conform.dict_name       mmcif_pdbx.dic\x20
_audit_conform.dict_version    5.279\x20
#\x20
loop_
_atom_site.group_PDB\x20
_atom_site.id\x20
_atom_site.type_symbol\x20
_atom_site.label_atom_id\x20
_atom_site.label_alt_id\x20
_atom_site.label_comp_id\x20
_atom_site.label_asym_id\x20
_atom_site.label_seq_id\x20
_atom_site.Cartn_x\x20
_atom_site.Cartn_y\x20
_atom_site.Cartn_z\x20
_atom_site.occupancy\x20
_atom_site.B_iso_or_equiv\x20
ATOM 1 N N . VAL A 1 10.870 14.230 8.910 1.00 20.00
ATOM 2 C CA . VAL A 1 11.450 15.220 9.840 1.00 20.00
`,

  SMILES: {
    aspirin: 'CC(=O)Oc1ccccc1C(=O)O',
    caffeine: 'CN1C=NC2=C1C(=O)N(C(=O)N2C)C',
    imatinib: 'Cc1ccc(cc1Nc2nccc(n2)c3cccnc3)NC(=O)c4ccc(cc4)CN5CCN(CC5)C',
  },

  FASTA_MSA: `>Homo_sapiens_TP53
MEEPQSDPSVEPPLSQETFSDLWKLLPENNVLSPLPSQAMDDLMLSPDDIEQWFTEDPGP
>Mus_musculus_Trp53
MEESQSDISLELPLSQETFSGLWKLLPPEDIL-SPS-HCMDDLLLSP-EAWFTEDPGP
>Danio_rerio_tp53
MAEPSADVSLELPLSQETFSCLWKLLPPEDILS-PS-YCMDDFLLSQ-DVWFTEDPGP
`,

  VCF: `##fileformat=VCFv4.2
##FILTER=<ID=PASS,Description="All filters passed">
##INFO=<ID=AF,Number=A,Type=Float,Description="Allele Frequency">
#CHROM	POS	ID	REF	ALT	QUAL	FILTER	INFO
chr1	123456	rs1001	A	G	100	PASS	AF=0.042
chr7	140753336	rs113488022	T	A	999	PASS	AF=0.0001
chr17	43044295	rs28897700	C	T	500	PASS	AF=0.0005
`,

  BED: `chr1	1000	2000	exon1	100	+
chr1	3000	4000	exon2	100	+
chr7	140753000	140754000	BRAF_V600E_locus	999	+
`,

  JUPYTER_NOTEBOOK: {
    cells: [
      {
        cell_type: 'markdown',
        metadata: {},
        source: ['# Genomic Analysis Pipeline\n', 'Evaluating RNA-seq counts and differential expression.'],
      },
      {
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        outputs: [
          {
            output_type: 'stream',
            name: 'stdout',
            text: ['Package DESeq2 version: 1.42.0\n', 'Dimensions of count matrix: 20000 x 6\n'],
          },
        ],
        source: ['import numpy as np\n', 'print("Package DESeq2 version: 1.42.0")\n', 'print("Dimensions of count matrix: 20000 x 6")'],
      },
    ],
    metadata: {
      language_info: {name: 'python'},
      orig_nbformat: 4,
    },
    nbformat: 4,
    nbformat_minor: 5,
  },

  CSV_DATA: `gene_id,gene_symbol,log2FoldChange,pvalue,padj
ENSG00000141510,TP53,2.45,1.2e-6,4.5e-5
ENSG00000157764,BRAF,-1.82,3.4e-4,2.1e-3
ENSG00000133703,KRAS,3.12,8.9e-9,1.1e-7
ENSG00000171094,ALK,0.15,0.42,0.61
`,
};
