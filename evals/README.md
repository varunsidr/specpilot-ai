# Local RAG evaluation

`requirements.json` contains 19 cases: 12 existing behaviors, five gaps (four constructed enhancements and one stock-guard defect), and two ambiguous policy requests. Gold files, outcomes, and evidence ranges were chosen by reading the configured storefront and Playwright source. `source-snapshot.json` records their hashes; run `npm run eval:check` before evaluation. See [REVIEW.md](REVIEW.md) for semantic review instructions. Reports containing source excerpts and full plans are written to ignored `data/evals/`.

### Stock gold correction on 2026-10-08

The earlier corpus labeled `quantity-stock` as fully implemented. Source inspection found a counterexample: a sized product starts with no selected size (`ProductDetailView.tsx:51`), so its available stock is unknown (`115-120`). All sizes can be out of stock (`121-123`) while the increase button's guard (`456`) still permits clicks. The expected outcome is now `changes_needed`, with a gap assessment and the component as an allowed change file. Historical reports below retain their original labels and category counts; their outcome scores are not directly comparable with this corrected corpus. New reports retain the full `goldCases` alongside the source hashes.

Run `npm run eval` after `npm run index`; set `EVAL_MODELS=qwen3:8b,qwen3.5:9b` to compare both planners. `EVAL_CASES_FILE=./evals/reserved-requirements.json` selects the four separate validation inputs documented in [RESERVED-REVIEW.md](RESERVED-REVIEW.md); it also applies to `eval:check` and `eval:snapshot`. Clear it for the default 19 development cases. Reports save the chosen corpus path and full gold cases. `npm run eval:summary` summarizes the latest report, including failures. The three-case results below are historical and use the older plan format.

New evaluations require full reported GPU placement for embeddings and planner inference. The harness preloads and checks `/api/ps` before inference, checks again afterwards, and unloads evaluated models between cases. Planner context must match the requested setting. Hardware blocks are recorded separately and excluded from comparable plan attempts. Historical results below did not enforce this policy; logs showed CPU offload for 9B, so earlier latency results are not controlled GPU-only comparisons. The normal HTTP backend still uses automatic placement. See [FUTURE_WORKFLOW.md](../FUTURE_WORKFLOW.md) for the evaluation rules and next gates.

## Measurements on 2026-10-05

All runs used `qwen3-embedding:0.6b` and `OLLAMA_NUM_CTX=8192` on the RTX 5050 Laptop GPU. Both the baseline and tuned runs used the new chunk index. The baseline was the first chunk-ranking pass before source priors and relationship tuning.

| Case | Gold files | First pass recall@10 | First pass selected recall | Tuned recall@10 | Tuned selected recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| Price sorting | 3 | 0.67 | 0.33 | 1.00 | 1.00 |
| Empty search | 4 | 0.50 | 0.50 | 1.00 | 1.00 |
| Guest checkout | 4 | 1.00 | 0.75 | 1.00 | 1.00 |

The tuned pass excluded generated Playwright error reports, prioritized source and test files over docs, followed imports through the page-object fixture, linked test selectors and routes to application files, and chose one chunk per file before additional chunks. These are three known cases, not proof of general retrieval accuracy. Add new cases before changing the ranking again.

| Planner | Mean planning latency | Planning GPU memory peak | Ollama input tokens | Gold files mentioned in changes |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 8B | 21.4 s | 7,015–7,654 MiB used | 6,085–6,136 | 0.50–0.67 recall |
| Qwen3.5 9B | 42.5 s | 7,026–7,200 MiB used | 6,094–6,138 | 0.50–1.00 recall |

The GPU numbers are total used memory sampled with `nvidia-smi`, including other processes. Model input token counts came from Ollama's `prompt_eval_count`. The local tokenizer estimates differed by 4–8 tokens in these cases, leaving room under 8192 after the reserved 1800 output tokens and 256-token safety allowance.

## Manual plan review

Both models proposed edits for requirements that already have source and test coverage. Qwen3 8B added unrelated legal and product-detail tests to the search plan and proposed an incorrect signed-out checkout scenario. Qwen3.5 9B included an admin layout no-op and a product-data script in the price-sort change list; its sorting explanation also misread the current implementation. A shorter Qwen3.5 rerun after a stricter planner instruction still inferred that `ProductListing` calls `useProductSort`, while the current code sorts inline. The updated prompt reduced unrelated changes in that rerun, but did not remove the false source claim.

