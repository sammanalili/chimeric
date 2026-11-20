import {expect, test} from 'bun:test';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from '@babel/parser';

const archive = resolve(import.meta.dir, '../../../work/runtime-recovery/original/assets.tar-j2zctwzf.gz');
const tool = resolve(import.meta.dir, '../tools/brand-frontend.mjs');
const fixtureTest = existsSync(archive) ? test : test.skip;
const original = () => {
  const result = Bun.spawnSync(['/usr/bin/tar', '-xOf', archive, './web-dist/assets/index-BgpYmw3d.js'], {stdout: 'pipe', stderr: 'pipe'});
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
};
const brand = (source: string) => Bun.spawnSync([process.execPath, tool], {
  env: {...process.env, BUN_BE_BUN: '1'},
  stdin: Buffer.from(JSON.stringify([{name: './web-dist/assets/index-BgpYmw3d.js', text: source}])),
  stdout: 'pipe', stderr: 'pipe',
});
let brandedHook = '';
function hook() {
  if (brandedHook) return brandedHook;
  const transformed = brand(original());
  expect(transformed.exitCode).toBe(0);
  const source = JSON.parse(transformed.stdout.toString()).files[0].text;
  expect(source).not.toContain('transcribed by your Chimeric account');
  expect(source).not.toContain('browser transcription (fallback');
  const matches = parse(source, {sourceType: 'module'}).program.body.filter((node: any) => node.type === 'FunctionDeclaration' && node.id?.name === 'EFt');
  expect(matches).toHaveLength(1);
  return brandedHook = source.slice(matches[0].start, matches[0].end);
}

function render(throwOnConnect = false) {
  const events: any[] = [], engines: any[] = [], options: any[] = [];
  let cancellations = 0, releases = 0, browserCalls = 0;
  const bridge = {cancel() {cancellations++;}};
  const f = {
    useState(value: any) {const initial = typeof value === 'function' ? value() : value; return [initial, (next: any) => engines.push(next)];},
    useReducer() {return [{status: 'idle'}, (event: any) => events.push(event)];},
    useRef(value: any) {return {current: value};}, useCallback(value: any) {return value;}, useEffect() {},
  };
  const globals = {
    f, K$t() {}, q$t: {}, A9() {browserCalls++; throw new Error('Browser speech must not be called');},
    Ud: null, L1: false, pFt() {}, qf() {releases++;},
    nFt(value: any) {if (throwOnConnect) throw new Error('Bridge rejected'); options.push(value); return bridge;},
    Iae: (value: string) => value,
  };
  const value = Function(...Object.keys(globals), `${hook()};return EFt({onText(){},getPrecedingText(){return ""},onInterim(){}});`)(...Object.values(globals));
  return {value, events, engines, options, browserCalls: () => browserCalls, cancellations: () => cancellations, releases: () => releases};
}

fixtureTest('The checked native hook contains no browser recognition constructor or fallback selection', () => {
  const source = hook();
  expect(source).not.toContain('A9()');
  expect(source).not.toContain('new G');
  expect(source).not.toContain('webspeech');
  expect(source).toContain('nFt({');
  expect(source).toContain('m({type:"fail",message:oe})');
  const japanese = JSON.parse(readFileSync(resolve(import.meta.dir, '../src/ja.json'), 'utf8'));
  expect(japanese['Voice transcription failed. Check the selected transcription connection and try again.']).toContain('文字起こし');
}, 15000);

fixtureTest('Capture failure and pre-ready close show local failure and release ownership without choosing browser speech', () => {
  for (const failure of ['capture', 'upstream', 'close', 'throw']) {
    const ui = render(failure === 'throw');
    expect(ui.value.supported).toBe(true);
    ui.value.start();
    if (failure === 'capture') ui.options[0].onError('Capture failed', 'capture_failed');
    if (failure === 'upstream') ui.options[0].onError('Unavailable', 'upstream_unavailable');
    if (failure === 'close') ui.options[0].onClose();
    const last = ui.events.at(-1);
    expect(last.type).toBe('fail');
    expect(last.message).toContain('selected transcription connection');
    expect(ui.value.isActive()).toBe(false);
    expect(ui.releases()).toBe(1);
    expect(ui.browserCalls()).toBe(0);
    expect(ui.engines).not.toContain('webspeech');
    if (failure !== 'throw') expect(ui.cancellations()).toBe(failure === 'close' ? 0 : 1);
  }
}, 15000);

fixtureTest('A failure after bridge readiness retains the original bridge error message', () => {
  const ui = render(); ui.value.start(); ui.options[0].onReady();
  ui.options[0].onError('The selected destination was disconnected.', 'policy_changed');
  expect(ui.events.at(-1)).toEqual({type: 'fail', message: 'The selected destination was disconnected.'});
  expect(ui.value.isActive()).toBe(false);
  expect(ui.browserCalls()).toBe(0);
}, 15000);

fixtureTest('Any drift in the signed fallback hook stops frontend transformation', () => {
  const changed = brand(original().replace('ne.continuous=!0', 'ne.continuous=!1'));
  expect(changed.exitCode).not.toBe(0);
  expect(changed.stderr.toString()).toContain('Native dictation fallback boundary changed');
}, 15000);
