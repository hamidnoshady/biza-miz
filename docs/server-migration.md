# Moving an install to another server

How to move a whole running install — every business, all history, all settings —
from one server to another, on whichever platform the new one is. The data half
is the same everywhere (one `pg_dump` artifact, restored with
`npm run db:restore`); only the *hosting* half differs, so this doc is
[universal steps](#step-1--inventory-what-has-to-move) plus one
[platform recipe](#platform-recipes) you pick from.

For restoring a *lost* server rather than moving a live one, use
[docs/backup-restore.md](backup-restore.md) §C — it's the same restore with no
old machine to drain first. For moving **one business** off a shared install
rather than the whole install, skip to
[Moving a single business instead](#moving-a-single-business-instead).

## What actually has to move

| Thing | Where it lives now | How it moves |
|---|---|---|
| **All data** — businesses, orders, ledger, inventory, users/passwords, dashboard settings (incl. S3 + AI keys) | the `pos` database | `pg_dump --format=custom` → `npm run db:restore` |
| **App code** | git / `ghcr.io/hamidnoshady/cafe-restaurant-pos` | rebuilt or re-pulled on the new host — nothing to copy |
| **Secrets** — `JWT_SECRET`, `POSTGRES_PASSWORD`, `REMOTE_SYNC_TOKEN`, `WEBAUTHN_*` | compose env / `.env` / the platform's env panel | copy by hand, before you start |
| **Backup artifacts** | `pos-backups` volume (`BACKUP_DIR=/app/backups`) | optional — history only, not needed to run |
| Uploaded files | — | nothing to move; this app stores no user uploads on disk |

Everything else (the `pos_app` role and its grants, the schema, migration
history) is recreated automatically by `docker-entrypoint.sh` on first boot.

## Step 1 — inventory what has to move

Before touching anything, write down from the **old** host:

- `JWT_SECRET` — carry it over verbatim. A new one silently invalidates every
  logged-in session (staff just log in again; not fatal, but do it knowingly).
  It must be ≥32 chars and not `change-me-in-production`, or the app refuses to
  boot (`src/lib/jwt-secret.ts`).
- `POSTGRES_PASSWORD` / the full `DATABASE_URL`.
- `REMOTE_SYNC_TOKEN`, if any café laptop syncs to this server
  ([docs/server-sync.md](server-sync.md)).
- `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` — and the **new** domain, if it changes.
- The backup **passphrase** and S3 credentials. They're inside the database too,
  so the restore brings them back, but you want them in hand if the dump itself
  turns out to be a cloud artifact you need to decrypt.
- Postgres major version (must match on the new host — 16 everywhere here).

> **Prefer the console if the old server still runs.** Migration 0132 gave the
> super-admin console a whole-system backup that another install can pull **by
> address**: turn on «دسترسی سرور دیگر به این نسخه‌ها» on the old one, issue a token,
> and on the new one add that address under «بازیابی از آدرس» → verify → apply. It
> is the same `pg_dump` artifact and the same scratch-database dry run as Steps
> 2–4 below, without the scp, and it checks the migration count and Postgres major
> on both sides for you. The shell procedure below stays the answer when the old
> machine is unreachable, when you want the file in your own hands, or when the
> console cannot be opened at all — and the drain (app stopped) rule applies to the
> console path just as much: take a fresh manual backup with the app stopped before
> you cutover, or everything between the last scheduled copy and the shutdown is
> lost.

## Step 2 — take the migration dump

Do this with the app **stopped**, so no order is written after the dump. A dump
taken while the app runs is consistent but will be missing whatever happens
between then and cutover.

```bash
docker compose -f your-compose-file.yml stop app
# (e.g. docker-compose.local.yml, or archive/deploy/docker-compose.srv1.yml
# for the retired VPS recipe — pick whichever stack this old host runs)
```

Then dump. From the db container (works on any of the compose stacks):

```bash
docker compose -f your-compose-file.yml exec -T db \
  pg_dump -U pos -d pos --format=custom > pos-migration.dump
```

Not on Docker (standalone/desktop install, or a managed database) — dump from
any machine that can reach it, with `postgresql-client` ≥ 16:

```bash
pg_dump --format=custom -f pos-migration.dump "postgres://USER:PASS@HOST:5432/pos"
```

Sanity-check it before you trust it: `pg_restore --list pos-migration.dump | head`
should print a table of contents, and the file should be megabytes, not bytes.

> A scheduled `/dashboard/backup` artifact works just as well as a fresh dump —
> it's the same `pg_dump --format=custom`. Just make sure it's *newer than the
> last order*, which a nightly one isn't. Prefer the explicit dump above.

## Step 3 — restore onto the new server

Universal shape, whatever the platform:

1. Bring up **Postgres only** on the new host (or provision its managed
   Postgres 16).
2. Get `pos-migration.dump` onto a machine that can reach that database.
3. **Dry run.** `npm run db:restore` restores into a throwaway
   `pos_restore_verify` database, prints migration count and row counts for
   businesses/locations/users/orders/journal_entries, then drops it. Production
   is not touched:
   ```bash
   npm run db:restore -- pos-migration.dump
   ```
4. Read those counts and compare them with the old server. If they're right:
   ```bash
   npm run db:restore -- pos-migration.dump --apply --yes
   ```
   `--apply` re-verifies in the scratch DB first, then drops and recreates the
   real database from the artifact. `--yes` is mandatory — there's no prompt.
5. Start the app. `docker-entrypoint.sh` waits for Postgres, runs migrations
   (a no-op — the dump already has them), provisions the restricted `pos_app`
   role and launches the server as that role.

Two things about the restoring connection, because they bite:

- It needs to reach the `postgres` maintenance database on the same server, not
  just `pos` — it issues `CREATE DATABASE`/`DROP DATABASE`. So use the
  **superuser** URL (`pos`), not `pos_app`. Pass it explicitly with
  `--database-url` if the ambient environment points somewhere else — and note
  that `docker-entrypoint.sh` deliberately rewrites `DATABASE_URL` to `pos_app`
  before running whatever command it's given, so a restore launched *through* the
  entrypoint fails on privileges. Bypass it (`--entrypoint sh`, as in recipe B)
  or pass `--database-url`.
- The machine running it needs `pg_restore` ≥ 16 on `PATH` (or `PG_RESTORE_PATH`
  set). The app image already ships `postgresql16-client`, which is why several
  recipes below run the restore *inside* a container.

## Step 4 — verify before cutover

With the new server up but DNS still pointing at the old one, reach the new one
directly (its temporary platform URL, or a `hosts` entry) and check:

- Log in as Owner — the old password works, since it came over in the dump.
- Today's orders list, and one order's detail page.
- Ledger → trial balance still balances.
- Inventory levels on a couple of items.
- `/dashboard/backup` — the schedule, retention, and run history are all there.
- Take a manual backup («پشتیبان‌گیری هم‌اکنون») to prove the new host can dump.
- If a café laptop syncs here, confirm one sync round-trip
  ([docs/server-sync.md](server-sync.md)).

Only then flip DNS / the reverse-proxy vhost. Keep the old server **stopped but
intact** for a few days — the cheapest possible rollback.

## Step 5 — after cutover

- **Never run both servers live.** Two installs writing to the same S3 backup
  prefix, or both accepting orders, diverge immediately and there is no merge
  tool. Old app stays stopped.
- **If the domain changed:** passkeys break. WebAuthn credentials are bound to
  `WEBAUTHN_RP_ID` (`src/lib/webauthn.ts`), so every registered biometric login
  fails against a new domain and staff must re-register. Set
  `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGIN` to the new host exactly — no scheme in
  `RP_ID`, exact scheme+host in `ORIGIN`.
- **If the domain changed:** update each café laptop's sync peer URL (per
  business, in the Owner dashboard — `server_sync.config`, not env). The AI
  connection is configured separately at `/platform/ai`; update its LiteLLM
  Base URL only if the proxy endpoint itself changed (there is no `APP_URL`
  provider setting).
- Re-point any external monitoring, and the public API consumers' base URL.

## Platform recipes

Pick the one that matches the **new** server. All of them are Step 3 above with
platform-specific plumbing; Steps 1, 2, 4 and 5 don't change.

### A′. srv1 + Komodo, pulling the GHCR image (`docker-compose.srv1.yml`)

The stack the sibling [`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms)
repo already runs on the same host, now available for this app too. Use it when
you want deploys to be *pull a prebuilt image and restart* rather than *build
from source on the platform*.

**Shape of it:** one Komodo stack from the repo-root `docker-compose.srv1.yml` —
the app plus its own Postgres 16 — publishing to `127.0.0.1` only, behind the
OpenLiteSpeed → Traefik front door that already terminates TLS on that host.

The image comes from `.github/workflows/publish.yml`, which runs on **every push
to `main`** (gated by type check, unit tests and a production build on the exact
merge commit) and pushes `ghcr.io/hamidnoshady/cafe-restaurant-pos` as
`sha-<short>` and `latest`. srv1 cannot reach `ghcr.io` — it is filtered at the
network layer there — so the stack pulls the same image through the
**`ghcr-mirror.liara.ir`** pull-through cache, which is reachable. That is the
one difference from the retired `archive/deploy/docker-compose.srv1.yml`, which
pointed straight at `ghcr.io` and is why it was retired.

1. **Create the Komodo stack** pointing at this repo and `docker-compose.srv1.yml`.
   Komodo cannot fetch from git on this host either, so it holds the operative
   copy in the stack's own compose configuration — this file is the
   version-controlled reference; edit both together.
2. **Set the stack's Environment**: at minimum `POSTGRES_PASSWORD`, `JWT_SECRET`,
   `ROOT_DOMAIN`, `PLATFORM_BASE_URL`, `WEBAUTHN_ORIGIN`, and `POS_HOST_PORT` if
   3000 is taken. Add `ESHOBE_CMS_*` if this deployment runs the website manager.
3. **Deploy.** `docker-entrypoint.sh` waits for Postgres, runs migrations, derives
   the restricted `pos_app` role and starts the server — the same sequence every
   other recipe here relies on.
4. **Point Traefik's `dynamic.yml`** at `http://127.0.0.1:${POS_HOST_PORT}`. The
   exact wildcard-router block is in `archive/deploy/docker-compose.srv1.yml`'s
   header comment; this stack does not change it.

Two traps worth stating, both learned on the CMS side of the same host:

- **The image tag in the compose file is literal, not `${VAR}`.** Komodo resolves
  the image reference without Compose variable interpolation, so a variable there
  fails the registry lookup *silently* and the stack keeps running what it had.
- **Komodo logs the expanded compose config in plaintext**, environment included.
  Treat anything in that stack's Environment as exposed to whoever can read
  Komodo's logs, and rotate accordingly.

Adopting this is a deliberate cutover. Merging the compose file changes nothing
on its own: production stays on Runflare, building from the `Dockerfile`, until
somebody creates that stack.

### A. Runflare (رانفلر)

Runflare is a Kubernetes/Docker PaaS: a *project* holds *services* and
*databases*, each service builds from a `Dockerfile` in your repo (GitHub/GitLab
CI-CD or the CLI), with per-service **disks**, env vars, an in-panel
**Terminal**, live logs, one-click SSL, and a managed **Postgres** you can
temporarily expose over the internet. That maps onto this app cleanly.

**Shape of it:** one project, one service (the app, built from the repo's
`Dockerfile`) + one managed Postgres database. Runflare terminates TLS and
routes your domain to the service, so you use **neither**
`archive/deploy/docker-compose.srv1.yml` (assumes OpenLiteSpeed→Traefik on
loopback) **nor** `archive/deploy/docker-compose.komodo.yml` (assumes Traefik
labels) — both retired now that this app deploys to Runflare. Those compose
files were for VPS hosts; here the
platform is the orchestrator.

1. **Create the project**, then a **Postgres** database in it (`portal.runflare.com`).
   Note its internal address — Runflare uses a service hostname like
   `psql-xxx-service` and no port is needed internally (5432 if a client insists).
   **Confirm the version is 16**; Runflare's docs don't publish it, and a
   Postgres older than the dump's major refuses to restore it
   (`select version()` in the panel's PgAdmin, or from the terminal).
2. **Create the app service** from your GitHub/GitLab repo, so the build uses the
   repo's `Dockerfile` — which already installs `postgresql16-client`, runs
   migrations from `docker-entrypoint.sh`, and starts `tsx server.ts`.
3. **Env vars** on the service:
   - `NODE_ENV=production`
   - `PORT=3000` — the container listens here (`server.ts:23`); point the
     service's port at it.
   - `DATABASE_URL=postgres://postgres:<pass>@<db-host>:5432/pos` — the
     **privileged** database user. The entrypoint migrates with it and then
     derives an unprivileged `pos_app` role to actually run as
     (`scripts/derive-runtime-database-url.ts`), because RLS is what isolates
     businesses and a superuser ignores it. If Runflare's Postgres won't let
     you create roles, see the caveat below.
   - `JWT_SECRET`, `SESSION_HOURS`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`,
     `REMOTE_SYNC_TOKEN` (if used) — from Step 1.
   - `BACKUP_DIR=/app/backups`
4. **Add a disk** mounted at `/app/backups`. Runflare's rule is that any path
   written to after deploy needs a disk; without one, scheduled backups vanish
   on every redeploy. Size it for `retention × dump size`.
5. **Restore the dump.** Two ways, in order of preference:
   - Enable the database's **remote access** toggle, then from your own machine:
     ```bash
     npm run db:restore -- pos-migration.dump --database-url "postgres://postgres:<pass>@<public-host>:<port>/pos"
     ```
     Dry run first (as written), then re-run with `--apply --yes`. **Turn remote
     access back off afterwards** — it's meant to be temporary.
   - Or upload the dump to the disk (File Manager / CLI file send) and run the
     same command from the service's **Terminal**, where `pg_restore` already
     exists. Use the internal DB host. A terminal session gets the service's
     configured env, so `DATABASE_URL` is the privileged one — but check with
     `echo $DATABASE_URL` first, and pass `--database-url` if it isn't.
6. **Add the domain** to the service and enable SSL, then verify per Step 4.
   For every subsequent image rollout, also run the exact-SHA and canonical-route
   check in [production deployment verification](production-deployment-verification.md).

Runflare caveats specific to this app:

- **The managed Postgres may not grant `CREATEROLE`.** If the entrypoint can't
  provision `pos_app`, the app aborts in production rather than run with RLS
  disabled (`assertRlsEffective`, `src/lib/db.ts:191`) — correct behaviour, not a
  bug to work around. Fix it by creating the role once by hand
  (`npm run db:app-role` against the DB, or the SQL in
  `scripts/create-app-role.ts`) and setting `RUNTIME_DATABASE_URL` to the
  `pos_app` URL; the entrypoint then honours it verbatim and skips provisioning.
  Keep `DATABASE_URL` as the owner for migrations.
- **Restoring needs `CREATE DATABASE`** on the `postgres` maintenance DB. If the
  managed instance forbids that, `npm run db:restore` can't drop/recreate `pos`.
  Fall back to a plain restore into an empty database Runflare created for you:
  ```bash
  pg_restore --no-owner --no-privileges --dbname="postgres://postgres:<pass>@<host>:5432/pos" pos-migration.dump
  ```
  You lose the scratch-database dry run, so verify carefully afterwards (Step 4).
- **`/ws` live sync** needs WebSocket upgrades passed through — the same port
  3000, no separate config. Confirm the waiter/kitchen screens update live
  before you call the migration done.
- Scale/hourly billing is per project resources; give the service enough RAM for
  a Next.js build if you build on the platform (or push a prebuilt GHCR image
  through Runflare's Docker mirror, `mirror-docker.runflare.com`, if pulling
  `ghcr.io` directly is blocked).

Runflare CLI, if you'd rather not use the panel for the deploy/restart cycle:

```bash
# install (Mac/Linux)
/bin/bash -c "$(curl -fsSL https://get.runflare.com/install.sh)"
```

```bash
runflare stop      # pick project → service type → app, interactively
runflare start
runflare restart
```

`start`/`stop`/`restart` are the ones documented as service power management
(`-y` accepts the cached project/service instead of browsing). Login, file
upload and log commands exist too but aren't reproduced here — check
<https://runflare.com/docs/work-with-cli/> for their exact syntax rather than
guessing, since it changes.

### B. Another plain VPS (Docker Compose) — retired, kept for reference

The old server's own shape — same compose file, new box. The compose file for
this recipe now lives at `archive/deploy/docker-compose.srv1.yml`.

```bash
# on the new host: clone, copy the SAME .env, then Postgres only
docker compose -f archive/deploy/docker-compose.srv1.yml up -d db

# Dry run, then apply — inside the app image, which ships postgresql16-client.
# --entrypoint sh is deliberate: docker-entrypoint.sh rewrites DATABASE_URL to
# the unprivileged pos_app role before running your command, and pos_app cannot
# CREATE/DROP DATABASE. Bypassing it keeps the superuser URL from compose.
docker compose -f archive/deploy/docker-compose.srv1.yml run --rm \
  -v "$PWD/pos-migration.dump:/tmp/pos.dump:ro" \
  --entrypoint sh app -c 'npm run db:restore -- /tmp/pos.dump'

docker compose -f archive/deploy/docker-compose.srv1.yml run --rm \
  -v "$PWD/pos-migration.dump:/tmp/pos.dump:ro" \
  --entrypoint sh app -c 'npm run db:restore -- /tmp/pos.dump --apply --yes'

docker compose -f archive/deploy/docker-compose.srv1.yml up -d
```

Pick the compose file that matches the **new** host's front door, not the old
one's: `archive/deploy/docker-compose.srv1.yml` for a host where a panel
(DirectAdmin/OpenLiteSpeed) owns 443 and proxies to Traefik on loopback;
`archive/deploy/docker-compose.komodo.yml` for Traefik-with-labels on a shared
external network. Mixing them up is the most common cause of "deployed fine,
502 in the browser".

To carry the old backup artifacts too:

```bash
# old host
docker run --rm -v pos-backups:/b -v "$PWD":/out alpine tar czf /out/backups.tgz -C /b .
# new host, after the stack is up
docker run --rm -v pos-backups:/b -v "$PWD":/in alpine tar xzf /in/backups.tgz -C /b
```

### C. Komodo (or any git-driven Docker orchestrator) — retired, kept for reference

Same as B with `archive/deploy/docker-compose.komodo.yml`, except the stack's env lives in
Komodo's **Environment** field rather than a `.env` file — copy it across
verbatim from the old stack, then deploy. Full walkthrough of that stack:
[docs/deployment-local-network.md](deployment-local-network.md). Note the
`srv1` file's warning: on that host Komodo holds the operative copy of the
compose file, so a repo edit alone changes nothing.

### D. A managed-Postgres PaaS generally (Railway, Render, Fly, Coolify, Dokku, …)

The pattern is Runflare's without the Persian panel:

1. Provision Postgres **16** (majors must match the dump).
2. Deploy the app from the repo's `Dockerfile`, port 3000, with the env from
   Step 1 plus `DATABASE_URL`.
3. Mount a persistent volume at `/app/backups` (else scheduled backups are lost
   on redeploy).
4. Restore over a temporarily-public database connection, or from the
   platform's container shell.
5. Read the two Runflare caveats above — `CREATEROLE` and `CREATE DATABASE` are
   the two managed-Postgres restrictions that actually block this app, and
   `RUNTIME_DATABASE_URL` / plain `pg_restore` are the respective escapes.

### E. To an on-site café machine instead of a server

Moving *down* to a Windows 11 laptop/mini-PC is a different install, not this
procedure: use the standalone Electron installer (`electron/`, staged runtime
and bundled PostgreSQL). See
[docs/standalone-desktop-app.md](standalone-desktop-app.md). Restore the dump
into whichever Postgres that install runs, then note that a local-mode install
has no cloud-backup half at all — configure a `BACKUP_SECONDARY_DIR` (USB/NAS)
instead.

## Moving a single business instead

If the goal is to lift **one business** off a shared install rather than move
the whole thing, don't use the physical dump — it contains every tenant. Use the
Phase 17 per-tenant export: `/dashboard/backup` →
«خروجی اطلاعات کسب‌وکار», or `GET /api/backup/export?format=sql`, restored with
`npm run db:restore-tenant` into a **freshly migrated, empty** database. It
refuses to merge into a database that already has that business. Runbook:
[docs/backup-restore.md](backup-restore.md#per-tenant-export--restore-phase-17).

## Rollback

Until you delete the old server, rollback is: stop the new app, start the old
one, point DNS back. That's why Step 4 says verify *before* cutover and Step 5
says keep the old box intact. After the old server is gone, your rollback is
whatever `/dashboard/backup` last produced — which is the ordinary restore in
[docs/backup-restore.md](backup-restore.md), with the ordinary data loss of
everything since that artifact.
