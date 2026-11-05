/**
 * Issue #903 §10 — **the "Real acceptance" line, as an executable matrix**.
 *
 * The epic's last P0 asks for evidence across every path it defines: "Cloud,
 * Hybrid (online/offline/reconnect), Full Offline, corruption, S3 outage,
 * huge/interrupted files, lost keys/device, concurrency, storage retention,
 * billing, and multi-tenant restore drills". Each of those had unit coverage and
 * none of them had been run end to end against a real PostgreSQL and a real
 * bucket-shaped endpoint — the only arrangement where the pieces are wired to
 * each other rather than mocked apart.
 *
 * So this suite stands up the runtime the way a deployment runs it:
 *
 *  • a real PostgreSQL with the full migration set, connected as the
 *    unprivileged app role, so row-level security is actually filtering;
 *  • a path-style S3 endpoint on localhost that stores, lists, serves and
 *    deletes bytes — and that can be told to go down or to store only part of a
 *    body, which is how a provider outage and an interrupted upload actually
 *    look from the application's side;
 *  • the managed service configured the way the console configures it (sealed
 *    credentials under the platform KEK), so `resolveTenantStorage` answers
 *    `managed` instead of falling back to a legacy bucket;
 *  • three businesses on the three profiles the epic distinguishes.
 *
 * It deliberately does NOT duplicate the suites that prove a narrower thing
 * better: `tenant-restore-apply.integration.test.ts` owns the destructive-apply
 * path (lock, journal, rollback, cross-tenant) and
 * `tenant-backup-isolation.integration.test.ts` owns the #807 admission guards.
 * The matrix in `docs/deployment/managed-tenant-backup-rollout.md` names one
 * owner per row, so "where is this proven?" has a single answer.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";
import { createAppRole, dropAppRole } from "../scripts/create-app-role";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) throw new Error("DATABASE_URL is required for database integration tests");

const APP_ROLE = "pos_backup_accept_role";
const APP_PASSWORD = "backup-accept-password";
const BUCKET = "accept-bucket";
const PREFIX = "managed/";

let dbName: string;
let workDir: string;
let seed: Client;
let s3Server: Server;
let s3Endpoint = "";

let dbLib: typeof import("../src/lib/db");
let svc: typeof import("../src/lib/backup-service");
let storage: typeof import("../src/lib/tenant-backup-storage");
let artifacts: typeof import("../src/lib/tenant-backup-artifacts-service");
let lifecycle: typeof import("../src/lib/tenant-backup-lifecycle");
let drill: typeof import("../src/lib/tenant-backup-drill");
let hybrid: typeof import("../src/lib/tenant-backup-hybrid");
let billing: typeof import("../src/lib/tenant-backup-billing-jobs");
let ops: typeof import("../src/lib/platform-tenant-backup-ops");
let transport: typeof import("../src/lib/tenant-backup-transport");
let runner: typeof import("../src/lib/tenant-backup-runner");
let refs: typeof import("../src/lib/tenant-backup-artifact-ref");

/**
 * What the bucket is doing right now. A provider answering 503 and one that
 * stores only part of a body are two different failures a backup system must
 * not call success.
 */
type S3Mode = "ok" | "down" | "truncate";
let s3Mode: S3Mode = "ok";
/** Every request the endpoint received, so "no outbound call at all" is provable. */
let s3Requests = 0;
const objects = new Map<string, Buffer>();

const bizA = { id: "" }; // cloud
const bizB = { id: "" }; // local
const bizC = { id: "" }; // hybrid

function urlFor(database: string, user?: { name: string; password: string }): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  if (user) {
    url.username = user.name;
    url.password = user.password;
  }
  return url.toString();
}

function asTenant<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  return dbLib.withTenant(businessId, fn);
}

function backupConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 5,
    directory: "",
    passphrase: "acceptance-passphrase",
    encryptLocal: true,
    ...overrides,
    cloud: {
      enabled: false,
      endpoint: "",
      region: "us-east-1",
      bucket: "",
      prefix: "pos-backups/",
      accessKeyId: "",
      secretAccessKey: "",
      passphrase: "",
      retention: 30,
      ...((overrides.cloud as Record<string, unknown>) ?? {}),
    },
  } as Parameters<typeof svc.setBackupConfig>[1];
}

