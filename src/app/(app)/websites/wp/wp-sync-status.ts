/**
 * Pure rules behind the overview's sync buttons and status lines — kept out
 * of the component so they are unit-testable without a DOM (#944 / OVR-04,
 * OVR-07, OVR-08).
 *
 *  - `classifySyncResponse` turns a sync route's reply into one of
 *    `completed | queued | partial | failed`, with the counts, the failed
 *    substeps and a user-facing message. HTTP 200 + `contentError` is a
 *    *partial* success, never «انجام شد».
 *  - `syncAvailability` says whether a button should be live for this store
 *    and member, and why not otherwise: the API's own refusals (flag off,
 *    paused, no permission, plugin cannot apply the job) said before the
 *    click. The API stays authoritative.
 *  - `transportHealthPresentation` names what the connection service's
 *    transport-health state means to a person, separately from the
 *    configured `active | paused | error` status.
 */
import { errorMessageOrRaw } from "@/app/dashboard/ui";
import { pluginSupportsJobType } from "@/lib/integrations/plugin-capabilities";
import type { WpAbility } from "@/lib/wp-access";
import type { WpManagerConnection } from "./wp-store-context";

export type SyncKind = "products" | "orders" | "customers" | "content";

export const SYNC_LABELS: Record<SyncKind, string> = {
  products: "محصولات",
  orders: "سفارش‌ها",
  customers: "مشتریان",
  content: "محتوا",
};

/** The outbox job each button enqueues in plugin mode — what the plugin must advertise. */
const PLUGIN_JOB_FOR: Record<SyncKind, string> = {
  products: "catalogue_export",
  orders: "orders_export",
  customers: "customer_export",
  content: "content_export",
};

export interface SyncFailedStep {
  step: string;
  error: string;
}

export type SyncOutcome =
  | { kind: "completed"; counts: Record<string, number> }
  | { kind: "queued" }
  | { kind: "partial"; counts: Record<string, number>; failedSteps: SyncFailedStep[] }
  | { kind: "failed"; status: number; code: string; message: string };

interface SyncResponseLike {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null | undefined;
}

const COUNT_KEYS = ["created", "updated", "skipped", "pulled", "imported", "upserted", "synced", "total", "count", "posts", "pages", "media"] as const;

function pickCounts(data: Record<string, unknown> | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  if (!data) return counts;
  for (const key of COUNT_KEYS) {
    const value = data[key];
    if (typeof value === "number" && Number.isFinite(value)) counts[key] = value;
  }
  return counts;
}

/** A failure the sync routes answer with, in the member's words. */
export function describeSyncFailure(status: number, code: string): string {
  if (status === 0) return "ارتباط با سرور برقرار نشد؛ اتصال اینترنت را بررسی کنید و دوباره تلاش کنید.";
  if (status === 401 || code === "unauthorized") return "نشست شما به پایان رسیده است؛ دوباره وارد شوید.";
  if (status === 403 || code === "forbidden") return "برای اجرای همگام‌سازی مجوز «همگام‌سازی ووکامرس» لازم است.";
  if (code === "plugin_job_unsupported") return "افزونهٔ وردپرس این فروشگاه این عملیات را پشتیبانی نمی‌کند؛ افزونه را به‌روز کنید.";
  if (status === 404 || code === "not_found") return "این فروشگاه دیگر وجود ندارد؛ فهرست فروشگاه‌ها را تازه کنید.";
  const mapped = code ? errorMessageOrRaw(code) : "";
  if (mapped && mapped !== code) return mapped;
  if (status === 409) return mapped || "این همگام‌سازی برای فروشگاه در دسترس نیست.";
  if (status >= 500) return mapped || "فروشگاه یا سرور پاسخ نداد؛ کمی بعد دوباره تلاش کنید.";
  return mapped || "همگام‌سازی با خطا مواجه شد.";
}

