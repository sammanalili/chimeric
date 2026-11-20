import {afterEach, expect, test} from 'bun:test';
import {parse} from '@babel/parser';
import * as t from '@babel/types';
import {AsyncLocalStorage} from 'node:async_hooks';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeRevision} from '../tools/native-revisions';
import {nativeScopeEdits, nativeMetadataEdit, nativeTaskScopeEdit, nativeRunnerScopeEdit, nativeJobScopeEdit, nativeFetchScopeEdit, type NativeScopeEdit} from '../tools/native-scope-patches';

const paths = {
  darwin: resolve(import.meta.dir, '../../../work/runtime-recovery/original/claude-science'),
  linux: resolve(import.meta.dir, '../../../work/chimeric-linux-probe/recovered-production-reader/claude-science'),
};
type Fixture = {source: string; edits: NativeScopeEdit[]; functions: Map<string, t.FunctionDeclaration>; nodes: Map<string, t.FunctionDeclaration | t.ClassMethod>; raw: t.CallExpression[]};
const cached = new Map<string, Fixture>();
function fixture(platform: keyof typeof paths) {
  if (cached.has(platform)) return cached.get(platform)!;
  const source = readFileSync(paths[platform], 'utf8');
  expect(nativeRevision(createHash('sha256').update(source).digest('hex')).platform).toBe(platform === 'darwin' ? 'darwin-arm64' : 'linux-x64');
  const ast = parse(source, {sourceType: 'unambiguous'}), edits = nativeScopeEdits(ast, source);
  const functions = new Map<string, t.FunctionDeclaration>(), nodes = new Map<string, t.FunctionDeclaration | t.ClassMethod>(), raw: t.CallExpression[] = [];
  t.traverseFast(ast, node => {
    if (t.isFunctionDeclaration(node) && node.id) functions.set(node.id.name, node);
    if (t.isFunctionDeclaration(node) || t.isClassMethod(node)) for (const edit of edits) {
      if (edit.start >= node.start! && edit.end <= node.end!) {
        const previous = nodes.get(edit.label);
        if (!previous || node.end! - node.start! < previous.end! - previous.start!) nodes.set(edit.label, node);
      }
    }
    if (t.isCallExpression(node) && t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property, {name: 'create'}) &&
        t.isMemberExpression(node.callee.object) && t.isIdentifier(node.callee.object.property, {name: 'messages'})) raw.push(node);
  });
  const value = {source, edits, functions, nodes, raw}; cached.set(platform, value); return value;
}
const slice = (value: Fixture, node: t.Node) => value.source.slice(node.start!, node.end!);
const patched = (value: Fixture, label: string) => {
  const node = value.nodes.get(label)!, edit = value.edits.find(edit => edit.label === label)!;
  return value.source.slice(node.start!, edit.start) + edit.text + value.source.slice(edit.end, node.end!);
};
const fnName = (source: string) => (parse(source).program.body[0] as t.FunctionDeclaration).id!.name;
const compile = (source: string, globals: Record<string, unknown>) => Function(...Object.keys(globals), `${source};return ${fnName(source)}`)(...Object.values(globals));
const method = (source: string, globals: Record<string, unknown>) => Function(...Object.keys(globals), `return new class {${source}}`)(...Object.values(globals));
const originalGlobal = (globalThis as any).__scienceLocal;
afterEach(() => {
  if (originalGlobal === undefined) delete (globalThis as any).__scienceLocal;
  else (globalThis as any).__scienceLocal = originalGlobal;
});

