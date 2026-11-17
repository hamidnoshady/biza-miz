"use client";

/**
 * ESH-147 (#1305) — the staff side of a table's printed QR.
 *
 * Lives inside the floor plan's table panel. It renders the QR from the
 * server, never from a token in the browser: the only JSON this component
 * receives is the masked prefix and the scan target, so a screenshot or a
 * copied response cannot be turned into an order.
 *
 * Everything here is gated by the same capabilities as the API — view/download
 * with `tables.manage`, generate/rotate/revoke with `tables.edit` — so a
 * waiter can reprint a table's QR but cannot invalidate every print in the
 * café by accident.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PrimaryButton, SecondaryButton, api, errorMessage } from "../ui";
import { LoadingSkeleton, cardClass } from "../page-chrome";

interface QrState {
  prefix: string;
  siteConnected: boolean;
  menuUrl: string | null;
  createdAt: string;
  createdBy: string | null;
  rotatedFromPrefix: string | null;
}

export function TableQrPanel({
  tableId,
  tableName,
  canManage,
  onChanged,
  setError,
}: {
  tableId: string;
  tableName: string;
  canManage: boolean;
  onChanged?: () => void;
  setError: (message: string) => void;
}) {
  const [qr, setQr] = useState<QrState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);

  const load = useCallback(async () => {
    const res = await api<{ qr: QrState | null; error?: string }>(
      `/api/tables/${tableId}/qr`,
    );
    if (res.aborted) return;
    if (!res.ok) {
      setError(errorMessage(res.data.error) || "دریافت QR میز ناموفق بود.");
      setLoaded(true);
      return;
    }
    setQr(res.data.qr ?? null);
    setLoaded(true);
  }, [tableId, setError]);

  useEffect(() => {
    setLoaded(false);
    setQr(null);
    void load();
  }, [load]);

  async function act(method: "POST" | "DELETE", url: string, successText: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api<{ qr?: QrState; error?: string; revoked?: boolean }>(url, {
        method,
      });
      if (!res.ok) {
        setError(errorMessage(res.data.error) || "عملیات QR میز ناموفق بود.");
        return;
      }
      if (res.data.qr) setQr(res.data.qr);
      else setQr(null);
      setImageVersion((v) => v + 1);
      toast.success(successText);
      onChanged?.();
    } finally {
      setBusy(false);
    }
  }

  // Reserve the panel's shape while the first read is in flight, per the
  // loading-coverage rule (docs/design-system.md §Charts and loading).
  if (!loaded) return <LoadingSkeleton rows={2} label="در حال بررسی QR میز" />;

  if (!qr) {
    return (
      <div className={`${cardClass} space-y-2 p-3`}>
        <div className="text-sm font-semibold text-foreground">QR سفارش میز</div>
        <p className="text-xs text-muted-foreground">
          برای این میز هنوز QR ساخته نشده است. مشتری با اسکن آن، منوی کافه را روی
          همین میز باز می‌کند.
        </p>
        {canManage ? (
          <PrimaryButton
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                "POST",
                `/api/tables/${tableId}/qr`,
                "QR میز ساخته شد.",
              )
            }
          >
            ساخت QR میز
          </PrimaryButton>
        ) : null}
      </div>
    );
  }

  const imageUrl = `/api/tables/${tableId}/qr/image?format=png&v=${imageVersion}`;
  const downloadUrl = `/api/tables/${tableId}/qr/image?format=png&download=1&v=${imageVersion}`;
  const svgUrl = `/api/tables/${tableId}/qr/image?format=svg&download=1&v=${imageVersion}`;

  return (
    <div className={`${cardClass} space-y-3 p-3`}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-foreground">QR سفارش میز</div>
        <span className="font-mono text-xs text-muted-foreground" dir="ltr">
          {qr.prefix}…
        </span>
      </div>

      {qr.siteConnected ? (
        <img
          src={imageUrl}
          alt={`QR سفارش ${tableName}`}
          width={220}
          height={220}
          className="mx-auto rounded-xl border border-border p-2"
          style={{ backgroundColor: "#ffffff" }}
        />
      ) : (
        <p className="rounded-lg bg-muted/60 p-2 text-xs text-muted-foreground">
          برای ساخت QR لازم است یک سایت فعال در «مدیریت وب‌سایت» متصل باشد؛
          بدون آن، اسکن QR به جایی نمی‌رسد.
        </p>
      )}

      {qr.menuUrl ? (
        <p className="break-all text-xs text-muted-foreground" dir="ltr">
          {qr.menuUrl}
        </p>
      ) : null}

      {qr.siteConnected ? (
        <div className="flex flex-wrap gap-2">
          <a
            href={downloadUrl}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          >
            دانلود PNG
          </a>
          <a
            href={svgUrl}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted"
          >
            دانلود SVG
          </a>
        </div>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">
          <SecondaryButton
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  "با چرخش QR، همهٔ نسخه‌های چاپ‌شدهٔ قبلی از کار می‌افتند. ادامه می‌دهید؟",
                )
              ) {
                return;
              }
              void act(
                "POST",
                `/api/tables/${tableId}/qr/rotate`,
                "QR میز چرخید؛ نسخهٔ قبلی دیگر کار نمی‌کند.",
              );
            }}
          >
            چرخش QR
          </SecondaryButton>
          <SecondaryButton
            type="button"
            disabled={busy}
            onClick={() => {
              if (!window.confirm("QR این میز باطل شود؟")) return;
              void act("DELETE", `/api/tables/${tableId}/qr`, "QR میز باطل شد.");
            }}
          >
            ابطال QR
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
}
