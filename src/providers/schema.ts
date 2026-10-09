import type { ContextRequest, CriterionAssessment, Evidence, Plan, RepositoryContext, Requirement } from '../types.ts';
const strings = { type: 'array', items: { type: 'string' } };
const repository = { type: 'string', enum: ['website', 'tests'] };
const evidenceSchema = { type: 'array', maxItems: 4, items: {
  type: 'object', additionalProperties: false, required: ['repository', 'path', 'startLine', 'endLine', 'quote'],
  properties: { repository, path: { type: 'string' }, startLine: { type: 'integer', minimum: 1, description: 'Supplied line label containing the exact quote' }, endLine: { type: 'integer', minimum: 1, description: 'Use the same line as startLine for a short single-line quote' }, quote: { type: 'string', maxLength: 500, description: 'Short verbatim source substring without the numeric line label' } },
} };
export const planSchema = {
  type: 'object', additionalProperties: false,
  required: ['schemaVersion', 'outcome', 'summary', 'assessments', 'changes', 'contextRequests', 'testScenarios', 'risks', 'questions'],
  properties: {
    schemaVersion: { type: 'integer', const: 2 },
    outcome: { type: 'string', enum: ['already_implemented', 'changes_needed', 'needs_context'] },
    summary: { type: 'string' },
    assessments: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['criterion', 'status', 'observation', 'evidence'],
      properties: { criterion: { type: 'integer', minimum: 1 }, status: { type: 'string', enum: ['implemented', 'gap', 'unknown'] }, observation: { type: 'string' }, evidence: evidenceSchema },
    } },
    changes: { type: 'array', maxItems: 12, items: {
      type: 'object', additionalProperties: false, required: ['repository', 'path', 'criterion', 'gap', 'evidence', 'reason', 'steps'],
      properties: { repository, path: { type: 'string' }, criterion: { type: 'integer', minimum: 1 }, gap: { type: 'string' }, evidence: evidenceSchema, reason: { type: 'string' }, steps: strings },
    } },
    contextRequests: { type: 'array', maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['repository', 'path', 'startLine', 'endLine', 'reason'],
      properties: { repository, path: { type: 'string' }, startLine: { type: 'integer', minimum: 1 }, endLine: { type: 'integer', minimum: 1 }, reason: { type: 'string' } },
    } },
    testScenarios: strings, risks: strings, questions: strings,
  },
};

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plan object');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !(key in result))) throw new Error('Invalid plan fields');
  return result;
}
function range(start: unknown, end: unknown, max: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end) || (start as number) < 1 || (end as number) < (start as number) || (end as number) - (start as number) + 1 > max) throw new Error(`Invalid evidence/context range; maximum ${max} lines`);
}
function evidence(value: unknown, context: RepositoryContext, required: boolean): Evidence[] {
  if (!Array.isArray(value) || value.length > 4 || (required && !value.length)) throw new Error('Evidence is required for an implemented criterion or proposed gap');
  for (const item of value) {
    const citation = object(item, ['repository', 'path', 'startLine', 'endLine', 'quote']);
    range(citation.startLine, citation.endLine, 20);
    if (!text(citation.quote) || citation.quote.length > 500) throw new Error('Evidence needs a short exact quote');
    const supplied = context.files.find(file => file.repository === citation.repository && file.path === citation.path &&
      file.startLine !== undefined && file.endLine !== undefined && file.startLine <= (citation.startLine as number) && file.endLine >= (citation.endLine as number) &&
      file.content.replaceAll('\r\n', '\n').split('\n').slice((citation.startLine as number) - file.startLine, (citation.endLine as number) - file.startLine + 1).join('\n').includes((citation.quote as string).replaceAll('\r\n', '\n')));
    if (!supplied) {
      const snippets = context.files.filter(file => file.repository === citation.repository && file.path === citation.path);
      const ranges = snippets.map(file => `${file.startLine}-${file.endLine}`).join(', ');
      const positions = [...new Set(snippets.flatMap(file => {
        const content = file.content.replaceAll('\r\n', '\n'), quote = (citation.quote as string).replaceAll('\r\n', '\n');
        const offset = content.indexOf(quote);
        return offset < 0 ? [] : [file.startLine! + content.slice(0, offset).split('\n').length - 1];
      }))];
      const hint = positions.length ? `Exact quote occurs at line(s) ${positions.join(', ')}; correct the citation.` : 'Quote is absent; copy a short exact substring or request missing lines.';
      throw new Error(`Unsupported citation: ${citation.repository}:${citation.path}:${citation.startLine}-${citation.endLine}. Supplied ranges: ${ranges || 'none'}. ${hint}`);
    }
  }
  return value as Evidence[];
}

