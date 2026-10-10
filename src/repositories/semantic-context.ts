import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildIndexes, readIndex } from './index.ts';
import type { IndexedChunk } from './index.ts';
import { expandedLines } from './chunks.ts';
import { inventory } from './scan.ts';
import type { Embedder } from './semantic.ts';
import type { TokenCounter } from './tokenizer.ts';
import type { SourceProfile } from './profile.ts';
import { sourceUsage, type SourceUsage } from './usage.ts';
import { InputError } from '../requirements/validate.ts';
import { MAX_PLAN_TOKENS, PROMPT_SAFETY_TOKENS, REPAIR_RESERVE_TOKENS, STAGE_RESERVE_TOKENS, promptTokens } from '../providers/prompt.ts';
import type { ContextFile, CriterionRetrieval, RepositoryName, Requirement, RepositoryContext, SourceLink } from '../types.ts';

export type RetrievalStrategy = 'requirement' | 'criterion';
export type SemanticOptions = { indexDir: string; embedder: Embedder; tokenCounter: TokenCounter; numCtx: number; retrievalStrategy?: RetrievalStrategy };
type Roots = { website: string; tests: string };
type Candidate = { repository: RepositoryName; path: string; raw: string; chunk: IndexedChunk; profile: SourceProfile; usage: SourceUsage;
  lexical: number; semantic: number; score: number; criterionScores: number[]; reason: ContextFile['reason'] };
const stopWords = new Set(['about', 'allow', 'also', 'from', 'into', 'only', 'that', 'them', 'then', 'there', 'these', 'this', 'when', 'where', 'which', 'with']);

function termsFor(text: string): string[] {
  return [...new Set(text
    .toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])].filter(term => !stopWords.has(term));
}

const genericTerms = new Set(['the', 'and', 'for', 'its', 'must', 'each', 'after', 'before', 'than', 'have', 'has', 'not', 'does', 'are', 'all', 'can', 'was', 'will', 'being', 'should']);
function behaviorWords(text: string): Set<string> {
  return new Set(termsFor(text.replace(/([a-z])([A-Z])/g, '$1 $2')).filter(term => !genericTerms.has(term))
    .map(term => term.replace(/(?:ing|ed|s)$/, '')));
}
function behaviorPriority(candidate: Candidate, words: Set<string>, links: SourceLink[]): number {
  const body = behaviorWords(candidate.raw.slice(candidate.chunk.startOffset, candidate.chunk.endOffset));
  if (![...words].some(term => body.has(term))) return 0;
  const facts = candidate.profile.facts.filter(fact => fact.startOffset >= candidate.chunk.startOffset && fact.endOffset <= candidate.chunk.endOffset);
  let score = facts.some(fact => fact.kind === 'handler' || fact.kind === 'guard') ? 0.006 : facts.some(fact => fact.kind === 'state') ? 0.004 : 0;
  if (candidate.usage.definitions.some(definition => definition.startOffset >= candidate.chunk.startOffset && definition.endOffset <= candidate.chunk.endOffset &&
    (definition.uses.length || links.some(link => link.definition.repository === candidate.repository && link.definition.path === candidate.path && link.definition.startLine === definition.startLine)))) score = Math.max(score, 0.005);
  return score;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('RAG index embedding dimensions do not match the query; run npm run index.');
  let dot = 0, an = 0, bn = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; an += a[i] * a[i]; bn += b[i] * b[i]; }
  return an && bn ? dot / Math.sqrt(an * bn) : 0;
}

