import { AsyncLocalStorage } from "node:async_hooks";
import { Pool, type PoolClient } from "pg";
import {
  businessScope,
  getTenantScope,
  runInTenantScope,
  scopeSettings,
  type TenantScope,
} from "./tenant-context";
import { connectTimeoutMs, poolMax } from "./pool-config";
import {
  describeConnectFailure,
  isRetryableConnectError,
  withConnectRetry,
} from "./db-retry";

// Reuse the pool across Next.js dev-server hot reloads.
const globalForPg = globalThis as unknown as { pgPool?: Pool };

/**
 * Applies the current tenant scope to every connection the pool hands out.
 *
 * Phase 12: tenant isolation is enforced by Postgres RLS keyed on the
 * `app.business_id` session setting (migration 0021), so that setting has to
 * be correct on whatever connection a statement lands on. Wrapping `connect`
 * — rather than only `query` — is what makes this airtight: node-postgres
 * implements `pool.query()` in terms of `pool.connect()`, so this single hook
 * covers both the one-off `query()` helper below AND the ~30 places that check
 * out a client directly to run a transaction. None of them had to change.
 *
 * The GUCs are set on EVERY checkout, including to empty when there is no
 * scope. That is deliberate and load-bearing: a pooled connection can never
 * be reused while still carrying the previous caller's business, because the
 * next caller always overwrites it before issuing a statement.
 */
function installTenantScoping(pool: Pool): Pool {
  const rawConnect = pool.connect.bind(pool) as typeof pool.connect;

  const applyScope = async (client: PoolClient, scope: TenantScope) => {
    const { businessId, bypass } = scopeSettings(scope);
    await client.query(
      "SELECT set_config('app.business_id', $1, false), set_config('app.rls_bypass', $2, false)",
      [businessId, bypass],
    );
  };

  /**
   * One checkout: take a connection and stamp the caller's scope onto it.
   *
   * Both halves are retried together by `checkout` below, which is safe
   * precisely because nothing else has run on this connection yet — the scope
   * statement is an idempotent `set_config`, and a checkout that never
   * connected never reached the server at all.
   */
  const rawCheckout = async (scope: TenantScope): Promise<PoolClient> => {
    const client = await (rawConnect as () => Promise<PoolClient>)();
    try {
      await applyScope(client, scope);
      return client;
    } catch (err) {
      client.release(err as Error);
      throw err;
    }
  };

  const checkout = (scope: TenantScope): Promise<PoolClient> =>
    withConnectRetry(() => rawCheckout(scope), {
      onRetry: (err, attempt, delay) =>
        console.warn(
          `postgres checkout failed (attempt ${attempt}), retrying in ${delay}ms: ` +
            describeConnectFailure(err, process.env.DATABASE_URL),
        ),
    }).catch((err: unknown) => {
      noteUnreachableDatabase(err);
      throw err;
    });

  function scopedConnect(this: Pool, callback?: unknown): unknown {
    // Captured here, before any awaiting, so the scope is the caller's even if
    // the checkout has to queue behind a busy pool.
    const scope = getTenantScope();

    // `pool.query()` — which is how `query()` below, and therefore most of the
    // app, reaches the database — calls `connect` in its callback form, so the
    // retry has to cover this branch too, not just the promise one.
    if (typeof callback === "function") {
      const cb = callback as (err?: Error, client?: PoolClient, done?: (r?: unknown) => void) => void;
      checkout(scope).then(
        (client) => cb(undefined, client, (err?: unknown) => client.release(err as Error | undefined)),
        (err: Error) => cb(err),
      );
      return undefined;
    }

    return checkout(scope);
  }

  pool.connect = scopedConnect as typeof pool.connect;
  return pool;
}

/**
 * Say once — not once per failed request — what an unreachable database means.
 *
 * A resolver blip fails every in-flight page and every background tick at the
 * same instant, so the raw `getaddrinfo EAI_AGAIN <host>` stack arrives a dozen
 * times over and says nothing about what to do about it. This adds one
 * actionable line per minute alongside them; the errors themselves still
 * propagate untouched, so callers keep seeing the real `code`.
 */
let lastUnreachableNoteAt = 0;
function noteUnreachableDatabase(err: unknown): void {
  if (!isRetryableConnectError(err)) return;
  const now = Date.now();
  if (now - lastUnreachableNoteAt < 60_000) return;
  lastUnreachableNoteAt = now;
  console.error(describeConnectFailure(err, process.env.DATABASE_URL));
}