/**
 * The bucket mock. Deliberately dumb about SigV4 — `s3-lite-upload.test.ts` owns
 * signature correctness against a strict mock — and deliberately precise about
 * bytes, because the question here is what the runtime does with a body that is
 * short or refused.
 */
function startS3Mock(): Server {
  return createServer((req: IncomingMessage, res) => {
    s3Requests += 1;
    if (s3Mode === "down") {
      res.statusCode = 503;
      res.end("<Error><Code>ServiceUnavailable</Code></Error>");
      return;
    }
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    const rawPath = parsed.pathname.replace(/^\/+/, "");
    const slash = rawPath.indexOf("/");
    const key = slash === -1 ? "" : decodeURIComponent(rawPath.slice(slash + 1));

    if (req.method === "GET" && !key && parsed.searchParams.get("list-type") === "2") {
      const prefix = parsed.searchParams.get("prefix") ?? "";
      const contents = [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(
          ([k, body]) =>
            `<Contents><Key>${k}</Key><Size>${body.byteLength}</Size><LastModified>2020-01-01T00:00:00.000Z</LastModified></Contents>`,
        )
        .join("");
      res.statusCode = 200;
      res.setHeader("content-type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      );
      return;
    }

    if (req.method === "HEAD") {
      const body = objects.get(key);
      res.statusCode = body ? 200 : 404;
      if (body) res.setHeader("content-length", String(body.byteLength));
      res.end();
      return;
    }

    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        // An interrupted upload: the provider accepted the request and stored
        // less than it was sent.
        objects.set(key, s3Mode === "truncate" && body.byteLength > 64 ? body.subarray(0, body.byteLength - 64) : body);
        res.statusCode = 200;
        res.setHeader("etag", `"${randomUUID().slice(0, 8)}"`);
        res.end();
      });
      return;
    }

    if (req.method === "GET") {
      const body = objects.get(key);
      if (!body) {
        res.statusCode = 404;
        res.end("<Error><Code>NoSuchKey</Code></Error>");
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-length", String(body.byteLength));
      res.end(body);
      return;
    }

    if (req.method === "DELETE") {
      objects.delete(key);
      res.statusCode = 204;
      res.end();
      return;
    }

    res.statusCode = 405;
    res.end();
  });
}

/** The one stored object that belongs to this artifact (whatever prefix it used). */
function storedObject(artifact: string): { key: string; body: Buffer } {
  const match = [...objects.entries()].find(([key]) => key.endsWith(artifact));
  if (!match) throw new Error(`object for ${artifact} is not in the bucket`);
  return { key: match[0], body: match[1] };
}

