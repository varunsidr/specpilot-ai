import ts from 'typescript';
import { parseSource } from './profile.ts';
import type { SourceChunk } from './chunks.ts';

export type SourceUse = SourceChunk & { name: string; kind: 'call' | 'event' | 'render'; module?: string; importedName?: string };
export type SourceDefinition = SourceChunk & { name: string; exportNames: string[]; uses: SourceUse[] };
export type SourceUsage = { definitions: SourceDefinition[]; imports: SourceUse[] };

// Bind a single file without resolving dependencies or reading/executing repository code.
// Symbol identity prevents comments, strings and shadowed identifiers from creating links.
export function sourceUsage(raw: string, filename: string): SourceUsage {
  const logicalPath = '/' + filename.replaceAll('\\', '/');
  const source = parseSource(raw, logicalPath);
  if (!source) return { definitions: [], imports: [] };
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => name === logicalPath ? source : undefined;
  host.fileExists = name => name === logicalPath;
  host.readFile = name => name === logicalPath ? raw : undefined;
  const checker = ts.createProgram([logicalPath], options, host).getTypeChecker();
  const definitions = new Map<ts.Symbol, SourceDefinition>();
  const bindings = new Map<ts.Symbol, { module: string; importedName: string }>();
  const imports: SourceUse[] = [];
  const range = (node: ts.Node): SourceChunk => {
    const startOffset = node.getStart(source), endOffset = node.end;
    return { startOffset, endOffset, startLine: source.getLineAndCharacterOfPosition(startOffset).line + 1,
      endLine: source.getLineAndCharacterOfPosition(Math.max(startOffset, endOffset - 1)).line + 1 };
  };
  const bind = (name: ts.Identifier, module: string, importedName: string) => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol) bindings.set(symbol, { module, importedName });
  };
  const declarations = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
      const clause = node.importClause, module = node.moduleSpecifier.text;
      if (clause.name) bind(clause.name, module, 'default');
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name, module, '*');
      else if (clause.namedBindings) for (const binding of clause.namedBindings.elements) if (!binding.isTypeOnly) bind(binding.name, module, binding.propertyName?.text ?? binding.name.text);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isVariableDeclaration(node) && node.initializer &&
        (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) && node.name && ts.isIdentifier(node.name)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const declaration = ts.isVariableDeclaration(node) && ts.isVariableStatement(node.parent.parent) ? node.parent.parent : node;
      const modifiers = ts.canHaveModifiers(declaration) ? ts.getModifiers(declaration) : undefined;
      const exportNames = modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword) ? ['default'] :
        modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ? [node.name.text] : [];
      if (symbol) definitions.set(symbol, { ...range(node), name: node.name.text, exportNames, uses: [] });
    }
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && ts.isIdentifier(statement.expression)) {
      const symbol = checker.getSymbolAtLocation(statement.expression);
      if (symbol && definitions.has(symbol)) definitions.get(symbol)!.exportNames.push('default');
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause) && !statement.isTypeOnly) {
      for (const binding of statement.exportClause.elements) {
        if (binding.isTypeOnly) continue;
        let symbol = checker.getSymbolAtLocation(binding.propertyName ?? binding.name);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
        if (symbol && definitions.has(symbol)) definitions.get(symbol)!.exportNames.push(binding.name.text);
      }
    }
  }
  const reference = (expression: ts.Expression | ts.JsxTagNameExpression, kind: SourceUse['kind']) => {
    const name = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol && definitions.has(symbol)) definitions.get(symbol)!.uses.push({ ...range(expression), name: expression.getText(source), kind });
    const receiver = ts.isPropertyAccessExpression(expression) ? expression.expression : expression;
    const binding = checker.getSymbolAtLocation(receiver);
    const imported = binding && bindings.get(binding);
    if (imported) imports.push({ ...range(expression), name: expression.getText(source), kind, module: imported.module,
      importedName: imported.importedName === '*' && ts.isPropertyAccessExpression(expression) ? expression.name.text : imported.importedName });
  };
  const references = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) reference(node.expression, 'call');
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^[A-Z]/.test(node.tagName.getText(source))) reference(node.tagName, 'render');
    if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText(source)) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
      reference(node.initializer.expression, 'event');
    }
    ts.forEachChild(node, references);
  };
  references(source);
  return { definitions: [...definitions.values()], imports };
}
