import type { ContextRequest, PinnedFile, RepositoryContext } from '../types.ts';

export type SuppliedRange = PinnedFile & { startLine: number; endLine: number };

// Adjacent excerpts jointly supply a range even when no single excerpt contains it.
export function suppliedRanges(context: RepositoryContext): SuppliedRange[] {
  const ranges = context.files.flatMap(file => {
    if (file.startLine === undefined || file.endLine === undefined) return [];
    const endLine = Math.min(file.endLine, file.startLine + file.content.replaceAll('\r\n', '\n').split('\n').length - 1);
    return [{ repository: file.repository, path: file.path, startLine: file.startLine, endLine }];
  }).sort((a, b) => a.repository.localeCompare(b.repository) || a.path.localeCompare(b.path) || a.startLine - b.startLine);
  const merged: SuppliedRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && previous.repository === range.repository && previous.path === range.path && previous.endLine + 1 >= range.startLine) previous.endLine = Math.max(previous.endLine, range.endLine);
    else merged.push({ ...range });
  }
  return merged;
}

export function rangeSupplied(context: RepositoryContext, request: Pick<ContextRequest, 'repository' | 'path' | 'startLine' | 'endLine'>): boolean {
  return suppliedRanges(context).some(range => range.repository === request.repository && range.path === request.path && range.startLine <= request.startLine && range.endLine >= request.endLine);
}
