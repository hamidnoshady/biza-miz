"use client";

/**
 * The commission settlement runs (issue #869): every period of commission the
 * books have built, from the first draft to the closed period, and the 2300
 * tie-out that says whether what is owed agrees with the ledger.
 *
 * Building a run is `commission.calculate`; the actions on a run are on its
 * own page. The list reads `commission.view`, and the export carries the same
 * filter. Dates are Shamsi on screen and integer Rial in the business's unit.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { DataTable, DataTableBody, DataTableHead, DataTableRow, Td, Th } from "@/app/dashboard/data-table";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  CardTitle,
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  PageHeader,
  PageShell,
  SectionCard,
  SectionCardSkeleton,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { api, ErrorBox, Field, InfoBox, inputClass } from "@/app/dashboard/ui";
import { formatPersianNumber } from "@/lib/digits";
import { todayIsoDate } from "@/lib/jalali";
import { COMMISSION_RUN_STATUSES, type CommissionRunStatus } from "@/lib/commission-settlement-lifecycle";
import { commissionSettlementErrorMessage } from "./commission-settlement-messages";
import { runStatusLabel, runStatusTone, shamsiDate } from "./commission-run-view";

interface RunRow {
  id: string;
  runNumber: number;
  title: string | null;
  periodFrom: string;
  periodTo: string;
  status: CommissionRunStatus;
  lineCount: number;
  employeeCount: number;
  commissionTotal: string;
  paidTotal: string;
  outstandingTotal: string;
  warnings: unknown[];
  createdAt: string;
}

interface TieOut {
  ledgerBalance: string;
  accruedTotal: string;
  paidTotal: string;
  unclaimed: string;
  payrollAwaitingCommission: string;
  settlementOutstanding: string;
  carriedForward: string;
  unpaidCommission: string;
  subledgerDifference: string;
  difference: string;
}

interface StaffMember {
  id: string;
  fullName: string;
}

interface LocationOption {
  id: string;
  name: string;
}

const PAGE_SIZE = 50;

function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

/** The 2300 tie-out, in the business's words. Zero on both lines is «متوازن». */
function TieOutCard({ tieOut, error, onRetry }: { tieOut: TieOut | null; error: string; onRetry: () => void }) {
  const money = useMoney();
  if (error) {
    return (
      <SectionCard title={<CardTitle eyebrow="تطبیق با دفتر" title="پورسانت و دفتر کل" />}>
        <ErrorBox>{error}</ErrorBox>
        <Button variant="outline" className="min-h-11" onClick={onRetry}>
          تلاش دوباره
        </Button>
      </SectionCard>
    );
  }
  if (!tieOut) {
    return <SectionCardSkeleton rows={2} />;
  }
  const balanced = tieOut.difference === "0" && tieOut.subledgerDifference === "0";
  return (
    <SectionCard
      title={<CardTitle eyebrow="تطبیق با دفتر" title="پورسانت پرداخت‌نشده و حساب ۲۳۰۰" />}
      description="آنچه به فروشندگان بدهکاریم، از روی ردیف‌های فروش، باید با مانده حساب ۲۳۰۰ دفتر کل یکی باشد."
      actions={<StatusBadge tone={balanced ? "positive" : "danger"} dot>{balanced ? "متوازن" : "ناهمخوان"}</StatusBadge>}
    >
      <KpiRow>
        <KpiCard label="پورسانت پرداخت‌نشده" value={money.formatText(tieOut.unpaidCommission)} hint="همهٔ مبالغی که هنوز به فروشندگان نرسیده" />
        <KpiCard label="در انتظار تسویه" value={money.formatText(tieOut.unclaimed)} hint="ردیف‌های فروش که هنوز در هیچ دوره‌ای نیستند" />
        <KpiCard label="در دورهٔ تسویه" value={money.formatText(tieOut.settlementOutstanding)} hint="تأییدشده یا آماده پرداخت، هنوز پرداخت‌نشده" />
        <KpiCard label="مانده‌های منتقل‌شده" value={money.formatText(tieOut.carriedForward)} hint="از دوره‌های بسته‌شدهٔ پرداخت‌نشده" />
      </KpiRow>
      {balanced ? null : (
        <div className="mt-3">
          <InfoBox>
            اختلاف با دفتر کل: {money.formatText(tieOut.difference)}. این عدد صفر باید باشد؛ یک سند دستی روی ۲۳۰۰ یا پرداختی
            خارج از این بخش ممکن است علت باشد.
          </InfoBox>
        </div>
      )}
    </SectionCard>
  );
}

