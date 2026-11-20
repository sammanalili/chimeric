import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './e2e/test-helpers';
import {test, expect, describe, beforeAll} from 'bun:test';
import {existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, symlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import https from 'node:https';
import http from 'node:http';
import {installNetworkPolicy, blockedServiceURL} from '../src/network-policy';
import {bannedHost} from '../src/registry';
import {BASELINE_URL, getLiveSessionAuth, findProfilePath, SessionAuth} from './e2e/test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Adversarial Challenge: Milestone 1 Iteration 3 Security Hardening', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // =========================================================================
  // 1. Darwin SBPL Kernel Sandbox Isolation (sandbox-exec AUTH_OPEN_DENIED)
  // =========================================================================
  describe('Vector 1: Darwin SBPL Kernel Sandbox Isolation', () => {
    const profilePath = findProfilePath();
    const authDir = join(profilePath, 'local-auth');
    const chatgptKey = join(authDir, 'chatgpt.key');
    const providersEnc = join(authDir, 'providers.enc.json');

    test('1.1 Credential directory and files exist on disk with restricted host state', () => {
      expect(existsSync(authDir)).toBe(true);
      expect(existsSync(chatgptKey)).toBe(true);
      expect(existsSync(providersEnc)).toBe(true);
    });

    test('1.2 Darwin SBPL profile denies direct read of chatgpt.key -> AUTH_OPEN_DENIED', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const script = `
import os
try:
    fd = os.open("${chatgptKey}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
    });

    test('1.3 Darwin SBPL profile denies direct read of providers.enc.json -> AUTH_OPEN_DENIED', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const script = `
import os
try:
    fd = os.open("${providersEnc}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
    });

    test('1.4 Darwin SBPL profile denies directory enumeration os.listdir(local-auth)', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const script = `
import os
try:
    os.listdir("${authDir}")
    print("DIR_ENUM_ALLOWED")
except PermissionError:
    print("DIR_ENUM_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('DIR_ENUM_DENIED');
    });

    test('1.5 Darwin SBPL profile denies relative traversal: local-auth/../local-auth/chatgpt.key', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
      const script = `
import os
try:
    fd = os.open("${authDir}/../local-auth/chatgpt.key", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
    });

    test('1.6 Darwin SBPL profile traps symlink traversal pointing inside local-auth', () => {
      const tempTestDir = join(tmpdir(), `sbpl_sym_test_${Date.now()}`);
      mkdirSync(tempTestDir, {recursive: true});
      const symlinkPath = join(tempTestDir, 'leak_key_symlink');
      symlinkSync(chatgptKey, symlinkPath);

      try {
        const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
        const script = `
import os
try:
    fd = os.open("${symlinkPath}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
        const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('AUTH_OPEN_DENIED');
      } finally {
        rmSync(tempTestDir, {recursive: true, force: true});
      }
    });

    test('1.7 Darwin SBPL profile denies file write/create operations in local-auth', () => {
      const sbpl = `(version 1)\n(allow default)\n(deny file-write* (subpath "${authDir}"))\n`;
      const script = `
import os
try:
    fd = os.open("${authDir}/injected_adversary.txt", os.O_WRONLY | os.O_CREAT)
    os.close(fd)
    print("AUTH_WRITE_ALLOWED")
except PermissionError:
    print("AUTH_WRITE_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_WRITE_DENIED');
    });

    test('1.8 Negative control: without SBPL deny rule, open succeeds (proves SBPL is active enforcer)', () => {
      const sbplAllow = `(version 1)\n(allow default)\n`;
      const script = `
import os
try:
    fd = os.open("${chatgptKey}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
      const res = spawnSync('sandbox-exec', ['-p', sbplAllow, 'python3', '-c', script], {encoding: 'utf-8'});
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toBe('AUTH_OPEN_ALLOWED');
    });

    test('1.9 Allowed outside paths remain accessible under SBPL sandbox', () => {
      const tempTestFile = join(tmpdir(), `sbpl_allowed_test_${Date.now()}.txt`);
      writeFileSync(tempTestFile, 'allowed data');

      try {
        const sbpl = `(version 1)\n(allow default)\n(deny file-read* (subpath "${authDir}"))\n`;
        const script = `
import os
try:
    fd = os.open("${tempTestFile}", os.O_RDONLY)
    os.close(fd)
    print("AUTH_OPEN_ALLOWED")
except PermissionError:
    print("AUTH_OPEN_DENIED")
`;
        const res = spawnSync('sandbox-exec', ['-p', sbpl, 'python3', '-c', script], {encoding: 'utf-8'});
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).toBe('AUTH_OPEN_ALLOWED');
      } finally {
        if (existsSync(tempTestFile)) unlinkSync(tempTestFile);
      }
    });
  });

  // =========================================================================
  // 2. CSRF & Origin Enforcement on Mutating Endpoints Across All HTTP Methods
  // =========================================================================
  describe('Vector 2: CSRF & Origin Enforcement on Mutating Endpoints Across All HTTP Methods', () => {
    const mutatingTargets = [
      {method: 'POST', path: '/api/local/connections', body: {name: 'adv_conn'}},
      {method: 'POST', path: '/api/local/connections/preview', body: {baseUrl: 'https://api.openai.com/v1'}},
      {method: 'POST', path: '/api/local/chatgpt', body: {action: 'status'}},
      {method: 'POST', path: '/api/frames', body: {projectId: `${E2E_PROJECT_ID}`, message: 'test'}},
      {method: 'POST', path: '/api/frames/non_existent_frame_123/approve-plan', body: {}},
      {method: 'POST', path: '/api/frames/non_existent_frame_123/resolve-input', body: {}},
      {method: 'POST', path: '/api/frames/non_existent_frame_123/discard-plan', body: {}},
      {method: 'POST', path: '/api/frames/non_existent_frame_123/cancel', body: {}},
      {method: 'POST', path: '/api/onboarding/lead-in', body: {projectId: `${E2E_PROJECT_ID}`}},
      {method: 'PUT', path: '/api/models/selection', body: {model: 'openai-codex::gpt-6.1-sol'}},
      {method: 'PUT', path: '/api/local/ui/preferences', body: {locale: 'ja'}},
      {method: 'PUT', path: '/api/local/connections/settings', body: {}},
      {method: 'PUT', path: '/api/mcp-servers/connectors/pubmed/enabled', body: {enabled: true}},
      {method: 'DELETE', path: '/api/local/connections/adv_probe_id', body: {}},
      {method: 'DELETE', path: '/api/frames/non_existent_frame_123', body: {}},
      {method: 'DELETE', path: '/api/memories/non_existent_mem_123', body: {}},
      {method: 'PATCH', path: '/api/preferences/host-grants', body: {path: '/tmp', mode: 'ro'}},
    ];

    for (const target of mutatingTargets) {
      test(`2.1 ${target.method} ${target.path} returns 401 when completely unauthenticated`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: {'content-type': 'application/json'},
          body: JSON.stringify(target.body),
        });
        expect(res.status).toBe(401);
      });

      test(`2.2 ${target.method} ${target.path} returns 403 origin_required when Origin header is omitted`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: {
            'content-type': 'application/json',
            Cookie: auth.cookieHeader,
          },
          body: JSON.stringify(target.body),
        });
        expect(res.status).toBe(403);
        const data = await res.json() as any;
        expect(data.code || data.error).toBe('origin_required');
      });

      test(`2.3 ${target.method} ${target.path} returns 403 forbidden origin on cross-origin attack`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: {
            'content-type': 'application/json',
            origin: 'https://evil-attacker.example.com',
            Cookie: auth.cookieHeader,
            'x-operon-csrf': auth.csrfToken,
          },
          body: JSON.stringify(target.body),
        });
        expect(res.status).toBe(403);
        const data = await res.json() as any;
        expect(data.detail).toContain('forbidden origin');
      });

      test(`2.4 ${target.method} ${target.path} returns 403 csrf_stale when Origin is valid but x-operon-csrf header is missing`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: {
            'content-type': 'application/json',
            origin: BASELINE_URL,
            Cookie: auth.cookieHeader,
          },
          body: JSON.stringify(target.body),
        });
        expect(res.status).toBe(403);
        const data = await res.json() as any;
        expect(data.code || data.error).toBe('csrf_stale');
      });

      test(`2.5 ${target.method} ${target.path} returns 403 csrf_stale when x-operon-csrf header contains forged token`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: {
            'content-type': 'application/json',
            origin: BASELINE_URL,
            Cookie: auth.cookieHeader,
            'x-operon-csrf': 'forged_deadbeef_000000000000000000000000',
          },
          body: JSON.stringify(target.body),
        });
        expect(res.status).toBe(403);
        const data = await res.json() as any;
        expect(data.code || data.error).toBe('csrf_stale');
      });

      test(`2.6 ${target.method} ${target.path} passes CSRF gate when valid session, origin, and matching CSRF header are provided`, async () => {
        const res = await fetch(`${BASELINE_URL}${target.path}`, {
          method: target.method,
          headers: auth.getHeaders(target.method),
          body: JSON.stringify(target.body),
        });
        // Must NOT be blocked by auth (401) or CSRF (403)
        expect(res.status).not.toBe(401);
        expect(res.status).not.toBe(403);
      });
    }

    test('2.7 Read-only GET endpoints do NOT require x-operon-csrf header', async () => {
      const readEndpoints = [
        '/api/models',
        '/api/local/connections',
        '/api/local/ui/preferences',
        '/api/auth/status',
      ];
      for (const ep of readEndpoints) {
        const res = await fetch(`${BASELINE_URL}${ep}`, {
          method: 'GET',
          headers: {Cookie: auth.cookieHeader},
        });
        expect(res.status).toBe(200);
      }
    });

    test('2.8 Mutating requests with form content-type without CSRF are strictly rejected with 403', async () => {
      const res = await fetch(`${BASELINE_URL}/api/local/connections`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: BASELINE_URL,
          Cookie: auth.cookieHeader,
        },
        body: 'name=adversary&baseUrl=http://evil.com',
      });
      expect(res.status).toBe(403);
    });
  });

  // =========================================================================
  // 3. Network Policy Enforcement via blockedServiceURL
  // =========================================================================
  describe('Vector 3: Network Policy Enforcement via blockedServiceURL', () => {
    beforeAll(() => {
      installNetworkPolicy();
    });

    const strictlyBlockedUrls = [
      // Anthropic API & Claude domains
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/v1/complete',
      'https://claude.ai/api/event_logging/v2/batch',
      'https://claude.com/api/track',
      'https://anthropic.ai/metrics',
      // Subdomains
      'https://stats.claude.ai/v1/event',
      'https://telemetry.anthropic.com/log',
      'https://nested.sub.domain.claude.ai/path',
      // Case insensitivity
      'https://API.ANTHROPIC.COM/v1/messages',
      'https://CLAUDE.AI/api/batch',
      'https://Stats.Claude.Ai/events',
      // DNS trailing dot (FQDN)
      'https://api.anthropic.com./v1/messages',
      'https://claude.ai./batch',
      // Port specifications
      'https://api.anthropic.com:443/v1/messages',
      // Sentry crash reporting
      'https://o1158394.ingest.us.sentry.io/api/123/envelope',
      'https://O1158394.INGEST.US.SENTRY.IO/api/envelope',
      // Preserved Google Storage update bucket
      'https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59',
      'https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59/',
      'https://storage.googleapis.com/operon-dist-cf94a20e-f71c-413c-bd00-9e12b1fedf59/releases/latest.json',
      // URL encoded bucket path
      'https://storage.googleapis.com/%6f%70%65%72%6f%6e%2d%64%69%73%74%2d%63%66%39%34%61%32%30%65%2d%66%37%31%63%2d%34%31%33%63%2d%62%64%30%30%2d%39%65%31%32%62%31%66%65%64%66%35%39',
    ];

    for (const u of strictlyBlockedUrls) {
      test(`3.1 blockedServiceURL returns true for blocked URL: ${u}`, () => {
        expect(blockedServiceURL(new URL(u))).toBe(true);
      });

      test(`3.2 globalThis.fetch rejects blocked URL: ${u}`, async () => {
        let threw = false;
        let errMsg = '';
        try {
          await fetch(u);
        } catch (e: any) {
          threw = true;
          errMsg = e.message;
        }
        expect(threw).toBe(true);
        expect(errMsg).toContain('Chimeric blocked a vendor service request.');
      });
    }

    test('3.3 Node https.get synchronously throws on blocked destinations', () => {
      expect(() => {
        https.get('https://api.anthropic.com/v1/messages');
      }).toThrow('Chimeric blocked a vendor service request.');

      expect(() => {
        https.get('https://o1158394.ingest.us.sentry.io/api/envelope');
      }).toThrow('Chimeric blocked a vendor service request.');
    });

    test('3.4 Node http.get synchronously throws on blocked HTTP destinations', () => {
      expect(() => {
        http.get('http://api.anthropic.com/v1/messages');
      }).toThrow('Chimeric blocked a vendor service request.');
    });

    const permittedScientificAndModelUrls = [
      // NCBI APIs
      'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=31899195',
      'https://pubmed.ncbi.nlm.nih.gov/31899195/',
      // UniProt
      'https://rest.uniprot.org/uniprotkb/P04637.json',
      // ChEMBL
      'https://www.ebi.ac.uk/chembl/api/data/molecule/CHEMBL25.json',
      // PDB
      'https://data.rcsb.org/rest/v1/core/entry/4HHB',
      // Model Providers
      'https://api.openai.com/v1/chat/completions',
      'https://chatgpt.com/backend-api/models',
      `${BASELINE_URL}/api/models`,
      // Non-vendor Google Storage datasets
      'https://storage.googleapis.com/public-datasets/genomes/hg38.fa',
      'https://storage.googleapis.com/broad-references/hg38/v0/Homo_sapiens_assembly38.fasta',
      // Non-Anthropic domains with similar suffixes
      'https://notanthropic.com/api',
      'https://anthropic.com.attacker.org/v1',
    ];

    for (const u of permittedScientificAndModelUrls) {
      test(`3.5 blockedServiceURL permits scientific or legitimate destination: ${u}`, () => {
        expect(blockedServiceURL(new URL(u))).toBe(false);
      });
    }

    test('3.6 bannedHost correctly identifies exact and subdomain matches only', () => {
      expect(bannedHost('anthropic.com')).toBe(true);
      expect(bannedHost('sub.anthropic.com')).toBe(true);
      expect(bannedHost('claude.ai')).toBe(true);
      expect(bannedHost('api.claude.ai')).toBe(true);
      expect(bannedHost('notanthropic.com')).toBe(false);
      expect(bannedHost('anthropic.com.evil.com')).toBe(false);
      expect(bannedHost('claude.ai.attacker.net')).toBe(false);
    });
  });

  // =========================================================================
  // 4. Path Traversal Attacks Against Artifact and Export Endpoints
  // =========================================================================
  describe('Vector 4: Path Traversal Attacks Against Artifact and Export Endpoints', () => {
    const traversalArtifactPaths = [
      '/api/artifacts/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/api/artifacts/..%2f..%2fetc%2fpasswd',
      '/api/artifacts/..%5c..%5cetc%5cpasswd',
      '/api/artifacts/%252e%252e%252fetc%252fpasswd',
      '/api/artifacts/%2e%2e%2f%2e%2e%2flocal-auth%2fchatgpt.key',
      `/api/artifacts/${E2E_FIXTURE_IDS.artifact}/versions/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      `/api/artifacts/${E2E_FIXTURE_IDS.artifact}/lineage/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      `/api/artifacts/${E2E_FIXTURE_IDS.artifact}/metadata/%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
    ];

    for (const p of traversalArtifactPaths) {
      test(`4.1 Path traversal endpoint ${p} returns strict 404 and never leaks sensitive file content`, async () => {
        const res = await fetch(`${BASELINE_URL}${p}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(res.status).toBe(404);
        const bodyText = await res.text();
        expect(bodyText).not.toContain('root:x:0:0:');
        expect(bodyText).not.toContain('daemon:x:');
        expect(bodyText).not.toContain('sk-');
      });
    }

    test('4.2 Host browse endpoint traps path traversal with strict 400', async () => {
      const probePaths = ['/etc/..', '%2e%2e', '/tmp/%2e%2e', '..%2f..'];
      for (const pp of probePaths) {
        const res = await fetch(`${BASELINE_URL}/api/preferences/host-browse?path=${pp}`, {
          headers: auth.getHeaders('GET'),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.detail).toBe('absolute path required');
      }
    });

    test('4.3 Portable build export rejects path traversal escaping runtime via Python unit suite', () => {
      const pythonProc = spawnSync('python3', ['-m', 'unittest', 'tests/test_portable_export.py'], {
        cwd: resolve(__dirname, '..'),
        encoding: 'utf-8',
      });
      expect(pythonProc.status).toBe(0);
      expect(pythonProc.stderr).toContain('OK');
    });

    test('4.4 Release boundary export auditor rejects directory escape and symlink traversal', () => {
      const pythonProc = spawnSync('python3', ['-m', 'unittest', 'tests/test_release.py'], {
        cwd: resolve(__dirname, '..'),
        encoding: 'utf-8',
      });
      expect(pythonProc.status).toBe(0);
      expect(pythonProc.stderr).toContain('OK');
    });

    test('4.5 release_check.py audit passes with 0 findings and clean source boundaries', () => {
      const pythonProc = spawnSync('python3', ['tools/release_check.py'], {
        cwd: resolve(__dirname, '..'),
        encoding: 'utf-8',
      });
      expect(pythonProc.status).toBe(0);
      const auditResult = JSON.parse(pythonProc.stdout);
      expect(auditResult.sourceChecksPassed).toBe(true);
      expect(auditResult.findings).toEqual([]);
    });
  });
});
