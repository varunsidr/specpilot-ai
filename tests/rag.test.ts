import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndexes, readIndex, INDEX_VERSION } from '../src/repositories/index.ts';
import { collectContext } from '../src/repositories/context.ts';
import type { Embedder } from '../src/repositories/semantic.ts';
import type { TokenCounter } from '../src/repositories/tokenizer.ts';
import { splitIntoChunks } from '../src/repositories/chunks.ts';
import { profileSource } from '../src/repositories/profile.ts';
import { promptTokens } from '../src/providers/prompt.ts';

test('structural chunks preserve handlers and disabled guards in large TSX components', () => {
  const prefix = Array.from({ length: 130 }, (_, i) => `  const item${i} = ${i};`).join('\r\n');
  const handler = '  const increase = () => {\r\n    if (stock === 0 || quantity >= stock) return;\r\n    setQuantity(q => Math.min(q + 5, stock));\r\n  };';
  const control = '<button disabled={stock === 0 || quantity >= stock} onClick={increase} data-testid="increase">Increase</button>';
  const raw = `import React from 'react';\r\nexport function Product() {\r\n${prefix}\r\n${handler}\r\nreturn <div>${'<p>Product details</p>'.repeat(180)}${control}</div>;\r\n}`;
  const chunks = splitIntoChunks(raw, 'Product.tsx');
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.endOffset - chunk.startOffset <= 2400));
  assert.ok(chunks.some(chunk => raw.slice(chunk.startOffset, chunk.endOffset).includes(handler)));
  assert.ok(chunks.some(chunk => raw.slice(chunk.startOffset, chunk.endOffset).includes(control)));
  let covered = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.startOffset <= covered, 'no source may disappear at a syntax boundary');
    covered = Math.max(covered, chunk.endOffset);
    assert.equal(chunk.startLine, raw.slice(0, chunk.startOffset).split('\n').length);
    assert.equal(chunk.endLine, raw.slice(0, chunk.endOffset - 1).split('\n').length);
  }
  assert.equal(covered, raw.length);
});

test('source profiles record literal syntax with exact ranges and fall back on malformed code', () => {
  const raw = `import { useState } from 'react';
export function Product() {
  const [quantity, setQuantity] = useState(1);
  const increase = () => { if (quantity < 10) setQuantity(q => q + 1); };
  return <button disabled={quantity >= 10} onClick={increase} data-testid="increase">+</button>;
}
page.getByTestId('increase');`;
  const profile = profileSource(raw, 'Product.tsx');
  assert.equal(profile.mode, 'syntax');
  for (const [kind, name] of [['import', 'react'], ['function', 'Product'], ['function', 'increase'], ['state', '[quantity, setQuantity]'], ['guard', 'quantity < 10'], ['guard', 'disabled'], ['handler', 'onClick']]) {
    assert.ok(profile.facts.some(fact => fact.kind === kind && fact.name === name), `${kind}: ${name}`);
  }
  assert.equal(profile.facts.filter(fact => fact.kind === 'selector').length, 2);
  assert.equal(raw.slice(profile.facts[0].startOffset, profile.facts[0].endOffset), "import { useState } from 'react';");
  for (const [filename, content] of [['bad.tsx', 'export const broken = <button'], ['readme.md', '# Heading\n' + 'x'.repeat(6000)], ['long.ts', `export const text = '${'x'.repeat(6000)}';`]]) {
    const chunks = splitIntoChunks(content, filename);
    assert.ok(chunks.every(chunk => chunk.endOffset - chunk.startOffset <= 2400));
    assert.equal(chunks.at(-1)!.endOffset, content.length);
    if (filename !== 'long.ts') {
      assert.equal(profileSource(content, filename).mode, 'text');
      assert.deepEqual(chunks, splitIntoChunks(content));
    }
  }
});

test('chunks retain line ranges across a long source file', () => {
  const raw = Array.from({ length: 160 }, (_, i) => `const item${i} = ${i};`).join('\n');
  const chunks = splitIntoChunks(raw);
  assert.ok(chunks.length > 1);
  assert.equal(chunks[0].startLine, 1);
  assert.ok(chunks[1].startLine > 1);
  assert.equal(chunks.at(-1)!.endLine, 160);
  assert.ok(chunks.every(chunk => chunk.startLine <= chunk.endLine && chunk.endOffset > chunk.startOffset));
});

