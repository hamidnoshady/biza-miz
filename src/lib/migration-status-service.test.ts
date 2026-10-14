/**
 * The canonical migration-status classifier, unit-tested against every state an
 * operator can meet — including the ones that are awkward to reproduce against
 * a live database (an unreadable inventory, conflicting switches, a later
 * migration that blocks the deferral).
 *
 * The production bug these lock down: `/platform/system` reported the
 * deliberately deferred `0209_ai_gateway_secret_cutover.sql` with the generic
 * "running code is ahead of the database — run npm run db:migrate" warning, and
 * an unreadable migrations directory was reported as zero pending.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMigrationStatus,
  findBlockingDependentMigration,
  readMigrationInventory,
  type CutoverDatabaseState,
  type MigrationStatusInput,
} from "./migration-status-service";
import {
  AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV,
  AI_GATEWAY_SECRET_CUTOVER_MIGRATION,
  AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV,
  cutoverReasonCode,
  migrationDependsOnLegacySecretColumn,
  mustDeferSecretCutover,
  readCutoverFlags,
} from "./ai-gateway-secret-cutover-policy";

const CUTOVER = AI_GATEWAY_SECRET_CUTOVER_MIGRATION;

/** A database with no stored credential and no legacy plaintext left. */
const CLEAN_DB: CutoverDatabaseState = {
  secretsStored: false,
  legacyColumnsPresent: false,
  rowsMissingCiphertext: 0,
  legacyPlaintextRows: 0,
};

/** A database still holding ciphertext-backed credentials and legacy plaintext. */
const STORED_DB: CutoverDatabaseState = {
  secretsStored: true,
  legacyColumnsPresent: true,
  rowsMissingCiphertext: 0,
  legacyPlaintextRows: 3,
};

/** A database whose plaintext has not been backfilled yet. */
const UNBACKFILLED_DB: CutoverDatabaseState = {
  secretsStored: true,
  legacyColumnsPresent: true,
  rowsMissingCiphertext: 2,
  legacyPlaintextRows: 2,
};

const NOW = new Date("2026-10-08T10:00:00.000Z");

function status(overrides: Partial<MigrationStatusInput> = {}) {
  return buildMigrationStatus({
    files: [],
    applied: new Map(),
    cutoverDatabase: CLEAN_DB,
    now: NOW,
    ...overrides,
  });
}