The automated plan file overlap and scenario keyword metrics in the JSON report are proxies. They reward mentioning gold paths even when no edit is needed, so inspect `plan.output` before treating a higher score as a better plan. On this small set, Qwen3 8B is faster; neither planner is reliable enough to apply changes without source review. The current configured model remains Qwen3.5 9B until a broader evaluation supports changing it.

## Evidence-contract baseline on 2026-10-06

The version 2 planner was tested on all 19 cases with Qwen3 8B, the same embedding model, and an 8192-token context. The interrupted run was completed in a second session; planner code hashes and settings matched. Failures remain in the denominator.

| Category | Cases | Valid plans matching the gold outcome | Rejected plans |
| --- | ---: | ---: | ---: |
| Existing behavior | 13 | 7 | 6 |
| Missing enhancement | 4 | 0 | 4 |
| Ambiguous policy | 2 | 0 | 2 |
| Total | 19 | 7 (36.8%) | 12 |

All seven accepted plans proposed no edits. Source inspection by Codex found one incorrect test expectation in the duplicate-cart plan: differing prices do not prevent a merge when product, size, and color match. Exact citation validation therefore did not eliminate unsupported semantic claims. Rejected raw responses were not retained for semantic review; their recorded validation errors are not a complete count of their false claims. An independent review and external test execution are still pending.

There were 26 failed validation attempts across initial responses and repairs, including 11 unsupported-citation attempts. Other failures included inconsistent outcomes/change lists, edits not tied to gap assessments, and oversized evidence ranges. No live 8B case completed a context expansion; the bounded follow-up mechanism is covered by deterministic tests, not established as reliable model behavior by this run.

| Measurement | Result |
| --- | ---: |
| Mean gold-file recall@10 | 0.930 |
| Mean selected gold-file recall | 0.825 |
| Mean initial gold-line coverage | 0.710 |
| Mean retrieval latency, all 19 cases | 17.6 s |
| Mean Ollama-reported duration, including repairs, all 19 cases | 33.6 s |
| Mean end-to-end planning latency, accepted plans only | 14.1 s |
| Sampled total GPU memory peaks, accepted plans only | 6,908–7,123 MiB |

Latency for accepted plans excludes retrieval. Failed plans do not retain the sampler's GPU/wall-time result, so the accepted-only measurements should not be read as averages across all attempts. The complete local report is `data/evals/2026-10-06T18-15-35-053Z-completed-baseline.json`; source excerpts stay out of Git. It retains the original gold hashes. A later page-object edit added registration/cart helpers without changing these cases' relevant behavior; the checked-in fingerprint was refreshed after source inspection.

The next gate is improving useful, correct answers under this contract, especially on missing and ambiguous requirements. Keep stage 2 in progress; these results do not justify patch generation or a claim that either model is production-ready.

### Qwen3.5 9B smoke check

Three representative cases were attempted: quantity minimum, quantity step buttons, and shipping policy. The minimum and shipping responses failed exact citation validation. The step-buttons case was initially refused after a page-object edit, then returned a structurally valid plan when retried against a reviewed snapshot. The page object changed again during generation, so that result's gold correctness score remains `null`.

Source inspection of the unscored plan found swapped criterion references, disabled controls contradicting the proposed clamp-to-limit test expectations, and an unsupported arithmetic crash/infinite-loop risk. These are four distinct review findings, stored separately from gold correctness. The supplied product component still exposes single-step quantity controls, but the suggested implementation is not ready to apply.

The page-object edits added registration/cart helpers and a cart recovery locator; the relevant gold behavior and evidence ranges were reviewed before refreshing its fingerprint. Reports retain their earlier snapshot hashes. This smoke check is not a controlled full-model comparison and does not establish that either model is better overall. It confirms that the configured 9B model also needs work under the stricter contract.

## Staged planner smoke check on 2026-10-07

The planner now selects backend-generated evidence IDs, assesses each criterion before drafting, and reviews drafts for criterion alignment, evidence support, and agreement between steps and tests. Public plans still use schema version 2 with backend-materialized quotes and line numbers. The reviewer is another model call, so its verdict requires source inspection.

