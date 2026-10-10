# Reserved validation cases

These four requirements were authored from the existing frozen source before the anchored-selection and assessment-audit implementation. They are kept separate from the 19 development cases. Do not use their results to tune this increment; run them after the implementation is fixed and retain failures.

The expected behavior was read from the frozen copies at `data/eval-snapshots/2026-10-06T18-55-48-735Z`. The existing checked-in source fingerprint already covers the required files. Source excerpts remain in ignored reports.

- Currency failure: `CurrencyContext.tsx:53-59` checks the active flag before restoring INR and rate one. The requirement applies to an active provider, not a discarded mount.
- Invalid cart row: `cartStorage.ts:24-33` skips invalid negative prices and marks recovery; `45-47` retains other valid rows. `CartContext.tsx:52-54` calls restoration and exposes the recovery notice. Other required row fields must be valid in any executable setup.
- Stock shrink: `ProductDetailView.tsx:148-152` clamps quantity only for a non-null positive stock amount. `min(8,3)=3`; unknown stock does not enter the effect body. This requirement does not claim that the separate zero-stock guard is correct.
- Volume pricing: eligibility, discount amount and currency treatment are explicitly missing business decisions. Existing totals and conversion code provide background, not those decisions. The expected result is questions with no proposed edits.

These are previously unused, source-reviewed validation inputs. The same implementing agent authored them; an independent reviewer has not approved their gold labels. They are not an independent held-out accuracy estimate, and the external application/tests have not been executed.

Set `EVAL_CASES_FILE=./evals/reserved-requirements.json` for this suite. Clear it to return to the 19 development cases. Use the same frozen roots and structural index for comparisons.
