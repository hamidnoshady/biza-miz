# Universal Platform Data Import/Export Engine

One engine that every module registers into. Not a CRM importer plus a POS
importer plus an accounting importer — a single flow (upload → analyse → map →
validate → preview → perform) that all six modules share, plus a registry that
describes what each entity is.

This document is the map. The code carries the detailed reasoning in its
headers; what follows is what was built, why it is shaped this way, and what is
still missing.

---

## 1. Architecture

### The registry is the seam

`src/lib/data-transfer/registry.ts` holds 25 entity definitions. Each one
states its fields and their types, which are required, validation rules,
relations to other entities, duplicate-detection keys, and the permission a
member needs to import or export it. Nothing else in the engine knows what a
customer is.

| Module | Entities |
|---|---|
| CRM (7) | customers, companies, leads, deals, activities, party_categories, pipeline_stages |
| POS (4) | products, categories, modifiers, orders *(export-only)* |
| Inventory (3) | items, stock *(export-only)*, warehouses *(export-only)* |
| Accounting (4) | accounts, invoices *(export-only)*, payments *(export-only)*, expenses |
| Website (3) | products, pages *(export-only)*, content *(export-only)* |
| Workspace (4) | projects, tasks, contracts, documents *(export-only)* |

Export-only is a deliberate judgement per entity, not a gap. An order is the
record of something that physically happened; an invoice and a payment are
postings that must go through the double-entry engine; stock levels are derived
from movements. Letting a spreadsheet write those directly would let an import
invent history, so those entities export and do not import.

### Adapters keep writes on the existing rails

`adapters.ts` plus `entities/{crm,pos,inventory,accounting,website,workspace}.ts`
supply each entity's `read` / `write` / `resolveReference`. Writes call the
module services that already exist — `createParty`, `createAccount`,
`recordExpense` — rather than issuing INSERTs. That is what keeps field
encryption, blind indexes, accounting-code allocation and double-entry intact
on the import path. An import is just another caller of the same code a human
form calls.

### Layers

```
codecs.ts     CSV · XLSX · JSON · PDF — the platform's only spreadsheet layer
mapping.ts    auto-suggestion, coercion, validation, row-level messages
registry.ts   what an entity is                      ← modules register here
adapters.ts   how to read and write it               ← via existing services
*-service.ts  import · export · templates · schedules · audit
/api/data/*   ten routes, all behind the two-key guard
settings/transfer  the UI, built from existing primitives
```

### Import: why the flow has four stops

`createImportJob` parses and stores the rows and writes **nothing** to the
business's own tables. `previewImportJob` re-validates against the current
mapping, still writing nothing. Only `runImportJob` touches tenant data, and it
re-derives everything from the stored rows rather than trusting a plan the
client computed.

An import is the fastest way to destroy a customer directory: one mis-mapped
column and three thousand records get a phone number in the name field, with no
undo. Showing exactly what will happen — how many created, matched, rejected,
and why, row by row — turns an irreversible bulk write into a decision somebody
can actually make. Re-deriving at perform time is what stops a stale approval
from executing against data that moved underneath it.

Rows are written one at a time, not in one transaction. A 5,000-row import in a
single transaction holds locks for minutes and rolls the whole batch back over
one bad row, whereas partial success is exactly what the reported counts
describe — and re-running the file is safe, because rows that already landed
now *match* instead of creating.

### Export: human-readable by construction

`category = پیتزا`, never `category_id = 15`. Related records are resolved to
their names, dates render Shamsi, and money is emitted in the unit the business
selected with that unit named in the header. Four formats: Excel, CSV, PDF,
JSON. All / selected / filtered, with a field chooser and saveable templates.

Two consequences for the file coming back in, both of them a field's contract
rather than an entity's exception:

- The header a money column gets is `«مبلغ (تومان)»`, not `«مبلغ»`. An entity that
  wants its own export to re-import lists the unit spellings among the field's
  `aliases` (the expense `amount` and `vatAmount` do); `suggestMapping` matches a
  header against key, label and aliases only, so an entity that says nothing gets
  its money columns reported as unmapped.
