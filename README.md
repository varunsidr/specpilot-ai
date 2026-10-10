# SpecPilot AI

A local TypeScript backend for your separate application and Playwright repositories.

**First milestone:** requirement + acceptance criteria → selected repository context → implementation plan with file references → saved run.

This version reads repositories and proposes plans. Patch creation/application, Git diff analysis, Playwright execution, cloud providers and dashboard integration are the next increments; they are not implemented here. The example Playwright file is context data, not a runnable application or test suite.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the data flow, [ROADMAP.md](ROADMAP.md) for milestones, [FUTURE_WORKFLOW.md](FUTURE_WORKFLOW.md) for the agreed implementation sequence and rough scope estimates, and [SECURITY.md](SECURITY.md) before publishing or exposing the service.

## 1. Open in VS Code and run the demo

Install **Node.js 24 or newer**. The project runs TypeScript through Node's native type stripping and uses built-in HTTP/fetch APIs. The Hugging Face tokenizer package counts local model tokens; the TypeScript parser profiles source and finds chunk boundaries.

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
OLLAMA_TIMEOUT_MS=300000
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

In a second terminal, run `node scripts/demo.mjs`. The index is local and incremental: later planning requests refresh changed files automatically. Set `RAG_ENABLED=false` to use the original keyword-only retrieval. The adapter calls Ollama's `/api/chat` with a schema per stage, binds criterion numbers/text and row counts to the requirement, disables thinking for structured responses, and retries one invalid response per stage. Review schemas restrict scenarios to the exact draft scenarios; the backend checks uniqueness and coverage. Both Ollama retrieval modes require tokenizer assets to check each actual prompt. There is no automatic cloud fallback.

Only one planning request runs at a time. On an 8 GB GPU, the embedding query releases its model before the planner loads; `qwen3.5:9b` may still use some system RAM. Actual VRAM use and latency depend on quantization, context and other GPU workloads. If it is slow or runs out of memory, try `qwen3:8b`. Both models have local tokenizer files; rerun `npm run setup:tokenizers` after a fresh install. Keep `OLLAMA_NUM_CTX=8192` until measured retrieval and plan results justify a change.

`npm run eval` now requires reported full GPU placement for embeddings and each planner stage, saving placement checks and reporting hardware blocks separately from plan failures. The normal HTTP API still uses Ollama's automatic placement. Source profiling and tokenization use CPU/RAM. JS/TS/JSX/TSX indexes now preserve bounded syntax blocks and store literal source facts; old indexes rebuild automatically on the next indexing/retrieval request.

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

Plans now use `schemaVersion: 2`. Each acceptance criterion has an `implemented`, `gap`, or `unknown` assessment with an observation and exact source quotes. Every proposed edit names its criterion, observed gap, and evidence from that file. Quotes are checked against supplied line ranges. The outcome is `already_implemented` (no changes), `changes_needed`, or `needs_context` (questions, no speculative edits). A completed run means a valid plan was returned, including an unresolved `needs_context` result; it does not mean the requirement was implemented or tests were executed. Existing saved plans retain their older format.

The model selects content-bound evidence IDs; the backend supplies the exact quotes and lines in the saved public plan. IDs stay the same for identical source fragments across overlapping excerpts, and change when their location or text changes. Long lines are split into fragments of at most 500 characters. A valid ID still cannot prove that the model interpreted the source correctly.

Planning now runs in stages. First, assess every criterion without proposing edits. Supplied handlers, state definitions and complete UI blocks can establish a gap for an additive enhancement; implementation choices alone are not missing business policy. The backend derives the outcome; any unknown criterion returns questions and prevents drafting. Unresolved assessment questions cannot coexist with fully resolved criteria, so missing business decisions cannot be locked as gaps for drafting. If all criteria are implemented, the run finishes after assessment. Confirmed gaps enter a draft stage grouped by exact criterion number and text; assessments stay fixed, and changes must retain evidence from their gap assessment. A final model review checks criterion alignment, evidence support and unsupported risk statements, and traces every test scenario through the proposed guards and result. The backend independently rejects failed scenario checks and contradictory summary flags, passing those findings to correction. Reported issues reject the draft. This review can miss errors and does not replace independent source review. Stage diagnostics, including rejected-draft review findings and up to 12,000 characters of each structurally rejected response, are saved in `planningMetrics` and ignored evaluation reports. Treat these source-bearing records as private.