/** Build a run for a period: a draft, then its calculation, in one step from the screen. */
function CreateRunCard({ onCreated }: { onCreated: (runId: string) => void }) {
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState(() => todayIsoDate());
  const [title, setTitle] = useState("");
  const [locationId, setLocationId] = useState("");
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One key per attempt, reused on a retry, so a double tap cannot make two drafts.
  const [attemptKey, setAttemptKey] = useState(() => newIdempotencyKey("commission-run"));

  useEffect(() => {
    void api<{ staff?: StaffMember[] }>("/api/commission/rules").then(({ ok, data }) => {
      if (ok && data.staff) setStaff(data.staff);
    });
    void api<{ locations?: LocationOption[] }>("/api/locations/active").then(({ ok, data }) => {
      if (ok && data.locations) setLocations(data.locations);
    });
  }, []);

  const invalid = periodFrom === "" || periodTo === "" || periodFrom > periodTo;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid || busy) return;
    setBusy(true);
    setError("");
    let runId = draftId;
    if (!runId) {
      const created = await api<{ run?: { id: string }; error?: string }>("/api/commission/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": attemptKey },
        body: JSON.stringify({
          periodFrom,
          periodTo,
          title: title.trim() || null,
          locationId: locationId || null,
          employeeIds,
        }),
      });
      if (!created.ok || !created.data.run) {
        setBusy(false);
        setError(commissionSettlementErrorMessage(created.data.error));
        return;
      }
      runId = created.data.run.id;
      setDraftId(runId);
    }
    const calculated = await api<{ error?: string }>(`/api/commission/runs/${runId}/calculate`, { method: "POST", body: "{}" });
    setBusy(false);
    if (!calculated.ok) {
      // The draft stays in the list; the screen says why it is not yet a settlement.
      setError(commissionSettlementErrorMessage(calculated.data.error));
      return;
    }
    setAttemptKey(newIdempotencyKey("commission-run"));
    setDraftId(null);
    onCreated(runId);
  }

  function toggleEmployee(id: string) {
    setEmployeeIds((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));
  }

  return (
    <SectionCard
      title={<CardTitle eyebrow="دورهٔ تازه" title="ساخت دورهٔ تسویه" />}
      description="دوره را برای بازهٔ تاریخ مشخص کنید. همهٔ پورسانت‌های تسویه‌نشدهٔ تا پایان این بازه، برای فروشندگان انتخاب‌شده (یا همه)، در آن می‌آیند."
    >
      <form onSubmit={submit} className="space-y-4" noValidate>
        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {draftId ? (
          <InfoBox>
            پیش‌نویس ساخته شد و هنوز محاسبه نشده است. با «محاسبه» دوباره تلاش کنید، یا آن را در فهرست پیدا کنید.
          </InfoBox>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="از تاریخ">
            <JalaliDatePicker value={periodFrom} onChange={setPeriodFrom} ariaLabel="از تاریخ دوره" />
          </Field>
          <Field label="تا تاریخ">
            <JalaliDatePicker value={periodTo} onChange={setPeriodTo} ariaLabel="تا تاریخ دوره" />
          </Field>
          <Field label="شعبه">
            <select className={inputClass} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">همهٔ شعبه‌ها</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="عنوان (اختیاری)">
            <input className={inputClass} value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          </Field>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-foreground">فروشندگان</legend>
          <p className="text-xs text-muted-foreground">
            بدون انتخاب، همهٔ فروشندگان دارای پورسانت تسویه‌نشده در دوره می‌آیند.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {staff.map((member) => (
              <label key={member.id} className="flex min-h-10 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={employeeIds.includes(member.id)}
                  onChange={() => toggleEmployee(member.id)}
                />
                <span>{member.fullName}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" className="min-h-11" disabled={invalid || busy}>
            {draftId ? "محاسبه" : "ساخت و محاسبهٔ دوره"}
          </Button>
          {invalid && (periodFrom !== "" || periodTo !== "") ? (
            <span className="text-xs text-destructive">بازهٔ تاریخ را درست انتخاب کنید.</span>
          ) : null}
        </div>
      </form>
    </SectionCard>
  );
}

export function CommissionRunsSection({ permissions }: { permissions: readonly string[] }) {
  const money = useMoney();
  const router = useRouter();
  const canCalculate = permissions.includes("commission.calculate");

  const [status, setStatus] = useState<"" | CommissionRunStatus>("");
  const [offset, setOffset] = useState(0);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState("");
  const [tieOut, setTieOut] = useState<TieOut | null>(null);
  const [tieOutError, setTieOutError] = useState("");

  const loadRuns = useCallback(async () => {
    setLoadError("");
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    if (status) params.set("status", status);
    const { ok, data } = await api<{ runs?: RunRow[]; total?: number; error?: string }>(`/api/commission/runs?${params}`);
    if (ok && data.runs) {
      setRuns(data.runs);
      setTotal(data.total ?? data.runs.length);
    } else {
      setLoadError(commissionSettlementErrorMessage(data.error));
    }
  }, [status, offset]);

  const loadTieOut = useCallback(async () => {
    setTieOutError("");
    const { ok, data } = await api<{ tieOut?: TieOut; error?: string }>("/api/commission/liability");
    if (ok && data.tieOut) setTieOut(data.tieOut);
    else setTieOutError(commissionSettlementErrorMessage(data.error));
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);
  useEffect(() => {
    void loadTieOut();
  }, [loadTieOut]);

  const csvHref = `/api/commission/runs?format=csv${status ? `&status=${status}` : ""}`;
  const from = offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <PageShell>
      <PageHeader
        title="دوره‌های تسویه پورسانت"
        description="پورسانت فروشندگان را به دوره‌هایی تبدیل می‌کنید که تأیید، پرداخت و بسته می‌شوند. هر دوره یک عکس ثابت از ردیف‌های فروش است؛ تغییر قانون بعدی، دورهٔ قبلی را دست‌کاری نمی‌کند."
        actions={
          <>
            <Button variant="outline" className="min-h-11" asChild>
              <Link href="/growth/commission">قوانین و گزارش</Link>
            </Button>
            <Button variant="outline" className="min-h-11" asChild>
              <a href={csvHref} download>
                خروجی CSV
              </a>
            </Button>
          </>
        }
      />

      <div className="space-y-4 sm:space-y-5">
        <TieOutCard tieOut={tieOut} error={tieOutError} onRetry={() => void loadTieOut()} />

        {canCalculate ? (
          <CreateRunCard onCreated={(runId) => router.push(`/growth/commission/runs/${runId}`)} />
        ) : null}

        <SectionCard
          flush
          title={<CardTitle eyebrow="فهرست" title="همهٔ دوره‌ها" />}
          actions={
            <div className="w-44">
              <Field label="وضعیت">
                <select
                  className={inputClass}
                  value={status}
                  onChange={(e) => {
                    setOffset(0);
                    setStatus(e.target.value as "" | CommissionRunStatus);
                  }}
                >
                  <option value="">همهٔ وضعیت‌ها</option>
                  {COMMISSION_RUN_STATUSES.map((value) => (
                    <option key={value} value={value}>
                      {runStatusLabel(value)}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          }
        >
          {loadError ? (
            <div className="space-y-3 p-4">
              <ErrorBox>{loadError}</ErrorBox>
              <Button variant="outline" onClick={() => void loadRuns()}>
                تلاش دوباره
              </Button>
            </div>
          ) : runs === null ? (
            <div className="p-4">
              <LoadingSkeleton rows={4} compact />
            </div>
          ) : runs.length === 0 ? (
            <div className="p-4">
              <EmptyState>
                {status ? "دورهٔ تسویه‌ای با این وضعیت نیست." : "هنوز دورهٔ تسویه‌ای ساخته نشده است."}
              </EmptyState>
            </div>
          ) : (
            <>
              <DataTable caption="دوره‌های تسویه پورسانت" frame={false}>
                <DataTableHead>
                  <Th>دوره</Th>
                  <Th>بازه</Th>
                  <Th>وضعیت</Th>
                  <Th numeric>فروشندگان</Th>
                  <Th numeric>کل پورسانت</Th>
                  <Th numeric>پرداخت‌شده</Th>
                  <Th numeric>باقی‌مانده</Th>
                  <Th>هشدار</Th>
                </DataTableHead>
                <DataTableBody>
                  {runs.map((run) => (
                    <DataTableRow key={run.id} onClick={() => router.push(`/growth/commission/runs/${run.id}`)}>
                      <Td>
                        <Link href={`/growth/commission/runs/${run.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                          دورهٔ {formatPersianNumber(run.runNumber)}
                        </Link>
                        {run.title ? <span className="block text-xs text-muted-foreground">{run.title}</span> : null}
                      </Td>
                      <Td nowrap>
                        {shamsiDate(run.periodFrom)} تا {shamsiDate(run.periodTo)}
                      </Td>
                      <Td>
                        <StatusBadge tone={runStatusTone(run.status)}>{runStatusLabel(run.status)}</StatusBadge>
                      </Td>
                      <Td numeric>{formatPersianNumber(run.employeeCount)}</Td>
                      <Td numeric>{money.formatText(run.commissionTotal)}</Td>
                      <Td numeric>{money.formatText(run.paidTotal)}</Td>
                      <Td numeric>{money.formatText(run.outstandingTotal)}</Td>
                      <Td>
                        {run.warnings.length > 0 ? (
                          <StatusBadge tone="danger">{formatPersianNumber(run.warnings.length)} مورد</StatusBadge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </Td>
                    </DataTableRow>
                  ))}
                </DataTableBody>
              </DataTable>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/80 p-3 text-sm text-muted-foreground">
                <span>
                  {formatPersianNumber(from)} تا {formatPersianNumber(to)} از {formatPersianNumber(total)}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                    قبلی
                  </Button>
                  <Button variant="outline" size="sm" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                    بعدی
                  </Button>
                </div>
              </div>
            </>
          )}
        </SectionCard>
      </div>
    </PageShell>
  );
}