function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    // Tenant-scoped work pins a connection for the length of a transaction, so
    // the pool needs a little more headroom than it did single-tenant. See
    // pool-config.ts: DB_POOL_MAX overrides the default of 20, which is
    // preserved for anyone who doesn't set it.
    max: poolMax(),
    // Every *new* connection costs a DNS lookup against the container runtime's
    // resolver, and that resolver is the part that flakes (see db-retry.ts). pg
    // would otherwise drop an idle connection after 10s and re-resolve the host
    // on the next request, turning a mostly-idle deployment into a steady
    // stream of lookups — each one a chance to fail. Hold connections open
    // instead, and keep the socket alive so a NAT/bridge doesn't cut it.
    keepAlive: true,
    idleTimeoutMillis: 60_000,
    // Without a ceiling, a dropped DNS query leaves the checkout hanging for
    // the OS resolver's full budget with the request waiting behind it. See
    // pool-config.ts for why the default is as generous as it is.
    connectionTimeoutMillis: connectTimeoutMs(),
  });

  // node-postgres emits this for a connection that failed while sitting idle in
  // the pool — the database restarted, the network dropped underneath it. It
  // belongs to no caller, and an EventEmitter 'error' with nobody listening
  // takes the whole process down with it: that is how a database blip became an
  // app restart. Log it and let the pool discard the client.
  pool.on("error", (err) => {
    console.error("postgres idle client error:", describeConnectFailure(err, connectionString));
  });

  return pool;
}

export function getPool(): Pool {
  if (!globalForPg.pgPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    globalForPg.pgPool = installTenantScoping(createPool(connectionString));
  }
  return globalForPg.pgPool;
}

/**
 * Drain and close the shared pool during an intentional server shutdown.
 *
 * Do not call getPool() here: a process that failed before its first database
 * checkout should not create a connection merely in order to close it.
 */
export async function closeDatabasePool(): Promise<void> {
  const pool = globalForPg.pgPool;
  if (!pool) return;
  await pool.end();
  if (globalForPg.pgPool === pool) globalForPg.pgPool = undefined;
}

/**
 * The client a surrounding `withTenantTransaction` has pinned, if any.
 *
 * AsyncLocalStorage rather than a module variable, for the same reason the
 * tenant scope uses one: concurrent requests share this module, and a plain
 * variable would leak one request's open transaction into another's queries.
 */
const pinnedClient = new AsyncLocalStorage<PoolClient>();

function runPinned<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  return pinnedClient.run(client, fn);
}

/**
 * Run one statement.
 *
 * Inside `withTenantTransaction` this goes to that transaction's pinned
 * client, so every statement in the callback shares one connection and one
 * transaction. Everywhere else it takes a connection from the pool per call,
 * which is the right default for the overwhelmingly common single-statement
 * case.
 */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params?: unknown[],
) {
  const pinned = pinnedClient.getStore();
  if (pinned) return runOnPinnedClient<T>(pinned, text, params);
  return getPool().query<T>(text, params as never);
}

/**
 * Serialise statements issued on a transaction's pinned client.
 *
 * A single pg client cannot run two queries at once. Inside a transaction,
 * `Promise.all([query(...), query(...)])` therefore does not parallelise
 * anything — it emits a deprecation warning and, on some driver versions,
 * interleaves the results onto the wrong promises. Rather than leave that as a
 * rule everyone has to remember, the calls are chained here: correctness is
 * structural, and the worst case is the sequential execution the caller would
 * have got anyway.
 *
 * Outside a transaction nothing is serialised — parallel reads across pooled
 * connections are genuinely parallel and are left alone.
 */
const pinnedQueues = new WeakMap<PoolClient, Promise<unknown>>();