function sourcePrior(repository: RepositoryName, relative: string): number {
  if (repository === 'website' && relative.startsWith('src/')) return 0.009;
  if (repository === 'tests' && relative.startsWith('tests/') && /\.(?:spec|test)\.[jt]sx?$/.test(relative)) return 0.007;
  if (repository === 'tests' && relative.startsWith('pages/')) return 0.005;
  if (/^(?:docs|specs)\//.test(relative) || relative.endsWith('.md')) return -0.008;
  if (relative.endsWith('.sql')) return -0.006;
  return 0;
}

function importedTarget(relative: string, specifier: string, available: Set<string>): string | undefined {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return undefined;
  const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : path.posix.join(path.posix.dirname(relative), specifier);
  const normalized = path.posix.normalize(base);
  if (normalized.startsWith('../') || normalized.startsWith('/')) return undefined;
  return [normalized, ...['.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx'].map(suffix => normalized + suffix)].find(target => available.has(target));
}
function importedPaths(relative: string, raw: string, available: Set<string>): string[] {
  const found = new Set<string>();
  const pattern = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of raw.matchAll(pattern)) {
    const target = importedTarget(relative, match[1], available);
    if (target) found.add(target);
  }
  return [...found];
}

function asContextFile(candidate: Candidate, nearby: number): ContextFile {
  const expanded = nearby ? expandedLines(candidate.raw, candidate.chunk, nearby) : {
    startLine: candidate.chunk.startLine,
    endLine: candidate.chunk.endLine,
    content: candidate.raw.slice(candidate.chunk.startOffset, candidate.chunk.endOffset),
  };
  return { repository: candidate.repository, path: candidate.path, startLine: expanded.startLine, endLine: expanded.endLine,
    content: expanded.content, truncated: expanded.content.length < candidate.raw.length, reason: candidate.reason };
}

function overlaps(a: ContextFile, b: ContextFile): boolean {
  if (a.repository !== b.repository || a.path !== b.path || a.startLine === undefined || b.startLine === undefined) return false;
  const intersection = Math.max(0, Math.min(a.endLine!, b.endLine!) - Math.max(a.startLine, b.startLine) + 1);
  return intersection > Math.min(a.endLine! - a.startLine + 1, b.endLine! - b.startLine + 1) / 2;
}

