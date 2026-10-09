import { createHash } from 'node:crypto';
import type { Evidence, RepositoryContext } from '../types.ts';

export type EvidenceCatalog = Map<string, Evidence>;
export function evidenceCatalog(context: RepositoryContext): EvidenceCatalog {
  const catalog: EvidenceCatalog = new Map();
  for (const file of context.files) {
    if (file.startLine === undefined || file.endLine === undefined) throw new Error('Evidence IDs require supplied line ranges');
    const lines = file.content.replaceAll('\r\n', '\n').split('\n');
    for (let index = 0; index < lines.length; index++) {
      const line = file.startLine + index;
      if (line > file.endLine) break;
      const raw = lines[index];
      if (!raw.trim() || /^[\s{}()[\];,]+$/.test(raw)) continue;
      for (let offset = 0; offset < raw.length; offset += 500) {
        const quote = raw.slice(offset, offset + 500);
        if (!quote.trim()) continue;
        const id = 'E' + createHash('sha256').update(JSON.stringify([file.repository, file.path, line, offset, quote])).digest('hex').slice(0, 12);
        const citation: Evidence = { repository: file.repository, path: file.path, startLine: line, endLine: line, quote };
        if (catalog.has(id) && JSON.stringify(catalog.get(id)) !== JSON.stringify(citation)) throw new Error('Evidence ID collision');
        catalog.set(id, citation);
      }
    }
  }
  return catalog;
}

export function resolveEvidence(value: unknown, catalog: EvidenceCatalog, required: boolean): Evidence[] {
  if (!Array.isArray(value)) throw new Error('Evidence IDs must be an array');
  if (value.length > 4) throw new Error(`Select at most four evidence IDs; received ${value.length}`);
  if (required && !value.length) throw new Error('Implemented and gap assessments require at least one supplied evidence ID');
  if (new Set(value).size !== value.length) throw new Error('Evidence IDs must be distinct; remove repeated IDs');
  return value.map(id => {
    if (typeof id !== 'string' || !catalog.has(id)) throw new Error(`Unknown evidence ID: ${String(id).slice(0, 40)}`);
    return { ...catalog.get(id)! };
  });
}
