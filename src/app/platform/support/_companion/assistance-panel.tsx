"use client";

/**
 * Issue #984 — the ticket's «کمک راه‌دور» tab: request attended view/control
 * (view and control are separate grants), follow consent/lease truthfully,
 * and revoke. Approval happens locally in the companion; the browser never
 * grants itself capture or input.
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
  SUPPORT_ASSISTANCE_CAP_LABELS,
  SUPPORT_ASSISTANCE_CAPS,
  SUPPORT_ASSISTANCE_STATE_LABELS,
} from "@/lib/support-companion/types";
import type {
  AssistanceSessionDto,
  TicketSupportContext,
  WorkspaceInstallation,
} from "./types";

export function AssistancePanel({ ticketId }: { ticketId: string }) {
  const can = useCan();
  const context = usePlatformQuery<{ context: TicketSupportContext }>(
    `/api/platform/support/tickets/${ticketId}/context`,
    [ticketId],
  );
  const sessions = usePlatformQuery<{ sessions: AssistanceSessionDto[] }>(
    `/api/platform/support/assistance?ticketId=${ticketId}`,
    [ticketId],
  );

  const activeInstallations = (context.data?.context.installations ?? []).filter(
    (i) => i.enrollmentState === "active",
  );
  const canRequest = can("support.assist.view") || can("support.assist.control");

  if (sessions.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (sessions.errorText) {
    return <p className="text-sm text-red-600 dark:text-red-400">{sessions.errorText}</p>;
  }

  return (
    <div className="space-y-4">
      <PlatformDetailSection title="درخواست کمک راه‌دور">
        {!canRequest ? (
          <p className="text-xs text-muted-foreground">درخواست کمک راه‌دور نیازمند مجوز «مشاهده/کنترل راه‌دور» است.</p>
        ) : activeInstallations.length === 0 ? (
          <p className="text-xs text-muted-foreground">بدون نصب تأییدشده، درخواستی ثبت نمی‌شود.</p>
        ) : (
          <RequestAssistanceForm
            ticketId={ticketId}
            installations={activeInstallations}
            allowControl={can("support.assist.control")}
            onDone={() => sessions.refetch()}
          />
        )}
      </PlatformDetailSection>

      <PlatformDetailSection title="نشست‌ها">
        {(sessions.data?.sessions ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">نشستی برای این تیکت ثبت نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {(sessions.data?.sessions ?? []).map((item) => (
              <li key={item.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <PlatformStatusBadge
                    tone={
                      item.state === "active_view" || item.state === "active_control"
                        ? "success"
                        : item.state === "revoked" || item.state === "failed"
                          ? "danger"
                          : item.state === "ended" || item.state === "expired"
                            ? "neutral"
                            : "warning"
                    }
                    label={SUPPORT_ASSISTANCE_STATE_LABELS[item.state as keyof typeof SUPPORT_ASSISTANCE_STATE_LABELS] ?? item.state}
                  />
                  <span className="text-[11px] text-muted-foreground">{fmtDateTime(item.createdAt)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  درخواستی: {item.requestedCaps.map((c) => SUPPORT_ASSISTANCE_CAP_LABELS[c as keyof typeof SUPPORT_ASSISTANCE_CAP_LABELS] ?? c).join("، ")}
                  {item.approvedCaps.length > 0
                    ? ` — تأییدشده: ${item.approvedCaps.map((c) => SUPPORT_ASSISTANCE_CAP_LABELS[c as keyof typeof SUPPORT_ASSISTANCE_CAP_LABELS] ?? c).join("، ")}`
                    : ""}
                </p>
                {item.reason ? <p className="mt-1 text-xs text-foreground">{item.reason}</p> : null}
                {item.state === "requested" || item.state === "awaiting_local_consent" ? (
                  <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-400">
                    در انتظار تأیید محلی مشتری در همراه — دسترسی آغاز نشده است.
                  </p>
                ) : null}
                {item.leaseExpiresAt &&
                (item.state === "active_view" || item.state === "active_control") ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    انقضای لیز: {fmtDateTime(item.leaseExpiresAt)} (دوره {item.leaseEpoch})
                  </p>
                ) : null}
                {item.endReason ? (
                  <p className="mt-1 text-[11px] text-muted-foreground" dir="ltr">
                    پایان: {item.endReason}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-2">
                  {item.state === "approved" && canRequest ? (
                    <SessionActionButton
                      ticketId={ticketId}
                      sessionId={item.id}
                      action="join"
                      label="پیوستن (مرورگر)"
                      onDone={() => sessions.refetch()}
                    />
                  ) : null}
                  {(item.state === "connecting" ||
                    item.state === "active_view" ||
                    item.state === "active_control") &&
                  canRequest ? (
                    <SessionActionButton
                      ticketId={ticketId}
                      sessionId={item.id}
                      action="rejoin"
                      label="پیوستن دوباره"
                      onDone={() => sessions.refetch()}
                    />
                  ) : null}
                  {can("support.assist.revoke") &&
                  !["ended", "revoked", "expired", "failed"].includes(item.state) ? (
                    <SessionActionButton
                      ticketId={ticketId}
                      sessionId={item.id}
                      action="revoke"
                      label="باطل کردن"
                      onDone={() => sessions.refetch()}
                    />
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </PlatformDetailSection>
    </div>
  );
}

function RequestAssistanceForm({
  ticketId,
  installations,
  allowControl,
  onDone,
}: {
  ticketId: string;
  installations: WorkspaceInstallation[];
  allowControl: boolean;
  onDone: () => void;
}) {
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [caps, setCaps] = useState<string[]>(["view"]);
  const mutate = usePlatformMutation(`/api/platform/support/assistance`, {
    method: "POST",
    request: () => ({
      options: {
        body: JSON.stringify({ ticketId, installationId, requestedCaps: caps, reason: reason.trim() }),
      },
    }),
    successToast: "درخواست کمک راه‌دور ثبت شد؛ در انتظار تأیید محلی مشتری.",
    errorMessages: {
      mfa_required: "این عملیات نیازمند تأیید دومرحله‌ای تازه است.",
      session_already_live: "نشست فعالی برای این نصب وجود دارد.",
      provider_not_configured: "موتور راه‌دور هنوز انتخاب نشده است.",
    },
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
        <legend className="text-[11px] text-muted-foreground">قابلیت درخواستی (تأیید محلی جداگانه برای هر کدام)</legend>
        <div className="flex flex-wrap gap-1.5">
          {SUPPORT_ASSISTANCE_CAPS.map((cap) => {
            const disabled = cap !== "view" && !allowControl;
            const on = caps.includes(cap);
            return (
              <button
                key={cap}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                title={disabled ? "نیازمند مجوز «کنترل راه‌دور»" : undefined}
                onClick={() =>
                  setCaps((prev) => (on ? prev.filter((c) => c !== cap) : [...prev, cap]))
                }
                className={`rounded-full border px-2.5 py-1 text-[11px] disabled:opacity-40 ${
                  on
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {SUPPORT_ASSISTANCE_CAP_LABELS[cap]}
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
          placeholder="چرا کمک راه‌دور لازم است؟"
          rows={2}
        />
      </div>
      <Button
        onClick={() => void mutate.mutate()}
        disabled={mutate.busy || !reason.trim() || !installationId || caps.length === 0}
      >
        {mutate.busy ? "در حال ثبت…" : "ثبت درخواست"}
      </Button>
    </div>
  );
}

function SessionActionButton({
  ticketId,
  sessionId,
  action,
  label,
  onDone,
}: {
  ticketId: string;
  sessionId: string;
  action: "join" | "rejoin" | "revoke";
  label: string;
  onDone: () => void;
}) {
  const mutate = usePlatformMutation<void, { session?: unknown; operatorUrl?: unknown }>(
    `/api/platform/support/assistance/${sessionId}`,
    {
      method: "POST",
      request: () => ({ options: { body: JSON.stringify({ ticketId, action }) } }),
      successToast:
        action === "revoke"
          ? "نشست باطل شد."
          : action === "rejoin"
            ? "پیوند تازه ساخته شد؛ نمایشگر راه‌دور در زبانهٔ تازه باز می‌شود."
            : "پیوستن انجام شد؛ نمایشگر راه‌دور در زبانهٔ تازه باز می‌شود.",
      errorMessages: {
        mfa_required: "این عملیات نیازمند تأیید دومرحله‌ای تازه است.",
        provider_not_configured: "موتور راه‌دور هنوز انتخاب نشده است؛ نشستی آغاز نشد.",
        agent_not_linked: "عامل MeshCentral این نصب هنوز متصل نشده است.",
        lease_expired: "لیز نشست منقضی شده بود؛ نشست بسته شد و پیوستن دوباره ممکن نیست.",
      },
      onSuccess: (data) => {
        // Join/rejoin hand the one-time operator URL back — open the
        // provider's viewer immediately; the URL is never stored anywhere.
        if (
          (action === "join" || action === "rejoin") &&
          typeof data?.operatorUrl === "string" &&
          /^https?:\/\//.test(data.operatorUrl)
        ) {
          window.open(data.operatorUrl, "_blank", "noopener,noreferrer");
        }
        onDone();
      },
    },
  );
  return (
    <Button variant="outline" size="sm" onClick={() => void mutate.mutate()} disabled={mutate.busy}>
      {mutate.busy ? "…" : label}
    </Button>
  );
}
