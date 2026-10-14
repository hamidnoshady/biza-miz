#!/usr/bin/env bash
# Local integration-test Postgres (sandbox-resilient).
# Usage: bash scripts/dev-local-pg.sh setup   # initdb + roles + citext (idempotent)
#        bash scripts/dev-local-pg.sh start   # foreground postgres on 127.0.0.1:5432
# The data dir lives OUTSIDE git under .local-pg/ (gitignored); suites re-migrate
# and re-seed themselves, so losing it only costs one re-init.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATADIR="$ROOT/.local-pg"
BIN="$ROOT/node_modules/@embedded-postgres/linux-x64/native/bin"

case "${1:-}" in
  setup)
    if [ ! -d "$DATADIR/base" ]; then
      # A byte-wise (C/POSIX) ctype corrupts every multibyte regexp/translate the
      # app relies on — e.g. the Persian search normaliser in shift-orders-service
      # mangled 'علی رضایی' into garbage and the shift-orders report test lost
      # all of its matches. Pin a UTF-8 ctype so the sandbox cluster behaves the
      # way every strtouq developer machine (and CI) does.
      "$BIN/initdb" -D "$DATADIR" -U pos --pwfile=<(echo pos) --encoding=UTF8 --locale=C.utf8 >/dev/null
      echo "listen_addresses = '127.0.0.1'" >> "$DATADIR/postgresql.conf"
    fi
    echo "setup: cluster ready at $DATADIR (start it, then run: bash $0 roles)"
    ;;
  roles)
    PGCONN="postgres://pos:pos@127.0.0.1:5432/postgres"
    node -e "
const { Client } = require('pg');
(async () => {
  const c = new Client({ connectionString: '$PGCONN' });
  await c.connect();
  await c.query('CREATE EXTENSION IF NOT EXISTS citext').catch((e) => { if (!String(e.message).includes('already exists')) throw e; });
  const dbs = (await c.query(\"SELECT datname FROM pg_database WHERE datname = 'pos'\")).rows;
  if (dbs.length === 0) await c.query('CREATE DATABASE pos');
  const c2 = new Client({ connectionString: 'postgres://pos:pos@127.0.0.1:5432/pos' });
  await c2.connect();
  await c2.query('CREATE EXTENSION IF NOT EXISTS citext').catch(() => {});
  await c2.end();
  await c.end();
  console.log('roles: pos user/db + citext ready');
})().catch((e) => { console.error(e.message); process.exit(1); });"
    ;;
  start)
    exec "$BIN/postgres" -D "$DATADIR"
    ;;
  *) echo "usage: $0 {setup|start|roles}" >&2; exit 2 ;;
esac
