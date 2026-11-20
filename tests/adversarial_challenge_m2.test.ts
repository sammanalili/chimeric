import {LIVE_E2E_ENABLED, E2E_PROJECT_ID, E2E_FIXTURE_IDS} from './e2e/test-helpers';
import {test, expect, describe, beforeAll, afterAll} from 'bun:test';
import {existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {runInNewContext} from 'node:vm';
import {createHash, randomBytes} from 'node:crypto';
import {Localization, resolveLanguage, localize} from '../src/localization';
import {createVoiceBridge} from '../src/voice';
import {ContentReader, processText, findConverter, converter} from '../src/content';
import {BASELINE_URL, getLiveSessionAuth, SessionAuth} from './e2e/test-helpers';

describe.skipIf(!LIVE_E2E_ENABLED)('Adversarial Challenge: Milestone 2 Robustness & Packaging Integrity', () => {
  if (!LIVE_E2E_ENABLED) return; // Explicit opt-in prevents discovery or mutation of a personal workspace.
  let auth: SessionAuth;

  beforeAll(async () => {
    auth = await getLiveSessionAuth();
  });

  // =========================================================================
  // 1. Localization Fault Tolerance & Fuzzing
  // =========================================================================
  describe('Vector 1: Localization Fault Tolerance & Prototype Mutation Fuzzing', () => {
    test('1.1 Fuzz live PUT /api/local/ui/preferences with invalid locales rejects with strict 400', async () => {
      const invalidLocales = ['fr', 'de', 'es', 'zh', '', 'EN', 'JA', 'system_en', 'unknown'];
      for (const loc of invalidLocales) {
        const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', {'content-type': 'application/json'}),
          body: JSON.stringify({locale: loc}),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.detail).toBe('Choose System, English or Japanese.');
      }
    });

    test('1.2 Fuzz live PUT /api/local/ui/preferences with type mutations rejects with strict 400', async () => {
      const mutatedPayloads = [
        {locale: 123},
        {locale: true},
        {locale: false},
        {locale: null},
        {locale: ['ja']},
        {locale: {nested: 'ja'}},
        {},
        {otherField: 'ja'},
        null,
      ];
      for (const payload of mutatedPayloads) {
        const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', {'content-type': 'application/json'}),
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.detail).toBe('Choose System, English or Japanese.');
      }
    });

    test('1.3 Fuzz live PUT /api/local/ui/preferences with prototype pollution & prototype keys', async () => {
      // Prototype key inside body
      const protoPayloads = [
        '{"__proto__": {"locale": "ja"}}',
        '{"constructor": {"prototype": {"locale": "ja"}}}',
        '{"locale": "__proto__"}',
        '{"locale": "constructor"}',
        '{"locale": "toString"}',
        '{"locale": "valueOf"}',
      ];
      for (const raw of protoPayloads) {
        const res = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
          method: 'PUT',
          headers: auth.getHeaders('PUT', {'content-type': 'application/json'}),
          body: raw,
        });
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.detail).toBe('Choose System, English or Japanese.');
      }
    });

    test('1.4 Live GET /api/local/ui/preferences responds cleanly with 200 and system fallback', async () => {
      // First ensure clean state
      const putRes = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'PUT',
        headers: auth.getHeaders('PUT', {'content-type': 'application/json'}),
        body: JSON.stringify({locale: 'system'}),
      });
      expect(putRes.status).toBe(200);

      const getRes = await fetch(`${BASELINE_URL}/api/local/ui/preferences`, {
        method: 'GET',
        headers: auth.getHeaders('GET', {'accept-language': 'en-US,en;q=0.9'}),
      });
      expect(getRes.status).toBe(200);
      const data = await getRes.json() as any;
      expect(data.locale).toBe('system');
      expect(data.resolvedLocale).toBe('en');
    });

    test('1.5 Disk corruption in ui-preferences.json safely recovers to system without throwing', () => {
      const testDir = mkdtempSync(join(tmpdir(), 'adv-locale-corrupt-'));
      try {
        const corruptions = [
          '{ broken json',
          '{"locale": ',
          '{"locale": "unsupported_xyz"}',
          '{"locale": 9999}',
          '[1, 2, 3]',
          '"just a string"',
          'null',
          'true',
          '',
          '\x00\x00\x00\x00',
          '{"other_key": true}',
          '{"__proto__": {"polluted": true}}',
          '{"locale": "__proto__"}',
          '{"locale": "constructor"}',
        ];

        for (const badContent of corruptions) {
          writeFileSync(join(testDir, 'ui-preferences.json'), badContent);
          const loc = new Localization(testDir);
          expect(loc.locale).toBe('system');
          expect(loc.resolve('en')).toBe('en');
          expect(loc.resolve('ja')).toBe('ja');
        }
      } finally {
        rmSync(testDir, {recursive: true, force: true});
      }
    });

    test('1.6 Corrupted disk state heals upon subsequent valid PUT operation', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'adv-locale-heal-'));
      try {
        writeFileSync(join(testDir, 'ui-preferences.json'), '{corrupt-content-here');
        const loc = new Localization(testDir);
        expect(loc.locale).toBe('system');

        const routes = new Map<string, Function>();
        loc.install({
          get: (p: string, h: Function) => routes.set('GET ' + p, h),
          put: (p: string, h: Function) => routes.set('PUT ' + p, h),
        });

        const reply: any = {code: () => ({send: (x: any) => x})};
        const putHandler = routes.get('PUT /api/local/ui/preferences')!;
        await putHandler({body: {locale: 'ja'}}, reply);

        // Instance state updated
        expect(loc.locale).toBe('ja');

        // Fresh instance reading healed file from disk
        const locReloaded = new Localization(testDir);
        expect(locReloaded.locale).toBe('ja');
      } finally {
        rmSync(testDir, {recursive: true, force: true});
      }
    });

    test('1.7 GET /api/local/i18n/bootstrap.js executes cleanly in isolated browser VM context', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'adv-locale-boot-'));
      try {
        const loc = new Localization(testDir);
        const routes = new Map<string, Function>();
        loc.install({
          get: (p: string, h: Function) => routes.set('GET ' + p, h),
          put: (p: string, h: Function) => routes.set('PUT ' + p, h),
        });

        const reply: any = {type: () => reply, header: () => reply, send: (s: string) => s};
        const bootHandler = routes.get('GET /api/local/i18n/bootstrap.js')!;
        const script = await bootHandler({}, reply);
        expect(typeof script).toBe('string');

        // Execute in sandbox context mimicking browser window
        const vmContext: any = {
          navigator: {languages: ['ja-JP', 'en']},
          document: {documentElement: {}},
        };
        runInNewContext(script, vmContext);
        expect(vmContext.ChimericI18n.locale).toBe('ja');
        expect(vmContext.ChimericI18n.preference).toBe('system');
        expect(vmContext.ChimericI18n.t('Language')).toBe('言語');
        expect(vmContext.ChimericI18n.t('NonExistentKey123')).toBe('NonExistentKey123');
      } finally {
        rmSync(testDir, {recursive: true, force: true});
      }
    });
  });

  // =========================================================================
  // 2. Voice Audio Frame Fuzzing & Resource Bounds
  // =========================================================================
  describe('Vector 2: Voice Audio Frame Fuzzing & Resource Bounds', () => {
    test('2.1 Odd byte length PCM16 frames across various sizes are immediately rejected with strict error', async () => {
      const oddSizes = [1, 3, 15, 101, 3201, 65535, 1_920_001];
      for (const size of oddSizes) {
        const events: any[] = [];
        let done!: () => void;
        const closed = new Promise<void>(r => done = r);
        const Bridge = createVoiceBridge({async start(){}, async transcribe(){ return ''; }});
        const voice = new Bridge({sendEvent(e: any){ events.push(e); }, close(){ done(); }}, {language: 'en'});
        await voice.start();
        voice.handleBrowserMessage(Buffer.alloc(size, 0xaa), true);
        await closed;
        const err = events.find(e => e.type === 'error');
        expect(err).toBeDefined();
        expect(err.message).toBe('Invalid PCM16 frame');
        expect(err.code).toBe('local_asr_error');
        expect(events.some(e => e.type === 'closed')).toBe(true);
      }
    });

    test('2.2 Single oversized audio frame (>1.92 MB) triggers immediate ceiling defense and halts stream', async () => {
      const events: any[] = [];
      let done!: () => void;
      const closed = new Promise<void>(r => done = r);
      const Bridge = createVoiceBridge({async start(){}, async transcribe(){ return ''; }});
      const voice = new Bridge({sendEvent(e: any){ events.push(e); }, close(){ done(); }}, {language: 'en'});
      await voice.start();
      // 1,920,002 bytes is even (valid PCM16 frame) but exceeds 1,920,000 ceiling
      voice.handleBrowserMessage(Buffer.alloc(1_920_002, 0x55), true);
      await closed;
      const err = events.find(e => e.type === 'error');
      expect(err).toBeDefined();
      expect(err.message).toBe('Local speech worker could not keep up with the audio stream');
      expect(err.code).toBe('local_asr_error');
      expect(events.some(e => e.type === 'closed')).toBe(true);
    });

    test('2.3 Incremental stream exceeding 1.92 MB buffer ceiling defense triggers on overflow chunk', async () => {
      const events: any[] = [];
      let done!: () => void;
      const closed = new Promise<void>(r => done = r);
      const Bridge = createVoiceBridge({async start(){}, async transcribe(){ return ''; }});
      const voice = new Bridge({sendEvent(e: any){ events.push(e); }, close(){ done(); }}, {language: 'en'});
      await voice.start();

      // Transmit 9 chunks of 200,000 bytes (1,800,000 bytes total, below ceiling)
      for (let i = 0; i < 9; i++) {
        voice.handleBrowserMessage(Buffer.alloc(200_000, 0x22), true);
      }
      expect(events.some(e => e.type === 'error')).toBe(false);

      // Transmit 10th chunk (now 2,000,000 bytes, exceeding ceiling)
      voice.handleBrowserMessage(Buffer.alloc(200_000, 0x22), true);
      await closed;

      const err = events.find(e => e.type === 'error');
      expect(err).toBeDefined();
      expect(err.message).toBe('Local speech worker could not keep up with the audio stream');
      expect(events.some(e => e.type === 'closed')).toBe(true);
    });

    test('2.4 Non-binary message fuzzing does not cause server exceptions or spurious errors', async () => {
      const events: any[] = [];
      const Bridge = createVoiceBridge({async start(){}, async transcribe(){ return ''; }});
      const voice = new Bridge({sendEvent(e: any){ events.push(e); }, close(){}}, {language: 'en'});
      await voice.start();

      const fuzzedStrings = [
        'not valid json',
        '{ truncated: ',
        '{"type": "not_stop"}',
        '{"type": 12345}',
        '{"__proto__": {"type": "stop"}}',
        '{"constructor": {"prototype": {"type": "stop"}}}',
        '',
        '\x00\x00',
        'x'.repeat(20_000),
      ];

      for (const s of fuzzedStrings) {
        voice.handleBrowserMessage(s, false);
      }
      expect(events.some(e => e.type === 'error')).toBe(false);
      voice.handleBrowserClose();
    });

    test('2.5 Offline privacy: dictation operates with zero OAuth or external network calls', async () => {
      let oauthAttempted = false;
      let networkAttempted = false;
      const events: any[] = [];
      let done!: () => void;
      const closed = new Promise<void>(r => done = r);

      const Bridge = createVoiceBridge({
        async start(){},
        async transcribe(pcm){
          return 'empirical challenger verified offline';
        },
      });

      const options = {
        get getAccessToken() {
          oauthAttempted = true;
          throw new Error('OAuth access token requested during local dictation!');
        },
        get fetch() {
          networkAttempted = true;
          throw new Error('Network fetch called during local dictation!');
        },
        language: 'en',
      };

      const voice = new Bridge({
        sendEvent(e: any){ events.push(e); },
        close(){ done(); },
      }, options);

      await voice.start();
      voice.handleBrowserMessage(Buffer.alloc(3200, 0x11), true);
      voice.handleBrowserMessage('{"type":"stop"}', false);
      await closed;

      expect(oauthAttempted).toBe(false);
      expect(networkAttempted).toBe(false);
      expect(events.map(e => e.type)).toEqual(['ready', 'transcript', 'closed']);
      expect(events[1].text).toBe('empirical challenger verified offline');
    });
  });

  // =========================================================================
  // 3. Packaging & Codesign Integrity Verification
  // =========================================================================
  describe('Vector 3: Packaging & Codesign Integrity Verification', () => {
    test('3.1 /Applications/Chimeric.app codesignature is valid and untampered', () => {
      const res = spawnSync('codesign', ['--verify', '--deep', '--verbose=4', '/Applications/Chimeric.app'], {
        encoding: 'utf-8',
      });
      expect(res.status).toBe(0);
      const combined = (res.stdout + '\n' + res.stderr);
      expect(combined).toContain('valid on disk');
      expect(combined).toContain('satisfies its Designated Requirement');
    });

    test('3.2 /Applications/Chimeric.app contains required bundle structure & Mach-O executable', () => {
      const appPath = '/Applications/Chimeric.app';
      const infoPlist = join(appPath, 'Contents/Info.plist');
      const macosBin = join(appPath, 'Contents/MacOS/Chimeric');
      const chimericBin = join(appPath, 'Contents/Resources/bin/chimeric');
      const runtimeJs = join(appPath, 'Contents/Resources/runtime/chimeric.js');

      expect(existsSync(infoPlist)).toBe(true);
      expect(existsSync(macosBin)).toBe(true);
      expect(existsSync(chimericBin)).toBe(true);
      expect(existsSync(runtimeJs)).toBe(true);

      const binStat = statSync(chimericBin);
      expect((binStat.mode & 0o111) !== 0).toBe(true); // Executable
    });

    test('3.3 dist/portable launcher script and linux binary have valid permissions and bindings', () => {
      const portableDir = resolve(__dirname, '../dist/portable');
      expect(existsSync(portableDir)).toBe(true);

      const chimericScript = join(portableDir, 'chimeric');
      const launcherMjs = join(portableDir, 'launcher.mjs');
      const linuxBin = join(portableDir, 'bin/chimeric');
      const bundleBuildJson = join(portableDir, 'BUNDLE-BUILD.json');

      expect(existsSync(chimericScript)).toBe(true);
      expect(existsSync(launcherMjs)).toBe(true);
      expect(existsSync(linuxBin)).toBe(true);
      expect(existsSync(bundleBuildJson)).toBe(true);

      // Verify executable bits
      const scriptStat = statSync(chimericScript);
      expect((scriptStat.mode & 0o111) !== 0).toBe(true);

      const binStat = statSync(linuxBin);
      expect((binStat.mode & 0o111) !== 0).toBe(true);

      // Verify launcher content
      const scriptContent = readFileSync(chimericScript, 'utf-8');
      expect(scriptContent).toContain('BUN_BE_BUN=1');
      expect(scriptContent).toContain('exec "$CHIMERIC_ROOT/bin/chimeric"');

      // Verify SHA-256 bindings in BUNDLE-BUILD.json
      const meta = JSON.parse(readFileSync(bundleBuildJson, 'utf-8'));
      expect(meta.platform).toBe('linux-x64');
      expect(meta.binarySha256).toBeDefined();

      const actualBinHash = createHash('sha256').update(readFileSync(linuxBin)).digest('hex');
      expect(actualBinHash).toBe(meta.binarySha256);
    });

    test('3.4 Docker container and seccomp configurations exist with unprivileged user & valid json', () => {
      const dockerfile = resolve(__dirname, '../Dockerfile');
      const seccompPath = resolve(__dirname, '../tools/docker-seccomp.json');

      expect(existsSync(dockerfile)).toBe(true);
      expect(existsSync(seccompPath)).toBe(true);

      const dockerContent = readFileSync(dockerfile, 'utf-8');
      expect(dockerContent).toContain('USER chimeric');
      expect(dockerContent).toContain('EXPOSE 18868 18869');

      const seccompDoc = JSON.parse(readFileSync(seccompPath, 'utf-8'));
      expect(seccompDoc.defaultAction).toBeDefined();
      expect(Array.isArray(seccompDoc.syscalls)).toBe(true);

      const unshareRule = seccompDoc.syscalls.find((s: any) => s.names && s.names.includes('unshare'));
      expect(unshareRule).toBeDefined();
      expect(unshareRule.action).toBe('SCMP_ACT_ALLOW');
    });
  });

  // =========================================================================
  // 4. Document Converters, Stream Ceilings, Media Fuzzing & Process Cleanup
  // =========================================================================
  describe('Vector 4: Document Converters, Stream Ceilings, Media Fuzzing & Process Cleanup', () => {
    const python = Bun.which('python3') || '/usr/bin/python3';

    test('4.1 Exact 20 MiB stream boundary: exact 20 MiB passes and 20 MiB + 1 byte strictly throws', async () => {
      // Exactly 20 MiB
      const exact = await processText([python, '-c', 'import sys; sys.stdout.write("A" * (20 * 1024 * 1024))']);
      expect(exact.length).toBe(20 * 1024 * 1024);

      // 20 MiB + 1 byte
      let threw = false;
      let errorMsg = '';
      try {
        await processText([python, '-c', 'import sys; sys.stdout.write("A" * (20 * 1024 * 1024 + 1))']);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      expect(threw).toBe(true);
      expect(errorMsg).toBe('document converter stdout output exceeds 20 MiB');
    });

    test('4.2 Stderr stream ceiling: output exceeding 20 MiB strictly throws', async () => {
      let threw = false;
      let errorMsg = '';
      try {
        await processText([python, '-c', 'import sys; sys.stderr.write("E" * (20 * 1024 * 1024 + 1))']);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      expect(threw).toBe(true);
      expect(errorMsg).toBe('document converter stderr output exceeds 20 MiB');
    });

    test('4.3 Infinite stream generator (yes) is halted and killed within 1.5s without leaking processes', async () => {
      const t0 = Date.now();
      let threw = false;
      let errorMsg = '';
      try {
        await processText(['yes', 'INFINITE_TEST_PATTERN']);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      const elapsed = Date.now() - t0;
      expect(threw).toBe(true);
      expect(errorMsg).toBe('document converter stdout output exceeds 20 MiB');
      expect(elapsed).toBeLessThan(2000);

      // Verify no orphaned yes process running
      const check = spawnSync('pgrep', ['-f', 'yes INFINITE_TEST_PATTERN'], {encoding: 'utf-8'});
      expect(check.stdout.trim()).toBe('');
    });

    test('4.4 Malformed PDF fuzzing: corrupted body, truncated header, and visual rendering handle cleanly', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-doc-pdf-'));
      const reader = new ContentReader(dir);
      try {
        // Corrupted PDF body
        const corruptPdf = Buffer.from('%PDF-1.4\nCorrupted binary \x00\x01\x02\xff\xfe garbage\n');
        let threw1 = false;
        let err1 = '';
        try {
          await reader.content({
            type: 'document',
            source: {type: 'base64', media_type: 'application/pdf', data: corruptPdf.toString('base64')},
          }, false);
        } catch (e: any) {
          threw1 = true;
          err1 = e.message;
        }
        expect(threw1).toBe(true);
        expect(err1).toContain('document conversion failed');

        // Truncated PDF header
        let threw2 = false;
        let err2 = '';
        try {
          await reader.content({
            type: 'document',
            source: {type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-').toString('base64')},
          }, false);
        } catch (e: any) {
          threw2 = true;
          err2 = e.message;
        }
        expect(threw2).toBe(true);
        expect(err2).toContain('document conversion failed');

        // Non-PDF data
        let threw3 = false;
        let err3 = '';
        try {
          await reader.content({
            type: 'document',
            source: {type: 'base64', media_type: 'application/pdf', data: Buffer.from('NOT_A_PDF').toString('base64')},
          }, false);
        } catch (e: any) {
          threw3 = true;
          err3 = e.message;
        }
        expect(threw3).toBe(true);
        expect(err3).toBe('document bytes do not contain a valid PDF header');

        // Malformed PDF with images: true
        let threw4 = false;
        try {
          await reader.content({
            type: 'document',
            source: {type: 'base64', media_type: 'application/pdf', data: corruptPdf.toString('base64')},
          }, true);
        } catch (e: any) {
          threw4 = true;
        }
        expect(threw4).toBe(true);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('4.5 Corrupted DOCX and ZIP fuzzing: random garbage, truncated zip, and missing document.xml handle cleanly', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-doc-docx-'));
      const reader = new ContentReader(dir);
      try {
        // Random binary garbage
        let threw1 = false;
        let err1 = '';
        try {
          await reader.content({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              data: Buffer.from('NOT_A_ZIP_RANDOM_GARBAGE_BYTES_12345').toString('base64'),
            },
          }, false);
        } catch (e: any) {
          threw1 = true;
          err1 = e.message;
        }
        expect(threw1).toBe(true);
        expect(err1).toContain('document conversion failed');

        // Truncated ZIP header
        let threw2 = false;
        let err2 = '';
        try {
          await reader.content({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/docx',
              data: Buffer.from('PK\x03\x04\x14\x00\x00\x00\x08\x00corrupt').toString('base64'),
            },
          }, false);
        } catch (e: any) {
          threw2 = true;
          err2 = e.message;
        }
        expect(threw2).toBe(true);
        expect(err2).toContain('document conversion failed');

        // Valid ZIP but without word/document.xml
        const zipFile = join(dir, 'test-not-docx.zip');
        spawnSync('python3', ['-c', `import zipfile; z = zipfile.ZipFile('${zipFile}', 'w'); z.writestr('other.txt', 'hello'); z.close()`]);
        const zipBytes = readFileSync(zipFile);
        let threw3 = false;
        let err3 = '';
        try {
          await reader.content({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/docx',
              data: zipBytes.toString('base64'),
            },
          }, false);
        } catch (e: any) {
          threw3 = true;
          err3 = e.message;
        }
        expect(threw3).toBe(true);
        expect(err3).toContain('document conversion failed');
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('4.6 Unsupported document media types are strictly rejected', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-doc-mime-'));
      const reader = new ContentReader(dir);
      const unsupported = ['application/zip', 'video/mp4', 'audio/mpeg', 'application/x-executable'];
      try {
        for (const mime of unsupported) {
          let threw = false;
          let err = '';
          try {
            await reader.content({
              type: 'document',
              source: {type: 'base64', media_type: mime, data: Buffer.from('test').toString('base64')},
            }, false);
          } catch (e: any) {
            threw = true;
            err = e.message;
          }
          expect(threw).toBe(true);
          expect(err).toBe(`unsupported document media type: ${mime}`);
        }
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('4.7 Image format validation strictly rejects malformed and truncated images', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-img-val-'));
      const reader = new ContentReader(dir);
      try {
        const tests = [
          {mime: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])}, // truncated PNG
          {mime: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0x00, 0x00])}, // JPEG without EOI 0xff 0xd9
          {mime: 'image/gif', data: Buffer.from('GIF89a\x00\x00\x00\x00\x00\x00\x00\x00;')}, // 0 width/height GIF
          {mime: 'image/webp', data: Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ') }, // Truncated WebP
        ];
        for (const t of tests) {
          let threw = false;
          let err = '';
          try {
            await reader.content({
              type: 'image',
              source: {type: 'base64', media_type: t.mime, data: t.data.toString('base64')},
            }, true);
          } catch (e: any) {
            threw = true;
            err = e.message;
          }
          expect(threw).toBe(true);
          expect(err).toBe('image bytes do not match the declared image media type');
        }
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('4.8 Staging directories are 100% cleaned up with zero disk leakage after failures', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-stage-leak-'));
      const reader = new ContentReader(dir);
      try {
        // Trigger multiple failing document operations
        for (let i = 0; i < 5; i++) {
          try {
            await reader.content({
              type: 'document',
              source: {type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-corrupt').toString('base64')},
            }, false);
          } catch {}
          try {
            await reader.content({
              type: 'document',
              source: {type: 'base64', media_type: 'application/docx', data: Buffer.from('corrupt').toString('base64')},
            }, false);
          } catch {}
        }
        const remaining = readdirSync(dir);
        expect(remaining.length).toBe(0);
      } finally {
        rmSync(dir, {recursive: true, force: true});
      }
    });

    test('4.9 Long-running converter with background child process is terminated with SIGKILL across the process group and does not hang', async () => {
      const t0 = Date.now();
      let threw = false;
      let errorMsg = '';
      try {
        // Spawn a command that starts a background grandchild process and sleeps
        await processText(['sh', '-c', 'sleep 5 & sleep 10'], undefined, 300);
      } catch (err: any) {
        threw = true;
        errorMsg = err.message;
      }
      const elapsed = Date.now() - t0;
      expect(threw).toBe(true);
      expect(errorMsg).toContain('document conversion timed out after 0.3 seconds');
      // The timeout was 300ms. If process group is cleanly killed, execution terminates in < 1500ms.
      // If process group is not killed and background grandchildren keep pipes open, it hangs for 5+ seconds.
      expect(elapsed).toBeLessThan(1500);
    });
  });
});
