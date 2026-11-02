"use client";

/**
 * Issue #1207 §A — the store control on one product row, named truthfully.
 *
 * There used to be one control for every row, «انتشار / پیوند فروشگاه». It was
 * wrong twice over: a row already linked to a store is not being published, and
 * nothing here is automatic — the click opens a review, the review queues a
 * change, and the store's acknowledgement is what links or updates anything.
 * Automatic stock/price sync is a separate asynchronous path and needs no click.
 *
 * So the control is derived from the row's own state (`productRowAction`):
 *
 *  - linked anywhere ⇒ «به‌روزرسانی دستی» — a manual review-and-send;
 *  - linked nowhere ⇒ «انتشار در فروشگاه», with «پیوند به محصول موجود» as the
 *    optional alternative so an existing store product is linked rather than
 *    duplicated;
 *  - a probable duplicate with no mapping ⇒ «بررسی محصول تکراری», which opens
 *    the review instead of creating a third twin.
 *
 * With several stores connected each store's own link/delivery status is shown
 * and the selected store is what decides create / link / update, exactly as the
 * server already did behind `previewProductPublication`. Nothing is mapped until
 * the store acknowledges the queued work.
 *
 * The trigger and the expanded review are two components because the list puts
 * the trigger in the row's action cell and the review in the row's expandable
 * area; both read the same derived action.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { LoadingSkeleton, StatusBadge } from "../page-chrome";
import { useMoney } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import type { ProductWooLink } from "@/lib/integrations/product-links-service";
import {
  STORE_LINK_STATE_LABEL,
  STORE_LINK_STATE_TONE,
  productRowAction,
  storeLinkState,
} from "@/lib/product-row-actions";

interface Preview {
  connectionId: string;
  storeName: string;
  name: string;
  action: string;
  reviewToken: string;
  payload: Record<string, unknown>;
}

const PREVIEW_ACTION_LABEL: Record<string, string> = {
  create: "ساخت محصول تازه",
  link: "پیوند بدون تغییر محتوا",
  update: "به‌روزرسانی دستی محصول",
};

type LinkSlice = Pick<ProductWooLink, "connectionId" | "storeName" | "remoteId" | "connectionStatus" | "lastOutboundStatus">;

/**
 * The row's one store control. It opens the review; it never sends anything by
 * being rendered, and it says which of the three actions it is.
 */
export function ProductStoreActionButton({
  links,
  duplicate,
  open,
  controls,
  onToggle,
  onReviewDuplicate,
}: {
  links: readonly LinkSlice[];
  duplicate: boolean;
  open: boolean;
  /** The id of the expanded review this button opens. */
  controls: string;
  onToggle: () => void;
  onReviewDuplicate: () => void;
}) {
  const action = productRowAction({ links, duplicate });
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="min-h-8 whitespace-nowrap px-2 text-xs"
      aria-expanded={action.kind === "review_duplicate" ? undefined : open}
      aria-controls={action.kind === "review_duplicate" ? undefined : controls}
      onClick={action.kind === "review_duplicate" ? onReviewDuplicate : onToggle}
    >
      {action.label}
    </Button>
  );
}

/**
 * The review itself: pick the store(s), see exactly what would be sent, then
 * confirm. A confirmation only queues work — the copy says so, and the row's
 * badge stays «در صف ارسال» until the store acknowledges.
 */
