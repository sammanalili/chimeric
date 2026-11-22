import { describe, expect, test } from 'bun:test';
import { acquireStartupLock, parseArgs, protectedMacProfile, readStartupLock, redacted, sessionFromControlSocket, startupLockPath, validateSessionUrl, versionInfo } from '../tools/launcher.mjs';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('packaged and source launchers report the declared release version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chimeric-version-'));
  const resources = join(dir, 'resources');
  mkdirSync(resources);
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({version: '0.2.0-rc.1'}));
    expect(versionInfo(resources)).toEqual({version: '0.2.0-rc.1', runtimeVersion: '0.1.71'});
    writeFileSync(join(resources, 'chimeric-version.json'), JSON.stringify({version: '0.3.0'}));
    expect(versionInfo(resources).version).toBe('0.3.0');
    writeFileSync(join(resources, 'chimeric-version.json'), JSON.stringify({version: 'invalid'}));
    expect(() => versionInfo(resources)).toThrow('Invalid Chimeric release version');
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

describe('launcher argument parsing', () => {
  test('accepts all actions and explicit values', () => {
    expect(parseArgs(['session', '--profile', '/tmp/profile', '--port=19000'])).toEqual({
      action: 'session', profileArgument: '/tmp/profile', portArgument: '19000',
    });
  });

  test.each([
    [['--profile'], 'missing profile'],
    [['--port'], 'missing port'],
    [['--port', 'not-a-port'], 'invalid port'],
    [['--port', '1023'], 'port below range'],
    [['--port', '65535'], 'port above range'],
    [['open', 'status'], 'multiple actions'],
    [['--unknown'], 'unknown option'],
    [['--profile', '/tmp/a', '--profile', '/tmp/b'], 'duplicate profile'],
  ])('rejects %s (%s)', (argv) => {
    expect(() => parseArgs(argv as string[])).toThrow();
  });
});

describe('session URL boundary', () => {
  test('normalizes localhost to loopback and preserves the nonce', () => {
    expect(validateSessionUrl('http://localhost:18868/?nonce=abcdef0123456789')).toBe('http://127.0.0.1:18868/?nonce=abcdef0123456789');
  });

  test.each([
    'https://localhost:18868/?nonce=abcdef0123456789',
    'http://example.test:18868/?nonce=abcdef0123456789',
    'http://127.0.0.1:18868/?nonce=short',
    'http://127.0.0.1:18868/?nonce=abcdef0123456789&extra=1',
    'http://127.0.0.1:18868/other?nonce=abcdef0123456789',
  ])('rejects unsafe or malformed URL %s', (url) => expect(() => validateSessionUrl(url)).toThrow());
});

describe('local control-socket readiness', () => {
  test('uses only the daemon socket to mint a loopback session URL', async () => {
    const calls: any[] = [];
    const url = await sessionFromControlSocket('/private/profile', 18868, {
      socketExists: (path) => path === '/private/profile/daemon.sock',
      fetcher: async (input, init) => {
        calls.push({input, init});
        return Response.json({nonce: 'abcdef0123456789'});
      },
    });
    expect(url).toBe('http://127.0.0.1:18868/?nonce=abcdef0123456789');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('http://localhost/nonce');
    expect(calls[0].init).toMatchObject({method: 'POST', unix: '/private/profile/daemon.sock'});
  });

  test('does not make a network call without the local daemon socket', async () => {
    let called = false;
    const url = await sessionFromControlSocket('/private/profile', 18868, {
      socketExists: () => false,
      fetcher: async () => { called = true; return Response.json({nonce: 'abcdef0123456789'}); },
    });
    expect(url).toBeNull();
    expect(called).toBe(false);
  });

  test('rejects malformed nonce replies from the local socket', async () => {
    const url = await sessionFromControlSocket('/private/profile', 18868, {
      socketExists: () => true,
      fetcher: async () => Response.json({nonce: 'not-valid'}),
    });
    expect(url).toBeNull();
  });
});

test('redaction removes one-use URLs and bearer material from log text', () => {
  const output = redacted('ready http://localhost:18868/?nonce=abcdef0123456789\nAuthorization: Bearer secret-token\nnormal status');
  expect(output).not.toContain('nonce=');
  expect(output).not.toContain('secret-token');
  expect(output).toContain('normal status');
});

test('native macOS launchers identify protected workspace locations before a database open can hang', () => {
  const home = '/Users/researcher';
  expect(protectedMacProfile('/Users/researcher/Documents/Chimeric', {platform: 'darwin', home})).toBe(true);
  expect(protectedMacProfile('/Users/researcher/Downloads/Workspace', {platform: 'darwin', home})).toBe(true);
  expect(protectedMacProfile('/Users/researcher/Library/Application Support/Chimeric', {platform: 'darwin', home})).toBe(false);
  expect(protectedMacProfile('/Users/researcher/Documents/Chimeric', {platform: 'linux', home})).toBe(false);
});

describe('workspace startup locks', () => {
  test('allows exactly one launcher to own a profile start and cleans up only its own lock', () => {
    const profile = mkdtempSync(join(tmpdir(), 'chimeric-start-lock-'));
    try {
      const first = acquireStartupLock(profile, { token: 'first', pid: 111 });
      expect(first).not.toBeNull();
      expect(acquireStartupLock(profile, { token: 'second', pid: 222, isProcessRunning: () => true })).toBeNull();
      expect(readStartupLock(profile)?.owner).toMatchObject({ token: 'first', pid: 111 });
      expect(statSync(join(startupLockPath(profile), 'owner.json')).mode & 0o777).toBe(0o600);
      expect(first?.release()).toBe(true);
      expect(readStartupLock(profile)).toBeNull();
      expect(acquireStartupLock(profile, { token: 'second', pid: 222 })?.release()).toBe(true);
    } finally { rmSync(profile, { recursive: true, force: true }); }
  });

  test('recovers a lock left by a dead launcher without allowing a live owner to be stolen', () => {
    const profile = mkdtempSync(join(tmpdir(), 'chimeric-start-recovery-'));
    try {
      const abandoned = acquireStartupLock(profile, { token: 'abandoned', pid: 333 });
      expect(abandoned).not.toBeNull();
      const recovered = acquireStartupLock(profile, { token: 'recovered', pid: 444, isProcessRunning: () => false });
      expect(recovered).not.toBeNull();
      expect(readStartupLock(profile)?.owner).toMatchObject({ token: 'recovered', pid: 444 });
      expect(abandoned?.release()).toBe(false);
      expect(recovered?.release()).toBe(true);

      const live = acquireStartupLock(profile, { token: 'live', pid: 555 });
      expect(live).not.toBeNull();
      expect(acquireStartupLock(profile, { token: 'intruder', pid: 666, isProcessRunning: () => true })).toBeNull();
      expect(live?.release()).toBe(true);
    } finally { rmSync(profile, { recursive: true, force: true }); }
  });
});
