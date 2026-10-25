# OpenObserve — fleet monitoring for the super-admin console

> Status: the integration is in the app (shipper + `/api/platform/observability` +
> the «سیستم → پایش» tab). The collector itself is optional: with no
> `OPENOBSERVE_*` env set, the app behaves exactly as before and the tab shows
> a setup guide. This file is the operations manual for when you turn it on.

## Why this and not "more tables in Postgres"

`/platform/system` («سلامت») answers *"what does **this** deployment's database
think?"* — pool, migrations, RLS, last backup per business. It is a good answer
and it can never be a better one: a single page can only see the node serving it.
The fleet has problems that are not database-shaped:

- a café's local box throws errors every night in the backup tick — and the
  central console finds out only when someone reports data missing;
- a deploy made request latency silently double on one host but not the others;
- `console.error` from the twelve background ticks in `server.ts` exists for
  about one boot in RAM (the docker log), and then never again;
- "did the update on site 3 actually restart?" is answered by nothing today.

OpenObserve is one container (~200 MB RAM idle) that becomes the answer to all
of it: append-only log/metric store, SQL over it, retention pruning, alerts,
and a UI. It is chosen over the Loki/Grafana/Tempo stack specifically because
this deployment style — one Rust binary, `docker compose up`, no sidecars —
matches how café servers are actually administered.

## How the app connects

```
┌ pos container ──────────────────────────────┐
│ server.ts                                   │
│  ├ installObservability()  → console.* tap  │   POST /api/{org}/{stream}/_json
│  └ res "finish" (status≥400 or ≥1s)        │   (buffered, batched, never blocks,
│                                             │    drops counted, app unaffected)
│ /api/platform/observability (system.read)   │   POST /api/{org}/_search?type=logs
│  └ «پایش» tab proxies through here          │
└─────────────────────────────────────────────┘          │
                                              ┌──────────▼──────────┐
                                              │ openobserve:5080    │
                                              │  pos_app_logs stream│
                                              │  dashboards / alerts│
                                              └─────────────────────┘
```

Facts the code relies on (the dev mock mirrors them, so drift shows up in review):

- **Ingest**: `POST /api/{org}/{stream}/_json` — array of objects,
  `_timestamp` in **microseconds**; Basic auth `email:password`.
- **Search**: `POST /api/{org}/_search?type=logs` with
  `{ query: { sql, start_time, end_time, from, size } }` — again µs; response
  rows arrive under `results` (newer) or `hits` (older) — the client accepts both.
- **Health**: `GET /health/z`. **Streams**: `GET /api/{org}/streams?type=logs`.
- The browser never talks to the collector. The console's tab calls
  `/api/platform/observability`, which is session+`system.read`-gated and
  proxies server-side. Credentials exist only in the app container's env.

### What gets shipped

| source | fields | notes |
|---|---|---|
| `console.*` tap | `level, message, logger:"console", service, environment` | every existing `console.error("… tick failed")` becomes observable with zero call-site churn; originals keep printing |
| HTTP finish | `logger:"http", method, path, status, duration_ms, host` | only `status ≥ 400` or `duration ≥ 1000ms` — the interesting tail, not the whole firehose (ingestion cost is the billing of this world) |
| boot | `logger:"boot"` | one record per process start: "did the new deploy come up, from where" |
| `uncaughtException` / `unhandledRejection` | `level:"fatal"/"error"` | best-effort flush before the process goes down |

Record fields to care about in queries: `service` (which host/site — set
`OPENOBSERVE_SERVICE` per box!), `environment`, `level`, `host` (request Host
header → which tenant origin was hit), `status`, `duration_ms`.

### A second stream: the website platform (`cms_events`)

Migration 0139 made the sibling **eshobe-cms** deployment observable from here too,
without putting a collector credential on it. Two producers, one stream
(`OPENOBSERVE_CMS_STREAM`, default `cms_events`), read back by
«سایت‌ساز ← پایش» through the same proxy with `?source=cms`:

| source | fields | notes |
|---|---|---|
| every control call the console makes | `logger:"cms", cms_operation, cms_outcome, duration_ms, status, site_id` | `src/lib/cms/platform-client.ts` wraps each one. A **network** error is `error`, an API refusal is `warn`: a CMS that refused answered, a CMS that did not answer is the outage, and a level filter must not conflate them. |
| the CMS's own event feed | `logger:"cms-event", cms_kind, cms_event_id, cms_site_domain, source_at, cms_*` | `GET /api/platform/events` on the CMS, polled on a cursor by the server tick: site changes, unverified domains, orders, gateway self-tests, keys issued. |

Why a separate stream rather than `pos_app_logs`: a retention window or an alert
that is right for this app's own request log is not necessarily right for another
product's audit tail, and one stream would mean tuning either tunes both.

