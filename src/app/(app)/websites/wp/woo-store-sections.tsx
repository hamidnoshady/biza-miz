"use client";

/**
 * Phase 38 — the surfaces that turn «فروشگاه ووکامرس» from a connection
 * tester into somewhere an owner can actually work:
 *
 *   «کاتالوگ»             `catalogue-section.tsx`, a read-only mirror
 *                         (products are edited in Accounting or in the
 *                         store, never from this screen).
 *   «دسته‌بندی‌ها»          `taxonomies-section.tsx`.
 *   «سفارش‌های فروشگاه»    `orders-section.tsx`.
 *   «تنظیمات همگام‌سازی»   this file: what is pulled, how far back, and
 *                         when it last ran.
 *
 * Every write is queued, never applied inline — the response says so. In
 * plugin mode the app cannot reach the store at all, so an inline call would
 * simply fail there; through the outbox the same button works in both modes
 * and inherits retry, backoff and a visible trail.
 */
import { useState } from "react";
import { api, InfoBox, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "./format";

export { formatDateTime } from "./format";
export { StoreOrdersSection } from "./orders-section";

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/**
 * «دسته‌بندی و ویژگی‌ها» is its own screen now — see taxonomies-section.tsx.
 * It is re-exported here so the existing import sites keep working; the
 * section outgrew the compact panel shape the rest of this file uses.
 */
export { TaxonomiesSection } from "./taxonomies-section";
export type { TermGroup, TermRow } from "./taxonomies-section";

// ---------------------------------------------------------------------------
// Sync settings
// ---------------------------------------------------------------------------

export interface SyncSettingsConnection {
  id: string;
  linkMode: "rest_api" | "plugin";
  syncCategories: boolean;
  autoPullOrders: boolean;
  orderLookbackDays: number;
  lastCatalogueSyncAt: string | null;
  lastOrderSyncAt: string | null;
  /** Issue #1149 — which side owns stock and prices; absent on older payloads (= both). */
  sourceOfTruth?: "store" | "pos" | "two_way";
  manageStockOptIn?: boolean;
}

const SOURCE_OF_TRUTH_LABELS: Record<"store" | "pos" | "two_way", string> = {
  store: "فروشگاه (موجودی و قیمت از فروشگاه می‌آید؛ سامانه چیزی نمی‌فرستد)",
  pos: "سامانهٔ حسابداری (موجودی و قیمت از این‌جا به فروشگاه می‌رود)",
  two_way: "هر دو (طبق کلیدهای ارسال موجودی و قیمت)",
};

export function SyncSettingsSection({
  connection,
  busy,
  call,
}: {
  connection: SyncSettingsConnection;
  busy: boolean;
  call: <T extends Record<string, unknown>>(
    path: string,
    method?: string,
    body?: unknown,
    options?: { successNotice?: string | null },
  ) => Promise<T | null>;
}) {
  const [lookback, setLookback] = useState(String(connection.orderLookbackDays));
  const [dirty, setDirty] = useState(false);

  const toggle = async (patch: Record<string, unknown>) => {
    await call(`/api/integrations/connections/${connection.id}`, "PATCH", patch);
  };

  return (
    <div className="mt-2 space-y-3 rounded-xl bg-muted p-2 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.autoPullOrders}
            disabled={busy}
            onChange={(e) => void toggle({ autoPullOrders: e.target.checked })}
          />
          <span>
            <span className="font-medium">دریافت دوره‌ای سفارش‌ها</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              {connection.linkMode === "plugin"
                ? "در حالت افزونه، خودِ افزونه سفارش‌ها را می‌فرستد؛ این گزینه یک بازخوانی کاملِ دوره‌ای هم درخواست می‌کند."
                : "علاوه بر وب‌هوک، سفارش‌های اخیر به‌طور دوره‌ای هم خوانده می‌شود؛ وب‌هوکی که تنظیم نشده باشد دیگر به معنای از دست رفتن فروش نیست."}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={connection.syncCategories}
            disabled={busy}
            onChange={(e) => void toggle({ syncCategories: e.target.checked })}
          />
          <span>
            <span className="font-medium">ساخت دسته‌بندی از فروشگاه</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              دسته‌های ووکامرس به دسته‌بندی‌های منو/کالا اضافه می‌شوند. به‌طور پیش‌فرض خاموش است، چون چیدمان موجود را
              تغییر می‌دهد.
            </span>
          </span>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block rounded-lg border border-border/70 bg-card p-2">
          <span className="font-medium">مرجع موجودی و قیمت</span>
          <select
            className={`${inputClass} mt-1`}
            value={connection.sourceOfTruth ?? "two_way"}
            disabled={busy}
            onChange={(e) => void toggle({ sourceOfTruth: e.target.value })}
          >
            {(Object.keys(SOURCE_OF_TRUTH_LABELS) as Array<keyof typeof SOURCE_OF_TRUTH_LABELS>).map((key) => (
              <option key={key} value={key}>
                {SOURCE_OF_TRUTH_LABELS[key]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-5 text-muted-foreground">
            با انتخاب «فروشگاه»، ارسال خودکار موجودی و قیمت خاموش می‌شود و کارهای منتظرِ آن بسته می‌شوند.
          </span>
        </label>

        <label className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={Boolean(connection.manageStockOptIn)}
            disabled={busy}
            onChange={(e) => void toggle({ manageStockOptIn: e.target.checked })}
          />
          <span>
            <span className="font-medium">روشن‌کردن مدیریت موجودی در فروشگاه</span>
            <span className="block text-[11px] leading-5 text-muted-foreground">
              به‌طور پیش‌فرض موجودی فقط برای کالاهایی ارسال می‌شود که فروشگاه خودش موجودی‌شان را مدیریت می‌کند. با روشن‌کردن
              این گزینه، ارسال موجودی می‌تواند مدیریت موجودی کالاهای دیگر را هم در فروشگاه روشن کند.
            </span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <div>
          <span className="mb-1 block text-[11px] text-muted-foreground">بازهٔ بازخوانی سفارش‌ها (روز)</span>
          <input
            className={inputClass}
            value={lookback}
            onChange={(e) => {
              setLookback(e.target.value);
              setDirty(true);
            }}
            inputMode="numeric"
            dir="ltr"
          />
        </div>
        <Button
          type="button"
          size="xs"
          disabled={busy || !dirty}
          onClick={async () => {
            const days = Math.min(365, Math.max(1, Math.round(Number(lookback) || 7)));
            setLookback(String(days));
            setDirty(false);
            await call(`/api/integrations/connections/${connection.id}`, "PATCH", { orderLookbackDays: days });
          }}
        >
          ذخیرهٔ بازه
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() =>
            call(`/api/integrations/connections/${connection.id}/sync/orders`, "POST", {
              sinceDays: Number(lookback) || undefined,
            })
          }
        >
          همگام‌سازی سفارش‌ها
        </Button>
      </div>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>آخرین همگام‌سازی محصولات: {formatDateTime(connection.lastCatalogueSyncAt)}</span>
        <span>آخرین همگام‌سازی سفارش‌ها: {formatDateTime(connection.lastOrderSyncAt)}</span>
      </div>

      <InfoBox>
        در حالت افزونهٔ وردپرس، زمان‌بندی همگام‌سازی در خودِ وردپرس است و بازهٔ آن را افزونهٔ نصب‌شده گزارش می‌کند
        (افزونه‌های ۱٫۶ به بالا هر دقیقه، نسخه‌های قدیمی‌تر هر پنج دقیقه). بازسازی کاملِ کاتالوگ و سفارش‌ها طبق
        برنامه‌ای که در تنظیمات افزونه انتخاب کرده‌اید اجرا می‌شود. زمان واقعی اجرا را وضعیت کرون در همین کارت
        نشان می‌دهد؛ این عدد تنظیمات است، نه زمان اندازه‌گیری‌شده روی این سرور.
      </InfoBox>
    </div>
  );
}
