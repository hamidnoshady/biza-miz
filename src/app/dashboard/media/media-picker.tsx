"use client";

/**
 * The shared cross-app picker & field primitives over «کتابخانهٔ رسانه»
 * (`media_assets` singleton library per tenant).
 *
 * Powers menu items, inventory items, parties, retail products (main cover,
 * multi-select gallery, per-variant image), and opens the canonical `/media`
 * `AssetDrawer` directly when `allowEdit` is enabled so crop/rotate/resize,
 * AI actions (`enhance`, `bg-remove`, `upscale`, `variations`), and non-destructive
 * version lineage ("استفاده از این نسخه") share ONE single implementation.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { MAX_PRODUCT_GALLERY_MEDIA } from "@/lib/product-input";
import { uploadFiles, type UploadProgressEvent } from "@/lib/media-uploader";
import type { MediaKind } from "@/lib/media";
import { AssetDrawer, type AssetRow } from "./media-manager";
import { cardClass, EmptyState, LoadingSkeleton } from "../page-chrome";
import { api, ErrorBox, InfoBox, inputClass } from "../ui";

const PAGE_SIZE = 40;
const ACCEPTED_FILE_TYPES: Record<MediaKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/webm,video/quicktime",
  document: ".pdf,.xlsx,.docx,.csv,.txt,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/csv,text/plain",
};

const UPLOAD_STATUS_LABELS: Record<UploadProgressEvent["status"], string> = {
  queued: "در صف",
  uploading: "در حال بارگذاری…",
  retrying: "تلاش دوباره…",
  success: "انجام شد",
  error: "ناموفق",
  canceled: "لغو شد",
};

export interface PickedMedia {
  id: string;
  fileName: string;
}

export function mediaFileUrl(id: string): string {
  return `/api/media/${id}/file`;
}

export function MediaPickerDialog({
  title,
  onPick,
  onPickMultiple,
  onClose,
  kind = "image",
  canUpload = true,
  multiple = false,
  initialSelectedIds = [],
  maxSelect = MAX_PRODUCT_GALLERY_MEDIA,
  allowEdit = false,
}: {
  title: string;
  onPick?: (asset: PickedMedia) => void;
  onPickMultiple?: (assets: PickedMedia[]) => void;
  onClose: () => void;
  kind?: MediaKind;
  canUpload?: boolean;
  multiple?: boolean;
  initialSelectedIds?: string[];
  maxSelect?: number;
  allowEdit?: boolean;
}) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [enhancePriceRial, setEnhancePriceRial] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [storageReady, setStorageReady] = useState(true);
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const [uploadEvents, setUploadEvents] = useState<UploadProgressEvent[]>([]);
  const [editingAsset, setEditingAsset] = useState<AssetRow | null>(null);
  const [multiSelected, setMultiSelected] = useState<Map<string, string>>(
    () => new Map(initialSelectedIds.map((id) => [id, id])),
  );

  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uploadCancelRef = useRef<(() => void) | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(
    (offset: number, append: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);

      const params = new URLSearchParams({
        kind,
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      // Server-side MIME exclusion keeps COUNT(*) OVER() and page size exact (issue #926 P2.11).
      if (kind === "image") params.set("excludeMime", "image/svg+xml");
      if (search) params.set("search", search);

      api<{
        assets: AssetRow[];
        total: number;
        storage: { ready: boolean; enhancePriceRial?: number };
      }>(`/api/media?${params.toString()}`, { signal: controller.signal }).then(({ ok, data, aborted }) => {
        if (aborted || requestId !== requestRef.current) return;
        setLoadingMore(false);
        if (!ok) {
          setError("خواندن کتابخانهٔ رسانه ناموفق بود.");
          return;
        }
        setError("");
        const usable = data.assets.filter((asset) => kind !== "image" || asset.mimeType !== "image/svg+xml");
        setAssets((current) => (append && current ? [...current, ...usable] : usable));
        setTotal(data.total);
        setStorageReady(data.storage.ready);
        if (typeof data.storage.enhancePriceRial === "number") {
          setEnhancePriceRial(data.storage.enhancePriceRial);
        }
      });
    },
    [search, kind],
  );

  useEffect(() => {
    load(0, false);
    return () => {
      abortRef.current?.abort();
      uploadCancelRef.current?.();
    };
  }, [load]);

  function toggleMulti(asset: PickedMedia) {
    setMultiSelected((current) => {
      const next = new Map(current);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else if (next.size < maxSelect) {
        next.set(asset.id, asset.fileName);
      }
      return next;
    });
  }

  function confirmMulti() {
    if (!onPickMultiple) return;
    const picked = Array.from(multiSelected.entries()).map(([id, fileName]) => ({ id, fileName }));
    onPickMultiple(picked);
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = multiple ? Array.from(files).slice(0, maxSelect) : [files[0]];
    setBusy(true);
    setError("");
    setNotice("");
    setUploadEvents(
      list.map((file, index) => ({
        id: `${index}:${file.name}:${file.size}:${file.lastModified}`,
        file,
        status: "queued",
        attempt: 0,
      })),
    );
    const { done, cancel } = uploadFiles(list, {
      onProgress: (event) => {
        setUploadEvents((current) => {
          const next = current.filter((item) => item.id !== event.id);
          next.push(event);
          return next;
        });
      },
    });
    uploadCancelRef.current = cancel;
    const results = await done;
    uploadCancelRef.current = null;
    setBusy(false);

    const succeeded = results.filter(
      (r): r is UploadProgressEvent & { asset: NonNullable<UploadProgressEvent["asset"]> } =>
        r.status === "success" && Boolean(r.asset),
    );
    const firstError = results.find((r) => r.status === "error");
    if (firstError) {
      setError(firstError.message ?? "بارگذاری ناموفق بود.");
    }
    if (succeeded.length === 0) return;

    if (multiple) {
      setMultiSelected((current) => {
        const next = new Map(current);
        for (const item of succeeded) {
          if (next.size < maxSelect) next.set(item.asset.id, item.asset.fileName);
        }
        return next;
      });
      if (succeeded.some((r) => r.asset.duplicate)) {
        setNotice("موارد تکراری از کتابخانهٔ موجود بازاستفاده و انتخاب شدند.");
      } else {
        setNotice(`${toPersianDigits(succeeded.length)} تصویر بارگذاری و به انتخاب اضافه شد.`);
      }
      load(0, false);
      return;
    }

    const first = succeeded[0];
    if (first.asset.duplicate) setNotice("این تصویر از قبل در کتابخانه بود؛ همان انتخاب شد.");
    onPick?.({ id: first.asset.id, fileName: first.asset.fileName });
  }

  const dialogTitleId = useId();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !editingAsset) {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingAsset, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogTitleId}
    >
      <div className={`${cardClass} max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={dialogTitleId} className="text-base font-semibold">{title}</h2>
          <div className="flex items-center gap-2">
            {multiple ? (
              <Button type="button" size="sm" onClick={confirmMulti}>
                تأیید انتخاب ({toPersianDigits(multiSelected.size)})
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>
              بستن
            </Button>
          </div>
        </div>

        {!isOnline ? (
          <InfoBox>
            اتصال اینترنت برقرار نیست؛ بارگذاری جدید و ویرایش هوش مصنوعی غیرفعال است اما ثبت محصول بدون تصویر همواره فعال می‌ماند.
          </InfoBox>
        ) : null}
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <p className="mb-3 text-xs text-muted-foreground">{notice}</p> : null}

        {uploadEvents.length > 0 ? (
          <div className="mb-3 rounded-xl border border-border bg-muted/40 p-2.5 text-xs space-y-1">
            {uploadEvents.map((ev) => (
              <div key={ev.id} className="flex items-center justify-between gap-2">
                <span className="truncate">{ev.file.name}</span>
                <span className={ev.status === "error" ? "text-destructive" : "text-muted-foreground"}>
                  {UPLOAD_STATUS_LABELS[ev.status]}
                </span>
              </div>
            ))}
            {busy ? (
              <div className="pt-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => uploadCancelRef.current?.()}
                >
                  لغو بارگذاری
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mb-4 flex gap-2">
          <input
            className={inputClass}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="جست‌وجو در تصاویر کتابخانه…"
          />
          {canUpload ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || !storageReady || !isOnline}
                onClick={() => fileInput.current?.click()}
              >
                {busy ? "در حال بارگذاری…" : kind === "image" ? "بارگذاری تصویر" : "بارگذاری فایل"}
              </Button>
              <input
                ref={fileInput}
                type="file"
                multiple={multiple}
                accept={ACCEPTED_FILE_TYPES[kind]}
                className="hidden"
                onChange={(e) => {
                  void upload(e.target.files);
                  e.target.value = "";
                }}
              />
            </>
          ) : null}
        </div>

        {!storageReady ? (
          <EmptyState>فضای ذخیره‌سازی رسانه هنوز توسط مدیر پلتفرم پیکربندی نشده است.</EmptyState>
        ) : assets === null ? (
          <LoadingSkeleton rows={4} />
        ) : assets.length === 0 ? (
          search ? (
            <EmptyState>تصویری با این جست‌وجو پیدا نشد.</EmptyState>
          ) : (
            <EmptyState>تصویری در کتابخانه نیست؛ با «بارگذاری تصویر» اولین تصویر را اضافه کنید.</EmptyState>
          )
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {assets.map((asset) => {
                const isSelected = multiSelected.has(asset.id);
                return (
                  <div
                    key={asset.id}
                    className={`group flex flex-col overflow-hidden rounded-xl border transition-colors ${
                      isSelected ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-ring"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (multiple) toggleMulti({ id: asset.id, fileName: asset.fileName });
                        else onPick?.({ id: asset.id, fileName: asset.fileName });
                      }}
                      className="flex flex-1 flex-col text-start"
                      title={asset.fileName}
                    >
                      <span className="relative flex aspect-square w-full items-center justify-center overflow-hidden bg-muted">
                        {asset.mimeType.startsWith("image/") ? (
                          <img src={mediaFileUrl(asset.id)} alt={asset.fileName} loading="lazy" className="size-full object-cover" />
                        ) : asset.mimeType.startsWith("video/") ? (
                          <video src={mediaFileUrl(asset.id)} aria-label={asset.fileName} muted preload="metadata" className="size-full object-cover" />
                        ) : (
                          <span aria-hidden="true" className="text-3xl">📄</span>
                        )}
                        {multiple && isSelected ? (
                          <span className="absolute end-1.5 top-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-bold text-primary-foreground">
                            ✓
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground">{asset.fileName}</span>
                    </button>
                    {allowEdit && asset.kind === "image" && asset.mimeType !== "image/svg+xml" ? (
                      <button
                        type="button"
                        onClick={() => setEditingAsset(asset)}
                        className="border-t border-border px-1.5 py-1 text-center text-[11px] font-medium text-primary hover:bg-muted"
                      >
                        ویرایش / هوش مصنوعی
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {assets.length < total ? (
              <div className="mt-3 flex justify-center">
                <Button type="button" variant="outline" size="sm" disabled={loadingMore} onClick={() => load(assets.length, true)}>
                  {loadingMore ? "در حال بارگذاری…" : `نمایش بیشتر (${toPersianDigits(total - assets.length)} مورد دیگر)`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {editingAsset ? (
        <AssetDrawer
          asset={editingAsset}
          folders={[]}
          collections={[]}
          enhancePriceRial={enhancePriceRial}
          onClose={() => setEditingAsset(null)}
          onUpdated={(updated) => {
            setEditingAsset(updated);
            load(0, false);
          }}
          onDeleted={() => {
            setEditingAsset(null);
            load(0, false);
          }}
          onUseAsset={(picked) => {
            setEditingAsset(null);
            if (multiple) {
              setMultiSelected((current) => {
                const next = new Map(current);
                if (next.size < maxSelect) next.set(picked.id, picked.fileName);
                return next;
              });
              load(0, false);
            } else {
              onPick?.(picked);
            }
          }}
        />
      ) : null}
    </div>
  );
}

async function fetchSingleAssetForEdit(
  assetId: string,
): Promise<{ asset: AssetRow | null; enhancePriceRial: number }> {
  const direct = await api<{
    asset?: AssetRow;
    enhancePriceRial?: number;
  }>(`/api/media/${assetId}`);
  if (direct.ok && direct.data.asset) {
    return {
      asset: direct.data.asset,
      enhancePriceRial: direct.data.enhancePriceRial ?? 0,
    };
  }
  const { ok, data } = await api<{
    assets: AssetRow[];
    storage: { enhancePriceRial?: number };
  }>(`/api/media?folderId=any&kind=image&limit=60`);
  if (!ok) return { asset: null, enhancePriceRial: 0 };
  const match = data.assets.find((a) => a.id === assetId) ?? null;
  if (match) {
    return { asset: match, enhancePriceRial: data.storage.enhancePriceRial ?? 0 };
  }
  return {
    asset: {
      id: assetId,
      folderId: null,
      kind: "image",
      fileName: "تصویر انتخاب‌شده",
      mimeType: "image/jpeg",
      byteSize: 0,
      category: null,
      tags: [],
      aiStatus: "none",
      aiLabels: {},
      variant: "original",
      sourceAssetId: null,
      source: "upload",
      createdByAi: false,
      createdAt: new Date().toISOString(),
    },
    enhancePriceRial: data.storage.enhancePriceRial ?? 0,
  };
}

/**
 * Compact single-image form control: thumbnail + انتخاب/تغییر + حذف + optional
 * canonical `/media` crop/rotate/resize & AI version editor (`allowEdit`).
 */