/** Post-hoc damage — bit rot, a bad replica, ransomware. Nothing the upload saw. */
function damageStoredObject(artifact: string): void {
  const { key, body } = storedObject(artifact);
  const damaged = Buffer.from(body);
  damaged[damaged.length - 1] ^= 0xff;
  objects.set(key, damaged);
}

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "pos-backup-accept-"));

  s3Server = startS3Mock();
  await new Promise<void>((resolve) => s3Server.listen(0, "127.0.0.1", resolve));
  s3Endpoint = `http://127.0.0.1:${(s3Server.address() as AddressInfo).port}`;

  dbName = `pos_bkp_accept_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await maintenance.end();
  }
  await runMigrations({ databaseUrl: urlFor(dbName), quiet: true });
  await createAppRole({
    databaseUrl: urlFor(dbName),
    roleName: APP_ROLE,
    password: APP_PASSWORD,
    quiet: true,
  });

  seed = new Client({ connectionString: urlFor(dbName) });
  await seed.connect();

  for (const [business, name, profile] of [
    [bizA, "Abr Cloud", "cloud"],
    [bizB, "Baran Local", "local"],
    [bizC, "Chekameh Hybrid", "hybrid"],
  ] as const) {
    const inserted = await seed.query<{ id: string }>(
      "INSERT INTO businesses (name, slug) VALUES ($1,$2) RETURNING id",
      [name, `accept-${randomUUID().slice(0, 8)}`],
    );
    business.id = inserted.rows[0].id;
    // The profile is the *tenant's* stored setting. On a central role it would
    // otherwise default to `cloud` and every business would look like a cloud
    // tenant — which is exactly the distinction this matrix is testing.
    await seed.query(
      `INSERT INTO settings (business_id, key, value) VALUES ($1, 'deployment.profile', $2::jsonb)
       ON CONFLICT DO NOTHING`,
      [business.id, JSON.stringify({ profile })],
    );
  }

  process.env.DATABASE_URL = urlFor(dbName, { name: APP_ROLE, password: APP_PASSWORD });
  process.env.DEPLOYMENT_ROLE = "central";
  process.env.BACKUP_DIR = path.join(workDir, "backups");
  delete process.env.BACKUP_SECONDARY_DIR;
  process.env.POS_MASTER_KEY = randomBytes(32).toString("base64");
  process.env.TENANT_BACKUP_STAGING_DIR = path.join(workDir, "staging");

  dbLib = await import("../src/lib/db");
  svc = await import("../src/lib/backup-service");
  storage = await import("../src/lib/tenant-backup-storage");
  artifacts = await import("../src/lib/tenant-backup-artifacts-service");
  lifecycle = await import("../src/lib/tenant-backup-lifecycle");
  drill = await import("../src/lib/tenant-backup-drill");
  hybrid = await import("../src/lib/tenant-backup-hybrid");
  billing = await import("../src/lib/tenant-backup-billing-jobs");
  ops = await import("../src/lib/platform-tenant-backup-ops");
  transport = await import("../src/lib/tenant-backup-transport");
  runner = await import("../src/lib/tenant-backup-runner");
  refs = await import("../src/lib/tenant-backup-artifact-ref");

  // The console's own write path, so the sealed credentials and the managed
  // destination are exactly what an operator would have produced.
  const configured = await storage.updateTenantBackupService({
    managedCloud: true,
    hybridEnabled: true,
    endpoint: s3Endpoint,
    region: "us-east-1",
    bucket: BUCKET,
    keyPrefix: PREFIX,
    accessKeyId: "ACCEPTACCESSKEY",
    secretAccessKey: "accept-secret-key",
    defaultIntervalHours: 24,
    defaultRetentionDays: 30,
    maxRetentionDays: 365,
    cloudKeepCount: 30,
    alertFailureStreak: 1,
    drillIntervalHours: 24,
  });
  if (!configured.ok) throw new Error(`service configuration failed: ${configured.error}`);
}, 300_000);

afterAll(async () => {
  await seed?.end().catch(() => {});
  await dbLib?.getPool().end().catch(() => {});
  await new Promise<void>((resolve) => s3Server?.close(() => resolve()));
  process.env.DATABASE_URL = rootDatabaseUrl;
  delete process.env.DEPLOYMENT_ROLE;
  delete process.env.BACKUP_DIR;
  delete process.env.POS_MASTER_KEY;
  delete process.env.TENANT_BACKUP_STAGING_DIR;
  await fs.rm(workDir, { recursive: true, force: true });

  const maintenance = new Client({ connectionString: urlFor("postgres") });
  await maintenance.connect();
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await dropAppRole(maintenance, APP_ROLE);
  } finally {
    await maintenance.end();
  }
});

beforeEach(async () => {
  s3Mode = "ok";
  objects.clear();
  for (const table of [
    "billing_usage_ratings",
    "billing_usage_events",
    "tenant_backup_artifacts",
    "tenant_backup_upload_queue",
    "tenant_backup_storage_samples",
    "tenant_backup_site_heartbeat",
    "tenant_backup_drills",
    "tenant_backup_restore_jobs",
    "backup_runs",
  ]) {
    await seed.query(`DELETE FROM ${table}`).catch(() => undefined);
  }
});

/** Configure a business for backups and take one, returning the artifact name. */
async function takeLocalBackup(businessId: string): Promise<string> {
  await asTenant(businessId, () => svc.setBackupConfig(businessId, backupConfig()));
  const result = await asTenant(businessId, () => svc.runLocalBackup(businessId, "manual"));
  if (result.status !== "ok") throw new Error(`local backup failed: ${JSON.stringify(result)}`);
  return result.artifact;
}

/** A two-hour window with a sample at each end, so the byte-day integral is exact. */
function sampledWindow(): { from: Date; to: Date } {
  const to = new Date();
  return { from: new Date(to.getTime() - 2 * 60 * 60 * 1000), to };
}

/** Download a cloud artifact and run the verifier against the bytes that came back. */
async function verifyCloudCopy(
  businessId: string,
  ref: string,
): Promise<{ ok: boolean; error?: string }> {
  const fetched = await asTenant(businessId, () =>
    transport.fetchCloudArtifact({ businessId, ref, profile: "cloud", role: "central", suffix: "accept" }),
  );
  if (!fetched.ok) return { ok: false, error: fetched.error };
  try {
    const schemaVersion = await asTenant(businessId, () => artifacts.installedSchemaVersion());
    return await asTenant(businessId, () =>
      runner.verifyStoredArtifact(businessId, { ref, stagedPath: fetched.path, schemaVersion }),
    );
  } finally {
    await fetched.cleanup().catch(() => undefined);
  }
}

describe("Cloud: a backup reaches managed storage, is proved by a drill, and leaves nothing local", () => {
  it("walks the whole chain, then reclaims the staged copy", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("ok");
    // The provider accepted the bytes. That is a request, not a copy.
    expect([...objects.keys()].some((key) => key.endsWith(artifact))).toBe(true);

    // The mirror path registers the cloud row `ready` on the strength of the
    // upload's payload hash, so nothing is left in the verify queue for it (see
    // the rollout doc: the pending-verification pass covers uploads, not
    // mirrors). The bytes themselves are proved by the drill below.
    expect(await asTenant(bizA.id, () => lifecycle.pendingVerificationCount(bizA.id))).toBe(0);

    // §1: on Cloud the server keeps no persistent second copy.
    const tick = await lifecycle.runBackupLifecycleTick(new Date());
    expect(tick.reclaimed).toBeGreaterThanOrEqual(1);
    const rows = await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id));
    expect(rows.length).toBe(1);
    expect(rows[0].destination).toBe("cloud");

    const inventory = await asTenant(bizA.id, () =>
      artifacts.tenantBackupInventory(bizA.id, { profile: "cloud", connectivity: "online" }),
    );
    expect(inventory.items.length).toBe(1);
    const item = inventory.items[0];
    expect(item.restorable).toBe(true);
    expect(item.destinations.find((destination) => destination.destination === "cloud")?.state).toBe("ready");

    // The drilled chain — fetch from the bucket, decrypt, parse, preview — is the
    // one a recovery walks, and it is proved against the object that is actually
    // stored.
    const verified = await verifyCloudCopy(bizA.id, item.ref);
    expect(verified).toEqual({ ok: true, tables: expect.any(Number) });

    const report = await asTenant(bizA.id, () =>
      drill.runDrill({
        businessId: bizA.id,
        deployment: { role: "central", profile: "cloud" },
        requiredSteps: [
          "artifact_selected",
          "artifact_ready",
          "payload_decrypted",
          "archive_parsed",
          "restore_preview",
        ],
      }),
    );
    expect(report.steps.filter((step) => step.status === "failed")).toEqual([]);
    expect(report.ok).toBe(true);
  }, 120_000);
});

describe("the scheduler mirrors in the tick that takes the backup", () => {
  it("uploads a managed Cloud backup even when the legacy tenant flag is off", async () => {
    // `backupConfig()` leaves `cloud.enabled` false on purpose: that switch is the
    // tenant-era one the owner decision removed from the tenant's reach. §1 says a
    // Cloud business is stored on managed storage *only*, so the mirror must
    // follow the platform's policy, not that flag — otherwise the only copy sits
    // on the app server for a whole interval, waiting for `maybeCatchUpCloud`.
    await asTenant(bizA.id, () => svc.setBackupConfig(bizA.id, backupConfig()));
    await svc.runTenantSnapshotTick();

    const rows = await seed.query<{ destination: string; state: string }>(
      "SELECT destination, state FROM tenant_backup_artifacts WHERE business_id = $1",
      [bizA.id],
    );
    expect(rows.rows).toContainEqual({ destination: "cloud", state: "ready" });
    // …and nothing reached the network for the Local business in the same tick.
    const local = await seed.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM tenant_backup_artifacts
        WHERE business_id = $1 AND destination = 'cloud'`,
      [bizB.id],
    );
    expect(local.rows[0].n).toBe("0");
  }, 180_000);
});

