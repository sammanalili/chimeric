import {parse} from '@babel/parser';
import * as t from '@babel/types';

export type NativeScopeEdit = {start: number; end: number; text: string; label: string};
const metadataSource = 'function metadata(e){let{lane:t}=e;if(!REGEX.test(t))throw Error(`apiMetadata: lane "${t}" must match ${REGEX}`);let n=e.frameId||null,r=e.sessionId||n||"",o=n!==null?n.replace(/-/g,""):null,s=[r.replace(/-/g,"")];if(o!==null&&n!==r)s.push(o.slice(0,24));if(t!=="agent")s.push(t);let i=s.join(":");if(i.length>64)throw Error(`apiMetadata: session_id "${i}" exceeds 64 chars`);return{user_id:JSON.stringify({session_id:i,...o!==null?{frame_id:o}:{}})}}';
const invalid = (name: string): never => {throw new Error(`Native ${name} boundary changed`);};
const range = (node: t.Node, name: string) => {
  if (node.start == null || node.end == null) return invalid(name);
  return {start: node.start, end: node.end};
};
function expectedFunction(text: string, actual: t.FunctionDeclaration) {
  const expected = parse(text).program.body[0] as t.FunctionDeclaration;
  expected.id = actual.id ? t.cloneNode(actual.id) : null;
  return expected;
}
function expectedMethod(text: string) {
  return (parse(`class NativeScope{${text}}`).program.body[0] as t.ClassDeclaration).body.body[0];
}

/**
 * Sign the original, unmodified frame/root identifiers at metadata construction.
 * The runtime callback must use its own signature and later verify ownership.
 * A serialized user_id, frame_id, or client-supplied policy flag is not proof.
 * Any local proof transported in metadata must be stripped before upstream I/O.
 */
export function nativeMetadataEdit(node: t.FunctionDeclaration, source: string): NativeScopeEdit {
  const invalid = (): never => {throw new Error('Native scope metadata boundary changed');};
  if (!node.id || node.params.length !== 1 || !t.isIdentifier(node.params[0], {name: 'e'})) return invalid();
  const guard = node.body.body[1];
  if (!t.isIfStatement(guard) || !t.isUnaryExpression(guard.test, {operator: '!'}) ||
      !t.isCallExpression(guard.test.argument) || !t.isMemberExpression(guard.test.argument.callee) ||
      !t.isIdentifier(guard.test.argument.callee.object)) return invalid();
  const regex = guard.test.argument.callee.object.name;
  const expected = parse(metadataSource.replaceAll('REGEX', regex)).program.body[0] as t.FunctionDeclaration;
  expected.id = t.cloneNode(node.id);
  if (!t.isNodesEquivalent(node, expected)) return invalid();
  const last = node.body.body.at(-1);
  if (!t.isReturnStatement(last) || !t.isObjectExpression(last.argument) ||
      last.argument.start == null || last.argument.end == null) return invalid();
  return {
    start: last.argument.start,
    end: last.argument.end,
    // The minified original is `return{...}`. Parentheses retain that token
    // boundary instead of accidentally producing an identifier `returnglobalThis`.
    text: `(globalThis.__scienceLocal.nativeMetadata(e,${source.slice(last.argument.start, last.argument.end)}))`,
    label: 'native-scope-metadata',
  };
}

/** Preserve the native task-source ALS, adding the root supplied by that native caller. */
export function nativeTaskScopeEdit(node: t.FunctionDeclaration, source: string): NativeScopeEdit {
  const name = 'task scope';
  const statement = node.body.body[0];
  if (!t.isReturnStatement(statement) || !t.isCallExpression(statement.argument) ||
      !t.isMemberExpression(statement.argument.callee) || !t.isIdentifier(statement.argument.callee.object)) return invalid(name);
  const storage = statement.argument.callee.object.name;
  const expected = expectedFunction(`function task(e,t,n=null){return ${storage}.run({taskSource:e,rootFrameId:n},t)}`, node);
  if (!t.isNodesEquivalent(node, expected)) return invalid(name);
  const callback = statement.argument.arguments[1];
  if (!t.isIdentifier(callback, {name: 't'}) || source.slice(callback.start!, callback.end!) !== 't') return invalid(name);
  return {...range(callback, name), text: '()=>globalThis.__scienceLocal.withFrame(n,t)', label: 'native-scope-task'};
}

