/**
 * The Persian operator vocabulary shared by the console pages.
 *
 * These pin the one thing that made the production report misleading: every
 * surface must derive its headline from the same canonical classification, so a
 * gated AI secret cleanup can never be summarised as an ordinary pending
 * migration, and an unreadable inventory can never be summarised as healthy.
 */
import { describe, expect, it } from "vitest";
import {
  AI_SECRET_CUTOVER_COMMANDS,
  AI_SECRET_CUTOVER_MIGRATE_COMMAND,
  MIGRATE_COMMAND,
  migrationHeadline,
  migrationReasonLabel,
  migrationStateLabel,
} from "./migration-status-labels";
import { buildMigrationStatus, type MigrationStatusInput } from "./migration-status-service";
import { AI_GATEWAY_SECRET_CUTOVER_MIGRATION } from "./ai-gateway-secret-cutover-policy";

const CUTOVER = AI_GATEWAY_SECRET_CUTOVER_MIGRATION;

function headline(overrides: Partial<MigrationStatusInput> = {}) {
  return migrationHeadline(
    buildMigrationStatus({
      files: [],
      applied: new Map(),
      cutoverDatabase: {
        secretsStored: false,
        legacyColumnsPresent: false,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 0,
      },
      ...overrides,
    }),
  );
}

describe("migration headline", () => {
  it("calls an up-to-date deployment healthy", () => {
    expect(headline({ files: ["0001_a.sql"], applied: new Map([["0001_a.sql", "2026-01-01T00:00:00.000Z"]]) })).toEqual({
      tone: "ok",
      label: "هم‌خوان",
      summary: "همهٔ مهاجرت‌ها اعمال شده‌اند",
    });
  });

  it("calls an ordinary pending migration a real problem", () => {
    const h = headline({
      files: ["0001_a.sql", "0002_b.sql"],
      applied: new Map([["0001_a.sql", "2026-01-01T00:00:00.000Z"]]),
    });
    expect(h.tone).toBe("bad");
    expect(h.label).toBe("عقب‌مانده");
    // Persian display digits, per the console's convention.
    expect(h.summary).toBe("۱ مهاجرت اجرا نشده است");
  });

  it("calls the gated cutover a hold, not a schema mismatch", () => {
    const h = headline({
      files: [CUTOVER],
      cutoverDatabase: {
        secretsStored: true,
        legacyColumnsPresent: true,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 2,
      },
    });
    expect(h.tone).toBe("warn");
    expect(h.label).toBe("در انتظار تأیید");
    expect(h.summary).toContain("پاک‌سازی کلیدهای قدیمی هوش مصنوعی");
    expect(h.summary).not.toContain("مهاجرت اجرا نشده");
  });

  it("calls an unreadable inventory unknown rather than healthy", () => {
    const h = headline({ files: null, applied: null });
    expect(h.tone).toBe("unknown");
    expect(h.label).toBe("نامشخص");
  });

  it("calls conflicting settings a hard error", () => {
    const h = headline({
      files: [CUTOVER],
      flags: { defer: true, verified: true, conflict: true },
      cutoverDatabase: {
        secretsStored: true,
        legacyColumnsPresent: true,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 1,
      },
    });
    expect(h.tone).toBe("bad");
    expect(h.label).toBe("تناقض تنظیمات");
  });

  it("calls a blocked deferral a hard error and names the blocker", () => {
    const h = headline({
      files: [CUTOVER, "0210_reads_master_key.sql"],
      blockedBy: "0210_reads_master_key.sql",
      cutoverDatabase: {
        secretsStored: true,
        legacyColumnsPresent: true,
        rowsMissingCiphertext: 0,
        legacyPlaintextRows: 1,
      },
    });
    expect(h.tone).toBe("bad");
    expect(h.summary).toContain("0210_reads_master_key.sql");
  });
});

describe("operator vocabulary", () => {
  it("labels every state and reason in Persian, never with a raw code", () => {
    expect(migrationStateLabel({ filename: "a.sql", state: "applied", reasonCode: "applied", detail: null, appliedAt: null })).toBe("اعمال‌شده");
    expect(migrationStateLabel({ filename: "a.sql", state: "pending", reasonCode: "ordinary_pending", detail: null, appliedAt: null })).toBe("اجرا نشده");
    expect(migrationStateLabel({ filename: "a.sql", state: "gated", reasonCode: "x", detail: null, appliedAt: null })).toBe("در انتظار تأیید اپراتور");
    for (const code of [
      "applied",
      "ordinary_pending",
      "ai_gateway_secret_cutover_awaiting_verification",
      "ai_gateway_secret_cutover_deferred_by_flag",
      "ai_gateway_secret_cutover_flags_conflict",
      "ai_gateway_secret_cutover_state_unknown",
      "migration_inventory_unreadable",
      "applied_migrations_unreadable",
      "ai_gateway_secret_cutover_blocks_later_migration",
      "up_to_date",
    ]) {
      expect(migrationReasonLabel(code), code).not.toBe(code);
      expect(migrationReasonLabel(code).length).toBeGreaterThan(4);
    }
  });

  it("documents the controlled completion sequence in order", () => {
    expect(AI_SECRET_CUTOVER_COMMANDS).toEqual([
      "npm run db:encrypt-ai-secrets -- --dry-run",
      "npm run db:encrypt-ai-secrets",
      "npm run db:encrypt-ai-secrets -- --verify-only",
    ]);
    // The one-time migration only after the prerequisites, with the defer
    // explicitly turned off and the confirmation explicitly on.
    expect(AI_SECRET_CUTOVER_MIGRATE_COMMAND).toBe(
      "AI_GATEWAY_SECRET_CUTOVER_DEFER=false AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate",
    );
    expect(MIGRATE_COMMAND).toBe("npm run db:migrate");
  });
});
