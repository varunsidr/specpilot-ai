import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ContextFile, ContextRequest, Evidence, RepositoryContext, Requirement } from '../types.ts';
import { rangeSupplied } from './ranges.ts';
import type { SemanticOptions } from './semantic-context.ts';
import { inventory } from './scan.ts';
import { MAX_PLAN_TOKENS, PROMPT_SAFETY_TOKENS, REPAIR_RESERVE_TOKENS, STAGE_RESERVE_TOKENS, promptTokens } from '../providers/prompt.ts';

export async function expandContext(roots: { website: string; tests: string }, requirement: Requirement, context: RepositoryContext, requests: ContextRequest[], options: SemanticOptions, retainEvidence: Evidence[] = []): Promise<RepositoryContext> {
  if (!requests.length || requests.length > 3) throw new Error('Context follow-up needs 1–3 ranges');
  const budget = options.numCtx - MAX_PLAN_TOKENS - PROMPT_SAFETY_TOKENS - REPAIR_RESERVE_TOKENS - STAGE_RESERVE_TOKENS;
  const trace = { requests, served: [] as ContextRequest[], warnings: [] as string[] };
  const requested: { file: ContextFile; request: ContextRequest }[] = [];
  for (const request of requests) {
    if (!['website', 'tests'].includes(request.repository) || !Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine || request.endLine - request.startLine >= 120 ||
      !(context.availableFiles ?? context.files).some(file => file.repository === request.repository && file.path === request.path)) throw new Error('Context request is outside the supplied inventory or range limit');
    if (rangeSupplied(context, request)) {
      trace.warnings.push(`${request.path}:${request.startLine}-${request.endLine}: already supplied; no new evidence`);
      continue;
    }
    const root = roots[request.repository];
    const listing = await inventory(root);
    if (!listing.files.some(file => file.path === request.path)) { trace.warnings.push(`${request.repository}:${request.path}: no longer eligible`); continue; }
    const rootPath = await realpath(root), full = path.join(root, request.path);
    const resolved = await realpath(full);
    const relative = path.relative(rootPath, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || (await lstat(full)).isSymbolicLink()) throw new Error('Context file resolves outside its repository or is a symlink');
    const raw = await readFile(full, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 100000) { trace.warnings.push(`${request.path}: file exceeds inventory size limit`); continue; }
    const lines = raw.replaceAll('\r\n', '\n').split('\n');
    if (request.startLine > lines.length) { trace.warnings.push(`${request.path}: requested lines do not exist`); continue; }
    const endLine = Math.min(request.endLine, lines.length);
    requested.push({ request, file: { repository: request.repository, path: request.path, startLine: request.startLine, endLine,
      content: lines.slice(request.startLine - 1, endLine).join('\n'), truncated: request.startLine > 1 || endLine < lines.length, reason: 'requested' } });
  }
  const noProgress = () => ({ ...context, followUps: [...(context.followUps ?? []), { ...trace, served: [] }] });
  if (!requested.length) return noProgress();
  const next: RepositoryContext = { ...context, files: [], warnings: [...context.warnings, 'Context follow-up preserves pinned, previously requested and cited evidence before adding new ranges.'], followUps: [...(context.followUps ?? []), trace] };
  const add = (file: ContextFile): boolean => {
    if (rangeSupplied(next, { ...file, startLine: file.startLine!, endLine: file.endLine! })) return true;
    if (next.files.length >= 12) return false;
    if (promptTokens(options.tokenCounter, requirement, { ...next, files: [...next.files, file] }) > budget) return false;
    next.files.push(file); return true;
  };
  for (const file of context.files.filter(file => file.reason === 'pinned' || file.reason === 'requested')) {
    if (!add(file)) {
      trace.warnings.push(`${file.path}: preserving prior evidence leaves no room for this follow-up`);
      return noProgress();
    }
  }
  for (const citation of retainEvidence) {
    if (rangeSupplied(next, citation)) continue;
    const file = context.files.find(file => file.repository === citation.repository && file.path === citation.path && file.startLine! <= citation.startLine && file.endLine! >= citation.endLine);
    if (!file) throw new Error('Cannot retain evidence outside supplied context');
    const lines = file.content.replaceAll('\r\n', '\n').split('\n');
    if (!lines.slice(citation.startLine - file.startLine!, citation.endLine - file.startLine! + 1).join('\n').includes(citation.quote)) throw new Error('Cannot retain an unsupported quote');
    const startLine = Math.max(file.startLine!, citation.startLine - 3), endLine = Math.min(file.endLine!, citation.endLine + 3);
    const retained = { ...file, startLine, endLine, content: lines.slice(startLine - file.startLine!, endLine - file.startLine! + 1).join('\n'), reason: 'evidence' as const, truncated: true };
    if (!add(retained)) {
      trace.warnings.push(`${file.path}: cited evidence leaves no room for this follow-up`);
      return noProgress();
    }
  }
  for (const { file, request } of requested) {
    trace.served.push({ ...request, endLine: file.endLine! });
    if (!add(file)) {
      trace.served.pop();
      trace.warnings.push(`${request.path}:${request.startLine}-${request.endLine}: range did not fit`);
    }
  }
  if (!trace.served.length) return noProgress();
  const protectedCount = next.files.length;
  for (const file of context.files) add(file);
  while (next.files.length > protectedCount && promptTokens(options.tokenCounter, requirement, next) > budget) next.files.pop();
  if (promptTokens(options.tokenCounter, requirement, next) > budget) {
    trace.warnings.push('Follow-up metadata and protected evidence exceed the token budget; original evidence retained.');
    return noProgress();
  }
  if (next.retrieval) next.retrieval = { ...next.retrieval, promptTokens: promptTokens(options.tokenCounter, requirement, next), promptBudget: budget };
  return next;
}
