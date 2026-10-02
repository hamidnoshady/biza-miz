"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox } from "../../ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

type Event = { id:string; kind:string; source:string; amountRial:number; status:string; attempts:number; error:string|null; occurredAt:string; journalEntryId:string|null };
export function BillingReconciliation(){
 const [events,setEvents]=useState<Event[]>([]); const [error,setError]=useState(""); const [busy,setBusy]=useState<string|null>(null);
 const load=async()=>{const r=await api<{events?:Event[];error?:string}>("/api/platform/company/accounting/reconciliation"); if(r.ok)setEvents(r.data.events??[]);else setError(r.data.error??"خطا در تطبیق");};
 useEffect(()=>{void load()},[]);
 const retry=async(id:string)=>{setBusy(id);const r=await api<{error?:string}>("/api/platform/company/accounting/reconciliation",{method:"POST",body:JSON.stringify({eventId:id})});setBusy(null);if(!r.ok)setError(r.data.error??"تلاش مجدد ناموفق بود");await load();};
 return <section className="rounded-2xl border border-border bg-card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-bold">تطبیق Billing با دفتر</h3><p className="mt-1 text-sm text-muted-foreground">MRR عملیاتی است؛ فقط رویدادهای «ثبت‌شده» درآمد دفتری هستند.</p></div><Button variant="outline" size="sm" onClick={load}>به‌روزرسانی</Button></div>{error?<div className="mt-3"><ErrorBox>{error}</ErrorBox></div>:null}<div className="mt-4 overflow-x-auto"><table className="w-full min-w-[700px] text-sm"><thead><tr className="border-b text-start text-muted-foreground"><th className="p-2 text-start">منبع</th><th className="p-2 text-start">نوع</th><th className="p-2 text-start">مبلغ (ریال)</th><th className="p-2 text-start">تاریخ</th><th className="p-2 text-start">وضعیت</th><th className="p-2 text-start">اقدام</th></tr></thead><tbody>{events.map(e=><tr key={e.id} className="border-b border-border/70"><td className="p-2 font-mono text-xs">{e.source}</td><td className="p-2">{e.kind}</td><td className="p-2">{toPersianDigits(e.amountRial.toLocaleString("en-US"))}</td><td className="p-2">{formatJalali(e.occurredAt)}</td><td className="p-2"><span title={e.error??undefined}>{e.status}{e.error?" · نیازمند توجه":""}</span></td><td className="p-2">{e.status==="failed"?<Button size="sm" variant="outline" disabled={busy===e.id} onClick={()=>retry(e.id)}>تلاش مجدد</Button>:e.journalEntryId?"سند ثبت شد":"—"}</td></tr>)}</tbody></table>{events.length===0?<p className="py-8 text-center text-sm text-muted-foreground">هنوز رویداد جدیدی پس از راه‌اندازی دریافت نشده است.</p>:null}</div></section>
}