describe("corruption: damage that happened after the upload is never restored", () => {
  it("refuses a copy whose stored bytes no longer match the manifest", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("ok");
    await lifecycle.runBackupLifecycleTick(new Date());

    // The managed object is the tenant's only copy now, and it rots.
    damageStoredObject(artifact);

    // The verifier is the gate that catches it, and it names the reason.
    const cloudRef = refs.tenantBackupArtifactRef(bizA.id, "cloud", artifact);
    await expect(verifyCloudCopy(bizA.id, cloudRef)).resolves.toEqual({
      ok: false,
      error: "artifact_checksum_mismatch",
    });

    // …and a drill cannot open it either, so "we can restore you" is not claimed
    // on the strength of a row that says `ready`.
    const report = await asTenant(bizA.id, () =>
      drill.runDrill({ businessId: bizA.id, deployment: { role: "central", profile: "cloud" } }),
    );
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.step === "payload_decrypted")?.status).toBe("failed");
  }, 120_000);
});

describe("bit rot on a copy that was already proved good", () => {
  it("is caught by the drift sweep instead of by the restore", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("ok");
    // A mirror registers `ready` on the upload's own payload hash, so the first
    // tick has nothing to promote — its job here is to reclaim the staged twin.
    const first = await lifecycle.runBackupLifecycleTick(new Date());
    expect(first.verified).toBe(0);
    expect(first.reclaimed).toBeGreaterThanOrEqual(1);

    // The copy is `ready`, the staged local twin is gone (Cloud keeps nothing on
    // the app server), and nothing is queued for verification — this is the state
    // every managed Cloud backup sits in for the rest of its retention.
    const cloudRef = refs.tenantBackupArtifactRef(bizA.id, "cloud", artifact);
    expect((await asTenant(bizA.id, () => artifacts.tenantBackupInventory(bizA.id, {
      profile: "cloud",
      connectivity: "online",
    }))).items.find((item) => item.ref === cloudRef)?.restorable).toBe(true);

    // A week passes without the object being read.
    await seed.query(
      `UPDATE tenant_backup_artifacts
          SET verified_at = now() - interval '30 days'
        WHERE business_id = $1 AND destination = 'cloud'`,
      [bizA.id],
    );
    let swept = await lifecycle.runBackupLifecycleTick(new Date());
    expect(swept.driftDetected).toBe(0);
    expect(swept.reverified).toBeGreaterThanOrEqual(1);

    // Now the bucket rots, and the next sweep is what notices — before any
    // restore asks for the bytes.
    await seed.query(
      `UPDATE tenant_backup_artifacts
          SET verified_at = now() - interval '30 days'
        WHERE business_id = $1 AND destination = 'cloud'`,
      [bizA.id],
    );
    damageStoredObject(artifact);
    swept = await lifecycle.runBackupLifecycleTick(new Date());
    expect(swept.driftDetected).toBe(1);
    expect(swept.reverified).toBe(0);

    // The row stopped claiming to be restorable, and says why, so the console and
    // the Owner's inventory agree that this copy is gone rather than discovering
    // it at restore time.
    const row = await seed.query<{ state: string; failure_code: string | null }>(
      "SELECT state, failure_code FROM tenant_backup_artifacts WHERE business_id = $1 AND destination = 'cloud'",
      [bizA.id],
    );
    expect(row.rows[0]).toEqual({ state: "failed", failure_code: "artifact_checksum_mismatch" });
    const report = await asTenant(bizA.id, () =>
      drill.runDrill({
        businessId: bizA.id,
        deployment: { role: "central", profile: "cloud" },
        requiredSteps: [
          "artifact_selected",
          "artifact_ready",
          "payload_decrypted",
          "archive_parsed",
          "restore_preview",
        ],
      }),
    );
    expect(report.ok).toBe(false);
  }, 120_000);
});