Three cases per model were run against the same frozen repository copies: quantity minimum, quantity step buttons, and shipping policy. Source hashes remained stable throughout. Both models used an 8192-token context, the same embedding model, and an initial prompt budget of 4680 tokens, leaving a 1200-token reserve for later stages. Later prompts are measured again before calling Ollama.

| Planner | Valid plans | Gold outcomes matched, all attempts | Rejected plans | Failed validation attempts |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 8B | 3/3 | 2/3 | 0 | 1 |
| Qwen3.5 9B | 2/3 | 1/3 | 1 | 3 |

Both models recognized the quantity minimum and returned `needs_context` for the missing five-step controls. The latter is a false abstention: the supplied quantity-control block already showed the relevant handlers. Both requested a range that was already supplied, so the backend stopped without another model call. Qwen3 8B asked for the missing shipping policy after two served context expansions and one repair. Qwen3.5 9B's shipping response was rejected for a context range exceeding 120 lines; its minimum case needed one repair for incorrect criterion coverage.

There were no unknown evidence-ID or unsupported-citation validation failures in these six attempts. Codex inspected all five accepted plans against source: they proposed no edits, but the 8B shipping assessment incorrectly claimed that no currency conversion exists. `CurrencyContext.tsx` implements conversion and was served during an earlier expansion. Correct outcome agreement therefore does not establish that every source claim is correct. Rejected raw responses were not retained and remain unreviewed.

| Accepted-case planning latency, including repairs and expansion | Qwen3 8B | Qwen3.5 9B |
| --- | ---: | ---: |
| Quantity minimum | 13.4 s | 83.8 s |
| Quantity step buttons | 12.5 s | 15.5 s |
| Shipping policy | 39.0 s | Rejected; wall-time sample unavailable |
| Sampled total GPU memory peaks | 7059-7345 MiB | 7261-7316 MiB |

Latency excludes initial retrieval. The 9B minimum result includes a long rejected first response and its repair; it is not a steady-state inference estimate. GPU samples include other processes. Local prompt estimates differed from Ollama counts by eight tokens for 8B and four for 9B.

No case reached live drafting or consistency review because neither model confirmed the missing-feature gaps. Deterministic HTTP tests cover those branches, including rejection of contradictory steps and tests, but their useful live-model behavior remains unmeasured. This small smoke check does not establish an overall model winner or a before/after accuracy improvement over the historical 19-case baseline.

The complete local report is `data/evals/2026-10-06T18-56-36-565Z.json`; its timestamp uses UTC. Frozen sources, index caches, full plans, and review notes stay under ignored `data/`. Use `npm run eval:freeze` before comparisons when another task is editing the configured repositories. Stage 2 remains in progress: the next reliability work is reducing false abstentions, retaining relevant evidence through context expansion, and measuring live gap drafting before enabling patch generation.

## Full staged comparison on 2026-10-08

Both planners completed all 19 corrected cases against the same frozen repository copies (38 attempts). The planner code remained unchanged throughout this final run; recorded hashes match the implementation at completion, and no source-drift cases were reported. Each model used `qwen3-embedding:0.6b`, an 8192-token context, a 4680-token initial prompt budget and a shared 300-second planning deadline. Earlier diagnostic and interrupted runs are excluded from this comparison. These are cases used during development, not a held-out accuracy estimate.

This iteration preserves assessment citations and previously requested ranges during follow-ups, permits one reassessment for redundant unknown-context requests, and records discarded redundant requests for resolved assessments. Stage schemas constrain the exact criterion count and text; reviews must cover every draft scenario. One correction is allowed after a negative review, followed by another review. Full gold definitions, both review attempts and capped rejected responses are retained locally for diagnosis.

| Category | Cases per model | 8B matching outcomes | 8B rejected | 9B matching outcomes | 9B rejected |
| --- | ---: | ---: | ---: | ---: | ---: |
| Existing behavior | 12 | 9 | 3 | 10 | 2 |
| Missing behavior | 5 | 1 | 3 | 0 | 4 |
| Ambiguous policy | 2 | 0 | 2 | 0 | 2 |
| Total | 19 | 10 (52.6%) | 8 | 10 (52.6%) | 8 |

Each model returned 11 structurally valid plans. The remaining valid outcome mismatch was a false abstention: sort URL persistence for 8B and undo removal for 9B. Failures remain in the denominator. Neither model returned a valid answer for either ambiguous policy, even though the required business decisions were deliberately unspecified.

