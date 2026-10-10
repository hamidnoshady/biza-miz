# #825 — visual and accessibility follow-up (2026-10-10)

Continues PR #881 on `arena/f1cf4030-biza-miz`; no new PR, merge to main or deployment.
The previously verified functional implementation is retained. See
[the functional source/evidence map](issue-825-verification.md).

## Starting state and main integration

- Previous pushed head: `25424d5dd06a0c29c5b8b213cc03946023a4b3f5`.
- Fetched main: `7b1b11c54f9ccb19a82fba69b590d10b10da31ba`; branch was four
  commits behind, seven ahead. Merged main without conflicts, preserving the
  shared capability configuration and canonical subledger services.
- Previous PR test run [37972257814](https://github.com/hamidnoshady/biza-miz/actions/runs/37972257814):
  all individual checks except visual passed; receivables 0.98%, expenses 4.06%.
- Latest main test run [37925908136](https://github.com/hamidnoshady/biza-miz/actions/runs/37925908136)
  has the same expenses **4.06%** annotation (visual job `113804662696`). The
  later main commit is a desktop version bump. Main's `ac48d7fa` (#832) explicitly
  documents its register redesign and pending visual baseline review.
- `gh run download 37972257814 --name visual-diffs` was retried into a fresh
  directory. The Azure Blob redirect still fails with EOF under the sandbox's
  network allowlist. **The original CI actual/diff files were not inspected.**

## Images actually inspected and classification

Regenerated with the repository harness, matching Chromium **141**, viewport
**1440×900**, DPR 1, `fa-IR`, `Asia/Tehran`, reduced motion and seeded app-role data.
Because the production build is resource-blocked below, these are development
captures; they are not substituted for exact-head production CI verification.
The committed expected images, local actuals and red-pixel diffs were opened.

| Receivables change | Decision and evidence |
|---|---|
| Four reconciliation cards above the table | Intended by #825 §6: positive claims, credits, net and control, including the match hint. |
| Search field and `۲ از ۲ مشتری` count | Intended by §5: server-backed search and a window count. |
| Table moves down approximately 194 px | The expected consequence of those two added regions, not an RTL/spacing regression. The two names, amounts and column order remain. |
| Load-more button | Not present in the two-row baseline fixture. Separately tested with a one-row window against the real API, including keyboard activation and server continuation. |
| Settle actions | Both remain visible for the seeded owner; hidden-settle behavior for read-only members is separately unit/API tested. Hidden actions did not cause this owner screenshot mismatch. |
| Muted text contrast | A real defect, corrected in the shared light token, not accepted as a visual regression: axe measured 4.48:1 on the warm canvas before the correction. |

The healthy local receivables comparison measured **0.75%** before recording.
Only `accounting-receivables.png` was selected for its update.

| Expenses change | Decision and evidence |
|---|---|
| Receipt/VAT area and form framing | The inherited #832 form, including input VAT and receipt handling. Not rewritten by this follow-up. |
| Payment-account and status filters | Intentional #832 register filters, alongside date/category/search. |
| Reference, receipt, status and detail-action columns | Intentional register redesign, with stable detail navigation and visible status. |
| Two totals in the footer | Net expense versus money paid, explicitly distinguished by #832. |
| Fixture data | The same three expenses, counterparties and amounts remain; total is 26,150,000 Toman. |

`expense-section.tsx`, `expense-detail-panel.tsx` and `expense-shared.ts` match
main byte-for-byte after the merge. This follow-up's shared muted-text correction
slightly affects their caption color, but the **4.06% layout failure predates it**.
The healthy local expense comparison measured **3.68%**; that number is not the
CI 4.06%. These visible differences are the documented redesign, so its baseline
was selected for review/update under the user's conditional authorization, not
rolled back or rewritten. An initial development connection banner was rejected;
the harness now waits for it to disappear and fails if the fixture stays offline.
It never hides that banner with CSS.

Commands used, separately after inspecting each diff:

```sh
npm run test:visual -- --screens=accounting-receivables
npm run test:visual:update -- --screens=accounting-receivables
npm run test:visual -- --screens=accounting-expenses
npm run test:visual:update -- --screens=accounting-expenses
```

Both focused comparisons passed after recording. The local `--screens` option
prevents unrelated recording; it is rejected in CI and the default CI suite is
still complete. No tolerance or pixel assertion changed. Only these two PNGs
belong in the baseline-only commit. Production CI must validate them before the
visual gates are called resolved.

## Modal and accessibility corrections

- `ledger-ui.tsx` composes Radix FocusScope/Portal: initial focus, Tab and
  Shift+Tab containment, focus restoration, no ancestor clipping, and hidden
  inactive content for assistive technology. `use-overlay-escape.tsx` consumes
  Escape only for the top ledger panel; a busy panel also protects its parent.
- `subledger-section.tsx` renders a **single** journal-entry overlay for both
  responsive layouts, including loading/error/close controls. Previously the
  desktop and mobile details both mounted. Stable source IDs and API guards are
  unchanged. Escape closes the entry first, returning to its drill-down trigger;
  the next Escape closes the statement, returning to the customer trigger.
- `ledger-ui.test.tsx` tests forward/backward cycling, programmatic focus escape,
  restoration, nested dismissal, busy nesting, no-control loading and prevented
  Escape. `subledger-section.test.tsx` tests the real statement/entry path for both
  sides and both layouts, including one mounted entry request and restoration.
- Light `--muted-foreground` changes from OKLCH 0.556 to 0.54, giving small muted
  text enough contrast on the warm canvas/muted surfaces. Dark tokens stay intact.
- `layout.tsx` narrowly acknowledges the browser's nonce-attribute hiding on its
  existing inline script. CSP nonce generation/policy and the actual `script.nonce`
  remain unchanged; unit/browser assertions check that preservation. This removes
  a misleading development hydration error badge, not real application errors.
- The Next development status badge is disabled; production presentation is
  unaffected. No application content or loading/error state is masked.

`npm run test:a11y:subledger` passed in **light/dark × 1440/390**, using the real
API with `limit=1` to expose load-more. It checks labels/axe WCAG A/AA, RTL, theme,
page overflow, keyboard search/paging/drill-down, focus trapping/restoration,
nonce preservation and uncaught/hydration errors. CI's visual job now also runs it.

There were **zero axe violations** on search/summary/paging, statement and entry.
Axe marked some mobile entry-cell contrast as indeterminate due to overlapping
background geometry. Those were not waived: screenshots were inspected, and the
browser test independently requires unobscured text, an opaque unfiltered
background, and measured WCAG contrast ≥4.5:1. Measured light ratios were
**5.07:1 / 19.80:1**, dark **6.94:1 / 17.18:1**. Unsupported compositing fails.
The raw axe indeterminate results remain logged alongside these measurements.
This is focused accessibility evidence, not whole-application WCAG certification.

## Production-build attempt

Ran `npm run build` with Node **24.21.0**, `NODE_OPTIONS=--max-old-space-size=8192`,
one Rayon thread and `MALLOC_ARENA_MAX=2`, without competing test/browser processes.
The sandbox has **3.8 GiB physical RAM and no swap**. Exact result:

```text
▲ Next.js 15.5.25
Creating an optimized production build ...
Killed
BUILD_EXIT=137
```

An 8 GiB heap limit cannot add physical RAM. The local production build did not
pass. No claim of a successful local production build or deployed verification
is made; the independent exact-head CI build remains required.

## Verification record

Full local checklist, Node 24, run serially without competing browser servers on
2026-10-10 (completed 10:10 UTC):

| Command | Result |
|---|---|
| `npx tsc --noEmit` | PASS, exit 0 |
| `npm run lint` | PASS, zero warnings, exit 0 |
| `npm test` | PASS: 707 files / 9,233 tests, 342.09 s |
| `npm run test:db` | PASS: 198 files / 2,738 tests; 1 pre-existing conditional skip, 2,216.61 s |
| `npm run test:design` | PASS: 5 files / 38 tests, 2.65 s |
| Focused visual comparisons | PASS: receivables 1/1 and expenses 1/1 after separate reviewed updates |
| `npm run test:a11y:subledger` | PASS: four contexts, twelve scans with zero actual axe violations; supplementary contrast as above |
| `npm run build` with 8 GiB heap | BLOCKED locally: exit 137, `Killed`, physical memory limitation as above |

The single DB skip is the existing `ai-gateway.integration.test.ts` RLS case,
conditional on the owner connection's `rlsEffective()`. The subledger hardening
suite separately uses a real non-bypass-RLS role and all 16 tests passed;
AR 34/34 and AP 26/26 passed too. No skip was added or assertion weakened.
Final checklist exit codes: `type=0 lint=0 unit=0 db=0 design=0`.

Exact final SHA, workflow links/results and latest-main mergeability are recorded
in the PR's final verification comment, so a prior head's results are never
called current. Local success alone does not resolve the production CI gates.

### Issue-item source/test map

| Issue item | Implementation | Proof retained/added |
|---|---|---|
| 1. Permission-derived actions | accounting-manager → ar/ap-section → subledger-section; receipts/payments route guards | subledger-capability.test.ts; subledger-section.test.tsx; receivables-hardening.integration.test.ts |
| 2. Valid customer party | ar-service.receivePayment, same-business active/unmerged Customer role | ar.integration.test.ts and hardening: supplier/employee-only, inactive, merged, foreign, valid and multi-role |
| 3. Real calendar dates | iso-date.ts shared by services/receipts/aging routes; businessToday defaults | iso-date.test.ts; ar/ap integration and hardening leap/impossible-date cases |
| 4. SQL scalability | ar/ap-attribution.ts, ar/ap-service.ts, migration 0216; filtered named source access | hardening 50,004-party API/RLS EXPLAIN assertions; subledger-sql-shape and source-contract tests |
| 5. Search/paging/count | subledger-pagination.ts; independent filtered CTE count; server nextOffset; shared UI ownership | pagination units; hardening empty/out-of-range/>50k/stable-order/unknown/search cases; deferred UI completion tests |
| 6. Reconciliation | server AR/AP summaries, shared BalanceSummary | ar/ap integration reconciliation, summary invariance across windows; UI summary tests |
| 7. Source drill-down | canonical source metadata, entries/[id] route, one statement-entry overlay | AR/AP/cheque/amendment tests; both-layout UI drill-down and focus tests; browser keyboard/WCAG script |
| 8. Loading/error/empty/retry | shared replacement/append ownership; statement/entry error handling | deferred stale/search/refresh/page tests; retained-row and retry cases; modal loading/busy tests |
| 9. Architecture preserved | journal source of truth, one parties model, canonical attribution, unknown/credit behavior, local business dates, one shared AR/AP UI | attribution/aging/architecture tests; ar/ap/cheque integration; business-day tests; no shadow-table migration |
| 10. Focused tests and presentation | preceding suites; shared design primitives; both money units/Jalali/RTL | subledger component tests; full local checklist below; visual and accessibility CI on final head |
