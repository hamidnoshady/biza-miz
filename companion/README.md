# Biza Support Companion (issue #984)

The standalone Windows diagnostics companion: its own runtime and UI, able to
run while the main Bizamiz app is broken, online (hybrid) or fully
offline. This directory holds the .NET 10 sources; the desktop shell launches
the installed companion via `electron/support-companion.js`, claims the
cross-runtime maintenance gate via `electron/maintenance-gate.js`, and the
server side (enrollment, offline tokens, artifacts, repair workflows, remote
assistance) lives under `src/lib/support-companion/` + `src/app/api/`.

Everything here is base-framework-only — Core and App reference zero NuGet
packages, so a build needs nothing beyond the .NET 10 SDK.

## Core library (`src/Biza.SupportCompanion.Core`, `net10.0-windows`)

| File | Contract |
|---|---|
| `CompanionPaths.cs` | Install locations (`%ProgramFiles%` → `%LocalAppData%`, `BIZA_SUPPORT_COMPANION_EXE` override). Must match `electron/support-companion.js`. |
| `SupportProtocol.cs` | The `biza-support://` link shapes: `ticket/{id}`, `open`, and owner-transferred `enroll?server=&id&claim` (shape only — the claim redeem is the credential). |
| `OfflineTokenVerifier.cs` | ES256 offline on-site token verification (CNG `ECDsa`), error-for-error parity with server `verifyOfflineToken`. Deliberate delta, documented in code: `exp`/`nbf` are required locally. |
| `Dpapi.cs` | Current-user DPAPI protect/unprotect via `crypt32.dll` P/Invoke (no `ProtectedData` package, by design). |
| `MaintenanceLock.cs` | The cross-runtime maintenance gate: `%ProgramData%\Biza\maintenance.lock` held with `FileShare.None` (`BIZA_MAINTENANCE_LOCK` override), plus the Electron claim protocol (`maintenance.electron.<pid>.claim` + mtime heartbeat): live claims refuse, dead-PID claims are collected, PID-reuse with a cold heartbeat is collected, everything else fails conservative. |
| `Redactor.cs` | Evidence redaction with parity to `redaction.ts` + `error-report.ts` (same blocked fields, same four secret patterns, tenant-attribution filter, exclusion counts). |
| `CanonicalJson.cs` | JS-compatible canonical JSON + sha256 recipe hashing; seed vectors pin the server's `recipe_hash` values cross-runtime. |
| `OperationJournal.cs` | Hash-chained `operations.jsonl` (genesis `GENESIS`, torn-tail refusal, per-run reads). |
| `RepairExecutor.cs` | The local repair executor: hash-pinned single-verb recipes (`companion.clean_temp`, `companion.rotate_logs`; the six `main.*` verbs are named-unsupported, never faked), dry-run plans with drift refusal, staged effects with rollback-or-`recovery_required`, gate holding, postchecks-before-success, receipts. |
| `RepairEnvelopeBuilder.cs` | The server→executor seam: run + catalog recipe → verified envelope (authorized-only, installation/ticket/version match, Windows platform, hash re-verified). Tested against the seed fixtures end-to-end into `Plan`. |
| `DiagnosticsCatalog.cs` | The 13 bounded offline probes (startup/runtime/storage/database/connectivity), honest `unsupported`/`unavailable` states, redacting report builder, sealed reports + manifest. |
| `UpdateManifest.cs` | RSA-signed channel-manifest verification against a provisioned approved-keys bundle (channel + upgrade-only + safe-path gates). |

xUnit tests in `test/` cover all of the above, including server-minted
cross-runtime vectors (minting keys discarded). Validated by the
`companion` workflow (`.github/workflows/companion.yml`): Windows build +
`dotnet test` + self-contained-single-file publish smoke on every PR/push
touching `companion/`.

## The app (`src/Biza.SupportCompanion.App`, WPF)

`BizaSupportCompanion.exe`: single instance per desktop session, protocol
activations forwarded from second instances, eight tabs, no fabricated
states:

- **Status** — server/enrollment/installation/session states + the
  device-credential poll (requests, consent-awaiting sessions, offline-key
  pinning, Mesh agent presence report).
- **Enrollment** — owner-transferred claim redeem (256-bit credential,
  current-user DPAPI) + rotation; prefilled by `enroll` links.
- **Authorize** — online code redeem, offline challenge/token verify +
  redeem; sessions stay memory-only.
- **Diagnostics** — bounded local runs, sealed offline reports, run upload
  against a ticket request (the only path that clears `not_sent`).
- **Repairs** — run fetch (hash-verified envelope), dry-run plan, bilingual
  customer consent + risk acknowledgement, gated execution with
  executing→terminal reporting back to the ticket.
- **Assistance** — Mesh agent presence, approve-view/control/deny, device-
  credential STOP (never depends on the operator's authorization), 20s
  lease keep-alive.
- **Updates** — signed channel-manifest check against the provisioned
  release keys, then verified download + staging (every byte re-hashed)
  and a generated apply script (waits for exit, moves verified files,
  restarts). Per-machine installs refuse without elevation.
- **Settings** — server/manifest/channel config + offline-bundle export
  (reports + journal + settings zip; no secrets).

Per-user data under `%LocalAppData%\Biza\SupportCompanion`
(`BIZA_COMPANION_DATA` override); each Windows account enrolls separately.

## Packaging & release

- `packaging/install.ps1` — per-user (no admin) or `-Machine` install:
  EXE copy, `biza-support://` protocol registration, `%ProgramData%\Biza`
  gate-dir creation with Users-write ACL (machine installs), signature
  report (unsigned until the signing setup exists — never faked).
- `packaging/README.md` — the pinned layout, `update-keys.json`
  provisioning, and the exact external gaps (signing cert, key bundle).
- `.github/workflows/companion-release.yml` — manual/tag packaging:
  self-contained single-file EXE + SHA-256 + `-unsigned` artifact.

## Gaps (explicit, not forgotten)

- **Signing + release keys**: no certificates or keys are invented here —
  `install.ps1` reports unsigned installs, and update checks report missing
  `update-keys.json`, until both setups are provisioned (exact steps in
  `packaging/README.md`).
- **`main.*` repair verbs**: the six main-app verbs refuse with named
  reasons; the main-app cooperation protocol (verified backend restart,
  cluster-identity checks, signed payload acquisition, …) is unwritten.
- **Mesh agent provisioning**: the companion reports presence; the agent
  installer link still travels out-of-band from the operator, and node-id
  discovery is server-side (broker match on phone-home).
- **MSIX/NSIS wrapper**: the script + signed EXE is the install story
  until a wrapper is justified.
- **Assistance viewer transport**: the operator console opens the
  provider's own viewer at the one-time operator URL; no viewer is
  reimplemented (by design — MeshCentral owns the pixels).
