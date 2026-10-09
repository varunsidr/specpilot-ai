import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Plan } from '../src/types.ts';
import { validatePlan } from '../src/providers/schema.ts';
import { expandContext } from '../src/repositories/expand-context.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { evidenceCatalog } from '../src/providers/evidence.ts';
import { rangeSupplied, suppliedRanges } from '../src/repositories/ranges.ts';
import { context, gapPlan, requirement, assessmentResponse, tokenCounter } from './plan-fixtures.ts';

test('rejects fabricated quotes, wrong lines, and edits to implemented criteria', () => {
  const fabricated = gapPlan(); fabricated.changes[0].evidence[0].quote = 'invented filtering function';
  assert.throws(() => validatePlan(fabricated, context, requirement), /Unsupported citation/);
  const wrongLines = gapPlan(); wrongLines.assessments[0].evidence[0].startLine = 20; wrongLines.assessments[0].evidence[0].endLine = 20;
  assert.throws(() => validatePlan(wrongLines, context, requirement), /Unsupported citation/);
  const redundant = gapPlan(); redundant.assessments[0].status = 'implemented';
  assert.throws(() => validatePlan(redundant, context, requirement), /criterion assessed as a gap/);
});

test('accepts an evidence-backed empty change list and requires every criterion', () => {
  const plan = gapPlan(); plan.outcome = 'already_implemented'; plan.changes = []; plan.assessments[0].status = 'implemented';
  assert.equal(validatePlan(plan, context, requirement).changes.length, 0);
  plan.assessments = [];
  assert.throws(() => validatePlan(plan, context, requirement), /every acceptance criterion/);
});

test('unknown requirements request context without speculative changes', () => {
  const plan = gapPlan(); plan.outcome = 'needs_context'; plan.assessments[0].status = 'unknown'; plan.questions = ['What is the price boundary policy?'];
  assert.throws(() => validatePlan(plan, context, requirement), /criterion assessed as a gap/);
  plan.changes = []; plan.contextRequests = [{ repository: 'website', path: '../private.ts', startLine: 1, endLine: 10, reason: 'Read private data' }];
  assert.throws(() => validatePlan(plan, context, requirement), /available repository file/);
});