- `validation.integral` on a `money` field refuses a fractional cell instead of
  rounding it to the nearest whole Rial. Any column the ledger *posts* should carry
  it: ۱۵/۷۵ تومان rounded to ۱۵۸ is a journal line that reconciles with no
  document, and a silently-rounded figure is the one thing an accountant cannot
  find afterwards. Ordinary list prices keep the default, which is to round.

### Background processing

`runImportQueueTick` (every 10s) and `runScheduledExportsTick` +
`pruneExpiredExports` (every 5min) are wired into `server.ts` beside the
existing ticks. The import worker claims **one** job per tick through a
conditional UPDATE with `SKIP LOCKED`, so two app instances cannot take the same
job, and one business's fifty-thousand-row upload cannot starve everyone
queued behind it. Three failed attempts park a job as failed rather than
retrying forever.

---

## 2. Database changes

`migrations/0169_data_transfer_engine.sql` — six tables, each RLS-forced with a
`tenant_isolation` policy whose `USING` **and** `WITH CHECK` follow the
templates in 0021/0167, verified by `tenant-isolation.integration.test.ts`:

| Table | Holds |
|---|---|
| `data_import_jobs` | one upload: file metadata, mapping, options, counts, status |
| `data_import_rows` | every parsed row with its status and messages (parent-scoped through the job) |
| `data_export_jobs` | export history; `content` bytea plus `expires_at` for 30-day retention |
| `data_mapping_templates` | saved external-column → platform-field mappings and transforms |
| `data_export_templates` | saved field selections and filters |
| `data_scheduled_exports` | daily/weekly/monthly schedules with delivery settings |

`entity_key` is free text with a `CHECK (entity_key ~ '^[a-z0-9_]+\.[a-z0-9_]+$')`
and no foreign key: the catalogue lives in code, and a database FK to it would
mean a migration every time a module registers an entity.

Indexes cover the queue claims (partial, on the active statuses), history
listing per business and entity, and row lookup per job.

---

## 3. API changes

Ten routes under `/api/data`, all `withTenantScope`:

| Route | Methods | Purpose |
|---|---|---|
| `entities` | GET | the catalogue, filtered to what the caller may actually touch |
| `imports` | GET · POST | history; upload (analyses only) |
| `imports/[id]` | GET · PATCH · POST · DELETE | inspect; map+preview; run/retry; cancel |
| `imports/[id]/errors` | GET | the rejected rows as CSV, with reasons |
| `exports` | GET · POST | history; build and download |
| `exports/[id]` | GET | re-download a previous export |
| `templates`, `templates/[id]` | GET · POST · PATCH · DELETE | mapping/export templates |
| `schedules`, `schedules/[id]` | GET · POST · PATCH · DELETE | scheduled exports |

**Removed:** `/api/crm/customers/import` and `/api/crm/customers/export` — the
CRM now registers into the engine like everything else.

### Security: the two-key rule

`src/app/api/data/guard.ts` is the whole model. Every call checks the engine
permission (`data.import` / `data.export`) **and** the entity's own permission
from the registry (`crm.export`, `menu.edit`, `ledger.post`). The engine grants
no new reach: a member who could not read the CRM cannot export it through the
data tab. Both keys are re-checked on every download, so revoking a permission
kills previously issued links. `api-guards.test.ts` asserts that every route
calls `entityAccess()`.

Verified live against the running server with the unprivileged role:

```
cashier    → 403 on all ten routes, including direct-by-id download
accountant → has data.export but not crm.export
             export accounting.accounts → 200
             export crm.customers       → 403
             download owner's CRM file  → 403
             catalogue shows 19 entities, owner sees 25
```

---

## 4. UI changes

`src/app/(app)/settings/transfer/` — five files, registered as the
`data-transfer` settings tab («ورود و خروج داده») in a new «داده‌ها» group.

