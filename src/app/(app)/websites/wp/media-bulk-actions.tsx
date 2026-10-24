"use client";
import { useEffect, useRef, useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { api } from "@/app/dashboard/ui";
/** Bounded batches enqueue immutable per-attachment commands on the shared
 * Queue. In-use trash is rejected at execution, never silently overridden.
 */
export function WpMediaBulkActions({ connectionId, items, canManage, canTrash }: { connectionId: string; items: { remoteId: string; revision?: string | null }[]; canManage: boolean; canTrash: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, string>>({});
  const cancel = useRef(false);
  useEffect(() => () => { cancel.current = true; }, []);
  async function run(action: string) {
    cancel.current = false; setBusy(true); setResults({});
    for (const item of items.slice(0, 20)) {
      if (cancel.current) break;
      const result = await api<{ error?: string }>(`/api/integrations/wp-manager/media/${item.remoteId}`, { method: "POST", body: JSON.stringify({ action, connectionId, revision: item.revision, confirmRemote: confirmed }) });
      if (cancel.current) break;
      setResults((current) => ({ ...current, [item.remoteId]: result.ok ? "در صف تأیید سایت؛ نتیجه را در صف یا جزئیات همین پیوست بررسی کنید." : result.data?.error || "ناموفق" }));
    }
    if (!cancel.current) setBusy(false);
  }
  if (!items.length) return null;
  return <div className="my-3 rounded-xl border border-border p-3"><p className="text-sm">{items.length} پیوست انتخاب‌شده (حداکثر ۲۰). عملیات فقط روی همین سایت انجام می‌شود.</p>
    <label className="my-2 flex gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />انتقال انتخاب‌ها به زباله‌دان این سایت را تأیید می‌کنم؛ فایل در حال استفاده بدون تأیید جداگانه در جزئیات منتقل نمی‌شود.</label>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy || !canManage} onClick={() => void run("inspect")}>بررسی کاربرد انتخاب‌ها</Button><Button variant="outline" disabled={busy || !canManage || !canTrash || !confirmed} onClick={() => void run("trash")}>انتقال به زباله‌دان سایت</Button><Button variant="outline" disabled={busy || !canManage} onClick={() => void run("restore")}>بازیابی انتخاب‌ها</Button>{busy ? <Button variant="outline" onClick={() => { cancel.current = true; setBusy(false); }}>توقف درخواست‌های بعدی</Button> : null}</div>
    {busy ? <LoadingSkeleton rows={1} label="در حال درخواست عملیات گروهی" /> : null}
    <ul aria-live="polite" className="mt-2 text-xs">{Object.entries(results).map(([id, status]) => <li key={id}>{id}: {status}</li>)}</ul>
  </div>;
}
