"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DownloadIcon, RefreshCwIcon } from "lucide-react";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import {
  allowedDecisions,
  RECONCILIATION_DECISION_LABELS,
  RECONCILIATION_DOMAIN_LABELS,
  RECONCILIATION_IMPORT_MODE_LABELS,
  RECONCILIATION_OUTCOME_LABELS,
  RECONCILIATION_RUN_STATUS_LABELS,
  RESOLUTION_REASON_LABELS,
  type CutoverAuthority,
  type FieldConflict,
  type ReconciliationDecision,
  type ReconciliationDomain,
  type ReconciliationOutcome,
  type ReconciliationRunStatus,
  type ResolutionReason,
} from "@/lib/import-reconciliation/types";

interface RunView {
  id: string;
  domain: ReconciliationDomain;
  sourceKind: string;
  provider: string;
  sourceKey: string;
  connectionId: string | null;
  importMode: keyof typeof RECONCILIATION_IMPORT_MODE_LABELS;
  status: ReconciliationRunStatus;
  cutoverAuthority: CutoverAuthority | null;
  cutoverAt: string | null;
  createdByName: string;
  createdAt: string;
  appliedAt: string | null;
}

interface CountsView {
  read: number;
  alreadyMapped: number;
  proposedLinks: number;
  newRecords: number;
  conflicts: number;
  invalid: number;
  historical: number;
  pending: number;
  approved: number;
  skipped: number;
  applied: number;
  failed: number;
}

interface ProgressView {
  stage: string;
  label: string;
  fullyReconciled: boolean;
  remaining: number;
}

interface ItemView {
  id: number;
  runId: string;
  externalType: string;
  externalKey: string;
  rowNumber: number | null;
  snapshot: Record<string, unknown>;
  outcome: ReconciliationOutcome;
  reasons: string[];
  canonicalId: string | null;
  candidates: { id: string; label: string }[];
  conflicts: FieldConflict[];
  notes: string[];
  historical: boolean;
  status: string;
  effect: string | null;
  resolvedCanonicalId: string | null;
  error: string | null;
}

const OUTCOME_TONES: Record<ReconciliationOutcome, "positive" | "active" | "danger" | "neutral"> = {
  already_linked: "positive",
  historical_match: "positive",
  safe_match: "positive",
  create_new: "neutral",
  field_conflict: "active",
  ambiguous: "active",
  invalid: "danger",
  skipped: "neutral",
  failed: "danger",
};

const ERROR_MESSAGES: Record<string, string> = {
  run_not_found: "پروندهٔ تطبیق پیدا نشد.",
  decision_not_allowed: "این تصمیم برای وضعیت فعلی این ردیف مجاز نیست.",
  invalid_candidate: "شناسهٔ انتخاب‌شده در فهرست پیشنهادهای این ردیف نیست.",
  unresolved_items_remain: "هنوز ردیف‌های نیازمند بررسی باقی مانده‌اند. ابتدا همهٔ موارد را تعیین تکلیف کنید.",
  preview_stale: "داده‌های سیستم پس از آماده‌سازی تغییر کرده است. دوباره بررسی بگیرید.",
  run_not_editable: "این پروندهٔ تطبیق دیگر قابل ویرایش نیست.",
  reconciliation_required: "پیش از ورود اطلاعات، پروندهٔ تطبیق باید بازبینی و اعمال شود.",
};

function itemTitle(item: ItemView): string {
  const snap = item.snapshot ?? {};
  const label = snap.name ?? snap.title ?? snap.externalId ?? item.externalKey;
  return String(label || item.externalKey);
}

