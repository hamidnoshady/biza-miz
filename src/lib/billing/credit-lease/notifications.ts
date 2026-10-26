/**
 * Credit lease notifications (issue #998, Phase 0) — which banner a Hybrid or
 * Full Offline site shows, and what it says.
 *
 * Everything is derived from four timestamps and the meter's state, never from
 * "is the sync running", so a stuck sync cannot hide the warning (the 1,092
 * silent ticks in the findings issues). The caller supplies the clock.
 *
 * Money and dates arrive already formatted — `formatMoney` for the business's
 * unit, `formatJalali` for the expiry — so this module never spells either.
 */
import { brandLocale, brandName, type BrandLocale } from "../../brand";
import { toPersianDigits } from "../../digits";
import { debtPercent, type CreditLeaseState } from "./policy";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Lease time left at which each time-driven level starts. */
export const NOTICE_BEFORE_EXPIRY_MS = 72 * HOUR_MS;
export const WARNING_BEFORE_EXPIRY_MS = 24 * HOUR_MS;
export const FINAL_BEFORE_EXPIRY_MS = HOUR_MS;
/** Share of the debt ceiling at which the near-lock warning starts. */
export const NEAR_LOCK_PERCENT = 80;
/** How long each of the four housekeeping jobs may go without success before it counts as overdue. */
export const SYNC_OVERDUE_MS = 4 * DAY_MS;
export const UPDATE_CHECK_OVERDUE_MS = 7 * DAY_MS;
export const BACKUP_OVERDUE_MS = 4 * DAY_MS;

export const CREDIT_NOTIFICATION_LEVELS = ["none", "notice", "warning", "final", "debt", "near_lock", "locked"] as const;
export type CreditNotificationLevel = (typeof CREDIT_NOTIFICATION_LEVELS)[number];

export type OverdueItem = "sync" | "lease" | "update" | "backup";

export interface CreditNotificationFacts {
  now: Date;
  /** Null when the site holds no lease (nothing is metered, nothing to say). */
  leaseExpiresAt: Date | null;
  lastSyncAt: Date | null;
  lastUpdateCheckAt: Date | null;
  lastBackupAt: Date | null;
  state: CreditLeaseState;
  debtRial: number;
  debtCeilingRial: number;
}

export interface CreditNotification {
  level: CreditNotificationLevel;
  overdue: OverdueItem[];
  /** Whole days since the last successful sync; null if it has never synced. */
  daysSinceSync: number | null;
  /** A banner the user may dismiss until the next sign-in. Only the first level is. */
  dismissible: boolean;
  /** A modal shown at sign-in. */
  modal: boolean;
}

function overdueSince(last: Date | null, now: Date, limitMs: number): boolean {
  return last === null || now.getTime() - last.getTime() >= limitMs;
}

export function overdueItems(facts: CreditNotificationFacts): OverdueItem[] {
  if (facts.leaseExpiresAt === null) return [];
  const items: OverdueItem[] = [];
  if (overdueSince(facts.lastSyncAt, facts.now, SYNC_OVERDUE_MS)) items.push("sync");
  if (facts.leaseExpiresAt.getTime() - facts.now.getTime() <= NOTICE_BEFORE_EXPIRY_MS) items.push("lease");
  if (overdueSince(facts.lastUpdateCheckAt, facts.now, UPDATE_CHECK_OVERDUE_MS)) items.push("update");
  if (overdueSince(facts.lastBackupAt, facts.now, BACKUP_OVERDUE_MS)) items.push("backup");
  return items;
}

export function creditNotification(facts: CreditNotificationFacts): CreditNotification {
  const overdue = overdueItems(facts);
  const daysSinceSync =
    facts.lastSyncAt === null ? null : Math.max(0, Math.floor((facts.now.getTime() - facts.lastSyncAt.getTime()) / DAY_MS));
  const base = { overdue, daysSinceSync };

  if (facts.leaseExpiresAt === null) return { ...base, level: "none", dismissible: false, modal: false };

  if (facts.state === "locked") return { ...base, level: "locked", dismissible: false, modal: true };
  if (facts.state === "over_lease_debt") {
    const near = debtPercent(facts.debtRial, facts.debtCeilingRial) >= NEAR_LOCK_PERCENT;
    return { ...base, level: near ? "near_lock" : "debt", dismissible: false, modal: near };
  }

  const msLeft = facts.leaseExpiresAt.getTime() - facts.now.getTime();
  if (msLeft <= FINAL_BEFORE_EXPIRY_MS) return { ...base, level: "final", dismissible: false, modal: true };
  if (msLeft <= WARNING_BEFORE_EXPIRY_MS) return { ...base, level: "warning", dismissible: false, modal: false };
  // Day 4 of a 7-day lease is E - 72 h; a sync that has been dark for four days says the same thing.
  if (msLeft <= NOTICE_BEFORE_EXPIRY_MS || overdue.includes("sync")) {
    return { ...base, level: "notice", dismissible: true, modal: false };
  }
  return { ...base, level: "none", dismissible: false, modal: false };
}

