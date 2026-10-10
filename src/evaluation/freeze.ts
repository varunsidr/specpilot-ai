import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inventory } from '../repositories/scan.ts';
import { INDEX_VERSION, readIndex, type IndexedFile } from '../repositories/index.ts';

export async function freezeRepositories(sources: { website: string; tests: string }, sourceIndexDir: string, destination: string, model: string) {
  const roots = { website: path.join(destination, 'website'), tests: path.join(destination, 'tests') };
  const indexDir = path.join(destination, 'index');
  await mkdir(indexDir, { recursive: true });
  const reports: { repository: string; files: number; reusedFiles: number; limited: boolean }[] = [];
  for (const repository of ['website', 'tests'] as const) {
    await mkdir(roots[repository], { recursive: true });
    const listing = await inventory(sources[repository]);
    let cached: Awaited<ReturnType<typeof readIndex>> | undefined;
    try { cached = await readIndex(sourceIndexDir, repository, sources[repository], model); } catch { /* Rebuild missing or incompatible cache. */ }
    const prior = new Map(cached?.files.map(file => [file.path, file]));
    const reused: IndexedFile[] = [];
    for (const entry of listing.files) {
      const from = path.join(sources[repository], entry.path);
      const before = await stat(from);
      const raw = await readFile(from);
      const after = await stat(from);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || raw.length !== after.size) throw new Error(`Source changed while freezing: ${repository}:${entry.path}; retry`);
      const target = path.join(roots[repository], entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, raw);
      const copied = await stat(target);
      const previous = prior.get(entry.path);
      // Use the same unchanged-file cache contract as buildIndexes; changed files are embedded afresh.
      if (previous && previous.size === after.size && previous.mtimeMs === after.mtimeMs) reused.push({ ...previous, size: copied.size, mtimeMs: copied.mtimeMs });
    }
    await writeFile(path.join(indexDir, `${repository}.json`), JSON.stringify({ version: INDEX_VERSION, root: roots[repository], model, limited: listing.limited, files: reused }));
    reports.push({ repository, files: listing.files.length, reusedFiles: reused.length, limited: listing.limited });
  }
  await writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ createdAt: new Date().toISOString(), sources, roots, indexDir, model, reports }, null, 2));
  return { roots, indexDir, reports };
}
