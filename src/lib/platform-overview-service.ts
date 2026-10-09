/**
 * The super-admin overview aggregation (task section 3).
 *
 * `/platform` is now a real operational dashboard, not the business list. This
 * module answers "what needs an operator's attention right now?" in a SINGLE
 * batched round-trip of cheap COUNT/EXISTS queries, rather than each overview
 * card firing its own expensive request. Everything here is read-only and runs
 * in platform (bypass) scope.
 *
 * The shape is deliberately actionable: counts paired with the section an
 * operator would click through to, plus a short alert list surfacing the few
 * things that are actually wrong.
 *
 * Migration status arrives as the canonical `MigrationStatus` from
 * `getMigrationStatus()` (see `src/lib/migration-status-service.ts`) so this
 * page, the system page and the migration runner all classify the same state
 * the same way. The overview deliberately keeps the split rather than a single
 * number: an ordinary pending migration and the deliberately gated
 * `0209_ai_gateway_secret_cutover.sql` need different operator actions, and
 * folding them into one count is what made the cutover look like a forgotten
 * migration.
 */
import { query, withoutTenantScope } from "./db";
import { getPlatformBackupHealth } from "./platform-backup-service";
import type { MigrationStatus } from "./migration-status-service";
import { migrationHeadline, type MigrationHeadline } from "./migration-status-labels";
import { toPersianDigits } from "./digits";

export interface OverviewAlert {
  level: "error" | "warning" | "info";
  title: string;
  href: string;
}

export interface PlatformOverview {
  businesses: {
    total: number;
    active: number;
    suspended: number;
    archived: number;
    /** Businesses created in the last 30 days. */
    newLast30d: number;
  };
  support: { open: number; urgentOpen: number; unassignedOpen: number };
  bugReports: { new: number; total: number };
  payments: { manualPending: number; failedLast7d: number };
  backup: {
    status: "ok" | "warning" | "error" | "unknown";
    lastSuccessAt: string | null;
    reason: string | null;
  };
  system: {
    /**
     * Ordinary pending + gated/deferred migrations, or null when the inventory
     * could not be read. Never zero as a stand-in for "unknown".
     */
    pendingMigrations: number | null;
    /** Unapplied migrations an ordinary `npm run db:migrate` would apply. */
    ordinaryPendingMigrations: number;
    /** Unapplied migrations deliberately withheld pending operator verification. */
    gatedMigrations: number;
    /** False when the migration inventory or `schema_migrations` was unreadable. */
    migrationStatusAvailable: boolean;
    /** Stable reason code from the migration-status service, or null. */
    migrationStatusReasonCode: string | null;
    /**
     * The canonical one-line classification (`migrationHeadline`), computed once
     * here so the tile, the alert list and the system page all say the same
     * thing about the same state.
     */
    migrationHeadline: MigrationHeadline | null;
    rlsEffective: boolean;
    poolWaiting: number;
  };
  alerts: OverviewAlert[];
}

/**
 * Aggregate the overview. `migrations` is the canonical status computed once by
 * the shared migration-status service and handed in by the route, so the
 * overview and the system page cannot disagree.
 */
