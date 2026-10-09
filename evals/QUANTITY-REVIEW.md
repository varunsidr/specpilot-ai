# Quantity-step plan review

This checklist concerns the constructed `quantity-step-buttons` evaluation requirement. It is a review reference, not an approved change to the storefront.

The inspected source snapshot is `data/eval-snapshots/2026-10-06T18-55-48-735Z`. `ProductDetailView.tsx:443-464` contains the complete quantity-control block: a single-step decrease clamped to one, a displayed quantity, and a single-step increase disabled at known stock or when the selected stock is out. There are no five-step controls in that block. `115-123` distinguishes unknown selected-size stock from known zero and whole-product stock. The supplied Playwright test checks the existing 1 → 2 → 1 behavior; it does not cover five-step controls.

For the enhancement, plus-five must calculate `min(quantity + 5, stock)` for a positive known stock, and `quantity + 5` when stock is unknown and the product is otherwise eligible. The control stays enabled before the stock limit, including when fewer than five units remain. Known zero stock disables increasing and leaves quantity unchanged; it must not clamp quantity to zero. Minus-five must calculate `max(1, quantity - 5)`. A proposal may disable decrease at one or keep it enabled with a clamped result, provided its scenarios agree with that choice.

| Starting quantity | Available stock | Action/check | Required result |
| --- | --- | --- | --- |
| 3 | 10 | Click enabled plus-five | 8 |
| 8 | 10 | Click enabled plus-five | 10 |
| 10 | 10 | Assert plus-five disabled | Quantity stays 10 |
| 1 | 0 | Assert plus-five disabled | Quantity stays 1 |
| 3 | Unknown (`null`) | Click plus-five on an otherwise eligible product | 8 |
| 8 | 10 | Click enabled minus-five | 3 |
| 5 | 10 | Click enabled minus-five | 1 |
| 2 | 10 | Click enabled minus-five | 1 |
| 1 | 10 | Check the proposed decrease guard/clamp | Quantity stays 1 |

Check that the plan names concrete handlers, bounds, guards, selectors and controlled test setup. A test must use a product or fixture with the specified stock; arbitrary live product data does not establish that starting state. Tests of a disabled button assert its disabled state rather than trying to click it. Unknown stock does not establish that the whole product is in stock, and quantity controls do not establish that add-to-cart is enabled.

Inspect every cited claim and risk against the supplied excerpts. Cite the control block to establish the additive gap, the handlers to describe existing behavior, and stock derivation for null/zero claims. An isolated label does not establish the handler or guard. No inferred server inventory mutation is justified by local `setQuantity` updates.

Reject raw expectations of 13 from quantity 8/stock 10 or zero from quantity 5/minimum one, even if the model review approves them. Passing this checklist on one development case does not establish held-out reliability or authorize patch application.

The local reference artifact is `data/evals/quantity-step-buttons-source-reviewed-reference.json`. It contains a manually authored public-schema plan, exact source excerpts and hash, and ten passing reference arithmetic/guard checks. It uses functional state updates and disables the new increase control for whole-product unavailability as well as selected-stock limits. The source-bearing artifact stays ignored. It is a static source review reference, not a generated plan accepted by the live model, and no external application or Playwright tests were executed.
