"use client";

/**
 * Issue #812 §5 — «پژوهش عمیق», the cost-approved isolated workflow's tenant
 * surface.
 * Issue #1367 — the workflow is retired; this panel is its **read-only
 * history**.
 *
 * The distinction matters more than it looks:
 *
 *  - There is no create field, no cost-approval step and no approve button any
 *    more. The retirement is enforced server-side as well, so removing them
 *    here is honest UI, not a security boundary.
 *  - What a member already ran stays exactly as it was: the question, the
 *    status, the actual cost the business was charged, the grounded answer, its
 *    sources and its findings. A result that cannot be checked is not a result.
 *  - A run that was waiting for approval cannot be started now, and says so
 *    instead of showing a button that would fail.
 *  - Nothing here is remapped onto the Thinking chat mode: Deep Research has its
 *    own history and its own costs, and pretending otherwise would rewrite what
 *    happened.
 *
 * The data comes from `GET /api/ai/research`, which stays scoped to the caller's
 * own runs in this business and refuses without `ai.use`.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpenIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { ErrorBox, api } from "@/app/dashboard/ui";
import type {
  ResearchFinding,
  ResearchRun,
  ResearchSource,
  ResearchStatus,
} from "@/lib/ai-research-shared";

const STATUS_LABELS: Record<
  ResearchStatus,
  { label: string; tone: "neutral" | "active" | "positive" | "danger" }
> = {
  awaiting_approval: { label: "در انتظار تأیید هزینه (اجرای تازه ممکن نیست)", tone: "neutral" },
  running: { label: "در حال اجرا در زمان بازنشستگی", tone: "neutral" },
  succeeded: { label: "پایان‌یافته", tone: "positive" },
  failed: { label: "ناموفق", tone: "danger" },
  cancelled: { label: "لغو شده", tone: "neutral" },
  expired: { label: "منقضی شده", tone: "neutral" },
  spend_cap_reached: { label: "به سقف هزینه رسید", tone: "active" },
};

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function AiResearchPanel() {
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setFailed(false);
    const { ok, data } = await api<{ runs: ResearchRun[] }>("/api/ai/research");
    if (ok) setRuns(data.runs ?? []);
    else setFailed(true);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSkeleton rows={3} />;

  return (
    <div className="space-y-4">
      <SectionCard title="تاریخچهٔ پژوهش‌های پیشین">
        <p className="text-sm leading-6 text-muted-foreground">
          پژوهش عمیق بازنشسته شده است و پژوهش تازه‌ای ثبت یا اجرا نمی‌شود. پژوهش‌های قبلی شما با نتیجه، منابع و
          هزینهٔ ثبت‌شده فقط خواندنی باقی می‌مانند. برای پرسش‌های تازه از حالت‌های خودکار، سریع یا تفکر عمیق
          استفاده کنید.
        </p>
      </SectionCard>

      {failed ? (
        <ErrorBox>
          خواندن تاریخچهٔ پژوهش انجام نشد.{" "}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="gap-1.5"
            onClick={() => {
              setLoading(true);
              void load();
            }}
          >
            <RotateCcwIcon className="size-3.5" aria-hidden="true" />
            تلاش دوباره
          </Button>
        </ErrorBox>
      ) : runs.length === 0 ? (
        <EmptyState>پژوهشی برای نمایش ثبت نشده است.</EmptyState>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => {
            const status = STATUS_LABELS[run.status] ?? {
              label: "وضعیت نامشخص",
              tone: "neutral" as const,
            };
            const open = openId === run.id;
            const sources: ResearchSource[] = run.sources ?? [];
            const findings: ResearchFinding[] = run.findings ?? [];
            return (
              <SectionCard key={run.id} title={run.question}>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    <StatusBadge tone="neutral">
                      دورهای استفاده‌شده: {run.roundsUsed.toLocaleString("fa-IR")}
                    </StatusBadge>
                    <StatusBadge tone="neutral">سقف هزینه: {money(run.spendCapUsd)}</StatusBadge>
                    {run.actualCostUsd > 0 && (
                      <StatusBadge tone="neutral">
                        هزینهٔ ثبت‌شده: {money(run.actualCostUsd)}
                      </StatusBadge>
                    )}
                  </div>

                  {run.answer ? (
                    <div className="space-y-2">
                      <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">{run.answer}</p>
                      {open && (
                        <div className="space-y-1 rounded-md border border-border/70 p-2">
                          <p className="text-xs font-semibold text-muted-foreground">منابع</p>
                          {sources.length === 0 ? (
                            <p className="text-xs text-muted-foreground">منبعی ثبت نشده است.</p>
                          ) : (
                            <ul className="space-y-0.5">
                              {sources.map((source) => (
                                <li
                                  key={`${source.kind}:${source.ref}`}
                                  className="text-xs text-muted-foreground"
                                >
                                  <BookOpenIcon
                                    className="me-1 inline size-3"
                                    aria-hidden="true"
                                  />
                                  {source.title} — {source.ref} (
                                  {source.count.toLocaleString("fa-IR")} مورد)
                                </li>
                              ))}
                            </ul>
                          )}
                          {findings.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {findings.map((finding, index) => (
                                <li
                                  key={`${finding.claim}-${index}`}
                                  className="text-xs leading-5 text-foreground"
                                >
                                  • {finding.claim}{" "}
                                  <span className="text-muted-foreground">
                                    ({finding.sourceRefs.join("، ")})
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setOpenId(open ? null : run.id)}
                      >
                        {open ? "بستن منابع" : "نمایش منابع"}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      این پژوهش نتیجهٔ ثبت‌شده‌ای ندارد.
                    </p>
                  )}

                  {run.error && <p className="text-xs text-destructive">{run.error}</p>}
                </div>
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