Codex inspected all 22 accepted plans against the frozen source and supplied excerpts. The accepted 8B quantity-step plan correctly identifies a missing feature, but expects quantity 8 with stock 10 to become 13, and quantity 5 to become zero after subtracting five. The required results are 10 and one. Its final model review approves both incorrect expectations. Its first review also lists “No risk issues identified” as a risk issue, triggering correction without a substantive finding. Outcome agreement is therefore not complete plan correctness, and the first verified correct missing-feature plan remains an open gate.

Source review recorded three distinct false or unsupported claims across accepted 8B plans and four across accepted 9B plans. Examples include misattributing `addItem` to the storage helper, claiming nonexistent supplied test coverage, and treating price-multiset equality as proof of product identity. These counts exclude rejected attempts and do not include every weak or irrelevant citation; those are recorded in the review notes. Exact quote validation establishes provenance, while some chosen quotes still fail to support the associated claim. No accepted plan proposed unnecessary edits on implemented or ambiguous cases. The only accepted change plan was the incorrect 8B quantity plan; 9B accepted no changes.

| Measurement | Qwen3 8B | Qwen3.5 9B |
| --- | ---: | ---: |
| Mean initial gold-file recall@10 | 0.895 | 0.895 |
| Mean initial selected gold-file recall | 0.680 | 0.680 |
| Mean initial gold-line coverage | 0.675 | 0.675 |
| Mean retrieval latency, all 19 cases | 15.9 s | 16.6 s |
| Mean Ollama-reported completed-call duration, all 19 cases | 22.1 s | 65.6 s |
| Mean planning latency, accepted plans only | 17.7 s | 22.8 s |
| Planning latency range, accepted plans only | 6.6-63.7 s | 9.4-66.9 s |
| Sampled total GPU memory peaks, accepted plans only | 6956-7007 MiB | 7110-7198 MiB |
| Completed stage calls, including repairs and correction | 39 | 48 |
| Validation failures across attempts and repairs | 16 | 13 |
| Unknown evidence-ID / unsupported-quote failures | 0 / 0 | 0 / 0 |

Planning latency excludes initial retrieval and includes expansion and repairs where used. Failed attempts do not retain wall-time/GPU samples; Ollama durations cover completed calls rather than any interrupted in-flight work. GPU usage includes other processes. Prompt estimates were eight tokens below Ollama counts for 8B and four below for 9B. Each model served two follow-up rounds on its false-abstention case; live follow-ups did not resolve those requirements. External application and Playwright tests were not executed.

The complete report is `data/evals/2026-10-07T19-01-44-887Z.json` (UTC timestamp). Its source-bearing contents and manual notes stay under ignored `data/`. This comparison supports retaining the current default while addressing citation relevance, concrete boundary checking, false abstentions and spurious risk findings. It does not establish an overall model winner, a before/after accuracy improvement over differently labeled historical runs, or readiness for automatic patch generation.

## Planner diagnostics on 2026-10-10

Three development cases were run against the same frozen source copies: quantity minimum, quantity step buttons, and shipping policy. An initial iteration linked risk findings to actual draft risks and strengthened numeric drafting/review instructions. It returned one valid minimum-quantity plan per model and rejected both enhancement and policy attempts. Both accepted plans were checked against the decrement handler at `ProductDetailView.tsx:446`; their semantic claim and unnecessary-edit counts are zero. The 8B minimum plan also includes unrelated extra citations, recorded in its review notes.

The final iteration independently rejects failed scenario checks even when the review summary approves, routes those contradictions through the bounded redraft, permits more correction feedback within the measured prompt budget, and rejects assessment questions when every criterion is marked resolved. TypeScript and 36 deterministic tests pass. The configured 9B model was then retested on those three cases:

| Case | Final 9B result | Source review |
| --- | --- | --- |
| Quantity minimum | `already_implemented`, valid | Correct clamp-to-one observation; no edits. |
| Quantity step buttons | Rejected after one correction | Partial-step arithmetic is now correct, but scenarios still require disabled clicks; the decrease guard unnecessarily depends on known stock, and citations point to quantity layout rather than handlers. |
| Shipping policy | Rejected after one correction | The assessment omits questions and locks a gap; the draft then asks for the missing threshold, regions and conversion policy while inventing region/threshold examples. It should return `needs_context`. |

