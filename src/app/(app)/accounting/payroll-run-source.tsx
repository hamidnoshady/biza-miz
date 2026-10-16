"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ErrorBox, api } from "@/app/dashboard/ui";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import type { PayrollRun } from "@/lib/payroll-types";
import { accountingSectionHref } from "./accounting-routes";
import { PayrollRunItem } from "./payroll-run-item";

type Result = { id: string; attempt: number } & (
  | { status: "ready"; run: PayrollRun }
  | { status: "error"; message: string }
);
const noMutation = () => {};

/** A source link is an exact, read-only run lookup, never a search in the first history page. */
export function PayrollRunSource({ runId }: { runId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void api<{ run: PayrollRun; error?: string }>(`/api/ledger/payroll/runs/${encodeURIComponent(runId)}`, { signal: controller.signal })
      .then(({ ok, data }) => {
        if (!active) return;
        setResult(ok
          ? { id: runId, attempt, status: "ready", run: data.run }
          : { id: runId, attempt, status: "error", message: data.error === "run_not_found"
            ? "این لیست حقوق یافت نشد یا متعلق به این کسب‌وکار نیست."
            : "بارگذاری لیست حقوق ناموفق بود. دوباره تلاش کنید." });
      });
    return () => { active = false; controller.abort(); };
  }, [runId, attempt]);
  // Hide the old owner's data immediately, including before the effect runs.
  const current = result?.id === runId && result.attempt === attempt ? result : null;
  return <SectionCard title="لیست حقوق پیوندشده" actions={
    <Button asChild variant="outline" size="sm"><Link href={accountingSectionHref("payroll")}>بستن لیست پیوندشده</Link></Button>
  }>
    {!current ? <LoadingSkeleton rows={3} label="در حال بارگذاری لیست حقوق پیوندشده" />
      : current.status === "error" ? <div className="space-y-3">
        <ErrorBox>{current.message}</ErrorBox>
        <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>تلاش دوباره</Button>
      </div> : <ul aria-label="لیست حقوق پیوندشده">
        <PayrollRunItem key={current.run.id} run={current.run} initialLines={current.run.lines}
          canManage={false} busy={false} working={false} paymentAccounts={[]} onPay={noMutation} onVoid={noMutation} />
      </ul>}
  </SectionCard>;
}
