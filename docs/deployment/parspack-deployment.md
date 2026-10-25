# Deploying to ParsPack

> **Retired.** ParsPack is no longer the deployed target — the app now deploys
> to Runflare (see `docs/deployment/server-migration.md` §Platform recipes A). The compose
> file and env template this doc refers to now live under `archive/deploy/`.
> Kept here as a reference for anyone still running this shape of stack.

`archive/deploy/docker-compose.parspack.yml` deploys three services together in one ParsPack app: the
POS itself, its Postgres 16, and OpenObserve (fleet log monitoring). This doc is the
walkthrough for ParsPack specifically, following its documented Compose flow
(<https://docs.parspack.com/paas/deploy/docker/docker-compose/>). The other
compose files — `docker-compose.local.yml` in the repo root, and the retired
`archive/deploy/docker-compose.{komodo,srv1}.yml` — target a self-managed
Traefik/DirectAdmin box instead and don't apply here.

## ParsPack's Compose constraints — read this before touching the file

ParsPack's Compose engine reads your `docker-compose.yaml`, identifies its services, and
provisions each one. Three things it does differently from `docker compose up` on your own
box, which `archive/deploy/docker-compose.parspack.yml` is already written around:

- **No `build:` — every service needs a pre-built `image:`.** ParsPack pulls images; it
  doesn't build them from a Dockerfile. `db` and `observability` already use public images
  (`postgres:16-alpine`, `openobserve/openobserve`), but the POS app has to be built and
  pushed by you first — see "Build and push the app image" below.
- **No bind-mount volumes.** Only named volumes are supported, and ParsPack lets you set a
  disk size for each one — `pos-pgdata`, `pos-backups` and `zo-data` already are, so nothing
  to change there.
- **Public vs. isolated access is a per-service toggle in the ParsPack panel**, decided
  after it reads the file — not a `ports:` mapping. You'll set this when it lists the three
  detected services (see "Deploying" below).

## Build and push the app image

Nothing in this repo publishes a container image automatically — there's no CI (see
`CLAUDE.md`). Build the image yourself from the repo root and push it somewhere ParsPack can
pull from (GHCR shown here; Docker Hub or another registry works the same way):

```bash
docker build -t ghcr.io/<you>/cafe-restaurant-pos:parspack .
docker push ghcr.io/<you>/cafe-restaurant-pos:parspack
```

Make the image (or the registry credential) something ParsPack's pull can actually reach —
a public GHCR package is the simplest option. Re-run these two commands and redeploy the
ParsPack app whenever you ship a change; there's no auto-rebuild.

## Environment (`archive/deploy/.env.parspack.example`)

Copy `archive/deploy/.env.parspack.example`, fill it in, and upload the filled-in copy in the app's
"پارامترها و متغیرها" step — ParsPack requires this for any compose variable with no
default, which is exactly how the required ones (`POS_IMAGE`, `JWT_SECRET`,
`POSTGRES_PASSWORD`, `OPENOBSERVE_ROOT_EMAIL`, `OPENOBSERVE_ROOT_PASSWORD`) are written in
`archive/deploy/docker-compose.parspack.yml`. Everything else in that file already has a sane default.

Don't set `DATABASE_URL` or `OPENOBSERVE_URL` yourself — the compose file wires both to the
bundled `db`/`observability` services. `docker-entrypoint.sh` runs migrations and provisions
the restricted `pos_app` role automatically on every deploy (see the README's tenancy
section); there's no separate migration step to run on ParsPack.

## Deploying

1. In ParsPack, under **Docker → Docker Compose**, connect this repo (or upload an archive
   containing `archive/deploy/docker-compose.parspack.yml`) as the source.
2. Upload your filled-in `archive/deploy/.env.parspack.example` when prompted for variables.
3. ParsPack lists the three services it found (`db`, `observability`, `app`). For each:
   - **`app`** → mark **public** (this is what staff/customers reach; container port 3000).
   - **`db`** and **`observability`** → leave **isolated** (no public access). Only make
     `observability` public if you specifically want its dashboard/alerts UI reachable
     directly — see the OpenObserve section below.
   - Set a disk size for each named volume ParsPack detects (`pos-pgdata`, `pos-backups`,
     `zo-data`).
