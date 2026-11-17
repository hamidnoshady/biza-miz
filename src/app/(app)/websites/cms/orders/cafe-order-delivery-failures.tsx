import { revalidatePath } from "next/cache";
import { SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { listCafeOrderDeliveryFailures, retryCafeOrderDelivery } from "@/lib/cms/cafe-order-state-delivery";
import { toPersianDigits } from "@/lib/digits";
import { PERMISSIONS } from "@/lib/permissions";

const STATE_LABELS: Record<string, string> = {
  accepted: "پذیرش",
  rejected: "رد",
  preparing: "آماده‌سازی",
  ready: "آماده",
  served: "تحویل",
  cancelled: "لغو",
  counter_payment: "پرداخت در صندوق",
};

export async function CafeOrderDeliveryFailures() {
  const { session } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (!session) return null;
  const rows = await listCafeOrderDeliveryFailures(session.businessId);
  if (!rows.length) return null;

  return (
    <SectionCard title="همگام‌سازی ناموفق سفارش‌ها">
      <ul className="divide-y divide-border">
        {rows.map((row) => (
          <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <span>سفارش {toPersianDigits(row.order_number ?? row.cms_order_id)} · {STATE_LABELS[row.state]}</span>
            <StatusBadge tone="danger">
              {row.last_error === "cms_http_409" ? "تعارض وضعیت یا مبلغ در سایت" : "ارسال به سایت ناموفق بود"}
            </StatusBadge>
            <form action={retry}>
              <input type="hidden" name="deliveryId" value={row.id} />
              <Button type="submit" variant="outline" size="sm">تلاش دوباره</Button>
            </form>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

async function retry(form: FormData): Promise<void> {
  "use server";
  const { session } = await requirePermission(PERMISSIONS.cmsContentManage);
  const id = form.get("deliveryId");
  if (!session || typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return;
  await retryCafeOrderDelivery(session.businessId, id);
  revalidatePath("/websites/cms/orders");
}
