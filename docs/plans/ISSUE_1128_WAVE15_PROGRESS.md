# #1128 §D — wave 15 work in progress

## Foundation merged in #1281

- Additive migration `0287_agency_vendor_settlements.sql`: payment documents and
  cost-to-payment links; posted substance freeze; tenant/reference checks;
  reversal-stamp immutability; existing cost/recharge guards restated.
- Posting rules for debit 2140 / credit 1100 or 1120, and the reverse direction.
- `settleAgencyVendorCosts`: validates payees and methods, locks selected costs in
  stable order inside the posting transaction, posts through the domain-event
  engine, and links costs atomically. Queued/unposted entries roll back the act.
- Register reads expose payment linkage and derived paid state. No stored paid flag.
- Numbering, Persian source labels, exhaustive guard statuses, and tests.

## Verification

- Fresh database: 474 migrations applied, none deferred.
- Vendor settlement integration suite: 8 passing tests, including concurrent
  duplicate payments, ledger tie-out, cross-tenant cost/location refusal, and
  posted reference immutability.
- Focused pure/guard tests: 39 passing.
- Scratch SQL guard harness: 43 passing (including prior cost/recharge rules).
- Narrow TypeScript check: no new errors; existing Holoo/mssql and CSS-module
  resolution noise excluded from that assessment. Changed-file ESLint passes.
- Full suite and CI not run for this slice yet.

## Next work / limitations

1. Implement and test the reversal service using the original posted entry as the
   authoritative reversal basis. The reversal posting rule alone is not a usable
   reversal workflow. Check accounting reversal linkage and fiscal-period policy.
2. Add guarded API operations and UI controls. Payments require the canonical
   payable-payment permission, not just expense-management permission. Update MCP
   documentation/coverage and boundary tests when routes exist.
3. Add failure/rollback and reversal integration coverage, then full regression/CI.
4. Implement quote → approved purchase → payable using canonical vendor identity.
   This slice deliberately retains exact, nonblank vendor-name matching; it does
   not claim supplier-level attribution or a complete procurement chain.

The existing AP service resolves account 2100; agency costs credit 2140. Extending
that service versus a trade-specific document remains an architecture choice to
review before public endpoints. Do not claim the platform supplier directory is
inherently unusable for agencies merely because existing stock-oriented purchase
routes are unsuitable. No fifth app or replacement project/CRM engine is intended.

The SQL guard does not prove that linked costs sum to the document amount; the
service owns that invariant. Do not expose arbitrary link updates as a public API.

## Follow-up: payment and reversal member workflow

Implemented after the foundation merged in #1281:

- `POST /api/agency/reimbursable-costs/settle` and
  `POST /api/agency/vendor-settlements/[id]/reverse`, both requiring
  `finance.payables_manage`. Writes remain agency-only in the service. Payment
  location is resolved from the active session; services verify branch access.
- Reversal records a domain event and uses `postExactMirrorEntry` rather than a
  mapping-based reversal rule. The shared mirror accepts an optional project ID
  so the reversal preserves the original entry's project as well as its account,
  exact amounts, line dimensions and party attribution. Original and reversing
  entries are linked. Payment and original entry are locked; only one concurrent
  reversal succeeds.
- A non-posting reversal or a fiscal-period refusal rolls the entire transaction
  back, including its event and original-entry reversal stamp. Costs are not
  freed merely because a reversal was requested.
- The cost register exposes separate payable-manager controls. Expense/invoice
  authority alone does not show them. The initial UI pays one cost at a time;
  reversal explicitly confirms the **whole payment**, including costs outside the
  loaded page. It is not a partial-payment UI or a global payment register.
- MCP coverage is regenerated; no automatic money-moving tools were added.

Focused tests cover original-line mirrors, project/reversal linkage, balance
restoration, re-payment, concurrency, foreign-tenant refusal and locked-period
rollback, plus UI selection, request bodies and whole-payment confirmation.

Still owed: quote → approved purchase → payable with canonical vendor identity,
resource/time capture, campaign attribution/reporting, and the other open #1128
items. This follow-up must not be described as completing §D or #1128.

Follow-up verification in this session:

- Vendor settlement integration: **12/12**, including locked-period rollback.
- Focused UI/guard/MCP tests: **46/46**.
- Route/navigation/design boundaries: **81/81**.
- Changed-file ESLint and `git diff --check`: pass.
- Narrow TypeScript check: only the two pre-existing Holoo `mssql` declaration /
  untyped-generic errors; no errors in the changed files.
- Full unit suite launched separately; result pending at the time of this entry.


## Canonical vendor identity follow-up (decision 80)

Migration 0288 adds optional supplier-party links to costs and payments, with no
backfill and no name-based inference. Cost creation snapshots the selected party's
name and carries its ID through the domain event to the payable journal leg.
Payments group linked costs by ID; text-only legacy costs retain exact-name matching
and cannot mix with linked costs. The payment inherits the selected vendor ID.

The cost form uses the existing Supplier directory and exposes its picker only with
`parties.view`; POST/PATCH also require directory-read authority when assigning a
vendor ID. Existing expense/payable/ledger permissions remain independently required.
Both references participate in audited party merges. Historical names and amounts
are unchanged; new payments refuse inactive or merged-away vendors.

Verification: vendor-settlement integration 20/20; live party-reference coverage
6/6; focused UI/guard/MCP/route/design tests 124/124. Changed-file lint passes. The
narrow TypeScript check still reports only the existing two Holoo/mssql errors.
Full regression completed with 1,450 files passing, one skipped, and one
failure: the new supplier picker did not explicitly render a loading skeleton.
Added a reserved LoadingSkeleton region; loading coverage plus the picker,
register, guard and MCP tests then passed 62/62. The complete suite has not been
rerun after that correction; CI review remains required.

Remaining next step: quote → approved purchase → payable documents using this
identity. Supplier-only merging remains outside the existing customer-merge endpoint.
No procurement documents, automatic tools or fifth app are claimed by this slice.
