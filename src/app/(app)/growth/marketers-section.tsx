"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import { DataTable, DataTableHead, DataTableBody, DataTableRow, Th, Td } from "@/app/dashboard/data-table";
import { api, ErrorBox, Field, inputClass } from "@/app/dashboard/ui";
import type { MarketerKind } from "@/lib/marketing-roster";

const KIND: Record<MarketerKind, string> = { employee: "کارمند", contractor: "پیمانکار", affiliate: "همکار ارجاعی", agency: "آژانس" };
type Row = { id: string; name: string; kind: MarketerKind; status: "active" | "inactive"; location_name: string; user_active: boolean | null; revision: number };
type List = { marketers: Row[]; hasMore: boolean };
type Candidates = { locations: { id: string; name: string }[]; users: { id: string; full_name: string; location_id: string }[] };

export function MarketersSection({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<List | null>(null);
  const requestSequence = useRef(0);
  const [candidates, setCandidates] = useState<Candidates | null>(null);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [locationId, setLocationId] = useState("");
  const [kind, setKind] = useState<MarketerKind>("employee");
  const [userId, setUserId] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<Row | null>(null);
  const [editName, setEditName] = useState("");
  const [pending, setPending] = useState<Row | null>(null);
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current;
    setData(null); setError("");
    const result = await api<List>(`/api/growth/marketers?q=${encodeURIComponent(search)}&page=${page}`);
    if (sequence !== requestSequence.current) return;
    if (!result.ok) { setError("دریافت فهرست ممکن نشد. دوباره تلاش کنید."); return; }
    setData(result.data);
  }, [search, page]);
  const loadCandidates = useCallback(async () => {
    const result = await api<Candidates>("/api/growth/marketers/candidates");
    if (result.ok) setCandidates(result.data);
    else setFormError("دریافت شعبه‌ها و اعضای تیم ممکن نشد.");
  }, []);
  useEffect(() => { const sequence = requestSequence; void load(); return () => { sequence.current++; }; }, [load]);
  useEffect(() => { if (canManage) void loadCandidates(); }, [canManage, loadCandidates]);

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setFormError("");
    const result = await api<{ error?: string }>("/api/growth/marketers", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locationId, kind, ...(kind === "employee" ? { userId } : { name }) }),
    });
    setBusy(false);
    if (!result.ok) { setFormError(result.data?.error === "marketer_already_exists" ? "این عضو قبلاً ثبت شده است." : "ثبت بازاریاب ممکن نشد. اطلاعات و دسترسی شعبه را بررسی کنید."); return; }
    setName(""); setUserId(""); await Promise.all([load(), loadCandidates()]);
  }

  async function change(row: Row, payload: object) {
    setBusy(true); setError("");
    const result = await api<{ error?: string }>(`/api/growth/marketers/${encodeURIComponent(row.id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, expectedRevision: row.revision }),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.data?.error === "open_assignments" ? "بازاریاب ماموریت باز دارد؛ ابتدا ماموریت‌ها را تکمیل یا لغو کنید." : result.data?.error === "ineligible_user" ? "عضو مرتبط فعال نیست یا دیگر به این شعبه دسترسی ندارد." : "تغییر ممکن نشد؛ دسترسی یا نسخهٔ بازاریاب ممکن است تغییر کرده باشد. فهرست را دوباره دریافت کنید.");
      return;
    }
    setEditing(null); setPending(null); await load();
  }

  return <div className="space-y-4">
    <SectionCard title="بازاریابان" description="فهرست عملیاتی بر اساس شعبه‌های قابل دسترس. ثبت همکار خارجی دسترسی به سامانه ایجاد نمی‌کند.">
      <form onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query.trim()); }} className="flex flex-wrap gap-2">
        <label className="sr-only" htmlFor="marketer-search">جست‌وجوی نام</label>
        <input id="marketer-search" className={inputClass} value={query} maxLength={150} onChange={(e) => setQuery(e.target.value)} placeholder="جست‌وجوی نام" />
        <Button type="submit" variant="outline">جست‌وجو</Button>
      </form>
      {error ? <><ErrorBox>{error}</ErrorBox><Button type="button" variant="outline" onClick={() => void load()}>تلاش دوباره</Button></> : null}
      {!data && !error ? <SectionCardSkeleton /> : null}
      {data && data.marketers.length === 0 ? <EmptyState>بازاریابی یافت نشد.</EmptyState> : null}
      {data && data.marketers.length > 0 ? <DataTable caption="فهرست بازاریابان">
        <DataTableHead><Th>نام</Th><Th>نوع همکاری</Th><Th>شعبه</Th><Th>وضعیت</Th>{canManage ? <Th>عملیات</Th> : null}</DataTableHead>
        <DataTableBody>{data.marketers.map((row) => <DataTableRow key={row.id}><Td>{row.name}</Td><Td>{KIND[row.kind]}</Td><Td>{row.location_name}</Td><Td>{row.status === "active" ? "فعال" : "غیرفعال"}{row.user_active === false ? " (عضو غیرفعال)" : ""}</Td>{canManage ? <Td>{row.kind !== "employee" && row.status === "active" ? <Button type="button" variant="outline" disabled={busy} onClick={() => { setPending(null); setEditing(row); setEditName(row.name); }}>ویرایش نام</Button> : null}<Button type="button" variant="outline" disabled={busy} onClick={() => { setEditing(null); setPending(row); }}>{row.status === "active" ? "غیرفعال‌سازی" : "فعال‌سازی"}</Button></Td> : null}</DataTableRow>)}</DataTableBody>
      </DataTable> : null}
      {data ? <div className="flex gap-2"><Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(page - 1)}>صفحه قبل</Button><Button type="button" variant="outline" disabled={!data.hasMore} onClick={() => setPage(page + 1)}>صفحه بعد</Button></div> : null}
    </SectionCard>
    {canManage && editing ? <SectionCard title="ویرایش نام همکار خارجی" description="نام اعضای تیم از فهرست مشترک کاربران دریافت می‌شود.">
      <form onSubmit={(e) => { e.preventDefault(); void change(editing, { action: "rename", name: editName }); }}>
        <Field label="نام همکار برای ویرایش"><input className={inputClass} required maxLength={150} value={editName} onChange={(e) => setEditName(e.target.value)} /></Field>
        <Button type="submit" disabled={busy}>ذخیره تغییرات</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setEditing(null)}>انصراف از ویرایش</Button>
      </form>
    </SectionCard> : null}
    {canManage && pending ? <SectionCard title={pending.status === "active" ? "تأیید غیرفعال‌سازی" : "تأیید فعال‌سازی"} description={pending.status === "active" ? "بازاریاب دارای ماموریت باز غیرفعال نمی‌شود. سابقه حذف نمی‌شود و وضعیت حساب کاربری تغییر نمی‌کند." : "کارمند باید عضو فعال و دارای دسترسی به شعبه باشد."}>
      <p>{pending.name}</p><Button type="button" disabled={busy} onClick={() => void change(pending, { action: pending.status === "active" ? "deactivate" : "reactivate" })}>تأیید</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setPending(null)}>انصراف</Button>
    </SectionCard> : null}
    {canManage ? <SectionCard title="افزودن بازاریاب" description="برای کارمند، عضو فعال همان کسب‌وکار و شعبه را انتخاب کنید.">
      {formError ? <ErrorBox>{formError}</ErrorBox> : null}
      {!candidates ? <Button type="button" variant="outline" onClick={() => void loadCandidates()}>دریافت شعبه‌ها و اعضا</Button> : <form onSubmit={submit}>
        <Field label="شعبه"><select className={inputClass} value={locationId} required onChange={(e) => { setLocationId(e.target.value); setUserId(""); }}><option value="">انتخاب شعبه</option>{candidates.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></Field>
        <Field label="نوع همکاری"><select className={inputClass} value={kind} onChange={(e) => { setKind(e.target.value as MarketerKind); setUserId(""); }}>
          {Object.entries(KIND).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></Field>
        {kind === "employee" ? <Field label="عضو تیم"><select className={inputClass} required value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">انتخاب عضو</option>{candidates.users.filter((u) => u.location_id === locationId).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select></Field> : <Field label="نام"><input className={inputClass} required maxLength={150} value={name} onChange={(e) => setName(e.target.value)} /></Field>}
        <Button type="submit" disabled={busy}>{busy ? "در حال ثبت…" : "ثبت"}</Button>
      </form>}
    </SectionCard> : null}
  </div>;
}
