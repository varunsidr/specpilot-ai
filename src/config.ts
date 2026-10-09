import path from 'node:path';
function integer(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const provider = process.env.AI_PROVIDER ?? 'mock';
if (provider !== 'mock' && provider !== 'ollama') throw new Error('AI_PROVIDER must be mock or ollama');
const ragEnabled = process.env.RAG_ENABLED === 'true';
if (process.env.RAG_ENABLED && !['true', 'false'].includes(process.env.RAG_ENABLED)) throw new Error('RAG_ENABLED must be true or false');
export const config = {
  port: integer('PORT', 4100, 1, 65535), provider,
  websiteRepo: path.resolve(process.env.WEBSITE_REPO ?? './examples/website'),
  testRepo: path.resolve(process.env.TEST_REPO ?? './examples/test-framework'),
  runsDir: path.resolve(process.env.RUNS_DIR ?? './data/runs'),
  ollamaUrl: process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen3:8b',
  timeoutMs: integer('OLLAMA_TIMEOUT_MS', 300000, 1000, 600000),
  numCtx: integer('OLLAMA_NUM_CTX', 8192, 2048, 32768),
  ragEnabled,
  indexDir: path.resolve(process.env.RAG_INDEX_DIR ?? './data/index'),
  embedModel: process.env.OLLAMA_EMBED_MODEL ?? 'qwen3-embedding:0.6b',
  embedTimeoutMs: integer('OLLAMA_EMBED_TIMEOUT_MS', 180000, 1000, 600000),
  tokenizerDir: path.resolve(process.env.TOKENIZER_DIR ?? './data/tokenizer'),
};
