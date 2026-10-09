import { writeFile } from 'node:fs/promises';
import { config } from '../src/config.ts';
import { loadCases, sourceState } from '../src/evaluation/cases.ts';
const cases = await loadCases();
const files = await sourceState({ website: config.websiteRepo, tests: config.testRepo }, cases);
await writeFile(new URL('../evals/source-snapshot.json', import.meta.url), JSON.stringify({ reviewedAt: new Date().toISOString(), files }, null, 2));
console.log(`Recorded hashes of ${files.length} gold files for ${cases.length} cases. Refresh only after reviewing expected outcomes and lines.`);
