import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { splitIntoChunks } from './chunks.ts';
import type { SourceChunk } from './chunks.ts';
import { inventory } from './scan.ts';
import type { Embedder } from './semantic.ts';

export type IndexedChunk = SourceChunk & { vector: number[] };
export type IndexedFile = { path: string; size: number; mtimeMs: number; chunks: IndexedChunk[] };
export type RepositoryIndex = { version: 2; root: string; model: string; limited: boolean; files: IndexedFile[] };
type Roots = { website: string; tests: string };
type IndexReport = { repository: keyof Roots; files: number; chunks: number; embedded: number; limited: boolean };

function filePath(directory: string, repository: keyof Roots): string { return path.join(directory, `${repository}.json`); }

export async function readIndex(directory: string, repository: keyof Roots, root: string, model: string): Promise<RepositoryIndex> {
  let index: RepositoryIndex;
  try { index = JSON.parse(await readFile(filePath(directory, repository), 'utf8')) as RepositoryIndex; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`RAG index is missing for ${repository}; run npm run index.`);
    throw error;
  }
  if (index.version !== 2 || index.root !== root || index.model !== model || !Array.isArray(index.files)) {
    throw new Error(`RAG index for ${repository} does not match the current repository or embedding model; run npm run index.`);
  }
  return index;
}

export async function buildIndexes(roots: Roots, directory: string, embedder: Embedder): Promise<IndexReport[]> {
  await mkdir(directory, { recursive: true });
  const reports: IndexReport[] = [];
  for (const repository of ['website', 'tests'] as const) {
    const root = roots[repository];
    const listing = await inventory(root);
    let previous: RepositoryIndex | undefined;
    try { previous = await readIndex(directory, repository, root, embedder.model); }
    catch { /* A missing or mismatched index is rebuilt. */ }
    const prior = new Map(previous?.files.map(file => [file.path, file]));
    const files: IndexedFile[] = [];
    const pending: { file: IndexedFile; chunk: SourceChunk; text: string }[] = [];
    for (const entry of listing.files) {
      const cached = prior.get(entry.path);
      if (cached && cached.size === entry.size && cached.mtimeMs === entry.mtimeMs) {
        files.push(cached);
        continue;
      }
      const raw = await readFile(path.join(root, entry.path), 'utf8');
      const file: IndexedFile = { ...entry, chunks: [] };
      files.push(file);
      for (const chunk of splitIntoChunks(raw)) {
        pending.push({ file, chunk, text: `File: ${entry.path}\nLines: ${chunk.startLine}-${chunk.endLine}\n${raw.slice(chunk.startOffset, chunk.endOffset)}` });
      }
    }
    for (let offset = 0; offset < pending.length; offset += 8) {
      const batch = pending.slice(offset, offset + 8);
      const vectors = await embedder.embed(batch.map(item => item.text));
      batch.forEach((item, i) => item.file.chunks.push({ ...item.chunk, vector: vectors[i] }));
    }
    files.sort((a,b) => a.path.localeCompare(b.path));
    const next: RepositoryIndex = { version: 2, root, model: embedder.model, limited: listing.limited, files };
    const target = filePath(directory, repository);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(next), 'utf8');
    await rename(temp, target);
    reports.push({ repository, files: files.length, chunks: files.reduce((sum, file) => sum + file.chunks.length, 0), embedded: pending.length, limited: listing.limited });
  }
  return reports;
}
