import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { collectContext } from '../src/repositories/context.ts';
import { OllamaEmbedder } from '../src/repositories/semantic.ts';
import { loadTokenCounter } from '../src/repositories/tokenizer.ts';
import { validateRequirement } from '../src/requirements/validate.ts';
import type { PinnedFile, Plan } from '../src/types.ts';

type Case = { id: string; requirement: unknown; expectedFiles: PinnedFile[]; scenarioTerms: string[] };
const runCommand = promisify(execFile);
const key = (file: PinnedFile) => `${file.repository}:${file.path}`;
const recall = (expected: Set<string>, found: Set<string>) => [...expected].filter(file => found.has(file)).length / expected.size;
const round = (value: number) => Math.round(value * 1000) / 1000;

async function gpuSample(): Promise<{ usedMiB: number; utilizationPct: number } | undefined> {
  try {
    const { stdout } = await runCommand('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits']);
    const [usedMiB, utilizationPct] = stdout.trim().split(/\s*,\s*/).map(Number);
    return Number.isFinite(usedMiB) && Number.isFinite(utilizationPct) ? { usedMiB, utilizationPct } : undefined;
  } catch { return undefined; }
}

async function measure<T>(work: () => Promise<T>): Promise<{ value: T; durationMs: number; gpu: object }> {
  const samples: { usedMiB: number; utilizationPct: number }[] = [];
  let pending: Promise<void> | undefined;
  const poll = () => { if (!pending) pending = gpuSample().then(sample => { if (sample) samples.push(sample); }).finally(() => { pending = undefined; }); };
  poll();
  const timer = setInterval(poll, 1000);
  const start = performance.now();
  try {
    const value = await work();
    return { value, durationMs: Math.round(performance.now() - start), gpu: {
      samples: samples.length,
      baselineUsedMiB: samples[0]?.usedMiB ?? null,
      peakUsedMiB: samples.length ? Math.max(...samples.map(sample => sample.usedMiB)) : null,
      peakUtilizationPct: samples.length ? Math.max(...samples.map(sample => sample.utilizationPct)) : null,
    } };
  } finally { clearInterval(timer); if (pending) await pending; }
}

function quality(plan: Plan, expected: Set<string>, terms: string[]) {
  const changes = new Set(plan.changes.map(key));
  const scenarios = plan.testScenarios.join(' ').toLowerCase();
  return {
    goldFileRecallInChanges: round(recall(expected, changes)),
    goldFilePrecisionInChanges: changes.size ? round([...changes].filter(file => expected.has(file)).length / changes.size) : 0,
    scenarioTermCoverage: terms.length ? round(terms.filter(term => scenarios.includes(term.toLowerCase())).length / terms.length) : 1,
    scenarioTermsFound: terms.filter(term => scenarios.includes(term.toLowerCase())),
  };
}

const allCases = JSON.parse(await readFile(new URL('../evals/requirements.json', import.meta.url), 'utf8')) as Case[];
const selectedCases = new Set((process.env.EVAL_CASES ?? '').split(',').map(id => id.trim()).filter(Boolean));
const cases = selectedCases.size ? allCases.filter(item => selectedCases.has(item.id)) : allCases;
if (!cases.length) throw new Error(`No evaluation cases matched EVAL_CASES: ${[...selectedCases].join(', ')}`);
const models = (process.env.EVAL_MODELS ?? config.ollamaModel).split(',').map(model => model.trim()).filter(Boolean);
const retrievalOnly = process.env.EVAL_RETRIEVAL_ONLY === 'true';
const embedder = new OllamaEmbedder(config.ollamaUrl, config.embedModel, config.embedTimeoutMs);
const roots = { website: config.websiteRepo, tests: config.testRepo };
const entries: object[] = [];
for (const model of models) {
  const tokenCounter = await loadTokenCounter(config.tokenizerDir, model);
  for (const item of cases) {
    const requirement = validateRequirement(item.requirement);
    const expected = new Set(item.expectedFiles.map(key));
    const result: Record<string, unknown> = { id: item.id, model, expectedFiles: [...expected] };
    try {
      const retrieval = await measure(() => collectContext(roots, requirement, { indexDir: config.indexDir, embedder, tokenCounter, numCtx: config.numCtx }));
      const ranked = retrieval.value.retrieval?.rankedFiles ?? [];
      const selected = retrieval.value.files;
      result.retrieval = {
        latencyMs: retrieval.durationMs, gpu: retrieval.gpu,
        chunksSelected: selected.length, promptTokens: retrieval.value.retrieval?.promptTokens,
        promptBudget: retrieval.value.retrieval?.promptBudget,
        recallAt5: round(recall(expected, new Set(ranked.slice(0, 5).map(key)))),
        recallAt10: round(recall(expected, new Set(ranked.slice(0, 10).map(key)))),
        selectedFileRecall: round(recall(expected, new Set(selected.map(key)))),
        selectedFiles: [...new Set(selected.map(key))], rankedFiles: ranked.slice(0, 10).map(key),
      };
      if (!retrievalOnly) {
        const provider = new OllamaProvider({ url: config.ollamaUrl, model, timeoutMs: config.timeoutMs, numCtx: config.numCtx });
        const generation = await measure(() => provider.plan(requirement, retrieval.value));
        result.plan = { latencyMs: generation.durationMs, gpu: generation.gpu,
          ollama: provider.lastMetrics, automatedQualityProxy: quality(generation.value, expected, item.scenarioTerms),
          output: generation.value };
      }
      console.log(`${model} ${item.id}: retrieval ${retrieval.durationMs} ms, recall@10 ${(result.retrieval as { recallAt10: number }).recallAt10}`);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`${model} ${item.id}: ${result.error}`);
    }
    entries.push(result);
  }
}
const outputDir = path.resolve('./data/evals');
await mkdir(outputDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = path.join(outputDir, `${stamp}.json`);
await writeFile(output, JSON.stringify({ createdAt: new Date().toISOString(),
  settings: { models, embeddingModel: config.embedModel, numCtx: config.numCtx, retrievalOnly },
  metricNotes: 'Gold files are manually chosen from the configured repos. Recall and latency are objective for this set. Plan file overlap and keyword coverage are rough proxies; inspect output for correctness. GPU memory includes other processes.',
  entries }, null, 2));
console.log(`Evaluation report: ${output}`);
if (entries.some(entry => 'error' in entry)) process.exitCode = 1;