export function ProductPublicationPanel({
  localId,
  links,
  duplicate,
  open,
  onQueued,
}: {
  localId: string;
  links: readonly LinkSlice[];
  duplicate: boolean;
  open: boolean;
  /** Fired after the queue accepts the reviewed change, so badges refresh. */
  onQueued: () => void;
}) {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storesLoading, setStoresLoading] = useState(true);
  const [storesError, setStoresError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [remoteId, setRemoteId] = useState("");
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const money = useMoney();
  const rowAction = productRowAction({ links, duplicate });
  const linkByConnection = new Map(links.map((link) => [link.connectionId, link]));

  useEffect(() => {
    if (!open) {
      // A review that was superseded by closing the panel must not be
      // confirmable later: the token would still be valid, the reader's view of
      // it is gone.
      setPreviews([]);
      setNotice("");
      return;
    }
    let cancelled = false;
    setStoresError("");
    setStoresLoading(true);
    void api<{ stores?: { id: string; name: string }[]; error?: string }>("/api/products/publications").then((result) => {
      if (cancelled) return;
      setStoresLoading(false);
      if (!result.ok) {
        setStoresError("اجازهٔ مدیریت اتصال یا دریافت فروشگاه‌ها در دسترس نیست.");
        return;
      }
      setStores(Array.isArray(result.data.stores) ? result.data.stores : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function submit(confirm: boolean) {
    setBusy(true);
    setError("");
    setNotice("");
    const result = await api<{ previews?: Preview[]; error?: string }>("/api/products/publications", {
      method: "POST",
      body: JSON.stringify({
        localId,
        confirm,
        stores: selected.map((connectionId) => ({
          connectionId,
          ...(remoteId ? { remoteId } : {}),
          ...(confirm ? { reviewToken: previews.find((preview) => preview.connectionId === connectionId)?.reviewToken } : {}),
        })),
      }),
    });
    setBusy(false);
    if (!result.ok) {
      setPreviews([]);
      setError(
        `ارسال انجام نشد؛ قیمت فروش، نگاشت ویژگی‌ها، وضعیت اتصال و تازه بودن بازبینی را بررسی کنید. (${result.data.error ?? "خطای ارتباط"})`,
      );
      return;
    }
    if (confirm) {
      setPreviews([]);
      setNotice(
        "در صف ارسال قرار گرفت. پیوند نهایی فقط پس از تأیید فروشگاه ثبت می‌شود؛ تا آن زمان وضعیت این ردیف «در صف ارسال» است.",
      );
      onQueued();
      return;
    }
    setPreviews(result.data.previews ?? []);
  }

  if (!open) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-sm font-semibold text-amber-950 dark:text-amber-200">{rowAction.label}</p>
        <p className="text-[11px] text-muted-foreground">{rowAction.hint}</p>
      </div>
      <ErrorBox>{storesError}</ErrorBox>
      {storesLoading ? <LoadingSkeleton rows={2} label="در حال خواندن فروشگاه‌ها" /> : null}
      {!storesLoading && stores.length === 0 && !storesError ? (
        <p className="text-sm text-muted-foreground">فروشگاه فعال در این شعبه وجود ندارد.</p>
      ) : null}
      {stores.map((store) => {
        const link = linkByConnection.get(store.id);
        const state = link ? storeLinkState(link) : null;
        return (
          <label key={store.id} className="flex flex-wrap items-center gap-2 text-sm">
            <input
              type="checkbox"
              disabled={busy}
              checked={selected.includes(store.id)}
              onChange={(event) => {
                setSelected((ids) => (event.target.checked ? [...ids, store.id] : ids.filter((id) => id !== store.id)));
                setRemoteId("");
                setPreviews([]);
                setNotice("");
              }}
            />
            <span>{store.name}</span>
            {state ? (
              <StatusBadge tone={STORE_LINK_STATE_TONE[state]}>{STORE_LINK_STATE_LABEL[state]}</StatusBadge>
            ) : (
              <StatusBadge tone="neutral">بدون پیوند</StatusBadge>
            )}
            <span className="text-[11px] text-muted-foreground">
              {link
                ? `به‌روزرسانی دستی محصول ووکامرس #${toPersianDigits(link.remoteId)}`
                : "محصولی از این ردیف در این فروشگاه نیست: انتشار تازه، یا پیوند به محصول موجود"}
            </span>
          </label>
        );
      })}
      {stores.length > 0 ? (
        <Field
          label="پیوند به محصول موجود — شناسهٔ محصول فروشگاه (اختیاری)"
          hint="اگر همان محصول از قبل در فروشگاه هست، شناسهٔ آن را وارد کنید تا به‌جای ساخت ردیف تازه پیوند شود. برای پیوند، فقط یک فروشگاه را انتخاب کنید."
        >
          <input
            className={inputClass}
            aria-label="شناسهٔ محصول فروشگاه برای پیوند"
            value={remoteId}
            inputMode="numeric"
            disabled={busy || selected.length !== 1}
            onChange={(event) => {
              setRemoteId(event.target.value);
              setPreviews([]);
            }}
          />
        </Field>
      ) : null}
      {previews.map((preview) => (
        <div key={preview.connectionId} className="space-y-1 text-sm">
          <p>
            {preview.storeName} · {preview.name} · {PREVIEW_ACTION_LABEL[preview.action] ?? preview.action}
          </p>
          <p className="text-xs text-muted-foreground">
            {String(preview.payload.sku)} ·{" "}
            {preview.payload.status === "publish"
              ? "منتشرشده"
              : preview.payload.status === "private"
                ? "خصوصی"
                : "پیش‌نویس"}{" "}
            ·{" "}
            {preview.payload.__children
              ? `خانواده با ${toPersianDigits((preview.payload.__children as unknown[]).length)} تنوع`
              : "محصول ساده"}
          </p>
          {[preview.payload, ...((preview.payload.__children ?? []) as Record<string, unknown>[])].map(
            (product, index) => (
              <div key={index} className="space-y-1 text-xs text-muted-foreground">
                <p>
                  {String(product.name)} · {String(product.sku)}{" "}
                  {product.__priceRial ? `· ${money.formatText(String(product.__priceRial))}` : ""}
                </p>
                {((product.attributes ?? []) as { id: number; option?: string; options?: string[] }[]).map(
                  (attribute) => (
                    <p key={attribute.id}>
                      ویژگی {toPersianDigits(attribute.id)}: {attribute.option ?? attribute.options?.join("، ")}
                    </p>
                  ),
                )}
              </div>
            ),
          )}
          <p className="text-xs text-muted-foreground">{String(preview.payload.description ?? "")}</p>
          <p className="text-xs text-muted-foreground">
            قیمت و ویژگی‌ها فقط در محدودهٔ اختیارات تأییدشدهٔ همین اتصال ارسال می‌شوند.
          </p>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="min-h-9 text-xs"
          disabled={busy || selected.length === 0}
          onClick={() => void submit(previews.length > 0)}
        >
          {busy
            ? "در حال بررسی…"
            : previews.length
              ? "تأیید و ارسال موارد بازبینی‌شده"
              : rowAction.kind === "manual_update"
                ? "بازبینی به‌روزرسانی دستی"
                : "بازبینی انتشار / پیوند"}
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
      {notice ? (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
