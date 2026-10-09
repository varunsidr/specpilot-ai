import path from 'node:path';
import { config } from '../src/config.ts';
import { freezeRepositories } from '../src/evaluation/freeze.ts';
const destination = path.resolve('data/eval-snapshots', new Date().toISOString().replace(/[:.]/g, '-'));
const result = await freezeRepositories({ website: config.websiteRepo, tests: config.testRepo }, config.indexDir, destination, config.embedModel);
console.log(`Frozen eligible source files under ${destination}`);
console.table(result.reports);
console.log('For an evaluation session, set WEBSITE_REPO, TEST_REPO and RAG_INDEX_DIR to the manifest roots/indexDir. Review changed gold sources before running eval:snapshot against these copies. Keep the source-bearing snapshot out of Git.');
