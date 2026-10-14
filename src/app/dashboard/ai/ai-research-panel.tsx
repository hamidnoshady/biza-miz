"use client";

/**
 * Issue #812 §5 — «پژوهش عمیق», the cost-approved isolated workflow's tenant
 * surface.
 *
 * The three-step shape is the point, and the panel refuses to collapse it:
 *
 *   1. ask      — write the question, see the estimated maximum cost
 *   2. approve  — explicitly agree to that cost
 *   3. read     — the grounded result, with its sources attached
 *
 * There is no "just run it" button. A Deep Research run spends real money on a
 * model call, so the approval step is the product, not friction to be removed.
 * The estimate is computed by the server from the platform's own caps and shown
 * before approval, so what the member agrees to is what the system will spend
 * against.
 *
 * Every finished run keeps its sources visible after the environment expires —
 * a result that cannot be checked is not a result.
 */
import { useCallback, useEffect, useState } from "react";
import { BookOpenIcon, SearchIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Field, InfoBox, api, inputClass } from "@/app/dashboard/ui";
import type {
  ResearchFinding,
  ResearchRun,
  ResearchSource,
  ResearchStatus,
} from "@/lib/ai-research-shared";
import {
  RESEARCH_DEFAULT_MAX_ROUNDS,
  RESEARCH_DEFAULT_SPEND_CAP_USD,
} from "@/lib/ai-research-shared";