export function classifySyncResponse(res: SyncResponseLike): SyncOutcome {
  const data = res.data ?? {};
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : "";
    return { kind: "failed", status: res.status, code, message: describeSyncFailure(res.status, code) };
  }
  const result = typeof data.result === "string" ? data.result : "";
  if (result === "queued" || data.queued === true) return { kind: "queued" };
  const failedSteps: SyncFailedStep[] = Array.isArray(data.failedSteps)
    ? (data.failedSteps as unknown[]).flatMap((item) =>
        item && typeof item === "object" && typeof (item as SyncFailedStep).step === "string"
          ? [{ step: (item as SyncFailedStep).step, error: String((item as SyncFailedStep).error ?? "") }]
          : [],
      )
    : [];
  if (failedSteps.length === 0 && typeof data.contentError === "string" && data.contentError) {
    failedSteps.push({ step: "content", error: data.contentError });
  }
  if (result === "partial" || failedSteps.length > 0) {
    return { kind: "partial", counts: pickCounts(data), failedSteps };
  }
  return { kind: "completed", counts: pickCounts(data) };
}

const STEP_LABELS: Record<string, string> = {
  content: "محتوای وردپرس (نوشته‌ها، برگه‌ها، رسانه)",
  catalogue: "کاتالوگ",
  orders: "سفارش‌ها",
  customers: "مشتریان",
};

export interface SyncOutcomeText {
  tone: "positive" | "warn" | "danger" | "neutral";
  message: string;
  /** A sync the member can run on its own to finish a partial one. */
  retryKind?: SyncKind;
}

function countsSentence(counts: Record<string, number>): string {
  const parts: string[] = [];
  if (counts.created !== undefined) parts.push(`${counts.created.toLocaleString("fa-IR")} جدید`);
  if (counts.updated !== undefined) parts.push(`${counts.updated.toLocaleString("fa-IR")} به‌روز`);
  if (counts.skipped !== undefined) parts.push(`${counts.skipped.toLocaleString("fa-IR")} بدون تغییر`);
  if (parts.length === 0) {
    const total = counts.pulled ?? counts.imported ?? counts.upserted ?? counts.synced ?? counts.total ?? counts.count;
    if (total !== undefined) parts.push(`${total.toLocaleString("fa-IR")} مورد`);
  }
  return parts.length ? ` (${parts.join("، ")})` : "";
}

export function describeSyncOutcome(kind: SyncKind, outcome: SyncOutcome): SyncOutcomeText {
  const label = SYNC_LABELS[kind];
  switch (outcome.kind) {
    case "queued":
      return {
        tone: "neutral",
        message: `درخواست همگام‌سازی ${label} در صف قرار گرفت؛ افزونهٔ وردپرس آن را در اجرای بعدی (معمولاً ظرف چند دقیقه) اعمال می‌کند. تا تأیید اجرا، این صفحه آن را «انجام‌شده» نشان نمی‌دهد.`,
      };
    case "completed":
      return { tone: "positive", message: `همگام‌سازی ${label} انجام شد${countsSentence(outcome.counts)}.` };
    case "partial": {
      const failed = outcome.failedSteps.map((step) => STEP_LABELS[step.step] ?? step.step).join("، ");
      const detail = outcome.failedSteps.map((step) => errorMessageOrRaw(step.error) || step.error).filter(Boolean).join("؛ ");
      const retryKind = outcome.failedSteps.some((step) => step.step === "content") ? "content" : undefined;
      return {
        tone: "warn",
        message: `همگام‌سازی ${label} ناقص انجام شد${countsSentence(outcome.counts)}: ${failed} همگام نشد${detail ? ` — ${detail}` : ""}.`,
        retryKind,
      };
    }
    case "failed":
      return { tone: "danger", message: `همگام‌سازی ${label}: ${outcome.message}` };
  }
}

export interface SyncAvailability {
  enabled: boolean;
  /** Why the button is off — shown next to it, never silently hidden. */
  reason?: string;
}