describe("migration status classification", () => {
  it("reports nothing pending on an up-to-date deployment", () => {
    const s = status({
      files: ["0183_ai_gateway_hardening.sql", "0210_later.sql"],
      applied: new Map([
        ["0183_ai_gateway_hardening.sql", "2026-09-01T00:00:00.000Z"],
        ["0210_later.sql", "2026-09-02T00:00:00.000Z"],
      ]),
    });
    expect(s.available).toBe(true);
    expect(s.reasonCode).toBe("up_to_date");
    expect(s.pendingTotal).toBe(0);
    expect(s.ordinaryPending).toEqual([]);
    expect(s.gated).toEqual([]);
    expect(s.appliedCount).toBe(2);
    expect(s.lastAppliedAt).toBe("2026-09-02T00:00:00.000Z");
    expect(s.applied.map((m) => m.filename)).toEqual(["0210_later.sql", "0183_ai_gateway_hardening.sql"]);
  });

  it("reports ordinary pending migrations with a filename and reason", () => {
    const s = status({
      files: ["0001_a.sql", "0002_b.sql", "0003_c.sql"],
      applied: new Map([["0001_a.sql", "2026-09-01T00:00:00.000Z"]]),
    });
    expect(s.pendingTotal).toBe(2);
    expect(s.ordinaryPending.map((m) => m.filename)).toEqual(["0002_b.sql", "0003_c.sql"]);
    expect(s.ordinaryPending.every((m) => m.state === "pending")).toBe(true);
    expect(s.ordinaryPending[0].reasonCode).toBe("ordinary_pending");
    expect(s.gated).toEqual([]);
    expect(s.reasonCode).toBe("ordinary_pending");
    // An unapplied migration has never been successfully applied.
    expect(s.ordinaryPending.every((m) => m.appliedAt === null)).toBe(true);
  });

  it("reports the gated cutover as gated, not as an ordinary pending migration", () => {
    const s = status({
      files: ["0208_x.sql", CUTOVER, "0210_later.sql"],
      applied: new Map([["0208_x.sql", "2026-09-01T00:00:00.000Z"]]),
      cutoverDatabase: STORED_DB,
    });
    expect(s.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.gated[0].state).toBe("gated");
    expect(s.gated[0].reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
    expect(s.ordinaryPending.map((m) => m.filename)).toEqual(["0210_later.sql"]);
    // Never hidden: the gated migration still counts as pending.
    expect(s.pendingTotal).toBe(2);
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
    expect(s.cutover.gated).toBe(true);
    expect(s.cutover.applied).toBe(false);
    expect(s.cutover.legacyPlaintextRows).toBe(3);
  });

  it("shows both categories separately when ordinary and gated migrations are mixed", () => {
    const s = status({
      files: ["0208_x.sql", CUTOVER, "0210_a.sql", "0211_b.sql"],
      applied: new Map([["0208_x.sql", "2026-09-01T00:00:00.000Z"]]),
      cutoverDatabase: STORED_DB,
    });
    expect(s.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.ordinaryPending.map((m) => m.filename)).toEqual(["0210_a.sql", "0211_b.sql"]);
    expect(s.pendingTotal).toBe(3);
    // The headline names the gate first: it is the one that needs an operator.
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
  });

  it("reports a completed cutover as applied with no pending work", () => {
    const s = status({
      files: ["0183_ai_gateway_hardening.sql", CUTOVER, "0210_later.sql"],
      applied: new Map([
        ["0183_ai_gateway_hardening.sql", "2026-09-01T00:00:00.000Z"],
        [CUTOVER, "2026-09-05T00:00:00.000Z"],
        ["0210_later.sql", "2026-09-06T00:00:00.000Z"],
      ]),
      cutoverDatabase: CLEAN_DB,
    });
    expect(s.cutover.applied).toBe(true);
    expect(s.cutover.gated).toBe(false);
    expect(s.cutover.reasonCode).toBe("ai_gateway_secret_cutover_applied");
    expect(s.gated).toEqual([]);
    expect(s.pendingTotal).toBe(0);
    expect(s.reasonCode).toBe("up_to_date");
  });

  it("treats 0209 as an ordinary migration once no credential is stored", () => {
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: CLEAN_DB,
    });
    expect(s.gated).toEqual([]);
    expect(s.ordinaryPending.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.ordinaryPending[0].reasonCode).toBe("ai_gateway_secret_cutover_applicable");
    expect(s.cutover.gated).toBe(false);
  });

  it("reports an unreadable migration inventory as unknown, never as zero pending", () => {
    const s = status({ files: null, applied: new Map() });
    expect(s.available).toBe(false);
    expect(s.reasonCode).toBe("migration_inventory_unreadable");
    expect(s.pendingTotal).toBeNull();
    expect(s.ordinaryPending).toEqual([]);
    expect(s.gated).toEqual([]);
  });

  it("reports an unreadable schema_migrations as unknown, never as zero pending", () => {
    const s = status({ files: ["0001_a.sql", CUTOVER], applied: null });
    expect(s.available).toBe(false);
    expect(s.reasonCode).toBe("applied_migrations_unreadable");
    expect(s.pendingTotal).toBeNull();
  });

  it("reports an undeterminable credential state as gated rather than assuming it is clear", () => {
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: {
        secretsStored: null,
        legacyColumnsPresent: null,
        rowsMissingCiphertext: null,
        legacyPlaintextRows: null,
      },
    });
    expect(s.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.gated[0].reasonCode).toBe("ai_gateway_secret_cutover_state_unknown");
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_state_unknown");
  });

  it("reports a plaintext credential that has not been backfilled as gated", () => {
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: UNBACKFILLED_DB,
    });
    expect(s.gated).toHaveLength(1);
    expect(s.cutover.rowsMissingCiphertext).toBe(2);
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_awaiting_verification");
  });
});

