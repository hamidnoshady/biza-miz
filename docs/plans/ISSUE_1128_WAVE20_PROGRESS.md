# Issue #1128 — campaign agenda, manual CSV preparation and combined specialties

Continuation of merged #1346. This implements three bounded pieces of the open
queue; it does **not** close #1128 or certify the remaining accounting, automation
or eligibility work. No migrations, data backfills or extra business apps.

## Campaign calendar

The CRM campaign screen includes a Jalali date-range **agenda**, backed by
`GET /api/crm/client-campaigns/calendar`, not by the legacy capped metrics list.
Choose an inclusive window of at most 93 days and optionally a canonical client.
The server returns 100 scheduled campaigns per page with an explicit next offset.
The UI can load all pages; it never claims that a page is the whole calendar and
never computes financial/performance totals. Undated campaigns are excluded;
open-ended campaigns overlap any later window. All lifecycle states are labelled,
including planned, completed and cancelled; scheduled dates are not proof of
actual execution. This is a range agenda, not a drag-and-drop month grid.

Authority is filtered **in SQL before LIMIT/OFFSET**. CRM view alone permits only
unlinked CRM events. Linked events additionally require the live Workspace view
guard and the existing valid project membership or business-wide read/admin
override, with same-tenant project existence. A Workspace override without the
independent permission flag does not grant visibility. Inaccessible rows neither
leak titles/client/project data nor consume visible page slots. Client filters,
window and safe offsets are revalidated in the source service. Existing Workspace
read/disabled-service policy is preserved; no eligibility policy is invented.

Date/client changes clear old rows and cancel the outstanding request. Results
are stable-ordered by start date/id; concurrent schedule edits can still move rows
between offset pages. The UI explicitly warns to refresh from the first page,
deduplicates IDs, shows first-fetch skeletons and never reports a snapshot total.

## CSV import into immutable period reports

The existing human report form accepts a browser-local UTF-8 comma-separated CSV:

- Maximum 1 MiB, 100 columns and 1,000 data rows; unique nonempty headers, consistent
  row lengths, quoted commas/newlines and escaped quotes. Malformed UTF-8, NUL,
  malformed quoting and bounds violations are refused. Blank physical records are
  ignored; row references are logical data-row numbers, not physical file lines.
- Explicit mapping of spend, impressions, clicks, leads and conversions; optional
  reach and attributed revenue. A column cannot be reused for two measures.
- **Explicit currency selection**, reset for each file. Integer toman converts to
  rial exactly with BigInt; Persian/Arabic digits are accepted. No decimal,
  separator, exponent, formula or unsafe monetary value is silently coerced.
  Mandatory blanks are invalid, optional blanks are unknown, measured zero is zero.
- One selected row is previewed with the user-selected period and attribution
  explanation. Changing period, note, row, mapping or currency invalidates preview.
  No rows or overlapping periods are summed and no bulk posting occurs.
- The file name, logical row and SHA-256 of the original bytes become a proposed
  source reference. Raw file contents stay in the browser. This fingerprint is
  **not independent source verification**, server-verified provenance, an upload,
  an integration connection or an attestation that the numbers are correct.
- A separate action transfers the preview to the editable form. Nothing is saved
  until the existing explicit report-save action; attribution confirmation resets
  to false. Correction IDs/period locks remain owned by the report form, never CSV
  content. Existing server validation, append-only corrections and guards remain
  authoritative even if a caller bypasses or edits the local preparation UI.

## Combined operating specialties

The template response now reads the stored primary **plus validated secondary**
agency specialties. Recommended flags/order are a stable union; template keys,
industry filtering, permissions, enabled features, navigation and data are not
changed. Duplicate specialties cannot duplicate choices. AEC keeps its existing
single-profile behavior and other industries keep their generic catalogue.
GET/POST/DELETE template responses use the same profile resolution. The settings
copy now explains that secondary specialties contribute recommendations rather
than being merely descriptive labels. No dashboard KPI or navigation preset
layer is claimed here; the universal CRM pipeline/default ordering is untouched.

## Verification

- Full unit/component/contracts: **18,556 passed**, 8 skipped; **1,508 files
  passed**, 1 skipped. The loading contract initially caught the missing first-fetch
  skeleton; after fixing it the entire suite was rerun successfully.
- Real database integration: **34 passed** across reports/calendar/presets (11),
  canonical campaign regressions (16), and audited agency party merges (7).
- New database checks cover filtering before pagination, >100 authorized rows,
  cross-tenant and same-tenant project isolation, independent Workspace permission,
  overrides, open ends/client filters, and real stored-specialty catalogue behavior.
- New component tests exercise calendar paging/date invalidation/refusal, explicit
  CSV mapping/currency/preview, no automatic save/attestation, malformed input and
  stale-preview invalidation. Pure tests cover range validation, quoted CSV,
  limits, exact currency conversion, blank/zero distinctions and invalid counts.
- Targeted TypeScript (new source/routes/components, Workspace/profile wiring,
  related tests/integration, repository declarations): pass.
- Changed-file ESLint and whitespace checks: pass. MCP matrix regenerated:
  1,260 routes, 17 tenant tool gaps, zero platform gaps and zero unclassified routes.
- Full production build, full DB suite, browser E2E/visual capture and production
  rollout not run locally for this slice; CI/review remains required.

## Still open

See [remaining work](ISSUE_1128_REMAINING_WORK.md). Full file provenance validation
and authorized ad connectors, campaign-ledger dimensions, actual time/resources,
commercial completion, renewals, agency dashboards/print/AI and rollout remain
open. #1110 currently has a **proposed** matrix for the older industry set but no
explicit `advertising_agency` row; do not call it an approved complete agency
eligibility decision or guess the missing policy.