export function syncAvailability(
  connection: Pick<
    WpManagerConnection,
    "status" | "linkMode" | "syncProducts" | "syncOrders" | "syncCustomers" | "pluginCapabilities"
  > | null,
  can: (ability: WpAbility) => boolean,
  kind: SyncKind,
): SyncAvailability {
  if (!connection) return { enabled: false, reason: "فروشگاهی انتخاب نشده است." };
  if (!can("sync")) return { enabled: false, reason: "برای اجرای همگام‌سازی مجوز «همگام‌سازی ووکامرس» لازم است." };
  if (connection.status === "paused") return { enabled: false, reason: errorMessageOrRaw("connection_paused") };
  if (kind === "products" && connection.syncProducts === false) return { enabled: false, reason: errorMessageOrRaw("sync_products_disabled") };
  if (kind === "orders" && connection.syncOrders === false) return { enabled: false, reason: errorMessageOrRaw("sync_orders_disabled") };
  if (kind === "customers" && connection.syncCustomers === false) return { enabled: false, reason: errorMessageOrRaw("sync_customers_disabled") };
  if (connection.linkMode === "plugin" && !pluginSupportsJobType(connection.pluginCapabilities ?? null, PLUGIN_JOB_FOR[kind])) {
    return {
      enabled: false,
      reason: `افزونهٔ وردپرس این فروشگاه همگام‌سازی ${SYNC_LABELS[kind]} را پشتیبانی نمی‌کند؛ افزونه را به‌روز کنید.`,
    };
  }
  return { enabled: true };
}

export interface TransportHealthPresentation {
  tone: "positive" | "neutral" | "danger" | "active";
  label: string;
  /** What the member should expect of the queue in this state, and where to go. */
  explanation: string | null;
}

/**
 * The transport-health state the connection service derives, in words. For a
 * REST store "healthy" only means the configuration is in place — nothing has
 * been verified until a sync has actually succeeded — so the label says so.
 */
export function transportHealthPresentation(
  connection: Pick<WpManagerConnection, "linkMode" | "status" | "transportHealth" | "lastSyncAt">,
): TransportHealthPresentation {
  const state = connection.transportHealth?.state ?? (connection.status === "paused" ? "paused" : connection.status === "error" ? "error" : "unknown");
  switch (state) {
    case "paused":
      return {
        tone: "neutral",
        label: "متوقف",
        explanation: "همگام‌سازی از سمت پنل متوقف است؛ کارهای صف تا ازسرگیری اتصال اجرا نمی‌شوند.",
      };
    case "error":
      return {
        tone: "danger",
        label: "خطا",
        explanation: "آخرین تلاش اتصال با خطا مواجه شده است؛ کارهای صف تا رفع خطا دوباره تلاش می‌شوند و ممکن است ناموفق بمانند.",
      };
    case "site_mismatch":
      return {
        tone: "danger",
        label: "ناسازگاری دامنه",
        explanation: "افزونه از دامنه‌ای غیر از دامنهٔ ثبت‌شده پاسخ می‌دهد؛ تا تأیید دامنهٔ جدید در تنظیمات اتصال، کارهای صف اجرا نمی‌شوند.",
      };
    case "never_connected":
      return {
        tone: "neutral",
        label: "افزونه هنوز متصل نشده",
        explanation: "افزونهٔ وردپرس هنوز هیچ‌بار به پنل وصل نشده است؛ درخواست‌های همگام‌سازی در صف می‌مانند تا نخستین اتصال افزونه.",
      };
    case "stale":
      return {
        tone: "danger",
        label: "افزونه بی‌پاسخ",
        explanation: "افزونه بیش از ۱۵ دقیقه است پاسخ نداده؛ کارهای صف تا بازگشت افزونه اجرا نمی‌شوند. کران (WP-Cron) و دسترسی سایت را بررسی کنید.",
      };
    case "healthy":
      if (connection.linkMode === "plugin") return { tone: "positive", label: "افزونه در ارتباط", explanation: null };
      return connection.lastSyncAt
        ? { tone: "positive", label: "REST — آخرین همگام‌سازی موفق", explanation: null }
        : {
            tone: "neutral",
            label: "REST — پیکربندی‌شده، هنوز آزمایش‌نشده",
            explanation: "کلیدهای REST ثبت شده‌اند اما هنوز هیچ همگام‌سازی موفقی انجام نشده؛ با نخستین همگام‌سازی، اتصال واقعاً آزمایش می‌شود.",
          };
    default:
      return { tone: "neutral", label: "نامشخص", explanation: null };
  }
}

/** «نام — دامنه» so two stores that share a name are still told apart. */
export function storeDisplayName(connection: Pick<WpManagerConnection, "name" | "baseUrl">): string {
  const host = storeHost(connection.baseUrl);
  return host && host !== connection.name ? `${connection.name} — ${host}` : connection.name;
}

export function storeHost(baseUrl: string | undefined): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}
