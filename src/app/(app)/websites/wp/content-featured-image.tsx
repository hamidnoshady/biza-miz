"use client";

/**
 * Issue #1215 P2-5 — the featured image field of the post/page editor.
 *
 * WordPress stores the thumbnail as meta, not as a post field, so the editor
 * sends an attachment id and the plugin calls `set_post_thumbnail`. The picker
 * reads the site's own media mirror (`content?type=attachment&kind=image`), so
 * it offers the images the store actually has — never a second upload store —
 * and only the id travels back.
 *
 * A plugin that cannot apply the field never sees this control: the parent
 * renders the refusal instead, because a field that silently does not save is
 * the failure the whole epic set out to remove.
 */

import { useCallback, useEffect, useState } from "react";
import { ImageIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, errorMessageOrRaw } from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";

interface MediaRow {
  remoteId: string;
  title: string;
  thumbnailUrl?: string | null;
  mediaUrl?: string | null;
  altText?: string;
}

export function WpFeaturedImagePicker({
  connectionId,
  value,
  currentUrl,
  onChange,
  disabled = false,
}: {
  connectionId: string;
  /** The attachment id already chosen in this edit session, or null. */
  value: number | null;
  /** The URL the mirror resolved for the saved row, used before a new pick. */
  currentUrl?: string | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MediaRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);

  const load = useCallback(
    (signal: AbortSignal) => {
      const params = new URLSearchParams({
        connectionId,
        type: "attachment",
        kind: "image",
        limit: "24",
        cursorMode: "1",
      });
      void api<{ rows?: MediaRow[]; error?: string }>(`/api/integrations/wp-manager/content?${params.toString()}`, {
        signal,
      }).then((response) => {
        if (response.aborted) return;
        if (!response.ok) {
          setError(errorMessageOrRaw(response.data?.error) || "خواندن تصاویر فروشگاه ناموفق بود.");
          setRows([]);
          return;
        }
        setRows(Array.isArray(response.data?.rows) ? response.data.rows : []);
      });
    },
    [connectionId],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setRows(null);
    setError(null);
    load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  // The chosen image has no URL until the save round-trips, so the preview
  // keeps the picked row's own thumbnail rather than showing an empty frame.
  useEffect(() => {
    if (value === null) setPickedUrl(null);
  }, [value]);

  const previewUrl = value !== null ? pickedUrl ?? currentUrl ?? null : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">تصویر شاخص</span>
        {value !== null ? (
          <span className="text-xs text-muted-foreground" aria-hidden>
            شناسهٔ رسانه: {toPersianDigits(value)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">بدون تصویر شاخص</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="size-20 overflow-hidden rounded-lg border border-border bg-muted/40">
          {previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a mirrored store URL, not an optimized asset
            <img src={previewUrl} alt="پیش‌نمایش تصویر شاخص" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <ImageIcon className="size-6" aria-hidden />
            </div>
          )}
        </div>

        <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => setOpen((current) => !current)}>
          {open ? "بستن فهرست تصاویر" : value !== null ? "تغییر تصویر شاخص" : "انتخاب تصویر شاخص"}
        </Button>
        {value !== null ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <XIcon className="size-4" />
            حذف تصویر شاخص
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="rounded-xl border border-border p-3">
          {error ? <p className="text-xs text-red-600 dark:text-red-400" role="alert">{error}</p> : null}
          {rows === null && !error ? <LoadingSkeleton rows={2} compact label="در حال خواندن تصاویر فروشگاه" /> : null}
          {rows !== null && rows.length === 0 && !error ? (
            <p className="text-xs text-muted-foreground">
              تصویری در کتابخانهٔ همین سایت پیدا نشد؛ اول در بخش رسانه‌ها تصویر اضافه کنید.
            </p>
          ) : null}
          {rows !== null && rows.length > 0 ? (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {rows.map((row) => {
                const id = Number(row.remoteId);
                const selected = value === id;
                const thumb = row.thumbnailUrl ?? row.mediaUrl ?? null;
                return (
                  <li key={row.remoteId}>
                    <button
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      title={row.title || row.remoteId}
                      onClick={() => {
                        onChange(id);
                        setPickedUrl(thumb);
                        setOpen(false);
                      }}
                      className={`w-full overflow-hidden rounded-lg border ${
                        selected ? "border-teal-500 dark:border-teal-400" : "border-border"
                      }`}
                    >
                      <span className="block aspect-square bg-muted/40">
                        {thumb ? (
                          // eslint-disable-next-line @next/next/no-img-element -- a mirrored store URL
                          <img src={thumb} alt={row.title || "تصویر فروشگاه"} className="size-full object-cover" />
                        ) : (
                          <span className="flex size-full items-center justify-center text-muted-foreground">
                            <ImageIcon className="size-4" aria-hidden />
                          </span>
                        )}
                      </span>
                      <span className="block truncate px-1 py-0.5 text-[11px]">{row.title || row.remoteId}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
