"use client";

/**
 * «محتوا و تصاویر» — one storefront product's presentation, in the WP manager
 * (issue #1215, P1-2).
 *
 * The catalogue stays the read-only mirror it was: price, stock and identity
 * are Accounting's, and this screen does not touch them. What it adds is the
 * half the store owns — the two descriptions WordPress shows a shopper — and
 * it adds it the way the rest of this manager works:
 *
 *  - **The text on screen is the store's text.** It comes from the last read of
 *    the store, not from Accounting's copy of the product, so an owner editing
 *    here edits what their shopfront actually says.
 *  - **Nothing is saved by typing.** The editor keeps a draft; the draft
 *    reaches the store only when «اعمال» is pressed, and the confirmation says
 *    «در صف» because that is what happened — the change counts when the store
 *    acknowledges it, and the card's queue badge reports that.
 *  - **AI proposes, a human applies.** The generated draft lands in the field,
 *    never in the outbox. There is no automatic write anywhere in this file.
 *  - **Images are shown, not edited.** Attachment transport and the canonical
 *    per-store mapping are #941's work (see
 *    docs/integrations/woocommerce-price-stock-policy.md); until it lands,
 *    replacing a storefront image from here would be a lie about a copy.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ImageOffIcon } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";
import { FilterChip, FilterChipRow } from "@/app/dashboard/filters";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { formatPersianNumber } from "@/lib/digits";
import { PRODUCT_LONG_DESCRIPTION_MAX, PRODUCT_SHORT_DESCRIPTION_MAX } from "@/lib/product-content";
import { diffHasChanges, diffLines, type DiffLine } from "./description-diff";
import { formatDateTime } from "./format";
import { looksLikeHtml, storefrontText } from "./product-content-text";

type Tab = "text" | "images" | "preview" | "sync";

interface ContentImage {
  src: string;
  alt: string;
}

interface ContentProduct {
  remoteId: string;
  localId: string | null;
  name: string | null;
  sku: string | null;
  wooType: string | null;
  remoteStatus: string | null;
  shortDescription: string | null;
  description: string | null;
  image: ContentImage | null;
  gallery: ContentImage[];
  galleryCount: number | null;
  remoteModifiedAt: string | null;
  lastSeenAt: string | null;
  queue: {
    state: "idle" | "queued" | "failed";
    kinds: string[];
    pendingPatch: Record<string, unknown> | null;
    lastError: string | null;
    updatedAt: string | null;
    lastSentAt: string | null;
  } | null;
}

const TABS: { key: Tab; label: string }[] = [
  { key: "text", label: "متن فروشگاه" },
  { key: "images", label: "تصاویر و گالری" },
  { key: "preview", label: "پیش‌نمایش فروشگاه" },
  { key: "sync", label: "همگام‌سازی و تاریخچه" },
];

const QUEUE_KIND_LABELS: Record<string, string> = {
  stock: "موجودی",
  price: "قیمت",
  product_update: "ویرایش محصول",
};

export interface ProductContentSheetProps {
  connectionId: string;
  /** The WooCommerce product id, as the card shows it. */
  remoteId: string;
  /** The name the card already knows — shown while the read is in flight. */
  productName: string;
  /** The store is open for writes (not paused) and the member may edit it. */
  canWrite: boolean;
  /** The panel's request helper, so a queued edit speaks in the panel's own banner. */
  call: <T extends Record<string, unknown>>(
    path: string,
    method?: string,
    body?: unknown,
    options?: { successNotice?: string | null },
  ) => Promise<T | null>;
  /** Re-read the catalogue after an Apply, so the card's queue badge is current. */
  onQueued?: () => void;
  onClose: () => void;
}

