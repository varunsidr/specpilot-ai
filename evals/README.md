# Local RAG evaluation

`requirements.json` contains 19 cases: 12 existing behaviors, five gaps (four constructed enhancements and one stock-guard defect), and two ambiguous policy requests. Gold files, outcomes, and evidence ranges were chosen by reading the configured storefront and Playwright source. `source-snapshot.json` records their hashes; run `npm run eval:check` before evaluation. See [REVIEW.md](REVIEW.md) for semantic review instructions. Reports containing source excerpts and full plans are written to ignored `data/evals/`.

### Stock gold correction on 2026-10-08

The earlier corpus labeled `quantity-stock` as fully implemented. Source inspection found a counterexample: a sized product starts with no selected size (`ProductDetailView.tsx:51`), so its available stock is unknown (`115-120`). All sizes can be out of stock (`121-123`) while the increase button's guard (`456`) still permits clicks. The expected outcome is now `changes_needed`, with a gap assessment and the component as an allowed change file. Historical reports below retain their original labels and category counts; their outcome scores are not directly comparable with this corrected corpus. New reports retain the full `goldCases` alongside the source hashes.

Run `npm run eval` after `npm run index`; set `EVAL_MODELS=qwen3:8b,qwen3.5:9b` to compare both planners. `npm run eval:summary` summarizes the latest report, including failures. The three-case results below are historical and use the older plan format.

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
