# Roadmap

The project currently delivers a local requirement-to-plan workflow. This roadmap lists outcomes in dependency order; it is not a release promise. A stage is complete only when its acceptance checks pass on both configured repositories.

| Stage | Status | Outcome and acceptance checks |
| --- | --- | --- |
| 1. Local planning foundation | Done | Validate requirements, read both repos, retrieve line-numbered chunks, count model tokens, call local Ollama, validate paths, save runs, and evaluate retrieval on real requirements. |
| 2. Evidence quality | Next | Expand the evaluation set beyond three known cases, include already-implemented requirements, and score factual claims against cited source lines. Reject or flag plans that propose unsupported edits. Track recall, plan quality, latency, and GPU use after each ranking change. |
| 3. Git provenance and proposed diffs | Planned | Record both repository commit IDs and dirty state in every run. Produce a reviewable patch tied to those commits. A plan may recommend new files, but applying a patch requires explicit review. |
| 4. Isolated application and checks | Planned | Apply an approved patch in separate branches or worktrees. Select impacted Playwright tests from the diff, run project checks, and attach logs and exit codes to the run. Never execute free-form model commands. |
| 5. Dashboard workflow | Planned | Show requirement, selected evidence with line numbers, plan, proposed diff, review decision, and check results. Use an authenticated backend proxy before access outside the local machine. |
| 6. Wider operation | Later | Add job isolation, auth and authorization, retention rules for source-bearing artifacts, structured logs, failure recovery, and a storage/index design for larger repositories. |

## Near-term tasks

1. Add at least ten new evaluation cases from different areas of the website and test framework. Include negative examples where existing code already satisfies the requirement. Define expected source lines as well as files.
2. Add an evidence check to plans: each proposed change should point to a retrieved line range and explain the observed gap. Treat claims about unobserved code as questions.
3. Capture repository commit IDs before retrieval and report when files change during planning. Use those IDs when generating a patch.
4. Build the diff preview and review step before any write to either external repository.
5. Connect test selection and execution only after patch review and isolation are working.

The first priority is **plan correctness**, because the current evaluation reached full gold-file retrieval on three cases while both local models still suggested unnecessary work. See [evals/README.md](evals/README.md) for the measured limits.
