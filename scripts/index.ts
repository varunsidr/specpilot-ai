import { config } from '../src/config.ts';
import { buildIndexes } from '../src/repositories/index.ts';
import { OllamaEmbedder } from '../src/repositories/semantic.ts';

const started = Date.now();
const embedder = new OllamaEmbedder(config.ollamaUrl, config.embedModel, config.embedTimeoutMs);
const reports = await buildIndexes({ website: config.websiteRepo, tests: config.testRepo }, config.indexDir, embedder);
if (reports.some(report => report.embedded)) await embedder.embed(['index complete'], true);
for (const report of reports) console.log(`${report.repository}: ${report.files} files, ${report.chunks} chunks indexed, ${report.embedded} chunks embedded${report.limited ? ' (inventory limit reached)' : ''}`);
console.log(`Index complete in ${Math.round((Date.now() - started) / 1000)}s. Model: ${config.embedModel}`);
