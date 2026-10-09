# Issue #883 — MCP full read/write hardening & parity: implementation plan

Status: wave 1 (this branch) delivers all five P0 tenant-MCP security blockers,
the origin-binding and request-limit P1 hardening, and the machine-reviewable
coverage matrix. The remaining P1 scope work and the independent Superadmin MCP
realm are mapped at the end with their follow-up waves.

## Audit-verified findings (reproduced from source on branch)

| # | Finding | Evidence |
|---|---------|----------|
| P0-1 | MCP reads run with `SYSTEM_AI_READ_PERMISSIONS = new Set(ALL_PERMISSIONS)` regardless of the authorizing member's RBAC | `src/lib/ai-system-read.ts`, called from `src/lib/mcp/server.ts:126` |
| P0-2 | Connection name-checks a `location_id`, but write executors never compare it; cross-branch reads are unscoped | `src/lib/ai-autopilot-executors.ts` (`locationOfMenuItem`, …) — no comparison against the connection branch |
| P0-3 | `decideMcpPendingAction` SELECTs `proposed`, executes, then conditionally updates — concurrent approvals both execute; no idempotency contract | `src/lib/mcp/write-service.ts` |
| P0-4 | Consent UI says owner-only; APIs use delegatable `integrations.manage` | `src/app/api/connections/mcp/**`, `src/app/mcp/consent/**` |
| P0-5 | Write path only checks that `authorized_by` exists; `AI_ACTION_PERMISSION_MAP` never enforced | `src/lib/mcp/write-service.ts` |
| P1-6 | Bearer auth never compares request host to the authorized tenant | `src/lib/mcp/auth.ts` |
| P1-9 | No body/batch/argument size bounds on `/api/mcp` | `src/app/api/mcp/route.ts` |

## Wave 1 — delivered here

1. **MCP authority resolution (P0-1).** `src/lib/mcp/authority.ts` resolves the
   authorizing member's *current* role/flags/effective permissions on every
   request (no cache, same read as `member-access.ts`). `authenticateMcp`
   attaches it and refuses the credential outright when the authorizer's
   membership is gone or inactive — retiring the legacy "NULL authorizer can
   still read" fallback — and when the business is suspended.
   `tools/list`, `tools/call`, `resources/list` and `resources/read` are all
   filtered through `AI_TOOL_PERMISSION_MAP` / `AI_ACTION_PERMISSION_MAP` and
   fail closed for unknown tools/actions.
2. **Write reauthorization (P0-5).** Both the immediate-apply path and the
   human-approval path re-resolve the act­ing member's effective permissions at
   execution time and require the action's domain permission
   (`aiActionPermission`), failing closed for unmapped/new actions.
3. **Atomic claim + idempotency (P0-3).** Approval claims the audit row
   `proposed → processing` in one CAS *before* any side effect (one winner;
   losers get `already_decided`); terminal status is a second CAS. Apply-mode
   calls accept an idempotency key (`_meta.idempotencyKey`) stored on the audit
   row with a partial unique index; retries return the durable outcome instead
   of duplicating the effect. Revoking or narrowing a connection cancels its
   outstanding `proposed` writes, and approval revalidates the connection's
   status/scopes at execution time.
4. **Branch enforcement (P0-2, write half).** Executors receive the
   connection's `locationId` and refuse targets belonging to another branch
   (menu items, orders, stock counts, purchase drafts, production runs).
   Autopilot/coworker callers pass `null` and are unchanged.
5. **Owner-only MCP management (P0-4).** New owner-only permission
   `mcp.manage` (mirroring `api.manage`) gates static-token minting, access
   changes, revocation, OAuth consent and pending-action decisions. The
   connections panel reads `canManage` from the GET payload and renders
   read-only without it. Policy: **owner-only issuance and approval**,
   documented in `docs/mcp/issue-883-authorization.md`.
6. **Origin binding (P1-6).** On host-routed deployments the bearer request's
   host must resolve to the connection's business (aliases allowed); apex /
   admin / unknown hosts are refused. Single-host (desktop) mode keeps the
   token-as-tenant-selector behaviour.
7. **Request limits (P1-9 subset).** 1 MiB body cap, 20-message batch cap,
   64 KiB per-tool-argument cap on `/api/mcp`.
8. **Coverage matrix + tests.** `docs/mcp/issue-883-authorization.md` carries the
   machine-reviewable matrix; regression tests for every P0 run against real
   PostgreSQL in `integration/mcp-connector.integration.test.ts` plus unit
   tests for the pure parts.

## Follow-up waves (not in this branch)

- Wave 2: fine-grained per-app scopes (P1-7), OAuth lifecycle/abuse
  hardening (P1-8), tenant management UX improvements (P1-10), branch-scoped
  *read* policy (`single_branch` vs consented `multi_branch`).
- Wave 3: independent Superadmin MCP realm (`/api/platform/mcp`) with platform
  credentials, per-tool `platformCan` authorization, audited tenant bridge,
  management UI, and the parity test grid against the tenant realm.