export function ReconciliationWizard({
  initialRunId = null,
  connectionId = null,
  domainFilter,
  onCompleted,
  onClose,
}: {
  initialRunId?: string | null;
  connectionId?: string | null;
  domainFilter?: ReconciliationDomain;
  onCompleted?: () => void;
  onClose?: () => void;
}) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(initialRunId);
  const [run, setRun] = useState<RunView | null>(null);
  const [counts, setCounts] = useState<CountsView | null>(null);
  const [progress, setProgress] = useState<ProgressView | null>(null);
  const [items, setItems] = useState<ItemView[]>([]);
  const [filterOutcome, setFilterOutcome] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<Record<number, string>>({});
  const [overrides, setOverrides] = useState<Record<number, Record<string, "canonical" | "source">>>({});
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (initialRunId) setActiveRunId(initialRunId);
  }, [initialRunId]);

  const loadRuns = useCallback(async () => {
    const params = new URLSearchParams();
    if (connectionId) params.set("connectionId", connectionId);
    if (domainFilter) params.set("domain", domainFilter);
    const qs = params.toString();
    const res = await api<{ runs: RunView[]; error?: string }>(
      `/api/data/reconciliation${qs ? `?${qs}` : ""}`,
    );
    if (res.ok) {
      setRuns(res.data.runs ?? []);
      setActiveRunId((prev) => prev || res.data.runs?.[0]?.id || null);
    }
    setLoading(false);
  }, [connectionId, domainFilter]);

  const loadRunDetail = useCallback(async (id: string) => {
    setError("");
    const res = await api<{
      run: RunView;
      counts: CountsView;
      progress: ProgressView;
      items: ItemView[];
      error?: string;
    }>(`/api/data/reconciliation/${encodeURIComponent(id)}`);
    if (!res.ok) {
      setError(ERROR_MESSAGES[res.data?.error ?? ""] ?? "خطا در بارگذاری پروندهٔ تطبیق.");
      return;
    }
    setRun(res.data.run);
    setCounts(res.data.counts);
    setProgress(res.data.progress);
    setItems(res.data.items ?? []);
  }, []);

  useEffect(() => {
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (activeRunId) {
      void loadRunDetail(activeRunId);
    } else {
      setRun(null);
      setCounts(null);
      setProgress(null);
      setItems([]);
    }
  }, [activeRunId, loadRunDetail]);

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((item) => {
      if (filterOutcome === "review") {
        if (item.outcome !== "ambiguous" && item.outcome !== "field_conflict") return false;
      } else if (filterOutcome !== "all" && item.outcome !== filterOutcome) {
        return false;
      }
      if (!q) return true;
      return (
        itemTitle(item).toLowerCase().includes(q) ||
        item.externalKey.toLowerCase().includes(q) ||
        String(item.snapshot?.sku ?? "").toLowerCase().includes(q)
      );
    });
  }, [items, filterOutcome, search]);

  async function postCommand(body: Record<string, unknown>, successText: string) {
    if (!activeRunId) return;
    setBusy(true);
    setError("");
    setNotice("");
    const res = await api<{
      ok?: boolean;
      error?: string;
      summary?: { run: RunView; counts: CountsView; progress: ProgressView };
      crossCheck?: { ok: boolean; problems: string[] };
    }>(`/api/data/reconciliation/${encodeURIComponent(activeRunId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      setError(ERROR_MESSAGES[res.data?.error ?? ""] ?? "اجرای عملیات انجام نشد.");
      return;
    }
    setNotice(successText);
    await loadRuns();
    await loadRunDetail(activeRunId);
    if (body.action === "apply" && res.data.summary?.run.status === "applied") {
      onCompleted?.();
    }
  }

  async function decide(item: ItemView, decision: ReconciliationDecision) {
    const candidateId =
      decision === "link"
        ? selectedCandidate[item.id] ?? item.canonicalId ?? item.candidates[0]?.id
        : undefined;
    const itemOverrides =
      decision === "choose_authority"
        ? Object.fromEntries(
            item.conflicts.map((c) => [c.field, overrides[item.id]?.[c.field] ?? "canonical"]),
          )
        : overrides[item.id];
    const reason = reasons[item.id]?.trim() || undefined;
    await postCommand(
      {
        action: "decide",
        itemId: item.id,
        decision,
        ...(candidateId ? { canonicalId: candidateId } : {}),
        ...(decision === "choose_authority" && itemOverrides && Object.keys(itemOverrides).length > 0
          ? { authorityOverrides: itemOverrides }
          : {}),
        ...(reason ? { reason } : {}),
      },
      "تصمیم با موفقیت ثبت شد.",
    );
  }

  if (loading) return <LoadingSkeleton rows={4} />;

  const isTerminal = run?.status === "applied" || run?.status === "cancelled";

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="بازبینی و تطبیق پیش از ورود اطلاعات"
        description="همهٔ منابع (فایل، هلو و ووکامرس) پیش از ثبت یا همگام‌سازی نهایی از این گام تطبیق می‌گذرند تا رکورد تکراری یا بازنویسی ناخواسته ایجاد نشود."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton type="button" onClick={() => void loadRuns()} disabled={busy}>
              <RefreshCwIcon className="h-4 w-4" />
              به‌روزرسانی
            </SecondaryButton>
            {onClose ? (
              <SecondaryButton type="button" onClick={onClose}>
                بستن
              </SecondaryButton>
            ) : null}
          </div>
        }
      >
        {runs.length === 0 ? (
          <EmptyState title="پروندهٔ تطبیق فعالی وجود ندارد">
            هنگام ورود فایل‌های دارای هم‌پوشانی یا اولین اتصال فروشگاه/هلو، پروندهٔ تطبیق در اینجا ظاهر می‌شود.
          </EmptyState>
        ) : (
          <Field label="انتخاب پروندهٔ تطبیق">
            <select
              className={inputClass}
              value={activeRunId ?? ""}
              onChange={(e) => setActiveRunId(e.target.value || null)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {RECONCILIATION_DOMAIN_LABELS[r.domain]} · {r.provider} ·{" "}
                  {RECONCILIATION_RUN_STATUS_LABELS[r.status]}
                </option>
              ))}
            </select>
          </Field>
        )}
      </SectionCard>

      {run && counts ? (
        <>
          <KpiRow>
            <KpiCard label="کل موارد خوانده‌شده" value={toPersianDigits(counts.read)} />
            <KpiCard label="نیازمند بررسی" value={toPersianDigits(counts.conflicts + counts.pending)} />
            <KpiCard label="تطبیق امن" value={toPersianDigits(counts.proposedLinks)} />
            <KpiCard label="مورد جدید" value={toPersianDigits(counts.newRecords)} />
            <KpiCard label="اعمال‌شده" value={toPersianDigits(counts.applied)} />
          </KpiRow>

          <SectionCard
            title="سیاست مرجع و عملیات"
            description={progress?.label ?? RECONCILIATION_RUN_STATUS_LABELS[run.status]}
            actions={
              <div className="flex flex-wrap gap-2">
                <a
                  href={`/api/data/reconciliation/${encodeURIComponent(run.id)}?report=csv`}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                  خروجی CSV
                </a>
                <a
                  href={`/api/data/reconciliation/${encodeURIComponent(run.id)}?report=json`}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <DownloadIcon className="h-3.5 w-3.5" />
                  گزارش JSON
                </a>
              </div>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-[220px]">
                <Field label="مرجع اصلی در هنگام تعارض">
                  <select
                    className={inputClass}
                    value={run.cutoverAuthority ?? "two_way"}
                    disabled={busy || isTerminal}
                    onChange={(e) =>
                      void postCommand(
                        { action: "cutover", cutoverAuthority: e.target.value },
                        "سیاست مرجع ذخیره شد.",
                      )
                    }
                  >
                    <option value="books">دفاتر حسابداری و سیستم مرکزی مرجع است</option>
                    <option value="source">منبع خارجی (فروشگاه/هلو) مرجع است</option>
                    <option value="two_way">دوطرفه (نیازمند بررسی موردی)</option>
                    <option value="archive_only">فقط بایگانی (بدون اعمال خودکار)</option>
                  </select>
                </Field>
              </div>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton
                  type="button"
                  disabled={busy || isTerminal}
                  onClick={() => void postCommand({ action: "approve_safe" }, "موارد امن تأیید شدند.")}
                >
                  تأیید گروهی موارد امن
                </SecondaryButton>
                <PrimaryButton
                  type="button"
                  disabled={busy || isTerminal || counts.pending > 0}
                  onClick={() => void postCommand({ action: "apply" }, "تطبیق با موفقیت اعمال شد.")}
                >
                  اعمال نهایی تصمیم‌ها
                </PrimaryButton>
                <SecondaryButton
                  type="button"
                  disabled={busy || isTerminal}
                  onClick={() => void postCommand({ action: "cancel" }, "پروندهٔ تطبیق لغو شد.")}
                >
                  لغو
                </SecondaryButton>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="فهرست ردیف‌ها">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <FilterChipRow label="فیلتر وضعیت تطبیق">
                {[
                  ["all", "همه"],
                  ["review", "نیازمند بررسی"],
                  ["safe_match", "تطبیق امن"],
                  ["create_new", "مورد جدید"],
                  ["already_linked", "پیوندشده"],
                ].map(([key, label]) => (
                  <FilterChip
                    key={key}
                    selected={filterOutcome === key}
                    onClick={() => setFilterOutcome(key)}
                  >
                    {label}
                  </FilterChip>
                ))}
              </FilterChipRow>
              <div className="w-64">
                <SearchField
                  label="جستجو در ردیف‌های تطبیق"
                  value={search}
                  onChange={setSearch}
                  placeholder="جستجو در نام، کد یا کلید…"
                />
              </div>
            </div>

            {filteredItems.length === 0 ? (
              <EmptyState title="ردیفی با این فیلتر پیدا نشد" />
            ) : (
              <div className="space-y-3">
                {filteredItems.map((item) => {
                  const choices = allowedDecisions(item.outcome, item.candidates.length > 0);
                  return (
                    <div
                      key={item.id}
                      className="rounded-xl border border-border bg-card p-4 space-y-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="space-y-1">
                          <div className="font-medium text-foreground">
                            {itemTitle(item)}
                            {item.snapshot?.sku ? (
                              <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                                ({String(item.snapshot.sku)})
                              </span>
                            ) : null}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            کلید منبع: <span dir="ltr">{item.externalKey}</span>
                            {item.reasons.length > 0 ? (
                              <span className="ms-2">
                                ·{" "}
                                {item.reasons
                                  .map((r) => RESOLUTION_REASON_LABELS[r as ResolutionReason] ?? r)
                                  .join("، ")}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <StatusBadge tone={OUTCOME_TONES[item.outcome]}>
                            {RECONCILIATION_OUTCOME_LABELS[item.outcome]}
                          </StatusBadge>
                          <StatusBadge tone="neutral">{item.status}</StatusBadge>
                        </div>
                      </div>

                      {item.candidates.length > 0 && !isTerminal ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs text-muted-foreground">نامزد تطبیق:</span>
                          <select
                            className={`${inputClass} max-w-sm`}
                            value={selectedCandidate[item.id] ?? item.canonicalId ?? item.candidates[0]?.id ?? ""}
                            onChange={(e) =>
                              setSelectedCandidate((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                          >
                            {item.candidates.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.label}
                              </option>
                            ))}
                          </select>
                        </div>
                      ) : null}

                      {item.conflicts.length > 0 ? (
                        <div className="rounded-lg bg-muted/40 p-3 space-y-2 text-xs">
                          <div className="font-medium text-foreground">تعارض فیلدها:</div>
                          {item.conflicts.map((conflict) => {
                            const currentPick = overrides[item.id]?.[conflict.field] ?? "canonical";
                            return (
                              <div
                                key={conflict.field}
                                className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2 first:border-t-0 first:pt-0"
                              >
                                <div>
                                  <span className="font-medium">{conflict.field}</span>:{" "}
                                  <span className="text-muted-foreground">
                                    سیستم: {String(conflict.canonical ?? "—")} | ورودی:{" "}
                                    {String(conflict.incoming ?? "—")}
                                  </span>
                                </div>
                                {!isTerminal ? (
                                  <select
                                    className={`${inputClass} w-auto text-xs`}
                                    value={currentPick}
                                    onChange={(e) =>
                                      setOverrides((prev) => ({
                                        ...prev,
                                        [item.id]: {
                                          ...(prev[item.id] ?? {}),
                                          [conflict.field]: e.target.value as "canonical" | "source",
                                        },
                                      }))
                                    }
                                  >
                                    <option value="canonical">حفظ مقدار سیستم (رد تغییر ورودی)</option>
                                    <option value="source">پذیرش مقدار ورودی</option>
                                  </select>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {!isTerminal ? (
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <input
                            type="text"
                            className={`${inputClass} max-w-xs text-xs`}
                            placeholder="دلیل تصمیم (اختیاری)…"
                            value={reasons[item.id] ?? ""}
                            onChange={(e) =>
                              setReasons((prev) => ({ ...prev, [item.id]: e.target.value }))
                            }
                          />
                          <div className="flex flex-wrap gap-2">
                            {choices.map((decision) => (
                              <SecondaryButton
                                key={decision}
                                type="button"
                                disabled={busy}
                                onClick={() => void decide(item, decision)}
                              >
                                {RECONCILIATION_DECISION_LABELS[decision]}
                              </SecondaryButton>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {item.error ? (
                        <div className="text-xs text-destructive">خطا: {item.error}</div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </SectionCard>
        </>
      ) : null}
    </div>
  );
}