test('semantic retrieval finds related files and refreshes changed source', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-rag-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const indexDir = path.join(root, 'index');
  const releasedQuerySizes: number[] = [];
  const embedder: Embedder = {
    model: 'fake-embedding',
    async embed(texts, release) {
      if (release) releasedQuerySizes.push(texts.length);
      return texts.map(text => /billing|invoice/i.test(text) ? [1, 0] : [0, 1]);
    },
  };
  const tokenCounter: TokenCounter = { model: 'fake', count: text => Math.ceil(text.length / 4) };
  const semantic = { indexDir, embedder, tokenCounter, numCtx: 8192 };
  try {
    await mkdir(roots.website);
    await mkdir(roots.tests);
    await writeFile(path.join(roots.website, 'invoice.ts'), "import { calculateTotal } from './billing-helper';\nexport function settleInvoice() { return calculateTotal() > 0; }");
    await writeFile(path.join(roots.website, 'other.ts'), 'export function listBooks() { return []; }');
    await writeFile(path.join(roots.website, 'billing-helper.ts'), 'export function calculateTotal() { return 10; }');
    await writeFile(path.join(roots.tests, 'invoice.spec.ts'), 'test("invoice", () => {});');
    await writeFile(path.join(roots.tests, 'other.spec.ts'), 'test("books", () => {});');
    const first = await buildIndexes(roots, indexDir, embedder);
    assert.deepEqual(first.map(report => report.embedded), [3, 2]);
    const second = await buildIndexes(roots, indexDir, embedder);
    assert.deepEqual(second.map(report => report.embedded), [0, 0]);
    const indexed = await readIndex(indexDir, 'website', roots.website, embedder.model);
    assert.equal(indexed.version, INDEX_VERSION);
    assert.ok(indexed.files.find(file => file.path === 'invoice.ts')!.profile.facts.some(fact => fact.name === 'settleInvoice'));
    // Old character-based caches must be rebuilt even when file size/mtime match.
    const oldIndex = JSON.parse(await readFile(path.join(indexDir, 'website.json'), 'utf8'));
    oldIndex.version = 2;
    await writeFile(path.join(indexDir, 'website.json'), JSON.stringify(oldIndex));
    const migrated = await buildIndexes(roots, indexDir, embedder);
    assert.deepEqual(migrated.map(report => report.embedded), [3, 0]);
    const context = await collectContext(roots, { title: 'Billing', description: 'Support payments', acceptanceCriteria: ['Complete billing'] }, semantic);
    assert.equal(context.retrieval!.strategy, 'requirement');
    assert.equal(context.retrieval!.criteria, undefined);
    assert.deepEqual(releasedQuerySizes, [1], 'default retrieval should embed only the original requirement query');
    assert.equal(context.files.find(file => file.repository === 'website' && file.path === 'invoice.ts')?.startLine, 1);
    assert.ok(context.retrieval!.promptTokens <= context.retrieval!.promptBudget);
    assert.equal(context.files.find(file => file.repository === 'tests')?.path, 'invoice.spec.ts');
    assert.equal(context.files.find(file => file.path === 'invoice.spec.ts')?.reason, 'test');
    assert.equal(context.files.find(file => file.path === 'billing-helper.ts')?.reason, 'import');
    const pinned = await collectContext(roots, { title: 'Billing', description: 'Support payments', acceptanceCriteria: ['Complete billing'], pinnedFiles: [{ repository: 'website', path: 'other.ts' }] }, semantic);
    assert.equal(pinned.files[0].path, 'other.ts');
    assert.equal(pinned.files[0].reason, 'pinned');
    await writeFile(path.join(roots.website, 'invoice.ts'), 'export function settleInvoice() { return false; }');
    const refreshed = await collectContext(roots, { title: 'Billing', description: 'Support payments', acceptanceCriteria: ['Complete billing'] }, semantic);
    assert.match(refreshed.files.find(file => file.repository === 'website' && file.path === 'invoice.ts')!.content, /return false/);
    assert.ok(refreshed.warnings.some(warning => warning.includes('refreshed 1 changed chunks')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('criterion retrieval reserves space for a minority behavior under a tight prompt budget', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-criteria-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const batches: { texts: string[]; release?: boolean }[] = [];
  const embedder: Embedder = { model: 'criterion-test', async embed(texts, release) {
    batches.push({ texts, release });
    return texts.map(text => /Acceptance criterion: Refund|File: refund/i.test(text) ? [0, 1] : [1, 0]);
  } };
  const requirement = { title: 'Catalog purchasing', description: 'Improve catalog inventory and catalog product browsing.',
    acceptanceCriteria: ['Catalog browsing preserves all products.', 'Refund returns the captured amount.'] };
  const tokenCounter: TokenCounter = { model: 'test', count: text => Math.ceil(text.length / 4) };
  try {
    await mkdir(roots.website); await mkdir(roots.tests);
    for (let i = 0; i < 6; i++) await writeFile(path.join(roots.website, `catalog${i}.ts`),
      `export function catalog${i}(products: string[]) {\n  const description = '${'catalog inventory '.repeat(80)}';\n  return products;\n}`);
    await writeFile(path.join(roots.website, 'refund.ts'),
      `export function refund(captured: number) {\n  const description = '${'payment record '.repeat(80)}';\n  return captured;\n}`);
    const context = await collectContext(roots, requirement, { indexDir: path.join(root, 'index'), embedder, tokenCounter, numCtx: 6200, retrievalStrategy: 'criterion' });
    assert.ok(context.files.some(file => file.path === 'refund.ts' && file.content.includes('return captured')),
      'the catalog majority must not exhaust the budget before the refund handler is selected');
    assert.ok(context.files.some(file => file.path.startsWith('catalog')));
    assert.ok(context.files.length < 7, 'the fixture must exert real packing pressure');
    assert.equal(context.retrieval!.criteria!.length, 2);
    assert.equal(context.retrieval!.criteria![1].rankedFiles[0].path, 'refund.ts');
    assert.ok(context.retrieval!.criteria![1].selectedRanges.some(range => range.path === 'refund.ts'));
    const queryBatch = batches.find(batch => batch.release);
    assert.equal(queryBatch!.texts.length, 3);
    assert.ok(queryBatch!.texts[1].includes(requirement.acceptanceCriteria[0]));
    assert.ok(!queryBatch!.texts[1].includes(requirement.acceptanceCriteria[1]));
    assert.equal(context.retrieval!.promptTokens, promptTokens(tokenCounter, requirement, context));
    assert.ok(context.retrieval!.promptTokens <= context.retrieval!.promptBudget);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('criteria can share complete handlers without duplicate excerpts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-shared-criteria-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const embedder: Embedder = { model: 'shared-test', async embed(texts) { return texts.map(() => [1, 0]); } };
  const requirement = { title: 'Quantity', description: 'Bound quantity changes.', acceptanceCriteria: [
    'Increase quantity up to stock.', 'Decrease quantity down to one.',
  ] };
  const tokenCounter: TokenCounter = { model: 'test', count: text => Math.ceil(text.length / 4) };
  try {
    await mkdir(roots.website); await mkdir(roots.tests);
    await writeFile(path.join(roots.website, 'quantity.ts'),
      'export function increase(quantity: number, stock: number) { return Math.min(quantity + 1, stock); }\n' +
      'export function decrease(quantity: number) { return Math.max(quantity - 1, 1); }');
    const context = await collectContext(roots, requirement, { indexDir: path.join(root, 'index'), embedder, tokenCounter, numCtx: 8192, retrievalStrategy: 'criterion' });
    assert.equal(context.files.length, 1);
    assert.deepEqual(context.retrieval!.criteria![0].selectedRanges, context.retrieval!.criteria![1].selectedRanges);
    for (const criterion of context.retrieval!.criteria!) for (const range of criterion.selectedRanges) {
      assert.ok(context.files.some(file => file.repository === range.repository && file.path === range.path &&
        file.startLine! <= range.startLine && file.endLine! >= range.endLine));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('different criteria retrieve distant handlers in the same source file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-handler-criteria-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const embedder: Embedder = { model: 'handler-test', async embed(texts) {
    return texts.map(text => /Acceptance criterion: Decrease|function decrease/.test(text) ? [0, 1] : [1, 0]);
  } };
  const requirement = { title: 'Controls', description: 'Keep both quantity bounds.', acceptanceCriteria: [
    'Increase quantity up to stock.', 'Decrease quantity down to one.',
  ] };
  const tokenCounter: TokenCounter = { model: 'test', count: text => Math.ceil(text.length / 4) };
  try {
    await mkdir(roots.website); await mkdir(roots.tests);
    await writeFile(path.join(roots.website, 'controls.ts'),
      'export function increase(quantity: number, stock: number) { return Math.min(quantity + 1, stock); }\n' +
      Array.from({ length: 160 }, (_, i) => `export const label${i} = 'unrelated layout copy';`).join('\n') + '\n' +
      'export function decrease(quantity: number) { return Math.max(quantity - 1, 1); }');
    const context = await collectContext(roots, requirement, { indexDir: path.join(root, 'index'), embedder, tokenCounter, numCtx: 8192, retrievalStrategy: 'criterion' });
    assert.ok(context.files.some(file => file.content.includes('function increase')));
    assert.ok(context.files.some(file => file.content.includes('function decrease')));
    assert.equal(context.files.length, 2, 'two distant handlers should use the existing per-file cap');
    assert.ok(context.retrieval!.criteria![0].selectedRanges.some(range => range.startLine === 1));
    assert.ok(context.retrieval!.criteria![1].selectedRanges.some(range => range.endLine === 162));
    assert.ok(context.retrieval!.promptTokens <= context.retrieval!.promptBudget);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('anchored criterion selection preserves a useful guard when another criterion ranks a different file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-anchors-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const embedder: Embedder = { model: 'anchor-test', async embed(texts) {
    return texts.map(text => /Acceptance criterion: Refund|File: refund/.test(text) ? [0, 1] : [1, 0]);
  } };
  const requirement = { title: 'Quantity and refunds', description: 'Preserve quantity limits and support refunds.',
    acceptanceCriteria: ['Quantity must remain at least one.', 'Refund returns the captured amount.'] };
  const tokenCounter: TokenCounter = { model: 'test', count: text => Math.ceil(text.length / 4) };
  try {
    await mkdir(roots.website); await mkdir(roots.tests);
    await writeFile(path.join(roots.website, 'quantity.ts'), 'export function decrease(quantity: number) { if (quantity <= 1) return 1; return quantity - 1; }');
    await writeFile(path.join(roots.website, 'refund.ts'), 'export function refund(captured: number) { return captured; }');
    const options = { indexDir: path.join(root, 'index'), embedder, tokenCounter, numCtx: 8192 };
    const control = await collectContext(roots, requirement, options);
    const anchored = await collectContext(roots, requirement, { ...options, retrievalStrategy: 'criterion' });
    const guard = control.files.find(file => file.path === 'quantity.ts')!;
    assert.ok(anchored.files.some(file => file.path === guard.path && file.content === guard.content));
    assert.ok(anchored.retrieval!.anchors!.some(range => range.path === guard.path && range.startLine === guard.startLine && range.endLine === guard.endLine));
    assert.ok(anchored.files.some(file => file.path === 'refund.ts'));
    assert.equal(anchored.retrieval!.selectionVersion, 2);
    assert.equal(anchored.retrieval!.promptTokens, promptTokens(tokenCounter, requirement, anchored));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retrieval links actual imported calls and does not fabricate uses of imported or private helpers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-links-'));
  const roots = { website: path.join(root, 'website'), tests: path.join(root, 'tests') };
  const embedder: Embedder = { model: 'link-test', async embed(texts) { return texts.map(() => [1, 0]); } };
  const requirement = { title: 'Price calculation', description: 'Use the price calculator from the catalog.', acceptanceCriteria: ['Catalog calls the exported price calculation.'] };
  try {
    await mkdir(roots.website); await mkdir(roots.tests);
    await writeFile(path.join(roots.website, 'catalog.ts'), "import { calculate as price, privateHelper } from './money';\nimport { unused } from './unused';\nexport function catalog() { return price(10); }\n// unused();\nprivateHelper();");
    await writeFile(path.join(roots.website, 'money.ts'), 'export function calculate(value: number) { return value * 2; }\nfunction privateHelper() { return 0; }');
    await writeFile(path.join(roots.website, 'unused.ts'), 'export function unused() { return 1; }');
    const context = await collectContext(roots, requirement, { indexDir: path.join(root, 'index'), embedder,
      tokenCounter: { model: 'test', count: text => Math.ceil(text.length / 4) }, numCtx: 8192, retrievalStrategy: 'criterion' });
    const links = context.retrieval!.sourceLinks!;
    assert.ok(links.some(link => link.name === 'calculate' && link.caller.path === 'catalog.ts' && link.caller.startLine === 3 && link.definition.path === 'money.ts'));
    assert.ok(!links.some(link => link.name === 'unused' || link.name === 'privateHelper'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
