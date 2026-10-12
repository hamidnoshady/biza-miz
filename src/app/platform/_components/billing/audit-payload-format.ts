/**
 * Typed presentation of billing-audit payloads (audit F21).
 *
 * The previous summariser treated every integer with magnitude ≥ 1000 as a
 * Rial amount, so a 5,000-order limit read as «۵۰۰ تومان». Presentation now
 * follows the KEY NAME, not the magnitude:
 *
 *   - `…Rial` / `amount` / `credit` money keys → Toman label (storage is Rial).
 *   - `…Count`, `…Limit`, `…Orders`, `…Quantity`, `…Units` → plain quantity.
 *   - `…Percent` (percentage points) and `…Bps` (basis points, shown ÷100).
 *   - ISO timestamps (`…At`, `…Date`, `…Until`) → Jalali display.
 *   - Anything else keeps its raw value; it is never guessed to be money.
 *
 * Pure module so the rules are unit-tested without rendering the tab.
 */
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { tomanLabel } from "@/lib/platform-money";

export const PAYLOAD_LABELS: Record<string, string> = {
  from: "از",
  to: "به",
  before: "پیش",
  after: "پس",
  kind: "نوع",
  group: "گروه",
  removed: "حذف",
  featureKey: "قابلیت",
  planKey: "پلن",
  packageName: "بسته",
  amountRial: "مبلغ",
  creditRial: "اعتبار",
  name: "نام",
  limit: "سقف",
  orderLimit: "سقف سفارش",
  orders: "سفارش",
  count: "تعداد",
  percent: "درصد",
  bps: "نرخ",
  active: "فعال",
  enabled: "فعال",
  expiresAt: "انقضا",
  effectiveAt: "اعمال از",
};

const MONEY_KEY = /(rial|amount|credit|price|balance|budget|spend|fee|cost)$/i;
const MONEY_EXACT = /^(amount|credit|price|balance|budget|spend|fee|cost)$/i;
const QUANTITY_KEY = /(count|limit|orders?|quantity|units?|size|items?|tokens?|days?|rounds?)$/i;
const PERCENT_KEY = /percent$/i;
const BPS_KEY = /bps$|basis(points)?$/i;
const TIME_KEY = /(at|date|until|since)$/i;

export type PayloadValueKind = "money" | "quantity" | "percent" | "bps" | "time" | "boolean" | "unknown";

/** The presentation kind of a value, decided by its key name only. */
export function payloadValueKind(key: string, value: unknown): PayloadValueKind {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) && TIME_KEY.test(key)) return "time";
  if (typeof value !== "number") return "unknown";
  if (BPS_KEY.test(key)) return "bps";
  if (PERCENT_KEY.test(key)) return "percent";
  if (MONEY_KEY.test(key) || MONEY_EXACT.test(key)) return "money";
  if (QUANTITY_KEY.test(key)) return "quantity";
  return "unknown";
}

function plainNumber(n: number): string {
  return toPersianDigits(n.toLocaleString("en-US").replace(/,/g, "٬"));
}

/** Operator-facing text for one payload value. */
export function formatPayloadValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  const kind = payloadValueKind(key, value);
  switch (kind) {
    case "boolean":
      return value ? "بله" : "خیر";
    case "time":
      return formatJalali(value as string, { withTime: true });
    case "money":
      return tomanLabel(value as number);
    case "percent":
      return `${toPersianDigits(String(value))}٪`;
    case "bps":
      return `${toPersianDigits(String(Number(value) / 100))}٪`;
    case "quantity":
      return plainNumber(value as number);
    default:
      if (typeof value === "number") return toPersianDigits(String(value));
      if (typeof value === "object") return toPersianDigits(JSON.stringify(value));
      return String(value);
  }
}

function labelFor(key: string): string {
  return PAYLOAD_LABELS[key] ?? key;
}

/** Human summary of a payload — before/after diffs above all. */
export function summarizePayload(payload: Record<string, unknown> | null): string | null {
  if (!payload || typeof payload !== "object") return null;
  const parts: string[] = [];

  for (const key of ["from", "to", "before", "after"]) {
    if (!(key in payload)) continue;
    const value = payload[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const inner = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => `${labelFor(k)}: ${formatPayloadValue(k, v)}`)
        .join("، ");
      parts.push(`${labelFor(key)}: ${inner || "—"}`);
    } else {
      parts.push(`${labelFor(key)}: ${formatPayloadValue(key, value)}`);
    }
  }

  for (const key of [
    "kind",
    "group",
    "removed",
    "featureKey",
    "planKey",
    "packageName",
    "amountRial",
    "creditRial",
    "name",
  ]) {
    if (key in payload) parts.push(`${labelFor(key)}: ${formatPayloadValue(key, payload[key])}`);
  }

  return parts.length ? parts.join(" • ") : null;
}
