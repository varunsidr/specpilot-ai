import { randomUUID } from 'node:crypto';
import { collectContext } from '../repositories/context.ts';
import { saveRun } from '../runs/store.ts';
import type { AIProvider, Requirement, Run } from '../types.ts';
import type { SemanticOptions } from '../repositories/semantic-context.ts';
export async function createPlan(requirement: Requirement, provider: AIProvider, roots: { website: string; tests: string }, runsDir: string, semantic?: SemanticOptions): Promise<Run> {
  const started = Date.now();
  const run: Run = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), provider: provider.name, requirement };
  await saveRun(runsDir, run);
  try {
    run.context = await collectContext(roots, requirement, semantic);
    run.plan = await provider.plan(requirement, run.context);
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : 'Planning failed';
  }
  run.durationMs = Date.now() - started;
  await saveRun(runsDir, run);
  return run;
}
