/**
 * `POST /api/native-devices` at the HTTP boundary (issue #884).
 *
 * `native-device-registry.integration.test.ts` already proves the service
 * layer and `checkNativeDevice`'s session-generation enforcement against the
 * real schema. This file proves the one thing only the route handler itself
 * can be responsible for: a `device_revoked` registration failure still
 * binds the *current* session to that device before returning the error, so
 * the browser ends up denied on its very next request even though the
 * registrar component that called this route never reads the response body
 * (see `src/components/native/native-device-registrar.tsx` and the route's
 * own doc comment). Without this, a revoked installation whose
 * re-registration attempt fails would keep a fully authenticated,
 * completely unbound session for the rest of that token's life.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

// Route-level integration tests replace only the cookie store, the same way
// hybrid-credential-sync.integration.test.ts does it, so real route handlers
// can be called directly without a running Next.js server.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
  headers: async () => new Headers(),
}));

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let authLib: typeof import("../src/lib/auth");
let nativeDevices: typeof import("../src/lib/native-device-service");
let postRoute: typeof import("../src/app/api/native-devices/route").POST;

const alpha = { businessId: "", ownerId: "" };

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

async function seedBusiness(name: string, slug: string) {
  const business = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [name, slug],
  );
  const businessId = business.rows[0].id;
  const owner = await db.query<{ id: string }>(
    `INSERT INTO users (business_id, role, full_name, password_hash)
     VALUES ($1, 'owner', $2, 'test') RETURNING id`,
    [businessId, `${name} مالک`],
  );
  return { businessId, ownerId: owner.rows[0].id };
}

function registerRequest(installationId: string) {
  return new NextRequest("http://localhost/api/native-devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      installationId,
      environment: "production",
      appVersionName: "1.0.0",
      appVersionCode: 1,
      bridgeVersion: 2,
    }),
  });
}

async function signInOwner(): Promise<void> {
  jar.set(
    authLib.SESSION_COOKIE,
    await authLib.signSession({
      sub: alpha.ownerId,
      role: "owner",
      businessId: alpha.businessId,
      locationId: null,
      fullName: "مالک",
    }),
  );
}

beforeAll(async () => {
  databaseName = `native_device_route_${randomUUID().replaceAll("-", "")}`;
  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });
  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  authLib = await import("../src/lib/auth");
  nativeDevices = await import("../src/lib/native-device-service");
  postRoute = (await import("../src/app/api/native-devices/route")).POST;
  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib?.closeDatabasePool().catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  jar.clear();
  await db.query("DELETE FROM businesses");
  Object.assign(alpha, await seedBusiness("آلفا", `alpha-${randomUUID().slice(0, 8)}`));
  await signInOwner();
});

describe("POST /api/native-devices", () => {
  it("binds the session on success", async () => {
    const installationId = `install-${randomUUID()}`;
    const response = await postRoute(registerRequest(installationId));
    expect(response.status).toBe(201);
    const cookie = response.cookies.get(authLib.SESSION_COOKIE)?.value;
    expect(cookie).toBeTruthy();
    const session = await authLib.resolveSessionFromToken(cookie);
    expect(session?.nativeDeviceId).toBeTruthy();
  });

  it("still binds the session to the device on a device_revoked failure, so the next request is denied", async () => {
    const installationId = `install-${randomUUID()}`;

    // First registration succeeds, then an owner revokes it.
    const first = await postRoute(registerRequest(installationId));
    expect(first.status).toBe(201);
    const { device } = (await first.json()) as { device: { id: string } };
    await dbLib.withTenant(alpha.businessId, () =>
      nativeDevices.revokeOwnNativeDevice(device.id, alpha.businessId, alpha.ownerId),
    );

    // The member signs back in (a fresh, unbound session — exactly what the
    // registrar's next attempt after a relaunch/login would present) and the
    // app retries registration, which must fail.
    await signInOwner();
    const retry = await postRoute(registerRequest(installationId));
    expect(retry.status).toBe(409);
    const body = (await retry.json()) as { error: string };
    expect(body.error).toBe("device_revoked");

    // The bug this guards against: without binding on failure, this response
    // would carry no Set-Cookie at all, and the session the member is
    // sitting on right now would stay fully authenticated and completely
    // unbound — checkNativeDevice never runs for it — for the rest of its
    // life, regardless of how many times registration keeps failing.
    const boundCookie = retry.cookies.get(authLib.SESSION_COOKIE)?.value;
    expect(boundCookie).toBeTruthy();
    const boundSession = await authLib.resolveSessionFromToken(boundCookie);
    expect(boundSession).toBeNull();
  });
});
