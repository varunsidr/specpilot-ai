import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CriterionAssessment, Evidence, PinnedFile, Plan, Requirement } from '../types.ts';
import { validateRequirement } from '../requirements/validate.ts';
import { inventory } from '../repositories/scan.ts';

export type EvaluationCase = { id: string; category: 'implemented' | 'missing' | 'ambiguous'; requirement: Requirement; expectedFiles: PinnedFile[];
  expectedEvidence: Omit<Evidence, 'quote'>[]; expectedOutcome: Plan['outcome']; expectedAssessments: CriterionAssessment['status'][];
  allowedChangeFiles: PinnedFile[]; scenarioTerms: string[] };
export type SourceSnapshot = { reviewedAt: string; files: (PinnedFile & { sha256: string })[] };
export const fileKey = (file: PinnedFile) => `${file.repository}:${file.path}`;
export async function loadCases(filename: string | URL = process.env.EVAL_CASES_FILE ?? new URL('../../evals/requirements.json', import.meta.url)): Promise<EvaluationCase[]> {
  const cases = JSON.parse(await readFile(filename, 'utf8')) as EvaluationCase[];
  const seen = new Set<string>();
  for (const item of cases) {
    if (!item.id || seen.has(item.id) || !['implemented', 'missing', 'ambiguous'].includes(item.category)) throw new Error('Invalid evaluation ID or category');
    seen.add(item.id);
    item.requirement = validateRequirement(item.requirement);
    for (const files of [item.expectedFiles, item.allowedChangeFiles, item.expectedEvidence]) validateRequirement({ ...item.requirement, pinnedFiles: [...new Map(files.map(({ repository, path }) => [`${repository}:${path}`, { repository, path }])).values()] });
    if (!item.expectedFiles.length || item.expectedAssessments.length !== item.requirement.acceptanceCriteria.length || item.expectedAssessments.some(status => !['implemented', 'gap', 'unknown'].includes(status)) || !['already_implemented', 'changes_needed', 'needs_context'].includes(item.expectedOutcome)) throw new Error(`Invalid gold assessments: ${item.id}`);
    if (item.expectedEvidence.some(range => !Number.isInteger(range.startLine) || !Number.isInteger(range.endLine) || range.startLine < 1 || range.endLine < range.startLine)) throw new Error(`Invalid gold evidence range: ${item.id}`);
  }
  return cases;
}

export async function sourceState(roots: { website: string; tests: string }, cases: EvaluationCase[]): Promise<SourceSnapshot['files']> {
  const eligible = { website: new Set((await inventory(roots.website)).files.map(file => file.path)), tests: new Set((await inventory(roots.tests)).files.map(file => file.path)) };
  const sources = new Map<string, PinnedFile>();
  for (const item of cases) for (const file of [...item.expectedFiles, ...item.expectedEvidence]) sources.set(fileKey(file), { repository: file.repository, path: file.path });
  const result: SourceSnapshot['files'] = [];
  for (const file of sources.values()) {
    if (!eligible[file.repository].has(file.path)) throw new Error(`Gold file is missing or ineligible: ${fileKey(file)}`);
    const raw = await readFile(path.join(roots[file.repository], file.path));
    const count = raw.toString('utf8').split('\n').length;
    for (const item of cases) if (item.expectedEvidence.some(range => fileKey(range) === fileKey(file) && range.endLine > count)) throw new Error(`Gold line range no longer exists: ${item.id}:${fileKey(file)}`);
    result.push({ ...file, sha256: createHash('sha256').update(raw).digest('hex') });
  }
  return result.sort((a, b) => fileKey(a).localeCompare(fileKey(b)));
}

export async function goldDrift(roots: { website: string; tests: string }, cases: EvaluationCase[], snapshot?: SourceSnapshot): Promise<string[]> {
  const saved = snapshot ?? JSON.parse(await readFile(new URL('../../evals/source-snapshot.json', import.meta.url), 'utf8')) as SourceSnapshot;
  const current = await sourceState(roots, cases);
  return current.filter(file => !saved.files.some(prior => fileKey(prior) === fileKey(file) && prior.sha256 === file.sha256)).map(fileKey);
}
