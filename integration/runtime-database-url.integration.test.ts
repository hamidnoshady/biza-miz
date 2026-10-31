/**
 * Covers scripts/derive-runtime-database-url.ts, which is what makes the
 * shipped Docker entrypoint self-heal a deployment stuck exactly like the
 * Komodo crash this was written for: every compose file hands the app
 * container one Postgres superuser for both migrating and running, and
 * `assertRlsEffective()` correctly refuses to start the server against that
 * connection in production — the same superuser ignores every RLS policy
 * from migration 0021 outright.
 *
 * Real Postgres throughout (a throwaway database + a throwaway superuser
 * role), because the thing actually worth proving is "does this correctly
 * tell a superuser from a restricted role", not "does the mock get called".
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { dropAppRole } from "../src/lib/create-app-role";
import { deriveRuntimeDatabaseUrl } from "../scripts/derive-runtime-database-url";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let superuserUrl: string;

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

async function isPrivileged(databaseUrl: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ privileged: boolean }>(
      "SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user",
    );
    return rows[0].privileged;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  databaseName = `pos_runtime_url_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  superuserUrl = urlFor(databaseName);
  await runMigrations({ databaseUrl: superuserUrl, quiet: true });
}, 120_000);

afterAll(async () => {
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    // deriveRuntimeDatabaseUrl provisions the role through `createAppRole`, whose
    // replay capability is a parameter grant that depends on the role: revoke it
    // first, or DROP ROLE refuses to run.
    await dropAppRole(maintenance, "pos_app_runtime_url_test");
  } finally {
    await maintenance.end();
  }
});

describe("this is actually the bug that hit Komodo", () => {
  it("reproduces: every shipped compose file's DATABASE_URL is a superuser connection", async () => {
    // If this ever starts failing, it means the shipped superuser DATABASE_URL
    // stopped being privileged and the whole scenario this script exists for
    // no longer applies — worth knowing, not something to quietly adjust.
    expect(await isPrivileged(superuserUrl)).toBe(true);
  });
});

describe("deriveRuntimeDatabaseUrl", () => {
  it("provisions a restricted role and returns a connection that is actually restricted", async () => {
    const runtimeUrl = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      APP_DB_USER: "pos_app_runtime_url_test",
    });

    expect(runtimeUrl).not.toBe(superuserUrl);
    expect(new URL(runtimeUrl).username).toBe("pos_app_runtime_url_test");
    expect(await isPrivileged(runtimeUrl)).toBe(false);

    // And the derived connection can actually reach the database — not just
    // parse as a URL — with real, working data access.
    const client = new Client({ connectionString: runtimeUrl });
    await client.connect();
    try {
      await expect(client.query("SELECT 1")).resolves.toBeTruthy();
    } finally {
      await client.end();
    }
  });

  it("reuses the source URL's password rather than requiring a new secret", async () => {
    const runtimeUrl = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      APP_DB_USER: "pos_app_runtime_url_test",
    });

    expect(new URL(runtimeUrl).password).toBe(new URL(superuserUrl).password);
  });

  it("is idempotent — re-running against an already-provisioned role doesn't fail", async () => {
    const first = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      APP_DB_USER: "pos_app_runtime_url_test",
    });
    const second = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      APP_DB_USER: "pos_app_runtime_url_test",
    });

    expect(second).toBe(first);
    expect(await isPrivileged(second)).toBe(false);
  });

  it("leaves an already-restricted DATABASE_URL untouched rather than provisioning a second role", async () => {
    const runtimeUrl = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      APP_DB_USER: "pos_app_runtime_url_test",
    });

    // Feed the already-restricted connection back in as if it were the boot
    // DATABASE_URL — must pass through unchanged, not attempt to create yet
    // another role (which would fail: this role has no CREATEROLE grant).
    const passthrough = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: runtimeUrl,
    });
    expect(passthrough).toBe(runtimeUrl);
  });

  it("an explicit RUNTIME_DATABASE_URL always wins, no provisioning attempted", async () => {
    const explicit = "postgres://someone:else@elsewhere/db";
    const result = await deriveRuntimeDatabaseUrl({
      DATABASE_URL: superuserUrl,
      RUNTIME_DATABASE_URL: explicit,
    });
    expect(result).toBe(explicit);
  });

  it("throws a clear error rather than silently doing nothing when DATABASE_URL is missing", async () => {
    await expect(deriveRuntimeDatabaseUrl({})).rejects.toThrow(
      "DATABASE_URL is not set",
    );
  });
});
