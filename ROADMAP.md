# Roadmap

The project currently delivers a local requirement-to-plan workflow. This roadmap lists outcomes in dependency order; it is not a release promise. A stage is complete only when its acceptance checks pass on both configured repositories.

| Stage | Status | Outcome and acceptance checks |
| --- | --- | --- |
| 1. Local planning foundation | Done | Validate requirements, read both repos, retrieve line-numbered chunks, count model tokens, call local Ollama, validate paths, save runs, and evaluate retrieval on real requirements. |
| 2. Evidence quality | In progress | Backend evidence IDs supply exact quotes. Assessment precedes drafting; gaps stay fixed, review checks each scenario, and one reviewed correction is allowed. Follow-ups retain cited and previously requested evidence, with bounded handling of redundant requests. Nineteen source-fingerprinted cases are implemented. Establish reliability on held-out cases with independent source review before patch generation. |
| 3. Git provenance and proposed diffs | Planned | Record both repository commit IDs and dirty state in every run. Produce a reviewable patch tied to those commits. A plan may recommend new files, but applying a patch requires explicit review. |
| 4. Isolated application and checks | Planned | Apply an approved patch in separate branches or worktrees. Select impacted Playwright tests from the diff, run project checks, and attach logs and exit codes to the run. Never execute free-form model commands. |
| 5. Dashboard workflow | Planned | Show requirement, selected evidence with line numbers, plan, proposed diff, review decision, and check results. Use an authenticated backend proxy before access outside the local machine. |
| 6. Wider operation | Later | Add job isolation, auth and authorization, retention rules for source-bearing artifacts, structured logs, failure recovery, and a storage/index design for larger repositories. |

## Near-term tasks

1. Obtain a live missing-feature plan that matches a source-reviewed reference. A manually authored quantity reference now passes exact citation validation and ten independent boundary/guard checks; see [evals/QUANTITY-REVIEW.md](evals/QUANTITY-REVIEW.md). The latest live quantity draft improves its clamped arithmetic but still requests clicks on disabled controls and chooses layout evidence instead of handlers. The reference is not a live-model success. Check concrete starting state, enabled controls, action, and result independently of the model verdict.
2. Require relevant evidence for each claim, improve context targeting, and distinguish missing business decisions from implementation gaps. Assessment questions now prevent fully resolved criteria from entering drafting, but the model can defer missing policy questions until the draft. Risk findings now reference actual draft risks; their explanations must still identify false or unsupported statements rather than restating valid risks. Measure these changes on held-out requirements before tuning further.
3. Capture repository commit IDs before retrieval and report when files change during planning. Use those IDs when generating a patch.
4. Build the diff preview and review step before any write to either external repository.
5. Connect test selection and execution only after patch review and isolation are working.

The first priority is **plan correctness**. The latest full comparison produced 11 valid plans and eight rejected cases per model, with 10/19 matching expected outcomes. Qwen3.5 9B matched more existing behaviors; Qwen3 8B returned the only accepted change plan, but manual review rejected its boundary expectations. The 2026-10-10 final 9B development smoke run returned one valid implemented plan and rejected the enhancement and ambiguous policy cases. Neither model has produced a verified correct change plan. Stage 2 remains in progress. See [evals/README.md](evals/README.md) for measurements and review limits.
