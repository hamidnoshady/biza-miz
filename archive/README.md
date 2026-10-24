# Archive

Compose files moved out of the repo root during the switch to Runflare as the deployment
target, kept for reference rather than deleted. Nothing here is read by the app,
the build, or `docker-entrypoint.sh` — it is excluded from the Docker build
context (see `.dockerignore`).

## `deploy/`

Compose files and env templates for hosting platforms this app no longer
deploys to (Komodo, ParsPack, srv1) plus their OpenObserve overlays. Each is
still referenced from the relevant doc as a "retired, kept for reference"
recipe:

- `docker-compose.komodo.yml`, `.env.komodo.example` — see
  [`docs/deployment/deployment-local-network.md`](../docs/deployment/deployment-local-network.md).
- `docker-compose.srv1.yml` — see
  [`docs/deployment/server-migration.md`](../docs/deployment/server-migration.md) §Platform recipes.
- `docker-compose.parspack.yml`, `.env.parspack.example` — see
  [`docs/deployment/parspack-deployment.md`](../docs/deployment/parspack-deployment.md).
- `docker-compose.observability.yml`, `docker-compose.observability.local.yml`
  — see [`docs/deployment/openobserve.md`](../docs/deployment/openobserve.md); for Runflare, that
  doc's §D covers wiring OpenObserve as a second Runflare service instead.

`docker-compose.local.yml` (the on-premise café server stack) and
`docker-compose.yml` (local dev Postgres) are **not** here — both are still
live, documented deployment paths and stay at the repo root.

If any of these is ever pressed back into service, note that
`docker-compose.komodo.yml`'s `build.context` was updated to `../..` to
account for the move — everything else is unchanged from its original,
root-level version.
