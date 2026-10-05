import type { Plan, RepositoryContext } from '../types.ts';
const strings = { type: 'array', items: { type: 'string' } };
export const planSchema = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'changes', 'testScenarios', 'risks', 'questions'],
  properties: {
    summary: { type: 'string' },
    changes: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['repository', 'path', 'reason', 'steps'],
      properties: { repository: { type: 'string', enum: ['website', 'tests'] }, path: { type: 'string' }, reason: { type: 'string' }, steps: strings },
    } },
    testScenarios: strings, risks: strings, questions: strings,
  },
};
export function validatePlan(value: unknown, context: RepositoryContext): Plan {
  if (!value || typeof value !== 'object') throw new Error('Invalid model response: expected object');
  const p = value as Record<string, unknown>;
  const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (typeof p.summary !== 'string' || !Array.isArray(p.changes) || !isStrings(p.testScenarios) || !isStrings(p.risks) || !isStrings(p.questions)) throw new Error('Invalid model response: plan fields');
  for (const item of p.changes) {
    if (!item || typeof item !== 'object') throw new Error('Invalid change');
    const c = item as Record<string,unknown>;
    if (typeof c.reason !== 'string' || !isStrings(c.steps) || !context.files.some(f => f.repository === c.repository && f.path === c.path)) {
      throw new Error('Model referenced a file outside the supplied context or returned an invalid change');
    }
  }
  return p as Plan;
}