describe("an interrupted upload is not a backup", () => {
  it("refuses a short object instead of decrypting whatever arrived", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    s3Mode = "truncate";
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    // The provider answered 200 for a body it stored only partly. The runtime
    // cannot know that from the response; the verifier is what settles it.
    expect(upload.status).toBe("ok");
    s3Mode = "ok";
    await lifecycle.runBackupLifecycleTick(new Date());

    const cloudRef = refs.tenantBackupArtifactRef(bizA.id, "cloud", artifact);
    const verified = await verifyCloudCopy(bizA.id, cloudRef);
    expect(verified.ok).toBe(false);
    expect(verified.error).toBe("artifact_checksum_mismatch");
  }, 120_000);
});

describe("S3 outage: the failure is recorded, the artifact is queued, and reconnect drains it", () => {
  it("recovers a queued upload without a second backup being taken", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    s3Mode = "down";
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("failed");
    expect([...objects.keys()].some((key) => key.endsWith(artifact))).toBe(false);

    // What the scheduler does with a failed upload: it queues. It does not loop,
    // and it does not pretend the copy exists.
    const heartbeat = await asTenant(bizA.id, () => hybrid.readHeartbeat(bizA.id));
    await asTenant(bizA.id, () =>
      hybrid.enqueueUpload({
        businessId: bizA.id,
        artifactName: artifact,
        generation: heartbeat?.siteGeneration ?? 0,
      }),
    );
    const queued = await asTenant(bizA.id, () => hybrid.pendingUploads(bizA.id));
    expect(queued.map((entry) => entry.artifactName)).toContain(artifact);

    // Back online: the operator's catch-up drains the same queue, with no new
    // backup taken to cover the gap.
    s3Mode = "ok";
    const drained = await asTenant(bizA.id, () => ops.catchUpBusinessUploads(bizA.id));
    expect(drained.uploaded).toBe(1);
    expect(drained.failed).toBe(0);
    expect(drained.remaining).toBe(0);

    const runs = await seed.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM backup_runs WHERE business_id = $1 AND kind = 'local' AND status = 'success'",
      [bizA.id],
    );
    expect(runs.rows[0].count).toBe("1");

    // What the scheduler asks a nightly drill to prove: everything it can hold,
    // which excludes the tenant-held recovery passphrase.
    const report = await asTenant(bizA.id, () =>
      drill.runDrill({
        businessId: bizA.id,
        deployment: { role: "central", profile: "cloud" },
        requiredSteps: [
          "artifact_selected",
          "artifact_ready",
          "payload_decrypted",
          "archive_parsed",
          "restore_preview",
        ],
      }),
    );
    expect(report.ok).toBe(true);
  }, 120_000);
});