export async function getPlatformOverview(migrations: MigrationStatus): Promise<PlatformOverview> {
  const [counts, backupHealth, rls, pool] = await withoutTenantScope("platform", () =>
    Promise.all([
      query<{
        biz_total: string;
        biz_active: string;
        biz_suspended: string;
        biz_archived: string;
        biz_new_30d: string;
        support_open: string;
        support_urgent: string;
        support_unassigned: string;
        bugs_new: string;
        bugs_total: string;
        pay_manual_pending: string;
        pay_failed_7d: string;
      }>(
        `SELECT
           (SELECT count(*) FROM businesses) AS biz_total,
           (SELECT count(*) FROM businesses WHERE status = 'active') AS biz_active,
           (SELECT count(*) FROM businesses WHERE status = 'suspended') AS biz_suspended,
           (SELECT count(*) FROM businesses WHERE status = 'archived') AS biz_archived,
           (SELECT count(*) FROM businesses WHERE created_at >= now() - interval '30 days') AS biz_new_30d,
           (SELECT count(*) FROM support_tickets WHERE status IN ('open','in_progress','waiting_customer')) AS support_open,
           (SELECT count(*) FROM support_tickets WHERE status IN ('open','in_progress','waiting_customer') AND priority = 'urgent') AS support_urgent,
           (SELECT count(*) FROM support_tickets WHERE status IN ('open','in_progress','waiting_customer') AND assigned_admin_id IS NULL) AS support_unassigned,
           (SELECT count(*) FROM bug_reports WHERE status = 'new') AS bugs_new,
           (SELECT count(*) FROM bug_reports) AS bugs_total,
           (SELECT count(*) FROM billing_payments WHERE gateway = 'manual' AND status = 'pending') AS pay_manual_pending,
           (SELECT count(*) FROM billing_payments WHERE status = 'failed' AND created_at >= now() - interval '7 days') AS pay_failed_7d`,
      ),
      // Best-effort: the overview must render even if the backup subsystem cannot answer.
      getPlatformBackupHealth().catch(() => null),
      query<{ privileged: boolean }>(
        `SELECT (rolsuper OR rolbypassrls) AS privileged FROM pg_roles WHERE rolname = current_user`,
      ),
      Promise.resolve(null),
    ]),
  );

  const c = counts.rows[0];
  const rlsEffective = rls.rows[0] ? !rls.rows[0].privileged : false;

  const support = {
    open: Number(c?.support_open ?? 0),
    urgentOpen: Number(c?.support_urgent ?? 0),
    unassignedOpen: Number(c?.support_unassigned ?? 0),
  };
  const bugReports = { new: Number(c?.bugs_new ?? 0), total: Number(c?.bugs_total ?? 0) };
  const payments = {
    manualPending: Number(c?.pay_manual_pending ?? 0),
    failedLast7d: Number(c?.pay_failed_7d ?? 0),
  };

  const backupStatus: PlatformOverview["backup"]["status"] = backupHealth
    ? backupHealth.alert.level === "error"
      ? "error"
      : backupHealth.alert.level === "warning"
        ? "warning"
        : "ok"
    : "unknown";

  const ordinaryPending = migrations.available ? migrations.ordinaryPending.length : 0;
  const gatedMigrations = migrations.available ? migrations.gated.length : 0;

  const alerts: OverviewAlert[] = [];
  if (!migrations.available) {
    // An inventory we could not read is not a healthy deployment; say so rather
    // than reporting zero pending and letting the badge read «سالم».
    alerts.push({
      level: "warning",
      title: "وضعیت مهاجرت‌های پایگاه‌داده نامشخص است؛ فهرست مهاجرت‌ها خوانده نشد",
      href: "/platform/system",
    });
  }
  if (migrations.cutover.flagsConflict) {
    alerts.push({
      level: "error",
      title: "تناقض در تنظیمات مهاجرت کلید هوش مصنوعی؛ اجرای مهاجرت متوقف شده",
      href: "/platform/system",
    });
  }
  if (migrations.cutover.blockedBy) {
    alerts.push({
      level: "error",
      title: `مهاجرت بعدی وابسته به ستون قدیمی، اجرای مهاجرت کلید هوش مصنوعی را متوقف کرده: ${migrations.cutover.blockedBy}`,
      href: "/platform/system",
    });
  }
  if (ordinaryPending > 0) {
    alerts.push({
      level: "error",
      title: `${toPersianDigits(ordinaryPending)} مهاجرت پایگاه‌داده اجرا نشده است`,
      href: "/platform/system",
    });
  }
  if (gatedMigrations > 0) {
    alerts.push({
      level: "warning",
      title: "پاک‌سازی کلیدهای قدیمی هوش مصنوعی در انتظار تأیید خوانش رمزنگاری‌شده است",
      href: "/platform/system",
    });
  }
  if (!rlsEffective) {
    alerts.push({
      level: "error",
      title: "RLS به‌درستی اعمال نمی‌شود؛ نقش اتصال بررسی شود",
      href: "/platform/system",
    });
  }
  if (backupStatus === "error") {
    alerts.push({
      level: "error",
      title: backupHealth?.alert.reason ?? "پشتیبان‌گیری کامل سیستم مشکل دارد",
      href: "/platform/backup",
    });
  } else if (backupStatus === "warning") {
    alerts.push({
      level: "warning",
      title: backupHealth?.alert.reason ?? "وضعیت پشتیبان‌گیری نیاز به بررسی دارد",
      href: "/platform/backup",
    });
  }
  if (payments.manualPending > 0) {
    alerts.push({
      level: "warning",
      title: `${payments.manualPending} پرداخت دستی در انتظار بررسی`,
      href: "/platform/billing",
    });
  }
  if (support.urgentOpen > 0) {
    alerts.push({
      level: "warning",
      title: `${support.urgentOpen} تیکت فوری باز`,
      href: "/platform/support",
    });
  }
  if (bugReports.new > 0) {
    alerts.push({
      level: "info",
      title: `${bugReports.new} گزارش خطای جدید`,
      href: "/platform/bug-reports",
    });
  }
  void pool;

  return {
    businesses: {
      total: Number(c?.biz_total ?? 0),
      active: Number(c?.biz_active ?? 0),
      suspended: Number(c?.biz_suspended ?? 0),
      archived: Number(c?.biz_archived ?? 0),
      newLast30d: Number(c?.biz_new_30d ?? 0),
    },
    support,
    bugReports,
    payments,
    backup: {
      status: backupStatus,
      lastSuccessAt: backupHealth?.localLastSuccessAt ?? null,
      reason: backupHealth?.alert.reason ?? null,
    },
    system: {
      pendingMigrations: migrations.pendingTotal,
      ordinaryPendingMigrations: ordinaryPending,
      gatedMigrations,
      migrationStatusAvailable: migrations.available,
      migrationStatusReasonCode: migrations.reasonCode,
      migrationHeadline: migrationHeadline(migrations),
      rlsEffective,
      poolWaiting: 0,
    },
    alerts,
  };
}
