import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from '../src/providers/ollama.ts';
test('Ollama adapter sends a structured request and validates the response', async () => {
  let request: any;
  const plan = { summary: 'Add price filtering', changes: [{ repository: 'website', path: 'products.ts', reason: 'Contains product logic', steps: ['Add inclusive comparison'] }], testScenarios: ['Boundary price'], risks: [], questions: [] };
  const server = createServer(async (req,res) => {
    assert.equal(req.url, '/api/chat');
    let body = ''; for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(plan) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test-model', timeoutMs: 1000, numCtx: 8192 });
    const result = await provider.plan({ title: 'Filter', description: 'Price filter', acceptanceCriteria: ['Include boundary'] }, { files: [{ repository: 'website', path: 'products.ts', content: 'export const price = 10;', truncated: false }], warnings: [] });
    assert.deepEqual(result, plan);
    assert.equal(request.stream, false);
    assert.equal(request.think, false);
    assert.equal(request.model, 'test-model');
    assert.equal(request.format.type, 'object');
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('Ollama adapter retries an invented file reference and keeps validation strict', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    if (requests === 2) assert.match(body.messages.at(-1).content, /website:products.ts/);
    const path = requests === 1 ? 'invented.ts' : 'products.ts';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify({ summary: 'Plan', changes: [{ repository: 'website', path, reason: 'Product logic', steps: ['Filter'] }], testScenarios: [], risks: [], questions: [] }) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test-model', timeoutMs: 1000, numCtx: 8192 });
    const result = await provider.plan({ title: 'Filter', description: 'Price filter', acceptanceCriteria: ['Include boundary'] }, { files: [{ repository: 'website', path: 'products.ts', content: 'export const price = 10;', truncated: false }], warnings: [] });
    assert.equal(result.changes[0].path, 'products.ts');
    assert.equal(requests, 2);
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});
