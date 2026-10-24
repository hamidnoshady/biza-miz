# WordPress plugin updates — build, host, update

The WooCommerce plugin (`wordpress-plugin/pos-accounting-connector/`) is not in the
WordPress.org directory and never will be: its source of truth is this repository.
Since 1.4.0 it carries its own update system (`includes/class-pos-updater.php`), so a
store owner updates it exactly like a directory plugin — from **«افزونه‌ها ←
به‌روزرسانی‌های موجود»**, **«پیشخوان ← به‌روزرسانی‌ها»**, WordPress auto-updates, or
`wp plugin update pos-accounting-connector`.

There are two update sources, and which one a store uses is decided by one constant:

| Mode | Configured by | Version info from | Zip downloaded from |
| --- | --- | --- | --- |
| **Self-hosted** (recommended for networks where GitHub is slow/filtered) | `POS_CONNECTOR_UPDATE_URL` in `pos-accounting-connector.php` — a full `update.json` URL on your own host | your `update.json` | your host, same folder |
| **GitHub** (the default while the URL is empty) | nothing — always available | GitHub releases → tags | GitHub release asset / tag zipball |

Both modes feed the same WordPress update UI. Switching is a one-line change and
never a behavioural one.

## Building a release — the manual workflow

**`.github/workflows/build-plugin-zip.yml`** runs **manually only** — there is no
push, tag or release trigger, on purpose: a build is a release decision.

Run it from GitHub (**Actions → build-plugin-zip → Run workflow**) or the CLI:

```bash
gh workflow run build-plugin-zip.yml -f bump=patch -f notes="چه چیزی عوض شد"
```

Inputs:

- `bump` — `patch` (default) / `minor` / `major`. **Every build bumps the version**;
  there is no "build the same version again" — the workflow refuses if the
  resulting tag already exists, because a version that was already shipped is never
  rebuilt.
- `notes` — the release notes; written into the `readme.txt` changelog and into
  `update.json`. Defaults to «بهبودها و رفع اشکال.» when left empty.

One run does all of this, in order:

0. Checks the resulting tag is free. The check asks with `git tag --list`, whose
   answer is its **output** — it exits 0 either way — and then ends on an explicit
   `exit`. Both details are load-bearing: the runner appends
   `if ((Test-Path -LiteralPath variable:\LASTEXITCODE)) { exit $LASTEXITCODE }`
   to every PowerShell step, so a step ends on whatever exit code it happens to
   leave behind. The original check probed with `git rev-parse -q --verify`, which
   exits **1** when the tag does *not* exist — the healthy case — and that leftover
   1 failed the step every time the version was free (run #101).
1. Computes the next version from `POS_CONNECTOR_VERSION`.
2. Bumps it in the three places the repo rule names (`Version:` header,
   `POS_CONNECTOR_VERSION`, `Stable tag`) and inserts the changelog entry.
3. Builds the **clean zip** — only `pos-accounting-connector/` at the root, nothing
   else (asserted by the workflow: any entry outside the folder fails the build).
4. Generates **`update.json`** (self-hosted mode only) with the new version, the
   notes, and `download_url` pointing at the zip **in the same folder as the
   manifest**.
5. Commits the bump and pushes tag `vX.Y.Z` — so the repo always says which version
   was actually shipped, and GitHub mode keeps working for stores that still use it.
6. Uploads `pos-accounting-connector.zip` (+ `update.json`) as the run's artifact
   `pos-accounting-connector-vX.Y.Z`.

## Hosting it on your own server (self-hosted mode)

1. **Decide the update folder** on a host you control, e.g.
   `https://dl.mybusiness.ir/pos-updates/`. It only needs to serve static files
   over HTTPS.
2. **Set the manifest URL once** in
   `wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php`:

   ```php
   define( 'POS_CONNECTOR_UPDATE_URL', 'https://dl.mybusiness.ir/pos-updates/update.json' );
   ```

   This single line is the whole configuration: the workflow reads it to generate
   the manifest, and every build from this repo carries it. Changing hosts later is
   editing this line and building again.

3. **Build** (workflow above), **download the artifact**, and upload **both files**
   to that folder:

   ```
   https://dl.mybusiness.ir/pos-updates/update.json
   https://dl.mybusiness.ir/pos-updates/pos-accounting-connector.zip
   ```

   The zip file name is fixed (`pos-accounting-connector.zip`) because
   `update.json`'s `download_url` points at it.

4. Done. Every store running a build with that URL checks **your server** on
   WordPress's normal update cycle (twice daily; six-hour cache per store, failures
   retried after fifteen minutes and the last good answer kept), sees the new
   version in «به‌روزرسانی‌های موجود», and installs with one click / auto-update /
   `wp plugin update pos-accounting-connector`.

If the manifest host is down (DNS, firewall, TLS), stores keep the last **successful**
check on file; the plugin shows a quiet notice on «اشوبه ← به‌روزرسانی» instead of
spamming the event log on every retry. To fall back to GitHub until your server is
fixed, set `POS_CONNECTOR_UPDATE_URL` to `''` in `pos-accounting-connector.php` (or
override with the `pos_connector_update_url` filter) and deploy that build.

