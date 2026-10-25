"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MediaPickerDialog, mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { cardClass } from "@/app/dashboard/page-chrome";

export type AiLibraryOrigin = {
  library: "media" | "cms" | "wordpress";
  id: string;
  connectionId?: string;
  remoteId?: string;
};
type Key = AiLibraryOrigin["library"];
type Source = { key: Key; label: string };
type Item = { id: string; name: string; url: string; mimeType: string; source: Key; connectionId?: string; remoteId?: string };
const MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

/** One picker, three independently permission-checked sources, no arbitrary remote fetch. */
export function AiCrossLibraryPicker({
  onClose, onPick,
}: {
  onClose: () => void;
  onPick: (file: File, origin: AiLibraryOrigin) => Promise<void> | void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState<Key | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai/libraries", { credentials: "same-origin", signal: controller.signal, cache: "no-store" })
      .then(async (response) => response.ok ? response.json() : { sources: [] })
      .then((result: { sources?: Source[] }) => {
        if (controller.signal.aborted) return;
        const available = (result.sources ?? []).filter((row) =>
          ["media", "cms", "wordpress"].includes(row.key));
        setSources(available);
        setSource(available[0]?.key ?? null);
      }).catch(() => { if (!controller.signal.aborted) setError("خواندن فهرست کتابخانه‌ها ممکن نشد."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!source || source === "media") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void fetch(`/api/ai/libraries?source=${source}`, {
      credentials: "same-origin", cache: "no-store", signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error("source_unavailable");
      return response.json();
    }).then((result: { items?: Item[] }) => {
      if (!controller.signal.aborted) setItems(result.items ?? []);
    }).catch(() => {
      if (!controller.signal.aborted) { setItems([]); setError("این کتابخانه اکنون در دسترس نیست."); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [source]);

  const tabs = (
    <div dir="rtl" className="flex flex-wrap gap-2" role="tablist" aria-label="منبع کتابخانه">
      {sources.map((item) =>
        <Button type="button" key={item.key} size="sm"
          variant={source === item.key ? "secondary" : "outline"}
          role="tab" aria-selected={source === item.key}
          onClick={() => setSource(item.key)}>{item.label}</Button>)}
    </div>
  );

  async function choose(item: Pick<Item, "id" | "name" | "url" | "source" | "remoteId" | "connectionId">) {
    if (busy) return;
    // Endpoints are server-produced; keep a second client guard to prevent
    // another component from ever passing through an arbitrary remote URL.
    if (!(item.url.startsWith("/api/media/") || item.url.startsWith("/api/cms/website/media/"))) return;
    setBusy(true);
    try {
      const response = await fetch(item.url, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("file_unavailable");
      const blob = await response.blob();
      if (!MIME.has(blob.type.toLowerCase()) || blob.size === 0 || blob.size > MAX_BYTES) {
        throw new Error("unsupported_image");
      }
      await onPick(new File([blob], item.name, { type: blob.type }), {
        library: item.source, id: item.id,
        ...(item.connectionId ? { connectionId: item.connectionId } : {}),
        ...(item.remoteId ? { remoteId: item.remoteId } : {}),
      });
      onClose();
    } catch {
      toast.error("این فایل برای تحلیل دستیار قابل دریافت نیست؛ لطفاً تصویر JPG/PNG/WebP کم‌تر از ۵ مگابایت انتخاب کنید.");
    } finally { setBusy(false); }
  }

  if (source === "media") {
    return <MediaPickerDialog title="انتخاب تصویر از کتابخانه" kind="image" canUpload={false}
      sourceTabs={tabs} onClose={onClose}
      onPick={async (asset) => { await choose({
        id: asset.id, name: asset.fileName, source: "media", url: mediaFileUrl(asset.id),
      }); }} />;
  }

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-center sm:p-6"
    role="dialog" aria-modal="true" aria-label="انتخاب از کتابخانه" dir="rtl">
    <div className={`${cardClass} max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">انتخاب تصویر از کتابخانه</h2>
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>بستن</Button>
      </div>
      {tabs}
      <p className="my-3 text-xs text-muted-foreground">
        فقط تصاویر همگام‌شده و مجاز نمایش داده می‌شوند؛ از نشانی خارجی ناشناس فایل دریافت نمی‌شود.
        تصاویر CMS به‌شکل پیش‌نمایش تأییدشده انتخاب می‌شوند.
      </p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {loading ? <p role="status" className="text-sm text-muted-foreground">در حال دریافت کتابخانه…</p>
        : source == null ? <p role="status">کتابخانهٔ قابل دسترس وجود ندارد.</p>
        : items.length === 0 ? <p role="status">تصویر مجازی در این منبع پیدا نشد.</p>
        : <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {items.map((item) => <button key={`${item.source}:${item.connectionId ?? ""}:${item.id}`}
            type="button" disabled={busy} onClick={() => void choose(item)}
            className="min-w-0 rounded-xl border border-border p-2 text-start hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
            <img src={item.url} alt={item.name} className="aspect-square w-full rounded-lg object-cover" loading="lazy" />
            <span className="mt-1 block truncate text-xs">{item.name}</span>
          </button>)}
        </div>}
    </div>
  </div>;
}
