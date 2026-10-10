# Reviewing plan correctness

Run `npm run eval:check` before evaluation. Gold file fingerprints must match the inspected source state. A fingerprint records the review point; refreshing it does not automatically make an expected outcome correct.

The current 19-case corpus has 12 source-backed existing behaviors, five gaps (four constructed enhancements and one stock-guard defect), and two deliberately underspecified policy requests. The stock case's old implemented label was corrected on 2026-10-08 after reviewing the unknown selected-size stock state. Historical reports retain their old labels. Constructed enhancements are evaluation inputs, not business backlog commitments. New reports retain `goldCases` as well as source hashes so later label changes cannot silently alter their interpretation.

The report provides automatic outcome agreement, criterion-status accuracy, false gap/implementation counts, unexpected change paths, and unnecessary edits on cases known to be implemented or policy-ambiguous. Unknown assessments are recorded as abstentions. File overlap and scenario keywords are not correctness scores. A valid citation only proves that its quote appears in supplied code.

For each generated plan, compare the summary, assessment observations, gap explanations, steps and test scenario expectations with the exact source in `context.files` and the gold line ranges. Count independently checkable assertions that are false or unsupported. Repetitions of the same claim count once. Pay particular attention to inferred hook calls, claims that an existing feature is missing, and claims about source omitted from the prompt.

Fill the report's `plan.correctness.manualReview` fields:

- `unsupportedSemanticClaims`: number of distinct false or unsupported source claims.
- `unnecessaryEdits`: number of change entries with no justified gap, including unrelated files and no-op edits.
- `reviewer`: the reviewer's chosen identifier.
- `notes`: short explanations referencing paths and lines. Keep reports local because they contain source excerpts.

Leave a field `null` until it has been reviewed. A correct `needs_context` answer can be safer than a guessed edit; check whether the uncertainty is legitimate or merely caused by poor retrieval. For fully implemented cases, a successful answer should cite existing behavior and propose no changes. For missing enhancements, it should identify the current conflicting behavior without treating an unseen excerpt as proof of absence. For ambiguous policies, it should ask for the missing business decision.

For staged runs, inspect `plan.ollama` or the failed entry's `ollama` diagnostics. `assessment`, `draft`, and `review` show validated stage responses; `stages` records per-call token estimates and Ollama counts. New reviews must trace every draft scenario's execution and result. `reviewAttempts` retains both initial and corrected drafts/reviews when consistency correction occurs; `consistencyFailures` accumulates findings even if the final plan passes. Do not copy the model's verdict into `manualReview`: it can approve a bad draft or reject a good one. Inspect false abstentions and redundant context requests alongside accepted changes; `redundantContextRequests` records requests discarded because resolved criteria already have the requested source. New `rejectedResponses` retains structurally rejected content capped at 12,000 characters per attempt; check its `truncated` flag before reviewing it. Content may contain source and remains in ignored local reports. Historical runs did not retain this content, and historical reviews lack scenario traces.

Use the findings to decide what to improve next. Passing structural tests does not establish model reliability, and the initial three-case retrieval result is not a general quality guarantee.

Assessment diagnostics now include a private audit for each criterion. Inspect each evidence check's explanation against the actual fragment and observation. `direct` and `supportsObservation=true` are model assertions; backend validation checks their consistency, not their truth. A helper definition may establish its arithmetic, but a UI integration claim also needs the actual caller. Experimental `sourceLinks` identify syntactic calls/renders/event references, not runtime reachability. Check missing source facts separately from missing business decisions. Every unknown criterion must own a question, policy-only uncertainty cannot request source, and unresolved draft questions are rejected. A model can still mislabel an uncertainty or confidently approve irrelevant evidence.

Four previously unused inputs are recorded in [RESERVED-REVIEW.md](RESERVED-REVIEW.md). They were source-reviewed by the implementing agent before this increment and must not be used to tune it. Independent gold review is pending; their results are separate from the development corpus and are not an independent held-out accuracy estimate.

For bounded numeric enhancements, independently calculate the raw action result and then apply the required bounds. Check ordinary changes, partial steps near a bound, controls at a bound, and zero versus unknown limits. A disabled-control assertion can be valid; a test requiring a click on that disabled control cannot. Do not accept a review observation that merely repeats the proposed expectation without calculating it.

Use [QUANTITY-REVIEW.md](QUANTITY-REVIEW.md) for the source-backed five-step quantity boundary checklist and its concrete expected values.

The backend now treats failed scenario checks and contradictory step/test summary flags as consistency findings. They trigger the bounded correction workflow instead of a structural retry; a summary flag cannot override a failed scenario. Original model flags remain in `reviewAttempts`, while the added rejection reasons appear in `consistencyFailures`. An assessment that asks unresolved questions while marking every criterion resolved is structurally invalid and cannot enter drafting.

New risk reviews use `riskIssues: [{ risk, issue }]`. The `risk` must exactly name a statement in the draft's `risks`, and each risk can have at most one finding. Empty draft risks require empty risk findings. The backend enforces this relationship, so an all-clear message cannot invent a risk when the draft has none. A linked finding still needs semantic inspection: naming a real risk does not prove that the criticism is correct. Historical reports retain their older string-array format.
