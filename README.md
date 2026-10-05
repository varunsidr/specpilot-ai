# SpecPilot AI

A local TypeScript backend for your separate application and Playwright repositories.

**First milestone:** requirement + acceptance criteria → selected repository context → implementation plan with file references → saved run.

This version reads repositories and proposes plans. Patch creation/application, Git diff analysis, Playwright execution, cloud providers and dashboard integration are the next increments; they are not implemented here. The example Playwright file is context data, not a runnable application or test suite.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow, [ROADMAP.md](ROADMAP.md) for planned work, and [SECURITY.md](SECURITY.md) before publishing or exposing the service.

## 1. Open in VS Code and run the demo

Install **Node.js 24 or newer**. The project runs TypeScript through Node's native type stripping and uses built-in HTTP/fetch APIs. The Hugging Face tokenizer package counts local model tokens; development dependencies provide type checking.

Extract this ZIP, open the `ai-engineering-platform` folder in VS Code, then use its PowerShell terminal:

```powershell
npm install
Copy-Item .env.example .env
npm run typecheck
npm test
npm run dev
```

Keep that terminal open. In a second terminal in the same folder:

```powershell
node scripts/demo.mjs
```

The first run uses `AI_PROVIDER=mock` and the included sample repositories. You should see `status: completed`, a clearly labelled mock plan, and a run ID. This verifies the plumbing; the mock provider performs no AI analysis.

Check API health at http://127.0.0.1:4100/health. The VS Code “Start AI backend” debug configuration also starts the service.

## 2. Connect your real repositories

Edit `.env` (use forward slashes for Windows paths; quote paths containing spaces):

```dotenv
WEBSITE_REPO="C:/Users/YourName/Projects/fashion-website"
TEST_REPO="C:/Users/YourName/Projects/playwright-ai-self-healing-framework"
```

Restart the backend after changing `.env`. Both folders must exist and contain source files. Repositories remain separate; this service reads their local checkouts. No cloning or code modification happens.

## 3. Switch to your local Ollama model

Make sure Ollama is running, then check installed models:

```powershell
ollama list
```

Set `.env` using the exact model name shown in that output:

```dotenv
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3.5:9b
OLLAMA_TIMEOUT_MS=180000
OLLAMA_NUM_CTX=8192
RAG_ENABLED=true
OLLAMA_EMBED_MODEL=qwen3-embedding:0.6b
OLLAMA_EMBED_TIMEOUT_MS=180000
RAG_INDEX_DIR=./data/index
TOKENIZER_DIR=./data/tokenizer
```

The model names above are examples; use exact installed names from `ollama list`. Install the embedding model once, then build the initial index before restarting the backend:

```powershell
ollama pull qwen3-embedding:0.6b
npm run setup:tokenizers
npm run index
npm run dev
```

In a second terminal, run `node scripts/demo.mjs`. The index is local and incremental: later planning requests refresh changed files automatically. Set `RAG_ENABLED=false` to use the original keyword-only retrieval. The adapter calls Ollama's `/api/chat` with a JSON schema, disables thinking for structured plans, and validates file references. It retries once if a model response is invalid. There is no automatic cloud fallback.

Only one planning request runs at a time. On an 8 GB GPU, the embedding query releases its model before the planner loads; `qwen3.5:9b` may still use some system RAM. Actual VRAM use and latency depend on quantization, context and other GPU workloads. If it is slow or runs out of memory, try `qwen3:8b`. Both models have local tokenizer files; rerun `npm run setup:tokenizers` after a fresh install. Keep `OLLAMA_NUM_CTX=8192` until measured retrieval and plan results justify a change.

## 4. Submit your own requirement

PowerShell example:

```powershell
$payload = @{
  title = "Add a maximum-price product filter"
  description = "Allow shoppers to filter and reset the product list."
  acceptanceCriteria = @(
    "Only products priced at or below the maximum are shown.",
    "Reset restores all products.",
    "No matches displays an empty state."
  )
  pinnedFiles = @(
    @{ repository = "website"; path = "src/components/ProductListing.tsx" }
  )
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri http://127.0.0.1:4100/api/plans `
  -Method Post -ContentType "application/json" -Body $payload |
  ConvertTo-Json -Depth 20
```

`pinnedFiles` is optional; each entry names an eligible repository file using a relative forward-slash path. Up to eight files can be pinned. `POST /api/plans` waits for planning and returns a complete run. Failed workflows return HTTP 502 with a saved failed run and error. Invalid input returns 400; concurrent planning returns 409. `GET /api/runs/<id>` retrieves a saved run. Run JSON files live under `data/runs/` and include selected source snippets and line ranges.

## Project layout

```text
src/
  config.ts                 Environment settings
  server.ts                 Local HTTP API
  types.ts                  Shared contracts
  requirements/validate.ts  Input checks
  repositories/context.ts   Bounded context selection
  repositories/scan.ts      Safe file inventory
  repositories/index.ts     Incremental local index
  repositories/chunks.ts    Line-numbered chunk boundaries
  repositories/tokenizer.ts Local Qwen tokenizer counter
  repositories/semantic.ts  Ollama embedding adapter
  repositories/semantic-context.ts  Hybrid semantic/keyword retrieval
  providers/
    mock.ts                 Offline demo provider
    ollama.ts               Local model adapter
    schema.ts               Plan schema and reference validation
  workflows/plan.ts         Coordinates requirement-to-plan
  runs/store.ts             JSON run persistence