export function ProductContentSheet({
  connectionId,
  remoteId,
  productName,
  canWrite,
  call,
  onQueued,
  onClose,
}: ProductContentSheetProps) {
  const [tab, setTab] = useState<Tab>("text");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [product, setProduct] = useState<ContentProduct | null>(null);
  const [shortDraft, setShortDraft] = useState("");
  const [longDraft, setLongDraft] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ shortDescription: string; longDescription: string; costRial: number | null } | null>(null);
  const [aiError, setAiError] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [applying, setApplying] = useState(false);
  const [leaveWarning, setLeaveWarning] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const result = await api<{ product: ContentProduct; canWrite: boolean; error?: string }>(
        `/api/integrations/connections/${connectionId}/store/products/${remoteId}`,
        { signal },
      );
      if (result.aborted) return;
      if (!result.ok || !result.data?.product) {
        setError(describeReadError(String(result.data?.error ?? "")));
        setLoading(false);
        return;
      }
      const next = result.data.product;
      setProduct(next);
      setShortDraft(next.shortDescription ?? "");
      setLongDraft(next.description ?? "");
      setError("");
      setLoading(false);
    },
    [connectionId, remoteId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const storeShort = product?.shortDescription ?? "";
  const storeLong = product?.description ?? "";
  const dirty = Boolean(product) && (shortDraft !== storeShort || longDraft !== storeLong);
  const shortDiff = useMemo<DiffLine[] | null>(() => (product ? diffLines(storeShort, shortDraft) : null), [product, storeShort, shortDraft]);
  const longDiff = useMemo<DiffLine[] | null>(() => (product ? diffLines(storeLong, longDraft) : null), [product, storeLong, longDraft]);
  const hasChanges = diffHasChanges(shortDiff) || diffHasChanges(longDiff);

  function dismiss() {
    if (dirty) {
      setLeaveWarning(true);
      return;
    }
    onClose();
  }

  async function apply() {
    if (!product || !hasChanges) return;
    setApplying(true);
    setError("");
    setNotice("");
    // The one write path every product edit already uses. An empty string is a
    // real instruction here — it clears the store's field — so both halves are
    // always sent, and each one is bounded exactly as the route bounds it.
    const fields: Record<string, string> = {
      short_description: shortDraft.slice(0, PRODUCT_SHORT_DESCRIPTION_MAX),
      description: longDraft.slice(0, PRODUCT_LONG_DESCRIPTION_MAX),
    };
    const result = await call<Record<string, unknown>>(
      `/api/integrations/connections/${connectionId}/store/products`,
      "POST",
      { remoteId, fields },
      { successNotice: null },
    );
    setApplying(false);
    if (!result) return;
    setNotice(
      "متن در صف ارسال به فروشگاه قرار گرفت. تا زمانی که سایت فروشگاه تأیید نکند، متن روی سایت تغییر نکرده است؛ وضعیت ارسال روی کارت محصول و در «صف و رویدادها» دیده می‌شود.",
    );
    setShowDiff(false);
    await load();
    onQueued?.();
  }

  async function generate() {
    setAiBusy(true);
    setAiError("");
    setAiDraft(null);
    const result = await api<{
      draft?: { shortDescription: string | null; longDescription: string | null };
      costRial?: number;
      error?: string;
      message?: string;
    }>(`/api/integrations/connections/${connectionId}/store/products/${remoteId}/ai`, {
      method: "POST",
      body: JSON.stringify({ shortDescription: shortDraft, description: longDraft }),
    });
    setAiBusy(false);
    if (!result.ok) {
      setAiError(describeAiError(String(result.data?.error ?? ""), result.data?.message));
      return;
    }
    setAiDraft({
      shortDescription: result.data?.draft?.shortDescription ?? "",
      longDescription: result.data?.draft?.longDescription ?? "",
      costRial: typeof result.data?.costRial === "number" ? result.data.costRial : null,
    });
  }

  const title = product?.name ?? productName;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>محتوا و تصاویر «{title}»</DialogTitle>
          <DialogDescription>
            متن و تصاویری که فروشگاه به مشتری نشان می‌دهد · شناسهٔ محصول در فروشگاه{" "}
            <span dir="ltr">#{remoteId}</span>
          </DialogDescription>
        </DialogHeader>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        <FilterChipRow label="بخش‌های محتوای محصول">
          {TABS.map((entry) => (
            <FilterChip key={entry.key} selected={tab === entry.key} onClick={() => setTab(entry.key)}>
              {entry.label}
            </FilterChip>
          ))}
        </FilterChipRow>

        {loading ? (
          <LoadingSkeleton label="خواندن محتوای محصول از فروشگاه" rows={3} />
        ) : !product ? null : (
          <>
            {tab === "text" ? (
              <div className="space-y-4">
                <p className="text-xs text-muted-foreground">
                  این متن، نسخهٔ خودِ فروشگاه است؛ با متن کالا در حسابداری یکی نیست و جدا نگه داشته می‌شود. انتشار
                  دوبارهٔ محصول از انبار، این دو فیلد را با متن حسابداری بازنویسی می‌کند.
                </p>
                <label className="block text-sm font-medium">
                  توضیح کوتاه فروشگاه
                  <textarea
                    aria-label="توضیح کوتاه فروشگاه"
                    className={inputClass}
                    rows={3}
                    maxLength={PRODUCT_SHORT_DESCRIPTION_MAX}
                    value={shortDraft}
                    disabled={!canWrite}
                    onChange={(event) => setShortDraft(event.target.value)}
                  />
                  <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                    {formatPersianNumber(shortDraft.length)} از {formatPersianNumber(PRODUCT_SHORT_DESCRIPTION_MAX)} نویسه
                  </span>
                </label>
                <label className="block text-sm font-medium">
                  توضیح بلند فروشگاه (HTML گوتنبرگ)
                  <textarea
                    aria-label="توضیح بلند فروشگاه"
                    className={`${inputClass} font-mono`}
                    dir="ltr"
                    rows={10}
                    maxLength={PRODUCT_LONG_DESCRIPTION_MAX}
                    value={longDraft}
                    disabled={!canWrite}
                    onChange={(event) => setLongDraft(event.target.value)}
                  />
                  <span className="mt-1 block text-[11px] font-normal text-muted-foreground">
                    {formatPersianNumber(longDraft.length)} از {formatPersianNumber(PRODUCT_LONG_DESCRIPTION_MAX)} نویسه ·
                    بلوک‌های گوتنبرگ دست‌نخورده می‌مانند؛ همین متن، بی‌کم‌وکاست به فروشگاه فرستاده می‌شود.
                  </span>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!canWrite || aiBusy}
                    onClick={() => void generate()}
                    aria-busy={aiBusy}
                  >
                    {aiBusy ? "در حال تولید…" : "تولید با هوش مصنوعی"}
                  </Button>
                  <Button type="button" variant="outline" disabled={!hasChanges} onClick={() => setShowDiff((value) => !value)}>
                    {showDiff ? "بستن پیش‌نمایش تغییرات" : "پیش‌نمایش تغییرات"}
                  </Button>
                  <Button type="button" disabled={!canWrite || !hasChanges || applying} onClick={() => void apply()}>
                    {applying ? "در حال ارسال…" : "اعمال در فروشگاه (صف ارسال)"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={!dirty}
                    onClick={() => {
                      setShortDraft(storeShort);
                      setLongDraft(storeLong);
                      setShowDiff(false);
                      setLeaveWarning(false);
                    }}
                  >
                    بازگردانی به متن فروشگاه
                  </Button>
                </div>

                {!canWrite ? (
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    این اتصال متوقف است؛ متن فروشگاه خواندنی است ولی تا فعال‌شدن اتصال تغییر نمی‌کند.
                  </p>
                ) : null}

                {aiError ? <ErrorBox>{aiError}</ErrorBox> : null}

                {aiDraft ? (
                  <div className="space-y-2 rounded-xl border border-border/70 bg-muted/40 p-3">
                    <p className="text-sm font-medium">پیشنهاد هوش مصنوعی — هنوز هیچ‌چیز ذخیره نشده است</p>
                    {aiDraft.costRial !== null ? (
                      <p className="text-[11px] text-muted-foreground">
                        هزینهٔ این درخواست: {formatPersianNumber(aiDraft.costRial)} ریال (از کیف پول هوش مصنوعی)
                      </p>
                    ) : null}
                    {aiDraft.shortDescription ? (
                      <div className="space-y-1">
                        <p className="text-xs font-medium">توضیح کوتاه پیشنهادی</p>
                        <p className="whitespace-pre-wrap text-xs leading-6">{aiDraft.shortDescription}</p>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => setShortDraft(aiDraft.shortDescription.slice(0, PRODUCT_SHORT_DESCRIPTION_MAX))}
                        >
                          گذاشتن در فیلد کوتاه
                        </Button>
                      </div>
                    ) : null}
                    {aiDraft.longDescription ? (
                      <div className="space-y-1">
                        <p className="text-xs font-medium">توضیح بلند پیشنهادی</p>
                        <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs leading-6">
                          {storefrontText(aiDraft.longDescription)}
                        </p>
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          onClick={() => setLongDraft(aiDraft.longDescription.slice(0, PRODUCT_LONG_DESCRIPTION_MAX))}
                        >
                          گذاشتن در فیلد بلند
                        </Button>
                      </div>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      گذاشتن در فیلد، فقط ویرایشگر را پر می‌کند؛ تا «اعمال در فروشگاه» را نزنید چیزی ارسال نمی‌شود.
                    </p>
                  </div>
                ) : null}

                {showDiff ? (
                  <div className="space-y-3">
                    <DiffBlock title="توضیح کوتاه" lines={shortDiff} />
                    <DiffBlock title="توضیح بلند" lines={longDiff} />
                  </div>
                ) : null}
              </div>
            ) : null}

            {tab === "images" ? (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  تصاویر همان چیزی است که فروشگاه در آخرین خوانش داشت. جایگزینی یا جابه‌جایی تصاویر از این صفحه هنوز
                  پشتیبانی نمی‌شود؛ آن کار به انتقال پیوست‌ها و نگاشت کتابخانهٔ اصلی وابسته است و تا آن زمان هیچ تغییری
                  اینجا ادعا نمی‌شود.
                </p>
                {product.image ? (
                  <figure className="space-y-1">
                    <img
                      src={product.image.src}
                      alt={product.image.alt || `تصویر اصلی ${title}`}
                      className="max-h-56 rounded-xl border border-border/60 object-contain"
                    />
                    <figcaption className="text-[11px] text-muted-foreground">
                      تصویر شاخص · متن جایگزین: {product.image.alt || "خالی (فروشگاه متنی برای این تصویر ندارد)"}
                    </figcaption>
                  </figure>
                ) : (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <ImageOffIcon aria-hidden="true" className="size-4" /> فروشگاه برای این محصول تصویری گزارش نکرده است.
                  </p>
                )}
                {product.gallery.length > 0 ? (
                  <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {product.gallery.map((image, index) => (
                      <li key={`${image.src}-${index}`} className="space-y-1">
                        <img
                          src={image.src}
                          alt={image.alt || `تصویر ${index + 2} ${title}`}
                          className="h-24 w-full rounded-lg border border-border/60 object-cover"
                        />
                        <p className="text-[10px] text-muted-foreground">
                          {formatPersianNumber(index + 2)} · {image.alt || "بدون متن جایگزین"}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {product.galleryCount !== null && product.galleryCount > product.gallery.length + 1 ? (
                  <p className="text-[11px] text-muted-foreground">
                    فروشگاه {formatPersianNumber(product.galleryCount)} تصویر دارد؛ آینهٔ همگام‌سازی فقط{" "}
                    {formatPersianNumber(product.gallery.length + 1)} تصویر نگه می‌دارد.
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === "preview" ? (
              <div className="space-y-3 rounded-xl border border-border/70 bg-card p-4">
                <p className="text-[11px] text-muted-foreground">
                  پیش‌نمایش از متنِ <b>در حال ویرایش</b> ساخته می‌شود، نه از متن ذخیره‌شده؛ پس آنچه پیش از «اعمال» می‌بینید
                  همان چیزی است که ارسال خواهد شد.
                </p>
                <div className="flex gap-3">
                  {product.image ? (
                    <img src={product.image.src} alt={product.image.alt || ""} className="size-24 rounded-lg border border-border/60 object-cover" />
                  ) : null}
                  <div className="min-w-0 space-y-1">
                    <p className="text-base font-semibold">{title}</p>
                    {product.sku ? (
                      <p className="text-[11px] text-muted-foreground" dir="ltr">
                        {product.sku}
                      </p>
                    ) : null}
                    <p className="whitespace-pre-wrap text-sm leading-6">
                      {storefrontText(shortDraft) || "بدون توضیح کوتاه"}
                    </p>
                  </div>
                </div>
                <div className="whitespace-pre-wrap border-t border-border/60 pt-3 text-sm leading-7">
                  {storefrontText(longDraft) || "بدون توضیح بلند"}
                </div>
                {looksLikeHtml(longDraft) ? (
                  <p className="text-[11px] text-muted-foreground">
                    متن بلند شامل نشانه‌گذاری HTML است؛ پیش‌نمایش فقط متن خواندنی را نشان می‌دهد و هنگام ارسال، همان HTML
                    فرستاده می‌شود.
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === "sync" ? (
              <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <Field label="وضعیت در فروشگاه" value={product.remoteStatus ?? "نامشخص"} />
                <Field label="نوع محصول" value={product.wooType ?? "نامشخص"} />
                <Field label="کالای حسابداری" value={product.localId ? "نگاشت‌شده" : "نگاشت نشده"} />
                <Field label="آخرین تغییر در وردپرس" value={formatDateTime(product.remoteModifiedAt)} />
                <Field label="آخرین خوانش در این آینه" value={formatDateTime(product.lastSeenAt)} />
                <Field
                  label="وضعیت صف ارسال"
                  value={
                    product.queue
                      ? product.queue.kinds.map((kind) => QUEUE_KIND_LABELS[kind] ?? kind).join("، ") +
                        (product.queue.state === "failed" ? " (ارسال ناموفق)" : " (در صف)")
                      : "چیزی در صف نیست"
                  }
                />
                {product.queue?.lastError ? (
                  <div className="sm:col-span-2 rounded-lg border border-destructive/25 bg-destructive/5 p-2 text-destructive">
                    <p className="font-medium">آخرین خطای ارسال</p>
                    <p className="break-words" dir="ltr">
                      {product.queue.lastError}
                    </p>
                  </div>
                ) : null}
                {product.queue?.pendingPatch ? (
                  <div className="sm:col-span-2">
                    <p className="text-muted-foreground">تغییراتی که هنوز به فروشگاه نرسیده</p>
                    <ul className="mt-1 space-y-0.5">
                      {Object.keys(product.queue.pendingPatch).map((key) => (
                        <li key={key} className="text-foreground" dir="ltr">
                          {key}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {product.queue?.lastSentAt ? (
                  <Field label="آخرین ارسال تأییدشده" value={formatDateTime(product.queue.lastSentAt)} />
                ) : null}
                <div className="sm:col-span-2">
                  <Link
                    className="text-primary underline-offset-4 hover:underline"
                    href={`/websites/wp/queue?store=${connectionId}`}
                  >
                    دیدن این ارسال‌ها در «صف و رویدادها»
                  </Link>
                </div>
              </dl>
            ) : null}
          </>
        )}

        {leaveWarning ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200">
            <p>تغییرهای ذخیره‌نشده دارید. بستن این پنجره آن‌ها را دور می‌ریزد.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="xs" variant="outline" onClick={() => setLeaveWarning(false)}>
                بازگشت به ویرایش
              </Button>
              <Button type="button" size="xs" variant="ghost" onClick={onClose}>
                بستن بدون ذخیره
              </Button>
            </div>
          </div>
        ) : null}

        <div className="flex justify-end">
          <Button type="button" variant="outline" onClick={dismiss}>
            بستن پنجره
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-2.5 py-1.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium text-foreground">{value}</dd>
    </div>
  );
}

function DiffBlock({ title, lines }: { title: string; lines: DiffLine[] | null }) {
  const changed = lines?.filter((line) => line.kind !== "same") ?? [];
  return (
    <div className="rounded-xl border border-border/70 p-3">
      <p className="text-xs font-medium">{title}</p>
      {lines === null ? (
        <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
          این متن برای مقایسهٔ خط‌به‌خط بسیار بلند است؛ تغییرها بدون این پیش‌نمایش هم با «اعمال» فرستاده می‌شوند.
        </p>
      ) : changed.length === 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">تغییری در این فیلد نیست.</p>
      ) : (
        <ul className="mt-1 space-y-0.5 text-[11px] leading-5" dir="ltr">
          {changed.slice(0, 60).map((line, index) => (
            <li
              key={`${line.kind}-${index}`}
              className={
                line.kind === "added"
                  ? "whitespace-pre-wrap break-words text-emerald-800 dark:text-emerald-300"
                  : "whitespace-pre-wrap break-words text-destructive line-through"
              }
            >
              {line.kind === "added" ? "+ " : "− "}
              {line.text || "(سطر خالی)"}
            </li>
          ))}
          {changed.length > 60 ? <li className="text-muted-foreground">… و {formatPersianNumber(changed.length - 60)} خط دیگر</li> : null}
        </ul>
      )}
    </div>
  );
}

/** The read's failure codes, in the store's own vocabulary. */
function describeReadError(code: string): string {
  switch (code) {
    case "product_not_mapped":
      return "این محصول به هیچ کالایی در حسابداری نگاشت نشده است؛ متنی برای ویرایش اینجا ثبت نشده.";
    case "invalid_remote_id":
      return "شناسهٔ محصول در فروشگاه معتبر نیست.";
    case "not_found":
      return "این فروشگاه پیدا نشد یا حذف شده است.";
    default:
      return "خواندن محتوای این محصول از فروشگاه ناموفق بود.";
  }
}

/** The AI route's refusals, said plainly (never a raw code). */
function describeAiError(code: string, message?: string): string {
  switch (code) {
    case "ai_unavailable":
      return "سرویس هوش مصنوعی هنوز آماده نیست؛ متن را دستی بنویسید.";
    case "ai_credit_required":
      return "اعتبار کیف پول هوش مصنوعی کافی نیست.";
    case "connection_paused":
      return "اتصال این فروشگاه متوقف است؛ تا فعال‌شدن آن، متنی تولید نمی‌شود.";
    case "product_name_unavailable":
      return "نام این محصول در دسترس نیست؛ متن را دستی بنویسید.";
    case "ai_failed":
      return "تولید متن ناموفق بود. دوباره تلاش کنید یا متن را دستی بنویسید.";
    default:
      return message || "تولید متن با هوش مصنوعی ناموفق بود.";
  }
}
