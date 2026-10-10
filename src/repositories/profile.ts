import ts from 'typescript';
import type { SourceChunk } from './chunks.ts';

export type SourceFact = SourceChunk & {
  kind: 'import' | 'function' | 'class' | 'state' | 'guard' | 'handler' | 'selector';
  name: string;
};
export type SourceProfile = { mode: 'syntax' | 'text'; facts: SourceFact[] };

export function parseSource(raw: string, filename: string): ts.SourceFile | undefined {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/i.test(filename)) return undefined;
  const source = ts.createSourceFile(filename, raw, ts.ScriptTarget.Latest, true);
  // Parser diagnostics are carried by SourceFile at runtime, but not exposed in its public type.
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics?.length ? undefined : source;
}

export function profileSource(raw: string, filename: string, parsed = parseSource(raw, filename)): SourceProfile {
  if (!parsed) return { mode: 'text', facts: [] };
  const facts: SourceFact[] = [];
  const add = (node: ts.Node, kind: SourceFact['kind'], name: string) => {
    const startOffset = node.getStart(parsed), endOffset = node.end;
    facts.push({ kind, name, startOffset, endOffset,
      startLine: parsed.getLineAndCharacterOfPosition(startOffset).line + 1,
      endLine: parsed.getLineAndCharacterOfPosition(Math.max(startOffset, endOffset - 1)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) add(node, 'import', node.moduleSpecifier.text);
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      add(node, ts.isClassDeclaration(node) ? 'class' : 'function', node.name.getText(parsed));
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) add(node, 'function', node.name.getText(parsed));
      if (ts.isCallExpression(node.initializer) && /(?:^|\.)use(?:State|Reducer)$/.test(node.initializer.expression.getText(parsed))) add(node, 'state', node.name.getText(parsed));
    }
    if (ts.isIfStatement(node) || ts.isConditionalExpression(node)) {
      const condition = ts.isIfStatement(node) ? node.expression : node.condition;
      add(condition, 'guard', condition.getText(parsed));
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(parsed);
      if (/^on[A-Z]/.test(name)) add(node, 'handler', name);
      else if (name === 'disabled') add(node, 'guard', name);
      else if (name === 'data-testid') add(node, 'selector', node.getText(parsed));
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && /^(?:locator|getByTestId|getByRole|getByText|getByLabel)$/.test(node.expression.name.text)) add(node, 'selector', node.getText(parsed));
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return { mode: 'syntax', facts };
}
