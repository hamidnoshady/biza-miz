/**
 * The one place a WooCommerce order status is rendered as a badge, so the list,
 * the modal and the picker cannot disagree — and so a status whose name could
 * not be read says out loud that it is showing a raw slug (#1215 / P1‑3).
 */
import { StatusBadge } from "@/app/dashboard/page-chrome";
import { orderStatusLabel, orderStatusNamed, orderStatusTone } from "./order-status";

export function OrderStatusBadge({
  status,
  registry,
}: {
  status: string;
  registry?: ReadonlyMap<string, string> | null;
}) {
  const named = orderStatusNamed(status, registry);
  return (
    <StatusBadge tone={orderStatusTone(status)}>
      <span dir={named ? undefined : "ltr"}>{orderStatusLabel(status, registry)}</span>
      {named ? null : (
        <span className="sr-only"> — نام این وضعیت از فروشگاه خوانده نشد؛ شناسهٔ خام نمایش داده می‌شود.</span>
      )}
    </StatusBadge>
  );
}