describe("Full Offline: nothing reaches the network and nothing is billed", () => {
  it("makes no S3 request, emits no storage event, and still has a restorable backup", async () => {
    const before = s3Requests;
    const artifact = await takeLocalBackup(bizB.id);
    const upload = await asTenant(bizB.id, () => svc.runCloudUpload(bizB.id, artifact, "manual"));
    // `disabled`, not `failed`: a Local profile has no cloud destination by
    // definition, so there is nothing to retry and nothing to alert on.
    expect(upload.status).toBe("disabled");
    expect(s3Requests).toBe(before);

    const window = sampledWindow();
    await asTenant(bizB.id, () => artifacts.recordStorageSample(bizB.id, window.from));
    await asTenant(bizB.id, () => artifacts.recordStorageSample(bizB.id, window.to));
    const settled = await asTenant(bizB.id, () => billing.settleBusinessStorage(bizB.id, window));
    expect(settled.status).toBe("skipped");
    expect(settled.byteDays).toBe(0);

    const { rows } = await seed.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM billing_usage_events WHERE business_id = $1",
      [bizB.id],
    );
    expect(rows[0].count).toBe("0");

    // The local copy is a real, restorable backup all the same.
    const report = await asTenant(bizB.id, () =>
      drill.runDrill({
        businessId: bizB.id,
        deployment: { role: "central", profile: "local" },
        requiredSteps: ["artifact_selected", "artifact_ready", "payload_decrypted", "archive_parsed"],
      }),
    );
    expect(
      report.steps.filter((step) => step.status === "failed").map((step) => [step.step, step.detail]),
    ).toEqual([["restore_preview", "artifact_unavailable_offline"]]);
    expect(report.ok).toBe(true);
  }, 120_000);
});

