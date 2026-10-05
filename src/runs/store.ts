import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Run } from '../types.ts';
export async function saveRun(directory: string, run: Run): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${run.id}.json`);
  const temp = `${file}.tmp`;
  await writeFile(temp, JSON.stringify(run, null, 2), 'utf8');
  await rename(temp, file);
}
export async function readRun(directory: string, id: string): Promise<Run | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  try { return JSON.parse(await readFile(path.join(directory, `${id}.json`), 'utf8')) as Run; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
