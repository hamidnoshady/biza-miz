# Issue #883 — implementation plan (waves 2–4, after P0 wave 1)

Branch: `arena/66dbaa34-biza-miz`. Base: `7b1b11c` (main, also squash-root).
Wave 1 (P0) is merged in this branch at `0dacf4e` and reviewed green except the
pre-existing visual-regression failure `accounting-expenses` (4.06%), which CI
shows equally red on `main` (runs 37925908136, 37919841516) — so it is NOT
attributable to wave 1. Attribution to be established by local repro.

## Recon (2026-10-09, at 0dacf4e)

- CI per workflow on reviewed head: `test` failed only in job `visual regression`
  ("4.06% of pixels changed, bounds 54,18 1370×830"); all other checks green
  (type, lint, unit, integration, guards, data-transfer, build, media E2E,
  design checks).
- main also fails the same visual test at two of the last three runs; the
  baseline file `docs/design/visual/accounting-expenses.png` was last touched by
  the squash commit itself. Repro locally before concluding.
- Repo squashed to a single commit (`7b1b11c`); no per-file history available.
- Tenant MCP (src/lib/mcp/*): read catalogue = reshaped `ai.ts` toolDefinitions
  ("dashboard") ∩ scope ∩ authorizer-permissions (P0-1 done). Writes =
  `WRITE_TOOL_SPECS` ⊆ ACTION_CATALOG-with-executor, applied through shared
  executors (never new mutation path). CAS + idempotency + host binding +
  mcp.manage + caps done (wave 1).
- `mcp_connections`: `scopes text[]` constrained by CHECK to a fixed list
  (see migration 0216-era); `location_id` = pinned branch; `expires_at` exists
  but creation defaults null.
- Platform realm exists: `platform_admins`, `platformCan(role, capability)`,
  `withPlatformScope`, `requirePlatformAdmin`, `platformAudit`, rich
  capability vocabulary (businesses/billing/backup/cms/messaging/security/…).
  NO MCP surface exists there → new realm built from scratch.
- `runReadTool(name, args, businessId, floorScope?, actorUserId?, permissions?)`:
  MCP passes undefined floorScope. Primary-location defaults at
  `primaryLocationId()`. Business-wide tools (branch comparison, report engine)
  have no branch constraint.

## What wave 2–4 must deliver (from the task, verbatim scope)

### A. Tenant hardening

1. **Branch scope for reads (A1).** New `branch_scope` text column
   (`'single_branch' | 'multi_branch'`, default `single_branch`, conservative
   migration) on `mcp_connections` + `mcp_oauth_codes`. Consent + static
   creation surface it. `runReadTool` gains an MCP-only
   `McpReadScope { branchScope, locationId }` argument; registry classifies
   every read tool as `pinned` (branch must = connection's branch, arg injected
   / mismatch refused), `business_wide` (only visible when multi_branch), or
   `agnostic`. ai-tools threads it into `run_report`'s trade-report locationId,
   primary-location tools (near-expiry, repurchase candidates), and
   `find_items` (new optional locationId arg pinned by registry).
2. **Resources ∩ connection grants (A2).** `resources/list` and
   `resources/read` must also require the connection's `pos.read`-app grant,
   not only authorizer permission: catalog filtered by (scopes ∧ grants ∧
   authorizer permissions).
3. **Pending-decision revalidation (A3).** `decideMcpPendingAction` already
   claims CAS + checks connection status/scopes; ADD: connection `expires_at`
   must not have lapsed (fail terminal, reason surfaced), entitlement
   (`api_platform` still on), original **authorized_by** authority still live
   AND permitted for this action (authorizer may have been downgraded after
   proposing), branch of target ∈ consented branches, approver's permission for
   the specific action (already), and step-up confirms for high-risk actions.
4. **Interruption recovery (A4).** `processing` rows stale beyond a window
   (15 min) are reconciled: `reconcileStaleMcpClaims(businessId)` — invoked
   lazily from the pending/history listing and from decide — marks them
   `failed` with `result.error='interrupted'`, `requiresReview=true`,
   preserving `prior_state` for manual review. Never auto-replay, never
   auto-retry. Idempotency replies on a *stale* processing row report the
   interrupted state rather than "in_flight" forever.
5. **Idempotency payload conflict (A5).** New column
   `mcp_idempotency_payload_hash text` (canonical JSON: action+payload,
   SHA-256). On unique-index collision: same hash → durable outcome replay;
   different hash → failure outcome `idempotency_conflict` (no side effect, no
   new row). Concurrency tests count actual side effects (audit rows + domain
   mutations).
6. **Async status (A6) & budgets (A7).** New read tool
   `get_write_status(auditId)` (registry-granted, connection must own the
   audit row) for polling apply/approve outcomes — covers async status &
   result retrieval. Route-level per-connection rate limit (60/min rolling,
   in-memory on the stateful server) → clear JSON-RPC error. MCP-side report
   range clamp (≤370 days) + tool-result size cap (~256 KiB) with a narrowing
   hint.
7. **Granular grants (A8).** `grants jsonb` on `mcp_connections` +
   `mcp_oauth_codes`/`mcp_oauth_tokens` propagation: app →
   `{ read, write }` booleans over `{ pos, accounting, crm, growth, website,
   workspace }`, plus `branches: string[] | "all"` and `branchScope`. Legacy
   `{}` = today's behaviour (conservative, no narrowing, no widening). New
   connections: safe defaults (read-only grants chosen explicitly, approve
   mode, finite expiry 180 days in UI). Catalogue filters app ∈ grants with
   read/write level; consent + creation UI exposes them.

### B. Tenant coverage + parity mechanism (B)

- `src/lib/mcp/registry.ts` — the machine-reviewable capability register:
  per tool `{ name, app, kind, permission, risk (low|high), approval
  ('mode'|'always_approve'), branchPolicy, module?, destructive, bridgeable }`.
  tools.tscatalogue derives from it; write specs keep asserting against
  ACTION_CATALOG executors.
- **Risk-based confirmation:** registry `risk: 'high'` + apply mode → the
  write is downgraded to approve with message `step_up` (human confirmation is
  mandatory for irreversible/financial posts and mass operations — never
  removed, never silently applied).
- **New write coverage** (all through existing validated services):
  menu item create (`menu-service.createMenuItem`), menu category create,
  supplier purchase receive draft? — each added to ACTION_CATALOG + executor +
  WRITE_TOOL_SPECS only where a validated service/executor path already exists
  and invariants hold. Genuinely blocked verbs (absent services) are listed in
  the matrix as gaps, not stubbed.
- **CI parity enforcement:** unit tests (already in CI) —
  (i) every AI read tool that AI_TOOL_PERMISSION_MAP knows is registered;
  (ii) every ACTION_CATALOG executor-backed action is registered;
  (iii) every registry id resolves to a real catalogue tool/spec;
  (iv) platform register covers every non-deprecated PlatformCapability or
  documents exclusion; (v) coverage-matrix doc matches registry output.

### C. Superadmin MCP realm (C)

- Migration `0218_platform_mcp.sql`: `platform_mcp_connections` (token_hash,
  admin FK, grants jsonb incl. `bridge:boolean`, expiry, revocation) +
  `platform_mcp_audit` (connection, admin, business?, tool, args, outcome,
  idempotency_key partial-unique) + `platform_mcp_pending` (approval queue:
  proposed→processing CAS→applied/failed/dismissed, prior pattern).
- `src/lib/platform-mcp/{registry,auth,server,write-service}.ts`: token prefix
  `pospmcp_` (structural non-crossover), fresh admin re-read each call (role
  downgrade/deactivate/revoke instant), per-tool `platformCan` check, admin-
  origin-only serving, audit rows for every call, idempotency same pattern.
- Tool surface: platform reads (businesses.search/detail, reports, usage,
  audit, system, ai, backup, plans, payments, support, cms) + writes
  (features.set, business.suspend/reactivate, plan.update,
  payments.review, billing.grant_credit [high→approve], business.provision /
  archive [high→approve], knowledge.update, cms.sync, backup.run) +**bridge**
  tools `tenant.tools/list`, `tenant.tools/call` with **explicit businessId +
  locationId**, per-call audit with target business, and
  `tenant.batch.call {businessIds[], tool, args}` returning tenant-by-tenant
  outcomes. Bridge capability mapping: read bridge ⇒ `impersonate.readOnly`,
  write bridge ⇒ `impersonate.full` AND platform approval for high-risk
  tool entries (maker-checker).
- Endpoint `/api/platform/mcp` (POST dispatch; GET = discovery + 401 shaping);
  `.well-known` metadata for the platform realm.
- Management plane `/api/platform/mcp-connections*` (capability
  `admins.manage` or dedicated `mcp.manage` on platform — decided:
  **`integrations.manage` on platform is not in vocabulary; use owner-only
  `admins.manage`? — dedicated `mcp.manage` capability, owner-only**), and a
  console page `/platform/mcp` (connections, pending approvals, audit history
  with search/filters/pagination).

### D. OAuth / transport hardening (D)

- `resource` indicator: validate against issuer when supplied
  (`invalid_target` on mismatch), at authorize + token exchange.
- Refresh replay: reuse of an already-rotated refresh token → revoke the whole
  family (defence-in-depth test).
- Registration abuse: per-business hour-rate cap (existing 50-row cap kept;
  prune: clients with zero connections older than 30 days pruned in
  `sweepExpiredMcpGrants`, capacity recoverable).
- Consent defaults: read-only + approve + finite expiry default; high-risk
  language for apply mode. (UI work below.)

### E. UX (E, existing design system tokens/components)

- Tenant `mcp-panel.tsx`: per-app grants matrix (read/write switches),
  branch selection (multi-select + "all branches" = multi_branch consent),
  expiry (default 180 d), actor, last use, revoke, risk badges; pending queue:
  immutable preview (payload + prior-state diff rendered read-only), stale
  state note, interrupted rows flagged, processing label, refresh-safe decide;
  history tab (applied/failed/dismissed with filters + search + pagination);
  loading/empty/error already patterned elsewhere — reuse InfoBox/ErrorBox,
  risk chips, RTL + responsive.
- Consent form: grants matrix, branch select, expiry, write mode with
  high-risk red explanation, step-up notice for high-risk grants.
- Platform: `/platform/mcp` page (connections + pending + history) and nav
  entry; explicit tenant-target selector for bridge preview.

### F. Dead-code audit (F) & docs (G)

- Audit `src/lib/mcp{,-platform}` for leftovers after refactors (unused
  helpers, duplicated scope parsing). Consolidate registry as the single
  metadata source. Check dynamic imports/jobs before deleting anything
  (`rg` sweeps: isX/isMcpX callers, sweepExpiredMcpGrants wiring, etc.).
- Docs: update `docs/mcp/issue-883-authorization.md`; new
  `docs/mcp/coverage-matrix.md` (machine-reviewable); threat-model addendum;
  platform-MCP security section.

## Completion gates

- typecheck, eslint, unit (new), integration (new, real PG, 2 businesses ×
  2 branches, roles owner/manager/cashier, platform roles support/engineer/
  owner, both origins), production build.
- Visual attribution verdict + fix or reviewed baseline.
- PR opened from the branch; CI green on final SHA; matrix attached.
- Anything not genuinely delivered is reported under "Genuine remaining
  issues" — never claimed.
