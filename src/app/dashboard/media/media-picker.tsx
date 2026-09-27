"use client";

/**
 * The shared image picker over «کتابخانهٔ رسانه» (migration 0149).
 *
 * One dialog every catalogue form opens: pick an image from the library or
 * upload a new one into it (the upload lands in the library too, so the file
 * is organized once and reused everywhere). Returns the chosen asset's id —
 * the caller stores it as `image_media_id` and renders the photo through
 * `/api/media/{id}/file`.
 *
 * Search follows the library screen's own debounce + AbortController +
 * stale-response guard (one implementation, not a second copy of the same
 * three rules), and paginates rather than ever fetching the whole library.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { uploadFiles } from "@/lib/media-uploader";
import { cardClass, EmptyState, LoadingSkeleton } from "../page-chrome";
import { api, ErrorBox, inputClass } from "../ui";

const PAGE_SIZE = 40;

export interface PickedMedia {
  id: string;
  fileName: string;
}

interface PickerAsset {
  id: string;
  fileName: string;
  mimeType: string;
  variant: "original" | "enhanced";
}

export function mediaFileUrl(id: string): string {
  return `/api/media/${id}/file`;
}

export function MediaPickerDialog({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (asset: PickedMedia) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<PickerAsset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [storageReady, setStorageReady] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

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

      const params = new URLSearchParams({ kind: "image", limit: String(PAGE_SIZE), offset: String(offset) });
      if (search) params.set("search", search);
      api<{ assets: PickerAsset[]; total: number; storage: { ready: boolean } }>(
        `/api/media?${params.toString()}`,
        { signal: controller.signal },
      ).then(({ ok, data, aborted }) => {
        if (aborted || requestId !== requestRef.current) return;
        setLoadingMore(false);
        if (!ok) {
          setError("خواندن کتابخانهٔ رسانه ناموفق بود.");
          return;
        }
        setError("");
        const usable = data.assets.filter((a) => a.mimeType !== "image/svg+xml");
        setAssets((current) => (append && current ? [...current, ...usable] : usable));
        setTotal(data.total);
        setStorageReady(data.storage.ready);
      });
    },
    [search],
  );

  useEffect(() => {
    load(0, false);
    return () => abortRef.current?.abort();
  }, [load]);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    setNotice("");
    // Same central uploader the library manager uses (src/lib/media-uploader.ts)
    // — a picker upload is a one-file batch, but it still gets the retry on a
    // transient failure that a bare fetch here never had.
    const { done } = uploadFiles([file]);
    const [result] = await done;
    setBusy(false);
    if (result.status !== "success" || !result.asset) {
      if (result.status === "error") setError(result.message ?? "بارگذاری ناموفق بود.");
      return;
    }
    // Inside a picker, an exact duplicate is reused rather than offered as a
    // second copy — the caller only needs an id, and the library gains
    // nothing from two identical objects.
    if (result.asset.duplicate) setNotice("این تصویر از قبل در کتابخانه بود؛ همان انتخاب شد.");
    onPick({ id: result.asset.id, fileName: result.asset.fileName });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className={`${cardClass} max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            بستن
          </Button>
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <p className="mb-3 text-xs text-muted-foreground">{notice}</p> : null}

        <div className="mb-4 flex gap-2">
          <input
            className={inputClass}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="جست‌وجو در تصاویر کتابخانه…"
          />
          <Button
            variant="outline"
            disabled={busy || !storageReady}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? "در حال بارگذاری…" : "بارگذاری تصویر"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
          />
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
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => onPick({ id: asset.id, fileName: asset.fileName })}
                  className="group overflow-hidden rounded-xl border border-border transition-colors hover:border-ring"
                  title={asset.fileName}
                >
                  <span className="block aspect-square overflow-hidden bg-muted">
                    { }
                    <img src={mediaFileUrl(asset.id)} alt={asset.fileName} loading="lazy" className="size-full object-cover" />
                  </span>
                  <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground">{asset.fileName}</span>
                </button>
              ))}
            </div>
            {assets.length < total ? (
              <div className="mt-3 flex justify-center">
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => load(assets.length, true)}>
                  {loadingMore ? "در حال بارگذاری…" : `نمایش بیشتر (${toPersianDigits(total - assets.length)} مورد دیگر)`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The compact form control: thumbnail + انتخاب/حذف. Give it the stored
 * `image_media_id` and it renders the photo and opens the picker.
 */
export function MediaImageField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-3">
        {value ? (
          <span className="block size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            { }
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
          onClose={() => setOpen(false)}
          onPick={(asset) => {
            onChange(asset.id);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