test('context expansion reads eligible ranges, fits tokens, and follows up once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-evidence-'));
  const repo = path.join(root, 'repo'); await mkdir(repo);
  await writeFile(path.join(repo, 'products.ts'), 'export const price = 10;\nexport const filter = (price, max) => price <= max;');
  const initial = structuredClone(context); initial.files[0].truncated = true; initial.availableFiles = [{ repository: 'website', path: 'products.ts' }];
  const request = { repository: 'website' as const, path: 'products.ts', startLine: 2, endLine: 2, reason: 'Inspect the actual filter comparison' };
  const unknown: Plan = { ...gapPlan(), outcome: 'needs_context', changes: [], contextRequests: [request], questions: ['Does the filter include equal prices?'], assessments: [{ criterion: 1, status: 'unknown', observation: 'Filter lines are missing.', evidence: [] }] };
  const completed: Plan = { ...gapPlan(), outcome: 'already_implemented', changes: [], questions: [], assessments: [{ criterion: 1, status: 'implemented', observation: 'Comparison is inclusive.', evidence: [{ repository: 'website', path: 'products.ts', startLine: 2, endLine: 2, quote: 'price <= max' }] }] };
  let calls = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls++;
    if (calls === 2) assert.match(JSON.parse(raw).messages[1].content, /2\| export const filter/);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const supplied = calls === 1 ? initial : { ...initial, files: [{ repository: 'website' as const, path: 'products.ts', content: 'export const filter = (price, max) => price <= max;', startLine: 2, endLine: 2, truncated: true }] };
    res.end(JSON.stringify({ message: { content: JSON.stringify(assessmentResponse(calls === 1 ? unknown : completed, supplied)) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const options = { indexDir: path.join(root, 'index'), numCtx: 8192, tokenCounter: { model: 'fake', count: (text: string) => Math.ceil(text.length / 4) }, embedder: { model: 'fake', async embed() { return []; } } };
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'fake', timeoutMs: 10000, numCtx: 8192, tokenCounter });
    const result = await provider.plan(requirement, initial, { resolveContext: requests => expandContext({ website: repo, tests: repo }, requirement, initial, requests, options) });
    assert.equal(result.outcome, 'already_implemented'); assert.equal(calls, 2); assert.equal(provider.lastMetrics?.contextRounds, 1);
    await assert.rejects(expandContext({ website: repo, tests: repo }, requirement, initial, [{ ...request, path: '.env' }], options), /outside the supplied inventory/);
    const noProgress = await expandContext({ website: repo, tests: repo }, requirement, initial, [{ ...request, startLine: 90, endLine: 95 }], options);
    assert.equal(noProgress.followUps?.at(-1)?.served.length, 0);
    const redundant = await expandContext({ website: repo, tests: repo }, requirement, initial, [{ ...request, startLine: 1, endLine: 1 }], options);
    assert.equal(redundant.followUps?.at(-1)?.served.length, 0);
    assert.match(redundant.followUps!.at(-1)!.warnings[0], /already supplied/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('planner stops after two context expansions and leaves uncertainty explicit', async () => {
  let calls = 0;
  let current = structuredClone(context);
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    calls++;
    const missing: Plan = { ...gapPlan(), outcome: 'needs_context', changes: [],
      assessments: [{ criterion: 1, status: 'unknown', observation: 'Relevant code still missing.', evidence: [] }],
      contextRequests: [{ repository: 'website', path: 'products.ts', startLine: calls + 1, endLine: calls + 1, reason: 'Inspect the next source line' }], questions: ['Where is filtering implemented?'] };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: { content: JSON.stringify(assessmentResponse(missing)) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'fake', timeoutMs: 10000, numCtx: 8192, tokenCounter });
    const plan = await provider.plan(requirement, current, { resolveContext: async requests => {
      current = { ...current, files: [...current.files, { repository: 'website', path: 'products.ts', content: '// incomplete evidence', startLine: requests[0].startLine, endLine: requests[0].endLine, truncated: true }],
        followUps: [...(current.followUps ?? []), { requests, served: requests, warnings: [] }] };
      return current;
    } });
    assert.equal(calls, 3); assert.equal(provider.lastMetrics?.contextRounds, 2); assert.equal(plan.outcome, 'needs_context'); assert.equal(plan.changes.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('adjacent excerpts cover a requested range without hiding missing lines', () => {
  const adjacent = { files: [{ ...context.files[0], startLine: 1, endLine: 2, content: 'one\ntwo' }, { ...context.files[0], startLine: 3, endLine: 4, content: 'three\nfour' }], warnings: [] };
  const request = { repository: 'website' as const, path: 'products.ts', startLine: 2, endLine: 4 };
  assert.equal(rangeSupplied(adjacent, request), true);
  assert.equal(suppliedRanges(adjacent).length, 1);
  adjacent.files[1].startLine = 4;
  assert.equal(rangeSupplied(adjacent, request), false);
});

test('follow-ups retain prior requested code and cited evidence under packing pressure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-retain-'));
  try {
    await writeFile(path.join(root, 'next.ts'), 'export const next = true;');
    const previous = { ...structuredClone(context), files: [
      { ...context.files[0], path: 'unrelated.ts', content: 'const irrelevant = "' + 'x'.repeat(13500) + '";' },
      { ...context.files[0], path: 'currency.ts', content: 'export const convert = (price) => price * rate;\n' + '// retained context\n'.repeat(149), endLine: 150, reason: 'requested' as const },
      { ...context.files[0], path: 'controls.ts', content: 'export const decrement = (quantity) => Math.max(1, quantity - 1);' },
    ], availableFiles: [{ repository: 'website' as const, path: 'next.ts' }] };
    const citation = [...evidenceCatalog(previous).values()].find(c => c.path === 'controls.ts')!;
    const request = { repository: 'website' as const, path: 'next.ts', startLine: 1, endLine: 1, reason: 'Read the next helper' };
    const options = { indexDir: root, numCtx: 8192, tokenCounter, embedder: { model: 'fake', async embed() { return []; } } };
    const expanded = await expandContext({ website: root, tests: root }, requirement, previous, [request], options, [citation]);
    assert.ok(expanded.files.some(f => f.path === 'currency.ts'));
    assert.ok(expanded.files.some(f => f.path === 'controls.ts'));
    assert.ok(expanded.files.some(f => f.path === 'next.ts'));
    assert.equal(expanded.files.some(f => f.path === 'unrelated.ts'), false);
    assert.ok(expanded.retrieval === undefined || expanded.retrieval.promptTokens <= expanded.retrieval.promptBudget);
    assert.ok([...evidenceCatalog(expanded).values()].some(c => c.quote === citation.quote));
    const blocked = await expandContext({ website: root, tests: root }, requirement, previous, [request], { ...options, tokenCounter: { model: 'fake', count: text => text.includes('export const convert') ? 6000 : 100 } }, [citation]);
    assert.deepEqual(blocked.files, previous.files);
    assert.equal(blocked.followUps?.at(-1)?.served.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