4. Choose resources — **dedicated** for `db` (and `observability` if you expect real load)
   is the recommended choice; `app` can usually stay on shared resources for a single café.
5. Save each service's settings (ثبت تغییرات), then create the app (ایجاد اپلیکیشن).

The entrypoint waits for Postgres, applies migrations, and starts the server on first boot
and every redeploy — nothing manual after this.

## Single business vs. hosting several (subdomains)

Most café/restaurant deployments are **one business, one domain** — the default in
`archive/deploy/.env.parspack.example`. Point your domain at the `app` service in ParsPack, and you're
done; nothing about `ROOT_DOMAIN` or wildcard certificates applies.

Only set `ROOT_DOMAIN` (and `SUBDOMAIN_ROUTING=on`) if you intend to run this deployment as
a platform serving **multiple businesses**, each at its own subdomain
(`{business}.yourdomain.com`, super-admin console at `admin.yourdomain.com`). That needs:
- A **wildcard** DNS record and a **wildcard** TLS certificate for `*.yourdomain.com` —
  confirm ParsPack's custom-domain feature can issue/attach a wildcard cert before
  committing to this path; a single-host cert won't cover it.
- `WEBAUTHN_RP_ID` left unset (it defaults to `ROOT_DOMAIN`, which is what per-business
  origins require).

If the wildcard cert isn't ready yet, `SUBDOMAIN_ROUTING=off` keeps the deployment on one
origin without disabling the rest of the app.

## eshobe-cms — don't add it here

If you're also using the Website app (`/dashboard/website`), **eshobe-cms is not a service
of this app and doesn't belong in this compose file.** Per
[docs/integrations/eshobe-cms-integration.md](../integrations/eshobe-cms-integration.md) it's a separate deployment (its
own repo, its own hosting) that this app talks to over REST with a per-business API key —
embedding it here would duplicate infrastructure and reopen the tenant isolation it already
solved. If you have (or plan to run) an eshobe-cms deployment elsewhere, just add these as
app parameters once it's reachable:

| Variable | Value |
|---|---|
| `ESHOBE_CMS_URL` | the CMS's control-plane origin, e.g. `https://cms.yourdomain.ir` |
| `ESHOBE_CMS_WEBHOOK_SECRET` | the CMS's `PAYLOAD_SECRET`, for verifying its publish webhook |
| `ESHOBE_CMS_PLATFORM_API_KEY` | optional, only if you provision CMS sites from this app |

Nothing else changes — the Website app is unused (and its connect flow just stays empty)
until these are set.

## OpenObserve — bundled, and still optional

`archive/deploy/docker-compose.parspack.yml` includes an `observability` service and the matching
`OPENOBSERVE_*` wiring on `app` by default, giving you the super-admin «پایش» tab
(`/platform/system/logs`) — a live tail of errors and slow/failed requests. See
[docs/deployment/openobserve.md](openobserve.md) for the full picture (what it ships, alert recipes,
retention).

It's still entirely optional: with no `OPENOBSERVE_*` env set the app behaves exactly as
without it, and that tab just shows a setup guide instead of live data. To drop it, delete
the `observability` service and the `OPENOBSERVE_*` lines under `app.environment` from
`archive/deploy/docker-compose.parspack.yml`, and the `zo-data` volume.

To reach the OpenObserve UI itself (for building dashboards/alerts — the console's tab works
fine without this), mark `observability` **public** in step 3 above and set
`OPENOBSERVE_PUBLIC_URL` to whatever domain ParsPack attaches to it. The app's own log
shipping never needs that — it always talks to `observability` over the internal network.

## If you'd rather use a managed database instead of the bundled one

You can skip the `db` service and point `DATABASE_URL` at a Postgres instance from
ParsPack's own "دیتابیس‌ها" catalogue (choose version 16) instead — delete the `db` service
from the compose file, drop it from `app.depends_on`, and set `DATABASE_URL` to that
instance's connection string as an app parameter. The entrypoint's automatic `pos_app` role
provisioning (see above) needs the connecting user to be able to `CREATE ROLE`; if
ParsPack's managed Postgres doesn't grant that, run `npm run db:app-role` yourself against
it once and set `DATABASE_URL`/`RUNTIME_DATABASE_URL` to the restricted role instead.
