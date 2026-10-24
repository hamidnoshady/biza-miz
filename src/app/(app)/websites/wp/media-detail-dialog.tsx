"use client";
import { MediaPickerDialog } from "@/app/dashboard/media/media-picker";
import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox, inputClass } from "@/app/dashboard/ui";
import { safeWpExternalUrl } from "@/lib/integrations/wp-media";

type Attachment = { id: string; title: string; status: string; mimeType: string; url: string | null; altText: string; caption: string; description: string; revision: string | null; filename: string | null; size: number | null; date: string | null; updatedAt: string | null; usage: { total: number; featured: number; galleries: number; embedded: number } | null; mappings: { media_asset_id: string; status: string }[] };
export function WpMediaDetailDialog({ connectionId, remoteId, siteName, canManage, canLink = false, onClose }: { connectionId: string; remoteId: string; siteName: string; canManage: boolean; canLink?: boolean; onClose: () => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [item, setItem] = useState<Attachment | null>(null);
  const [formRevision, setFormRevision] = useState<string | null>(null);
  const [fields, setFields] = useState({ title: "", alt_text: "", caption: "", description: "" });
  const [canEdit, setCanEdit] = useState(false);
  const [canTrash, setCanTrash] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [jobs, setJobs] = useState<{ id: string; status: string; last_error: string | null; action: string }[]>([]);
  const load = useCallback(async (signal?: AbortSignal, reset = false) => {
    const result = await api<{ attachment: Attachment; canEdit: boolean; canTrash: boolean; jobs: typeof jobs; error?: string }>(`/api/integrations/wp-manager/media/${remoteId}?connectionId=${encodeURIComponent(connectionId)}`, { signal });
    if (result.aborted) return;
    if (!result.ok) { setError(result.data?.error || "خواندن جزئیات ناموفق بود."); return; }
    setItem(result.data.attachment); setCanEdit(result.data.canEdit); setCanTrash(result.data.canTrash); setJobs(result.data.jobs);
    if (reset) { const a = result.data.attachment; setFormRevision(a.revision); setFields({ title: a.title, alt_text: a.altText, caption: a.caption, description: a.description }); }
  }, [connectionId, remoteId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal, true);
    const interval = window.setInterval(() => void load(controller.signal), 5000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [load]);
  async function command(action: string) {
    if (!item) return;
    setBusy(true); setError(""); setNotice("");
    const result = await api<{ error?: string }>(`/api/integrations/wp-manager/media/${remoteId}`, { method: "POST", body: JSON.stringify({ connectionId, action, revision: action === "update" ? formRevision : item.revision, ...fields, confirmRemote: confirmed, acknowledgeUsage: acknowledge }) });
    setBusy(false);
    if (!result.ok) setError(result.data?.error || "درخواست ناموفق بود.");
    else { setNotice("در صف وردپرس قرار گرفت. تا دریافت تأیید سایت، تغییر انجام‌شده محسوب نمی‌شود؛ نتیجه در همین پنجره نمایش داده می‌شود."); void load(); }
  }
  const mutable = canManage && canEdit && !busy;
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>جزئیات رسانهٔ وردپرس</DialogTitle><DialogDescription>{siteName} · شناسهٔ {remoteId} · این عملیات فایل اصلی کتابخانه را حذف یا ویرایش نمی‌کند.</DialogDescription></DialogHeader>
    {error ? <ErrorBox>{error}</ErrorBox> : null}{notice ? <InfoBox>{notice}</InfoBox> : null}
    {item ? <>
      {item.url && item.mimeType?.startsWith("image/") ? <img src={safeWpExternalUrl(item.url) ?? undefined} alt={item.altText} referrerPolicy="no-referrer" className="mx-auto max-h-56 max-w-full object-contain" /> : null}
      <dl className="grid grid-cols-2 gap-2 text-xs"><dt>نام فایل / نوع</dt><dd>{item.filename ?? "—"} / {item.mimeType}</dd><dt>حجم</dt><dd>{item.size ?? "—"}</dd><dt>وضعیت / تاریخ</dt><dd>{item.status} / {item.updatedAt ?? item.date ?? "—"}</dd><dt>پیوند کتابخانهٔ اصلی</dt><dd>{item.mappings.length ? item.mappings.map((m) => `${m.media_asset_id}: ${m.status}`).join(" · ") : "پیوند ندارد"}</dd><dt>کاربرد گزارش‌شدهٔ سایت</dt><dd>{item.usage ? `شاخص: ${item.usage.featured} · گالری محصول: ${item.usage.galleries} · محتوا: ${item.usage.embedded}` : "هنوز بررسی نشده؛ بررسی کاربرد را درخواست کنید."}</dd></dl>
      {canLink && !item.mappings.length ? <Button variant="outline" onClick={() => setLinkOpen(true)}>پیوند عمدی به فایل موجود کتابخانهٔ اصلی (بدون کپی)</Button> : null}
      {linkOpen ? <MediaPickerDialog title={`پیوند فایل اصلی به پیوست ${remoteId} در ${siteName}`} canUpload={false} onClose={() => setLinkOpen(false)} onPick={async (asset) => {
        setLinkOpen(false); setBusy(true);
        const result = await api<{ error?: string }>(`/api/integrations/wp-manager/media/${remoteId}/link`, { method: "POST", body: JSON.stringify({ connectionId, assetId: asset.id }) });
        setBusy(false); if (!result.ok) setError(result.data?.error || "پیوند ناموفق بود."); else { setNotice("پیوند ثبت شد؛ فایل کپی نشده است."); void load(); }
      }} /> : null}
      {item.url ? <a className="text-primary underline" href={safeWpExternalUrl(item.url) ?? undefined} target="_blank" rel="noopener noreferrer">نشانی عمومی فایل</a> : null}
      {Object.entries({ title: "عنوان", alt_text: "متن جایگزین", caption: "زیرنویس", description: "توضیحات" }).map(([key, label]) => <label key={key} className="block text-sm">{label}<textarea aria-label={label} className={inputClass} disabled={!mutable} value={fields[key as keyof typeof fields]} maxLength={{ title: 200, alt_text: 1000, caption: 5000, description: 20000 }[key]} onChange={(e) => setFields({ ...fields, [key]: e.target.value })} /></label>)}
      <div className="flex flex-wrap gap-2"><Button disabled={!mutable || !formRevision} onClick={() => void command("update")}>ذخیرهٔ فراداده در وردپرس</Button><Button variant="outline" disabled={!mutable} onClick={() => void command("inspect")}>بررسی کاربرد در سایت</Button><Button variant="outline" onClick={() => void load(undefined, true)}>خواندن مجدد فیلدها</Button></div>
      <p className="text-xs text-muted-foreground">تشخیص کاربرد شامل تصویر شاخص، گالری محصولات و محتوای پست/صفحه است؛ پیوندهای بیرونی و افزونه‌های دیگر قابل تشخیص کامل نیستند. تغییر نام/جایگزینی فایل یا حذف دائمی از اینجا پشتیبانی نمی‌شود.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />تأیید می‌کنم فقط پیوست همین سایت به زباله‌دان منتقل شود؛ کتابخانهٔ اصلی باقی می‌ماند.</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={acknowledge} onChange={(e) => setAcknowledge(e.target.checked)} />با وجود احتمال خرابی ارجاع‌های محصولات/محتوا، انتقال پیوست در حال استفاده را تأیید می‌کنم.</label>
      <div className="flex gap-2"><Button variant="outline" disabled={!mutable || !confirmed || !canTrash || item.status === "trash"} onClick={() => void command("trash")}>انتقال پیوست سایت به زباله‌دان</Button><Button variant="outline" disabled={!mutable || item.status !== "trash"} onClick={() => void command("restore")}>بازیابی پیوست سایت</Button></div>
      {!canTrash ? <p className="text-xs text-muted-foreground">زباله‌دان رسانه باید در تنظیمات همین وردپرس فعال باشد؛ حذف دائمی جایگزین آن نمی‌شود.</p> : null}
      <ul aria-live="polite" className="space-y-1 text-xs">{jobs.map((job) => <li key={job.id}>{job.action}: {job.status}{job.last_error ? ` — ${job.last_error}` : ""}</li>)}</ul>
    </> : <LoadingSkeleton rows={5} label="در حال خواندن جزئیات" />}
  </DialogContent></Dialog>;
}
