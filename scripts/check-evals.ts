import { config } from '../src/config.ts';
import { goldDrift, loadCases } from '../src/evaluation/cases.ts';
const cases = await loadCases();
const drift = await goldDrift({ website: config.websiteRepo, tests: config.testRepo }, cases);
if (drift.length) { console.error(`Gold sources changed; review cases before refreshing snapshots: ${drift.join(', ')}`); process.exitCode = 1; }
else console.log(`${cases.length} gold cases validated; source hashes and line ranges match.`);