examples/                   Sample repos and requirement
scripts/demo.mjs            API client
scripts/index.ts            Index builder
scripts/setup-tokenizers.ts Pinned tokenizer download and checksum check
scripts/evaluate.ts         Retrieval and planning evaluation
evals/requirements.json     Real requirement gold files
tests/                     Starter verification tests
```

## How context works

With `RAG_ENABLED=true`, the service splits each eligible source file into overlapping, line-numbered chunks and embeds each chunk with Ollama. Each request refreshes changed files, embeds the requirement, combines semantic and keyword rankings, and expands imports plus related Playwright tests from leading matches. Pinned files rank first. Selected snippets include six nearby lines where they fit. The embedding model is separate from the planning model. The index is local JSON in `data/index/`; no vector database is needed. The first chunk rebuild takes longer than later incremental refreshes.

The planner counts the actual Qwen tokenizer output for its full prompt, including instructions, requirement and selected code. It reserves 1,800 tokens for the plan and 256 tokens of headroom inside `OLLAMA_NUM_CTX`. Up to twelve chunks, six per repository and two per file, are selected within that budget. If pins cannot fit, the request fails with a clear error. The count is an estimate of Ollama's final chat prompt: its schema formatting and internal templates can add tokens, so compare `retrieval.promptTokens` with Ollama's `prompt_eval_count` in evaluation reports.

With `RAG_ENABLED=false`, the original keyword retrieval selects up to six files per repository, with up to 12,000 characters per repository and 4,000 per file. Pinning and token packing apply to RAG mode. Both modes report excerpting and inventory limits.

## Evaluate retrieval and planning

`evals/requirements.json` records three requirements from the configured storefront and Playwright repositories, with source and test files chosen by inspection. Run `npm run eval` for retrieval recall at 5 and 10 files, selected-file recall, prompt tokens, plan file overlap, scenario keyword coverage, latency, and sampled GPU memory/utilization. The report is saved in ignored `data/evals/`; the measured baseline and findings are in `evals/README.md`. To compare your two local planners on the same requirements, set `$env:EVAL_MODELS='qwen3:8b,qwen3.5:9b'` before running it. Set `$env:EVAL_RETRIEVAL_ONLY='true'` for a faster ranking-only run, or `$env:EVAL_CASES='price-sort'` to isolate a case. Remove those session variables afterward if needed. Plan overlap and keyword coverage are simple proxies; read the plans before deciding which model or ranking is better. The gold paths may need updating if either external repository changes.

Hidden files, common build/dependency folders, symlinks and filenames indicating credentials are skipped. This does **not** guarantee secrets are absent inside ordinary source files. Review what is stored in run context before adding any external provider. File references are checked against supplied context; that establishes provenance, not correctness. The model can request missing context or proposed new files in `questions`.

## Roadmap and publishing

[ROADMAP.md](ROADMAP.md) tracks the next stages: better evidence checking, Git provenance, reviewable diffs, isolated test execution, and dashboard integration. The first priority is plan correctness because both local models proposed unnecessary changes in the current evaluation.

Before the first GitHub commit, run `npm run check:publish` and inspect the staged diff. `.env` and all `data/` contents stay local; `.env.example` is the public template. See [SECURITY.md](SECURITY.md) for the runtime boundary and what to do if a secret has already entered Git history.

Add provider adapters by implementing `AIProvider`; register the adapter in `server.ts` and extend the config allowlist. Keep decisions and orchestration separate from the provider.

For dashboard integration, proxy requests through your dashboard backend. This service binds only to `127.0.0.1`, rejects cross-origin browser requests, and has no public authentication. It is a local development starter; hosting it publicly requires authentication, authorization and job isolation. Do not let model output directly become shell commands.

## Troubleshooting

- **Unknown `.ts` extension / unsupported env-file flag:** verify `node --version` is 24+ and reopen VS Code after upgrading.
- **Connection refused:** check the backend or Ollama is running on the configured port.
- **Ollama HTTP 404:** verify `OLLAMA_MODEL` matches an installed name from `ollama list`.
- **Embedding HTTP 404:** install the exact `OLLAMA_EMBED_MODEL` shown in `.env`, then run `npm run index`.
- **Missing tokenizer:** run `npm run setup:tokenizers`; token packing currently supports `qwen3:8b` and `qwen3.5:9b`.
- **Invalid model response:** inspect context, try a more reliable model or reduce task scope. The starter deliberately rejects invented file references.
- **Missing repository:** check `.env` paths, including quotes around spaces.
- **Timeout:** warm up your model, inspect GPU usage and tune the timeout/context limits.

## References

- Ollama chat API: https://docs.ollama.com/api/chat
- Ollama structured output: https://docs.ollama.com/capabilities/structured-outputs
- Ollama embeddings: https://docs.ollama.com/capabilities/embeddings
- Node TypeScript execution: https://nodejs.org/api/typescript.html

## Verification supplied with this starter

Run `npm test` and `npm run typecheck`. Tests cover input validation, context exclusions, chunk indexing and refresh, pinning/import expansion, invalid model file references, retry behavior, completed/failed run persistence and the Ollama HTTP protocol using a fake server. Real local-model plans still require human review.

Verified locally: all eight tests and TypeScript type checking passed. The live evaluation command reports measured retrieval and planning performance for the currently configured repositories.
all are working
