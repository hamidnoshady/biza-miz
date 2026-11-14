# Issue #1128 — posted campaign expense allocation preview

2026-10-26. Incremental backend foundation, **not** completed campaign accounting
or campaign profitability. The epic and the remaining-work queue stay open.

## Delivered scope

`POST /api/agency/projects/[id]/campaign-allocation-preview`

```json
{
  "sourceLineId": "123",
  "targets": [{ "campaignId": "aaaaaaaa-0000-0000-0000-000000000001", "basisPoints": 2500 }]
}
```

This calculates a proposal from one existing **posted expense debit**. It does
not create or modify a journal, draft, dimension, campaign, audit record or saved
allocation. Every success returns `previewOnly: true`; it is not approval, a
reservation of the source, or a promise that a later posting will be eligible.

- Intersection of live `ledger.approve`, `ledger.view`, `crm.view` and
  `workspace.manage`, the existing Workspace projects activation guard, agency
  industry, and canonical project `manage` capability. Platform permission alone
  does not authorize a project. No new AI/MCP allocation capability is exposed.
- Source ID is canonical positive bigint **text**, never a JS number. Submitted
  amount/source-entry metadata is ignored: the amount comes from journal_lines.
- One scoped SQL statement observes source and campaign eligibility. Source
  entry, account, project and project client must belong to the tenant. Campaigns
  must belong to the same tenant, project **and** client as the source project.
- Missing/foreign/ineligible source → generic `allocation_source_not_found` (404).
  Missing/foreign/wrong-client/wrong-project campaign → generic
  `allocation_campaign_not_found` (404), without source figures in the error.
- Original reversed entries and reversal entries are ineligible. Asset account
  1270/pass-through, revenue, payable credit legs and projectless entries cannot
  be presented as campaign expense. No reported spend, time, reservation or
  approved-but-unbooked procurement amount is accepted as a posted source.
- Explicit integer basis points, positive per campaign and at most 10,000 total,
  up to 100 distinct canonical UUIDs. Incomplete allocation stays unassigned;
  it is never silently normalized to 100%.
- Existing BigInt largest-remainder allocator is reused. Exact storage-safe rial
  in, JSON-safe integer text out. Ties use canonical campaign UUID order before
  the unassigned bucket; request order or UUID casing cannot move residual rial.
  Policy is versioned `campaign-basis-points-v1`.

## Still required before campaign P&L can be delivered

1. Approval-controlled immutable allocation persistence, source-line provenance,
   retry identities, concurrency/over-allocation protection and audit actor facts.
2. Additive integration with canonical line dimensions and existing posting flows;
   do not hijack configurable detail dimensions or reclassify history in bulk.
3. Original exact allocation mirrors on reversals, including archived campaigns;
   never recompute historical allocations from changed weights/policy.
4. Campaign revenue attribution and ledger tie-outs with visible unassigned
   amounts and completeness. A partial attributed cost is not a full margin.
5. Permission-scoped UI, fresh-install/upgrade and RTL/browser/rollout acceptance.

No migration or backfill is required for this read-only preview. It deliberately
makes no accounting or cost-allocation decision on behalf of a user.

## Verification

Actual checks for this slice:

- Full unit suite: 1,535 files passed, 1 skipped; **18,811 tests passed,
  8 skipped** (691.42 seconds).
- Final focused allocation/API/service/MCP registry run: **76 tests passed**.
- Real PostgreSQL integration: **22 tests passed** across allocation preview
  (8) and existing whole-project P&L (14), 181.79 seconds. The shell stopped
  waiting at 180 seconds; the completed log confirms exit with all tests passing.
- Targeted TypeScript check including changed code, tests, DB integration and
  transitive imports: passed with a bounded 2 GB Node heap.
- Changed-file ESLint and `git diff --check`: passed.
- Full-repository TypeScript: attempted with a bounded 2.25 GB heap; failed with
  Node heap exhaustion (exit 134). Not a type-check pass. Raising the heap above
  available sandbox RAM is intentionally avoided after the prior unresponsive
  sandbox incident.
- MCP matrix regenerated: 1,269 routes, 17 tenant gaps, zero platform gaps and
  zero unclassified routes. No new AI posting/approval capability.
- Full database suite, production build and browser/visual/rollout checks not run.
  The PR remains draft and is not production acceptance.

New pure tests cover malformed weights,
duplicate/case-normalized UUIDs, exact residuals, bigint IDs, input immutability,
100-target bounds and conservation through PostgreSQL bigint maximum. Service
and route tests cover permission intersections, validation, forbidden/missing
scopes and untrusted submitted figures. Database tests provision real agencies,
post through the canonical exact journal path, and check client/project/tenant
separation, project roles, reversals, pass-through/credit exclusion, exact large
amounts, and that repeated previews leave original journal rows unchanged.

The prior full-repository type-check attempt exhausted the sandbox heap. This
slice uses a targeted TypeScript check covering changed code and its transitive
imports; do not describe that as a full-repository check or a production build.