For bounded numeric enhancements, drafting is instructed to state handler formulas and disabled conditions, calculate clamped expectations, and cover ordinary, partial-step, limit, zero and unknown-limit states where relevant. Review is instructed to calculate those results independently. Risk findings must reference an actual draft risk; an empty risk list cannot receive a fabricated finding. These constraints improve review structure but still require source inspection to establish correctness.

Assessment diagnostics now include a private evidence and uncertainty audit. The backend requires one check per cited ID, direct supporting checks for resolved observations, and a source or policy question for each unknown criterion. Policy-only questions cannot trigger source requests, and draft questions are rejected. These checks enforce consistency of the model's self-audit; they do not independently verify its interpretation. Public plans retain schema version 2.

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
  repositories/profile.ts   Syntax-derived source facts and ranges
  repositories/tokenizer.ts Local Qwen tokenizer counter
  repositories/semantic.ts  Ollama embedding adapter
  repositories/semantic-context.ts  Hybrid semantic/keyword retrieval
  repositories/usage.ts             Syntactic call and event-reference links
  repositories/expand-context.ts   Bounded follow-up evidence reads
  evaluation/              Gold source checks and correctness metrics
  providers/
    mock.ts                 Offline demo provider
    ollama.ts               Local model adapter
    schema.ts               Plan schema and reference validation
    evidence.ts             Stable source-fragment IDs and quote resolution
    stages.ts               Assessment, draft, and review contracts
  workflows/plan.ts         Coordinates requirement-to-plan
  runs/store.ts             JSON run persistence