Two details the shipper depends on. `cms_event_id` is the CMS's own id, carried
verbatim, so a duplicate from an overlapping poll is *findable* rather than merely
indistinguishable. `source_at` is the CMS's own instant, kept beside the ingest
time the collector stamps — a feed polled every ten minutes would otherwise show
every record as having happened at poll time.

Both halves are opt-in on «سایت‌ساز ← اتصال» and default off, so a deployment with
no CMS ships nothing and calls nothing.

Alert recipes worth having on this stream:

```sql
-- a merchant's gateway failing its self-test, anywhere on the fleet
SELECT cms_site_domain, message FROM "cms_events"
WHERE cms_kind = 'gateway.selftest' AND level = 'error'

-- the console losing its connection to the website platform
SELECT count(*) AS n FROM "cms_events"
WHERE logger = 'cms' AND cms_outcome = 'network_error'

-- a key issued for any site (the record you most want to find later)
SELECT * FROM "cms_events" WHERE cms_kind = 'key.issued' ORDER BY _timestamp DESC
```

## Installing it

### A. Central server (Komodo / archive/deploy/docker-compose.komodo.yml — retired)

```bash
# once, on the server, in the stack folder:
export OPENOBSERVE_ROOT_EMAIL=ops@yourdomain.ir
export OPENOBSERVE_ROOT_PASSWORD="$(openssl rand -base64 18)"
docker compose -f archive/deploy/docker-compose.komodo.yml -f archive/deploy/docker-compose.observability.yml up -d
```

That is the whole install: the overlay starts OpenObserve on the private
network, injects the `OPENOBSERVE_*` env into the app, and creates the
`zo-data` volume. The collector listens **only** inside that network.

