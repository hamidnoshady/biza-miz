# syntax=docker/dockerfile:1

# Production image for the POS app (Next.js custom server in server.ts).
#
# The app does NOT use `next start`; `npm start` runs `tsx server.ts`, which
# boots Next in production mode AND the `/ws` WebSocket sync channel. So tsx is
# a RUNTIME dependency: it is listed under "dependencies" in package.json,
# because the prod-deps stage below prunes dev dependencies out and a
# devDependency would be dropped from the image at exactly the moment the
# entrypoint calls it. Alongside it the runtime image keeps the source tree,
# `.next` build output, migrations and scripts — the scripts it runs at boot
# are TypeScript too, so anything they import (dotenv, pg) must also be a
# runtime dependency. src/lib/runtime-dependencies.test.ts guards this.
#
# Chromium IS installed in the runner: the app server renders print jobs
# itself now (src/app/api/print/* on top of src/lib/system-print/) — the
# browser's print client falls back to it when no local print agent answers
# on the till — and report PDF export (src/lib/pdf-render.ts) needs the same
# engine. Network (ESC/POS over TCP) printers are reachable from the
# container; Windows-installed queues still need the local print agent on the
# till PC, since a Linux container cannot enumerate the host's spooler.

# ---- deps: install all dependencies (dev deps are needed to build) ----------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Cache mount keyed on the image's npm cache dir: on a builder that persists
# BuildKit cache between deploys (e.g. registry cache export/import), this
# turns an unchanged package-lock.json into a install from cache instead of a
# full re-download — the biggest single lever on deploy time we don't control
# from inside the Dockerfile alone. Harmless (a plain `docker build` with no
# cache backend just skips it) when it isn't.
RUN --mount=type=cache,target=/root/.npm npm ci

# ---- builder: produce the .next production build ----------------------------
FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Keep the heap override scoped to Next's build command rather than the runtime
# image. CI passes 3072 MB so Next can use the resized runner without starving
# Docker and PostgreSQL of memory.
ARG NODE_OPTIONS
ENV NODE_ENV=production
# next build only needs JWT_SECRET to be *set* to satisfy the prod env check;
# pages that read cookies() render dynamically at request time, not at build.
# It is deliberately NOT an ENV/ARG instruction: BuildKit's
# SecretsUsedInArgOrEnv rule flags any ARG/ENV whose name looks like a
# credential, because such a value is baked into the image's metadata and is
# readable with `docker history` / `docker inspect` on every layer that
# follows. Setting it inline on this one RUN keeps it scoped to the single
# build command — no image layer, no metadata, nothing to leak — and it is a
# throwaway placeholder either way; the real secret is injected at runtime by
# the deployment (see docker-compose.srv1.yml's JWT_SECRET).
RUN JWT_SECRET=build-time-placeholder-not-used-at-runtime \
    NODE_OPTIONS="$NODE_OPTIONS" npm run build
# Next serves public/ directly; it includes the dependency-free Windows print
# connector downloaded by the authenticated one-click installer route. Keep the
# directory creation defensive for source/export variants that omit assets.
RUN mkdir -p public

# ---- prod-deps: strip dev dependencies out of the already-installed tree ----
# Deliberately not a second `npm ci --omit=dev`: that would re-resolve and
# re-download the ~36 production packages a second time for no reason, since
# the `deps` stage already installed them (alongside the 14 dev-only ones
# `npm run build` needed). `npm prune` is a local operation on the tree we
# already have — no registry round trip — so this is strictly a subset of the
# work the old second `npm ci` did.
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev

# ---- runner: the image that actually runs in Komodo -------------------------
FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Production backup/restore tools are resolved only from this verified payload.
ENV PG_TOOLS_DIR=/opt/postgresql-tools

# Which "sha-<short-hash>" tag this image was published as, baked in at build
# time so the running process can report its own version — the self-update check (app-update.ts)
# compares this against what a paired café laptop is running. Defaults to
# "unknown" for a local `docker build` with no --build-arg, which the update
# check treats as "nothing to compare, never offer an update".
ARG GIT_SHA=unknown
ENV APP_IMAGE_SHA=$GIT_SHA

# postgresql-client gives pg_isready / pg_dump / pg_restore. The app's backup
# system (Phase 10) shells out to pg_dump/pg_restore, and the entrypoint uses
# pg_isready to wait for the DB before migrating.
# su-exec is used to drop privileges from root after fixing volume permissions.
# chromium is the rendering engine for server-side printing (/api/print/*) and
# report PDF export — playwright-core drives it, it is never downloaded by npm.
# ttf-dejavu satisfies fontconfig; the actual receipt font (Vazirmatn) is
# embedded into the HTML as a data URI by the renderer.
RUN apk add --no-cache postgresql16-client su-exec chromium ttf-dejavu
# Both renderers (src/lib/pdf-render.ts and src/lib/system-print/render.ts)
# honour this before falling back to their auto-detection.
ENV PDF_CHROMIUM_PATH=/usr/bin/chromium-browser

# Production tree only — dev dependencies pruned out, so dependencies only.
# tsx belongs there (see the note at the top of this file): the entrypoint
# runs TS scripts and `npm start` runs `tsx server.ts`.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/.next ./.next
COPY --from=builder --chown=node:node /app/public ./public
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/migrations ./migrations
COPY --from=builder --chown=node:node /app/scripts ./scripts
COPY --from=builder --chown=node:node /app/server.ts ./server.ts
COPY --from=builder --chown=node:node /app/next.config.ts ./next.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=builder --chown=node:node /app/package.json ./package.json
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh

# apk verifies the Alpine repository signature when installing postgresql16-client.
# Stage its exact binaries with a checksum manifest, then exercise the same
# production resolver used by platform backup/restore. No database is needed:
# this catches missing tools, bad manifests and version drift during image build.
RUN node scripts/stage-container-postgresql-tools.mjs \
  && node --import tsx --input-type=module -e 'import { resolvePgTool } from "./src/lib/pg-tools.ts"; const [dump, restore] = await Promise.all([resolvePgTool("pg_dump"), resolvePgTool("pg_restore")]); if (dump.postgresVersion !== restore.postgresVersion) throw new Error("postgresql_tools_version_pair_mismatch"); console.log(`Verified packaged PostgreSQL ${dump.postgresVersion} tools.`);'

RUN chmod +x ./docker-entrypoint.sh

# Fail the BUILD, not a café's Monday morning, if tsx ever drops out of the
# production tree again. `npm ci --omit=dev` makes that failure invisible until
# the container boots and the entrypoint cannot find its TypeScript runner —
# so assert it here, where the fix is a one-line package.json change.
RUN test -x ./node_modules/.bin/tsx \
  || { echo "tsx is missing from the production dependency tree: it is required at runtime (entrypoint + 'npm start'), so it belongs in package.json \"dependencies\", not \"devDependencies\"."; exit 1; }

EXPOSE 3000

# The route is deliberately database-less: Docker/Coolify should only replace a
# process when the web tier itself is dead, not turn a brief Postgres outage into
# a restart loop. The long start period covers the entrypoint's database wait +
# migrations; Docker marks the container healthy immediately on an early success,
# so this does not delay a normal ~15 second boot. BusyBox wget is included in the
# Alpine base image, avoiding curl just for one probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

# The entrypoint waits for Postgres, applies migrations, then starts the server.
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["npm", "start"]
