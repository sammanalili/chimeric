import {test, expect} from 'bun:test';
import {MEMORY_CLASSIFIER_SYSTEM, memoryClassifierInput, memoryClassifierOptions} from '../src/memory-classifier';
import {Registry} from '../src/registry';
import {startBridge} from '../src/bridge';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

test('The memory request keeps cancellation and identity while disabling optional reasoning', () => {
  const signal = new AbortController().signal, metadata = {frame_id: 'synthetic'};
  const options = memoryClassifierOptions({model: 'role-medium', maxTokens: 512, system: 'old', signal, metadata,
    classifierQueue: true, noPrefillContinuation: true, effort: 'high', thinking: {type: 'adaptive'}, extra: {temperature: 1}},
    () => ({reasoning: true, compat: {thinkingFormat: 'qwen-chat-template'}, maxTokens: 16384}));
  expect(options).toMatchObject({model: 'role-medium', maxTokens: 4096, system: MEMORY_CLASSIFIER_SYSTEM,
    classifierQueue: true, noPrefillContinuation: true, thinking: {type: 'disabled'}, extra: {temperature: 1}});
  expect(options.effort).toBeUndefined(); expect(options.signal).toBe(signal); expect(options.metadata).toBe(metadata);
  expect(options.system.length).toBeLessThan(2500);
});

test('Mandatory reasoning uses the lowest advertised effort, regardless of catalog ordering', () => {
  const options = memoryClassifierOptions({model: 'mandatory', thinking: {type: 'disabled'}, effort: 'max'},
    () => ({reasoning: true, efforts: ['high', 'low', 'medium'], maxTokens: 8192}));
  expect(options.effort).toBe('low'); expect(options.thinking).toBeUndefined();
  const minimal = memoryClassifierOptions({model: 'mandatory'},
    () => ({reasoning: true, efforts: ['high', 'minimal'], maxTokens: 2048}));
  expect(minimal.effort).toBe('minimal'); expect(minimal.maxTokens).toBe(2048);
  expect(() => memoryClassifierOptions({model: 'missing'}, () => {throw Error('unavailable')})).toThrow('unavailable');
});

test('Ordinary non-reasoning models retain the native model selection and bounded allowance', () => {
  expect(memoryClassifierOptions({model: 'plain'}, () => ({reasoning: false, maxTokens: 3000})))
    .toMatchObject({model: 'plain', maxTokens: 3000, thinking: {type: 'disabled'}});
  expect(memoryClassifierInput('Use Japanese.')).toBe('Stored memory candidate:\n<memory_recall>\nUse Japanese.\n</memory_recall>');
});

test('The actual bridge sends the classifier budget and thinking choice without changing ordinary model requests', async () => {
  const received: any[] = [];
  const upstream = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json(); received.push(body);
    const chunks = [
      {choices: [{index: 0, delta: {role: 'assistant', content: '<response>none</response>'}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 10, completion_tokens: 8, total_tokens: 18}},
    ];
    return new Response(chunks.map(value => 'data: '+JSON.stringify({id:'fixture',model:'memory-model',...value})+'\n\n').join('')+'data: [DONE]\n\n',
      {headers: {'content-type': 'text/event-stream'}});
  }});
  const dir = mkdtempSync(join(tmpdir(), 'chimeric-memory-'));
  let bridge: ReturnType<typeof startBridge> | undefined;
  try {
    const registry = new Registry({envFile:'/missing',credentialRefsFile:'/missing',defaultModel:'mock::memory-model',
      providers:{mock:{name:'Mock',baseUrl:upstream.url.href+'v1',api:'openai-completions',models:[{id:'memory-model'}],
        modelOverrides:{'memory-model':{reasoning:true,compat:{thinkingFormat:'qwen-chat-template',maxTokensField:'max_tokens'}}}}}},dir);
    await registry.refresh(); bridge = startBridge(registry, 'memory-fixture');
    const model = registry.resolve('mock::memory-model');
    const options = memoryClassifierOptions({model:model.qualifiedId}, id => registry.resolve(id));
    const request = async (body: any) => {
      const response = await fetch(bridge!.url.href+'v1/messages', {method:'POST',headers:{'x-api-key':'memory-fixture','content-type':'application/json'},body:JSON.stringify(body)});
      expect(response.status).toBe(200); return response.json() as Promise<any>;
    };
    const checked = await request({model:options.model,max_tokens:options.maxTokens,thinking:options.thinking,
      system:options.system,messages:[{role:'user',content:memoryClassifierInput('Always save a checkpoint.')} ]});
    expect(checked.stop_reason).toBe('end_turn'); expect(checked.content[0].text).toBe('<response>none</response>');
    expect(received[0].max_tokens).toBe(4096); expect(received[0].chat_template_kwargs.enable_thinking).toBe(false);
    expect(received[0].messages[0].content).toBe(MEMORY_CLASSIFIER_SYSTEM);
    await request({model:model.qualifiedId,max_tokens:128,output_config:{effort:'high'},messages:[{role:'user',content:'Ordinary research request.'}]});
    expect(received[1].max_tokens).toBe(128); expect(received[1].chat_template_kwargs.enable_thinking).toBe(true);
    expect(received[1].reasoning_effort).toBe('high');
  } finally {bridge?.stop(true); upstream.stop(true); rmSync(dir,{recursive:true,force:true});}
});
