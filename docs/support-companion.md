# Windows Support Companion — server operator guide (issue #984)

The companion is a standalone .NET 10 runtime on the customer's Windows
machine. It survives the main app being broken: it authenticates with its
own **support-device credential** (never the main app's sync bearer, which
lives in the main database — exactly what is unavailable when the companion
matters most), and works fully offline with ticket-issued signed tokens.

## Server pieces (all in this repo)

| Piece | Code | State |
|---|---|---|
| Enrollment (owner begins → companion completes with a locally generated secret, staged rotation) | `src/lib/support-companion/device-credentials.ts`, `src/app/api/support/installations/enrollment`, `src/app/api/support-companion/enrollment` | implemented + integration-tested |
| Ticket-issued tokens (online one-time codes, ES256 offline QR/import) | `access-tokens.ts` | implemented + tested |
| Diagnostics (requests, redacted runs, chunked artifact upload) | `diagnostics.ts`, `artifacts.ts`, `redaction.ts` | implemented + tested |
| Repair catalog/runs (signed recipes, consent, transitions) | `repair-catalog.ts` | implemented + tested |
| Assistance sessions (consent, lease, Stop/revoke, MeshCentral share bind) | `assistance.ts`, `remote-broker.ts` | implemented + tested against a fake transport; **live-server conformance still open** (below) |
| Support AI (permission intersection, spend ceiling) | `support-ai.ts` | implemented + tested |
| Retention sweep (expired bytes, stale uploads, spent claims) | `runSupportRetentionSweep` in `artifacts.ts` | implemented + tested |

Schema: migrations `0228` (foundation), `0229` (device credentials,
enrollments, artifact chunks), `0230` (MeshCentral node link). All tables
are RLS-forced with `tenant_isolation` policies.

## External setup the operator must provide

### 1. Token signing keys (required for any on-site token)

Two independent JWK key sets (see `.env.example`):

- `SUPPORT_TOKEN_*` — Ed25519, server-minted + server-verified session JWTs.
- `SUPPORT_OFFLINE_TOKEN_*` — P-256 (ES256), offline tokens the .NET
  companion verifies with in-box ECDSA.

Generate with `npx tsx scripts/mint-support-keys.mts`, store both private
JWKs in the deployment's secret manager, and ship the **public** halves in
the companion's approved-keys bundle. Rotation: add the new public JWK to
the bundle first, then flip the signing key; `kid` selects.

### 2. MeshCentral server (required for remote assistance)

Without it, assistance sessions stay records-only and operator join refuses
with `provider_not_configured` — by design, never faked.

Provisioning checklist (all outside this repo):

1. Deploy self-hosted MeshCentral (Node.js) with TLS; note its origin.
2. Create a **service user** (e.g. `biza-support`) with rights **only** on
   the support device groups (mesh scopes), no server-admin rights.
3. Create one device group (mesh) per tenant boundary you need isolated,
   with consent flags that match policy (the broker always requests
   desktop-notify + connection toolbar on its shares; server-side
   `userConsentFlags` can only add prompting, never remove the broker's).
4. Set `MESHCENTRAL_URL` (origin, e.g. `https://mesh.example.com`),
   `MESHCENTRAL_USER`, `MESHCENTRAL_PASS`. Self-signed/private-CA TLS
   needs the explicit `MESHCENTRAL_ALLOW_SELF_SIGNED_TLS=true` opt-in.
5. Install the MeshCentral agent on each attended machine (the companion
   reports the agent's node id on its poll; join refuses with
   `agent_not_linked` until then).

Wire protocol reference: `wss://{host}/control.ashx` + `x-meshauth`
header, `createDeviceShareLink` / `removeDeviceShare` actions — verified
against MeshCentral's own `meshctrl.js` (`DeviceSharing` command).

### 3. Live-server conformance (not yet run — no instance exists)

When a MeshCentral instance is available, run this checklist before
calling remote assistance done:

1. Bind: approved view session → join returns a guest URL; agent shows
   notify banner + toolbar; desktop is view-only.
2. Bind: approved control session → operator can input; toolbar Stop on
   the agent side ends the share.
3. Revoke: operator revoke + customer Stop both kill the share within
   seconds (`engine_unbound` event, no `engine_revoke_failed`).
4. Expiry: kill the broker's network mid-session, confirm the share dies
   at its `end` and the event journal shows `engine_revoke_failed`.
5. Isolation: a share for tenant A's node is unreachable from tenant B's
   operator session (different mesh / user rights).

### 4. Companion packaging (not yet built — tracked in #984)

The C# companion, its installer, the maintenance gate (cross-runtime lock
file with the main app), update channel on Central #981 release authority,
and Windows CI are still ahead. The server contracts they must speak are
frozen by this branch: enrollment, token redeem, requests poll, runs,
artifacts, repairs, assistance, consent — see
`src/app/api/support-companion/` and the integration suite.

## Scheduler wiring

Call `runSupportRetentionSweep()` from the deployment's janitor tick (same
place the data-transfer queue ticks run). It purges expired artifact bytes
(metadata tombstones stay), rejects abandoned uploads, and deletes spent
enrollment claims. Idempotent; returns counts for the job log.
