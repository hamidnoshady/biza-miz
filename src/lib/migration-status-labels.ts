/**
 * Persian operator vocabulary for the migration status, shared by the console
 * pages that render it.
 *
 * The status itself is computed server-side by
 * `src/lib/migration-status-service.ts` and travels as stable reason codes; this
 * module is the single place those codes become the words an operator reads, so
 * `/platform` and `/platform/system` never describe the same state in two
 * different ways.
 *
 * Deliberately dependency-free: it is imported by `"use client"` components, so
 * it may not reach `src/lib/db.ts` or a `node:` builtin
 * (`src/lib/client-bundle-boundary.test.ts`).
 */
import { toPersianDigits } from "./digits";
import type { MigrationEntry, MigrationStatus } from "./migration-status-service";

/** The three states a migration can be in on this deployment. */
export const MIGRATION_STATE_LABELS: Record<MigrationEntry["state"], string> = {
  applied: "اعمال‌شده",
  pending: "اجرا نشده",
  gated: "در انتظار تأیید اپراتور",
};

/** Stable reason code → Persian explanation of *why* the migration is in that state. */
export const MIGRATION_REASON_LABELS: Record<string, string> = {
  applied: "در schema_migrations ثبت شده است.",
  ordinary_pending: "مهاجرت معمولی؛ با اجرای معمول مهاجرت‌ها اعمال می‌شود.",
  ai_gateway_secret_cutover_applicable:
    "هیچ کلیدی ذخیره نشده است، بنابراین این مهاجرت بدون تأیید اضافی اعمال می‌شود.",
  ai_gateway_secret_cutover_awaiting_verification:
    "کلید متنی قدیمی هنوز ذخیره است؛ حذف ستون تا تأیید خوانش رمزنگاری‌شده روی همهٔ نمونه‌ها به تعویق می‌افتد.",
  ai_gateway_secret_cutover_deferred_by_flag:
    "با AI_GATEWAY_SECRET_CUTOVER_DEFER=true به‌عمد به تعویق افتاده است.",
  ai_gateway_secret_cutover_flags_conflict:
    "AI_GATEWAY_SECRET_CUTOVER_DEFER و AI_GATEWAY_SECRET_CUTOVER_VERIFIED هر دو روشن هستند؛ اجرای مهاجرت تا رفع یکی از آن‌ها متوقف است.",
  ai_gateway_secret_cutover_state_unknown:
    "نمی‌توان از این پایگاه‌داده فهمید کلیدی ذخیره شده یا نه.",
  migration_inventory_unreadable: "پوشهٔ migrations خوانده نشد.",
  applied_migrations_unreadable: "جدول schema_migrations خوانده نشد.",
  ai_gateway_secret_cutover_blocks_later_migration:
    "یک مهاجرت بعدی به ستون قدیمی وابسته است و اجازهٔ تعویق ایمن نمی‌دهد.",
  up_to_date: "ساختار پایگاه‌داده با کد در حال اجرا هم‌خوان است.",
};

/** The ordinary migration command, shown LTR. */
export const MIGRATE_COMMAND = "npm run db:migrate";

/**
 * The controlled AI gateway secret-cutover sequence, in order. Each entry is
 * one command an operator runs **individually** inside the application
 * container; nothing here is executed by the console, which stays read-only.
 */
export const AI_SECRET_CUTOVER_COMMANDS: readonly string[] = [
  "npm run db:encrypt-ai-secrets -- --dry-run",
  "npm run db:encrypt-ai-secrets",
  "npm run db:encrypt-ai-secrets -- --verify-only",
];

/** The one-time migration command, only after every prerequisite above passes. */
export const AI_SECRET_CUTOVER_MIGRATE_COMMAND =
  "AI_GATEWAY_SECRET_CUTOVER_DEFER=false AI_GATEWAY_SECRET_CUTOVER_VERIFIED=true npm run db:migrate";

/** Persian label for a reason code, falling back to the raw code (never blank). */
export function migrationReasonLabel(reasonCode: string): string {
  return MIGRATION_REASON_LABELS[reasonCode] ?? reasonCode;
}

/** Persian label for a migration entry's state. */
export function migrationStateLabel(entry: MigrationEntry): string {
  return MIGRATION_STATE_LABELS[entry.state];
}

/** The headline state of a whole status, for badges and summaries. */
export type MigrationHeadlineTone = "ok" | "warn" | "bad" | "unknown";

export interface MigrationHeadline {
  tone: MigrationHeadlineTone;
  /** Short Persian label for a badge. */
  label: string;
  /** One-line Persian summary for the copied operator report. */
  summary: string;
}

/**
 * One headline derived from the canonical status. Every surface uses this, so a
 * badge, an alert and a copied summary cannot disagree.
 */
export function migrationHeadline(status: MigrationStatus): MigrationHeadline {
  if (!status.available) {
    return {
      tone: "unknown",
      label: "نامشخص",
      summary: `وضعیت مهاجرت‌ها نامشخص است (${migrationReasonLabel(status.reasonCode ?? "")})`,
    };
  }
  if (status.cutover.flagsConflict) {
    return {
      tone: "bad",
      label: "تناقض تنظیمات",
      summary: "تناقض در تنظیمات مهاجرت کلید هوش مصنوعی؛ اجرای مهاجرت متوقف است",
    };
  }
  if (status.cutover.blockedBy) {
    return {
      tone: "bad",
      label: "مسدود شده",
      summary: `مهاجرت وابسته به ستون قدیدی اجرای مهاجرت کلید هوش مصنوعی را متوقف کرده: ${status.cutover.blockedBy}`,
    };
  }
  if (status.ordinaryPending.length > 0) {
    return {
      tone: "bad",
      label: "عقب‌مانده",
      summary: `${toPersianDigits(status.ordinaryPending.length)} مهاجرت اجرا نشده است`,
    };
  }
  if (status.gated.length > 0) {
    return {
      tone: "warn",
      label: "در انتظار تأیید",
      summary: "پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید خوانش رمزنگاری‌شده است",
    };
  }
  return {
    tone: "ok",
    label: "هم‌خوان",
    summary: "همهٔ مهاجرت‌ها اعمال شده‌اند",
  };
}
