import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const skip = new Set(['node_modules', 'dist', 'build', 'coverage', 'vendor', 'test-results', 'playwright-report', 'allure-results', 'allure-report', 'blob-report', 'data']);
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.html', '.css', '.scss', '.md', '.json', '.sql', '.prisma']);
const ignoredFiles = /(?:lock|secret|credential|token|private[-_]?key)/i;

export type ScannedFile = { path: string; size: number; mtimeMs: number };

export async function inventory(root: string): Promise<{ files: ScannedFile[]; limited: boolean }> {
  if (!(await stat(root)).isDirectory()) throw new Error('Configured repository is not a directory');
  const files: ScannedFile[] = [];
  let visited = 0;
  let limited = false;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 10) { limited = true; return; }
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (++visited > 5000 || files.length >= 1500) { limited = true; return; }
      if (entry.name.startsWith('.') || entry.isSymbolicLink() || skip.has(entry.name) || /^test-results(?:-|_)/.test(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && extensions.has(path.extname(entry.name)) && !ignoredFiles.test(entry.name)) {
        const info = await stat(full);
        if (info.size <= 100000) files.push({ path: path.relative(root, full).split(path.sep).join('/'), size: info.size, mtimeMs: info.mtimeMs });
      }
    }
  }
  await walk(root, 0);
  return { files, limited };
}
