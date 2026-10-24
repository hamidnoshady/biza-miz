"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";

interface PrintJob {
  id: string;
  documentType: string;
  entityId: string | null;
  status: string;
  errorMessage: string | null;
  deliveryOutcome: string;
  routeReason: string;
  attemptNumber: number;
  printerName: string | null;
  templateName: string | null;
  templateVersion: number | null;
  templatePaper: string | null;
  when: string;
}

const STATUS: Record<string, string> = { handed_off: "ارسال‌شده به چاپگر", failed: "ناموفق", sending: "در حال ارسال", pending: "در انتظار" };
const DOC: Record<string, string> = { receipt: "رسید", invoice: "فاکتور", kitchen: "آشپزخانه", label: "برچسب" };

export function PrintHistoryPanel() {
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ jobs?: PrintJob[]; error?: string }>("/api/printing/jobs");
    if (ok) { setJobs(data.jobs ?? []); setError(""); }
    else setError(errorMessage(data.error));
    setLoading(false);
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  return <SectionCard title="تاریخچه و عیب‌یابی چاپ" description="وضعیت تحویل، چاپگر، قالب و نسخهٔ قالب برای تلاش‌های اخیر. تلاش‌های ارسال ناموفق و موارد مبهم را از همین‌جا پیدا کنید." actions={<Button type="button" variant="outline" onClick={() => void reload()} disabled={loading}>بازخوانی</Button>}>
    <ErrorBox>{error}</ErrorBox>
    {loading ? <div role="status" aria-busy="true" className="ops-skeleton h-32 rounded-xl" /> : jobs.length ? (
      <ol className="space-y-2" aria-label="تلاش‌های اخیر چاپ">
        {jobs.map((job) => <li key={job.id} className="rounded-xl border border-border/80 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="font-semibold">{DOC[job.documentType] ?? job.documentType}{job.entityId ? ` · ${job.entityId}` : ""}</p><p className="text-xs text-muted-foreground">{job.when} · {job.printerName ?? "چاپگر نامشخص"} · {job.templateName ?? job.templatePaper ?? "قالب پیش‌فرض"}{job.templateVersion ? ` v${job.templateVersion}` : ""}</p></div>
            <span className={`rounded-full px-2 py-1 text-xs font-semibold ${job.status === "failed" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>{STATUS[job.status] ?? job.status} · {job.deliveryOutcome}</span>
          </div>
          {job.errorMessage ? <p className="mt-2 text-sm text-destructive">{job.errorMessage}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">مسیر: {job.routeReason} · تلاش {job.attemptNumber}</p>
        </li>)}
      </ol>
    ) : <p className="py-8 text-center text-sm text-muted-foreground">هنوز تلاش چاپی ثبت نشده است.</p>}
  </SectionCard>;
}
