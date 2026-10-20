"use client";

/**
 * Phase 42b — the «حواله بازگشت» tab: the supplier-return form, extracted
 * unchanged from the former retail stock workspace (Phase 27 Wave 8's retail
 * supplier returns) into the warehouse module's «اقلام و عملیات» group. The
 * form's fields and POST payload are byte-for-byte the originals; only the
 * data loading moved into the section. Kept separate from the warehouse
 * document (حواله انبار) on purpose: a return TO a supplier settles against
 * the supplier, a warehouse issue does not.
 */
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { clearPendingIdempotencyKey, pendingIdempotencyKey } from "@/lib/pending-idempotency";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { SectionCard, SectionCardSkeleton } from "../page-chrome";

interface StockItem {
  id: string;
  name: string;
  sku: string | null;
  tracking: string;
  quantity: string;
  unitCost: number | null;
  unitPrice: number | null;
}

export function ReturnsSection() {
  const [items, setItems] = useState<StockItem[] | null>(null);
  // Issue #915 — a failed initial fetch must surface a retry, not an
  // endless skeleton.
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const load = useCallback(() => {
    setLoadError("");
    api<{ items: StockItem[] }>("/api/stock/items").then(({ ok, data }) => {
      if (ok) setItems(data.items);
      else setLoadError("دریافت فهرست کالاها ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  if (items === null) {
    if (loadError) {
      return (
        <SectionCard title="برگشت به تأمین‌کننده" bodyClassName="space-y-3">
          <p className="text-sm text-destructive" role="alert">{loadError}</p>
          <Button type="button" variant="outline" onClick={load}>
            تلاش دوباره
          </Button>
        </SectionCard>
      );
    }
    return <SectionCardSkeleton rows={4} />;
  }

  return (
    <div className="space-y-3">
      <ReturnForm
        items={items}
        onDone={(m) => {
          setDone(m);
          load();
        }}
        onError={setError}
      />
      <ErrorBox>{error}</ErrorBox>
      {done ? (
        <p className="text-xs text-emerald-700 dark:text-emerald-300">{done}</p>
      ) : null}
    </div>
  );
}

function ReturnForm({
  items,
  onDone,
  onError,
}: {
  items: StockItem[];
  onDone: (m: string) => void;
  onError: (m: string) => void;
}) {
  const [itemId, setItemId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  // Issue #795 — a serialized return names the exact physical unit (the
  // operator scans/types its serial number); quantity is always 1.
  const [serialNumber, setSerialNumber] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedItem = items.find((i) => i.id === itemId) ?? null;
  const isSerialItem = selectedItem?.tracking === "serial";

  async function submit() {
    if (busy) return;
    if (!itemId || !reason.trim()) return;
    if (isSerialItem && !serialNumber.trim()) {
      onError("برای برگشت کالای سریالی، شماره سریال دستگاه را وارد کنید.");
      return;
    }
    if (!isSerialItem && !quantity.trim()) return;
    setBusy(true);
    onError("");
    try {
      // Issue #915 — the stable request identity /api/stock/returns dedupes
      // on. Persisted (sessionStorage) under a fingerprint of the payload
      // until the outcome is known, so even a RELOAD between "request sent"
      // and "response seen" resubmits with the SAME key and the server
      // replays the original return instead of relieving stock twice. A
      // changed payload gets a fresh key (pending-idempotency.ts).
      const payload = {
        reason,
        lines: [
          isSerialItem
            ? { itemId, quantity: "1", serialNumber: serialNumber.trim() }
            : { itemId, quantity },
        ],
      };
      const idempotencyKey = pendingIdempotencyKey(window.sessionStorage, "stock.return", payload);
      const { ok, status, data } = await api<{ error?: string; message?: string }>(
        "/api/stock/returns",
        {
          method: "POST",
          body: JSON.stringify({ ...payload, idempotencyKey }),
        },
      );
      if (!ok) {
        // 409 = this key was already spent on a DIFFERENT payload (a stale
        // entry); drop it so the next attempt starts clean. Other failures
        // keep the key — a retry must replay, not double-post.
        if (status === 409) clearPendingIdempotencyKey(window.sessionStorage, "stock.return");
        onError(data.message ?? "ثبت برگشت ناموفق بود.");
      } else {
        clearPendingIdempotencyKey(window.sessionStorage, "stock.return");
        setItemId("");
        setQuantity("1");
        setSerialNumber("");
        setReason("");
        onDone("برگشت به تأمین‌کننده ثبت شد.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard title="برگشت به تأمین‌کننده" bodyClassName="space-y-3">
      <div className="grid gap-2">
        <Field label="کالا">
          <SearchableSelect
            value={itemId}
            onChange={setItemId}
            options={[
              { value: "", label: "انتخاب کنید…" },
              ...items.map((i) => ({
                value: i.id,
                label: i.name,
                searchString: `${i.name} ${i.sku ?? ""}`,
              })),
            ]}
            placeholder="انتخاب کنید…"
            searchPlaceholder="جستجوی کالا…"
            ariaLabel="انتخاب کالا برای برگشت"
          />
        </Field>
        {isSerialItem ? (
          <Field label="شماره سریال دستگاه" hint="برگشت کالای سریالی دستگاه‌به‌دستگاه است.">
            <input
              className={inputClass}
              dir="ltr"
              value={serialNumber}
              onChange={(e) => setSerialNumber(e.target.value)}
              placeholder="SN-…"
            />
          </Field>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <Field label="تعداد" hint={isSerialItem ? "برای کالای سریالی همیشه ۱ است." : undefined}>
            <PersianNumberInput
              inputMode="decimal"
              allowNegative={false}
              className={inputClass}
              dir="ltr"
              value={isSerialItem ? "1" : quantity}
              onChange={(e) => setQuantity(e.target.value)}
              disabled={isSerialItem}
            />
          </Field>
          <Field label="دلیل">
            <input
              className={inputClass}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </div>
        <Button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="min-h-11 w-full"
        >
          ثبت برگشت
        </Button>
      </div>
    </SectionCard>
  );
}