The final outcome score is 1/3 across all attempts. Both rejected cases reached live correction rather than losing their scenario findings to a structural retry. Original model verdicts and backend-added consistency findings remain in the reports. The question guard catches explicit unresolved assessment questions, but cannot ensure that the model recognizes business ambiguity or prevent it from postponing those questions until drafting. Linked risk findings also remain semantically fallible: some explanations describe a valid risk or confuse new proposed behavior with current source.

Separately, a manually authored quantity reference plan passes exact citation validation and ten independently specified arithmetic/guard checks. See [QUANTITY-REVIEW.md](QUANTITY-REVIEW.md). This is a review baseline, not a live-model success. No generated enhancement plan has passed source review, and external application and Playwright tests were not executed. These are development diagnostics rather than held-out reliability measurements or evidence of an overall accuracy improvement.

The initial report is `data/evals/2026-10-09T19-21-48-786Z.json`; the final report is `data/evals/2026-10-09T19-35-53-864Z.json`. Their timestamps use UTC; the runs occurred on October 10 in Asia/Calcutta. Source hashes remained valid. Source-bearing plans, reference artifacts and review notes remain under ignored `data/`. Stage 2 remains in progress, with citation relevance, disabled-control scenarios and missing-policy handling as the next priorities.

## Structural retrieval smoke on 2026-10-10

The first profiler/chunking increment records deterministic syntax facts and preserves bounded JS/TS/JSX/TSX nodes. Oversized components descend into smaller nodes; malformed/unsupported sources and oversized leaves use text chunks. Index version 3 forces old caches to rebuild. This run used the existing frozen source copies and a separate `data/structural-retrieval-index/`, preserving the historical index. TypeScript and 41 deterministic tests cover source coverage/ranges, handler/control boundaries, fallback behavior, cache migration, and GPU guards before/after inference.

Three known development requirements were measured in retrieval-only mode using `qwen3-embedding:0.6b`, the Qwen3 8B tokenizer, an 8192-token context and a 4680-token prompt budget. No planner inference occurred. The comparison below uses the Qwen3 8B retrieval entries from the full staged baseline; source fingerprints match. Both chunk boundaries and embedding fact labels changed, so this does not isolate their individual effects.

| Case | Previous selected file recall | New selected file recall | Previous gold-line coverage | New gold-line coverage | New prompt tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quantity minimum | 1.000 | 1.000 | 1.000 | 1.000 | 4654 |
| Quantity step buttons | 0.333 | 0.667 | 1.000 | 1.000 | 4663 |
| Shipping policy | 0.500 | 0.500 | 0.000 | 0.000 | 4616 |

The indexed quantity-control block spans lines 442-467, preserving both original button handlers and disabled guards in one chunk. All 168 recorded embedding placement checks reported positive, equal model/VRAM sizes; no case was hardware blocked. The first retrieval took 65.5 seconds including the fresh index build, followed by 23.0 and 27.3 seconds. These timings include placement checks and are not a steady-state generation-speed comparison.

The smoke passes budget/source/GPU checks, but shipping still lacks its expected evidence and quantity line coverage was already complete. These three known cases do not establish a broad accuracy improvement or a correct live enhancement plan. The next work is criterion-specific targeting, relevance/policy auditing and broader retrieval validation, followed by separate GPU-eligible planner runs.

The local report is `data/evals/2026-10-09T20-26-23-210Z.json` (UTC timestamp). It contains source-bearing excerpts and stays ignored. Placement telemetry is saved with the report; no external application or Playwright tests were executed.

## Criterion retrieval experiment on 2026-10-11

Whole-requirement selection and the criterion-selection prototype were each measured on all 19 development cases against the same frozen copies and version 3 structural index. Both used `qwen3-embedding:0.6b`, the Qwen3 8B tokenizer, an 8192-token context and a 4680-token prompt budget. This was retrieval-only evaluation; no planner inference or external application tests ran. Both reports retain the same gold cases, source fingerprints and settings. All 38 retrievals completed within budget, and all 76 pre/post embedding checks reported full GPU placement.

The prototype embeds the whole requirement and a separate query for each criterion in one batch, ranks criterion queries separately, gives each criterion an initial share of remaining prompt space, then rotates through criteria to use spare space. Complete chunks can be shared without duplication. Its initial ranked files and nominated ranges are retained for inspection.