/** The runner's exact child frame is stored on its native instance, not in a browser flag. */
export function nativeRunnerScopeEdit(node: t.ClassMethod, source: string): NativeScopeEdit {
  const name = 'runner scope', statement = node.body.body[0];
  if (!t.isReturnStatement(statement) || !t.isCallExpression(statement.argument) ||
      !t.isIdentifier(statement.argument.callee)) return invalid(name);
  const task = statement.argument.callee.name;
  const expected = expectedMethod(`async run(e){return ${task}(null,()=>this._runInner(e),this.root_frame_id)}`);
  if (!t.isNodesEquivalent(node, expected)) return invalid(name);
  const callback = statement.argument.arguments[1];
  if (!t.isArrowFunctionExpression(callback)) return invalid(name);
  return {...range(callback, name), text: `()=>globalThis.__scienceLocal.withFrame(this.frame_id,${source.slice(callback.start!, callback.end!)})`, label: 'native-scope-runner'};
}

/** Cover the complete native agent job, including post-run titling and memory work. */
export function nativeJobScopeEdit(node: t.ClassMethod, source: string): NativeScopeEdit {
  const name = 'agent job scope', statement = node.body.body[0];
  if (!t.isReturnStatement(statement) || !t.isCallExpression(statement.argument) ||
      !t.isIdentifier(statement.argument.callee)) return invalid(name);
  const providers = statement.argument.callee.name;
  const expected = expectedMethod(`async executeRequest(e){return ${providers}(this.services.providers,()=>this._executeRequestInner(e))}`);
  if (!t.isNodesEquivalent(node, expected)) return invalid(name);
  const callback = statement.argument.arguments[1];
  if (!t.isArrowFunctionExpression(callback)) return invalid(name);
  return {...range(callback, name), text: `()=>globalThis.__scienceLocal.withFrame(e.frame_id,${source.slice(callback.start!, callback.end!)})`, label: 'native-scope-agent-job'};
}

/**
 * Both shared SDK factories reach this fetch boundary through uon (Darwin names).
 * Wrapping its fetch parameter covers both the ordinary and proxy-disabled paths,
 * including raw SDK calls that do not use the common _requestOptions method.
 */
export function nativeFetchScopeEdit(node: t.FunctionDeclaration, source: string): NativeScopeEdit {
  const name = 'SDK fetch scope', first = node.body.body[0], last = node.body.body.at(-1);
  if (!t.isIfStatement(first) || !t.isUnaryExpression(first.test, {operator: '!'}) ||
      !t.isCallExpression(first.test.argument) || !t.isIdentifier(first.test.argument.callee) ||
      !t.isReturnStatement(last) || !t.isCallExpression(last.argument) || !t.isIdentifier(last.argument.callee)) return invalid(name);
  const hostname = first.test.argument.callee.name, proxy = last.argument.callee.name;
  const expected = expectedFunction(`function transport(e,t,n,r,o=process.env){if(!${hostname}(t.hostname))return e(n,r);let s={...r,proxy:!1};return ${proxy}([t.hostname],()=>e(n,s),o)}`, node);
  if (!t.isNodesEquivalent(node, expected) || node.body.start == null || source[node.body.start] !== '{') return invalid(name);
  return {start: node.body.start + 1, end: node.body.start + 1, text: 'e=globalThis.__scienceLocal.scopeFetch(e);', label: 'native-scope-sdk-fetch'};
}

/** Return exactly one checked patch per supported boundary on either signed revision. */
export function nativeScopeEdits(ast: t.Node, source: string): NativeScopeEdit[] {
  const edits: NativeScopeEdit[] = [], counts = new Map<string, number>();
  const add = (edit: NativeScopeEdit) => {edits.push(edit); counts.set(edit.label, (counts.get(edit.label) ?? 0) + 1);};
  t.traverseFast(ast, node => {
    if (t.isFunctionDeclaration(node)) {
      if (node.id?.name === 'uu') add(nativeMetadataEdit(node, source));
      const body = source.slice(node.body.start!, node.body.end!);
      if (body.length < 200 && body.includes('.run({taskSource:e,rootFrameId:n},t)')) add(nativeTaskScopeEdit(node, source));
      if (body.length < 300 && body.includes('proxy:!1') && body.includes('t.hostname')) add(nativeFetchScopeEdit(node, source));
    }
    if (t.isClassMethod(node) && !node.computed && t.isIdentifier(node.key)) {
      if (node.key.name === 'run' && source.slice(node.start!, node.end!).includes('this._runInner(e)')) add(nativeRunnerScopeEdit(node, source));
      if (node.key.name === 'executeRequest' && source.slice(node.start!, node.end!).includes('this._executeRequestInner(e)')) add(nativeJobScopeEdit(node, source));
    }
  });
  for (const label of ['native-scope-metadata', 'native-scope-task', 'native-scope-runner', 'native-scope-agent-job', 'native-scope-sdk-fetch']) {
    if (counts.get(label) !== 1) throw new Error(`Missing or ambiguous native scope boundary: ${label}`);
  }
  return edits;
}