Built entirely from existing primitives (`PageShell`, `SectionCard`, `TabBar`,
`DataTable`, `SectionNav`, `Field`, `PrimaryButton`, `StatusBadge`,
`JalaliDatePicker`) — no new design language, and it passes `design-lint`,
`primitive-lint` and `loading-coverage`. RTL throughout, Shamsi dates
everywhere, Persian digits for display.

The import screen walks module → entity → upload → column analysis → mapping →
preview → import. Mapping offers auto-suggestions with manual override, field
search, required-field warnings, and save-as-template. The preview reports
total / valid / warning / error counts with per-row reasons, import-valid-only,
and a downloadable error report. Export offers the field chooser, filters,
format, templates and schedules. History lists both directions with re-download
and failed-record download.

> The folder is `transfer/`, not `data-transfer/`: a component folder named
> after a settings slug shadows the `[section]` dynamic route and fails
> `route-tree.test.ts`. Same reason `printing/` serves the `printers` tab.

---

## 5. Cleanup

Deleted, not deprecated:

- `src/lib/xlsx-import.ts`
- `src/lib/crm-csv.ts`
- `src/lib/crm-import-service.ts`
- `src/lib/crm-export-service.ts`
- `src/app/api/crm/customers/{import,export}/`
- `integration/crm-import-export.integration.test.ts`

`report-export.ts`, `tenant-export.ts` and `menu-import.ts` were rewritten onto
the shared codecs, so there is now exactly one CSV writer and one XLSX reader in
the platform. Every property the deleted CRM suite asserted was carried forward
verbatim into the new integration suite: consent is never imported or exported,
dry runs are inert, ambiguity is reported, re-runs are safe, formulas are
neutralised, everything is audited and tenant-isolated.

---

## 6. Defects found and fixed

Five real bugs, all found by tests or CI during this work:

1. **`report-export.ts` had no formula-injection guard.** The reports CSV was
   an unguarded export door — a cell beginning `=` would execute on open in
   Excel. Fixed by consolidation onto `csvCell`, pinned by a new case.
2. **`inventory.warehouses.name` was `required && readOnly`** — an
   unsatisfiable combination that made the entity impossible to import. Fixed
   and pinned by `registry.test.ts`.
3. **The import queue's claim ran with no tenant scope.** Every engine table is
   RLS-protected on `app.business_id`; an unset scope makes the predicate false,
   so the claim matched **zero rows on every business** and the queue never
   drained. It reported no error — the UPDATE honestly said it updated nothing.
   This was invisible to the integration suite, which connects as a superuser
   and therefore ignores RLS entirely, and total under the unprivileged role a
   real deployment uses. Found by running the production server against
   `pos_app`; fixed by wrapping the claim in `withoutTenantScope("platform")`,
   matching the messaging and notification ticks; pinned by
   `queue-scope.test.ts`, which asserts the scope each statement runs in.
4. **The error path could reject the whole tick.** The recovery write that
   returns a failed job to the queue was itself unguarded, so a database blip —
   exactly when it fires — would throw out of `runImportQueueTick` and stop the
   queue for *every* business. Now caught, and `reclaimStalledImports()` returns
   jobs abandoned mid-flight (deploy, OOM, dropped connection) to the queue,
   parking them as failed after the attempt ceiling.
5. **The desktop installer stopped building.** The retention tick made
   `server.ts` reach `export-service` → `pdf-render` → `playwright-core`, whose
   prebuilt bundle requires `chromium-bidi` subpaths that are not in the npm
   tree. esbuild could not resolve them, so `npm run desktop:runtime` failed and
   took `verify-shippables` and `build-desktop-installer` with it. Nothing else
   compiles `server.ts` with esbuild, so all nine `test` jobs stayed green while
   the shipped artefacts broke. Fixed by marking `playwright-core` external —
   safe because Next's standalone trace already stages the real package into the
   runtime — plus a lazy import, and a posture test pinning it to the list.

---

## 7. Test results