| Measurement, all 19 cases | Whole requirement | Criterion prototype |
| --- | ---: | ---: |
| Mean selected gold-file recall | 0.671 | 0.526 |
| Mean selected gold-line coverage | 0.669 | 0.505 |
| Completed retrievals | 19/19 | 19/19 |

Gold-line coverage improved for two cases, regressed for five and stayed equal for twelve. Empty-search coverage rose from 0.145 to 0.250 and guest-checkout coverage from 0 to 0.520. Price sorting fell from 0.813 to zero; duplicate-cart and zero-quantity coverage each fell from one to zero. Quantity minimum fell from one to 0.353 and mobile-menu from 0.273 to zero. Quantity-step coverage stayed complete, while selected file recall fell from 0.667 to 0.333. Shipping evidence coverage remains zero under both strategies.

Source inspection confirms that price sorting selects `useProductSort.ts` while omitting `ProductListing.tsx`, whose inline `getSortedProducts` function implements the catalog behavior. The duplicate-cart case omits the storage helper entirely. These are concrete evidence-selection failures. Quantity-minimum still receives the decrement handler, so its lower coverage metric alone does not prove a wrong assessment. File and line metrics require source interpretation.

The final implementation exposes the prototype through `RAG_RETRIEVAL_STRATEGY=criterion`, while `requirement` remains the default. Configuration and run/evaluation metadata identify the strategy. TypeScript and 44 deterministic tests pass, including minority-criterion budget pressure, shared excerpts, distant handlers in the same file, and default single-query behavior. The comparison reports retain the pre-gate prototype code hashes; the final implementation adds the opt-in gate and caches unchanged prompt-token counts. Nominations do not prove claim relevance or resolve missing business policy.

After the gate and token-count cache were added, price sorting and duplicate-cart retrieval were repeated under both final strategies. All four retrievals passed budget, source-fingerprint and GPU checks. The default reproduced the baseline excerpts and token counts exactly (coverage 0.813 and 1.000); the opt-in strategy reproduced the prototype excerpts, criterion traces and token counts exactly (zero coverage for both). These smoke reports are `data/evals/2026-10-10T19-01-40-363Z.json` and `data/evals/2026-10-10T19-02-51-512Z.json`; exact comparisons are saved in ignored `data/criterion-gate-verification.json`.

The next work is auditing criterion relevance and policy ambiguity, investigating how filename scores and strict initial budget shares select short unrelated excerpts, and adding independently reviewed held-out cases before enabling the experiment. These development measurements do not establish plan correctness. Stage 2 remains in progress.

The whole-requirement report is `data/evals/2026-10-10T18-45-58-440Z.json`; the prototype report is `data/evals/2026-10-10T18-52-53-818Z.json`. Timestamps use UTC; these runs occurred on October 11 in Asia/Calcutta. Source-bearing range/fact comparisons are saved in ignored `data/criterion-retrieval-comparison.json`.

## Anchored selection and assessment audit on 2026-10-11

Selection version 2 protects useful whole-requirement excerpts before filling remaining space with criterion candidates, favors matching handlers/state/guards and referenced functions, and records syntactic calls/renders/event bindings. The planner now requires a private citation-support audit and criterion-owned source/policy questions. Policy-only uncertainty cannot request source, and unresolved draft questions are rejected. The audit is a model self-check with backend consistency validation; it is not independent semantic verification. Public plans retain schema version 2. TypeScript and 52 deterministic tests pass.

The control and revised strategy each retrieved all 19 development cases on the same frozen sources, structural index, embedding model, 8B tokenizer and 4,680-token budget. Their recorded runtime hashes, gold cases and source fingerprints match. Both include the new audit instructions in the measured initial prompt, so this is the appropriate control for the revised selector. All 38 retrievals completed within budget; all 76 pre/post embedding checks reported full GPU placement. No planner inference occurred in this comparison.

| Metric | Whole requirement | Anchored criterion selection |
| --- | ---: | ---: |
| Mean selected gold-line coverage | 0.669 | 0.669 |
| Mean selected file recall | 0.627 | 0.640 |
| Coverage improvements / regressions / equal | — | 0 / 0 / 19 |