export function validateAssessments(value: unknown, context: RepositoryContext, requirement: Requirement): CriterionAssessment[] {
  if (!Array.isArray(value) || value.length !== requirement.acceptanceCriteria.length) throw new Error('Assess every acceptance criterion exactly once, using 1-based criterion numbers');
  const assessments = new Map<number, string>();
  for (const item of value) {
    const a = object(item, ['criterion', 'status', 'observation', 'evidence']);
    if (!Number.isInteger(a.criterion) || (a.criterion as number) < 1 || (a.criterion as number) > requirement.acceptanceCriteria.length || assessments.has(a.criterion as number) || !['implemented', 'gap', 'unknown'].includes(a.status as string) || !text(a.observation)) throw new Error('Invalid or duplicate criterion assessment');
    evidence(a.evidence, context, a.status !== 'unknown');
    assessments.set(a.criterion as number, a.status as string);
  }
  return value as CriterionAssessment[];
}

export function validateContextRequests(value: unknown, context: RepositoryContext): ContextRequest[] {
  if (!Array.isArray(value) || value.length > 3) throw new Error('Request at most three context ranges');
  const seen = new Set<string>();
  for (const item of value) {
    const request = object(item, ['repository', 'path', 'startLine', 'endLine', 'reason']);
    range(request.startLine, request.endLine, 120);
    if (!text(request.reason) || !(context.availableFiles ?? context.files).some(file => file.repository === request.repository && file.path === request.path)) throw new Error('Context request must name an available repository file');
    const key = `${request.repository}:${request.path}:${request.startLine}-${request.endLine}`;
    if (seen.has(key)) throw new Error('Duplicate context request');
    seen.add(key);
  }
  return value as ContextRequest[];
}

export function validatePlan(value: unknown, context: RepositoryContext, requirement: Requirement): Plan {
  const p = object(value, ['schemaVersion', 'outcome', 'summary', 'assessments', 'changes', 'contextRequests', 'testScenarios', 'risks', 'questions']);
  if (p.schemaVersion !== 2 || !text(p.summary) || !['already_implemented', 'changes_needed', 'needs_context'].includes(p.outcome as string) || !isStrings(p.testScenarios) || !isStrings(p.risks) || !isStrings(p.questions)) throw new Error('Invalid model response: plan fields');
  const assessments = new Map(validateAssessments(p.assessments, context, requirement).map(a => [a.criterion, a.status]));
  if (!Array.isArray(p.changes) || p.changes.length > 12) throw new Error('Invalid changes');
  for (const item of p.changes) {
    const c = object(item, ['repository', 'path', 'criterion', 'gap', 'evidence', 'reason', 'steps']);
    if (!text(c.reason) || !text(c.gap) || !isStrings(c.steps) || !c.steps.length || assessments.get(c.criterion as number) !== 'gap' || !context.files.some(file => file.repository === c.repository && file.path === c.path)) throw new Error('Change must reference a supplied file and a criterion assessed as a gap');
    const citations = evidence(c.evidence, context, true);
    if (!citations.some(citation => citation.repository === c.repository && citation.path === c.path)) throw new Error('Change evidence must include the file being edited');
  }
  const contextRequests = validateContextRequests(p.contextRequests, context);
  const statuses = [...assessments.values()];
  if (statuses.includes('unknown') && !p.questions.length) throw new Error('Unknown criteria require explicit questions');
  if (p.outcome === 'already_implemented' && (statuses.some(status => status !== 'implemented') || p.changes.length || contextRequests.length)) throw new Error('already_implemented requires supported implementation evidence for every criterion and no changes');
  if (p.outcome === 'changes_needed' && (!p.changes.length || contextRequests.length)) throw new Error('changes_needed requires evidence-backed changes and no pending context request');
  if (p.outcome === 'needs_context' && (p.changes.length || !statuses.includes('unknown') || !p.questions.length)) throw new Error('needs_context requires unknown criteria, questions, and no speculative changes');
  return p as Plan;
}
