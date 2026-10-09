import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContextFile, Requirement, RepositoryContext } from '../types.ts';
import { inventory } from './scan.ts';
import { collectSemanticContext } from './semantic-context.ts';
import type { SemanticOptions } from './semantic-context.ts';

export async function collectContext(roots: { website: string; tests: string }, requirement: Requirement, semantic?: SemanticOptions): Promise<RepositoryContext> {
  if (semantic) return collectSemanticContext(roots, requirement, semantic);
  const files: ContextFile[] = [];
  const warnings: string[] = [];
  const terms = [...new Set(`${requirement.title} ${requirement.description} ${requirement.acceptanceCriteria.join(' ')}`.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [])];
  for (const repository of ['website', 'tests'] as const) {
    let remaining = 12000;
    const root = roots[repository];
    const listing = await inventory(root);
    if (listing.limited) warnings.push(`${repository}: inventory limit reached; relevant files may be missing.`);
    const candidates: { path: string; content: string; score: number; truncated: boolean }[] = [];
    for (const { path: relative } of listing.files) {
      const full = path.join(root, relative);
      const raw = await readFile(full, 'utf8');
      const content = raw.slice(0, 12000);
      const lower = content.toLowerCase();
      const score = terms.reduce((s, term) => s + (relative.toLowerCase().includes(term) ? 5 : 0) + (lower.includes(term) ? 1 : 0), 0);
      candidates.push({ path: relative, content, score, truncated: raw.length > content.length });
    }
    const selected = candidates.sort((a,b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0,6);
    for (const entry of selected) {
      if (remaining <= 0) break;
      const content = entry.content.slice(0, Math.min(4000, remaining));
      files.push({ repository, path: entry.path, content, startLine: 1, endLine: content.split('\n').length, truncated: entry.truncated || content.length < entry.content.length });
      remaining -= content.length;
    }
    if (selected.length < candidates.length) warnings.push(`${repository}: selected ${selected.length} of ${candidates.length} eligible files using keyword ranking.`);
  }
  if (files.some(f => f.truncated)) warnings.push('Some files were truncated; review context before accepting a plan.');
  if (!files.length) throw new Error('No eligible source files found in the configured repositories');
  return { files, warnings };
}