for (const platform of ['darwin', 'linux'] as const) {
  const nativeTest = existsSync(paths[platform]) ? test : test.skip;
  nativeTest(`${platform}: the actual original AST contains five unique supported scope boundaries`, () => {
    const value = fixture(platform);
    expect(value.edits.map(edit => edit.label).sort()).toEqual(['native-scope-agent-job', 'native-scope-metadata', 'native-scope-runner', 'native-scope-sdk-fetch', 'native-scope-task']);
    for (const edit of value.edits) {
      const result = patched(value, edit.label), node = value.nodes.get(edit.label)!;
      parse(t.isClassMethod(node) ? `class Native{${result}}` : result);
    }
    const sorted = [...value.edits].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
  }, 20000);

  nativeTest(`${platform}: metadata signing receives original identifiers and preserves the native user_id and validation`, () => {
    const value = fixture(platform), node = value.nodes.get('native-scope-metadata') as t.FunctionDeclaration;
    const regex = (node.body.body[1] as any).test.argument.callee.object.name, calls: any[] = [];
    (globalThis as any).__scienceLocal = {nativeMetadata(input: any, metadata: any) {calls.push({input, metadata}); return {...metadata, local_test_proof: 'signed-synthetic-proof'};}};
    const globals = {[regex]: /^[a-z0-9]{1,6}$/};
    const original = compile(slice(value, node), globals), signed = compile(patched(value, 'native-scope-metadata'), globals);
    const input = {sessionId: '11111111-2222-3333-4444-555555555555', frameId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', lane: 'ttl'};
    const result = signed(input);
    expect(calls).toHaveLength(1); expect(calls[0].input).toBe(input);
    expect(calls[0].input.frameId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(result.user_id).toBe(original(input).user_id); expect(result.local_test_proof).toBe('signed-synthetic-proof');
    expect(JSON.parse(result.user_id)).toEqual({session_id: '11111111222233334444555555555555:aaaaaaaabbbbccccddddeeee:ttl', frame_id: 'aaaaaaaabbbbccccddddeeeeeeeeeeee'});
    expect(() => signed({...input, lane: 'bad-lane'})).toThrow('must match');
    expect(() => signed({...input, sessionId: 'x'.repeat(100)})).toThrow('exceeds 64'); expect(calls).toHaveLength(1);
  });

  nativeTest(`${platform}: native task, runner and complete job retain nested async scope and provider context`, async () => {
    const value = fixture(platform), frames = new AsyncLocalStorage<string>(), nativeTasks = new AsyncLocalStorage<any>(), providers: any[] = [], seen: any[] = [];
    (globalThis as any).__scienceLocal = {withFrame(frameId: string | null, callback: () => any) {return frameId === null ? callback() : frames.run(frameId, callback);}};
    const taskNode = value.nodes.get('native-scope-task') as t.FunctionDeclaration;
    const taskStorage = (taskNode.body.body[0] as any).argument.callee.object.name;
    const taskSource = patched(value, 'native-scope-task'), task = compile(taskSource, {[taskStorage]: nativeTasks});
    const runner = method(patched(value, 'native-scope-runner'), {[taskNode.id!.name]: task});
    runner.frame_id = 'native-child'; runner.root_frame_id = 'native-root';
    runner._runInner = async () => {await Promise.resolve(); seen.push([frames.getStore(), nativeTasks.getStore()]); return 'native result';};
    const jobNode = value.nodes.get('native-scope-agent-job') as t.ClassMethod;
    const providerContext = (jobNode.body.body[0] as any).argument.callee.name;
    const job = method(patched(value, 'native-scope-agent-job'), {[providerContext]: (value: any, callback: () => any) => {providers.push(value); return callback();}});
    job.services = {providers: {synthetic: true}};
    job._executeRequestInner = async (input: any) => {
      expect(input.frame_id).toBe('native-child'); expect(frames.getStore()).toBe('native-child');
      const result = await runner.run({synthetic: true});
      await new Promise<void>(resolve => queueMicrotask(() => {seen.push(['post-run', frames.getStore()]); resolve();}));
      return result;
    };
    expect(await job.executeRequest({frame_id: 'native-child', root_frame_id: 'native-root'})).toBe('native result');
    expect(seen).toEqual([['native-child', {taskSource: null, rootFrameId: 'native-root'}], ['post-run', 'native-child']]);
    expect(providers).toEqual([job.services.providers]); expect(frames.getStore()).toBeUndefined(); expect(nativeTasks.getStore()).toBeUndefined();
    await task('memory', async () => {await Promise.resolve(); expect(frames.getStore()).toBe('memory-root'); expect(nativeTasks.getStore()).toEqual({taskSource: 'memory', rootFrameId: 'memory-root'});}, 'memory-root');
  });

  nativeTest(`${platform}: both native fetch paths invoke the scope hook and preserve request data and proxy policy`, async () => {
    const value = fixture(platform), node = value.nodes.get('native-scope-sdk-fetch') as t.FunctionDeclaration;
    const hostCheck = (node.body.body[0] as any).test.argument.callee.name, proxy = (node.body.body.at(-1) as any).argument.callee.name;
    const requests: any[] = [], wrapped: any[] = [], proxies: any[] = [];
    (globalThis as any).__scienceLocal = {scopeFetch(fetchImpl: Function) {wrapped.push(fetchImpl); return (input: any, options: any) => fetchImpl(input, {...options, headers: {...options.headers, 'x-chimeric-context': 'synthetic-proof'}});}};
    const transport = compile(patched(value, 'native-scope-sdk-fetch'), {[hostCheck]: (hostname: string) => hostname === 'proxy.example.invalid', [proxy]: (hosts: string[], callback: Function, env: any) => {proxies.push({hosts, env}); return callback();}});
    const fetchImpl = async (input: any, options: any) => {requests.push({input, options}); return 'synthetic response';};
    const signal = new AbortController().signal, options = {method: 'POST', body: 'synthetic body', signal, headers: {'x-native': 'retained'}}, env = {synthetic: 'environment'};
    for (const hostname of ['ordinary.example.invalid', 'proxy.example.invalid']) {
      const input = `https://${hostname}/v1/messages`;
      expect(await transport(fetchImpl, new URL(input), input, options, env)).toBe('synthetic response');
    }
    expect(wrapped).toEqual([fetchImpl, fetchImpl]); expect(requests[0].options).toEqual({...options, headers: {'x-native': 'retained', 'x-chimeric-context': 'synthetic-proof'}});
    expect(requests[1].options).toEqual({...requests[0].options, proxy: false}); expect(requests[1].options.signal).toBe(signal);
    expect(proxies).toEqual([{hosts: ['proxy.example.invalid'], env}]); expect(options.headers).toEqual({'x-native': 'retained'});
    (globalThis as any).__scienceLocal.scopeFetch = () => () => {throw new Error('Synthetic scope rejection');};
    for (const hostname of ['ordinary.example.invalid', 'proxy.example.invalid']) expect(() => transport(fetchImpl, new URL(`https://${hostname}`), hostname, options, env)).toThrow('Synthetic scope rejection');
    expect(requests).toHaveLength(2);
  });
}

const darwinTest = existsSync(paths.darwin) ? test : test.skip;
darwinTest('the actual prepared-request, serialization and raw SDK bodies preserve signed metadata', () => {
  const value = fixture('darwin'), functions = value.functions;
  const normalize = compile(slice(value, functions.get('tB')!), {tE: (text: string) => text.toWellFormed()});
  const nativeBody = compile(slice(value, functions.get('K3r')!), {tB: normalize});
  const globals = {Ure() {}, ge: () => ({max_tokens: 4096}), qR: () => 4096, wta: () => [], Pon: () => null, mta: () => false, vta: () => undefined, bta: () => false, CE() {}, Hea: 'beta-a', Qea: 'beta-b', snn: () => false, H3r: () => false, mon: 'agent', Lre: 'helper', CLe: 'kernel', S_e: () => null, nY: () => undefined, xJe: () => false, E_e: () => false, Fon: () => ({body: {}, headers: {}, beta: null}), aye: () => ({}), hct: (messages: any) => messages, Eon: (messages: any) => messages, nDr: (messages: any) => messages, yta: (system: any) => system, sDr: () => null};
  const prepare = compile(slice(value, functions.get('act')!), globals);
  const metadata = {user_id: '{"session_id":"synthetic"}', local_test_proof: 'signed-synthetic-proof'};
  const prepared = prepare([{role: 'user', content: 'synthetic\uD800'}], {metadata, frameId: 'native-child'}, 'synthetic-model', undefined);
  expect(prepared.kwargs.metadata).toBe(metadata); expect(prepared.frameId).toBe('native-child');
  const body = nativeBody(prepared); expect(body.metadata).toEqual(metadata); expect(body.messages[0].content).toBe('synthetic\uFFFD');
  expect(body.frameId).toBeUndefined(); expect(body.kwargs).toBeUndefined();
  expect(JSON.parse(JSON.stringify(body)).metadata.local_test_proof).toBe('signed-synthetic-proof');
  const rawBodies = value.raw.map(call => call.arguments[0]).filter(t.isCallExpression).filter(call => t.isObjectExpression(call.arguments[0])).map(call => call.arguments[0] as t.ObjectExpression);
  const property = (body: t.ObjectExpression, name: string) => body.properties.find(value => t.isObjectProperty(value) && t.isIdentifier(value.key, {name})) as t.ObjectProperty | undefined;
  const classifier = rawBodies.find(body => t.isMemberExpression(property(body, 'metadata')?.value) && slice(value, property(body, 'metadata')!.value) === 'e.metadata' && property(body, 'tool_choice'))!;
  expect(classifier).toBeDefined(); expect(slice(value, property(classifier, 'metadata')!.value)).toBe('e.metadata');
  const auto = rawBodies.find(body => slice(value, property(body, 'metadata')?.value ?? body).includes('lane:"amc"'))!;
  expect(auto).toBeDefined(); expect(slice(value, property(auto, 'metadata')!.value)).toBe('uu({sessionId:e.rootFrameId,frameId:e.frameId,lane:"amc"})');
  const evaluate = (body: t.ObjectExpression, globals: Record<string, unknown>) => Function(...Object.keys(globals), `return ${slice(value, body)}`)(...Object.values(globals));
  const messages = [{role: 'user', content: 'synthetic'}], classifierBody = evaluate(classifier, {Ug: () => ({}), e: {model: 'synthetic-model', systemPrompt: 'synthetic', metadata}, Ima: 512, l: false, rye: () => null, d: messages, Lre: 'helper', C_e: () => 'synthetic system', Pma: {name: 'synthetic-tool'}, z3e: 'synthetic-tool'});
  expect(classifierBody.metadata).toBe(metadata); expect(normalize(classifierBody).metadata.local_test_proof).toBe('signed-synthetic-proof');
  const captured: any[] = [];
  (globalThis as any).__scienceLocal = {nativeMetadata(input: any, original: any) {captured.push(input); return {...original, local_test_proof: 'signed-auto-proof'};}};
  const signed = compile(patched(value, 'native-scope-metadata'), {QWr: /^[a-z0-9]{1,6}$/});
  const autoBody = evaluate(auto, {r: 'synthetic-model', gOn: 512, n: {}, rye: () => null, C: messages, Lre: 'helper', C_e: () => 'synthetic system', u: 'synthetic prompt', wOn: {name: 'synthetic-tool'}, xvt: 'synthetic-tool', e: {rootFrameId: 'native-root', frameId: 'native-child'}, uu: signed, k: {body: {program_use_case_id: 'synthetic-case'}}});
  expect(captured).toEqual([{sessionId: 'native-root', frameId: 'native-child', lane: 'amc'}]);
  expect(JSON.parse(JSON.stringify(normalize(autoBody))).metadata.local_test_proof).toBe('signed-auto-proof');
  // The later native use-case body spread cannot replace metadata in this revision.
  const useCaseSource = slice(value, functions.get('Fon')!);
  for (const enabled of [true, false]) {
    const useCase = compile(useCaseSource, {UVt: () => enabled, aDr: () => false, dct: 'synthetic-beta', dDr: 'synthetic-header'});
    expect(useCase('synthetic-case', 'synthetic-account').body).not.toHaveProperty('metadata');
  }
});

darwinTest('the signed native SDK factories both reach the checked fetch boundary, and HTTP metadata follows ownership checks', () => {
  const value = fixture('darwin'), text = (name: string) => slice(value, value.functions.get(name)!);
  expect(value.source).toContain('Son=uon(ita)'); expect(text('PP')).toContain('fetch:Son');
  expect(text('Fma')).toContain('fetch:nct()'); expect(text('nct')).toContain('lon=uon()');
  expect(text('uon').match(/aon\(/g)).toHaveLength(3);
  expect(text('i5l').indexOf('await rl(e.db,r,n.user_id,e.dbRo)')).toBeLessThan(text('i5l').indexOf('metadata:uu('));
  expect(text('$fs').indexOf('await Kyt(e.db,r,n.user_id,e.dbRo)')).toBeLessThan(text('$fs').indexOf('metadata:uu('));
  expect(text('$fs')).toContain('let[a,l]=i'); expect(text('$fs')).toContain('sessionId:a.root_frame_id,frameId:a.frame_id');
  expect(value.source).toContain('new $Se({root_frame_id:t,frame_id:n,parent_frame_id:d,project_id:r');
});

darwinTest('changed or duplicate actual native scope boundaries stop the build', () => {
  const value = fixture('darwin');
  const parseFunction = (text: string) => parse(text).program.body[0] as t.FunctionDeclaration;
  const parseMethod = (text: string) => (parse(`class Native{${text}}`).program.body[0] as t.ClassDeclaration).body.body[0] as t.ClassMethod;
  const metadata = slice(value, value.nodes.get('native-scope-metadata')!);
  const task = slice(value, value.nodes.get('native-scope-task')!);
  const runner = slice(value, value.nodes.get('native-scope-runner')!);
  const job = slice(value, value.nodes.get('native-scope-agent-job')!);
  const fetch = slice(value, value.nodes.get('native-scope-sdk-fetch')!);
  for (const changed of [metadata.replace('i.length>64', 'i.length>128'), patched(value, 'native-scope-metadata')]) expect(() => nativeMetadataEdit(parseFunction(changed), changed)).toThrow('boundary changed');
  const badTask = task.replace('rootFrameId:n', 'rootFrameId:e'); expect(() => nativeTaskScopeEdit(parseFunction(badTask), badTask)).toThrow('boundary changed');
  const badRunner = runner.replace('this._runInner(e)', 'this._runInner(e.extra)'); expect(() => nativeRunnerScopeEdit(parseMethod(badRunner), badRunner)).toThrow('boundary changed');
  const badJob = job.replace('this.services.providers', 'e.providers'); expect(() => nativeJobScopeEdit(parseMethod(badJob), badJob)).toThrow('boundary changed');
  const badFetch = fetch.replace('proxy:!1', 'proxy:!0'); expect(() => nativeFetchScopeEdit(parseFunction(badFetch), badFetch)).toThrow('boundary changed');
  const complete = [metadata, task, fetch, `class NativeRunner{${runner}}`, `class NativeJob{${job}}`].join('\n');
  expect(nativeScopeEdits(parse(complete), complete)).toHaveLength(5);
  const missing = complete.replace(metadata, ''), duplicate = complete + '\n' + task.replace('function fh(', 'function duplicate(');
  expect(() => nativeScopeEdits(parse(missing), missing)).toThrow('Missing or ambiguous');
  expect(() => nativeScopeEdits(parse(duplicate), duplicate)).toThrow('Missing or ambiguous');
});
