"use client";

/**
 * Issue #984 — the ticket's «توکن حضوری» tab: the privileged on-site access
 * token builder. The issued plaintext appears ONCE (with a QR for the signed
 * offline token) for handoff to the visiting technician; the list below keeps
 * only fingerprints, scope, expiry and redemption state.
 */
import { useState } from "react";
import QRCode from "qrcode";
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
  SUPPORT_OPERATIONS,
  SUPPORT_OPERATION_LABELS,
  SUPPORT_TOKEN_PURPOSE_LABELS,
  SUPPORT_TOKEN_STATE_LABELS,
} from "@/lib/support-companion/types";
import type {
  AccessTokenDto,
  TicketSupportContext,
  WorkspaceInstallation,
} from "./types";

interface IssueResponse {
  record: AccessTokenDto;
  plaintext: string;
}

export function TokenPanel({ ticketId }: { ticketId: string }) {
  const can = useCan();
  const context = usePlatformQuery<{ context: TicketSupportContext }>(
    `/api/platform/support/tickets/${ticketId}/context`,
    [ticketId],
  );
  const tokens = usePlatformQuery<{ tokens: AccessTokenDto[] }>(
    `/api/platform/support/access-tokens?ticketId=${ticketId}`,
    [ticketId],
  );
  const [issued, setIssued] = useState<IssueResponse | null>(null);
  const [qr, setQr] = useState("");

  const activeInstallations = (context.data?.context.installations ?? []).filter(
    (i) => i.enrollmentState === "active",
  );

  async function showIssued(response: IssueResponse) {
    setIssued(response);
    if (response.record.purpose === "offline_onsite") {
      try {
        setQr(await QRCode.toDataURL(response.plaintext, { width: 220, margin: 1, errorCorrectionLevel: "M" }));
      } catch {
        setQr("");
      }
    } else {
      setQr("");
    }
  }

  if (tokens.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (tokens.errorText) {
    return <p className="text-sm text-red-600 dark:text-red-400">{tokens.errorText}</p>;
  }

  return (
    <div className="space-y-4">
      <PlatformDetailSection title="صدور توکن حضوری">
        {!can("support.token.issue") ? (
          <p className="text-xs text-muted-foreground">
            صدور توکن حضوری نیازمند مجوز «صدور توکن» و تأیید دومرحله‌ای تازه است.
          </p>
        ) : activeInstallations.length === 0 ? (
          <p className="text-xs text-muted-foreground">بدون نصب تأییدشده، توکنی صادر نمی‌شود.</p>
        ) : (
          <TokenBuilderForm
            ticketId={ticketId}
            installations={activeInstallations}
            onIssued={(response) => {
              void showIssued(response);
              tokens.refetch();
            }}
          />
        )}
      </PlatformDetailSection>

      {issued ? (
        <PlatformDetailSection title="توکن صادرشده — فقط همین یک‌بار نمایش داده می‌شود">
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <p className="text-xs text-amber-700 dark:text-amber-400">
              این متن را به تکنسین حاضر در محل تحویل دهید؛ پس از بستن، دیگر قابل بازیابی نیست و در
              تیکت ذخیره نمی‌شود.
            </p>
            {qr ? (
              <img src={qr} alt="کیوآر توکن حضوری" className="h-44 w-44 rounded bg-white p-1" />
            ) : null}
            <p className="break-all rounded bg-muted p-2 font-mono text-[11px] leading-5" dir="ltr">
              {issued.plaintext}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void navigator.clipboard?.writeText(issued.plaintext)}
              >
                کپی
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIssued(null);
                  setQr("");
                }}
              >
                پنهان کردن
              </Button>
            </div>
          </div>
        </PlatformDetailSection>
      ) : null}

      <PlatformDetailSection title="توکن‌های صادرشده">
        {(tokens.data?.tokens ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">توکنی برای این تیکت صادر نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {(tokens.data?.tokens ?? []).map((token) => (
              <li key={token.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs text-foreground">
                    {SUPPORT_TOKEN_PURPOSE_LABELS[token.purpose as keyof typeof SUPPORT_TOKEN_PURPOSE_LABELS] ?? token.purpose}
                  </span>
                  <PlatformStatusBadge
                    tone={token.state === "pending" ? "warning" : token.state === "revoked" || token.state === "expired" ? "danger" : "neutral"}
                    label={SUPPORT_TOKEN_STATE_LABELS[token.state as keyof typeof SUPPORT_TOKEN_STATE_LABELS] ?? token.state}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  دامنه: {token.scope.map((op) => SUPPORT_OPERATION_LABELS[op as keyof typeof SUPPORT_OPERATION_LABELS] ?? op).join("، ")}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {token.fingerprint.slice(0, 16)}… — انقضا {fmtDateTime(token.expiresAt)}
                </p>
                {token.reason ? <p className="mt-1 text-xs text-foreground">{token.reason}</p> : null}
                {(token.state === "pending" || token.state === "redeemed") && can("support.token.issue") ? (
                  <RevokeTokenButton ticketId={ticketId} tokenId={token.id} onDone={() => tokens.refetch()} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PlatformDetailSection>
    </div>
  );
}

function TokenBuilderForm({
  ticketId,
  installations,
  onIssued,
}: {
  ticketId: string;
  installations: WorkspaceInstallation[];
  onIssued: (response: IssueResponse) => void;
}) {
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [purpose, setPurpose] = useState("online_code");
  const [reason, setReason] = useState("");
  const [validityMinutes, setValidityMinutes] = useState("30");
  const [scope, setScope] = useState<string[]>(["diagnostics.run", "report.upload"]);
  const [technicianBindingHash, setTechnicianBindingHash] = useState("");
  const [challenge, setChallenge] = useState("");
  const mutate = usePlatformMutation<void, IssueResponse>(`/api/platform/support/access-tokens`, {
    method: "POST",
    request: () => ({
      options: {
        body: JSON.stringify({
          ticketId,
          installationId,
          purpose,
          requestedScope: scope,
          reason: reason.trim(),
          validityMinutes: Number(validityMinutes) || 30,
          technicianBindingHash: technicianBindingHash.trim(),
          challenge: challenge.trim(),
        }),
      },
    }),
    successToast: "توکن صادر شد؛ متن آن را فقط همین‌جا تحویل بگیرید.",
    errorMessages: {
      mfa_required: "صدور توکن نیازمند تأیید دومرحله‌ای تازه است.",
      scope_empty: "دامنه درخواستی خارج از اختیارات شماست.",
      signing_unavailable: "کلید امضای توکن روی سرور پیکربندی نشده است.",
    },
    onSuccess: (data) => {
      setReason("");
      setTechnicianBindingHash("");
      setChallenge("");
      onIssued(data);
    },
  });

  return (
    <div className="space-y-3 py-1">
      <div className="grid gap-3 sm:grid-cols-2">
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
          <Label className="text-[11px] text-muted-foreground">نوع توکن</Label>
          <Select value={purpose} onValueChange={setPurpose}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="online_code">{SUPPORT_TOKEN_PURPOSE_LABELS.online_code}</SelectItem>
              <SelectItem value="offline_onsite">{SUPPORT_TOKEN_PURPOSE_LABELS.offline_onsite}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-[11px] text-muted-foreground">دامنه (حداکثر، اختیارات شما)</legend>
        <div className="flex flex-wrap gap-1.5">
          {SUPPORT_OPERATIONS.map((op) => {
            const on = scope.includes(op);
            return (
              <button
                key={op}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setScope((prev) => (on ? prev.filter((o) => o !== op) : [...prev, op]))
                }
                className={`rounded-full border px-2.5 py-1 text-[11px] ${
                  on
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground"
                }`}
              >
                {SUPPORT_OPERATION_LABELS[op]}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">اعتبار (دقیقه، حداکثر ۴۸۰)</Label>
          <Select value={validityMinutes} onValueChange={setValidityMinutes}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["15", "30", "60", "120", "480"].map((minutes) => (
                <SelectItem key={minutes} value={minutes}>
                  {minutes} دقیقه
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {purpose === "offline_onsite" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">اثر کلید تکنسین</Label>
            <Textarea
              value={technicianBindingHash}
              onChange={(e) => setTechnicianBindingHash(e.target.value)}
              placeholder="اثر انگشت کلید دستگاه تکنسین"
              rows={2}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-[11px] text-muted-foreground">چالش نصب</Label>
            <Textarea
              value={challenge}
              onChange={(e) => setChallenge(e.target.value)}
              placeholder="نانس تازه نصب هدف"
              rows={2}
            />
          </div>
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-[11px] text-muted-foreground">دلیل</Label>
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="چرا این توکن صادر می‌شود؟"
          rows={2}
        />
      </div>
      <Button
        onClick={() => void mutate.mutate()}
        disabled={mutate.busy || !reason.trim() || !installationId || scope.length === 0}
      >
        {mutate.busy ? "در حال صدور…" : "صدور توکن"}
      </Button>
    </div>
  );
}

function RevokeTokenButton({
  ticketId,
  tokenId,
  onDone,
}: {
  ticketId: string;
  tokenId: string;
  onDone: () => void;
}) {
  const mutate = usePlatformMutation(`/api/platform/support/access-tokens/${tokenId}`, {
    method: "POST",
    request: () => ({ options: { body: JSON.stringify({ ticketId, action: "revoke" }) } }),
    successToast: "توکن باطل شد.",
    onSuccess: () => onDone(),
  });
  return (
    <Button variant="outline" size="sm" className="mt-2" onClick={() => void mutate.mutate()} disabled={mutate.busy}>
      {mutate.busy ? "…" : "باطل کردن"}
    </Button>
  );
}
