# Performance audit — Shahrivar 1405 / September 2026

Part A (platform + application performance) of a two-part audit. Everything below was
**measured on a running system**, not inferred from reading code; where a finding is
structural rather than benchmarked it says so.

Full report with query plans and before/after timings:
<https://claude.ai/code/artifact/47f97438-dd6f-4ea1-bb78-58ec5872860f>

Scope: this repo @ `e16b54e`, and [`eshobe-cms`](https://github.com/hamidnoshady/eshobe-cms)
@ `6b85c66` (its own findings are in that repo's `docs/audits/performance-audit-2026-09.md`).

## The bench

PostgreSQL 16.13 with `pg_stat_statements`, connected as `pos_app` — the
`NOSUPERUSER NOBYPASSRLS` role `scripts/create-app-role.ts` provisions, so **every plan below
has RLS actually applied**. Data: 2 businesses × 1 branch, 400,000 orders (60 open) over 900
days, 1,200,000 order lines, 266,668 payments, 266,668 journal entries, 533,336 journal lines,
80,000 customers, all 160 migrations. App: `next build` production bundle, `NODE_ENV=production`,
real session cookie.

Limits worth stating. One host, loopback to Postgres, no network RTT — so every "extra round
trip" finding below is **understated** against a managed database. No max-RPS figure was
obtainable: `BUSINESS_API_LIMIT = 300/min` refuses load before the server is stressed (25
connections for 20 s → 300 successes, 1,060 × 429). LiteLLM and OpenObserve are optional
compose profiles and were not stood up; those findings are read from config and marked as such.

## Fail table

| | # | Finding | Where | Impact |
|---|---|---|---|---|
| P0 | 1 | Enum predicates cannot be index conditions under RLS | database-wide | **142 → 14.6 ms (9.7×)** |
| P0 | 2 | Platform console counts every order, per business, per page load | `platform-service.ts:100` | 446 ms at 2 tenants; O(n×m) |
| P0 | 3 | Unindexed FK on `orders.customer_id` (297 unindexed FKs total) | `migrations/0002` | 50.6 → 9.5 ms per delete |
| P0 | 4 | Checkout customer picker reads the whole customer table | `customers-service.ts:202` | **36.4 → 0.14 ms (260×)** |
| P0 | 5 | A GET endpoint performs 18 INSERTs per request | `api/reports/saved/route.ts:11` | 18 writes × every call |
| P0 | 6 | Feature/module/app gates re-queried on every request | `auth.ts:161–188` | 4 queries + 4 checkouts/req |
| P1 | 7 | Rate limiter makes an HTTP round trip to itself, then writes to Postgres | `rate-limit.ts:151` | 6.72 ms floor on every request |
| P1 | 8 | Tenant scoping costs one extra statement per pool checkout | `db.ts:38` | 6.9 statements/req |
| P1 | 9 | Thirteen background ticks share the API event loop | `server.ts:89–206` | no worker container |
| P1 | 10 | No graceful shutdown | `server.ts` | in-flight requests dropped |
| P1 | 11 | Production runs `tsx server.ts` on Node 20 | `package.json` · `Dockerfile` | transpile at boot |
| P1 | 12 | No heap budget, no cluster, single process per container | `Dockerfile:60` | 1 core of N used |
| P1 | 13 | API JSON uncompressed; no cache headers on API responses | `Caddyfile` | 6.8× on `/api/orders` |
| P1 | 15 | Eleven queue/log tables grow without bound | app-wide | `rate_limits` grows per IP seen |
| P1 | 16 | No traces, no RED metrics, no `tenant_id` on telemetry | `observability.ts` | errors and >1 s only |
| P1 | 17 | LiteLLM has no cache, no Redis, unbounded spend logs | `docker/litellm/config.yaml` | worst case 360 s/turn |
| P1 | 18 | Two outbound clients on request paths have no timeout | `sms-kavenegar.ts` · `payment-gateway.ts` | unbounded hang |
| P1 | 19 | Customer search is `ILIKE '%…%'` with no trigram index | `customers-service.ts:213` | 57.2 ms, 38,889 rows discarded |
| P1 | 20 | The dashboard order list has no hard maximum | `order-read-service.ts:59` | 250 ms / 4.9 MB disk sort at 33k |
| P2 | 22 | 297 `CREATE INDEX`, zero `CONCURRENTLY` | `migrations/` · `scripts/migrate.ts` | 415 ms lock at 1.2 M rows |
| P2 | 23 | JSONB equality lookups with no expression index | `loyalty-service.ts:269` +2 | no GIN on 60+ jsonb columns |
| P2 | 24 | A constant HMAC is recomputed on every request | `internal-auth.ts:43` | 0.099 ms/req, avoidable |
| P2 | 26 | `SELECT *` on tables with jsonb columns | `reports-service.ts` +others | jsonb pulled unused |
| P2 | 27 | No client-side request dedup or cache | `src/app/dashboard/**` | duplicate fetches on remount |

(Findings 14, 21 and 25 are `eshobe-cms`; see that repo's doc.)

## The one to fix first

**`enum_eq` is not `LEAKPROOF`, so no enum predicate can ever be an index condition on an
RLS table.**

Postgres evaluates RLS quals before any user qual that is not leakproof. `uuid_eq`,
`texteq`, `int8eq` and `timestamptz_ge` are leakproof; `enum_eq` is not. So on every RLS
table, a composite index whose second column is an enum **collapses to its leading prefix** —
`idx_orders_location_status (location_id, status)` is used, but only for `location_id`.

`GET /api/orders`, on a branch with 60 open bills:

```
Sort (actual time=142.413..142.428 rows=30 loops=1)
  -> Bitmap Heap Scan on orders o (actual time=21.639..84.168 rows=30)
       Rows Removed by Filter: 199970          <-- 30 rows returned, 200k scanned
       Heap Blocks: exact=9931
       -> Bitmap Index Scan on idx_orders_location_status (rows=233312)
            Index Cond: (location_id = '…'::uuid)    <-- status is NOT here
            Filter: (… OR hashed SubPlan 1) AND (status = 'open')
```

The fix is a new forward-only migration:

```sql
-- migrations/0136_enum_eq_leakproof.sql
-- enum_eq compares two OIDs. It cannot raise a data-dependent error and cannot
-- reveal the value it was handed, which is exactly what LEAKPROOF asserts.
ALTER FUNCTION enum_eq(anyenum, anyenum) LEAKPROOF;
ALTER FUNCTION enum_ne(anyenum, anyenum) LEAKPROOF;
```

Measured after:

```
Sort (actual time=14.501..14.510 rows=30 loops=1)
  -> Index Scan using idx_orders_location_status
       Index Cond: ((location_id = '…') AND (status = 'open'))
Execution Time: 14.635 ms
```

End to end: `GET /api/orders` p50 **158 ms → 19 ms**, p95 165 → 23 ms (production build, 12
serial warmed requests). The same demotion applies to `order_items.status` (KDS),
`payments.method`, `stock_movements.type` and every other enum column on an RLS table, so one
migration fixes all of them.

`ALTER FUNCTION … LEAKPROOF` is superuser-only DDL and applies database-wide, which is a fair
reason to hesitate. The per-query alternative reaches the same plan by putting the enum value in
an index *predicate*, which the planner proves at plan time rather than as a qual:
`CREATE INDEX CONCURRENTLY idx_orders_open ON orders (location_id, opened_at DESC) WHERE status = 'open'`
measured 26.3 ms on the same query. Either way the wider point stands: **several composite
indexes in this schema are not doing what their definitions suggest.**

## Suggested order of work

1. **#1**, the `LEAKPROOF` migration — two lines, 9.7× on the busiest read, fixes every enum
   predicate at once.
2. **#3 and #4**, eight index definitions in one migration — measured 5× and 260×. Wants
   `CONCURRENTLY`, so either do #22's runner change first or apply by hand.
3. **#6 and #5** — one small TTL cache module and one `ensureStandardSavedReports` rewrite;
   removes ~5 queries and 18 writes per affected request.
4. **#10 and #18** — a `SIGTERM` handler and two `AbortSignal.timeout` calls. Each is
   currently a way to lose a payment.
5. **#16, then measure again.** Per-route p95 and a `tenant_id` on telemetry are missing, so
   everything past this point is guesswork without them. The load-test scenario and a stored
   baseline belong in the same change.

## What passes

Worth knowing, because it changes where the next hour goes:

- **Policy functions are `STABLE`**, verified via `pg_proc.provolatile`. The location-scoped
  policies use `location_id IN (SELECT …)`, which the planner hashes into one subplan per
  statement — migration 0021 says so and the plans confirm it.
- **The tenant filter *is* an `Index Cond`**, not a `Filter` — `uuid_eq` is leakproof. That is
  the half of #1 that works.
- **215 of 215 RLS tables carry a policy**, with `FORCE ROW LEVEL SECURITY`.
- **Tenant context is set once per checkout, not per statement.** Wrapping `pool.connect`
  rather than `pool.query` is the right place; #8 is about the remaining per-checkout cost, not
  the design.
- Cache hit ratio **0.9972**; no `idle in transaction` sessions.
- Pooling: `max` 20 (env-overridable, reasoned), `connectionTimeoutMillis` 30 s rather than
  pg's "wait forever", `keepAlive`, and an `error` listener so an idle-client failure does not
  take the process down.
- No synchronous blocking on request paths — the PDF font is memoised, the browser is a shared
  promise, everything else is test code. `bcrypt.compare` async at cost 12 from one constant.
- One `console.log` in non-test source. No `moment`, no `lodash`, no aws-sdk v2.
- **LLM path**: streaming end-to-end with `stream_options.include_usage`, a per-call
  `AbortController` deadline, batched embeddings, and an answer cache keyed on the *business
  day* plus a tool signature.
- **Frontend**: heaviest first-load route is 305 kB raw (~100 kB gz, under the 300 kB gz
  target); operational screens are pushed over `/ws`, not polled — only two `setInterval`
  refreshes exist in the whole dashboard.

## Reproducing this

```sql
-- Is the enum problem live on your database?
SELECT proname, proleakproof FROM pg_proc WHERE proname IN ('enum_eq','uuid_eq');

-- The plan that matters most.
BEGIN;
SET LOCAL app.business_id = '<business uuid>';
EXPLAIN (ANALYZE, BUFFERS) SELECT o.id FROM orders o
 WHERE o.location_id = '<location uuid>' AND o.status = 'open';
ROLLBACK;
-- Look for `status` inside Index Cond. If it is under Filter instead, and
-- Rows Removed by Filter is large, finding #1 applies.

-- Missing FK indexes (297 here; triage by table size, not by count).
SELECT c.conrelid::regclass AS tbl, string_agg(a.attname, ',') AS cols
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
 WHERE c.contype = 'f' AND NOT EXISTS (
   SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid
     AND (i.indkey::int2[])[0:array_length(c.conkey,1)-1] @> c.conkey)
 GROUP BY c.conrelid, c.conname ORDER BY 1;

-- Unused indexes — run against PRODUCTION stats, not a bench.
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
  FROM pg_stat_user_indexes
 WHERE idx_scan = 0 AND indexrelname NOT LIKE '%pkey'
 ORDER BY pg_relation_size(indexrelid) DESC;
```

Queries per request, for any endpoint:

```bash
psql -c "SELECT pg_stat_statements_reset(0,0,0);"
curl -s -o /dev/null -b cookies.txt "https://<host>/api/orders"
psql -c "SELECT sum(calls) FROM pg_stat_statements s
           JOIN pg_roles r ON r.oid = s.userid WHERE r.rolname = 'pos_app';"
# Target is under 10. Measured: /api/orders 16, /api/menu 27,
# /api/reports/saved 31, /api/customers 6, /api/team 6.
```
