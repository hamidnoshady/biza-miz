/**
 * The runtime-role provisioner (issue #807).
 *
 * The case that made this file exist: the packaged-desktop acceptance run
 * restores as the very role in `DATABASE_URL` — the embedded cluster's
 * bootstrap superuser. `ALTER ROLE <current_user> ... NOSUPERUSER` is refused by
 * PostgreSQL ("permission denied to alter role"), the restore engine now treats
 * a failed re-grant as fatal, and so a correct restore rolled itself back and
 * failed the release gate. These pin the decision and, just as importantly,
 * that everything else about the lock-down still happens.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queries: [] as { text: string; values?: unknown[] }[],
  state: { exists: false, is_current: false, is_superuser: false },
  failRoleLookup: false,
}));

vi.mock("pg", () => ({
  Client: class {
    constructor(_options: unknown) {}
    async connect() {}
    async end() {}
    async query(text: string, values?: unknown[]) {
      h.queries.push({ text, values });
      if (h.failRoleLookup && text.includes("FROM pg_roles WHERE rolname = $1")) {
        throw new Error("permission denied to alter role");
      }
      if (text.includes("FROM pg_roles WHERE rolname = $1")) return { rows: [h.state] };
      if (text.includes("quote_literal")) return { rows: [{ literal: `'${String(values?.[0] ?? "")}'` }] };
      if (text.includes("current_database()")) return { rows: [{ current_database: "pos" }] };
      return { rows: [] };
    }
  },
}));

import { createAppRole, decodeUrlCredential, DEFAULT_APP_ROLE } from "./create-app-role";
import { regrantAppRole } from "./restore-engine";

const DATABASE_URL = "postgres://pos:pos@127.0.0.1:5432/pos";

beforeEach(() => {
  h.queries.length = 0;
  h.state = { exists: false, is_current: false, is_superuser: false };
  h.failRoleLookup = false;
});

const sqlText = () => h.queries.map((entry) => entry.text);
const find = (pattern: RegExp) => sqlText().find((text) => pattern.test(text));

describe("createAppRole — provisioning the restricted runtime role", () => {
  it("creates a missing role with the full lock-down clause and every grant", async () => {
    const result = await createAppRole({ databaseUrl: DATABASE_URL, password: "s3cret", quiet: true });

    expect(result).toEqual({ role: DEFAULT_APP_ROLE, superuser: false });
    expect(find(/^CREATE ROLE pos_app /)).toBe(
      "CREATE ROLE pos_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 's3cret'",
    );
    expect(find(/^ALTER ROLE /)).toBeUndefined();
    expect(find(/GRANT CONNECT ON DATABASE "pos" TO pos_app/)).toBeDefined();
    expect(find(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos_app/)).toBeDefined();
    expect(find(/REVOKE ALL ON TABLE schema_migrations FROM pos_app/)).toBeDefined();
    expect(find(/GRANT SELECT ON TABLE schema_migrations TO pos_app/)).toBeDefined();
  });

  it("updates an existing role that is not the connection's own", async () => {
    h.state = { exists: true, is_current: false, is_superuser: true };

    const result = await createAppRole({ databaseUrl: DATABASE_URL, password: "s3cret", quiet: true });

    expect(result.superuser).toBe(false);
    expect(find(/^ALTER ROLE pos_app /)).toBe(
      "ALTER ROLE pos_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 's3cret'",
    );
  });

  it("skips only the self-demotion when the runtime role is the connection's own superuser", async () => {
    h.state = { exists: true, is_current: true, is_superuser: true };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createAppRole({ databaseUrl: DATABASE_URL, roleName: "pos", password: "pos", quiet: true });

    expect(result).toEqual({ role: "pos", superuser: true });
    expect(find(/^ALTER ROLE pos /)).toBe("ALTER ROLE pos WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'pos'");
    // The one token PostgreSQL refuses — and nothing else — is dropped.
    expect(sqlText().some((text) => text.includes("NOSUPERUSER"))).toBe(false);
    expect(find(/GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pos/)).toBeDefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("own role and a SUPERUSER"));
    warn.mockRestore();
  });

  it("omits only the SUPERUSER clause for the connection's own non-superuser role, without warning", async () => {
    h.state = { exists: true, is_current: true, is_superuser: false };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await createAppRole({ databaseUrl: DATABASE_URL, password: "pos_app", quiet: true });

    expect(result).toEqual({ role: DEFAULT_APP_ROLE, superuser: false });
    // PostgreSQL refuses a SUPERUSER change for the session's own role whether
    // or not it has the attribute ("Only roles with the SUPERUSER attribute may
    // change the SUPERUSER attribute"), so the token goes either way — but there
    // is no privilege left behind to warn about.
    expect(find(/^ALTER ROLE pos_app /)).toBe(
      "ALTER ROLE pos_app WITH LOGIN NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'pos_app'",
    );
    expect(find(/NOSUPERUSER/)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports the role as ready unless asked to stay quiet", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await createAppRole({ databaseUrl: DATABASE_URL, password: "s3cret" });

    expect(log).toHaveBeenCalledWith("Role pos_app is ready on database pos.");
    log.mockRestore();
  });

  it("decodes a percent-encoded credential and leaves a malformed escape alone", () => {
    expect(decodeUrlCredential("p%40ss%2Fw")).toBe("p@ss/w");
    expect(decodeUrlCredential("plain")).toBe("plain");
    expect(decodeUrlCredential("bad%zz")).toBe("bad%zz");
  });

  it("refuses an identifier PostgreSQL could not quote safely and a missing password", async () => {
    await expect(
      createAppRole({ databaseUrl: DATABASE_URL, roleName: "pos-app", password: "x", quiet: true }),
    ).rejects.toThrow(/invalid_role_name/);
    await expect(createAppRole({ databaseUrl: DATABASE_URL, password: "", quiet: true })).rejects.toThrow(
      /APP_DB_PASSWORD is required/,
    );
  });
});

describe("regrantAppRole — the restore path's hard failure contract", () => {
  it("refuses to continue without a runtime URL", async () => {
    await expect(regrantAppRole(DATABASE_URL, {})).rejects.toThrow(/restore_runtime_url_missing/);
    await expect(regrantAppRole(DATABASE_URL, { DATABASE_URL: "not-a-url" })).rejects.toThrow(
      /restore_runtime_url_invalid/,
    );
    await expect(regrantAppRole(DATABASE_URL, { DATABASE_URL: "postgres://pos@127.0.0.1:5432/pos" })).rejects.toThrow(
      /restore_runtime_url_incomplete/,
    );
  });

  it("re-grants the role named by the runtime URL and reports its posture", async () => {
    h.state = { exists: true, is_current: false, is_superuser: false };
    const result = await regrantAppRole(DATABASE_URL, { DATABASE_URL: "postgres://pos_app:pw@127.0.0.1:5432/pos" });

    expect(result).toEqual({ role: "pos_app", superuser: false });
    expect(find(/^ALTER ROLE pos_app /)).toBeDefined();
  });

  it("sets the decoded password, not the URL's percent-encoded spelling", async () => {
    h.state = { exists: true, is_current: false, is_superuser: false };

    const result = await regrantAppRole(DATABASE_URL, {
      DATABASE_URL: "postgres://pos_app:p%40ss%2Fw@127.0.0.1:5432/pos",
    });

    expect(result.role).toBe("pos_app");
    expect(find(/^ALTER ROLE pos_app /)).toBe(
      "ALTER ROLE pos_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD 'p@ss/w'",
    );
  });

  it("still fails hard when the grant itself fails", async () => {
    h.failRoleLookup = true;

    await expect(
      regrantAppRole(DATABASE_URL, { DATABASE_URL: "postgres://pos_app:pw@127.0.0.1:5432/pos" }),
    ).rejects.toThrow(/restore_regrant_failed:permission denied to alter role/);
  });
});