export async function collectSemanticContext(roots: Roots, requirement: Requirement, options: SemanticOptions): Promise<RepositoryContext> {
  const files: ContextFile[] = [];
  const warnings: string[] = [];
  const strategy = options.retrievalStrategy ?? 'requirement';
  const budget = options.numCtx - MAX_PLAN_TOKENS - PROMPT_SAFETY_TOKENS - REPAIR_RESERVE_TOKENS - STAGE_RESERVE_TOKENS;
  if (budget <= 0) throw new Error('OLLAMA_NUM_CTX is too small for the reserved plan output');
  const query = `${requirement.title}\n${requirement.description}\n${requirement.acceptanceCriteria.join('\n')}`;
  const terms = termsFor(query);
  const criterionTerms = requirement.acceptanceCriteria.map(termsFor);
  const refreshed = await buildIndexes(roots, options.indexDir, options.embedder);
  for (const report of refreshed) if (report.embedded) warnings.push(`${report.repository}: refreshed ${report.embedded} changed chunks.`);
  // One batch keeps placement checks and model release around every query vector.
  const [queryVector, ...criterionVectors] = await options.embedder.embed([
    query, ...(strategy === 'criterion' ? requirement.acceptanceCriteria.map(criterion => `${requirement.title}\n${requirement.description}\nAcceptance criterion: ${criterion}`) : []),
  ], true);
  const candidates: Candidate[] = [];
  const available = new Map<RepositoryName, Set<string>>();
  for (const repository of ['website', 'tests'] as const) {
    const root = roots[repository];
    const index = await readIndex(options.indexDir, repository, root, options.embedder.model);
    const listing = await inventory(root);
    const current = new Map(listing.files.map(file => [file.path, file]));
    available.set(repository, new Set(current.keys()));
    if (current.size !== index.files.length || index.files.some(file => {
      const now = current.get(file.path);
      return !now || now.size !== file.size || now.mtimeMs !== file.mtimeMs;
    })) warnings.push(`${repository}: files changed during retrieval; rerun planning for a fresh ranking.`);
    if (index.limited || listing.limited) warnings.push(`${repository}: inventory limit reached; some files were not indexed.`);
    const loaded = await Promise.all(index.files.filter(file => current.has(file.path)).map(async file => {
      const full = path.join(root, file.path);
      if ((await lstat(full)).isSymbolicLink()) throw new Error(`Repository file changed during retrieval: ${file.path}`);
      const raw = await readFile(full, 'utf8');
      const usage = strategy === 'criterion' ? sourceUsage(raw, file.path) : { definitions: [], imports: [] };
      return file.chunks.map(chunk => {
        const lower = raw.slice(chunk.startOffset, chunk.endOffset).toLowerCase(), name = file.path.toLowerCase();
        const lexical = terms.reduce((sum, term) => sum + (name.includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0), 0);
        return { repository, path: file.path, raw, chunk, profile: file.profile, usage, lexical, semantic: cosine(queryVector, chunk.vector), score: 0, criterionScores: [] as number[], reason: 'semantic' as const };
      });
    }));
    const group = loaded.flat();
    const semanticRank = new Map([...group].sort((a,b) => b.semantic - a.semantic).map((candidate, i) => [candidate, i]));
    const lexicalRank = new Map([...group].sort((a,b) => b.lexical - a.lexical).map((candidate, i) => [candidate, i]));
    for (const candidate of group) {
      candidate.score = 1 / (60 + semanticRank.get(candidate)!) + (candidate.lexical ? 1 / (60 + lexicalRank.get(candidate)!) : 0) + sourcePrior(repository, candidate.path);
      candidates.push(candidate);
    }
    for (const [criterion, vector] of criterionVectors.entries()) {
      const lexical = new Map(group.map(candidate => {
        const lower = candidate.raw.slice(candidate.chunk.startOffset, candidate.chunk.endOffset).toLowerCase();
        const name = candidate.path.toLowerCase();
        return [candidate, criterionTerms[criterion].reduce((sum, term) => sum + (name.includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0), 0)];
      }));
      const semantic = new Map(group.map(candidate => [candidate, cosine(vector, candidate.chunk.vector)]));
      const semanticRank = new Map([...group].sort((a, b) => semantic.get(b)! - semantic.get(a)!).map((candidate, i) => [candidate, i]));
      const lexicalRank = new Map([...group].sort((a, b) => lexical.get(b)! - lexical.get(a)!).map((candidate, i) => [candidate, i]));
      for (const candidate of group) candidate.criterionScores[criterion] = 1 / (60 + semanticRank.get(candidate)!) +
        (lexical.get(candidate) ? 1 / (60 + lexicalRank.get(candidate)!) : 0) + sourcePrior(repository, candidate.path);
    }
    warnings.push(`${repository}: ranked ${group.length} chunks from ${index.files.length} indexed files.`);
  }
  const pinned = new Set((requirement.pinnedFiles ?? []).map(pin => `${pin.repository}:${pin.path}`));
  const byFile = new Map(candidates.map(candidate => [`${candidate.repository}:${candidate.path}`, candidate]));
  const links: SourceLink[] = [];
  for (const file of byFile.values()) {
    for (const definition of file.usage.definitions) for (const use of definition.uses) links.push({ name: definition.name, kind: use.kind,
      caller: { repository: file.repository, path: file.path, startLine: use.startLine, endLine: use.endLine },
      definition: { repository: file.repository, path: file.path, startLine: definition.startLine, endLine: definition.endLine } });
    for (const use of file.usage.imports) {
      const target = importedTarget(file.path, use.module!, available.get(file.repository)!);
      const definition = target && byFile.get(`${file.repository}:${target}`)?.usage.definitions.find(definition => definition.exportNames.includes(use.importedName!));
      if (target && definition) links.push({ name: use.importedName!, kind: use.kind,
        caller: { repository: file.repository, path: file.path, startLine: use.startLine, endLine: use.endLine },
        definition: { repository: file.repository, path: target, startLine: definition.startLine, endLine: definition.endLine } });
    }
  }
  for (const pin of requirement.pinnedFiles ?? []) if (!available.get(pin.repository)?.has(pin.path)) throw new InputError(`Pinned file is not eligible or does not exist: ${pin.repository}:${pin.path}`);
  const top = [...candidates].sort((a,b) => b.score - a.score).filter((candidate, i, list) => list.findIndex(other => other.repository === candidate.repository && other.path === candidate.path) === i).slice(0, 6);
  const related = new Map<string, ContextFile['reason']>();
  for (const seed of top) {
    for (const target of importedPaths(seed.path, seed.raw, available.get(seed.repository)!)) {
      related.set(`${seed.repository}:${target}`, 'import');
      const dependency = candidates.find(candidate => candidate.repository === seed.repository && candidate.path === target);
      if (dependency) for (const next of importedPaths(target, dependency.raw, available.get(seed.repository)!)) related.set(`${seed.repository}:${next}`, 'import');
    }
    if (seed.repository === 'website') {
      const stem = path.posix.basename(seed.path).replace(/\.[^.]+$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(part => part.length >= 4);
      for (const testPath of available.get('tests') ?? []) {
        if (!/\.(?:spec|test)\.[jt]sx?$/.test(testPath)) continue;
        if (stem.some(part => testPath.toLowerCase().includes(part))) related.set(`tests:${testPath}`, 'test');
      }
    }
  }
  const testEvidence = candidates.filter(candidate => candidate.repository === 'tests' &&
    (top.some(seed => seed.repository === 'tests' && seed.path === candidate.path) || related.has(`tests:${candidate.path}`)));
  for (const evidence of testEvidence) {
    const lines = evidence.raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const nearby = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ').toLowerCase();
      if (!terms.some(term => nearby.includes(term))) continue;
      for (const match of lines[i].matchAll(/getByTestId\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        const selector = match[1];
        for (const candidate of candidates) if (candidate.repository === 'website' && candidate.raw.includes(`data-testid="${selector}"`)) related.set(`website:${candidate.path}`, 'test');
      }
      for (const match of lines[i].matchAll(/\/([a-z][a-z0-9-]{2,})(?:\\|\?|\/|['"`])/g)) {
        const route = `src/app/${match[1]}/page.tsx`;
        if (available.get('website')!.has(route)) related.set(`website:${route}`, 'test');
      }
    }
  }
  for (const candidate of candidates) {
    const relation = related.get(`${candidate.repository}:${candidate.path}`);
    if (relation) { candidate.score += 0.004; candidate.criterionScores = candidate.criterionScores.map(score => score + 0.004); candidate.reason = relation; }
    if (pinned.has(`${candidate.repository}:${candidate.path}`)) { candidate.score += 1; candidate.criterionScores = candidate.criterionScores.map(score => score + 1); candidate.reason = 'pinned'; }
  }
  candidates.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
  const rankedFiles: { repository: RepositoryName; path: string }[] = [];
  for (const candidate of candidates) {
    if (!rankedFiles.some(file => file.repository === candidate.repository && file.path === candidate.path)) rankedFiles.push({ repository: candidate.repository, path: candidate.path });
    if (rankedFiles.length >= 40) break;
  }
  if (candidates.some(candidate => candidate.chunk.endOffset - candidate.chunk.startOffset < candidate.raw.length)) warnings.push('Some files were excerpted; inspect source before applying a plan.');
  const queues = (strategy === 'criterion' ? requirement.acceptanceCriteria : []).map((_, criterion) => {
    const words = behaviorWords(requirement.acceptanceCriteria[criterion]);
    const scores = new Map(candidates.map(candidate => [candidate, candidate.criterionScores[criterion] + 0.25 * candidate.score + behaviorPriority(candidate, words, links)]));
    const ranked = [...candidates].sort((a, b) => scores.get(b)! - scores.get(a)! || a.path.localeCompare(b.path));
    const seen = new Set<string>(), first: Candidate[] = [], repeats: Candidate[] = [];
    for (const candidate of ranked) {
      const key = `${candidate.repository}:${candidate.path}`;
      if (seen.has(key)) repeats.push(candidate);
      else { first.push(candidate); seen.add(key); }
    }
    return { rankedFiles: first.slice(0, 10).map(({ repository, path }) => ({ repository, path })), selection: ranked };
  });
  const criteria: CriterionRetrieval[] = queues.map(({ rankedFiles }, criterion) => ({ criterion: criterion + 1, rankedFiles, selectedRanges: [] }));
  // Keep the same bounded inventory as the control so metadata cannot displace anchors.
  const availableFiles = rankedFiles;
  const eligibleFiles = new Set(availableFiles.map(file => `${file.repository}:${file.path}`));
  const tokenCount = (selected: ContextFile[]) => promptTokens(options.tokenCounter, requirement, { files: selected, warnings, availableFiles });
  let usedTokens = tokenCount(files);
  if (usedTokens > budget) throw new Error('Requirement and planner instructions exceed the token budget; shorten the requirement or increase OLLAMA_NUM_CTX.');
  const perRepo: Record<RepositoryName, number> = { website: 0, tests: 0 };
  const perFile = new Map<string, number>();
  const markdown: Record<RepositoryName, number> = { website: 0, tests: 0 };
  const append = (snippet: ContextFile, nextTokens = tokenCount([...files, snippet])) => {
    files.push(snippet); usedTokens = nextTokens;
    perRepo[snippet.repository]++;
    const key = `${snippet.repository}:${snippet.path}`;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
    if (snippet.path.endsWith('.md')) markdown[snippet.repository]++;
  };
  const add = (candidate: Candidate, allowance = Infinity, shareSupplied = true, legacyOverlap = false, reserved: ContextFile[] = []): ContextFile | undefined => {
    const key = `${candidate.repository}:${candidate.path}`;
    if (strategy === 'criterion' && !eligibleFiles.has(key)) return undefined;
    // Share an already supplied chunk without charging another criterion's budget.
    const supplied = files.find(file => file.repository === candidate.repository && file.path === candidate.path &&
      file.startLine! <= candidate.chunk.startLine && file.endLine! >= candidate.chunk.endLine &&
      file.content.includes(candidate.raw.slice(candidate.chunk.startOffset, candidate.chunk.endOffset)));
    if (supplied) return shareSupplied ? supplied : undefined;
    if (files.length >= 12 || (perRepo[candidate.repository] >= 6 && !pinned.has(key)) || (perFile.get(key) ?? 0) >= 2) return undefined;
    if (candidate.path.endsWith('.md') && markdown[candidate.repository] >= 1 && !pinned.has(key)) return undefined;
    let snippet = asContextFile(candidate, 6);
    if ((strategy === 'requirement' || legacyOverlap) && files.some(file => overlaps(file, snippet))) return undefined;
    const ceiling = Math.min(budget, usedTokens + allowance);
    let nextTokens = tokenCount([...files, snippet]);
    if (files.some(file => overlaps(file, snippet)) || nextTokens > ceiling || reserved.length && tokenCount([...files, snippet, ...reserved]) > budget) {
      snippet = asContextFile(candidate, 0);
      if (files.some(file => overlaps(file, snippet))) return undefined;
      nextTokens = tokenCount([...files, snippet]);
      if (nextTokens > ceiling || reserved.length && tokenCount([...files, snippet, ...reserved]) > budget) return undefined;
    }
    append(snippet, nextTokens);
    return snippet;
  };
  const seenWhole = new Set<string>(), firstWhole: Candidate[] = [], repeatWhole: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.repository}:${candidate.path}`;
    if (seenWhole.has(key)) repeatWhole.push(candidate);
    else { firstWhole.push(candidate); seenWhole.add(key); }
  }
  for (const candidate of [...firstWhole, ...repeatWhole]) {
    if (files.length >= 12) break;
    add(candidate, Infinity, false, true);
  }
  const anchors: ContextFile[] = [];
  if (strategy === 'criterion') {
    const baseline = [...files];
    const primary = new Map<RepositoryName, ContextFile>();
    for (const file of baseline) if (!primary.has(file.repository)) primary.set(file.repository, file);
    const words = behaviorWords(query);
    const protectedFiles = baseline.filter(file => pinned.has(`${file.repository}:${file.path}`) ||
      candidates.some(candidate => candidate.repository === file.repository && candidate.path === file.path &&
        candidate.chunk.startLine >= file.startLine! && candidate.chunk.endLine <= file.endLine! && behaviorPriority(candidate, words, links) > 0));
    files.length = 0; perFile.clear(); perRepo.website = 0; perRepo.tests = 0; markdown.website = 0; markdown.tests = 0;
    usedTokens = tokenCount(files);
    // Preserve useful source verbatim. Pure import/type/layout matches can be upgraded
    // within their leading file, rather than letting unrelated short files replace it.
    for (const file of protectedFiles) append(file);
    const pendingPrimary = [...primary.values()].filter(file => !files.some(selected => selected.repository === file.repository && selected.path === file.path));
    for (const [i, file] of pendingPrimary.entries()) {
      const replacements = candidates.filter(candidate => candidate.repository === file.repository && candidate.path === file.path && behaviorPriority(candidate, words, links) > 0)
        .sort((a, b) => b.score + behaviorPriority(b, words, links) - a.score - behaviorPriority(a, words, links));
      if (!replacements.some(candidate => Boolean(add(candidate, Infinity, true, false, pendingPrimary.slice(i + 1))))) append(file);
    }
    anchors.push(...files);
  }
  for (const key of strategy === 'criterion' ? pinned : []) {
    for (const candidate of candidates.filter(candidate => `${candidate.repository}:${candidate.path}` === key)) if (add(candidate)) break;
    if (!files.some(file => `${file.repository}:${file.path}` === key)) throw new Error(`Pinned file could not fit in the ${options.numCtx}-token context: ${key}.`);
  }
  const record = (criterion: number, file: ContextFile) => {
    const ranges = criteria[criterion].selectedRanges;
    if (!ranges.some(range => range.repository === file.repository && range.path === file.path && range.startLine === file.startLine && range.endLine === file.endLine)) {
      ranges.push({ repository: file.repository, path: file.path, startLine: file.startLine!, endLine: file.endLine! });
    }
  };
  // Useful whole-requirement anchors get priority; criteria share the remaining space.
  const share = queues.length ? Math.floor((budget - usedTokens) / queues.length) : 0;
  for (const [criterion, queue] of queues.entries()) {
    for (const candidate of queue.selection) {
      const file = add(candidate, share);
      if (file) { record(criterion, file); break; }
    }
  }
  const cursors = queues.map(() => 0);
  let progress = true;
  while (progress) {
    progress = false;
    for (const [criterion, queue] of queues.entries()) {
      while (cursors[criterion] < queue.selection.length) {
        const file = add(queue.selection[cursors[criterion]++], Infinity, false);
        if (!file) continue;
        record(criterion, file);
        progress = true;
        break;
      }
    }
  }
  for (const key of pinned) if (!files.some(file => `${file.repository}:${file.path}` === key)) throw new Error(`Pinned file could not fit in the ${options.numCtx}-token context: ${key}.`);
  if (!files.length) throw new Error('No eligible source files found in the configured repositories');
  const selectedLinks = links.filter(link => files.some(file => file.repository === link.caller.repository && file.path === link.caller.path && file.startLine! <= link.caller.startLine && file.endLine! >= link.caller.endLine) ||
    files.some(file => file.repository === link.definition.repository && file.path === link.definition.path && file.startLine! <= link.definition.startLine && file.endLine! >= link.definition.endLine));
  return { files, warnings, availableFiles, retrieval: { promptTokens: usedTokens, promptBudget: budget, rankedFiles, strategy,
    ...(strategy === 'criterion' ? { criteria, selectionVersion: 2, anchors: anchors.map(({ repository, path, startLine, endLine }) => ({ repository, path, startLine: startLine!, endLine: endLine! })), sourceLinks: selectedLinks } : {}) } };
}
