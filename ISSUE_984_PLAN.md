# Issue #984 — plan: ticket-driven diagnostics, on-site tokens, Support AI

Owner instruction received 2026-10-17 (“develop by the issue”): this lifts the
epic’s planning-only gate **for the in-repo server/web scope below**. The
native Windows companion, remote-engine vendor qualification, production
signing and real-Windows packaging matrices remain blocked follow-ups (see §8)
— they need a Windows machine, a vendor decision and signing infrastructure
this sandbox cannot provide.

Source: epic #984 + coding-agent prompt (#984, comment 6222384923) +
ticket-workspace amendment (comment 6222916906) + support-only/token/AI
amendment (comment 6223078318). Policy precedence: #974 (activation, online
support submission), #956 (Secure Connect), #981 (Central-managed updates)
stay authoritative; this work reuses their identities/policies and adds no
second updater, sync authority, ticket system or AI stack.

## 1. What ships in this change (server + web, in this repo)

1. **Platform capabilities** (`src/lib/platform-admin.ts`): separately
   enforceable companion authorities; `support.manage` alone grants none of
   them. Role mapping is least-privilege (support < engineer < owner).
2. **Migration 0228**: ticket-linked support records with same-migration RLS
   and scope-safe relationships; a global signed repair catalog; issuance/
   redemption journals. No secrets, no token plaintext, no large payloads in
   ticket message text.
3. **Services** (`src/lib/support-companion/`): diagnostic requests/runs,
   Ed25519-signed on-site tokens + atomic online codes, assistance session
   state machine with short leases, repair catalog + run receipts, consent
   journal, redaction, and ticket-scoped Support AI reusing the canonical
   gateway/runtime (`runAgentTurn` + `executeReadTool` realm) with support
   cost attribution — never the tenant wallet.
4. **APIs**: platform orchestration routes under `/api/platform/support/*`,
   companion routes under `/api/support-companion/*` (device credential for
   pending-request poll; redeemed ticket-bound session JWT for everything
   else), and member read/Stop routes for their own ticket’s diagnostics.
5. **Console UI**: the existing Support → ticket drawer becomes the workspace
   (Conversation · User & installation · Diagnostics & repairs · Remote
   assistance · On-site token · Support AI · History), reusing platform
   primitives, Persian RTL and Jalali dates.
6. **Tests**: unit (capabilities, crypto round-trip, state machines,
   redaction, permission intersection) + real-DB integration (RLS, flows,
   atomic redeem, cross-tenant rejection).

## 2. Deliberate boundaries (what this change does NOT do)

- No native companion (.NET/Electron), no remote media/input transport, no
  provider integration. Assistance sessions manage request/consent/lease/
  revoke records; `engine_binding` carries an explicit `provider: "none"`
  until a qualified engine is selected (Phase 0 decision, still open).
- No arbitrary command/SQL/shell execution anywhere. Support AI tools are a
  fixed allowlist (read redacted evidence, request diagnostics, propose
  catalog repair); repair *execution* always requires operator approval at
  the action boundary + local consent + postchecks.
- No tenant-wallet billing for Support AI; no tenant virtual-key minting.
- No `withoutTenantScope` additions: platform routes already run under the
  documented `platform` bypass; companion routes derive scope server-side
  from verified credentials/tokens.

## 3. Capabilities (all enforced server-side, re-checked per action)

| Capability | support | engineer | owner |
|---|---|---|---|
| `support.context.read` | ✓ | ✓ | ✓ |
| `support.reports.read` | ✓ | ✓ | ✓ |
| `support.diagnostics.request` | – | ✓ | ✓ |
| `support.repair.propose` | – | ✓ | ✓ |
| `support.assist.view` | – | ✓ | ✓ |
| `support.assist.revoke` | – | ✓ | ✓ |
| `support.token.issue` | – | ✓ (+recent MFA) | ✓ (+recent MFA) |
| `support.ai.use` | – | ✓ | ✓ |
| `support.repair.execute` | – | – | ✓ |
| `support.assist.control` | – | – | ✓ |
| `support.repair.publish` | – | – | ✓ |
| `support.ai.configure` | – | – | ✓ |

Token issuance and remote assistance additionally require a fresh MFA session
(`mfaVerified`), matching the impersonation route’s precedent.

## 4. Data model (migration 0228)

Tenant tables (all `business_id`, `ENABLE+FORCE RLS`, `tenant_isolation`
policy, FKs carrying `business_id` where the parent is tenant-scoped):

- `support_installations` — verified Windows installation bound to
  `site_devices(id, business_id)`; `generation` fencing, enrollment state,
  versions, capabilities, last contact, revocation. Unique
  `(business_id, site_device_id)`.
- `support_diagnostic_requests` — ticket + installation + generation,
  initiator, modules, reason, allowed ops, expiry, idempotency key (unique
  per business), state, immutable `context_snapshot`.
- `support_diagnostic_runs` — request → run states incl. partial/failed/
  cancelled/declined; versions, coverage, redacted findings, upload state
  (`not_sent` until server ack → `received`); idempotent completion.
- `support_diagnostic_artifacts` — metadata only (manifest, sha256,
  storage key, redaction summary, expiry); bytes live outside ticket text.
- `support_repair_runs` — recipe id/version/hash, actor, consent ref,
  preconditions, backup ref, before/after findings, verification, receipt;
  terminal states never reactivated by replay.
