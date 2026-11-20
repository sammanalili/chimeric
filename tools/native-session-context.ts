import {parse} from '@babel/parser';
import * as t from '@babel/types';

export type NativeSessionContextEdit = {start: number; end: number; text: string; label: string};

/**
 * Wrap only the final SDK options value. The callback is synchronous: both native
 * SDK callers pass this method's result directly, without awaiting it.
 *
 * The caller must select the verified native provider class and require exactly
 * one match. This edit does not establish ownership, infer a policy from metadata,
 * or cover SDK requests which bypass this method. Those checks belong to the
 * trusted runtime callback and request broker.
 */
export function nativeRequestOptionsEdit(
  node: t.ClassMethod,
  source: string,
  timeoutIdentifier: string,
): NativeSessionContextEdit {
  const invalid = (): never => {throw new Error('Native session request-options boundary changed');};
  const [request, options] = node.params;
  const declaration = node.body.body[0];
  if (!t.isIdentifier(request) || !t.isAssignmentPattern(options) || !t.isIdentifier(options.left) ||
      !t.isVariableDeclaration(declaration) || declaration.declarations.length !== 1 ||
      !t.isIdentifier(declaration.declarations[0].id) || !t.isValidIdentifier(timeoutIdentifier)) return invalid();
  const input = request.name, settings = options.left.name, result = declaration.declarations[0].id.name;
  if (new Set([input, settings, result, timeoutIdentifier, 'globalThis']).size !== 5) return invalid();
  const expectedSource = `class NativeProvider {
    _requestOptions(${input},${settings}={}){
      let ${result}={};
      if(${input}.finalHeaders)${result}.headers=${input}.finalHeaders;
      if(${input}.signal)${result}.signal=${input}.signal;
      if(${input}.freshConnection)${result}.fetchOptions={keepalive:!1};
      if(${settings}.streaming)
        ${result}.fetchOptions={...${result}.fetchOptions??{},timeout:!1},
        ${result}.timeout=Math.max(${timeoutIdentifier},Math.ceil(${settings}.firstEventBudgetMs??0));
      return ${result}
    }
  }`;
  const expectedClass = parse(expectedSource).program.body[0] as t.ClassDeclaration;
  const expected = expectedClass.body.body[0];
  if (!t.isNodesEquivalent(node, expected)) return invalid();
  const last = node.body.body.at(-1);
  if (!t.isReturnStatement(last) || !t.isIdentifier(last.argument, {name: result}) ||
      last.argument.start == null || last.argument.end == null ||
      source.slice(last.argument.start, last.argument.end) !== result) return invalid();
  return {
    start: last.argument.start,
    end: last.argument.end,
    text: `globalThis.__scienceLocal.requestOptions(${input},${settings},${result})`,
    label: 'native-session-request-options',
  };
}