describe("Hybrid: online, offline, and the reconnect that reconciles them", () => {
  it("keeps the local copy while offline and mirrors it when the network returns", async () => {
    const artifact = await takeLocalBackup(bizC.id);

    s3Mode = "down";
    const offline = await asTenant(bizC.id, () => svc.runCloudUpload(bizC.id, artifact, "manual"));
    expect(offline.status).toBe("failed");
    // The local half is untouched by the cloud failure: that is what an optional
    // mirror means on a device whose connection comes and goes.
    const localRows = await asTenant(bizC.id, () => artifacts.listStoredArtifactRows(bizC.id));
    expect(localRows.some((row) => row.destination === "local" && row.state === "ready")).toBe(true);

    s3Mode = "ok";
    const retried = await asTenant(bizC.id, () => svc.runCloudUpload(bizC.id, artifact, "manual"));
    expect(retried.status).toBe("ok");
    await lifecycle.runBackupLifecycleTick(new Date());

    // Hybrid keeps both halves — the reclaim pass is Cloud-only.
    const rows = await asTenant(bizC.id, () => artifacts.listStoredArtifactRows(bizC.id));
    const destinations = new Set(rows.map((row) => row.destination));
    expect(destinations.has("local")).toBe(true);
    expect(destinations.has("cloud")).toBe(true);
    // Two rows, one backup: the artifact id is derived from the artifact name.
    expect(new Set(rows.map((row) => row.artifactId)).size).toBe(1);

    const inventory = await asTenant(bizC.id, () =>
      artifacts.tenantBackupInventory(bizC.id, { profile: "hybrid", connectivity: "online" }),
    );
    expect(inventory.items.length).toBe(1);
    expect(inventory.items[0].destinations.map((destination) => destination.destination).sort()).toEqual([
      "cloud",
      "local",
    ]);
  }, 120_000);
});

describe("lost custody: a backup the platform cannot open is reported, not assumed", () => {
  it("fails the drill at decryption and shows no active key generation", async () => {
    const artifact = await takeLocalBackup(bizA.id);
    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("ok");
    await lifecycle.runBackupLifecycleTick(new Date());

    // Premise: the platform's only copy is the managed one, sealed under the
    // generation its manifest names.
    const rows = await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id));
    expect(rows.length).toBe(1);
    expect(rows[0].keyVersion).toBeGreaterThan(0);
    const sealedVersion = rows[0].keyVersion!;

    // The generation is lost (a restore of an old platform database, a deleted
    // custody record). The bytes still exist; the key does not.
    await seed.query("DELETE FROM backup_key_versions WHERE subject_business_id = $1 AND version = $2", [
      bizA.id,
      sealedVersion,
    ]);

    const report = await asTenant(bizA.id, () =>
      drill.runDrill({ businessId: bizA.id, deployment: { role: "central", profile: "cloud" } }),
    );
    expect(report.ok).toBe(false);
    expect(report.steps.find((step) => step.step === "payload_decrypted")?.status).toBe("failed");

    // And the custody readout names the hole rather than claiming coverage.
    const summary = await asTenant(bizA.id, () =>
      artifacts.businessCustodySummary(bizA.id, { legacyArtifacts: false }),
    );
    expect(summary.scheme).toBe("unconfigured");
    expect(summary.activeVersion).toBeNull();
  }, 120_000);
});