The manifest is what WordPress cannot do without: it is how the plugin learns a new
version exists without downloading the whole zip. The workflow generates it, so
hosting a release is uploading two files.

**Manifest shape** (generated; documented here because the updater validates it):

```json
{
  "name": "POS Accounting Connector",
  "version": "1.5.1",
  "download_url": "https://dl.mybusiness.ir/pos-updates/pos-accounting-connector.zip",
  "notes": "Release notes shown in the «مشاهدهٔ جزئیات» modal",
  "published_at": "2026-09-16T12:00:00Z"
}
```

Only `version` and `download_url` are required. `version` must be a plain
`X.Y.Z(-suffix)` — anything else is refused rather than guessed. `download_url`
must be **HTTPS and on the same host as the manifest**; anything else is rejected
(`unexpected_download_url`), so a manifest can never point the plugin at an
arbitrary URL on the internet.

### «هیچ افزونهٔ معتبری یافت نشد» on install

WordPress shows this when the uploaded or downloaded zip does not unpack to a
folder that contains `pos-accounting-connector.php` with a `Plugin Name:` header.
Common causes:

1. **Wrong file** — the repository «Source code» zip, `update.json`, or a
   re-zipped artifact that still wraps `pos-accounting-connector.zip` inside
   another zip. Use the clean **`pos-accounting-connector.zip`** from the
   workflow artifact or `https://updates.eshobe.app/wordpress/pos-accounting-connector/pos-accounting-connector.zip`.
2. **Windows backslash paths** — zips built with `Compress-Archive` instead of
   the workflow's ZipArchive step install as one flat file. Rebuild with
   **build-plugin-zip** and re-upload.
3. **GitHub tag zipball** — the whole monorepo; since 1.6.6 the plugin's
   `upgrader_source_selection` handler walks wrapper folders before WordPress
   validates the package. Update through «به‌روزرسانی‌های موجود» or upload the
   clean zip for first install.

### Transitioning stores from GitHub mode to self-hosted

Stores running 1.4.x don't know your URL yet — they still check GitHub. The
transition is automatic: every workflow build pushes tag `vX.Y.Z`, so the next
build after you set the URL is visible in GitHub mode too. Stores update to it and
from then on check your server. After that, GitHub no longer needs releases — the
workflow's tags alone keep the old path alive for anyone left behind.

## GitHub mode (the default)

With `POS_CONNECTOR_UPDATE_URL` empty, the updater asks GitHub:

1. `/releases/latest` — a release with a `pos-accounting-connector.zip` asset
   (built by `wordpress-plugin/package-release.sh` locally, or the workflow
   artifact) installs as-is; any other `.zip` asset is used; with no asset, the
   tag's **zipball** (the whole repository) is used and
   `upgrader_source_selection` digs the plugin folder out of it.
2. No releases at all → the newest **tag** (the workflow's `vX.Y.Z` tags make this
   path work with zero extra effort).

A GitHub **Release** is therefore optional in GitHub mode: publish one when you
want the release notes in the details modal; otherwise tagging is enough.

## What a store sees (both modes)

- The normal twice-daily update cycle does the checking — the plugin adds no cron
  of its own, and no page view ever waits on the update server.
- New version in «افزونه‌ها ← به‌روزرسانی‌های موجود» with the standard
  «مشاهدهٔ جزئیات نسخهٔ …» modal (notes as the changelog) and one-click install.
  Auto-update toggles and `wp plugin update` work.
- The plugin's «به‌روزرسانی» tab (top-level «اشوبه» admin menu) shows the installed
  version, the update **source** (your server or GitHub), the newest found version,
  the last check time, and a «بررسی به‌روزرسانی» button — the one user-initiated
  check. `wp pos-connector check-update` is its WP-CLI twin.
- The updater initializes **before** the WooCommerce gate, so the plugin can update
  itself even where WooCommerce is deactivated or missing.

## Security summary

- **Self-hosted mode:** manifest URL is baked in at build time and must be HTTPS.
  The `download_url` it names must be HTTPS on the **same host** as the manifest.
  Notes shown in the modal pass through `wp_kses_post`.
- **GitHub mode:** the `package` URL is rebuilt locally and constrained to this
  repository's tags and assets on GitHub's own download hosts
  (`github.com`, `codeload.github.com`, `objects.githubusercontent.com`).
- In both modes: version strings must parse as real versions, updates are offered
  only when `version_compare()` says the found version is newer, and the
  `Update URI:` header tells core never to ask wordpress.org about this plugin.

## Rules that keep it working

- Tag names must be `v` + a plain version (`v1.5.1`) — the workflow enforces this
  shape for you.
- The plugin folder name stays `pos-accounting-connector` — it is the slug
  WordPress indexes updates by and what `wp plugin update` expects.
- The zip root must be exactly `pos-accounting-connector/` (the workflow asserts
  this too).
- The workflow commits and pushes to the branch it was run on — run it on `main`
  (or a branch without push protection).
- Prefer the workflow over the local `package-release.sh`; the script remains for
  building a zip by hand without GitHub, and it does **not** bump the version —
  the repo rule (bump on every plugin change) still applies to whatever you ship.
