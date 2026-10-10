import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config.ts';
import { OllamaProvider } from '../src/providers/ollama.ts';
import { collectContext } from '../src/repositories/context.ts';
import { OllamaEmbedder } from '../src/repositories/semantic.ts';
import { loadTokenCounter } from '../src/repositories/tokenizer.ts';
import { validateRequirement } from '../src/requirements/validate.ts';
import { expandContext } from '../src/repositories/expand-context.ts';
import { goldDrift, loadCases, type SourceSnapshot } from '../src/evaluation/cases.ts';
import { goldLineCoverage, planQuality } from '../src/evaluation/quality.ts';
import type { PinnedFile, Plan } from '../src/types.ts';
import { prepareGpuModel, checkGpuPlacement, unloadModel, GpuPlacementError, type GpuPlacement } from '../src/providers/gpu-placement.ts';

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

const casesFile = path.resolve(process.env.EVAL_CASES_FILE ?? './evals/requirements.json');
const allCases = await loadCases(casesFile);
const selectedCases = new Set((process.env.EVAL_CASES ?? '').split(',').map(id => id.trim()).filter(Boolean));
const cases = selectedCases.size ? allCases.filter(item => selectedCases.has(item.id)) : allCases;
if (!cases.length) throw new Error(`No evaluation cases matched EVAL_CASES: ${[...selectedCases].join(', ')}`);
const models = (process.env.EVAL_MODELS ?? config.ollamaModel).split(',').map(model => model.trim()).filter(Boolean);
const retrievalOnly = process.env.EVAL_RETRIEVAL_ONLY === 'true';
let embeddingPlacements: GpuPlacement[] = [];
const embedder = new OllamaEmbedder(config.ollamaUrl, config.embedModel, config.embedTimeoutMs, { onPlacement: placement => { embeddingPlacements.push(placement); } });
const roots = { website: config.websiteRepo, tests: config.testRepo };
const goldSourceSnapshot = JSON.parse(await readFile(new URL('../evals/source-snapshot.json', import.meta.url), 'utf8')) as SourceSnapshot;
const drift = await goldDrift(roots, cases, goldSourceSnapshot);
if (drift.length) throw new Error(`Gold sources changed; review cases and run eval:snapshot: ${drift.join(', ')}`);
const entries: object[] = [];
const outputDir = path.resolve('./data/evals');
await mkdir(outputDir, { recursive: true });
const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
const output = path.join(outputDir, `${stamp}.json`);
const plannerCodeHashes = Object.fromEntries(await Promise.all(['providers/prompt.ts', 'providers/schema.ts', 'providers/stages.ts', 'providers/evidence.ts', 'providers/ollama.ts', 'providers/gpu-placement.ts', 'repositories/expand-context.ts', 'repositories/ranges.ts', 'repositories/semantic-context.ts', 'repositories/semantic.ts', 'repositories/chunks.ts', 'repositories/profile.ts', 'repositories/usage.ts', 'repositories/index.ts'].map(async file => [file, createHash('sha256').update(await readFile(new URL(`../src/${file}`, import.meta.url))).digest('hex')])));
async function checkpoint(complete = false) {
  await writeFile(`${output}.tmp`, JSON.stringify({ createdAt,
    complete, expectedEntries: models.length * cases.length, goldSourceSnapshot, goldCases: cases,
    settings: { models, embeddingModel: config.embedModel, numCtx: config.numCtx, timeoutMs: config.timeoutMs, retrievalOnly, casesFile, retrievalStrategy: config.retrievalStrategy, requirePlannerFullGpu: !retrievalOnly, requireEmbeddingFullGpu: true, plannerCodeHashes, sourceRoots: roots, indexDir: config.indexDir },
    metricNotes: 'Gold outcomes and line ranges were inspected in source snapshots, not verified by running the external apps. Status agreement and unnecessary edits are measured against that snapshot. Exact quotes prove provenance, not semantic correctness; fill manualReview for unsupported semantic claims. File overlap and keyword coverage are legacy proxies. GPU memory includes other processes.', entries }, null, 2));
  await rename(`${output}.tmp`, output);
}
console.log(`Evaluation report (updated after each case): ${output}`);
for (const model of models) {
  const tokenCounter = await loadTokenCounter(config.tokenizerDir, model);
  for (const item of cases) {
    const requirement = validateRequirement(item.requirement);
    const expected = new Set(item.expectedFiles.map(key));
    const result: Record<string, unknown> = { id: item.id, model, category: item.category, expectedOutcome: item.expectedOutcome, expectedFiles: [...expected] };
    let provider: OllamaProvider | undefined;
    const placements: GpuPlacement[] = [];
    embeddingPlacements = [];
    try {
      if ((await goldDrift(roots, [item], goldSourceSnapshot)).length) throw new Error('Gold source changed before this case; inspect and refresh the case first');
      const retrieval = await measure(() => collectContext(roots, requirement, { indexDir: config.indexDir, embedder, tokenCounter, numCtx: config.numCtx, retrievalStrategy: config.retrievalStrategy }));
      result.context = retrieval.value;
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
        goldLineCoverage: round(goldLineCoverage(retrieval.value, item)),
        strategy: retrieval.value.retrieval?.strategy ?? config.retrievalStrategy,
        selectionVersion: retrieval.value.retrieval?.selectionVersion,
        anchors: retrieval.value.retrieval?.anchors ?? [], sourceLinks: retrieval.value.retrieval?.sourceLinks ?? [],
        criteria: retrieval.value.retrieval?.criteria ?? [],
      };
      if (!retrievalOnly) {
        provider = new OllamaProvider({ url: config.ollamaUrl, model, timeoutMs: config.timeoutMs, numCtx: config.numCtx, tokenCounter,
          beforeRequest: async signal => { placements.push(await prepareGpuModel(config.ollamaUrl, model, config.numCtx, signal)); },
          afterRequest: async signal => { placements.push(await checkGpuPlacement(config.ollamaUrl, model, config.numCtx, signal)); },
        });
        const context = retrieval.value;
        const generation = await measure(() => provider!.plan(requirement, context, { resolveContext: async (requests, retainEvidence) => {
          Object.assign(context, await expandContext(roots, requirement, context, requests, { indexDir: config.indexDir, embedder, tokenCounter, numCtx: config.numCtx, retrievalStrategy: config.retrievalStrategy }, retainEvidence));
          return context;
        } }));
        const verified = !(await goldDrift(roots, [item], goldSourceSnapshot)).length;
        result.goldSourcesVerified = verified;
        result.hardwareEligible = true;
        result.plan = { latencyMs: generation.durationMs, gpu: generation.gpu,
          ollama: provider.lastMetrics, automatedQualityProxy: quality(generation.value, expected, item.scenarioTerms),
          correctness: verified ? planQuality(generation.value, item) : null, finalGoldLineCoverage: round(goldLineCoverage(context, item)), finalPromptTokens: context.retrieval?.promptTokens,
          contextFollowUps: context.followUps ?? [], finalContext: context.files, output: generation.value };
      }
      console.log(`${model} ${item.id}: retrieval ${retrieval.durationMs} ms, recall@10 ${(result.retrieval as { recallAt10: number }).recallAt10}`);
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      result.ollama = provider?.lastMetrics;
      if (error instanceof GpuPlacementError) result.hardwareEligible = false;
      console.error(`${model} ${item.id}: ${result.error}`);
    } finally {
      result.embeddingPlacements = embeddingPlacements;
      try { await embedder.unload(); }
      catch (error) { result.embeddingUnloadError = error instanceof Error ? error.message : String(error); }
      if (!retrievalOnly) {
        result.gpuPlacements = placements;
        try { await unloadModel(config.ollamaUrl, model); }
        catch (error) { result.modelUnloadError = error instanceof Error ? error.message : String(error); }
      }
    }
    entries.push(result);
    await checkpoint();
  }
}
await checkpoint(true);
console.log(`Evaluation report: ${output}`);
if (entries.some(entry => 'error' in entry)) process.exitCode = 1;
