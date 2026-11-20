import {test, expect} from 'bun:test';
import {parse} from '@babel/parser';
import {memoryClassifierRequestEdits} from '../tools/native-memory';

const source = `async function classify(body, options) {
  const reply = await llm.chat([{role:"user", content:prefix + sanitize(body) + suffix + tail}],
    {system:policy,model:model,maxTokens:512,classifierQueue:true,callSite:"classifier",noPrefillContinuation:true,signal:signal});
  if (reply.raw.stop_reason === "max_tokens") return true;
  return reply.text === "<response>high</response>";
}`;
const edits = (text: string) => memoryClassifierRequestEdits(parse(text).program.body[0] as any, text);

test('The native patch preserves the sanitizer and leaves verdict handling byte-identical', async () => {
  const patches = edits(source); let patched = source;
  for (const edit of patches.sort((a,b) => b.start-a.start)) patched=patched.slice(0,edit.start)+edit.text+patched.slice(edit.end);
  expect(patches).toHaveLength(2); expect(patched).toContain('memoryClassifierInput(sanitize(body))');
  expect(patched.slice(patched.indexOf('if (reply.raw'))).toBe(source.slice(source.indexOf('if (reply.raw')));
  parse(patched);
});

test('Changed or ambiguous native classifier calls stop the build', () => {
  for (const text of [source.replace('maxTokens:512','maxTokens:1024'), source.replace('sanitize(body)','sanitize(options)'),
    source.replace('classifierQueue:true','classifierQueue:false'), source.replace('signal:signal','unexpected:signal'),
    source.replace('const reply =','await llm.chat([], {}); const reply =')]) {
    expect(() => edits(text)).toThrow('boundary changed');
  }
});

test('The signed minified revision uses !0 for the same true queue and continuation flags', () => {
  expect(edits(source.replaceAll(':true', ':!0'))).toHaveLength(2);
  expect(() => edits(source.replace('classifierQueue:true', 'classifierQueue:!1'))).toThrow('boundary changed');
});