const STATUS_LABELS: Record<ResearchStatus, { label: string; tone: "neutral" | "active" | "positive" | "danger" }> = {
  awaiting_approval: { label: "در انتظار تأیید هزینه", tone: "active" },
  running: { label: "در حال اجرا", tone: "active" },
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
  const [question, setQuestion] = useState("");
  const [maxRounds, setMaxRounds] = useState(String(RESEARCH_DEFAULT_MAX_ROUNDS));
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [sources, setSources] = useState<ResearchSource[]>([]);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ runs: ResearchRun[] }>("/api/ai/research");
    if (ok) setRuns(data.runs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    if (question.trim().length < 8) {
      toast.error("سؤال کوتاه است؛ کمی دقیق‌تر بنویسید.");
      return;
    }
    const rounds = Math.max(1, Math.min(12, Number(maxRounds) || RESEARCH_DEFAULT_MAX_ROUNDS));
    setCreating(true);
    // Step 1 asks without approving: the server answers with the estimate it
    // computed from its own caps, and only a second, explicit call approves.
    const { ok, data } = await api<{ error?: string; estimatedMaxCostUsd?: number; run?: ResearchRun }>(
      "/api/ai/research",
      {
        method: "POST",
        body: JSON.stringify({ question: question.trim(), maxRounds: rounds, costApproved: false }),
      },
    );
    setCreating(false);
    if (ok && data.run) {
      toast.success("پژوهش ساخته شد؛ برای شروع باید هزینهٔ آن را تأیید کنید.");
      void load();
      return;
    }
    if (ok) {
      toast.message(
        `بازهٔ هزینهٔ این پژوهش حدود ${money(data.estimatedMaxCostUsd ?? 0)} است. برای شروع آن را تأیید کنید.`,
      );
      return;
    }
    toast.error(researchErrorMessage(data.error ?? ""));
  }

  async function approve(run: ResearchRun) {
    if (!window.confirm(`هزینهٔ تخمینی این پژوهش ${money(run.estimatedMaxCostUsd)} است. تأیید و شروع می‌کنید؟`)) {
      return;
    }
    setApprovingId(run.id);
    const { ok, data } = await api<{ error?: string; run?: ResearchRun; sources?: ResearchSource[] }>(
      `/api/ai/research/${run.id}/approve`,
      { method: "POST" },
    );
    setApprovingId(null);
    if (!ok) {
      toast.error(researchErrorMessage(data.error ?? ""));
      return;
    }
    if (data.run) setOpenId(data.run.id);
    if (data.sources) setSources(data.sources);
    toast.success("پژوهش اجرا شد.");
    void load();
  }

  return (
    <div className="space-y-4">
      <InfoBox>
        پژوهش عمیق یک کار جداگانه و هزینه‌دار است: سؤال شما را در چند دور بررسی می‌کند، هر عدد را به منبعش
        ارجاع می‌دهد و نتیجه را همراه شواهد نگه می‌دارد. پیش از شروع، حداکثر هزینهٔ آن به شما نشان داده می‌شود و
        بدون تأیید شما اجرا نمی‌شود.
      </InfoBox>

      <SectionCard title="پژوهش جدید">
        <div className="space-y-3">
          <Field label="سؤال">
            <textarea
              className={inputClass}
              rows={3}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="مثلاً: فروش سه ماه گذشته را به تفکیک شعبه و دستهٔ کالا با ذکر منابع گزارش کن."
            />
          </Field>
          <Field label="حداکثر دورهای بررسی">
            <input
              className={inputClass}
              inputMode="numeric"
              value={maxRounds}
              onChange={(event) => setMaxRounds(event.target.value)}
            />
          </Field>
          <div className="flex justify-end">
            <Button type="button" size="sm" className="gap-1.5" disabled={creating} onClick={create}>
              <SearchIcon className="size-4" aria-hidden="true" />
              ساخت پژوهش
            </Button>
          </div>
        </div>
      </SectionCard>

      {loading ? (
        <LoadingSkeleton rows={3} />
      ) : runs.length === 0 ? (
        <EmptyState>هنوز پژوهشی نداشته‌اید.</EmptyState>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => {
            const status = STATUS_LABELS[run.status];
            const open = openId === run.id;
            return (
              <SectionCard key={run.id} title={run.question}>
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                    <StatusBadge tone="neutral">دورهای استفاده‌شده: {run.roundsUsed.toLocaleString("fa-IR")}</StatusBadge>
                    <StatusBadge tone="neutral">سقف هزینه: {money(run.spendCapUsd)}</StatusBadge>
                    {run.actualCostUsd > 0 && (
                      <StatusBadge tone="neutral">هزینهٔ واقعی: {money(run.actualCostUsd)}</StatusBadge>
                    )}
                  </div>

                  {run.status === "awaiting_approval" && (
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-muted-foreground">
                        حداکثر هزینهٔ تخمینی: {money(run.estimatedMaxCostUsd)}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        disabled={approvingId === run.id}
                        onClick={() => approve(run)}
                      >
                        {approvingId === run.id ? "در حال اجرا…" : "تأیید و اجرا"}
                      </Button>
                    </div>
                  )}

                  {run.answer && (
                    <div className="space-y-2">
                      <p className="text-sm leading-6 text-foreground whitespace-pre-wrap">{run.answer}</p>
                      {open && (
                        <div className="space-y-1 rounded-md border border-border/70 p-2">
                          <p className="text-xs font-semibold text-muted-foreground">منابع</p>
                          {sources.length === 0 ? (
                            <p className="text-xs text-muted-foreground">منبعی ثبت نشده است.</p>
                          ) : (
                            <ul className="space-y-0.5">
                              {sources.map((source) => (
                                <li key={`${source.kind}:${source.ref}`} className="text-xs text-muted-foreground">
                                  <BookOpenIcon className="me-1 inline size-3" aria-hidden="true" />
                                  {source.title} — {source.ref} ({source.count.toLocaleString("fa-IR")} مورد)
                                </li>
                              ))}
                            </ul>
                          )}
                          {(run.findings as ResearchFinding[]).length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {(run.findings as ResearchFinding[]).map((finding, index) => (
                                <li key={`${finding.claim}-${index}`} className="text-xs leading-5 text-foreground">
                                  • {finding.claim} <span className="text-muted-foreground">({finding.sourceRefs.join("، ")})</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                      <Button type="button" size="sm" variant="ghost" onClick={() => setOpenId(open ? null : run.id)}>
                        {open ? "بستن منابع" : "نمایش منابع"}
                      </Button>
                    </div>
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

export function researchErrorMessage(code: string): string {
  switch (code) {
    case "research_disabled":
      return "پژوهش عمیق روی این سکو فعال نیست.";
    case "research_question_too_short":
      return "سؤال کوتاه است؛ دقیق‌تر بنویسید.";
    case "research_cost_not_approved":
      return "هزینهٔ پژوهش تأیید نشده است.";
    case "research_not_found":
      return "پژوهش پیدا نشد.";
    case "research_not_awaiting_approval":
      return "این پژوهش در انتظار تأیید هزینه نیست.";
    case "research_environment_expired":
      return "محیط این پژوهش منقضی شده است.";
    case "insufficient_credit":
      return "اعتبار هوش مصنوعی این کسب‌وکار کافی نیست.";
    case "ai_disabled":
      return "سرویس هوش مصنوعی در دسترس نیست.";
    default:
      return "انجام نشد.";
  }
}
