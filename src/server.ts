import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.ts';
import { InputError, validateRequirement } from './requirements/validate.ts';
import { MockProvider } from './providers/mock.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { createPlan } from './workflows/plan.ts';
import { readRun } from './runs/store.ts';
import { OllamaEmbedder } from './repositories/semantic.ts';
import { loadTokenCounter } from './repositories/tokenizer.ts';
const tokenCounter = config.ragEnabled || config.provider === 'ollama' ? await loadTokenCounter(config.tokenizerDir, config.ollamaModel) : undefined;
const provider = config.provider === 'mock' ? new MockProvider() : new OllamaProvider({ url: config.ollamaUrl, model: config.ollamaModel, timeoutMs: config.timeoutMs, numCtx: config.numCtx, tokenCounter: tokenCounter! });
const semantic = config.ragEnabled ? {
  indexDir: config.indexDir,
  embedder: new OllamaEmbedder(config.ollamaUrl, config.embedModel, config.embedTimeoutMs),
  tokenCounter: tokenCounter!,
  numCtx: config.numCtx,
} : undefined;
let busy = false;
function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new InputError('Use Content-Type: application/json');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new InputError('Request body exceeds 64 KB');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InputError('Invalid JSON'); }
}
const server = createServer(async (req, res) => {
  // Local developer API; do not expose publicly without authentication.
  if (req.headers.origin) return json(res, 403, { error: 'Browser cross-origin access is disabled. Use a same-origin backend proxy.' });
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', provider: provider.name, busy });
    if (req.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
      const run = await readRun(config.runsDir, url.pathname.slice('/api/runs/'.length));
      return json(res, run ? 200 : 404, run ?? { error: 'Run not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/plans') {
      const requirement = validateRequirement(await body(req));
      if (busy) return json(res, 409, { error: 'A planning request is already running; retry after it finishes.' });
      busy = true;
      try {
        const run = await createPlan(requirement, provider, { website: config.websiteRepo, tests: config.testRepo }, config.runsDir, semantic);
        return json(res, run.status === 'completed' ? 200 : 502, run);
      } finally { busy = false; }
    }
    json(res, 404, { error: 'Route not found' });
  } catch (error) {
    if (error instanceof InputError) return json(res, 400, { error: error.message });
    console.error(error);
    json(res, 500, { error: 'Server error; inspect terminal output.' });
  }
});
server.requestTimeout = 300000;
server.listen(config.port, '127.0.0.1', () => console.log(`AI engineering API: http://127.0.0.1:${config.port} (${provider.name})`));