The earlier prototype's coverage regressions are avoided, but there is no gold-line coverage improvement over this control. Empty search gains one expected file while retaining the same gold-line coverage. Price sorting retains the test excerpt at `price-sorting.spec.ts:6-69`, yet still supplies only `ProductListing.tsx:1-53` rather than its inline sorting function/caller at `207-219`. Duplicate-cart retrieval supplies `cartStorage.ts:1-53` and `CartContext.tsx:38-113`; quantity retains its original handler/guard block. Guest checkout and shipping still have zero initial gold-line coverage. These limits keep the experiment opt-in; neither retained lines nor source-use links establish correct model interpretation.

The new control is `data/evals/2026-10-10T19-39-14-180Z.json`, and the anchored run is `data/evals/2026-10-10T19-46-44-335Z.json`. Their source-bearing comparison remains ignored in `data/anchored-retrieval-comparison.json`. The earlier prototype reports are preserved separately. Selected file recall in the older control used different prompt instructions and is not an isolated comparison with this selector.

### Reserved validation

Four previously unused cases were recorded before this increment, source-reviewed by the implementing agent and kept separate from development cases. Independent gold review is pending; these are not an independent held-out accuracy estimate. The runtime was fixed before measuring them, and their failures were retained without tuning against them.

Whole-requirement retrieval-only and the initial retrieval metrics from an anchored live 8B run have mean gold-line coverage 0.915 in both, with file recall 0.750 and 0.875 respectively. Runtime hashes, gold cases and frozen sources match. No live entry expanded context, so the captured initial metrics remain separate from generation. Both runs record eight successful pre/post embedding placement checks; the live run also records 14 full GPU planner checks and no hardware blocks.

| Reserved case | Live result | Source review |
| --- | --- | --- |
| Currency service failure | `already_implemented` | Outcome matches supplied fallback; no edits. One audit explanation incorrectly says the cited active-guard line sets currency/rate. |
| Negative-price cart recovery | Rejected after repair | Initial response omits citation checks; repair keeps definition-only test citations while claiming implementation. Needed provider restoration/notice lines remain absent. |
| Positive stock shrink / unknown stock | Rejected after repair | Gold lines are supplied, but the model attributes clamping to a cart-opening line and an effect dependency line. Initial response also invents an unknown-stock gap. |
| Missing volume pricing policy | Rejected after repair | Model mistakes unspecified policy for implementation gaps, requests an invented path, then equates ordinary conversion with approved discount treatment. It fails to ask the required policy questions. |

Only 1/4 attempts matches the expected outcome. Rejection prevents these inconsistent assessments from producing drafts, but does not count as successful source interpretation or policy recognition. The accepted currency result also shows that a structurally consistent audit can overstate citation support. No external application/tests ran and no edits were applied. Reviews were performed by the implementing agent, not an independent reviewer.

The retrieval control is `data/evals/2026-10-10T19-53-45-531Z.json`; the live report is `data/evals/2026-10-10T19-55-10-261Z.json`. Source-review findings remain in ignored `data/anchored-reserved-review.json`; the accepted plan's manual-review fields retain the audit finding.

### Separate development planner check

With the same runtime and frozen sources, anchored Qwen3 8B was checked on price sorting, five-step quantity controls and shipping policy. Sorting returns `already_implemented` after repair, matching gold. Quantity and shipping are rejected after repair, so outcome agreement is 1/3 across attempts. All six embedding and twelve planner placement checks report full GPU placement; no hardware blocks occur. All six model calls are assessments: no entry reaches expansion, drafting or review.

Source review finds five distinct misleading/unsupported audit support claims in the accepted sorting response, including treating a parsed-price return as evidence of monotonic order and a price-mapping line as a count assertion. Its full test excerpt contains the relevant assertions, but the actual catalog function/caller remains omitted and tests were not executed. Quantity correctly identifies the additive gap but selects labels/markup rather than supplied handlers and marks its citations non-supporting. Shipping names missing policy in its initial summary while still declaring a gap with no business questions. The new consistency guard rejects those assessments; it does not produce a correct enhancement or a successful policy-question result.

The report is `data/evals/2026-10-10T19-59-25-243Z.json`; implementing-agent review remains in ignored `data/anchored-development-review.json` and the accepted plan's manual-review fields. The next gate is better claim-to-citation selection and independent source verification, followed by the planned deterministic quantity scenario contract. These measurements do not justify enabling criterion retrieval by default or proceeding to patch application.
