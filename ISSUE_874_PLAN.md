# Issue #874 — Superadmin audit: implementation status

Source: [hamidnoshady/biza-miz#874](https://github.com/hamidnoshady/biza-miz/issues/874)
(read-only audit of 2026-10-07; findings F01–F28). This file records what this
branch changes, what was verified, and what is still open, so the next person
does not have to reconstruct it from the diff.

Scope note: the issue spans two repositories. Items that need changes in
`hamidnoshady/eshobe-cms` (deploy-target platform-key endpoint, entitlement
signing credentials, usage ingestion, CMS job classification) are **not**
implemented here and are listed under "Open".

## Implemented on this branch

| Finding | Change | Where |
|---|---|---|
| F01 admin mutations | One typed request contract shared by the page and the route. POST = create only; PATCH = `update` / `revoke_sessions` / `reset_password` keyed by `adminId`. Unknown or missing actions are rejected (`invalid_action`). The ignored initial-password field is removed. Sensitive admin actions require recent auth (15 min) and the console replays the same request after step-up. A signed-in admin cannot deactivate themselves. Last-owner check now runs under `FOR UPDATE` in one transaction with the audit row. | `src/lib/platform-admin-contract.ts`, `src/app/api/platform/admins/route.ts`, `src/app/platform/admins/page.tsx`, `src/lib/platform-service.ts` (`updatePlatformAdmin`), `src/lib/db.ts` (`withoutTenantScopeTransaction`) |
| F02 mobile titles | First column renders once as the mobile card title when no `mobileTitle` is given. | `src/components/platform/data-table.tsx` |
| F20 keyboard details | Clickable rows get a named, focusable details button (desktop and mobile). Mobile cards are no longer `role="button"` containing other buttons. | `src/components/platform/data-table.tsx` |
| F12 stale refresh | A failed refresh with rows on screen shows a visible stale-data alert with retry; rows stay. | `src/components/platform/data-table.tsx` |
| F03 backup encryption | A run that requests encryption without an effective passphrase is refused and recorded as failed (no plaintext). Status reports `effectiveEncryption`. Peers are never served plaintext (`.dump`) artifacts; legacy files are kept on disk, not deleted. | `src/lib/platform-backup-service.ts`, `src/lib/platform-backup.ts` |
| F07 recent auth | Destructive restore, backup config writes, peer-sharing token creation, and peer add/update/delete require recent auth. Verify-only restore is unchanged. | `src/app/api/platform/backup/**`, `src/app/api/platform/admins/route.ts` |
| F09 KPI scope | Overview business counts use customer ownership only (matches the directory); internal-company count is reported separately. | `src/lib/platform-overview-service.ts` |
| F10 status viewpoint | Canonical ticket states unchanged; operator desk uses its own labels (`waiting_customer` = customer owes the reply). | `src/lib/support-tickets.ts`, `src/app/platform/support/*` |
| F14 sort direction | Validated `dir=asc|desc` for name/orders/members/activity/created, applied in SQL with `b.id` tie-breaker. The UI arrow reflects the resolved order. Legacy `newest`/`oldest` still work. | `src/lib/business-sort.ts`, `src/lib/platform-service.ts` (`queryBusinesses`), `src/app/api/platform/businesses/route.ts`, `src/app/platform/businesses/page.tsx` |
| F16 spend-policy audit | PUT validates UUID/action/budget/thresholds before any write; policy change and `billing.spend_policy.updated` audit (actor, business, before/after) commit in one transaction. Form has a busy state and client-side UUID check. | `src/app/api/platform/billing/spend/route.ts`, `src/app/platform/_components/billing/commercial-tabs.tsx`, `src/app/api/platform/billing/audit/route.ts` |
| F19 KPI deep links (partial) | "Urgent" and "unassigned" tiles/alerts link to the open queue with the matching filter (`queue=open`, `unassigned=true`). | `src/app/platform/page.tsx`, `src/lib/platform-overview-service.ts`, `src/app/api/platform/support/tickets/route.ts`, `src/lib/platform-service.ts` |
| F11 dates (audit log) | Native Gregorian `<input type="date">` replaced by `JalaliDatePicker` on the audit log; ISO stays in the URL. | `src/app/platform/audit/page.tsx` |
| F21 audit money | Billing audit summaries pick units by key name (`…Rial` money, `…Limit`/`…Count` quantities, `…Percent`/`…Bps`, ISO times → Jalali). Unknown integers are never guessed to be money. | `src/app/platform/_components/billing/audit-payload-format.ts` |

## Already correct on this revision

- **F08 prompt route**: `/platform/ai/prompts` is not redirected in
  `next.config.ts` (only `/platform/ai/gateway` and tenant settings redirect),
  and `src/app/route-tree.test.ts` pins it. The audit's live observation predates
  this revision.

## Open (not done in this branch)

- **CMS boundary (F05, F06, CMS side of F13/F18/F23):** platform-key deploy-target
  endpoint, entitlement signing credential setup, usage backlog diagnosis and
  replay, failed-job classification. Requires `hamidnoshady/eshobe-cms` changes
  and production access; no production replay was attempted.
- **F04 backup operations:** schedule, retention, storage capacity and a scratch
  restore drill need an operator with production access.
- **F13/F18 health cards:** structured CMS health cards and per-read
  loading/error/empty states on the CMS infrastructure panel are not reworked.
- **F15 auto-renew display, F17 company entry-point gating, F22 copy/digit drift,
  F24 AI readiness wording, F25 desktop release registration, F26 knowledge
  section registry and `overview` tag migration, F27 MFA realm messaging,
  F28 page H1/empty-state structure:** not implemented here.
- **F12 scope:** the stale banner is implemented in the shared table; the
  last-success timestamp is not yet shown.
- **F07 scope:** the other admin-level write paths (sessions/impersonation
  routes already use recent auth) were reviewed; no new gates were needed there.
- **F16 scope:** the spend form's "Gregorian/Persian digit" and threshold
  selector polish are not done.
- **DB integration (`npm run test:db`):** not run — no PostgreSQL in the sandbox.
  The atomicity claims (admin last-owner lock, spend-policy audit rollback) are
  covered by mocked-transaction tests only; they need a DB test before release.
- **Full `npm run build`:** not completed in the sandbox (out-of-memory on a
  3 GB host). `npx tsc --noEmit` passes.

## Verification run on this branch

| Command | Result |
|---|---|
| `npx tsc --noEmit` | pass (exit 0) |
| `npx vitest run` (full unit suite) | 756 files, 9905 tests passed |
| `npm run test:design` | 5 files, 38 tests passed |
| `npx eslint` on all changed/new files, `--max-warnings=0` | clean |
| `npm run test:db` | not run (no Postgres) |
| `npm run build` | not completed (OOM in sandbox) |
