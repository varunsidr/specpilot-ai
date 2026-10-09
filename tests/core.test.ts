import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateRequirement } from '../src/requirements/validate.ts';
import { collectContext } from '../src/repositories/context.ts';
import { validatePlan } from '../src/providers/schema.ts';
import { MockProvider } from '../src/providers/mock.ts';
import { createPlan } from '../src/workflows/plan.ts';
import { readRun } from '../src/runs/store.ts';
const requirement = { title: 'Price filter', description: 'Filter products by maximum price', acceptanceCriteria: ['Include boundary price'] };
test('rejects malformed requirement input', () => {
  assert.throws(() => validateRequirement({ ...requirement, acceptanceCriteria: [] }));
  assert.throws(() => validateRequirement({ ...requirement, title: ' ' }));
  assert.deepEqual(validateRequirement(requirement), requirement);
});
test('context excludes env files, dependencies and symlinks', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-context-'));
  try {
    await mkdir(path.join(root, 'node_modules'));
    await mkdir(path.join(root, 'allure-results'));
    await writeFile(path.join(root, 'products.ts'), 'export const price = 10;');
    await writeFile(path.join(root, '.env'), 'SECRET=hidden');
    await writeFile(path.join(root, 'credentials.json'), '{"secret":"hidden"}');
    await writeFile(path.join(root, 'node_modules', 'hidden.ts'), 'hidden');
    await writeFile(path.join(root, 'allure-results', 'report.json'), '{"generated":true}');
    try { await symlink(path.join(root, 'products.ts'), path.join(root, 'linked.ts')); }
    catch (error) {
      // Windows may require Developer Mode for symlink creation.
      if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    const result = await collectContext({ website: root, tests: root }, requirement);
    assert.equal(result.files.length, 2);
    assert.ok(result.files.every(f => f.path === 'products.ts'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('rejects model references to files outside the retrieved context', () => {
  const plan = { summary: 'Plan', changes: [{ repository: 'website', path: '../secret.ts', reason: 'x', steps: [] }], testScenarios: [], risks: [], questions: [] };
  assert.throws(() => validatePlan(plan, { files: [], warnings: [] }, requirement));
});
test('mock workflow persists a completed run and failed provider persists failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ai-run-'));
  try {
    const repo = path.join(root, 'repo'); await mkdir(repo);
    await writeFile(path.join(repo, 'products.ts'), 'export const price = 10;');
    const runs = path.join(root, 'runs');
    const completed = await createPlan(requirement, new MockProvider(), { website: repo, tests: repo }, runs);
    assert.equal(completed.status, 'completed');
    assert.match(completed.plan!.summary, /MOCK ONLY/);
    assert.equal((await readRun(runs, completed.id))?.status, 'completed');
    const failed = await createPlan(requirement, { name: 'broken', async plan() { throw new Error('Model unavailable'); } }, { website: repo, tests: repo }, runs);
    assert.equal(failed.status, 'failed');
    assert.equal((await readRun(runs, failed.id))?.error, 'Model unavailable');
    assert.equal(await readRun(runs, '../outside'), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});
