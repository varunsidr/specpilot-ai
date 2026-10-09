import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildIndexes, readIndex } from './index.ts';
import type { IndexedChunk } from './index.ts';
import { expandedLines } from './chunks.ts';
import { inventory } from './scan.ts';
import type { Embedder } from './semantic.ts';
import type { TokenCounter } from './tokenizer.ts';
import { InputError } from '../requirements/validate.ts';
import { MAX_PLAN_TOKENS, PROMPT_SAFETY_TOKENS, REPAIR_RESERVE_TOKENS, STAGE_RESERVE_TOKENS, promptTokens } from '../providers/prompt.ts';
import type { ContextFile, RepositoryName, Requirement, RepositoryContext } from '../types.ts';

export type SemanticOptions = { indexDir: string; embedder: Embedder; tokenCounter: TokenCounter; numCtx: number };
type Roots = { website: string; tests: string };
type Candidate = { repository: RepositoryName; path: string; raw: string; chunk: IndexedChunk; lexical: number; semantic: number; score: number; reason: ContextFile['reason'] };
const stopWords = new Set(['about', 'allow', 'also', 'from', 'into', 'only', 'that', 'them', 'then', 'there', 'these', 'this', 'when', 'where', 'which', 'with']);

function termsFor(requirement: Requirement): string[] {
  return [...new Set(`${requirement.title} ${requirement.description} ${requirement.acceptanceCriteria.join(' ')}`
    .toLowerCase().match(/[a-z][a-z0-9]{2,}/g) ?? [])].filter(term => !stopWords.has(term));
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

function importedPaths(relative: string, raw: string, available: Set<string>): string[] {
  const found = new Set<string>();
  const pattern = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g;
  for (const match of raw.matchAll(pattern)) {
    const specifier = match[1];
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;
    const base = specifier.startsWith('@/') ? `src/${specifier.slice(2)}` : path.posix.join(path.posix.dirname(relative), specifier);
    const normalized = path.posix.normalize(base);
    if (normalized.startsWith('../') || normalized.startsWith('/')) continue;
    for (const target of [normalized, ...['.ts', '.tsx', '.js', '.jsx', '.json', '/index.ts', '/index.tsx'].map(suffix => normalized + suffix)]) {
      if (available.has(target)) { found.add(target); break; }
    }
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
  const budget = options.numCtx - MAX_PLAN_TOKENS - PROMPT_SAFETY_TOKENS - REPAIR_RESERVE_TOKENS - STAGE_RESERVE_TOKENS;
  if (budget <= 0) throw new Error('OLLAMA_NUM_CTX is too small for the reserved plan output');
  const terms = termsFor(requirement);
  const query = `${requirement.title}\n${requirement.description}\n${requirement.acceptanceCriteria.join('\n')}`;
  const refreshed = await buildIndexes(roots, options.indexDir, options.embedder);
  for (const report of refreshed) if (report.embedded) warnings.push(`${report.repository}: refreshed ${report.embedded} changed chunks.`);
  const [queryVector] = await options.embedder.embed([query], true);
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
      return file.chunks.map(chunk => {
        const lower = raw.slice(chunk.startOffset, chunk.endOffset).toLowerCase(), name = file.path.toLowerCase();
        const lexical = terms.reduce((sum, term) => sum + (name.includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0), 0);
        return { repository, path: file.path, raw, chunk, lexical, semantic: cosine(queryVector, chunk.vector), score: 0, reason: 'semantic' as const };
      });
    }));
    const group = loaded.flat();
    const semanticRank = new Map([...group].sort((a,b) => b.semantic - a.semantic).map((candidate, i) => [candidate, i]));
    const lexicalRank = new Map([...group].sort((a,b) => b.lexical - a.lexical).map((candidate, i) => [candidate, i]));
    for (const candidate of group) {
      candidate.score = 1 / (60 + semanticRank.get(candidate)!) + (candidate.lexical ? 1 / (60 + lexicalRank.get(candidate)!) : 0) + sourcePrior(repository, candidate.path);
      candidates.push(candidate);
    }
    warnings.push(`${repository}: ranked ${group.length} chunks from ${index.files.length} indexed files.`);
  }
  const pinned = new Set((requirement.pinnedFiles ?? []).map(pin => `${pin.repository}:${pin.path}`));
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
    if (relation) { candidate.score += 0.004; candidate.reason = relation; }
    if (pinned.has(`${candidate.repository}:${candidate.path}`)) { candidate.score += 1; candidate.reason = 'pinned'; }
  }
  candidates.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path));
  const rankedFiles: { repository: RepositoryName; path: string }[] = [];
  for (const candidate of candidates) {
    if (!rankedFiles.some(file => file.repository === candidate.repository && file.path === candidate.path)) rankedFiles.push({ repository: candidate.repository, path: candidate.path });
    if (rankedFiles.length >= 40) break;
  }
  if (candidates.some(candidate => candidate.chunk.endOffset - candidate.chunk.startOffset < candidate.raw.length)) warnings.push('Some files were excerpted; inspect source before applying a plan.');
  const availableFiles = rankedFiles;
  const tokenCount = (selected: ContextFile[]) => promptTokens(options.tokenCounter, requirement, { files: selected, warnings, availableFiles });
  if (tokenCount(files) > budget) throw new Error('Requirement and planner instructions exceed the token budget; shorten the requirement or increase OLLAMA_NUM_CTX.');
  const perRepo: Record<RepositoryName, number> = { website: 0, tests: 0 };
  const perFile = new Map<string, number>();
  const markdown: Record<RepositoryName, number> = { website: 0, tests: 0 };
  const seenFirst = new Set<string>();
  const first: Candidate[] = [], repeats: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.repository}:${candidate.path}`;
    if (seenFirst.has(key)) repeats.push(candidate);
    else { first.push(candidate); seenFirst.add(key); }
  }
  for (const candidate of [...first, ...repeats]) {
    if (files.length >= 12) break;
    const key = `${candidate.repository}:${candidate.path}`;
    if ((perRepo[candidate.repository] >= 6 && !pinned.has(key)) || (perFile.get(key) ?? 0) >= 2) continue;
    if (candidate.path.endsWith('.md') && markdown[candidate.repository] >= 1 && !pinned.has(key)) continue;
    let snippet = asContextFile(candidate, 6);
    if (files.some(file => overlaps(file, snippet))) continue;
    if (tokenCount([...files, snippet]) > budget) {
      snippet = asContextFile(candidate, 0);
      if (tokenCount([...files, snippet]) > budget) continue;
    }
    files.push(snippet);
    perRepo[candidate.repository]++;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
    if (candidate.path.endsWith('.md')) markdown[candidate.repository]++;
  }
  for (const key of pinned) if (!files.some(file => `${file.repository}:${file.path}` === key)) throw new Error(`Pinned file could not fit in the ${options.numCtx}-token context: ${key}.`);
  if (!files.length) throw new Error('No eligible source files found in the configured repositories');
  const used = tokenCount(files);
  return { files, warnings, availableFiles, retrieval: { promptTokens: used, promptBudget: budget, rankedFiles } };
}
