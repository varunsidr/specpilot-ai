import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.ts';

const models = [
  { folder: 'qwen3.5-9b', repo: 'Qwen3.5-9B', revision: '0fd2a3858f6cee5f5b72ef2e21276bcf9a45ff55', sha256: '5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42' },
  { folder: 'qwen3-8b', repo: 'Qwen3-8B', revision: '895c8d171bc03c30e113cd7a28c02494b5e068b7', sha256: 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4' },
] as const;

async function download(url: string, target: string, expectedHash?: string): Promise<void> {
  try {
    const current = await readFile(target);
    if (!expectedHash || createHash('sha256').update(current).digest('hex') === expectedHash) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Tokenizer download failed: HTTP ${response.status} for ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expectedHash && createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error(`Tokenizer checksum mismatch for ${url}`);
  const temp = `${target}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);
}

for (const model of models) {
  const folder = path.join(config.tokenizerDir, model.folder);
  await mkdir(folder, { recursive: true });
  const base = `https://huggingface.co/Qwen/${model.repo}/resolve/${model.revision}`;
  await download(`${base}/tokenizer.json`, path.join(folder, 'tokenizer.json'), model.sha256);
  await download(`${base}/tokenizer_config.json`, path.join(folder, 'tokenizer_config.json'));
  console.log(`${model.folder}: tokenizer ready`);
}
