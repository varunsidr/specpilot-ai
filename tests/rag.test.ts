import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildIndexes } from '../src/repositories/index.ts';
import { collectContext } from '../src/repositories/context.ts';
import type { Embedder } from '../src/repositories/semantic.ts';
import type { TokenCounter } from '../src/repositories/tokenizer.ts';
import { splitIntoChunks } from '../src/repositories/chunks.ts';

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
  const embedder: Embedder = {
    model: 'fake-embedding',
    async embed(texts) { return texts.map(text => /billing|invoice/i.test(text) ? [1, 0] : [0, 1]); },
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
    const context = await collectContext(roots, { title: 'Billing', description: 'Support payments', acceptanceCriteria: ['Complete billing'] }, semantic);
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
