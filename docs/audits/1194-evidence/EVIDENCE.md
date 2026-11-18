# ESH-96 / GH #1194 — Windows installer evidence, collected 2026-11-18

**Status: unsigned-development packaging evidence only. No signed installer scan and no
Full Offline acceptance run exists anywhere in this repository's CI history, so the
"signed installer scan + both-mode Windows acceptance" the ticket asks for cannot be
attached from the current artefacts.**

## What CI has actually produced

Run: <https://github.com/hamidnoshady/biza-miz/actions/runs/44277108577>
Workflow: `build-desktop-installer`, job `packaged Windows end-to-end` (windows-latest)
Commit: `0929821b3ff0e7f755cba63a5bcdb6c6de04b555` (main), 2026-11-18, conclusion **success**.

Relevant steps:

| Step | Result |
| --- | --- |
| Verify explicit unsigned-development status | success — `UNSIGNED DEVELOPMENT ARTIFACT (not eligible for production release)` |
| Release scan — no test bootstrap and no Central privileges in the payload | success — `Desktop release scan passed. Report: desktop-release-scan.json` |
| Install and run actual packaged desktop twice as a standard user | success (09:48–10:04Z) |

### `desktop-release-scan.json`

- `ok: true`, `findings: []`
- installer: `Bizamiz Setup 1.0.197.exe`, 180,102,193 bytes,
  sha256 `9b800aa326eb222373c955c4334b7e42596229bd5efed3f8239c7b23b789b438`
- installer extraction: attempted, `ok: true`, 1 nested archive, "Scanned 2 extracted tree(s)"
- payload: 9,184 files / 715,535,452 bytes; `resources/app.asar` 2,261 entries
- rules applied: 8 text markers (smoke env, smoke probe, mock activation, smoke owner
  password, platform seed password/script, private signing material) and 7 path rules
  (Central platform pages/API, probe file, seed file, private key, source/test, env file)

### `windows-signature-verification.json`

Mode `unsigned-development`; both `win-unpacked/Bizamiz.exe` (sha256
`ca728c7455252f06ae6046da56e7a8e3a1820029d200435a89f722ee5465505f`) and the NSIS
installer are `NotSigned`. This is a development artefact, not the signed release.

### Windows acceptance (Hybrid path), from the harness log

- fresh non-elevated install, app served on `http://127.0.0.1:3000`
- real `POST /api/setup/bootstrap` created the Owner (second factor sms_otp, 10 recovery codes)
- Owner password accepted, wrong password rejected
- "the installed runtime denied every platform-realm probe with 404"
  (`/platform`, `/platform/login`, `/api/platform/auth/login`, `/api/platform/auth/me`,
  `/api/platform/mcp`)
- instance identity stable across restart: `9fd89559-5ab5-4374-9403-320ec67d2a5a`
- existing Owner credentials still work after restart; installed-payload scan clean
- **skipped:** clean-shutdown assertions on each launch, because the runner session has
  no window (`window=0`); the harness force-stopped the app and the restart exercised the
  abrupt-stop recovery path instead

## What is missing, and why it cannot be attached

1. **Signed installer bytes do not exist.**
   `windows-signed-candidate.yml` is `workflow_dispatch`-only and has **0 runs**;
   `windows-11-release.yml` has **0 runs**; the repository has **0 releases**.
   Therefore no `desktop-release-scan.json` or `signed-candidate-release-scan.json` bound
   to signed bytes exists to attach. The hardware/secret prerequisites are absent too:
   the workflow fails closed without `WINDOWS_SIGNING_PROVIDER`,
   `WINDOWS_EXPECTED_SIGNER`, `WINDOWS_EXPECTED_SIGNER_THUMBPRINT`,
   `DESKTOP_RELEASE_PUBLIC_KEY_PEM` and the provider credentials
   (`WINDOWS_CSC_LINK`/`WINDOWS_CSC_KEY_PASSWORD`, certificate-store runner, or
   `AZURE_TRUSTED_SIGNING_*` + Azure client secrets) in the protected
   `windows-production` environment.
2. **Full Offline has never been exercised.**
   The harness's Full Offline phase needs `DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL`
   (repository variable) and `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN` (secret). Both were empty
   in run 44277108577 (`DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL:` / `..._TOKEN:` with no
   value), so the phase reported `skipped`. Only the Hybrid path has Windows evidence.
3. Independent on-device assessment (recovery, in-place upgrade, retail Windows 11) is the
   `windows-11-release` workflow, which has never run.

## How to produce the missing evidence

1. Trigger `windows-signed-candidate` with `version` (X.Y.Z), `candidate_commit` (full SHA
   of the commit that owns the workflow file) and `channel` on the protected environment.
   It builds, signs, then runs
   `node scripts/scan-desktop-release.mjs --payload=electron/dist/win-unpacked
   --installer="electron/dist/Bizamiz Setup <version>.exe" --output=desktop-release-scan.json
   --require-installer-extraction` and uploads
   `business-suite-windows-<version>-release-scan`.
2. Set the repository variable `DESKTOP_ACCEPTANCE_OFFLINE_CLOUD_URL` and the secret
   `DESKTOP_ACCEPTANCE_OFFLINE_TOKEN` (real staging Cloud) so the Full Offline phase stops
   reporting `skipped`.
3. Trigger `windows-11-release` with `version`, `candidate_commit`, `candidate_run_id`,
   `previous_run_id`, `previous_version`, `previous_artifact` and
   `uac_cancellation_evidence_url`. It re-scans the downloaded signed installer on the
   retail machine before installing and runs fresh install, abrupt-stop recovery,
   in-place update and uninstall/data-preserved acceptance, uploading
   `windows-11-release-evidence.json` + `signed-candidate-release-scan.json`.

## Files in this folder

- `desktop-release-scan-1.0.197.json` — archived copy of the CI-generated `desktop-release-scan.json`
  for the unsigned 1.0.197 development installer (run above). Renamed on archiving because
  `.gitignore` ignores the working filename `desktop-release-scan.json`; the content is the
  report exactly as the job uploaded it.
- `windows-signature-verification.json` — proves that artefact is `NotSigned`
- `windows-acceptance-2026-11-18.log` — acceptance/scan/signing lines from the same job
