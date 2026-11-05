import { Client } from "pg";

export const DEFAULT_APP_ROLE = "pos_app";

/**
 * Every attribute the runtime role must end up with: login, and none of the
 * powers that ignore row-level security.
 */
const RESTRICTED_ATTRIBUTES = ["LOGIN", "NOSUPERUSER", "NOBYPASSRLS", "NOCREATEDB", "NOCREATEROLE"] as const;

export interface AppRoleOptions {
  databaseUrl: string;
  roleName?: string;
  password: string;
  quiet?: boolean;
}

export interface AppRoleResult {
  role: string;
  /**
   * True when the role is still a PostgreSQL superuser after this call. The
   * only way that happens is the case below — the target role is the
   * connection's own role, and PostgreSQL refuses to let a session drop its own
   * SUPERUSER attribute — so callers that report on the security posture
   * (restore-engine does) can read it here instead of re-querying `pg_roles`.
   */
  superuser: boolean;
}

function assertSafeIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid_role_name: ${name}`);
  return name;
}

/**
 * `URL.username`/`URL.password` keep the percent-encoded spelling, and `pg`
 * decodes it when it opens a connection. Anything that turns those values into
 * SQL must decode first, or a password like `p@ss/w` would be *set* on the role
 * as `p%40ss%2Fw` while the application still connects with the decoded form —
 * an authentication failure that only shows up after a restore. A malformed
 * escape is left alone rather than thrown on, so a hand-written URL cannot make
 * provisioning crash for a cosmetic reason.
 */
export function decodeUrlCredential(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Anything that can run a statement — the pool, a `pg` client, or a test double. */
export interface SqlRunner {
  query(queryText: string): Promise<unknown>;
}

/**
 * Drop a runtime role this module may have provisioned.
 *
 * `createAppRole` grants the role SET on `session_replication_role` (see there),
 * and PostgreSQL records that grant in `pg_parameter_acl`, which *depends on the
 * role*: a plain `DROP ROLE` then fails with "role ... cannot be dropped because
 * some objects depend on it". Revoking first is the only way to remove a role
 * whose capability was granted. Tolerates a role that never existed, or a
 * cluster that never had the grant.
 */
export async function dropAppRole(client: SqlRunner, roleName: string): Promise<void> {
  const role = assertSafeIdentifier(roleName);
  await client
    .query(`REVOKE SET ON PARAMETER session_replication_role FROM ${role}`)
    .catch(() => {});
  await client.query(`DROP ROLE IF EXISTS ${role}`);
}

/** Idempotently provisions the restricted NOSUPERUSER/NOBYPASSRLS runtime role. */
export async function createAppRole(options: AppRoleOptions): Promise<AppRoleResult> {
  const role = assertSafeIdentifier(options.roleName ?? DEFAULT_APP_ROLE);
  if (!options.password) throw new Error("APP_DB_PASSWORD is required");
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ exists: boolean; is_current: boolean; is_superuser: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists,
              EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1 AND rolname = current_user) AS is_current,
              COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = $1), false) AS is_superuser`,
      [role],
    );
    const quotedPassword = (
      await client.query<{ literal: string }>("SELECT quote_literal($1::text) AS literal", [options.password])
    ).rows[0].literal;
    const state = rows[0];
    // `ALTER ROLE <current_user> ... NOSUPERUSER` is refused outright
    // ("permission denied to alter role", DETAIL "Only roles with the SUPERUSER
    // attribute may change the SUPERUSER attribute"): PostgreSQL does not let a
    // session touch its own SUPERUSER attribute. That is not a hypothetical —
    // the packaged desktop acceptance run and any deployment whose DATABASE_URL
    // is the bootstrap superuser re-grant as exactly that role, and issue #807
    // makes a failed re-grant roll the swap back, so treating this as an error
    // would turn a correct restore into an outage. Skip only that one token:
    // the rest of the hardening and every GRANT below still run, and a role
    // that stays a superuser produces a loud warning naming the privilege that
    // could not be removed.
    const selfRole = state.exists && state.is_current;
    const selfSuperuser = selfRole && state.is_superuser;
    if (selfSuperuser) {
      console.warn(
        `create-app-role: ${role} is this connection's own role and a SUPERUSER, and PostgreSQL does not allow a session to drop its own SUPERUSER attribute; ` +
          "the role keeps unrestricted access. Provision the runtime role from a separate admin connection to fix this permanently.",
      );
    }
    const attributes = RESTRICTED_ATTRIBUTES.filter(
      (attribute) => !(selfRole && attribute === "NOSUPERUSER"),
    ).join(" ");
    await client.query(
      state.exists
        ? `ALTER ROLE ${role} WITH ${attributes} PASSWORD ${quotedPassword}`
        : `CREATE ROLE ${role} WITH ${attributes} PASSWORD ${quotedPassword}`,
    );
    const database = (await client.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0].current_database;
    await client.query(`GRANT CONNECT ON DATABASE "${database}" TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${role}`);
    // A central tenant restore replays an archive into the business's tables.
    // The triggers on those tables police *live* mutations and reject a faithful
    // replay — the order-item guard refuses even the DELETE of an item belonging
    // to a completed order — so `applyTenantArchive` replays with
    // `session_replication_role = replica`, scope-local to its transaction. That
    // is a parameter only a superuser may set unless it is granted, and this role
    // is never a superuser by design, so the grant is what makes an ordinary
    // business restorable at all. It does not weaken RLS, checks, foreign keys or
    // any constraint — only ordinary triggers, and only for the session that sets
    // it. Servers older than 15 have no such grant: warn, so an operator learns
    // why restores refuse rather than discovering it mid-incident.
    try {
      await client.query(`GRANT SET ON PARAMETER session_replication_role TO ${role}`);
    } catch {
      console.warn(
        `create-app-role: could not grant SET on session_replication_role to ${role} ` +
          "(PostgreSQL 15+ is required); tenant restores of this database will refuse with " +
          "restore_requires_trigger_bypass.",
      );
    }
    await client.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
    );
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`);
    await client.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${role}`);
    await client.query(`REVOKE ALL ON TABLE schema_migrations FROM ${role}`);
    await client.query(`GRANT SELECT ON TABLE schema_migrations TO ${role}`);
    if (!options.quiet) console.log(`Role ${role} is ready on database ${database}.`);
    return { role, superuser: selfSuperuser };
  } finally {
    await client.end();
  }
}
