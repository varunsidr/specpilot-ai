import test from 'node:test';
import assert from 'node:assert/strict';
import { goldLineCoverage, planQuality } from '../src/evaluation/quality.ts';
import { goldDrift, sourceState, type EvaluationCase } from '../src/evaluation/cases.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { freezeRepositories } from '../src/evaluation/freeze.ts';
import { buildIndexes, readIndex } from '../src/repositories/index.ts';
import { context, gapPlan, requirement } from './plan-fixtures.ts';

test('correctness metrics penalize unnecessary edits even when gold paths match', () => {
  const item: EvaluationCase = { id: 'existing', category: 'implemented', requirement,
    expectedFiles: [{ repository: 'website', path: 'products.ts' }], expectedEvidence: [{ repository: 'website', path: 'products.ts', startLine: 1, endLine: 2 }],
    expectedOutcome: 'already_implemented', expectedAssessments: ['implemented'], allowedChangeFiles: [], scenarioTerms: [] };
  const result = planQuality(gapPlan(), item);
  assert.equal(result.outcomeMatchesGold, false);
  assert.equal(result.unnecessaryEditCount, 1);
  assert.equal(result.falseGapClaims, 1);
  assert.equal(result.manualReview.unsupportedSemanticClaims, null);
  assert.equal(goldLineCoverage(context, item), 0.5);
});

test('a frozen gold snapshot detects source edits during evaluation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'specpilot-eval-'));
  try {
    const file = path.join(root, 'products.ts');
    await writeFile(file, 'export const price = 10;\n');
    const item: EvaluationCase = { id: 'existing', category: 'implemented', requirement,
      expectedFiles: [{ repository: 'website', path: 'products.ts' }], expectedEvidence: [{ repository: 'website', path: 'products.ts', startLine: 1, endLine: 1 }],
      expectedOutcome: 'already_implemented', expectedAssessments: ['implemented'], allowedChangeFiles: [], scenarioTerms: [] };
    const roots = { website: root, tests: root };
    const snapshot = { reviewedAt: new Date().toISOString(), files: await sourceState(roots, [item]) };
    assert.deepEqual(await goldDrift(roots, [item], snapshot), []);
    await writeFile(file, 'export const price = 20;\n');
    assert.deepEqual(await goldDrift(roots, [item], snapshot), ['website:products.ts']);
    assert.notEqual((await sourceState(roots, [item]))[0].sha256, snapshot.files[0].sha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('evaluation copies exclude private files and reuse only unchanged index entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'specpilot-freeze-'));
  try {
    const source = path.join(root, 'source'); await mkdir(source);
    await writeFile(path.join(source, 'products.ts'), 'export const price = 10;');
    await writeFile(path.join(source, 'stable.ts'), 'export const stable = true;');
    await writeFile(path.join(source, '.env'), 'PRIVATE_VALUE=local');
    const index = path.join(root, 'index');
    await buildIndexes({ website: source, tests: source }, index, { model: 'fake', async embed(texts) { return texts.map(() => [1, 0]); } });
    await writeFile(path.join(source, 'products.ts'), 'export const price = 200;');
    const frozen = await freezeRepositories({ website: source, tests: source }, index, path.join(root, 'frozen'), 'fake');
    assert.equal(frozen.reports[0].files, 2); assert.equal(frozen.reports[0].reusedFiles, 1);
    assert.deepEqual((await readIndex(frozen.indexDir, 'website', frozen.roots.website, 'fake')).files.map(f => f.path), ['stable.ts']);
    await assert.rejects(readFile(path.join(frozen.roots.website, '.env')), { code: 'ENOENT' });
    await writeFile(path.join(source, 'products.ts'), 'export const price = 300;');
    assert.equal(await readFile(path.join(frozen.roots.website, 'products.ts'), 'utf8'), 'export const price = 200;');
  } finally { await rm(root, { recursive: true, force: true }); }
});
