import type { Plan, RepositoryContext } from '../src/types.ts';
import { evidenceCatalog } from '../src/providers/evidence.ts';
import type { AssessmentResponse, DraftResponse, ReviewResponse } from '../src/providers/stages.ts';
export const tokenCounter = { model: 'test', count: (value: string) => Math.ceil(value.length / 4) };
export const requirement = { title: 'Filter', description: 'Price filter', acceptanceCriteria: ['Include boundary'] };
export const context: RepositoryContext = { files: [{ repository: 'website', path: 'products.ts', content: 'export const price = 10;', startLine: 1, endLine: 1, truncated: false }], warnings: [] };
export function gapPlan(): Plan {
  const evidence = [{ repository: 'website' as const, path: 'products.ts', startLine: 1, endLine: 1, quote: 'export const price = 10;' }];
  return { schemaVersion: 2, outcome: 'changes_needed', summary: 'Add a price filter',
    assessments: [{ criterion: 1, status: 'gap', observation: 'The supplied code exposes a fixed price without a filter.', evidence }],
    changes: [{ repository: 'website', path: 'products.ts', criterion: 1, gap: 'No filtering function in this complete sample.', evidence, reason: 'Add the requested comparison.', steps: ['Add an inclusive price comparison.'] }],
    contextRequests: [], testScenarios: ['Include a product exactly at the boundary.'], risks: [], questions: [] };
}
export function assessmentResponse(plan = gapPlan(), supplied = context, req = requirement): AssessmentResponse {
  const catalog = evidenceCatalog(supplied);
  return { summary: plan.summary, assessments: plan.assessments.map(a => {
    const evidenceIds = a.evidence.map(e => [...catalog].find(([, c]) => c.repository === e.repository && c.path === e.path && c.startLine === e.startLine && c.quote.includes(e.quote))![0]);
    return { criterion: a.criterion, criterionText: req.acceptanceCriteria[a.criterion - 1], status: a.status, observation: a.observation, evidenceIds,
      audit: { evidenceChecks: evidenceIds.map(evidenceId => ({ evidenceId, relation: 'direct' as const, supportsObservation: true, explanation: a.observation.slice(0, 200) })),
        uncertainties: a.status === 'unknown' ? plan.questions.map(question => ({ kind: 'source' as const, question })) : [] } };
  }), contextRequests: plan.contextRequests, questions: plan.questions };
}
export function draftResponse(plan = gapPlan()): DraftResponse {
  const evidenceId = [...evidenceCatalog(context).keys()][0];
  return { criteria: plan.assessments.filter(a => a.status === 'gap').map(a => ({ criterion: a.criterion, criterionText: requirement.acceptanceCriteria[a.criterion - 1],
    changes: plan.changes.filter(c => c.criterion === a.criterion).map(({ repository, path, gap, reason, steps }) => ({ repository, path, gap, reason, steps, evidenceIds: [evidenceId] })), testScenarios: plan.testScenarios })), risks: plan.risks, questions: plan.questions };
}
export function positiveReview(): ReviewResponse {
  return { checks: [{ criterion: 1, criterionText: requirement.acceptanceCriteria[0], criterionAligned: true, stepsMatchTests: true, evidenceSupportsGap: true, scenarioChecks: gapPlan().testScenarios.map(scenario => ({ scenario, executable: true, resultMatches: true, observation: 'The comparison includes a product equal to the boundary.' })), issues: [] }], riskIssues: [] };
}
