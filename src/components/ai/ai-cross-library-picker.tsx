"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { MediaPickerDialog, mediaFileUrl } from "@/app/dashboard/media/media-picker";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { AiAttachmentOrigin } from "./use-ai-chat";

type Key = AiAttachmentOrigin["library"];
type Source = { key: Key; label: string };
type Item = { id: string; name: string; url: string; mimeType: string; source: Key; connectionId?: string; remoteId?: string };
const MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 5 * 1024 * 1024;

/** One picker, three independently permission-checked sources, no arbitrary remote fetch. */
export function AiCrossLibraryPicker({
  onClose, onPick,
}: {
  onClose: () => void;
  onPick: (file: File, origin: AiAttachmentOrigin) => Promise<void> | void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [source, setSource] = useState<Key | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai/libraries", { credentials: "same-origin", signal: controller.signal, cache: "no-store" })
      .then(async (response) => { if (!response.ok) throw new Error("libraries_unavailable"); return response.json(); })
      .then((result: { sources?: Source[] }) => {
        if (controller.signal.aborted) return;
        const available = (result.sources ?? []).filter((row) =>
          ["media", "cms", "wordpress"].includes(row.key));
        setSources(available);
        setSource((current) => available.some((row) => row.key === current) ? current : available[0]?.key ?? null);
        setError("");
      }).catch(() => { if (!controller.signal.aborted) setError("خواندن فهرست کتابخانه‌ها ممکن نشد."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

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
  }, [source, revision]);

  const tabs = (
    <div dir="rtl" className="flex flex-wrap gap-2" role="group" aria-label="منبع کتابخانه">
      {sources.map((item) =>
        <Button type="button" key={item.key} size="sm"
          variant={source === item.key ? "secondary" : "outline"}
          aria-pressed={source === item.key} disabled={busy}
          onClick={() => { if (source === item.key) return; setItems([]); setLoading(item.key !== "media"); setError(""); setSource(item.key); }}>{item.label}</Button>)}
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

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent dir="rtl" className="sm:max-w-2xl">
      <DialogTitle>انتخاب تصویر از کتابخانه</DialogTitle>
      {tabs}
      <DialogDescription>
        فقط تصاویر همگام‌شده و مجاز نمایش داده می‌شوند؛ از نشانی خارجی ناشناس فایل دریافت نمی‌شود.
        تصاویر CMS به‌شکل پیش‌نمایش تأییدشده انتخاب می‌شوند.
      </DialogDescription>
      {error ? <div><p role="alert" className="text-sm text-destructive">{error}</p>
        <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>تلاش دوباره</Button>
      </div> : null}
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
    </DialogContent>
  </Dialog>;
}