describe("conflicting defer/verification settings", () => {
  const both = { defer: true, verified: true, conflict: true };

  it("reports the conflict and keeps 0209 gated", () => {
    const s = status({
      files: [CUTOVER, "0210_later.sql"],
      applied: new Map(),
      cutoverDatabase: STORED_DB,
      flags: both,
    });
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_flags_conflict");
    expect(s.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.gated[0].reasonCode).toBe("ai_gateway_secret_cutover_flags_conflict");
    expect(s.cutover.flagsConflict).toBe(true);
    expect(s.cutover.deferFlag).toBe(true);
    expect(s.cutover.verifiedFlag).toBe(true);
  });

  it("reports the defer flag alone as the reason", () => {
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: CLEAN_DB,
      flags: { defer: true, verified: false, conflict: false },
    });
    // Even with no stored credential, an explicit defer withholds the migration.
    expect(s.gated.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.gated[0].reasonCode).toBe("ai_gateway_secret_cutover_deferred_by_flag");
    expect(s.pendingTotal).toBe(1);
  });

  it("does not read the verified flag as proof that the cutover happened", () => {
    // VERIFIED=true only authorises the run; the migration is still pending
    // until it is recorded in schema_migrations.
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: STORED_DB,
      flags: { defer: false, verified: true, conflict: false },
    });
    expect(s.gated).toEqual([]);
    expect(s.ordinaryPending.map((m) => m.filename)).toEqual([CUTOVER]);
    expect(s.cutover.applied).toBe(false);
  });
});

describe("a later migration that blocks the deferral", () => {
  it("surfaces the blocking migration by name", () => {
    const s = status({
      files: ["0208_x.sql", CUTOVER, "0210_reads_master_key.sql"],
      applied: new Map([["0208_x.sql", "2026-09-01T00:00:00.000Z"]]),
      cutoverDatabase: STORED_DB,
      blockedBy: "0210_reads_master_key.sql",
    });
    expect(s.reasonCode).toBe("ai_gateway_secret_cutover_blocks_later_migration");
    expect(s.cutover.blockedBy).toBe("0210_reads_master_key.sql");
  });
});

describe("secret redaction", () => {
  it("carries counts and filenames only — never a credential", () => {
    const s = status({
      files: [CUTOVER],
      applied: new Map(),
      cutoverDatabase: {
        secretsStored: true,
        legacyColumnsPresent: true,
        rowsMissingCiphertext: 1,
        legacyPlaintextRows: 1,
      },
    });
    const serialized = JSON.stringify(s);
    // No credential-shaped value of any kind.
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(serialized).not.toMatch(/enc:v\d+:/);
    expect(serialized).not.toMatch(/"\w*(?:secret|password|token|api_?key)\w*"\s*:\s*"(?!")/);
    // The gated entry's detail is prose about the situation, not a value.
    expect(s.gated[0].detail).toMatch(/plaintext AI credentials are still stored/i);
    // And the cutover block's shape is exactly the redacted allowlist.
    expect(Object.keys(s.cutover).sort()).toEqual([
      "applied",
      "blockedBy",
      "deferFlag",
      "flagsConflict",
      "gated",
      "legacyColumnsPresent",
      "legacyPlaintextRows",
      "migration",
      "reasonCode",
      "rowsMissingCiphertext",
      "verifiedFlag",
    ]);
  });
});