/** Values the copy needs, all pre-formatted for the reader. */
export interface CreditCopyParams {
  /** Whole days offline (`daysSinceSync`); a never-synced site passes the lease age. */
  days: number;
  /** Jalali expiry date and time, already formatted. */
  expiry: string;
  /** Debt used and the ceiling, formatted in the business's money unit. */
  used: string;
  ceiling: string;
  overdue: readonly OverdueItem[];
}

export interface CreditCopy {
  title: string;
  body: string;
}

const ITEM_LABEL: Record<BrandLocale, Record<OverdueItem, string>> = {
  fa: { sync: "همگام‌سازی مصرف", lease: "تمدید اعتبار", update: "بررسی به‌روزرسانی", backup: "پشتیبان‌گیری" },
  en: { sync: "usage sync", lease: "credit renewal", update: "update check", backup: "backup" },
};

export function creditNotificationCopy(
  level: Exclude<CreditNotificationLevel, "none">,
  locale: string | null | undefined,
  params: CreditCopyParams,
): CreditCopy {
  const lang = brandLocale(locale);
  const brand = brandName(locale);
  const items = params.overdue.map((item) => ITEM_LABEL[lang][item]).join(lang === "fa" ? "، " : ", ");

  if (lang === "fa") {
    const days = toPersianDigits(params.days);
    switch (level) {
      case "notice":
        return {
          title: "لطفاً به اینترنت وصل شوید",
          body:
            `${brand} ${days} روز است به اینترنت وصل نشده. برای همگام‌سازی مصرف، تمدید اعتبار، بررسی به‌روزرسانی و پشتیبان‌گیری، رایانه را به اینترنت وصل کنید.` +
            (items ? ` معوق: ${items}.` : ""),
        };
      case "warning":
        return {
          title: "اعتبار آفلاین رو به پایان است",
          body: `اعتبار آفلاین ${brand} تا ${params.expiry} تمام می‌شود. پس از آن، مصرف به‌صورت بدهی ثبت می‌شود. همین حالا به اینترنت وصل شوید.`,
        };
      case "final":
        return {
          title: "کمتر از یک ساعت مانده است",
          body: `کمتر از یک ساعت تا پایان اعتبار آفلاین ${brand} مانده است. برای جلوگیری از ثبت بدهی، اکنون به اینترنت وصل شوید.`,
        };
      case "debt":
        return {
          title: "اعتبار آفلاین تمام شده است",
          body: `اعتبار آفلاین تمام شده و مصرف جدید به‌صورت بدهی ثبت می‌شود (${params.used} از سقف ${params.ceiling}). برای جلوگیری از قفل شدن، به اینترنت وصل شوید.`,
        };
      case "near_lock":
        return {
          title: "بدهی نزدیک سقف است",
          body: `بدهی به ${toPersianDigits(NEAR_LOCK_PERCENT)}٪ سقف رسیده است (${params.used} از ${params.ceiling}). با رسیدن به سقف، ثبت فروش جدید قفل می‌شود.`,
        };
      case "locked":
        return {
          title: "ثبت فروش جدید قفل است",
          body: "سقف بدهی پر شده و ثبت فروش جدید قفل است. بستن سفارش‌ها و شیفت، چاپ رسید، خروجی‌گیری و پشتیبان‌گیری همچنان در دسترس است. برای رفع قفل به اینترنت وصل شوید.",
        };
    }
  }

  switch (level) {
    case "notice":
      return {
        title: "Please connect to the Internet",
        body:
          `${brand} has been offline for ${params.days} ${params.days === 1 ? "day" : "days"}. Connect to the Internet to sync usage, renew your credit, check for updates and upload a backup.` +
          (items ? ` Overdue: ${items}.` : ""),
      };
    case "warning":
      return {
        title: "Offline credit is running out",
        body: `${brand}'s offline credit ends at ${params.expiry}. After that, usage is recorded as debt. Connect to the Internet now.`,
      };
    case "final":
      return {
        title: "Less than an hour left",
        body: `Less than an hour of offline credit left in ${brand}. Connect now to avoid recording debt.`,
      };
    case "debt":
      return {
        title: "Offline credit has run out",
        body: `Offline credit has run out; new usage is recorded as debt (${params.used} of ${params.ceiling}). Connect to the Internet to avoid a lock.`,
      };
    case "near_lock":
      return {
        title: "Debt is close to the ceiling",
        body: `Debt has reached ${NEAR_LOCK_PERCENT}% of the ceiling (${params.used} of ${params.ceiling}). New sales will be locked when it is reached.`,
      };
    case "locked":
      return {
        title: "New sales are locked",
        body: "The debt ceiling has been reached and new sales are locked. Closing orders and shifts, printing receipts, exporting and backing up still work. Connect to the Internet to unlock.",
      };
  }
}
