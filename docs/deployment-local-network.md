# Deploying on a local network (Komodo + Traefik)

> **Retired.** This Komodo/Traefik recipe is no longer the deployed target —
> the app now deploys to Runflare (see `docs/server-migration.md` §Platform
> recipes A). The compose file and env template it references now live under
> `archive/deploy/`. Kept here as a reference for anyone still running this
> shape of stack.

How to run the POS on an always-on server managed by [Komodo](https://komo.do),
published over HTTPS through Traefik, so the cashier, waiter/garson phones, and
kitchen display all connect to it from the cafe's WiFi.

## The shape of the deployment

One always-on **server** runs the "brain": the Next.js app (which also serves
the `/ws` live-sync WebSocket) plus its PostgreSQL database. Everything else is
just a **browser** pointed at your HTTPS subdomain:

```
                       ┌─────────────────────────────────────────┐
                       │  Server (Docker + Komodo)                │
   cafe WiFi / LAN     │                                          │
                       │   Traefik ──TLS──►  app (Next.js + /ws)   │
  ┌───────────┐        │                         │                │
  │ Cashier   │──HTTPS─┼────────────────────────►│                │
  │ (till PC) │        │                     Postgres 16          │
  └───────────┘        │                                          │
  ┌───────────┐        └─────────────────────────────────────────┘
  │ Waiter    │──HTTPS──►  https://pos.example.com/dashboard/waiter
  │ phones    │
  └───────────┘
  ┌───────────┐
  │ Kitchen   │──HTTPS──►  https://pos.example.com/accounting/kitchen
  │ display   │
  └───────────┘
```

- The app container is **not** published to the host. The only way in is the
  HTTPS subdomain Traefik serves — Traefik terminates TLS and forwards to the
  app on its internal port 3000.
- Live sync needs nothing special: the browser connects to
  `wss://<your-domain>/ws` automatically when the page is HTTPS
  (`src/app/dashboard/use-realtime.ts`), and Traefik forwards the WebSocket
  upgrade transparently.
- Because the browser talks HTTPS, the `Secure` session cookie works correctly.
  (Serving the app over plain `http://` — no TLS — would break login, since a
  production `Secure` cookie is only sent over HTTPS. Traefik solves that.)

## What's in the repo for this

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build; runtime runs the custom server (`npm start` → `tsx server.ts`), the same as local. |
| `docker-entrypoint.sh` | Waits for Postgres, applies migrations, then starts the server. Runs on every deploy. |
| `archive/deploy/docker-compose.komodo.yml` | The stack: `app` + `db`, wired to Traefik via labels. |
| `archive/deploy/.env.komodo.example` | The variables the stack needs. |
| `.dockerignore` | Keeps secrets and local state out of the image. |

## Steps

### 1. DNS + Traefik cert

Point your subdomain (e.g. `pos.example.com`) at the server, and make sure your
Traefik certresolver can issue a cert for it (a public DNS name with Let's
Encrypt, or your own resolver). Note the **name of Traefik's Docker network**
and the **certresolver name** from your Traefik static config — you'll need both.

### 2. Create the Stack in Komodo

Point a Komodo **Stack** at this repo and set the compose file to
`archive/deploy/docker-compose.komodo.yml`. In the Stack's **Environment**, paste the values
from `archive/deploy/.env.komodo.example` and fill them in. At minimum:

- `POS_DOMAIN` — your subdomain
- `JWT_SECRET` — `openssl rand -hex 32`
- `POSTGRES_PASSWORD` — a strong password
- `TRAEFIK_NETWORK` — the name of Traefik's existing external network
- `TRAEFIK_CERTRESOLVER` — your certresolver name (e.g. `letsencrypt`)

### 3. Deploy

Komodo builds the image and starts the stack. On first boot the entrypoint
creates the schema (runs all migrations) and starts the server. Watch the `app`
logs for `Postgres is ready` → `Applying database migrations` →
`Ready on http://localhost:3000`.

### 4. First run

Open `https://pos.example.com`. On an empty database it routes to `/welcome` to
create the business + first Owner, then the industry-shaped setup wizard (see the README).
To skip the wizard with demo data instead, run a one-off `npm run db:seed`
inside the app container (Komodo terminal / exec).

### 5. Connect the phones and displays

- **Waiter / garson:** open `https://pos.example.com/login` in the phone
  browser → **PIN tab** → 4-digit PIN → they land on their waiter board (only
  the floor sections assigned to them). "Add to Home Screen" makes it feel like
  a native app.
- **Kitchen display:** open `https://pos.example.com/accounting/kitchen` on the
  KDS screen and log in with the kitchen PIN.
- **Cashier / till:** open `https://pos.example.com/accounting/pos`.

All screens refetch on the relevant WebSocket event, so a new order appears on
the KDS and the waiter board instantly — no refresh, no polling.

## The receipt printer / cash drawer

The **Windows print connector is separate from the cloud/container on purpose.**
It runs on the cashier PC physically attached to the receipt printer or cash
drawer, and the dashboard's browser talks to it directly on
`127.0.0.1:9123`; the traffic does **not** go through the server or Traefik.

No technical setup is required on the till. Sign in to the POS on that Windows
PC, open «تنظیمات → چاپ و فاکتور → چاپگرها», click **«دانلود و نصب رابط چاپ
ویندوز»**, and open the downloaded file once. The per-user installer needs no
administrator rights, Node.js, repository checkout, command line, or manual
configuration. It starts the connector immediately and at each Windows login.
The connector reads the normal unshared queues shown in Windows «Printers &
scanners» and sends jobs through the native spooler.

On Chrome/Edge 142+, allow the site's Local network access prompt (labelled
**Apps on device** for loopback on newer versions), return to the settings page,
and click «بررسی دوباره». `NEXT_PUBLIC_PRINT_CONNECTOR_URL` is only for
nonstandard development setups; ordinary Windows users leave it unset.

A printer with an Ethernet port but no WiFi (plugged into a WiFi extender's LAN
port, e.g. a TP-Link RE200) is a supported shape — the extender's mode, the
printer's fixed IP and diagnostics are in
[docs/network-printer-wifi-extender.md](network-printer-wifi-extender.md).

## Backups

Scheduled backups (Phase 10) write to `/app/backups` inside the app container,
which the stack keeps on the `pos-backups` volume. For off-machine safety,
configure the Owner dashboard's cloud (S3) target and/or mount a
`BACKUP_SECONDARY_DIR` (USB/NAS). Restore runbook: `docs/backup-restore.md`.

## Operating notes

- **Everything depends on the router.** Phones reach the server over the cafe
  WiFi; if the router or server is down, the clients can't sync. Keep the server
  and router on a UPS if you can.
- **Updating:** push to your branch, then redeploy the Stack in Komodo — the
  image rebuilds and the entrypoint re-runs migrations (already-applied ones are
  skipped).
- **Migrations are forward-only.** A deploy never rewrites history; it only
  applies new `migrations/NNNN_*.sql` files.
