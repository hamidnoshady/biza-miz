/**
 * The restore path's re-grant, against the two real PostgreSQL shapes it meets
 * (issue #807).
 *
 * `regrantAppRole` has to end with a runtime role that can actually use the
 * restored database, and it fails hard when it cannot — the apply path rolls
 * the swap back. The regression this file pins was found by the packaged
 * Windows release gate: the desktop acceptance run restores as the embedded
 * cluster's *bootstrap superuser*, and `ALTER ROLE <current_user> ...
 * NOSUPERUSER` is refused by PostgreSQL ("Only roles with the SUPERUSER
 * attribute may change the SUPERUSER attribute"). Because a failed re-grant is
 * now fatal, that refused token turned a correct restore into a rolled-back
 * one, and the gate went red.
 *
 * Two cases follow, both against real roles rather than a mock:
 *
 *   1. a separate runtime role (`pos_app`'s shape) — the full lock-down is
 *      applied to a role that is *not* the connection's own, and the role must
 *      be able to connect and read afterwards;
 *   2. the connection's own role — the impossible token is skipped, the role
 *      keeps its grants, and the caller is told the role is still a superuser
 *      instead of the restore being thrown away.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createAppRole, DEFAULT_APP_ROLE } from "../src/lib/create-app-role";
import { regrantAppRole, validateRuntimeAccess } from "../src/lib/restore-engine";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

const probeRole = `${DEFAULT_APP_ROLE}_regrant_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

async function sql<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = new Client({ connectionString: databaseUrl! });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

// Resolved while the file is collected, not in a beforeAll: `it.skipIf` decides
// whether a test exists at collection time, so a hook would be too late and both
// cases below would silently skip on every run.
const [bootstrap] = await sql<{ current_user: string; rolsuper: boolean; rolcreaterole: boolean }>(
  "SELECT current_user, rolsuper, rolcreaterole FROM pg_roles WHERE rolname = current_user",
);
const currentRole = bootstrap.current_user;
const superuser = bootstrap.rolsuper;
const canCreateRoles = bootstrap.rolsuper || bootstrap.rolcreaterole;
const currentPassword = decodeURIComponent(new URL(databaseUrl).password);

afterAll(async () => {
  if (!canCreateRoles) return;
  await sql(`DROP OWNED BY ${probeRole}`).catch(() => {});
  await sql(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => {});
});

describe("re-granting a separate runtime role", () => {
  it.skipIf(!canCreateRoles)("locks it down and leaves it able to connect and read", async () => {
    await sql(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => {});
    const result = await createAppRole({ databaseUrl, roleName: probeRole, password: "probe-password", quiet: true });

    expect(result).toEqual({ role: probeRole, superuser: false });
    const attributes = await sql<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1",
      [probeRole],
    );
    expect(attributes[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });

    // The lock-down is not the point on its own: the restored database has to
    // be *readable* by this role, and schema_migrations must stay read-only.
    const runtime = new URL(databaseUrl!);
    runtime.username = probeRole;
    runtime.password = "probe-password";
    const client = new Client({ connectionString: runtime.toString() });
    await client.connect();
    try {
      const applied = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM schema_migrations");
      expect(Number(applied.rows[0].n)).toBeGreaterThan(0);
      await expect(client.query("DELETE FROM schema_migrations")).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
    }
  });
});

describe("re-granting the connection's own role", () => {
  it.skipIf(!superuser)("skips the self-demotion instead of failing the restore", async () => {
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = currentRole;
    runtimeUrl.password = currentPassword;
    const env = { DATABASE_URL: runtimeUrl.toString() };

    const result = await regrantAppRole(databaseUrl, env);

    // Every attribute that *can* be re-applied still is; SUPERUSER is the one
    // PostgreSQL will not let a session touch, and the caller is told so.
    expect(result).toEqual({ role: currentRole, superuser: true });
    await expect(validateRuntimeAccess(env)).resolves.toBeUndefined();

    const stillSuperuser = await sql<{ rolsuper: boolean }>(
      "SELECT rolsuper FROM pg_roles WHERE rolname = $1",
      [currentRole],
    );
    expect(stillSuperuser[0].rolsuper).toBe(true);
  });
});