Everything below was run after the final change.

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run lint` | clean |
| `npm test` | **380 files / 5464 tests pass** (baseline 376 / 5346) |
| `npm run test:db` | **130 files / 1478 pass, 1 skipped** (~544s) |
| `npm run test:design` | 5 files / 36 tests pass |
| `npm run build` | succeeds (needs a raised heap; see §9) |
| `npm run desktop:runtime` | succeeds — 164.9 MiB, within the 200 MiB budget |

### On CI (GitHub Actions, all green)

| Workflow | Result |
|---|---|
| `test` | all 9 jobs pass, including `visual regression`, `api-guard-tests` and `data-transfer-tests` |
| `verify-shippables` | desktop shell, production container, WordPress plugin, print connector |
| `build-desktop-installer` | packaged Windows end-to-end |

New tests: `codecs` (37), `mapping` (43), `registry` (23), `schedule` (12),
`queue-scope` (9), and `integration/data-transfer.integration.test.ts` (54,
including a 2,000-row import, an XLSX round-trip, permission cases and four
tenant-isolation cases).

### Live verification

A production build was served to a real browser on the unprivileged `pos_app`
role — i.e. with RLS actually enforced, and past both the `assertSecurePosture`
and `assertRlsEffective` boot guards:

- Persian CSV uploaded → columns auto-mapped correctly
  (`نام مشتری`→name, `شماره تماس`→phone) → preview 3/3 valid → queued.
- Background worker claimed and completed it: **3 created**; the three records
  appear in `/accounting/directory`.
- Re-importing the identical file: **0 created, 3 skipped** — duplicate
  detection working against live data.
- CSV / XLSX / JSON exports returned correct bytes; XLSX round-tripped through
  the platform's own reader; the CSV shows `دستهٔ شخص = مشتری طلایی`
  (name, not id) and `۱۴۰۵/۰۶/۳۱` (Shamsi).
- Permission matrix as in §3.
- `/settings/data-transfer` renders server-side in RTL with every section.

---

## 8. CI changes

`.github/workflows/test.yml` gains two jobs, both fanned into `required`:

- **`api-guard-tests`** — asserts every `/api/data/*` route is behind
  `entityAccess()`, so a new route cannot be added without its two-key check.
- **`data-transfer-tests`** — a `postgres:16` service, migrations applied twice
  (the second run must be a no-op), then the engine suite, the tenant-isolation
  suite and the migration sweeps.

Required set is now: `lint, typecheck, unit-tests, build, integration-tests,
api-guard-tests, data-transfer-tests, design-checks, visual-regression`.

---

## 9. Remaining issues

Stated plainly, because each one is a real limit:

1. **PDF import is best-effort.** pdf.js collapses column gutters to single
   spaces, so a two-pass splitter (gutters, then single spaces) is used with a
   "one matching line is not a table" floor. It cannot reliably distinguish a
   three-word heading from a three-column row. Tested, documented in code, and
   flagged in the UI hint — treat PDF as a convenience, and prefer CSV/XLSX.
2. **PDF *export* needs Chromium**, which is absent from this sandbox, so that
   one path could not be exercised here. It shares `renderHtmlToPdf` with the
   existing `/api/reports/export`, so it is a pre-existing constraint rather
   than a new one; CI's `visual-regression` job installs Chromium and does
   cover it.
3. **`npm run build` needs a raised heap** (`NODE_OPTIONS=--max-old-space-size`
   at 2560–3072 MB). The default 1954 MB OOMs during the type-check phase; on a
   4 GB machine 3072 can itself be killed by the OS, so 2560 is the safer value.
   CI already raises it. Pre-existing, now more visible.
4. **Scheduled-export email delivery** rides the existing SMTP outbox
   (`OutboundAttachment` was added to the provider interface). The scheduling,
   claiming and file-production paths are unit- and integration-tested, but an
   end-to-end send needs real SMTP credentials and was not exercised here.
5. **Visual-regression baselines** were not re-recorded for the new screen —
   recording is deliberately a human, opt-in action in this repo
   (`docs/design/visual-regression.md`), never something CI or an agent does to
   turn a run green. The job passes because the new screen is additive and no
   existing baseline shifted; recording one for `/settings/data-transfer` is a
   deliberate follow-up for whoever approves the look.
