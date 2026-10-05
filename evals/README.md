# Local RAG evaluation

`requirements.json` contains three requirements drawn from the configured storefront and Playwright repositories. Gold files were chosen by reading the source and existing tests. Run `npm run eval` after `npm run index`; set `EVAL_MODELS=qwen3:8b,qwen3.5:9b` to compare both planners. Reports with full plans are written to ignored `data/evals/`.

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
