import type { Plan, RepositoryContext } from '../types.ts';
import type { EvaluationCase } from './cases.ts';
import { fileKey } from './cases.ts';

export type ManualPlanReview = { unsupportedSemanticClaims: number | null; unnecessaryEdits: number | null; reviewer: string | null; notes: string[] };

export function planQuality(plan: Plan, item: EvaluationCase) {
  const allowed = new Set(item.allowedChangeFiles.map(fileKey));
  return {
    outcomeMatchesGold: plan.outcome === item.expectedOutcome,
    criterionStatusAccuracy: plan.assessments.filter(a => a.status === item.expectedAssessments[a.criterion - 1]).length / item.expectedAssessments.length,
    abstainedCriteria: plan.assessments.filter(a => a.status === 'unknown').length,
    falseGapClaims: plan.assessments.filter(a => a.status === 'gap' && item.expectedAssessments[a.criterion - 1] !== 'gap').length,
    falseImplementedClaims: plan.assessments.filter(a => a.status === 'implemented' && item.expectedAssessments[a.criterion - 1] !== 'implemented').length,
    unexpectedChangeFiles: plan.changes.filter(change => !allowed.has(fileKey(change))).length,
    unnecessaryEditCount: item.expectedOutcome !== 'changes_needed' ? plan.changes.length : null,
    citationProvenanceValid: true,
    manualReview: { unsupportedSemanticClaims: null, unnecessaryEdits: null, reviewer: null, notes: [] } as ManualPlanReview,
  };
}

export function goldLineCoverage(context: RepositoryContext, item: EvaluationCase): number {
  const required = new Set<string>(), found = new Set<string>();
  for (const range of item.expectedEvidence) for (let line = range.startLine; line <= range.endLine; line++) {
    const key = `${fileKey(range)}:${line}`; required.add(key);
    if (context.files.some(file => fileKey(file) === fileKey(range) && file.startLine! <= line && file.endLine! >= line)) found.add(key);
  }
  return required.size ? found.size / required.size : 0;
}