examples/                   Sample repos and requirement
scripts/demo.mjs            API client
scripts/index.ts            Index builder
scripts/setup-tokenizers.ts Pinned tokenizer download and checksum check
scripts/evaluate.ts         Retrieval and planning evaluation
evals/requirements.json     Implemented, missing, and ambiguous evaluation cases
tests/                     Starter verification tests
```

## How context works

With `RAG_ENABLED=true`, the service splits each eligible source file into line-numbered chunks and embeds each chunk with Ollama. Each request refreshes changed files, embeds the requirement, combines semantic and keyword rankings, and expands imports plus related Playwright tests from leading matches. Pinned files rank first. Selected snippets include six nearby lines where they fit. The embedding model is separate from the planning model. The index is local JSON in `data/index/`; no vector database is needed. The first chunk rebuild takes longer than later incremental refreshes.

`RAG_RETRIEVAL_STRATEGY=requirement` is the default. Experimental `criterion` selection embeds each criterion separately in the same query batch. Version 2 preserves useful whole-requirement excerpts and favors matching handlers, guards, state and referenced functions before sharing remaining space across criteria. Shared chunks are included once. Saved retrieval metadata includes anchors, criterion nominations and syntactic source-use links. Symbol binding distinguishes actual references from comments, strings and shadowed names; it can miss indirect or dynamic uses. Keep this strategy opt-in while broader validation is pending. Ranking and source-use links do not prove that a fragment supports a claim or supplies a missing business decision.

The planner counts Qwen tokenizer output for its full prompt, including instructions, requirement, evidence IDs, line labels, available file paths and selected code. Retrieval reserves 1,800 output tokens, 256 tokens of template headroom, 256 for validation feedback, and 1,200 for later stage state inside `OLLAMA_NUM_CTX`. At 8192, the initial assessment prompt budget is 4,680 tokens. Up to twelve chunks, normally six per repository and two per file, are selected within that budget; pins can exceed the per-repository cap. Every stage measures its actual prompt again before sending it; unusually large assessments/drafts can still fail the fit check. If pins cannot fit, the request fails with a clear error. Compare per-stage estimates with Ollama's `prompt_eval_count` in reports.

If excerpts are incomplete, the assessment stage can ask for up to three eligible file ranges of at most 120 lines. Follow-up packing preserves pins, previously requested ranges, and source around assessment citations before adding new ranges. If protected evidence cannot fit, the original context is retained and no new range is served. Adjacent excerpts jointly count as supplied lines. Prompts include supplied ranges, follow-up warnings, and the previous assessment for reassessment against source. Expansion stops after two rounds; an unknown assessment's redundant request gets at most one reassessment with explicit feedback before stopping. For resolved assessments, already-supplied requests are discarded and recorded in `redundantContextRequests`; genuinely unseen requests remain invalid until the relevant assessment is unknown. A trace is saved in `context.followUps`. The model never gets arbitrary filesystem access. Invalid responses get one structural repair attempt per stage, with a short error and a rebuilt prompt; rejected responses are not appended. A negative consistency review allows one redraft using its findings, then requires another review. A second negative review rejects the plan. `reviewAttempts` retains both drafts and reviews, while `consistencyFailures` includes findings from all attempts even when correction succeeds. `OLLAMA_TIMEOUT_MS` bounds assessment, expansion, drafting, review and repairs together. Gap cases normally need three model calls, or five with consistency correction; implemented or policy-unknown cases normally need one.

With `RAG_ENABLED=false`, the original keyword retrieval selects up to six files per repository, with up to 12,000 characters per repository and 4,000 per file. Pinning and token packing apply to RAG mode. Both modes report excerpting and inventory limits.

## Evaluate retrieval and planning

`evals/requirements.json` records 19 cases from the connected storefront and Playwright repos: 12 implemented behaviors, five gaps (four constructed enhancements and one stock-guard defect), and two ambiguous policies. The stock case was corrected after source inspection found that a product can be entirely out of stock while no size is selected and its quantity increase control remains enabled. Historical reports used its older label. Cases include expected assessments, outcomes and source line ranges. `evals/source-snapshot.json` contains paths and hashes, not external source text. The real evaluation corpus requires those repos; it is separate from the included demo fixtures.

Run `npm run eval:check` before `npm run eval`. Evaluation refuses stale gold sources. When a repo changes, inspect the affected expected outcomes and lines before deliberately running `npm run eval:snapshot`. Each new report retains a fixed copy of its gold hashes and checkpoints after each case under ignored `data/evals/`. It records retrieval/file and line coverage, outcome agreement, criterion status accuracy, false gap/implementation claims, unnecessary edits on implemented or ambiguous cases, validation failures, context rounds, latency, GPU use and accepted raw plans. Exact citations validate provenance; semantic correctness still needs the manual review described in [evals/REVIEW.md](evals/REVIEW.md). Unreviewed semantic claim counts remain `null`.

Set `$env:EVAL_MODELS='qwen3:8b,qwen3.5:9b'` to compare both planners, `$env:EVAL_RETRIEVAL_ONLY='true'` for ranking only, or `$env:EVAL_CASES='quantity-minimum,quantity-step-buttons,shipping-policy'` for a stratified smoke run. Remove session variables afterward if needed. Historical measurements are in [evals/README.md](evals/README.md); file overlap and keyword coverage are retained only as legacy proxies.

If another task is editing the repositories, use `npm run eval:freeze` to copy eligible files into ignored `data/eval-snapshots/`. Unchanged cache entries use the existing size/mtime cache checks; changed files are embedded afresh. Read the printed snapshot's `manifest.json` and set session variables `WEBSITE_REPO`, `TEST_REPO`, and `RAG_INDEX_DIR` to its `roots.website`, `roots.tests`, and `indexDir`. Run `eval:check` against those copies. If gold hashes differ, inspect the changed source and criteria before using `eval:snapshot`; then run the comparison. Remove those session variables to return to `.env` repositories. Freezing prevents later edits to the originals from changing the copied evaluation input; it does not establish semantic correctness or guarantee that ordinary source files contain no secrets.

Use `npm run eval:summary` for a compact view of the latest report, or `npm run eval:summary -- data/evals/<report>.json` for a specific run. Failed model calls remain in the outcome-match denominator; cases invalidated by source drift are reported separately and withheld from that comparison.

Hidden files, common build/dependency folders, symlinks and filenames indicating credentials are skipped. This does **not** guarantee secrets are absent inside ordinary source files. Review what is stored in run context before adding any external provider. File references are checked against supplied context; that establishes provenance, not correctness. The model can request missing context or proposed new files in `questions`.

## Roadmap and publishing

[ROADMAP.md](ROADMAP.md) tracks the next stages: better evidence checking, Git provenance, reviewable diffs, isolated test execution, and dashboard integration. Plan correctness remains the first priority: the latest frozen 19-case comparison matched 10 outcomes per model, but source review found incorrect claims and a quantity-boundary plan that passed model review with wrong expectations. See [evals/README.md](evals/README.md) for the category breakdown and measurement limits.

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

Verification includes quote/line rejection, stale evidence IDs, exact criterion ownership, fixed assessments, model-reported contradiction rejection, per-stage token checks, prevention of edits to implemented/unknown criteria, empty change lists, bounded context expansion, and correctness scoring. Run `npm test`, `npm run typecheck`, and `npm run eval:check` for the current checks.
all are working
