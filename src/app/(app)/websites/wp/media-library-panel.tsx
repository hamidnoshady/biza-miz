"use client";

import { useEffect, useRef, useState } from "react";
import { MediaPickerDialog, type PickedMedia } from "@/app/dashboard/media/media-picker";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";

type Selection = PickedMedia & { status: string; error?: string };
/** Reuses the canonical picker/uploader: upload progress, cancel, retry and
 * hash dedupe stay in /media. No WP-specific blob store or upload endpoint.
 */
export function WpMediaLibraryPanel({ connectionId, siteName, canPush, allowCanonical = true }: { connectionId: string; siteName: string; canPush: boolean; allowCanonical?: boolean }) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Selection[]>([]);
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<{ pending: number; failed: number; dead: number } | null>(null);
  const [error, setError] = useState("");
  const cancel = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const currentGeneration = ++generation.current; cancel.current = true;
    setAssets([]); setOpen(false); setBusy(false); setError(""); setQueue(null);
    return () => { generation.current = currentGeneration + 1; cancel.current = true; };
  }, [connectionId]);
  useEffect(() => {
    const controller = new AbortController();
    const poll = async () => {
      const result = await api<{ summary: { pending: number; failed: number; dead: number }; error?: string }>(`/api/integrations/wp-manager/queue?connectionId=${encodeURIComponent(connectionId)}&pageSize=10`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) { setQueue(result.data.summary); setError(""); }
      else setError(errorMessageOrRaw(result.data?.error) || "خواندن وضعیت صف ناموفق بود.");
    };
    void poll(); const interval = window.setInterval(() => void poll(), 10000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [connectionId]);
  async function send() {
    const requestGeneration = generation.current;
    cancel.current = false; setBusy(true);
    for (const asset of assets.filter((item) => item.status === "selected" || item.status === "failed")) {
      if (cancel.current || requestGeneration !== generation.current) break;
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, status: "sending", error: undefined } : item));
      const response = await api<{ mapping?: { status: string }; error?: string }>(`/api/media/${asset.id}/wordpress`, { method: "POST", body: JSON.stringify({ connectionId }) });
      if (requestGeneration !== generation.current) return;
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, status: response.ok ? response.data.mapping?.status ?? "pending" : "failed", error: response.ok ? undefined : errorMessageOrRaw(response.data?.error) || "ارسال ناموفق بود." } : item));
    }
    if (requestGeneration === generation.current) setBusy(false);
  }
  const labels: Record<string, string> = { selected: "آمادهٔ ارسال", sending: "در حال درخواست", pending: "در صف تأیید وردپرس", synced: "همگام‌شده", failed: "ناموفق؛ بررسی صف" };
  return <SectionCard title="کتابخانهٔ اصلی ← وردپرس" description={`مقصد: ${siteName}. فایل فقط یک‌بار در کتابخانهٔ اصلی ذخیره می‌شود؛ ارسال به سایت یک پیوند مستقل دارد.`}>
    {allowCanonical ? <div className="flex flex-wrap gap-2">
      <Button variant="outline" disabled={!canPush || busy} onClick={() => setOpen(true)}>انتخاب یا بارگذاری در کتابخانهٔ اصلی</Button>
      <Button disabled={!canPush || busy || !assets.some((item) => item.status === "selected" || item.status === "failed")} onClick={() => void send()}>ارسال انتخاب‌ها به {siteName}</Button>
      {busy ? <Button variant="outline" onClick={() => { cancel.current = true; }}>توقف پس از فایل جاری</Button> : null}
    </div> : null}
    {error ? <ErrorBox>{error}</ErrorBox> : null}
    <div role="status" aria-live="polite" className="mt-3 text-sm text-muted-foreground">{queue ? `صف این سایت: ${toPersianDigits(queue.pending ?? 0)} در انتظار · ${toPersianDigits(queue.failed ?? 0)} ناموفق · ${toPersianDigits(queue.dead ?? 0)} متوقف` : <LoadingSkeleton rows={1} label="در حال خواندن صف" />}</div>
    <ul className="mt-3 space-y-2">{assets.map((asset) => <li key={asset.id} className="flex flex-wrap gap-2 text-sm"><span>{asset.fileName}</span><span>{labels[asset.status] ?? asset.status}</span>{asset.error ? <span role="alert">{asset.error}</span> : null}</li>)}</ul>
    {open ? <MediaPickerDialog title={`رسانه برای ${siteName}`} kind="image" multiple maxSelect={20} canUpload={canPush} initialSelectedIds={assets.map((asset) => asset.id)} onPickMultiple={(picked) => { setAssets(picked.map((item) => assets.find((asset) => asset.id === item.id) ?? { ...item, status: "selected" })); setOpen(false); }} onClose={() => setOpen(false)} /> : null}
  </SectionCard>;
}
