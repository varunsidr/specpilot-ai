import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { gapPlan, context, requirement, assessmentResponse, draftResponse, positiveReview, tokenCounter } from './plan-fixtures.ts';
test('Ollama adapter sends a structured request and validates the response', async () => {
  let request: any;
  const stages: string[] = [];
  const plan = gapPlan();
  const server = createServer(async (req,res) => {
    assert.equal(req.url, '/api/chat');
    let body = ''; for await (const chunk of req) body += chunk;
    request = JSON.parse(body);
    const stage = request.format.properties.assessments ? 'assessment' : request.format.properties.criteria ? 'draft' : 'review';
    stages.push(stage);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: { content: JSON.stringify(stage === 'assessment' ? assessmentResponse(plan) : stage === 'draft' ? draftResponse(plan) : positiveReview()) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test-model', timeoutMs: 1000, numCtx: 8192, tokenCounter });
    const result = await provider.plan(requirement, context);
    assert.deepEqual(result.assessments, plan.assessments);
    assert.deepEqual(result.changes, plan.changes);
    assert.deepEqual(stages, ['assessment', 'draft', 'review']);
    assert.equal(request.stream, false);
    assert.equal(request.think, false);
    assert.equal(request.model, 'test-model');
    assert.equal(request.format.type, 'object');
    assert.match(request.messages[1].content, /proposedDraft/);
    assert.equal(provider.lastMetrics?.stages.length, 3);
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('Ollama adapter retries an invented file reference and keeps validation strict', async () => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests++;
    if (requests === 3) {
      assert.match(body.messages.at(-1).content, /validationFeedback/);
      assert.equal(body.messages.length, 2, 'repair does not append the rejected response');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const draft = draftResponse(); if (requests === 2) draft.criteria[0].changes[0].path = 'invented.ts';
    res.end(JSON.stringify({ message: { content: JSON.stringify(requests === 1 ? assessmentResponse() : requests === 4 ? positiveReview() : draft) } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const provider = new OllamaProvider({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, model: 'test-model', timeoutMs: 1000, numCtx: 8192, tokenCounter });
    const result = await provider.plan(requirement, context);
    assert.equal(result.changes[0].path, 'products.ts');
    assert.equal(requests, 4);
    assert.equal(provider.lastMetrics?.validationFailures.length, 1);
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});
