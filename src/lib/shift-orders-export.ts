/**
 * The shift report as a file — the framework-free half of the export route's
 * `shift_orders` kind (issue #819).
 *
 * The shift screen is paginated at 25 orders; its export must not be. A file
 * that silently stopped at the first page would reconcile a shift against
 * one page of its bills, which is worse than no file at all — so the route
 * walks every page and this module turns the collected orders into the one
 * tabular shape all three formats share. Keeping the projection here (rather
 * than inline in the route) makes the exported columns testable without a
 * database, exactly like `groupShiftOrders` is.
 *
 * Money leaves converted to the business's display unit, with the unit named
 * on each column — the same rule the chart and business-overview exports
 * follow, so one report never disagrees with itself across formats.
 */
import { formatJalali } from "./jalali";
import { moneyToInput, type MoneyUnit } from "./money";
import type { ShiftOrder } from "./shift-orders";
import type { ReportTable } from "./report-export";

const TYPE_LABELS: Record<ShiftOrder["type"], string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
  retail: "فاکتور فروش",
};

const STATUS_LABELS: Record<string, string> = {
  open: "باز",
  held: "نگه‌داشته",
  completed: "تکمیل‌شده",
  voided: "باطل‌شده",
};

/** Money columns carry the unit; every amount cell is converted to it. */
export function shiftOrdersExportTable(
  orders: readonly ShiftOrder[],
  unit: MoneyUnit,
): ReportTable {
  const unitLabel = unit === "rial" ? "ریال" : "تومان";
  const money = (value: number) => moneyToInput(value, unit);
  const stamp = (iso: string | null) =>
    iso === null ? "" : formatJalali(iso, { withTime: true });

  return {
    columns: [
      { key: "orderNumber", label: "شمارهٔ سفارش" },
      { key: "type", label: "نوع" },
      { key: "status", label: "وضعیت" },
      { key: "table", label: "میز" },
      { key: "customer", label: "مشتری" },
      { key: "guests", label: "مهمان" },
      { key: "openedAt", label: "باز شده" },
      { key: "closedAt", label: "بسته شده" },
      { key: "openedBy", label: "بازکننده" },
      { key: "closedBy", label: "بستن‌دهنده" },
      { key: "itemCount", label: "تعداد اقلام" },
      { key: "subtotal", label: `جمع جزء (${unitLabel})` },
      { key: "discount", label: `تخفیف (${unitLabel})` },
      { key: "serviceCharge", label: `خدمات (${unitLabel})` },
      { key: "tax", label: `مالیات (${unitLabel})` },
      { key: "tip", label: `انعام (${unitLabel})` },
      { key: "total", label: `مبلغ کل (${unitLabel})` },
      { key: "payments", label: `پرداخت‌ها (${unitLabel})` },
      { key: "channel", label: "کانال" },
      { key: "note", label: "یادداشت سفارش" },
      { key: "voidedReason", label: "دلیل ابطال" },
    ],
    rows: orders.map((order) => ({
      orderNumber: order.orderNumber,
      type: TYPE_LABELS[order.type] ?? order.type,
      status: STATUS_LABELS[order.status] ?? order.status,
      table: order.tableName ?? "",
      customer: order.customerName ?? "",
      guests: order.guestCount ?? "",
      openedAt: stamp(order.openedAt),
      closedAt: stamp(order.closedAt),
      openedBy: order.openedByName ?? "",
      closedBy: order.closedByName ?? "",
      itemCount: order.itemCount,
      subtotal: money(order.subtotal),
      discount: money(order.discount),
      serviceCharge: money(order.serviceCharge),
      tax: money(order.tax),
      tip: money(order.tipAmount),
      total: money(order.total),
      // Every tender of a split bill, in the order it was taken — a shift
      // reconciliation is often exactly about how one order was paid.
      payments: order.payments
        .map((payment) => `${payment.methodName ?? payment.method}: ${money(payment.amount)}`)
        .join("؛ "),
      channel: order.channel === "online" ? "وب‌سایت" : "حضوری",
      note: order.note ?? "",
      voidedReason: order.voidedReason ?? "",
    })),
  };
}
