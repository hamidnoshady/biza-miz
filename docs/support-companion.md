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
| Assistance sessions (consent, lease, Stop/revoke, MeshCentral share bind) | `assistance.ts`, `remote-broker.ts` | implemented + unit-tested; broker protocol conformant live (§3); attended-hardware checks open |
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

### 3. Live-server conformance (protocol layer green; hardware layer open)

`src/lib/support-companion/remote-broker.live.test.ts` runs the
automatable slice against a real server (skipped without
`MESHCENTRAL_LIVE_NODE`). First green run: MeshCentral 1.2.5 with a real
online Linux agent, 2026-10-18 — 6/6 live assertions:

- Bind: view-only and control sessions return a real guest URL, and the
  URL serves HTTP 200 while live.
- Revoke: kills the share (`result: 'OK'`); a second revoke reports the
  already-gone shape and still resolves success, so operator-revoke +
  customer-Stop races land without a spurious `engine_revoke_failed`.
- Honest failures: unknown node → `Invalid node id`; rights-less user
  binding another tenant's node → `Access denied` (isolation at the
  bind layer).
- Expiry: the guest URL serves 200, then 404 after `end`; post-expiry
  revoke resolves success.

Two wire discoveries from that run are now in the broker: the server
echoes `removeDeviceShare` (and `createDeviceShareLink`) back with our
`responseid` *before* the verdict, so the transport only resolves on
messages carrying `result` (before the fix, every revoke failed); and the
already-gone verdict is `Invalid device share identifier.`, which the
broker maps to success.

One-time setup for a re-run: `npm i meshcentral`, create an admin
account offline (`--createaccount`), launch with a dotted `--cert` name
(bare names force LAN mode, which withholds the agent server URL),
`createmesh` over `control.ashx`, download the `meshinstall` agent for
the mesh, run it with its `.msh`, and export the resulting node id as
`MESHCENTRAL_LIVE_NODE` (plus an unprivileged account for the isolation
case). Re-run before every release that touches the broker.

Still needing attended hardware + a browser (not covered above):

1. View session: agent shows the notify banner + toolbar; the guest
   desktop is pixels-view-only.
2. Control session: operator input reaches the desktop; toolbar Stop on
   the agent side ends the share.
3. Network-kill mid-session: revoke fails unreachable, the event journal
   shows `engine_revoke_failed`, and the share still dies at its `end`
   (the journal path is unit-tested with a failing transport; only the
   physical kill is unobserved).

### 4. Companion packaging (built — signing/keys still external)

The C# companion ships from `companion/`: the Core library (offline
verify, diagnostics catalog, repair executor, update verifier), the WPF
app (enrollment → authorize → diagnostics → repairs → assistance →
updates), the bilateral maintenance gate (C# lock + Electron claim in
`electron/maintenance-gate.js`, wired into the desktop update install),
and Windows CI (`companion.yml` build/test/publish-smoke) plus the manual
`companion-release.yml` packager. Server contracts are frozen:
enrollment, token redeem, requests poll (now with `offlineKeys` +
`meshAgentPresent`), runs, artifacts, repairs (POST transitions + the
`GET repairs/[runId]` run/recipe fetch), assistance, consent.

Still external (exact steps in `companion/packaging/README.md`): the
code-signing certificate (builds upload `-unsigned`), and the RSA
`update-keys.json` bundle the operator places in the companion data dir.

## Scheduler wiring

Call `runSupportRetentionSweep()` from the deployment's janitor tick (same
place the data-transfer queue ticks run). It purges expired artifact bytes
(metadata tombstones stay), rejects abandoned uploads, and deletes spent
enrollment claims. Idempotent; returns counts for the job log.
