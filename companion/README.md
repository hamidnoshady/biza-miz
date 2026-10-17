# Biza Support Companion (issue #984)

The standalone Windows diagnostics companion: its own runtime and UI, able to
run while the main Business Suite app is broken, online (hybrid) or fully
offline. This directory holds the .NET 10 sources; the desktop shell launches
the installed companion via `electron/support-companion.js`, and the server
side (enrollment, offline tokens, artifacts, repair workflows, remote
assistance) lives under `src/lib/support-companion/` + `src/app/api/`.

## What exists today (Core slice)

`src/Biza.SupportCompanion.Core` (`net10.0-windows`, **base framework only —
zero packages**) plus xUnit tests in `test/`:

| File | Contract |
|---|---|
| `CompanionPaths.cs` | Install locations (`%ProgramFiles%` → `%LocalAppData%`, `BIZA_SUPPORT_COMPANION_EXE` override). Must match `electron/support-companion.js`. |
| `SupportProtocol.cs` | The `biza-support://ticket/{id}` / `biza-support://open` link shape. |
| `OfflineTokenVerifier.cs` | ES256 offline on-site token verification (CNG `ECDsa`), error-for-error parity with server `verifyOfflineToken` (`malformed`/`unknown_key`/`invalid_signature`/`wrong_audience`/`expired`/`not_yet_valid`). Deliberate delta, documented in code: `exp`/`nbf` are required locally — a timeless token must never verify offline. |
| `Dpapi.cs` | Current-user DPAPI protect/unprotect via `crypt32.dll` P/Invoke (no `ProtectedData` package, by design). |
| `MaintenanceLock.cs` | The cross-runtime maintenance gate: `%ProgramData%\Biza\maintenance.lock` held with `FileShare.None` (`BIZA_MAINTENANCE_LOCK` override). The open handle is the lock, so crashes release it. |
| `Redactor.cs` | Evidence redaction with parity to `redaction.ts` + `error-report.ts` (same blocked fields, same four secret patterns, tenant-attribution filter, exclusion counts). |

The offline-token tests embed vectors minted by the real server signer
(`jose` ES256) — true cross-runtime proof; the minting key was discarded.

Validated by the `companion` workflow (`.github/workflows/companion.yml`):
Windows build + `dotnet test` on every PR/push touching `companion/`.

## Gaps (explicit, not forgotten)

- **WPF shell + installer**: no UI, no MSIX/NSIS packaging, no
  `biza-support://` protocol registration, no `%ProgramData%\Biza` ACL setup
  yet. The launcher contract (`CompanionPaths`) is pinned so the installer
  cannot drift from the shell.
- **Companion ↔ server flows**: enrollment claim, artifact chunk upload,
  repair-executor (signed recipes, consent, backups, audit), MeshCentral
  agent presence, and update channel (rides Central #981 authority on a
  separate channel — same RSA manifest key). Server endpoints exist; the
  companion HTTP/auth client does not.
- **Main-app side of the maintenance gate**: Electron/Next must adopt the
  same lock path before the gate is real (currently only the companion
  defines it).
- **Signing**: no certificates are invented here — the companion ships
  unsigned until the release-signing setup is documented and provisioned
  (same rule as the rest of #984: exact external setup gaps, never fake
  credentials).
