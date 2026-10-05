import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

function git(args: string[]): Buffer {
  return execFileSync('git', args, { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function paths(args: string[]): string[] {
  return git(args).toString('utf8').split('\0').filter(Boolean).map(file => file.replaceAll('\\', '/'));
}

let staged: string[], untracked: string[];
try {
  staged = paths(['ls-files', '--cached', '-z']);
  untracked = paths(['ls-files', '--others', '--exclude-standard', '-z']);
} catch {
  throw new Error('Run this check from a Git repository before committing or pushing.');
}

const findings: string[] = [];
const candidates = [...new Set([...staged, ...untracked])];
const riskyPath = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|\.aws|\.ssh|data|node_modules|credentials?|secrets?|service[-_]?account|id_(?:rsa|ed25519))(?:\/|$)|(?:credential|secret|service[-_]?account).*\.json$|\.(?:pem|key|p12|pfx|jks|keystore|db|sqlite3?|zip|7z|tar|gz|bak|orig|log)$/i;
const secretPatterns: [string, RegExp][] = [
  ['private key block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ['access token or cloud key', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|AKIA[0-9A-Z]{16})\b/],
  ['credential in URL', /\b(?:https?|postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s/'"@]+:[^\s/'"@]+@/i],
  ['machine-specific Windows home path', /[A-Za-z]:[\\/]Users[\\/](?!YourName\b|yourname\b|<)[^\\/\s'"<>]+[\\/]/i],
  ['credential assignment', /^\s*[A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS)\s*=\s*(?!$|["']?$|your[-_]|example\b|changeme\b|<)[^\s#]+/i],
];

function inspect(file: string, label: string, bytes: Buffer): void {
  if (bytes.length > 1024 * 1024) findings.push(`${file} (${label}): larger than 1 MiB; review before publishing`);
  if (bytes.includes(0)) return;
  const lines = bytes.toString('utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [name, pattern] of secretPatterns) if (pattern.test(line)) findings.push(`${file}:${index + 1} (${label}): ${name}`);
  });
}

for (const file of candidates) {
  if (file !== '.env.example' && riskyPath.test(file)) findings.push(`${file}: sensitive or generated path`);
  const full = path.resolve(file);
  if (existsSync(full)) {
    if (lstatSync(full).isSymbolicLink()) findings.push(`${file}: symlink needs manual review`);
    else inspect(file, 'working tree', readFileSync(full));
  }
  if (staged.includes(file)) {
    try { inspect(file, 'staged', git(['show', `:${file}`])); }
    catch { findings.push(`${file}: could not inspect staged content`); }
  }
}

if (findings.length) {
  console.error('Potential publication risks (values hidden):');
  for (const finding of [...new Set(findings)]) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Publish check passed for ${candidates.length} candidate files. Review the staged diff before pushing.`);
}