function runOnPinnedClient<T extends Record<string, unknown>>(
  client: PoolClient,
  text: string,
  params?: unknown[],
) {
  const previous = pinnedQueues.get(client) ?? Promise.resolve();
  // `.catch` on the tail, not on the returned promise: one statement failing
  // must not stop later ones from being scheduled (the caller decides whether
  // to abort), but it also must not leave an unhandled rejection behind.
  const next = previous.then(
    () => client.query<T>(text, params as never),
    () => client.query<T>(text, params as never),
  );
  pinnedQueues.set(
    client,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Run `fn` scoped to one business.
 *
 * Use this anywhere a business is known but there is no request session to
 * derive it from — the background ticks in `server.ts` (rollup, backup,
 * server-sync) iterate businesses and must scope each iteration, and the
 * token-authenticated server-to-server routes resolve their business from a
 * bearer token rather than a cookie.
 */
export async function withTenant<T>(
  businessId: string,
  fn: () => Promise<T>,
  options: { locationId?: string | null; userId?: string | null } = {},
): Promise<T> {
  return runInTenantScope(
    businessScope(businessId, options.locationId ?? null, options.userId ?? null),
    fn,
  );
}

/**
 * Run `fn` inside ONE database transaction, scoped to one business.
 *
 * ## Why this exists, and what it fixes
 *
 * `withTenant` establishes the RLS scope but is **not** a transaction. Every
 * `query()` inside it checks out its own connection from the pool, so a
 * sequence of writes is a sequence of independent autocommits: a failure
 * halfway leaves the earlier ones committed, and — the part that bites
 * hardest — `SELECT ... FOR UPDATE` releases its lock the instant that one
 * statement's connection goes back to the pool.
 *
 * That makes a lock-then-check-then-write guard silently useless. Two
 * simultaneous requests both take the lock (sequentially, each on its own
 * connection), both see the pre-write state, and both proceed. It is the
 * classic double-submit: two customers created from one "convert" click, two
 * receipts for one payment.
 *
 * Inside this helper, `query()` is redirected to a single pinned client
 * wrapped in `BEGIN`/`COMMIT`, so `FOR UPDATE` holds for the whole callback
 * and a throw rolls everything back. Call sites need no change beyond swapping
 * `withTenant` for `withTenantTransaction`.
 *
 * ## When to use which
 *
 * - Read-only work, or a single write: `withTenant` is correct and cheaper —
 *   it does not hold a connection for the duration.
 * - Two or more writes that must all happen or none: this.
 * - Any `FOR UPDATE` / `pg_advisory_xact_lock` guard: **this**, always. Those
 *   constructs are defined in terms of a transaction and mean nothing outside
 *   one.
 */
export async function withTenantTransaction<T>(
  businessId: string,
  fn: () => Promise<T>,
  options: { locationId?: string | null; userId?: string | null } = {},
): Promise<T> {
  return withTenant(
    businessId,
    async () => {
      // The pool's connect hook stamps the tenant scope onto this client, so
      // RLS applies inside the transaction exactly as it does outside.
      const client = await getPool().connect();
      const previous = pinnedClient.getStore();
      try {
        await client.query("BEGIN");
        const result = await runPinned(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        // Roll back on any throw. A failed ROLLBACK (a connection that already
        // died) must not mask the original error, which is the one that
        // explains what went wrong.
        try {
          await client.query("ROLLBACK");
        } catch {
          // Intentionally ignored — see above.
        }
        throw error;
      } finally {
        void previous;
        client.release();
      }
    },
    options,
  );
}

/**
 * Run `fn` with tenant isolation deliberately stood down.
 *
 * Every legitimate reason shares one shape — resolving *which* tenant a
 * request is for, before that tenant can be known any other way — and
 * `reason` records which:
 *
 *   - **login** — resolving an email to the businesses it belongs to
 *     necessarily happens before a business has been chosen;
 *   - **platform** — the super-user realm administers every tenant by
 *     definition (Phase 15), as does the migration runner;
 *   - **server-sync-auth** — resolving a server-sync bearer token to the
 *     business it belongs to (Phase 17) is the same "identify the tenant
 *     first" problem as login, just keyed on a token instead of an email;
 *   - **api-key-auth** — resolving a public API bearer key to the
 *     business/location it belongs to (Phase 19) has the same identify-the-
 *     tenant-first shape as server-sync authentication;
 *   - **woocommerce-webhook-auth** — resolving an inbound WooCommerce webhook
 *     delivery (keyed on the connection id in its URL) to the business its
 *     store belongs to, before that business can be known any other way
 *     (Phase 23);
 *   - **woocommerce-plugin-auth** — the same lookup for the other way a store
 *     connects: resolving the WordPress plugin's link token to the connection,
 *     and therefore the business, that issued it. Keyed on a token hash rather
 *     than a URL id, which makes it the same shape as server-sync-auth and
 *     api-key-auth; the request's HMAC envelope is verified inside the same
 *     bypass, because the token it is verified against is what the lookup
 *     returns;
 *   - **identity** — a narrow write to the global identity table
 *     (`platform_users`, which carries no `business_id` to scope by) on
 *     behalf of a membership already verified to belong to the caller's own
 *     business, e.g. team-service.ts's credential reset;
 *   - **employee-session-auth** — re-checking an `employee_sessions` row
 *     (Phase 20 Wave 2) is still active, from `getSession()`, which runs
 *     this check before `enterTenantScope` has been called for the request —
 *     the same timing constraint `checkImpersonation`'s `activeGrant` lookup
 *     already has, just for a PIN login's session record instead of an
 *     impersonation grant.
 *   - **pairing-redeem** — resolving a one-time desktop pairing code to the
 *     business it was issued for (and reading that business's configuration to
 *     build the snapshot) happens before any tenant has been chosen, the same
 *     identify-the-tenant-first shape as server-sync-auth. Its counterpart on
 *     the local install, `applyPairingSnapshot`, runs under **platform** for
 *     the same reason `provisionBusiness` does: it creates the tenant that
 *     scoping would otherwise require to already exist.
 *
 *   - **host-resolution** — resolving a request's hostname to the business it
 *     addresses (Phase 23). The host *is* how a tenant gets identified once
 *     each business has its own origin, so this is the same identify-the-
 *     tenant-first shape as login and server-sync-auth, keyed on a DNS label.
 *     One read-only lookup against `businesses` and
 *     `business_subdomain_aliases`, returning the business's identity and
 *     nothing else about it.
 *
 *   - **mcp-token-auth** — resolving an MCP bearer credential (a static
 *     connector token, or an OAuth access token) to the connection, and
 *     therefore the business and branch, it belongs to (Phase 34). Identical in
 *     shape to api-key-auth and server-sync-auth: the token is *how* the tenant
 *     gets selected, so there is nothing to scope to until the lookup returns.
 *     The OAuth flow's own pre-session lookups — a client registration, an
 *     authorization code — are NOT here: they run on a business's own origin,
 *     so `resolveMcpTenant` names the tenant from the host first (under
 *     host-resolution) and every subsequent read runs inside `withTenant`.
 *
 *   - **impersonation-handoff** — redeeming the one-time token the console
 *     mints on admin.{root} so the browser can mint its impersonation session
 *     on the business's own origin (Phase 23 follow-up). The caller has no
 *     session on that origin yet — the token is what creates the first one —
 *     the same identify-the-tenant-first shape as login and accept-invite.
 *
 *   - **first-run** — `hasAnyUser()`: whether this install has been claimed by
 *     anyone at all. Install-wide by definition and asked before a tenant
 *     exists (it is what decides whether one should be created), so there is no
 *     scope that could express it — and left unscoped, RLS would answer 0
 *     forever, which is the failure mode this reason exists to prevent rather
 *     than a convenience. Returns a boolean about the install, never a row.
 *
 *   - **cms-billing-site-map** — resolving an eshobe-cms `site_id` on a usage
 *     batch to the business that owns `eshobe_cms_connections`, before any
 *     tenant is selected. The same identify-the-tenant-first shape as
 *     woocommerce-webhook-auth. The CMS never supplies `business_id`.
 *
 *   - **cms-order-webhook-site-map** — resolving `site_id` on a signed
 *     `POST /api/cms/order-events` delivery to its `eshobe_cms_connections`
 *     row before ingest runs under `withTenant`.
 *
 *   - **single-tenant-check** — `restoreAvailable()`: whether this install
 *     holds exactly one business. The same shape as `first-run` — a `count(*)`
 *     about the *install*, which no tenant scope can express, since the whole
 *     question is "is there more than one tenant here". It gates a
 *     whole-database restore, which replaces every business on the install, so
 *     scoped it would answer 1 on a shared server and green-light the one
 *     operation that must never run there. Returns a boolean, never a row.
 *
 * Every call is a hole in the isolation boundary, so keep them few, keep them
 * short, and never let one wrap a request body that also handles tenant data.
 */
export async function withoutTenantScope<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  return runInTenantScope({ kind: "bypass", reason }, fn);
}

/**
 * Whether RLS is actually capable of protecting anything on this connection.
 *
 * Superusers — and any role with BYPASSRLS — ignore row-level security
 * entirely, which would make every policy in migration 0021 a silent no-op
 * with no error and no log line. The stock `docker-compose.yml` and the CI
 * service both create `pos` as the database superuser, so this is the exact
 * mistake a deployment is most likely to make.
 */
export async function rlsEffective(): Promise<boolean> {
  const { rows } = await query<{ privileged: boolean }>(
    `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
  );
  return rows[0] ? !rows[0].privileged : false;
}

/**
 * Refuse to serve production traffic with tenant isolation disabled.
 *
 * Called at startup from `server.ts`. In development it warns instead, so a
 * contributor running the stock docker-compose isn't blocked — but the
 * isolation integration test always provisions an unprivileged role, so the
 * policies are proven regardless of how the local database is configured.
 */
export async function assertRlsEffective(): Promise<void> {
  if (await rlsEffective()) return;

  const message =
    "Tenant isolation is NOT enforced: the application's database role is a superuser or has " +
    "BYPASSRLS, so every row-level security policy is being ignored. Provision an unprivileged " +
    "role with `npm run db:app-role` and point DATABASE_URL at it.";

  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(`WARNING: ${message}`);
}

export type { PoolClient };