export function MediaImageField({
  label,
  value,
  onChange,
  disabled,
  allowEdit = false,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  allowEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{ asset: AssetRow; enhancePriceRial: number } | null>(null);
  const [loadingEditor, setLoadingEditor] = useState(false);

  async function openEditor() {
    if (!value) return;
    setLoadingEditor(true);
    const resolved = await fetchSingleAssetForEdit(value);
    setLoadingEditor(false);
    if (resolved.asset) {
      setEditing({ asset: resolved.asset, enhancePriceRial: resolved.enhancePriceRial });
    }
  }

  return (
    <div className="mb-4">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      <div className="flex flex-wrap items-center gap-3">
        {value ? (
          <span className="block size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            <img src={mediaFileUrl(value)} alt="" className="size-full object-cover" />
          </span>
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-lg text-muted-foreground" aria-hidden>
            🖼
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
            {value ? "تغییر تصویر" : "انتخاب از کتابخانه"}
          </Button>
          {value && allowEdit ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || loadingEditor}
              onClick={() => void openEditor()}
            >
              {loadingEditor ? "در حال باز کردن…" : "ویرایش / هوش مصنوعی"}
            </Button>
          ) : null}
          {value ? (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>
              حذف تصویر
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <MediaPickerDialog
          title={label}
          allowEdit={allowEdit}
          onClose={() => setOpen(false)}
          onPick={(asset) => {
            onChange(asset.id);
            setOpen(false);
          }}
        />
      ) : null}
      {editing ? (
        <AssetDrawer
          asset={editing.asset}
          folders={[]}
          collections={[]}
          enhancePriceRial={editing.enhancePriceRial}
          onClose={() => setEditing(null)}
          onUpdated={(updated) => setEditing((prev) => (prev ? { ...prev, asset: updated } : null))}
          onDeleted={() => {
            onChange(null);
            setEditing(null);
          }}
          onUseAsset={(picked) => {
            onChange(picked.id);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Multi-image gallery field over shared `media_assets`: multi-select from library,
 * upload multiple photos, non-destructive crop/rotate/resize + AI edits (`enhance`,
 * `bg-remove`, `upscale`, `variations`) via canonical `AssetDrawer` ("استفاده از این نسخه"),
 * and remove/reorder thumbnails without creating a second media store.
 */
export function MediaGalleryField({
  label,
  values,
  onChange,
  disabled,
  maxItems = MAX_PRODUCT_GALLERY_MEDIA,
  allowEdit = true,
}: {
  label: string;
  values: string[];
  onChange: (ids: string[]) => void;
  disabled?: boolean;
  maxItems?: number;
  allowEdit?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<{
    index: number;
    asset: AssetRow;
    enhancePriceRial: number;
  } | null>(null);

  async function openItemEditor(id: string, index: number) {
    const resolved = await fetchSingleAssetForEdit(id);
    if (resolved.asset) {
      setEditing({ index, asset: resolved.asset, enhancePriceRial: resolved.enhancePriceRial });
    }
  }

  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">
          {toPersianDigits(values.length)} از {toPersianDigits(maxItems)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {values.map((id, idx) => (
          <div
            key={id}
            className="flex flex-col items-center gap-1 rounded-xl border border-border bg-muted/40 p-1.5"
          >
            <span className="block size-14 overflow-hidden rounded-lg border border-border bg-muted">
              <img src={mediaFileUrl(id)} alt="" className="size-full object-cover" />
            </span>
            <div className="flex items-center gap-1">
              {allowEdit ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void openItemEditor(id, idx)}
                  className="rounded px-1 text-[11px] font-medium text-primary hover:bg-muted"
                  aria-label={`ویرایش تصویر گالری ${toPersianDigits(idx + 1)}`}
                >
                  ویرایش
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                onClick={() => onChange(values.filter((item) => item !== id))}
                className="rounded px-1 text-[11px] text-destructive hover:bg-destructive/10"
                aria-label={`حذف تصویر گالری ${toPersianDigits(idx + 1)}`}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || values.length >= maxItems}
          onClick={() => setOpen(true)}
        >
          {values.length > 0 ? "مدیریت گالری" : "افزودن تصاویر گالری"}
        </Button>
      </div>

      {open ? (
        <MediaPickerDialog
          title={label}
          multiple
          initialSelectedIds={values}
          maxSelect={maxItems}
          allowEdit={allowEdit}
          onClose={() => setOpen(false)}
          onPickMultiple={(picked) => {
            onChange(picked.map((p) => p.id).slice(0, maxItems));
            setOpen(false);
          }}
        />
      ) : null}

      {editing ? (
        <AssetDrawer
          asset={editing.asset}
          folders={[]}
          collections={[]}
          enhancePriceRial={editing.enhancePriceRial}
          onClose={() => setEditing(null)}
          onUpdated={(updated) => setEditing((prev) => (prev ? { ...prev, asset: updated } : null))}
          onDeleted={() => {
            onChange(values.filter((_, i) => i !== editing.index));
            setEditing(null);
          }}
          onUseAsset={(picked) => {
            const next = [...values];
            if (!next.includes(picked.id)) {
              next[editing.index] = picked.id;
            }
            onChange(next);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}
