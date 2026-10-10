import type { ContextRequest, CriterionAssessment, Plan, RepositoryContext, Requirement } from '../types.ts';
import { evidenceCatalog, resolveEvidence } from './evidence.ts';
import { validateAssessments, validateContextRequests, validatePlan } from './schema.ts';
import { rangeSupplied } from '../repositories/ranges.ts';

export type AssessmentAudit = {
  evidenceChecks: { evidenceId: string; relation: 'direct' | 'definition_only' | 'unrelated'; supportsObservation: boolean; explanation: string }[];
  uncertainties: { kind: 'source' | 'policy'; question: string }[];
};
export type AssessmentResponse = { summary: string; assessments: { criterion: number; criterionText: string; status: CriterionAssessment['status']; observation: string; evidenceIds: string[]; audit: AssessmentAudit }[]; contextRequests: ContextRequest[]; questions: string[] };
export type DraftResponse = { criteria: { criterion: number; criterionText: string; changes: { repository: 'website' | 'tests'; path: string; gap: string; evidenceIds: string[]; reason: string; steps: string[] }[]; testScenarios: string[] }[]; risks: string[]; questions: string[] };
export type ReviewResponse = { checks: { criterion: number; criterionText: string; criterionAligned: boolean; stepsMatchTests: boolean; evidenceSupportsGap: boolean; scenarioChecks: { scenario: string; executable: boolean; resultMatches: boolean; observation: string }[]; issues: string[] }[]; riskIssues: { risk: string; issue: string }[] };
const strings = { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 400 } };
const repository = { type: 'string', enum: ['website', 'tests'] };
const objectSchema = <T extends Record<string, unknown>>(properties: T) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const ids = (context: RepositoryContext, required = false) => {
  const keys = [...evidenceCatalog(context).keys()];
  return { type: 'array', minItems: required ? 1 : 0, maxItems: 4, items: keys.length ? { type: 'string', enum: keys } : { type: 'string', const: 'NO_EVIDENCE_AVAILABLE' } };
};
function criterionArray<T extends Record<string, unknown>>(requirement: Requirement, numbers: number[], fields: (number: number) => T | T[]) {
  if (!numbers.length) throw new Error('Stage schema requires at least one criterion');
  const variants = numbers.flatMap(number => {
    const properties = fields(number);
    return (Array.isArray(properties) ? properties : [properties]).map(fields => objectSchema({ criterion: { type: 'integer', const: number }, criterionText: { type: 'string', const: requirement.acceptanceCriteria[number - 1] }, ...fields }));
  });
  return { type: 'array', minItems: numbers.length, maxItems: numbers.length, items: variants.length === 1 ? variants[0] : { anyOf: variants } };
}
export function assessmentSchema(context: RepositoryContext, requirement: Requirement) {
  const audit = objectSchema({ evidenceChecks: { type: 'array', maxItems: 4, items: objectSchema({ evidenceId: ids(context).items,
    relation: { type: 'string', enum: ['direct', 'definition_only', 'unrelated'] }, supportsObservation: { type: 'boolean' }, explanation: { type: 'string', minLength: 1, maxLength: 200 } }) },
    uncertainties: { type: 'array', maxItems: 8, items: objectSchema({ kind: { type: 'string', enum: ['source', 'policy'] }, question: { type: 'string', minLength: 1, maxLength: 400 } }) } });
  return objectSchema({ summary: { type: 'string', maxLength: 300 }, assessments: criterionArray(requirement, requirement.acceptanceCriteria.map((_, i) => i + 1), () => [
    { status: { type: 'string', enum: ['implemented', 'gap'] }, observation: { type: 'string', maxLength: 300 }, evidenceIds: ids(context, true), audit },
    { status: { type: 'string', enum: ['unknown'] }, observation: { type: 'string', maxLength: 300 }, evidenceIds: ids(context), audit },
  ]),
    contextRequests: { type: 'array', maxItems: 3, items: objectSchema({ repository, path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, reason: { type: 'string', maxLength: 300 } }) }, questions: strings });
}
export function draftSchema(context: RepositoryContext, requirement: Requirement, base: Plan) {
  return objectSchema({ criteria: criterionArray(requirement, base.assessments.filter(a => a.status === 'gap').map(a => a.criterion), () => ({
    changes: { type: 'array', minItems: 1, maxItems: 4, items: objectSchema({ repository, path: { type: 'string' }, gap: { type: 'string', maxLength: 300 }, evidenceIds: ids(context, true), reason: { type: 'string', maxLength: 300 }, steps: { ...strings, minItems: 1 } }) }, testScenarios: { ...strings, minItems: 1 } })), risks: strings, questions: strings });
}
export function reviewSchema(requirement: Requirement, base: Plan, draft: DraftResponse) {
  return objectSchema({ checks: criterionArray(requirement, base.assessments.filter(a => a.status === 'gap').map(a => a.criterion), number => {
    const scenarios = draft.criteria.find(c => c.criterion === number)!.testScenarios;
    return { criterionAligned: { type: 'boolean' }, stepsMatchTests: { type: 'boolean' }, evidenceSupportsGap: { type: 'boolean' }, scenarioChecks: { type: 'array', minItems: scenarios.length, maxItems: scenarios.length, items: objectSchema({ scenario: { type: 'string', enum: scenarios }, executable: { type: 'boolean' }, resultMatches: { type: 'boolean' }, observation: { type: 'string', maxLength: 300 } }) }, issues: strings };
  }), riskIssues: { type: 'array', maxItems: draft.risks.length, items: objectSchema({
    risk: draft.risks.length ? { type: 'string', enum: draft.risks } : { type: 'string', const: 'NO_DRAFT_RISK' },
    issue: { type: 'string', minLength: 1, maxLength: 400 },
  }) } });
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid stage object');
  const result = value as Record<string, unknown>;
  if (keys.some(key => !(key in result)) || Object.keys(result).some(key => !keys.includes(key))) throw new Error('Invalid stage fields');
  return result;
}
function text(value: unknown, max = 400): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Stage text is missing or exceeds its length limit');
}
function stringList(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Stage list exceeds eight entries');
  value.forEach(item => text(item));
}
function criterionRows(value: unknown, expected: number[], requirement: Requirement, keys: string[]): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length !== expected.length) throw new Error(`Assess or plan every required criterion exactly once: return ${expected.length} rows for [${expected.join(', ')}]; received ${Array.isArray(value) ? value.length : 'non-array'}`);
  const seen = new Set<number>();
  return value.map(row => {
    const result = object(row, keys);
    const id = result.criterion;
    if (!Number.isInteger(id) || !expected.includes(id as number) || seen.has(id as number)) throw new Error(`Invalid or duplicate stage criterion ${id}; return each of [${expected.join(', ')}] exactly once`);
    if (result.criterionText !== requirement.acceptanceCriteria[(id as number) - 1]) throw new Error(`Criterion ${id} text must exactly match its acceptance criterion`);
    seen.add(id as number); return result;
  });
}
export function assessmentPlan(value: unknown, context: RepositoryContext, requirement: Requirement): { response: AssessmentResponse; plan: Plan; redundantRequests: ContextRequest[] } {
  const a = object(value, ['summary', 'assessments', 'contextRequests', 'questions']);
  text(a.summary, 300); stringList(a.questions);
  const rows = criterionRows(a.assessments, requirement.acceptanceCriteria.map((_, i) => i + 1), requirement, ['criterion', 'criterionText', 'status', 'observation', 'evidenceIds', 'audit']);
  const catalog = evidenceCatalog(context);
  const assessments = rows.map(row => {
    if (!['implemented', 'gap', 'unknown'].includes(row.status as string)) throw new Error('Invalid assessment status');
    text(row.observation, 300);
    return { criterion: row.criterion as number, status: row.status as CriterionAssessment['status'], observation: row.observation, evidence: resolveEvidence(row.evidenceIds, catalog, row.status !== 'unknown') };
  });
  const unknown = assessments.some(row => row.status === 'unknown');
  const gaps = assessments.some(row => row.status === 'gap');
  validateAssessments(assessments, context, requirement);
  const requests = validateContextRequests(a.contextRequests, context);
  // Removing an already-supplied request changes no evidence or criterion status.
  // Unknown criteria keep their requests so the provider can reassess with feedback.
  const redundantRequests = unknown ? [] : requests.filter(request => rangeSupplied(context, request));
  const contextRequests = requests.filter(request => !redundantRequests.includes(request));
  if (unknown && !a.questions.length) throw new Error('Unknown criteria require explicit questions');
  if (!unknown && a.questions.length) throw new Error('Assessment questions require unknown criteria: unresolved source facts or business decisions must be unknown, not gaps');
  const assignedQuestions = new Set<string>();
  let hasSourceUncertainty = false;
  for (const row of rows) {
    const audit = object(row.audit, ['evidenceChecks', 'uncertainties']);
    const selectedIds = row.evidenceIds as string[];
    if (!Array.isArray(audit.evidenceChecks) || audit.evidenceChecks.length !== selectedIds.length) throw new Error('Audit every selected evidence ID exactly once');
    const checkedIds = new Set<string>();
    for (const entry of audit.evidenceChecks) {
      const check = object(entry, ['evidenceId', 'relation', 'supportsObservation', 'explanation']);
      if (typeof check.evidenceId !== 'string' || !selectedIds.includes(check.evidenceId) || checkedIds.has(check.evidenceId)) throw new Error('Evidence audit IDs must match the selected criterion evidence exactly once');
      if (!['direct', 'definition_only', 'unrelated'].includes(check.relation as string) || typeof check.supportsObservation !== 'boolean') throw new Error('Invalid evidence audit relation or support flag');
      text(check.explanation, 200); checkedIds.add(check.evidenceId);
      if (row.status !== 'unknown' && (check.relation !== 'direct' || !check.supportsObservation)) throw new Error(`Criterion ${row.criterion}: resolved observations require direct supporting evidence; use unknown or remove unrelated citations`);
      if (check.relation === 'unrelated' && check.supportsObservation) throw new Error('Unrelated evidence cannot support an observation');
    }
    if (!Array.isArray(audit.uncertainties) || audit.uncertainties.length > 8) throw new Error('Invalid assessment uncertainties');
    if (row.status !== 'unknown' && audit.uncertainties.length) throw new Error('Unresolved source or policy decisions require unknown criteria before drafting');
    if (row.status === 'unknown' && !audit.uncertainties.length) throw new Error('Unknown criteria require their own source or policy question');
    const seenQuestions = new Set<string>();
    for (const entry of audit.uncertainties) {
      const uncertainty = object(entry, ['kind', 'question']); text(uncertainty.question);
      if (!['source', 'policy'].includes(uncertainty.kind as string) || !(a.questions as string[]).includes(uncertainty.question) || seenQuestions.has(uncertainty.question)) throw new Error('Assign each uncertainty once to its criterion and copy its question into questions');
      seenQuestions.add(uncertainty.question); assignedQuestions.add(uncertainty.question);
      if (uncertainty.kind === 'source') hasSourceUncertainty = true;
    }
  }
  if ((a.questions as string[]).some(question => !assignedQuestions.has(question))) throw new Error('Every question must belong to an unknown criterion audit');
  if (unknown && !hasSourceUncertainty && contextRequests.length) throw new Error('Policy questions cannot be resolved by source requests; return contextRequests=[]');
  if (!unknown && contextRequests.length) throw new Error('Resolved assessments cannot have pending context requests');
  const plan: Plan = { schemaVersion: 2, outcome: unknown ? 'needs_context' : gaps ? 'changes_needed' : 'already_implemented', summary: a.summary, assessments,
    changes: [], contextRequests, testScenarios: requirement.acceptanceCriteria.map(c => `Verify: ${c}`), risks: [], questions: a.questions };
  if (unknown || !gaps) validatePlan(plan, context, requirement);
  return { response: { ...(value as AssessmentResponse), contextRequests }, plan, redundantRequests };
}
export function draftPlan(value: unknown, response: AssessmentResponse, base: Plan, context: RepositoryContext, requirement: Requirement): { response: DraftResponse; plan: Plan } {
  const d = object(value, ['criteria', 'risks', 'questions']); stringList(d.risks); stringList(d.questions);
  if (d.questions.length) throw new Error('Draft contains unresolved questions; resolve source or policy uncertainty in assessment before locking gaps');
  const gaps = base.assessments.filter(row => row.status === 'gap').map(row => row.criterion);
  const rows = criterionRows(d.criteria, gaps, requirement, ['criterion', 'criterionText', 'changes', 'testScenarios']);
  const catalog = evidenceCatalog(context);
  const changes: Plan['changes'] = [], scenarios: string[] = [];
  for (const row of rows) {
    stringList(row.testScenarios);
    if (!(row.testScenarios as string[]).length) throw new Error('Every gap needs test scenarios');
    if (new Set(row.testScenarios as string[]).size !== (row.testScenarios as string[]).length) throw new Error('Draft test scenarios must be distinct within each criterion');
    scenarios.push(...(row.testScenarios as string[]).map(scenario => `Criterion ${row.criterion}: ${scenario}`));
    if (!Array.isArray(row.changes) || !row.changes.length || row.changes.length > 4) throw new Error('Each gap requires one to four relevant changes');
    for (const value of row.changes) {
      const c = object(value, ['repository', 'path', 'gap', 'evidenceIds', 'reason', 'steps']);
      text(c.gap, 300); text(c.reason, 300); stringList(c.steps);
      const evidence = resolveEvidence(c.evidenceIds, catalog, true);
      const assessedIds = response.assessments.find(a => a.criterion === row.criterion)!.evidenceIds;
      if (!(c.evidenceIds as string[]).some(id => assessedIds.includes(id))) throw new Error('Change must retain evidence from its locked gap assessment');
      changes.push({ repository: c.repository as 'website' | 'tests', path: c.path as string, criterion: row.criterion as number, gap: c.gap, reason: c.reason, steps: c.steps, evidence });
    }
  }
  const plan = validatePlan({ ...base, changes, testScenarios: [...base.assessments.filter(a => a.status === 'implemented').map(a => `Verify: ${requirement.acceptanceCriteria[a.criterion - 1]}`), ...scenarios], risks: d.risks, questions: d.questions }, context, requirement);
  return { response: value as DraftResponse, plan };
}
export function validateReview(value: unknown, base: Plan, requirement: Requirement, draft: DraftResponse): ReviewResponse {
  const r = object(value, ['checks', 'riskIssues']);
  if (!Array.isArray(r.riskIssues) || r.riskIssues.length > draft.risks.length) throw new Error('Risk findings must reference actual draft risks; return [] when risks is empty');
  const seenRisks = new Set<string>();
  for (const value of r.riskIssues) {
    const finding = object(value, ['risk', 'issue']);
    if (typeof finding.risk !== 'string' || !draft.risks.includes(finding.risk) || seenRisks.has(finding.risk)) throw new Error('Risk findings must name each actual draft risk at most once');
    text(finding.issue); seenRisks.add(finding.risk);
  }
  const gaps = base.assessments.filter(row => row.status === 'gap').map(row => row.criterion);
  const rows = criterionRows(r.checks, gaps, requirement, ['criterion', 'criterionText', 'criterionAligned', 'stepsMatchTests', 'evidenceSupportsGap', 'scenarioChecks', 'issues']);
  for (const row of rows) {
    stringList(row.issues);
    const scenarios = draft.criteria.find(c => c.criterion === row.criterion)!.testScenarios;
    if (!Array.isArray(row.scenarioChecks) || row.scenarioChecks.length !== scenarios.length) throw new Error('Review every draft test scenario exactly once');
    const seen = new Set<string>();
    for (const value of row.scenarioChecks) {
      const check = object(value, ['scenario', 'executable', 'resultMatches', 'observation']);
      if (typeof check.scenario !== 'string' || !scenarios.includes(check.scenario) || seen.has(check.scenario) || typeof check.executable !== 'boolean' || typeof check.resultMatches !== 'boolean') throw new Error('Invalid or duplicate scenario review');
      text(check.observation, 300); seen.add(check.scenario);
    }
    // A contradictory summary is a consistency finding, not a structural repair.
    // The provider independently rejects every failed scenario before acceptance.
    const flags = [row.criterionAligned, row.stepsMatchTests, row.evidenceSupportsGap];
    if (flags.some(flag => typeof flag !== 'boolean') || (flags.some(flag => flag === false) !== ((row.issues as string[]).length > 0))) throw new Error('Review flags and issues must agree');
  }
  return value as ReviewResponse;
}
