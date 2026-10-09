import { randomUUID } from 'node:crypto';
import { collectContext } from '../repositories/context.ts';
import { expandContext } from '../repositories/expand-context.ts';
import { validatePlan } from '../providers/schema.ts';
import { saveRun } from '../runs/store.ts';
import type { AIProvider, Requirement, Run } from '../types.ts';
import type { SemanticOptions } from '../repositories/semantic-context.ts';
export async function createPlan(requirement: Requirement, provider: AIProvider, roots: { website: string; tests: string }, runsDir: string, semantic?: SemanticOptions): Promise<Run> {
  const started = Date.now();
  const run: Run = { id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), provider: provider.name, requirement };
  await saveRun(runsDir, run);
  try {
    run.context = await collectContext(roots, requirement, semantic);
    const context = run.context;
    const proposed = await provider.plan(requirement, context, semantic ? { resolveContext: async (requests, retainEvidence) => {
      const expanded = await expandContext(roots, requirement, context, requests, semantic, retainEvidence);
      Object.assign(context, expanded);
      return context;
    } } : undefined);
    run.plan = validatePlan(proposed, context, requirement);
    run.status = 'completed';
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : 'Planning failed';
  }
  run.durationMs = Date.now() - started;
  if (provider.lastMetrics) run.planningMetrics = structuredClone(provider.lastMetrics);
  await saveRun(runsDir, run);
  return run;
}
