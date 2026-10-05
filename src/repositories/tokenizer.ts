import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Tokenizer } from '@huggingface/tokenizers';

export interface TokenCounter {
  model: string;
  count(text: string): number;
}

const folders: Record<string, string> = { 'qwen3.5:9b': 'qwen3.5-9b', 'qwen3:8b': 'qwen3-8b' };
const cache = new Map<string, Promise<TokenCounter>>();

export function loadTokenCounter(directory: string, model: string): Promise<TokenCounter> {
  const folder = folders[model];
  if (!folder) throw new Error(`No local tokenizer configured for ${model}; supported models: ${Object.keys(folders).join(', ')}.`);
  const key = `${directory}:${model}`;
  if (!cache.has(key)) cache.set(key, (async () => {
    const base = path.join(directory, folder);
    let json: string, config: string;
    try {
      [json, config] = await Promise.all([
        readFile(path.join(base, 'tokenizer.json'), 'utf8'),
        readFile(path.join(base, 'tokenizer_config.json'), 'utf8'),
      ]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`Tokenizer files for ${model} are missing; run npm run setup:tokenizers.`);
      throw error;
    }
    const tokenizer = new Tokenizer(JSON.parse(json), JSON.parse(config));
    return { model, count: (text: string) => tokenizer.encode(text).ids.length };
  })());
  return cache.get(key)!;
}
