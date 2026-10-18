# Companion packaging (issue #984)

## Build the shippable EXE

Self-contained single-file (no .NET runtime needed on the target):

```powershell
dotnet publish companion/src/Biza.SupportCompanion.App/Biza.SupportCompanion.App.csproj `
  -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -o publish
```

No trimming (WPF + reflection JSON), no packages (Core and App are both
base-framework-only; restore needs no network beyond the SDK).

## Install layout (pinned — the shell and installer must not drift)

| What | Per-user (default) | Machine (`-Machine`) |
|---|---|---|
| EXE | `%LocalAppData%\Biza Support Companion\BizaSupportCompanion.exe` | `%ProgramFiles%\Biza Support Companion\BizaSupportCompanion.exe` |
| Protocol | `HKCU\Software\Classes\biza-support` | `HKLM\SOFTWARE\Classes\biza-support` |
| Data (per-user, always) | `%LocalAppData%\Biza\SupportCompanion` | same (each account enrolls separately) |

The EXE paths are the `CompanionPaths` / `electron/support-companion.js`
contract — change all three or none. The data dir holds `settings.json`,
`device-credential.dat` (current-user DPAPI), `reports/`, `journal/`,
`logs/`, `staging/`, `pending-challenge.txt`, `offline-keys.json`
(poll-cached), and `update-keys.json` (below).

The maintenance lock file lives machine-wide at
`%ProgramData%\Biza\maintenance.lock`. Standard users cannot create that
directory, so a `-Machine` install (or the main app's admin installer, or
an admin one-liner) must create `%ProgramData%\Biza` once with a
Users-write ACL — `install.ps1 -Machine` does it. Per-user-only machines
without that directory get an honest "gate unavailable" refusal from the
Repairs tab instead of a misleading "busy"; `BIZA_MAINTENANCE_LOCK` points
both runtimes at a per-user path for labs and tests.

Install/uninstall:

```powershell
.\install.ps1 -SourceDir .\publish            # per-user, no admin
.\install.ps1 -SourceDir .\publish -Machine   # elevated prompt
```

There is no MSIX/NSIS wrapper yet — the script above plus the signed EXE
is the install story until a wrapper is justified. Uninstall = delete the
install dir + the protocol key (+ the data dir to forget the enrollment).

## Update keys (external setup, exact gap)

`update-keys.json` in the data dir is the release authority's approved RSA
bundle the updater verifies manifests against — the same key discipline as
#981's update channel. Provisioning it is an operator step, not code:

1. The release authority publishes its RSA public keys as
   `update-keys.json` (`{"keys": [{"kid": ..., "n": ..., "e": ...}]}` —
   the shape `UpdateManifest` parses).
2. The operator copies that file into the data dir (or ships it next to
   the installer and copies it during provisioning).
3. The Updates tab verifies channel manifests against it; without the
   file, update checks report "not provisioned" instead of guessing.

Key rotation = replace the file (a poll-served rotation is a follow-up).

## Publishing an update channel (operator step)

The Updates tab consumes a static file set per channel — no server code
is involved; the RSA signature (not the transport) is the trust root.
For channel `stable` at base URL `https://updates.example.com/stable/`:

1. `stable.json` — the manifest: `{"channel": "stable",
   "version": "0.2.0", "kid": "<key id>", "files": [{"path":
   "BizaSupportCompanion.exe", "bytes": 123456789, "sha256":
   "<hex>"}]}`. Paths are relative, install-dir rooted, `/`-separated.
2. `stable.json.sig` — the manifest signature: base64url of the
   RSA-PKCS#1v1.5+SHA256 signature over the *canonical* manifest JSON
   (keys sorted, no whitespace — see `CanonicalJson`), as raw text.
3. One file per `files[]` entry, at base URL + `path`, byte-identical to
   what the manifest hashes.

The companion verifies (channel match, version upgrade over its own,
signature against `update-keys.json`), downloads each file (512MB cap),
re-hashes every byte before staging, and only then offers Install &
restart.

Build the channel with the script — never hand-write the manifest:

```powershell
# From a companion-release run: download the unsigned EXE artifact, then:
npx tsx scripts/build-companion-update.mts `
  --exe BizaSupportCompanion.exe --version 1.2.0 `
  --channel companion-stable --kid release-1 --out channel/
# → channel/companion-stable.json + channel/BizaSupportCompanion.exe
# (unsigned: no .sig yet)
```

Then sign offline with the release RSA key — the SAME key as the #981
desktop channel (`DESKTOP_RELEASE_PRIVATE_KEY_PEM`), one release
authority for both channels:

```powershell
$env:DESKTOP_RELEASE_PRIVATE_KEY_PEM = Get-Content release-key.pem -Raw
npx tsx scripts/build-companion-update.mts `
  --exe BizaSupportCompanion.exe --version 1.2.0 `
  --channel companion-stable --kid release-1 --out channel/
# → also writes channel/companion-stable.json.sig (base64url RSA-SHA256
# over the canonical manifest bytes, self-verified before writing)
```

Serve the three files statically at the channel base URL. The `kid`
must name the key in the companions' `update-keys.json` bundles (see
"Update keys" above); a `kid` the bundle does not know fails
closed on every machine. Without the private key only the unsigned
output exists, and the companion refuses unsigned channels — by design,
never served.

## Signing (external setup, exact gap)

No certificates exist in this repo and none are invented. Until the
release-signing setup is provisioned, `install.ps1` reports `UNSIGNED`
and proceeds (lab/dev installs). Before any production distribution:

1. Provision a code-signing certificate the build can reach (exact
   mechanism TBD — `.pfx` in CI secrets or a cloud signer; not chosen).
2. Sign the published EXE, e.g.
   `signtool sign /fd SHA256 /a publish\BizaSupportCompanion.exe`.
3. Re-run `install.ps1`, which verifies and prints the signer.

The release workflow uploads the EXE as `-unsigned` and says so in its
summary, so an unsigned build can never be mistaken for a release.