describe("concurrency: two attempts are one backup and one charge", () => {
  it("serialises simultaneous backups and settles a repeated window once", async () => {
    await asTenant(bizA.id, () => svc.setBackupConfig(bizA.id, backupConfig()));
    const [first, second] = await Promise.all([
      asTenant(bizA.id, () => svc.runLocalBackup(bizA.id, "manual")),
      asTenant(bizA.id, () => svc.runLocalBackup(bizA.id, "manual")),
    ]);
    expect([first.status, second.status].sort()).toEqual(["busy", "ok"]);
    const winner = first.status === "ok" ? first : second;
    if (winner.status !== "ok") throw new Error("no backup succeeded");
    const artifact = winner.artifact;

    expect((await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id))).length).toBe(1);

    const upload = await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, artifact, "manual"));
    expect(upload.status).toBe("ok");
    await lifecycle.runBackupLifecycleTick(new Date());
    const cloudRows = (await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id))).filter(
      (row) => row.destination === "cloud",
    );
    // One artifact per destination is a database constraint, not a convention.
    expect(cloudRows.length).toBe(1);
    expect(cloudRows[0].state).toBe("ready");

    const window = sampledWindow();
    await asTenant(bizA.id, () => artifacts.recordStorageSample(bizA.id, window.from));
    await asTenant(bizA.id, () => artifacts.recordStorageSample(bizA.id, window.to));
    const firstSettlement = await asTenant(bizA.id, () => billing.settleBusinessStorage(bizA.id, window));
    const secondSettlement = await asTenant(bizA.id, () => billing.settleBusinessStorage(bizA.id, window));
    expect(firstSettlement.status).toBe("accepted");
    expect(firstSettlement.byteDays).toBeGreaterThan(0);
    // The window is the idempotency identity: a retry is a duplicate, not a charge.
    expect(secondSettlement.status).toBe("duplicate");

    const { rows: events } = await seed.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM billing_usage_events WHERE business_id = $1",
      [bizA.id],
    );
    expect(events[0].count).toBe("1");
  }, 120_000);
});

describe("retention never crosses the protected floor", () => {
  it("keeps the last protected backup even when its retention has passed", async () => {
    await takeLocalBackup(bizA.id);
    const before = await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id));
    // Premise: there is exactly one good backup, and it is the last one.
    expect(before.some((row) => row.state === "ready")).toBe(true);

    // Every copy is now past its deadline — exactly when a naive sweep would
    // leave the business with nothing.
    await seed.query(
      "UPDATE tenant_backup_artifacts SET retention_until = now() - interval '1 day' WHERE business_id = $1",
      [bizA.id],
    );
    const swept = await lifecycle.runBackupLifecycleTick(new Date());
    expect(swept.expired).toBe(0);
    expect(swept.protectedSkipped).toBeGreaterThanOrEqual(1);

    const after = await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id));
    expect(after.length).toBe(before.length);
  }, 120_000);
});

describe("multi-tenant: one business's drill never touches another's bytes", () => {
  it("drills each business against its own artifact and nothing else", async () => {
    const cloudArtifact = await takeLocalBackup(bizA.id);
    await asTenant(bizA.id, () => svc.runCloudUpload(bizA.id, cloudArtifact, "manual"));
    const localArtifact = await takeLocalBackup(bizB.id);
    await lifecycle.runBackupLifecycleTick(new Date());

    const cloudReport = await asTenant(bizA.id, () =>
      drill.runDrill({
        businessId: bizA.id,
        deployment: { role: "central", profile: "cloud" },
        requiredSteps: [
          "artifact_selected",
          "artifact_ready",
          "payload_decrypted",
          "archive_parsed",
          "restore_preview",
        ],
      }),
    );
    const localReport = await asTenant(bizB.id, () =>
      drill.runDrill({
        businessId: bizB.id,
        deployment: { role: "central", profile: "local" },
        requiredSteps: ["artifact_selected", "artifact_ready", "payload_decrypted", "archive_parsed"],
      }),
    );
    expect(cloudReport.ok).toBe(true);
    expect(localReport.ok).toBe(true);
    // Each drill picked its own artifact — the refs differ, so a drill cannot
    // have borrowed the other tenant's copy.
    expect(cloudReport.ref).not.toBe(localReport.ref);

    // The other tenant's ref is not resolvable inside this business's scope.
    const foreign = await asTenant(bizB.id, () => artifacts.resolveOwnedArtifact(bizB.id, cloudReport.ref!));
    expect(foreign).toBeNull();

    // …and A cannot see B's local artifact either.
    const aRows = await asTenant(bizA.id, () => artifacts.listStoredArtifactRows(bizA.id));
    expect(aRows.every((row) => row.destination === "cloud")).toBe(true);
    const bRows = await asTenant(bizB.id, () => artifacts.listStoredArtifactRows(bizB.id));
    expect(bRows.every((row) => row.storageRef === localArtifact)).toBe(true);
  }, 120_000);
});
