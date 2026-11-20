import * as t from '@babel/types';

/** Change only the semantic request; native verdict, static screen and write gates remain intact. */
export function memoryClassifierRequestEdits(node: t.FunctionDeclaration, source: string) {
  const invalid = () => {throw new Error('Native memory classifier request boundary changed');};
  if (!node.async || node.params.length !== 2 || !t.isIdentifier(node.params[0])) return invalid();
  const candidates: t.CallExpression[] = [];
  t.traverseFast(node.body, value => {
    if (t.isCallExpression(value) && t.isMemberExpression(value.callee) &&
        !value.callee.computed && t.isIdentifier(value.callee.property, {name: 'chat'})) candidates.push(value);
  });
  if (candidates.length !== 1) return invalid();
  const [messages, options] = candidates[0].arguments;
  if (candidates[0].arguments.length !== 2 || !t.isArrayExpression(messages) || messages.elements.length !== 1 ||
      !t.isObjectExpression(messages.elements[0]) || !t.isObjectExpression(options)) return invalid();
  const property = (object: t.ObjectExpression, name: string) => object.properties.find(value =>
    t.isObjectProperty(value) && !value.computed && t.isIdentifier(value.key, {name})) as t.ObjectProperty | undefined;
  const isTrue = (value: t.Node | undefined) => t.isBooleanLiteral(value, {value: true}) ||
    t.isUnaryExpression(value, {operator: '!'}) && t.isNumericLiteral(value.argument, {value: 0});
  const role = property(messages.elements[0], 'role'), content = property(messages.elements[0], 'content');
  if (!t.isStringLiteral(role?.value, {value: 'user'}) || !content ||
      !t.isNumericLiteral(property(options, 'maxTokens')?.value, {value: 512}) ||
      !t.isStringLiteral(property(options, 'callSite')?.value, {value: 'classifier'}) ||
      !isTrue(property(options, 'classifierQueue')?.value) ||
      !isTrue(property(options, 'noPrefillContinuation')?.value) ||
      !t.isIdentifier(property(options, 'model')?.value) || !t.isIdentifier(property(options, 'system')?.value) ||
      !property(options, 'signal')) return invalid();
  const terms: t.Node[] = [];
  const flatten = (value: t.Node) => {
    if (t.isBinaryExpression(value, {operator: '+'})) {flatten(value.left); flatten(value.right);}
    else terms.push(value);
  };
  flatten(content.value);
  const sanitized = terms[1];
  if (terms.length !== 4 || ![terms[0], terms[2], terms[3]].every(value => t.isIdentifier(value)) ||
      !t.isCallExpression(sanitized) || !t.isIdentifier(sanitized.callee) || sanitized.arguments.length !== 1 ||
      !t.isIdentifier(sanitized.arguments[0], {name: node.params[0].name})) return invalid();
  const range = (value: t.Node) => {
    if (value.start == null || value.end == null) return invalid();
    return {start: value.start, end: value.end};
  };
  return [
    {...range(content.value), text: `globalThis.__scienceLocal.memoryClassifierInput(${source.slice(sanitized.start!, sanitized.end!)})`, label: 'memory-classifier-input'},
    {...range(options), text: `globalThis.__scienceLocal.memoryClassifierOptions(${source.slice(options.start!, options.end!)})`, label: 'memory-classifier-options'},
  ];
}