- `support_assistance_sessions` + `support_assistance_events` — requested/
  approved caps (view/input/elevation separate), consent proof, lease epoch
  + expiry (≤30s without renewal), end/revoke reason. Separate from
  `impersonation_grants`; neither grant authorises the other.
- `support_access_tokens` — issuance records: fingerprint (never plaintext),
  purpose (`online_code` | `offline_onsite`), scope, reason, expiry
  (default 30 min, bounded), one-use journal, revocation.
- `support_token_redemptions` — redemption journal (challenge binding,
  technician-device fingerprint, result).
- `support_consent_events` — durable customer consent/Stop journal per
  subject (diagnostics/repair/view/control).
- `support_ai_conversations` + `support_ai_messages` +
  `support_ai_tool_events` — ticket-scoped, operator-owned, support cost
  attribution; raw tenant evidence never leaves ticket scope.

Global: `support_repair_catalog` (recipe id + version PK, risk,
compatibility, preconditions/effects/postchecks, `recipe_hash`,
publisher approval, active flag) — platform-owned like other
`platform_*` policy tables.

States mirror the epic’s transition diagrams; every table keeps created/
updated/observed/received timestamps separately.

## 5. Token design (mirrors `site-device-service` hash-only discipline)

- **Online code**: short one-time human code; only `sha256` stored; redeem
  is one atomic `UPDATE … WHERE state='pending'` (no double-redeem);
  30-minute default lifetime; redeems server-side into a ticket-bound
  support session JWT (Ed25519, 15-min default, claims: token id, ticket,
  business, installation + generation, operator, scope, audience
  `support-companion`).
- **Offline on-site token**: signed JWT (Ed25519) with the full claim set
  from the amendment (incl. challenge/nonce binding + technician
  proof-of-possession fingerprint); verifiable without DB/internet against
  approved public keys; fails closed on uncertain clock/integrity.
- Signing keys: `SUPPORT_TOKEN_SIGNING_KEY` (JWK, server-only, never in
  tokens/reports/tickets); key id (`kid`) rotation keeps old public keys
  for verification during overlap.
- Ticket stores fingerprint/scope/expiry/redemption — never plaintext.

## 6. Support AI (reuse, not a fork)

- Turn execution calls the canonical `runAgentTurn` with a
  `executeReadTool` realm serving **only** redacted ticket evidence +
  diagnostic results; `businessId` is deliberately absent so no tenant
  credit path can trigger; gateway-reported cost accrues on the
  conversation as platform/support spend.
- Tool allowlist: `support.evidence.read`, `support.diagnostics.request`,
  `support.repair.propose`, `support.report.summarize`. No shell/SQL/
  codegen tool exists to be granted.
- Permission intersection enforced outside the model at every tool call:
  operator caps ∩ ticket/installation scope ∩ live authorization ∩ recipe
  policy ∩ customer consent. Prompt injection cannot widen scope (tools
  take server-resolved ids, never model-supplied business/ticket ids).
- Model profiles: named aliases resolving through LiteLLM gateway config;
  advanced profiles selectable only with `support.ai.configure`-published
  entries; unsupported settings rejected, not silently claimed.
- Gateway outage ⇒ deterministic local investigation summary remains;
  outage never blocks opening diagnostics.

## 7. Verification

- `npx tsc --noEmit`, `npm run lint`, `npm test` (unit),
  `npm run test:db` (integration incl. new RLS/flow suites), `npm run build`.
- Exact results recorded in the final report; genuine remaining issues stay
  open — no weakened assertions, no placeholder transports.

## 8. Blocked / follow-up (needs Windows, vendor or owner decision)

Status key: DONE = implemented + tested on this branch; OPEN = still ahead.

1. Native companion app (.NET 10, base-framework-only Core + thin WPF
   shell + DPAPI via P/Invoke) + independent installer/updater/rollback +
   maintenance gate + Windows CI (epic Phases 0–1, 7): **OPEN**. Server
   contracts are frozen: enrollment, token redeem, requests poll, runs,
   artifacts, repairs, assistance, consent.
2. Remote engine: **DECIDED** = self-hosted MeshCentral; the broker
   (`remote-broker.ts`, share create/revoke wired into join/terminate, URL
   never stored) is **DONE** against a source-verified protocol with fake-
   transport tests. **OPEN**: MeshCentral provisioning (server, service
   user, per-tenant meshes, agents) and the live-server conformance
   checklist — see `docs/support-companion.md` §2–3.
3. Token signing keys: ceremony/runbook **DONE** (`scripts/mint-`
   `support-keys.mts`, `.env.example`, `docs/support-companion.md` §1);
   **OPEN**: production key generation by the operator (never in-repo).
   Retention sweep **DONE** (`runSupportRetentionSweep` + scheduler note).
   Artifact bytes live in-DB (`payload` bytea, 8 MiB cap); S3/object-store
   wiring is **OPEN** (the `storage_key` shape is already store-compatible).
4. Real-Windows failure-matrix runs (main/DB/network down), RTL/a11y pass
   on the new drawer tabs, pilot + runbooks (Phase 7): **OPEN**.
5. Offline token algorithm: **CHANGED** by decision — ES256 (P-256), because
   .NET ships ECDSA but not Ed25519 in-box. Server session JWTs stay
   Ed25519; the two key sets are independent (`SUPPORT_TOKEN_*` vs
   `SUPPORT_OFFLINE_TOKEN_*`).
6. Companion device identity: **CHANGED** by design review — an independent
   support-device credential (enrollment attested by the owner's claim
   code), never the main app's sync bearer. Migration 0229; staged
   rotation with 24 h overlap.
