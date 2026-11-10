# Issue #1128 — evidenced, period-specific client campaign reports

Date: 2026-10-26. Continuation of merged #1345 (Wave 18). This implements part of
§C/manual attribution, **not completion of #1128 or its remaining-work backlog**.
See [the current remaining-work tracker](ISSUE_1128_REMAINING_WORK.md).

## Member workflow

The canonical CRM client-campaign drawer now offers period reports. A member picks
Jalali dates, provides a source/export reference and attribution explanation, and
pastes a measured JSON object. Required fields are `spendRial`, `impressions`,
`clicks`, `leadsGenerated`, and `conversions`; optional `reach` and `revenueRial`
are nullable. Money in imported JSON is integer **rial**, regardless of the display
currency. There are no prefilled/fabricated measured zeros. For example, field
names are documented in the form, but no sample performance is saved automatically.

The period must fall within a dated, nonplanned canonical campaign's window and
not extend past the tenant business day. Running, paused, completed and cancelled
campaigns can receive historical reports; cancellation is not evidence that no
activity occurred. Reports do not reopen or change the campaign lifecycle.

Attribution defaults to **unconfirmed**. Until the person explicitly declares
source reconciliation, CPL, CPA and ROAS stay unknown; CTR remains a mathematical
ratio of the supplied impression/click counts. Zero denominators yield unknown,
and measured zero revenue is distinct from missing revenue. A human declaration
is not independent platform verification. These figures are never posted revenue
or expense and do not update the older editable campaign-lifetime counters.
The list explicitly labels those older counters as unverified manual figures.

History displays source reference, explanation, actor-name snapshot, Jalali date,
nullable reach/revenue, metrics and the total campaign budget captured at insertion.
That budget is context, **not a period budget** or a valid period-spend variance.
Each report can be downloaded as JSON. This is manual structured import/export,
not a file parser, evidence upload, scheduled connector, client-facing report or
print/PDF template. Source references are user declarations, not validated evidence.

## Integrity and authority

Additive migration `0293_client_campaign_reports.sql` creates an RLS/FORCE-RLS
append-only report table; it performs no legacy-counter backfill. Tenant/campaign,
window, value bounds, same-period correction lineage, unique root periods and
single-successor corrections are enforced at storage as applicable. The service
also checks the tenant business day. Update/delete of a report is refused.

A correction appends a new version and preserves its predecessor; the form resets
attribution confirmation so an old declaration is not silently reused. A parent
campaign lock serializes competing writes, preventing correction forks. Read scope
is held with a share lock while history is loaded. Client/project scope cannot be
changed once reported, apart from the existing audited canonical CRM party-merge
path. Campaign dates may expand but cannot exclude existing reported periods.
The report author is registered in member-history retention.

`GET`/`POST /api/crm/client-campaigns/[id]/reports` require `crm.view`/`crm.manage`.
For linked projects, the existing Workspace guard independently checks activation
and `workspace.view`/`workspace.manage`; the source service independently enforces
project capability and membership. Server-derived `canWrite` is only a UI hint,
not authorization. An unlinked route call is explicitly denied Workspace authority,
so a racing assignment to a project cannot reuse CRM-only access. Actors come from
the verified session, never request measurements.

Only the newest 100 report versions are returned, explicitly labelled in the UI.
Different overlapping periods may be recorded, but are **never summed** into a
campaign/client/dashboard total. Superseded state is checked against stored history,
not just the capped page. No ledger entries, domain events, accounting claims,
automatic platform integration, background job or AI attestation tool is added.
The regenerated MCP matrix classifies the routes and documents the real tool gap.

## Verification

- Full unit/component/contract suite: **18,433 passed**, 8 skipped;
  **1,490 files passed**, 1 skipped. Includes CRM permission classification,
  API guards, MCP drift, industry/navigation/design and loading contracts.
- Database integration: **37 passed** across period reports (8), existing canonical
  campaigns (16), agency party merge (7), and party-reference coverage (6).
- New database assertions include immutable corrections, concurrent writers,
  explicit zero revenue, unknown reach, budget snapshot preservation, tenant/RLS
  and same-tenant project isolation, window protection and the real audited merge.
- New component tests cover uncertainty/read-only controls, explicit JSON import,
  correction period preservation/reset attestation, and retained input on refusal.
- Targeted TypeScript includes report libraries, campaign APIs, CRM components,
  new report integration/component tests and repository type declarations: pass.
- Changed-file ESLint and `git diff --check`: pass.

The full Next production build, browser E2E/visual checks, full database suite and
production rollout were not run here. These results do not substitute for #1110's
missing approved eligibility matrix or certify the complete epic's rollout.
