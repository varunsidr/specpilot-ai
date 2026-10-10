import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Plan } from '../src/types.ts';
import type { OllamaMetrics } from '../src/providers/ollama.ts';
import type { planQuality } from '../src/evaluation/quality.ts';

type Entry = { id: string; model: string; category: string; expectedOutcome: string; goldSourcesVerified?: boolean; hardwareEligible?: boolean; error?: string; ollama?: OllamaMetrics;
  retrieval?: { recallAt10: number; selectedFileRecall: number; goldLineCoverage: number };
  plan?: { output: Plan; latencyMs: number; ollama: OllamaMetrics; correctness: ReturnType<typeof planQuality> | null } };
const directory = path.resolve('./data/evals');
const latest = process.argv[2] ?? (await readdir(directory)).filter(file => file.endsWith('.json')).sort().at(-1);
if (!latest) throw new Error('No evaluation report found; run npm run eval first.');
const filename = process.argv[2] ? path.resolve(latest) : path.join(directory, latest);
const report = JSON.parse(await readFile(filename, 'utf8')) as { complete?: boolean; expectedEntries?: number; settings?: { retrievalOnly?: boolean; retrievalStrategy?: string }; entries: Entry[] };
console.log(`Report: ${filename} (${report.complete ? 'complete' : 'partial or historical'})`);
console.log(`Retrieval strategy: ${report.settings?.retrievalStrategy ?? 'not recorded in this historical report'}`);
console.table(report.entries.map(entry => ({ model: entry.model, case: entry.id,
  outcome: entry.hardwareEligible === false ? 'hardware blocked' : report.settings?.retrievalOnly && !entry.error ? 'retrieval only' : entry.plan?.output.outcome ?? 'failed', gold: entry.expectedOutcome,
  matches: entry.plan?.correctness?.outcomeMatchesGold ?? '-',
  edits: entry.plan?.output.changes.length ?? '-', error: entry.error ?? '' })));
for (const model of new Set(report.entries.map(entry => entry.model))) {
  const entries = report.entries.filter(entry => entry.model === model);
  if (report.settings?.retrievalOnly) {
    console.table(entries.map(entry => ({ case: entry.id, recallAt10: entry.retrieval?.recallAt10 ?? '-', selectedFileRecall: entry.retrieval?.selectedFileRecall ?? '-', goldLineCoverage: entry.retrieval?.goldLineCoverage ?? '-' })));
    console.log(`${model}: retrieval only; ${entries.filter(entry => entry.retrieval).length}/${entries.length} retrievals completed, ${entries.filter(entry => entry.hardwareEligible === false).length} hardware blocked. No plan-quality score.`);
    continue;
  }
  const scored = entries.filter(entry => entry.plan?.correctness);
  const drifted = entries.filter(entry => entry.goldSourcesVerified === false || entry.error?.startsWith('Gold source changed'));
  const hardwareBlocked = entries.filter(entry => entry.hardwareEligible === false);
  const comparable = entries.filter(entry => !drifted.includes(entry) && !hardwareBlocked.includes(entry));
  const correct = scored.filter(entry => entry.plan!.correctness!.outcomeMatchesGold).length;
  const metrics = entries.flatMap(entry => (entry.plan?.ollama ?? entry.ollama)?.validationFailures ?? []);
  const reviewed = scored.filter(entry => entry.plan!.correctness!.manualReview.unsupportedSemanticClaims !== null);
  console.log(`${model}: ${entries.length} cases, ${scored.length} scored valid plans, ${entries.filter(entry => entry.error && entry.hardwareEligible !== false).length} failures, ${correct}/${comparable.length} gold outcomes matched across comparable attempts; ${drifted.length} cases withheld for source drift; ${hardwareBlocked.length} hardware blocked.`);
  console.log(`Rejected citation attempts: ${metrics.filter(error => error.includes('Unsupported citation')).length}; total validation failures: ${metrics.length}.`);
  console.log(`Unknown evidence-ID attempts: ${metrics.filter(error => error.includes('Unknown evidence ID')).length}; consistency findings: ${entries.reduce((sum, entry) => sum + ((entry.plan?.ollama ?? entry.ollama)?.consistencyFailures?.length ?? 0), 0)}.`);
  console.log(`Accepted unnecessary edits on implemented/ambiguous cases: ${scored.reduce((sum, entry) => sum + (entry.plan!.correctness!.unnecessaryEditCount ?? 0), 0)}. Semantic claim review: ${reviewed.length}/${scored.length} reviewed.`);
  console.log(`Unsupported claims in reviewed accepted plans: ${reviewed.reduce((sum, entry) => sum + (entry.plan!.correctness!.manualReview.unsupportedSemanticClaims ?? 0), 0)}. Unreviewed and rejected plans are not included in this claim count.`);
}