describe("migration inventory on disk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-inventory-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads and sorts NNNN_name.sql files", () => {
    writeFileSync(join(dir, "0002_b.sql"), "SELECT 1;");
    writeFileSync(join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(join(dir, "notes.md"), "not a migration");
    writeFileSync(join(dir, "abc_x.sql"), "not a migration");
    expect(readMigrationInventory(dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("returns null — not an empty list — when the directory cannot be read", () => {
    expect(readMigrationInventory(join(dir, "missing"))).toBeNull();
  });

  it("finds a later unapplied migration that still names a legacy column", () => {
    writeFileSync(join(dir, CUTOVER), "-- cutover");
    writeFileSync(join(dir, "0210_later.sql"), "CREATE TABLE t (id int);");
    writeFileSync(join(dir, "0211_reads_master_key.sql"), "SELECT master_key FROM platform_ai_gateway;");
    const files = ["0208_x.sql", CUTOVER, "0210_later.sql", "0211_reads_master_key.sql"];
    expect(findBlockingDependentMigration(dir, files, new Set(["0208_x.sql"]))).toBe(
      "0211_reads_master_key.sql",
    );
  });

  it("ignores an already-applied dependent and one that only names the ciphertext twin", () => {
    writeFileSync(join(dir, CUTOVER), "-- cutover");
    writeFileSync(join(dir, "0210_reads_master_key.sql"), "SELECT master_key FROM platform_ai_gateway;");
    writeFileSync(
      join(dir, "0211_reads_ciphertext.sql"),
      "SELECT master_key_ciphertext FROM platform_ai_gateway;",
    );
    const files = [CUTOVER, "0210_reads_master_key.sql", "0211_reads_ciphertext.sql"];
    expect(
      findBlockingDependentMigration(dir, files, new Set(["0210_reads_master_key.sql"])),
    ).toBeNull();
  });

  it("returns null when the cutover migration is not in the inventory at all", () => {
    writeFileSync(join(dir, "0210_reads_master_key.sql"), "SELECT master_key FROM platform_ai_gateway;");
    expect(findBlockingDependentMigration(dir, ["0210_reads_master_key.sql"], new Set())).toBeNull();
  });
});

describe("cutover policy", () => {
  const envNames = [AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV, AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV];
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    delete process.env[AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV];
    delete process.env[AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV];
  });
  afterEach(() => {
    for (const name of envNames) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("reads only the exact string true as set", () => {
    expect(readCutoverFlags({})).toEqual({ defer: false, verified: false, conflict: false });
    expect(readCutoverFlags({ [AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV]: "1" }).defer).toBe(false);
    expect(readCutoverFlags({ [AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV]: "TRUE" }).verified).toBe(false);
    expect(readCutoverFlags({ [AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV]: "true" }).verified).toBe(true);
  });

  it("flags the conflicting pair", () => {
    expect(
      readCutoverFlags({
        [AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV]: "true",
        [AI_GATEWAY_SECRET_CUTOVER_VERIFIED_ENV]: "true",
      }),
    ).toEqual({ defer: true, verified: true, conflict: true });
  });

  it("reads the flags from the ambient environment", () => {
    process.env[AI_GATEWAY_SECRET_CUTOVER_DEFER_ENV] = "true";
    expect(readCutoverFlags().defer).toBe(true);
  });

  it("matches the runner's defer rule exactly", () => {
    expect(mustDeferSecretCutover({ defer: false, verified: false, secretsStored: true })).toBe(true);
    expect(mustDeferSecretCutover({ defer: false, verified: false, secretsStored: false })).toBe(false);
    expect(mustDeferSecretCutover({ defer: true, verified: false, secretsStored: false })).toBe(true);
    expect(mustDeferSecretCutover({ defer: false, verified: true, secretsStored: true })).toBe(false);
  });

  it("names a reason code for every combination", () => {
    expect(cutoverReasonCode({ defer: true, verified: true, secretsStored: true })).toBe(
      "ai_gateway_secret_cutover_flags_conflict",
    );
    expect(cutoverReasonCode({ defer: true, verified: false, secretsStored: false })).toBe(
      "ai_gateway_secret_cutover_deferred_by_flag",
    );
    expect(cutoverReasonCode({ defer: false, verified: true, secretsStored: true })).toBe(
      "ai_gateway_secret_cutover_applicable",
    );
    expect(cutoverReasonCode({ defer: false, verified: false, secretsStored: null })).toBe(
      "ai_gateway_secret_cutover_state_unknown",
    );
    expect(cutoverReasonCode({ defer: false, verified: false, secretsStored: true })).toBe(
      "ai_gateway_secret_cutover_awaiting_verification",
    );
    expect(cutoverReasonCode({ defer: false, verified: false, secretsStored: false })).toBe(
      "ai_gateway_secret_cutover_applicable",
    );
  });

  it("recognises a legacy column reference without matching the ciphertext twin", () => {
    expect(migrationDependsOnLegacySecretColumn("SELECT master_key FROM platform_ai_gateway;")).toBe(true);
    expect(migrationDependsOnLegacySecretColumn("SELECT virtual_key FROM ai_business_gateway;")).toBe(true);
    expect(migrationDependsOnLegacySecretColumn("SELECT master_key_ciphertext FROM platform_ai_gateway;")).toBe(false);
    expect(migrationDependsOnLegacySecretColumn("SELECT virtual_key_ciphertext FROM ai_business_gateway;")).toBe(false);
    expect(migrationDependsOnLegacySecretColumn("UPDATE platform_ai_gateway SET virtual_keys_enabled = true;")).toBe(false);
  });
});
