import { readFile } from 'node:fs/promises';
const payload = await readFile(new URL('../examples/requirement.json', import.meta.url), 'utf8');
const response = await fetch('http://127.0.0.1:4100/api/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(240000) });
console.log(JSON.stringify(await response.json(), null, 2));
if (!response.ok) process.exitCode = 1;