Optional — publish its UI (dashboards/alert config need it at first; the
console's tab works regardless): uncomment the Traefik labels in the overlay
and set `OPENOBSERVE_PUBLIC_URL=https://obs.yourdomain.ir`.

### B. Café box (docker-compose.local.yml)

Two choices, mixable:

1. **Report up**: no new container — add to the box's `.env`:
   `OPENOBSERVE_URL=https://obs.yourdomain.ir`, `OPENOBSERVE_USER`,
   `OPENOBSERVE_PASSWORD`, `OPENOBSERVE_SERVICE=cafe-north`. Works while the
   internet is up; the shipper drops (and counts) while it isn't — which is
   the correct café-box behavior anyway.
2. **Self-contained LAN**: `docker compose -f docker-compose.local.yml -f
   archive/deploy/docker-compose.observability.local.yml up -d` — a local collector at
   `http://<lan-ip>:5080`, 14-day retention, nothing leaves the premises.

### C. Bare-metal / systemd

Download the single binary from <https://openobserve.ai/downloads/>, then:

```bash
ZO_ROOT_USER_EMAIL=ops@yourdomain.ir ZO_ROOT_USER_PASSWORD=... \
ZO_DATA_DIR=/var/lib/openobserve ZO_COMPACT_DATA_RETENTION_DAYS=60 \
./openobserve
```

and set the four `OPENOBSERVE_*` vars on the app service unit. Restart both.

### D. RunFlare (managed Docker PaaS — no compose file)

Platforms like [RunFlare](https://runflare.com) deploy **one service at a time**
(a Docker image, or a folder pushed with `runflare deploy` / GitHub-GitLab CI)
instead of a full compose file, so the overlay from **A** cannot be applied
directly. Nothing changes in the app image — you replicate the same wiring
with platform features: a second service, a disk, env vars, and an optional
subdomain.

1. **Create an OpenObserve service in the same project as the app.** Service
   type Docker, image `openobserve/openobserve:latest` (Docker Hub is covered
   by RunFlare's `mirror-docker.runflare.com`, so the pull is fast; the
   upstream ECR registry is not mirrored). If the dashboard has no image
   field, deploy a folder containing a one-line Dockerfile —
   `FROM openobserve/openobserve:latest` — via CLI/CI. Set the app port to
   **5080** (OpenObserve's only port) and ≥ 1 GB RAM.
2. **Attach a persistent disk** («ساخت دیسک جدید» / add a disk to the project,
   mounted on the service) at `/data`, and set `ZO_DATA_DIR=/data` — otherwise
   the log store is wiped on every redeploy. RunFlare's disk backups then
   cover the log archive too.
3. **Env vars on the collector service** (root pair is read on first boot
   only; change the password in the UI afterwards):
   `ZO_ROOT_USER_EMAIL`, `ZO_ROOT_USER_PASSWORD`, `ZO_DATA_DIR=/data`,
   `ZO_COMPACT_DATA_RETENTION_DAYS=30`.
4. **Env vars on the app service**, then redeploy it (the shipper reads env
   at boot): `OPENOBSERVE_URL=http://<openobserve-service-name>:5080` if the
   project's internal network resolves service names, else attach a subdomain
   to the collector («اتصال دامنه به سرویس», e.g. `https://obs.yourdomain.com`)
   and use that — the UI and ingestion both sit behind OpenObserve's own
   login. Either way add `OPENOBSERVE_USER` / `OPENOBSERVE_PASSWORD`, and
   `OPENOBSERVE_SERVICE=pos-central` per project if you run more than one.
5. **Verify:** `GET /api/platform/observability?mode=config` → `configured:
   true`, `shipper.sent` climbing; or the console page «پایش» shows rows.
   If the internal hostname does not resolve, fall back to the subdomain.

The compose overlays and `archive/deploy/docker-compose.observability.yml` remain the
reference for what these services do; RunFlare just assembles them from its
own building blocks.

### E. Local development — no Docker at all

```bash
node scripts/dev-openobserve.mjs     # contract-faithful in-memory mock on :5080
OPENOBSERVE_URL=http://127.0.0.1:5080 OPENOBSERVE_USER=root@example.com \
OPENOBSERVE_PASSWORD=devpass npm run dev
```

Open `/platform/system/logs` → data flows. The mock is dev-only: no retention,
no dashboards, memory-capped.

## Verifying it is alive

```bash
# ingest works (from the app's own stream):
curl -s -u "$OPENOBSERVE_USER:$OPENOBSERVE_PASSWORD" \
  "$OPENOBSERVE_URL/api/default/_search?type=logs" \
  -H 'Content-Type: application/json' \
  -d "{\"query\":{\"sql\":\"SELECT * FROM \\\"pos_app_logs\\\" ORDER BY _timestamp DESC\",\"start_time\":$(( ($(date +%s) - 3600) * 1000000 )),\"end_time\":$(( $(date +%s) * 1000000 )),\"size\":5}}"
```

or just watch «پایش» in the console: a boot record appears within seconds of
the app starting, and `mode=config` shows `shipper.sent` climbing. If
`dropped` climbs instead, the collector is unreachable — the POS does not
care, but you now do.

## Alert recipes worth adding on day one

In OpenObserve UI → Alerts, each is a saved query + channel (email/Telegram/
webhook). These map directly onto failure modes this platform has seen:

```sql
-- any ticket-critical job failing at all, last 15 min
SELECT count(*) AS n FROM "pos_app_logs"
WHERE level IN ('error','fatal') AND str_match(message, 'tick failed')

-- backups: a site that stopped reporting success entirely (24h silence = alert)
SELECT service, max(_timestamp) AS last_seen FROM "pos_app_logs"
WHERE str_match(message, 'backup') GROUP BY service HAVING last_seen < now() - interval '24 hours'
```

plus the infra-shaped ones from the other side (metrics, once the node exporter
is added): disk on the `zo-data` / `pos-pgdata` volume, pool queue > 0, HTTP
5xx rate per `host` (i.e. per tenant origin).

## Retention, size, privacy

- `ZO_COMPACT_DATA_RETENTION_DAYS` (60 central / 14 per-box in the overlays) is
  the prune lever. At the volumes this app logs — errors, slow requests, one
  line per tick — 60 days is hundreds of MB, not GB.
- Logs contain paths, tenant *hosts*, and error text — no passwords, tokens or
  payment data are written by the shipper (messages come from `console.*` in
  code that already prints them to docker logs today; nothing new is exposed
  inside the same server boundary). If you front the OpenObserve UI, it is
  Basic-auth only: put it behind the same VPN/IP-allowlist discipline you use
  for anything with production logs, or leave the port unpublished and use
  the console tab (which is session-gated) as the operator surface.
- The DB remains the source of truth for *business* audit (`platform_audit_log`
  — what admins did). OpenObserve is for *machine* health. The console links
  «رویدادها» and «پایش» side by side for exactly this reason: don't replace one
  with the other.

## Roadmap this unlocks (not built yet)

1. **Desktop/electron clients** → `fetch(centralOrigin + "/api/platform/...")`
   is already how updates are checked; a `desktop_logs` stream (crashes,
   print-job failures per `businessId`) would give the console per-install
   field visibility. Needs a thin ingest proxy under the app (so client builds
   hold no collector credentials) and stream-name allowlisting.
2. **Postgres logs** → `docker compose` logging driver or `vector` tailing
   the db container into the same collector: slow-query log becomes queryable
   per site without touching Postgres config.
3. **Metrics** → OTLP endpoint is built into OpenObserve; a 10-line
   `@opentelemetry/sdk-metrics` exporter in `server.ts` (pool stats, tick
   durations, order latency histogram) is the next increment after this one.
