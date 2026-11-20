import {afterEach, expect, test} from 'bun:test';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {nativeRequestOptionsEdit} from '../tools/native-session-context';

const method = `_requestOptions(e,t={}){let n={};if(e.finalHeaders)n.headers=e.finalHeaders;if(e.signal)n.signal=e.signal;if(e.freshConnection)n.fetchOptions={keepalive:!1};if(t.streaming)n.fetchOptions={...n.fetchOptions??{},timeout:!1},n.timeout=Math.max(uye,Math.ceil(t.firstEventBudgetMs??0));return n}`;
const fixture = `class Provider {${method}}`;
const patch = (source: string, timeout = 'uye') => {
  const node = (parse(source).program.body[0] as t.ClassDeclaration).body.body[0] as t.ClassMethod;
  const edit = nativeRequestOptionsEdit(node, source, timeout);
  return {edit, source: source.slice(0, edit.start) + edit.text + source.slice(edit.end)};
};
const originalGlobal = (globalThis as any).__scienceLocal;
afterEach(() => {
  if (originalGlobal === undefined) delete (globalThis as any).__scienceLocal;
  else (globalThis as any).__scienceLocal = originalGlobal;
});
const provider = (callback: (...args: any[]) => any) => {
  (globalThis as any).__scienceLocal = {requestOptions: callback};
  return Function('uye', `${patch(fixture).source};return new Provider`)(1000);
};

test('Only the final return value changes, and the callback receives native objects synchronously', () => {
  const {source, edit} = patch(fixture);
  expect(edit.label).toBe('native-session-request-options');
  expect(source).toBe(fixture.replace('return n}', 'return globalThis.__scienceLocal.requestOptions(e,t,n)}'));
  parse(source);
  const headers = {'x-native': 'kept'}, signal = new AbortController().signal;
  const request = {frameId: 'native-frame', finalHeaders: headers, signal, freshConnection: true};
  const settings = {streaming: true, firstEventBudgetMs: 2500.1};
  let received: any[] = [];
  const marker = {headers: {'x-chimeric-context': 'opaque-test-proof'}};
  const value = provider((...args) => {received = args; return marker;})._requestOptions(request, settings);
  expect(value).toBe(marker);
  expect(value).not.toBeInstanceOf(Promise);
  expect(received[0]).toBe(request);
  expect(received[1]).toBe(settings);
  expect(received[2]).toEqual({headers, signal, fetchOptions: {keepalive: false, timeout: false}, timeout: 2501});
  expect(received[2].headers).toBe(headers);
  expect(received[2].signal).toBe(signal);
  expect(request).toEqual({frameId: 'native-frame', finalHeaders: headers, signal, freshConnection: true});
});

test('Native defaults, non-streaming options and first-event budgets retain their behavior', () => {
  const instance = provider((_request, _settings, nativeOptions) => nativeOptions);
  expect(instance._requestOptions({})).toEqual({});
  expect(instance._requestOptions({freshConnection: true})).toEqual({fetchOptions: {keepalive: false}});
  expect(instance._requestOptions({}, {streaming: true})).toEqual({fetchOptions: {timeout: false}, timeout: 1000});
  expect(instance._requestOptions({}, {streaming: true, firstEventBudgetMs: 500})).toEqual({fetchOptions: {timeout: false}, timeout: 1000});
  expect(instance._requestOptions({}, {streaming: false, firstEventBudgetMs: 5000})).toEqual({});
});

test('A trusted context rejection propagates before the SDK receives any options', () => {
  const failure = new Error('Native frame is not owned by this session');
  const instance = provider(() => {throw failure;});
  expect(() => instance._requestOptions({frameId: 'unowned'})).toThrow(failure);
});

test('Native field changes, extra behavior and duplicate patching fail the boundary check', () => {
  for (const source of [
    fixture.replace('e.finalHeaders', 'e.headers'),
    fixture.replace('if(e.signal)', 'if(t.signal)'),
    fixture.replace('keepalive:!1', 'keepalive:!0'),
    fixture.replace('timeout:!1', 'timeout:!0'),
    fixture.replace('Math.ceil', 'Math.floor'),
    fixture.replace('return n', 'n.extra=true;return n'),
    fixture.replace('return n', 'return {...n}'),
    fixture.replace('_requestOptions(', 'async _requestOptions('),
    fixture.replace('t={}', 't={streaming:true}'),
    patch(fixture).source,
  ]) expect(() => patch(source)).toThrow('boundary changed');
  expect(() => patch(fixture, 'differentTimeout')).toThrow('boundary changed');
  expect(() => patch(fixture, 'uye);untrusted()')).toThrow('boundary changed');
});

test('Revision-provided timeout symbols and minified local names are checked without hardcoding Darwin names', () => {
  const source = fixture.replaceAll('uye', 'pye');
  expect(patch(source, 'pye').source).toContain('requestOptions(e,t,n)');
  const renamed = fixture.replaceAll(/\be\b/g, 'request').replaceAll(/\bt\b/g, 'options').replaceAll(/\bn\b/g, 'result');
  expect(patch(renamed).source).toContain('requestOptions(request,options,result)');
  expect(() => patch(renamed.replaceAll(/\brequest\b/g, 'globalThis'))).toThrow('boundary changed');
});

const nativePath = resolve(import.meta.dir, '../../../work/runtime-recovery/original/claude-science');
test.skipIf(!existsSync(nativePath))('The signed native source has exactly the checked method and two synchronous callers', () => {
  const source = readFileSync(nativePath, 'utf8');
  expect(source.split(method)).toHaveLength(2);
  expect(patch(`class Provider {${source.slice(source.indexOf(method), source.indexOf(method) + method.length)}}`).source)
    .toContain('requestOptions(e,t,n)');
  expect(source.split('this._requestOptions(c)')).toHaveLength(2);
  expect(source.split('this._requestOptions(t,{streaming:!0,firstEventBudgetMs:c})')).toHaveLength(2);
  expect(source).toContain('frameId:t.frameId,callSite:t.callSite');
  expect(source).toContain('new Hd({agentName:this.agent_name,frameId:this.frame_id,rootFrameId:this.root_frame_id,projectId:this.project_id');
  expect(source).toContain('callSite:this.agentName.toUpperCase()==="REVIEWER"?"reviewer":"agent_loop",frameId:this.frameId}');
  expect(source).toContain('metadata:this._apiMetadata("fold"),frameId:this.frameId,callSite:"compaction",stripCacheMarkers:!0');
  expect(source).toContain('e.get("/api/voice/stream",{websocket:!0,exposeHeadRoute:!1},(r,o)=>');
  expect(source).toContain('new dir(c,{getAccessToken:()=>e8c(n),language:l,log:{warn:(u)=>e.log.warn(u)}})');
});
