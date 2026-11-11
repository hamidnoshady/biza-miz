"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";

type Option = { id: string; name: string };
type Result = { supervisors: Option[]; hasMore: boolean };
type Marketer = { id: string; name: string; location_id: string; supervisor_name: string | null; supervisor_id: string | null; status: "active" | "inactive" };
export function MarketerSupervisorForm({ marketer, busy, onCancel, onSave }: { marketer: Marketer; busy: boolean; onCancel: () => void; onSave: (supervisorId: string | null) => void }) {
  const [q, setQ] = useState(""); const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null); const [error, setError] = useState(""); const [selected, setSelected] = useState("");
  const seq = useRef(0);
  const load = useCallback(async () => {
    const current = ++seq.current; setData(null); setError(""); setSelected("");
    const result = await api<Result>(`/api/growth/marketers/supervisors?locationId=${encodeURIComponent(marketer.location_id)}&q=${encodeURIComponent(search)}&page=${page}`);
    if (current !== seq.current) return;
    if (!result.ok) setError("دریافت سرپرستان ممکن نشد."); else setData(result.data);
  }, [marketer.location_id,search,page]);
  useEffect(() => { const ref = seq; if (marketer.status === "active") void load(); return () => { ref.current++; }; }, [load,marketer.status]);
  return <SectionCard title={`سرپرست ${marketer.name}`} description="سرپرست باید کارمند فعال و مجاز در همین شعبه باشد. این رابطه هیچ دسترسی یا اختیار تأییدی ایجاد نمی‌کند.">
    <p>سرپرست فعلی: {marketer.supervisor_name ?? "ندارد"}</p>
    {marketer.status === "active" ? <>
      <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(q.trim()); }}>
        <label htmlFor="supervisor-search" className="sr-only">جست‌وجوی سرپرست</label><input id="supervisor-search" className={inputClass} maxLength={150} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="outline" disabled={busy}>جست‌وجوی سرپرست</Button>
      </form>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data ? <>
        <Field label="انتخاب سرپرست"><select className={inputClass} value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}><option value="">انتخاب سرپرست</option>{data.supervisors.filter((option) => option.id !== marketer.id).map((option) => <option key={option.id} value={option.id}>{option.name} — {option.id.slice(0, 8)}</option>)}</select></Field>
        {data.supervisors.length === 0 ? <p>سرپرستی یافت نشد.</p> : null}
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={busy || page === 1} onClick={() => setPage(page-1)}>صفحه قبل سرپرستان</Button><Button type="button" variant="outline" disabled={busy || !data.hasMore} onClick={() => setPage(page+1)}>صفحه بعد سرپرستان</Button></div>
        <Button type="button" disabled={busy || !selected || selected === marketer.supervisor_id} onClick={() => onSave(selected)}>ذخیره سرپرست</Button>
      </> : null}
    </> : <p>برای بازاریاب غیرفعال فقط حذف سرپرست ممکن است.</p>}
    {marketer.supervisor_id ? <Button type="button" variant="outline" disabled={busy} onClick={() => onSave(null)}>حذف سرپرست</Button> : null}
    <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>انصراف از تغییر سرپرست</Button>
  </SectionCard>;
}
