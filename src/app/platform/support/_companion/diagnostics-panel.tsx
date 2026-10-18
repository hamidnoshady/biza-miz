"use client";

/**
 * Issue #984 — the ticket's «تشخیص و تعمیر» tab: request diagnostics for a
 * verified installation, follow run states truthfully (no false greens),
 * and propose approved catalog repairs. Execution approval stays a separate
 * owner-only action at the action boundary.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PlatformDetailSection, PlatformStatusBadge } from "@/components/platform";
import { usePlatformMutation, usePlatformQuery } from "../../_lib/use-platform-data";
import { useCan } from "../../_lib/capability-context";
import { fmtDateTime } from "@/lib/platform-format";
import {
  SUPPORT_DIAGNOSTIC_MODULES,
  SUPPORT_DIAGNOSTIC_MODULE_LABELS,
  SUPPORT_REPAIR_RISK_LABELS,
  SUPPORT_REPAIR_RUN_STATE_LABELS,
  SUPPORT_REQUEST_STATE_LABELS,
  SUPPORT_RUN_STATE_LABELS,
  SUPPORT_SEVERITY_LABELS,
  SUPPORT_UPLOAD_STATE_LABELS,
} from "@/lib/support-companion/types";
import type {
  DiagnosticRequestDto,
  DiagnosticRunDto,
  RepairRecipeDto,
  RepairRunDto,
  TicketSupportContext,
  WorkspaceInstallation,
} from "./types";
import { FreshnessBadge } from "./freshness-badge";

function stateTone(state: string): "success" | "warning" | "neutral" | "muted" | "danger" | "info" {
  if (["completed", "succeeded", "received"].includes(state)) return "success";
  if (["failed", "recovery_required"].includes(state)) return "danger";
  if (["partial", "pending", "awaiting_approval", "delivered", "opened", "not_sent", "uploading"].includes(state)) {
    return "warning";
  }
  if (["running", "executing", "verifying", "consented", "authorized"].includes(state)) return "info";
  return "neutral";
}

export function DiagnosticsPanel({ ticketId }: { ticketId: string }) {
  const can = useCan();
  const context = usePlatformQuery<{ context: TicketSupportContext }>(
    `/api/platform/support/tickets/${ticketId}/context`,
    [ticketId],
  );
  const diagnostics = usePlatformQuery<{ requests: DiagnosticRequestDto[]; runs: DiagnosticRunDto[] }>(
    `/api/platform/support/diagnostics?ticketId=${ticketId}`,
    [ticketId],
  );
  const repairs = usePlatformQuery<{ catalog: RepairRecipeDto[]; runs: RepairRunDto[] }>(
    `/api/platform/support/repairs?ticketId=${ticketId}`,
    [ticketId],
  );

  const installations = context.data?.context.installations ?? [];
  const activeInstallations = installations.filter((i) => i.enrollmentState === "active");

  if (diagnostics.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (diagnostics.errorText) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {diagnostics.errorText}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <PlatformDetailSection title="درخواست بررسی">
        {can("support.diagnostics.request") ? (
          activeInstallations.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              نصب فعال و تأییدشده‌ای برای این کسب‌وکار وجود ندارد؛ درخواست تشخیص تا زمان ثبت نصب مسدود است.
            </p>
          ) : (
            <RequestDiagnosticsForm
              ticketId={ticketId}
              installations={activeInstallations}
              onDone={() => diagnostics.refetch()}
            />
          )
        ) : (
          <p className="text-xs text-muted-foreground">درخواست تشخیص نیازمند مجوز «درخواست تشخیص» است.</p>
        )}
      </PlatformDetailSection>

      <PlatformDetailSection title="درخواست‌ها و اجراها">
        {(diagnostics.data?.requests ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">درخواستی برای این تیکت ثبت نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {(diagnostics.data?.requests ?? []).map((item) => (
              <li key={item.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <PlatformStatusBadge
                    tone={stateTone(item.state)}
                    label={SUPPORT_REQUEST_STATE_LABELS[item.state as keyof typeof SUPPORT_REQUEST_STATE_LABELS] ?? item.state}
                  />
                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <FreshnessBadge at={item.createdAt} />
                    {fmtDateTime(item.createdAt)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">
                  ماژول‌ها: {item.modules.map((m) => SUPPORT_DIAGNOSTIC_MODULE_LABELS[m as keyof typeof SUPPORT_DIAGNOSTIC_MODULE_LABELS] ?? m).join("، ")}
                </p>
                {item.reason ? <p className="mt-1 text-xs text-foreground">{item.reason}</p> : null}
                {item.state === "pending" ? (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    در انتظار باز شدن همراه توسط مشتری — اجرا گزارش نشده است.
                  </p>
                ) : null}
                <RunsList runs={(diagnostics.data?.runs ?? []).filter((run) => run.requestId === item.id)} />
              </li>
            ))}
          </ul>
        )}
      </PlatformDetailSection>

      <PlatformDetailSection title="تعمیرهای مصوب">
        {can("support.repair.propose") ? (
          activeInstallations.length === 0 ? (
            <p className="text-xs text-muted-foreground">بدون نصب تأییدشده، پیشنهادی ثبت نمی‌شود.</p>
          ) : (
            <ProposeRepairForm
              ticketId={ticketId}
              installations={activeInstallations}
              catalog={repairs.data?.catalog ?? []}
              onDone={() => repairs.refetch()}
            />
          )
        ) : (
          <p className="text-xs text-muted-foreground">پیشنهاد تعمیر نیازمند مجوز «پیشنهاد تعمیر» است.</p>
        )}
        <div className="mt-3 space-y-2">
          {(repairs.data?.runs ?? []).map((run) => (
            <div key={run.id} className="rounded-lg border border-border bg-card p-3">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-foreground" dir="ltr">
                  {run.recipeId}@{run.recipeVersion}
                </span>
                <PlatformStatusBadge
                  tone={stateTone(run.state)}
                  label={SUPPORT_REPAIR_RUN_STATE_LABELS[run.state as keyof typeof SUPPORT_REPAIR_RUN_STATE_LABELS] ?? run.state}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {run.actor === "support_ai" ? "پیشنهاد هوش پشتیبانی" : "پیشنهاد اپراتور"} —{" "}
                {run.verification?.verified === true ? "راستی‌آزمایی موفق" : "بدون راستی‌آزمایی موفق"} —{" "}
                {fmtDateTime(run.updatedAt)}
              </p>
              {can("support.repair.execute") &&
              (run.state === "proposed" || run.state === "dry_run_ready" || run.state === "awaiting_approval") ? (
                <ApproveRepairButton ticketId={ticketId} runId={run.id} onDone={() => repairs.refetch()} />
              ) : null}
            </div>
          ))}
        </div>
      </PlatformDetailSection>
    </div>
  );
}

function RunsList({ runs }: { runs: DiagnosticRunDto[] }) {
  if (runs.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5 border-t border-border pt-2">
      {runs.map((run) => (
        <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <span className="text-foreground">
            {SUPPORT_RUN_STATE_LABELS[run.state as keyof typeof SUPPORT_RUN_STATE_LABELS] ?? run.state} —{" "}
            {run.findings.length} یافته — شدت {SUPPORT_SEVERITY_LABELS[run.severityOverall as keyof typeof SUPPORT_SEVERITY_LABELS] ?? run.severityOverall}
          </span>
          <span className="flex items-center gap-2 text-muted-foreground">
            {SUPPORT_UPLOAD_STATE_LABELS[run.uploadState as keyof typeof SUPPORT_UPLOAD_STATE_LABELS] ?? run.uploadState} —{" "}
            <FreshnessBadge at={run.receivedAt} />
            {fmtDateTime(run.receivedAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RequestDiagnosticsForm({
  ticketId,
  installations,
  onDone,
}: {
  ticketId: string;
  installations: WorkspaceInstallation[];
  onDone: () => void;
}) {
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [modules, setModules] = useState<string[]>([...SUPPORT_DIAGNOSTIC_MODULES]);
  const mutate = usePlatformMutation(`/api/platform/support/diagnostics`, {
    method: "POST",
    request: () => ({
      options: {
        body: JSON.stringify({
          ticketId,
          installationId,
          modules,
          reason: reason.trim(),
          idempotencyKey: typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}`,
        }),
      },
    }),
    successToast: "درخواست بررسی ثبت شد.",
    onSuccess: () => {
      setReason("");
      onDone();
    },
  });

  return (
    <div className="space-y-3 py-1">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">نصب تأییدشده</Label>
        <Select value={installationId} onValueChange={setInstallationId}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {installations.map((installation) => (
              <SelectItem key={installation.id} value={installation.id}>
                {installation.displayName || "نصب ویندوز"} — نسل {installation.generation}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] text-muted-foreground">ماژول‌ها</legend>
        <div className="flex flex-wrap gap-1.5">
          {SUPPORT_DIAGNOSTIC_MODULES.map((module) => {
            const on = modules.includes(module);
            return (
              <button
                key={module}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setModules((prev) => (on ? prev.filter((m) => m !== module) : [...prev, module]))
                }
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  on
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {SUPPORT_DIAGNOSTIC_MODULE_LABELS[module]}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">دلیل</Label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="چرا این بررسی لازم است؟"
          rows={2}
        />
      </div>
      <Button
        onClick={() => void mutate.mutate()}
        disabled={mutate.busy || !reason.trim() || !installationId}
        aria-busy={mutate.busy}
      >
        {mutate.busy ? "در حال ثبت…" : "ثبت درخواست بررسی"}
      </Button>
    </div>
  );
}

function ProposeRepairForm({
  ticketId,
  installations,
  catalog,
  onDone,
}: {
  ticketId: string;
  installations: WorkspaceInstallation[];
  catalog: RepairRecipeDto[];
  onDone: () => void;
}) {
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [recipe, setRecipe] = useState("");
  const mutate = usePlatformMutation(`/api/platform/support/repairs`, {
    method: "POST",
    request: () => ({
      options: {
        body: JSON.stringify({
          ticketId,
          installationId,
          recipeId: recipe.split("@")[0],
          recipeVersion: Number(recipe.split("@")[1] ?? NaN) || undefined,
        }),
      },
    }),
    successToast: "تعمیر پیشنهادی ثبت شد.",
    onSuccess: () => {
      setRecipe("");
      onDone();
    },
  });

  if (catalog.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        فهرست مصوب خالی است؛ انتشار دستور جدید نیازمند مجوز «انتشار فهرست تعمیر» است.
      </p>
    );
  }
  return (
    <div className="space-y-3 py-1">
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">نصب تأییدشده</Label>
        <Select value={installationId} onValueChange={setInstallationId}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {installations.map((installation) => (
              <SelectItem key={installation.id} value={installation.id}>
                {installation.displayName || "نصب ویندوز"} — نسل {installation.generation}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">دستور مصوب</Label>
        <Select value={recipe} onValueChange={setRecipe}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="انتخاب دستور…" />
          </SelectTrigger>
          <SelectContent>
            {catalog.map((entry) => (
              <SelectItem key={`${entry.recipeId}@${entry.version}`} value={`${entry.recipeId}@${entry.version}`}>
                {entry.title} — {SUPPORT_REPAIR_RISK_LABELS[entry.risk as keyof typeof SUPPORT_REPAIR_RISK_LABELS] ?? entry.risk}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button
        onClick={() => void mutate.mutate()}
        disabled={mutate.busy || !recipe || !installationId}
        aria-busy={mutate.busy}
      >
        {mutate.busy ? "در حال ثبت…" : "ثبت پیشنهاد تعمیر"}
      </Button>
    </div>
  );
}

function ApproveRepairButton({
  ticketId,
  runId,
  onDone,
}: {
  ticketId: string;
  runId: string;
  onDone: () => void;
}) {
  const mutate = usePlatformMutation(`/api/platform/support/repairs/${runId}`, {
    method: "POST",
    request: () => ({ options: { body: JSON.stringify({ ticketId, action: "approve" }) } }),
    successToast: "تعمیر مجاز شد؛ اجرا در همراه با رضایت مشتری.",
    errorMessages: { consent_missing: "رضایت مشتری برای تعمیر ثبت نشده است." },
    onSuccess: () => onDone(),
  });
  return (
    <Button
      variant="outline"
      size="sm"
      className="mt-2"
      onClick={() => void mutate.mutate()}
      disabled={mutate.busy}
      aria-busy={mutate.busy}
    >
      {mutate.busy ? "…" : "تأیید اجرا (نیازمند رضایت مشتری)"}
    </Button>
  );
}
