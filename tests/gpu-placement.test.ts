import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fullGpuPlacement, prepareGpuModel, checkGpuPlacement, GpuPlacementError } from '../src/providers/gpu-placement.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { OllamaEmbedder } from '../src/repositories/semantic.ts';
import { context, requirement, assessmentResponse, tokenCounter } from './plan-fixtures.ts';

test('GPU eligibility rejects CPU, mixed, absent, malformed, and mismatched-context telemetry', () => {
  const loaded = { name: 'local:latest', size: 6000, size_vram: 6000, context_length: 8192 };
  assert.equal(fullGpuPlacement({ models: [loaded] }, 'local', 8192).sizeVram, 6000);
  for (const value of [{ models: [] }, null, { models: [null] }, ...[
    { size_vram: 0 }, { size_vram: 5000 }, { size_vram: 6001 }, { size: 0, size_vram: 0 },
    { size: NaN }, { size: undefined }, { context_length: undefined }, { context_length: 4096 },
  ].map(change => ({ models: [{ ...loaded, ...change }] }))]) {
    assert.throws(() => fullGpuPlacement(value, 'local', 8192), GpuPlacementError);
  }
});

test('embedding GPU checks run before inference and before release, and block CPU offload', async () => {
  for (const [mixed, unloadFails] of [[true, false], [true, true], [false, false]]) {
    const calls: string[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/ps') {
        calls.push('placement');
        response.end(JSON.stringify({ models: [{ name: 'embedding:latest', size: 1000, size_vram: mixed ? 900 : 1000 }] }));
        return;
      }
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      calls.push(body.input.length ? 'infer' : body.keep_alive === 0 ? 'unload' : 'load');
      if (body.keep_alive === 0 && unloadFails) { response.statusCode = 500; response.end('{}'); return; }
      // Do not release until after the post-inference placement snapshot.
      if (body.input.length) assert.equal(body.keep_alive, '5m');
      response.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0]) }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const placements: string[] = [];
    const embedder = new OllamaEmbedder(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'embedding', 5000, { onPlacement: placement => { placements.push(placement.model); } });
    try {
      if (mixed) {
        await assert.rejects(embedder.embed(['criterion'], true), GpuPlacementError);
        assert.deepEqual(calls, ['load', 'placement', 'unload']);
      } else {
        assert.deepEqual(await embedder.embed(['criterion'], true), [[1, 0]]);
        assert.deepEqual(calls, ['load', 'placement', 'infer', 'placement', 'unload']);
        assert.equal(placements.length, 2);
      }
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});

test('GPU guard blocks mixed placement before generation and rejects placement changes after a stage', async () => {
  for (const initiallyMixed of [true, false]) {
    let generated = 0, checks = 0;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/ps') {
        checks++;
        response.end(JSON.stringify({ models: [{ name: 'local:latest', size: 6000, size_vram: initiallyMixed || checks > 1 ? 5000 : 6000, context_length: 8192 }] }));
        return;
      }
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw);
      assert.equal(body.options.num_ctx, 8192);
      if (body.messages.length === 0) { response.end('{}'); return; }
      generated++;
      const assessment = assessmentResponse(); assessment.assessments[0].status = 'implemented';
      response.end(JSON.stringify({ message: { content: JSON.stringify(assessment) } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const provider = new OllamaProvider({ url, model: 'local', numCtx: 8192, timeoutMs: 5000, tokenCounter,
        beforeRequest: async signal => { await prepareGpuModel(url, 'local', 8192, signal); },
        afterRequest: async signal => { await checkGpuPlacement(url, 'local', 8192, signal); },
      });
      await assert.rejects(provider.plan(requirement, context), GpuPlacementError);
      assert.equal(generated, initiallyMixed ? 0 : 1);
      assert.equal(provider.lastMetrics?.validationFailures.length, 0, 'hardware failures must not consume schema repairs');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  }
});
