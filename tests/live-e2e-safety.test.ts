import {test, expect} from 'bun:test';
import {mkdtempSync, rmSync, writeFileSync, symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {liveE2EConfiguration} from './e2e/test-helpers';

function disposableFixture() {
  const profile = mkdtempSync(join(tmpdir(), 'chimeric-live-gate-'));
  const environment = {
    CHIMERIC_LIVE_E2E: '1', CHIMERIC_E2E_URL: 'http://127.0.0.1:19980',
    CHIMERIC_E2E_SANDBOX_URL: 'http://127.0.0.1:19981', CHIMERIC_E2E_PROFILE: profile,
    CHIMERIC_E2E_PROJECT_ID: 'fixture-project',
    CHIMERIC_E2E_FRAME_ID: '11111111-1111-4111-8111-111111111111',
    CHIMERIC_E2E_ARTIFACT_ID: '22222222-2222-4222-8222-222222222222',
    CHIMERIC_E2E_REQUEST_ID: '33333333-3333-4333-8333-333333333333',
    CHIMERIC_E2E_FORK_FRAME_ID: '44444444-4444-4444-8444-444444444444',
    CHIMERIC_E2E_COMPLETED_FRAME_ID: '55555555-5555-4555-8555-555555555555',
  };
  return {profile, environment, close: () => rmSync(profile, {recursive: true, force: true})};
}

test('Live integration configuration never discovers a local workspace by default', () => {
  expect(() => liveE2EConfiguration({})).toThrow('Live E2E is disabled');
  expect(() => liveE2EConfiguration({CHIMERIC_LIVE_E2E: '1'})).toThrow('CHIMERIC_E2E_URL');
});

test('Live integration configuration rejects production ports, remote origins and credential URLs', () => {
  const fixture = disposableFixture();
  try {
    writeFileSync(join(fixture.profile, '.chimeric-e2e-disposable'), 'synthetic fixture');
    for (const url of ['http://127.0.0.1:18868', 'http://localhost:18869', 'https://example.com:19980',
      'http://fixture:password@127.0.0.1:19980', 'http://127.0.0.1:19980/?nonce=fixture', 'http://127.0.0.1:19980/path']) {
      expect(() => liveE2EConfiguration({...fixture.environment, CHIMERIC_E2E_URL: url})).toThrow('isolated');
    }
    expect(() => liveE2EConfiguration({...fixture.environment, CHIMERIC_E2E_SANDBOX_URL: fixture.environment.CHIMERIC_E2E_URL})).toThrow('separate');
  } finally { fixture.close(); }
});

test('A live integration profile requires a real disposable marker and seeded fixture identifiers', () => {
  const fixture = disposableFixture();
  try {
    expect(() => liveE2EConfiguration(fixture.environment)).toThrow('marker');
    const marker = join(fixture.profile, '.chimeric-e2e-disposable');
    const target = join(fixture.profile, 'marker-target');
    writeFileSync(target, 'synthetic fixture');
    symlinkSync(target, marker);
    expect(() => liveE2EConfiguration(fixture.environment)).toThrow('marker');
    rmSync(marker);
    writeFileSync(marker, 'synthetic fixture');
    expect(() => liveE2EConfiguration({...fixture.environment, CHIMERIC_E2E_FRAME_ID: ''})).toThrow('CHIMERIC_E2E_FRAME_ID');
    const configured = liveE2EConfiguration(fixture.environment);
    expect(configured.baseline).toBe('http://127.0.0.1:19980');
    expect(configured.profile.endsWith(fixture.profile.split('/').at(-1)!)).toBe(true);
  } finally { fixture.close(); }
});
