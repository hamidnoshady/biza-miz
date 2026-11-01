"use client";

/**
 * Issue #908 — the signing preparation and tracking panel.
 *
 * Two states, and they are genuinely different screens:
 *
 *  - **draft** (nothing sent): the sender names the signatories, assigns each
 *    one a signature placement from the document, chooses parallel/sequential
 *    and the link lifetime. «ارسال برای امضا» freezes the document FIRST and
 *    refuses while anything is unresolved, so an incomplete document cannot
 *    reach a signer by this path.
 *  - **live** (sent / partially signed): the list becomes evidence — who was
 *    invited, who opened it, who signed — with per-signer resend and a fresh
 *    single-use link the sender can pass on when the SMS gateway is not
 *    configured. Changing who signs now requires cancelling, which is stated on
 *    the button rather than discovered afterwards.
 *
 * Delivery is never faked: the API reports `delivered: false` with a reason when
 * no SMS line is configured, and this panel shows that reason and the link.
 */
import { useState } from "react";
import { CopyIcon, SendIcon, XCircleIcon } from "lucide-react";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  KpiCard,
  KpiRow,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import {
  DELIVERY_REASON_LABELS,
  ENVELOPE_STATUS_LABELS,
  SIGNER_STATUS_LABELS,
  SIGNING_EVENT_LABELS,
  SIGNING_MODE_LABELS,
} from "@/lib/contracts/labels";
import type { ContractSigningMode, ContractSignerStatus, MessageDelivery } from "@/lib/contracts/view";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { DateField, WorkspaceFormDialog } from "../../workspace-ui";
import { contractError, EnvelopeBadge, type SigningResponse } from "./contract-workspace";

interface DraftSigner {
  key: string;
  fullName: string;
  phone: string;
  roleLabel: string;
  slotId: string;
  required: boolean;
  deadline: string;
}

function signerTone(status: ContractSignerStatus): "positive" | "danger" | "active" | "neutral" {
  if (status === "signed") return "positive";
  if (status === "declined" || status === "expired") return "danger";
  if (status === "opened" || status === "acknowledged" || status === "invited") {
    return "active";
  }
  return "neutral";
}

function jalaliDateTime(value: string | null): string {
  if (!value) return "—";
  return formatJalali(value, { withMonthName: true, withTime: true });
}

export function SigningPanel({
  data,
  onChanged,
}: {
  data: SigningResponse;
  onChanged: () => Promise<void> | void;
}) {
  const { overview, slots } = data;
  const envelope = overview.envelope;
  const live = envelope?.status === "sent" || envelope?.status === "partially_signed";
  const firstSlot = slots[0]?.slotId ?? "";
  const [mode, setMode] = useState<ContractSigningMode>(envelope?.signingMode ?? "parallel");
  const [expiresInDays, setExpiresInDays] = useState(14);
  const [signers, setSigners] = useState<DraftSigner[]>(() =>
    overview.signers.length > 0
      ? overview.signers.map((signer) => ({
          key: signer.id,
          fullName: signer.fullName,
          phone: signer.phoneE164.replace(/^\+98/, "0"),
          roleLabel: signer.roleLabel,
          slotId: signer.slotId,
          required: signer.required,
          deadline: signer.deadline ?? "",
        }))
      : [{ key: "s1", fullName: "", phone: "", roleLabel: "", slotId: firstSlot, required: true, deadline: "" }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deliveries, setDeliveries] = useState<MessageDelivery[]>([]);
  const [confirmSend, setConfirmSend] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const updateSigner = (key: string, patch: Partial<DraftSigner>) => {
    setSigners((current) => current.map((signer) => (signer.key === key ? { ...signer, ...patch } : signer)));
  };

  const addSigner = () => {
    const used = new Set(signers.map((signer) => signer.slotId));
    const nextSlot = slots.find((slot) => !used.has(slot.slotId))?.slotId ?? firstSlot;
    setSigners((current) => [
      ...current,
      {
        key: `s${current.length + 1}_${Math.random().toString(36).slice(2, 6)}`,
        fullName: "",
        phone: "",
        roleLabel: "",
        slotId: nextSlot,
        required: true,
        deadline: "",
      },
    ]);
  };

  const payload = {
    signingMode: mode,
    expiresInDays,
    signers: signers.map((signer, index) => ({
      fullName: signer.fullName,
      phone: signer.phone,
      roleLabel: signer.roleLabel,
      slotId: signer.slotId,
      order: index + 1,
      required: signer.required,
      deadline: signer.deadline || null,
    })),
  };

  const saveDraft = async () => {
    setBusy(true);
    const { ok, data: result } = await api<{ error?: string }>(
      `/api/workspace/contracts/${data.contract.id}/signing`,
      { method: "PUT", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok) {
      setError(contractError(result?.error));
      return;
    }
    setError("");
    setNotice("فهرست امضاکنندگان ذخیره شد.");
    await onChanged();
  };

  const send = async () => {
    setConfirmSend(false);
    setBusy(true);
    const { ok, data: result } = await api<{
      deliveries?: MessageDelivery[];
      version?: { version: number };
      error?: string;
    }>(`/api/workspace/contracts/${data.contract.id}/signing`, {
      method: "POST",
      body: JSON.stringify({ action: "send", ...payload }),
    });
    setBusy(false);
    if (!ok) {
      setError(contractError(result?.error));
      return;
    }
    setError("");
    setDeliveries(result.deliveries ?? []);
    setNotice(
      `نسخهٔ ثابت v${toPersianDigits(result.version?.version ?? 1)} برای امضا ارسال شد.`,
    );
    await onChanged();
  };

  const resend = async (signerId: string, channel: "sms" | "link") => {
    setBusy(true);
    const { ok, data: result } = await api<{ delivery?: MessageDelivery; error?: string }>(
      `/api/workspace/contracts/${data.contract.id}/signing`,
      { method: "POST", body: JSON.stringify({ action: "resend", signerId, channel }) },
    );
    setBusy(false);
    if (!ok || !result.delivery) {
      setError(contractError(result?.error));
      return;
    }
    setError("");
    const delivery = result.delivery;
    setDeliveries((current) => [...current.filter((item) => item.signerId !== signerId), delivery]);
    setNotice(
      channel === "link"
        ? "لینک تازه ساخته شد؛ لینک قبلی همین امضاکننده دیگر کار نمی‌کند."
        : result.delivery.delivered
          ? "پیامک دعوت دوباره ارسال شد."
          : DELIVERY_REASON_LABELS[result.delivery.reason ?? ""] ?? "ارسال پیامک انجام نشد.",
    );
    await onChanged();
  };

  const cancel = async () => {
    setBusy(true);
    const { ok, data: result } = await api<{ error?: string }>(
      `/api/workspace/contracts/${data.contract.id}/signing`,
      { method: "POST", body: JSON.stringify({ action: "cancel", reason: cancelReason }) },
    );
    setBusy(false);
    setCancelOpen(false);
    if (!ok) {
      setError(contractError(result?.error));
      return;
    }
    setError("");
    setNotice("درخواست امضا لغو شد. متن را اصلاح کنید و دوباره بفرستید.");
    await onChanged();
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <KpiRow>
        <KpiCard
          label="وضعیت پاکت امضا"
          value={envelope ? ENVELOPE_STATUS_LABELS[envelope.status] : "ساخته نشده"}
          hint={envelope ? `نسخهٔ ارسالی: v${toPersianDigits(envelope.documentVersion ?? 1)}` : "فهرست امضاکنندگان را تنظیم کنید"}
        />
        <KpiCard
          label="پیشرفت امضا"
          value={`${toPersianDigits(overview.progress.signed)} از ${toPersianDigits(overview.progress.required)}`}
          hint="فقط امضاهای الزامی شمرده می‌شوند"
        />
        <KpiCard
          label="مهلت لینک‌ها"
          value={envelope?.expiresAt ? jalaliDateTime(envelope.expiresAt) : "—"}
          hint="پس از این زمان لینک‌ها باطل می‌شوند"
        />
        <KpiCard
          label="روش امضا"
          value={SIGNING_MODE_LABELS[mode].split(" ")[0]}
          hint={SIGNING_MODE_LABELS[mode]}
        />
      </KpiRow>

      {overview.draftAheadOfFrozen ? (
        <InfoBox>
          پیش‌نویس سند از نسخهٔ ارسال‌شده جدیدتر است. امضاکنندگان همان نسخهٔ ثابت‌شده را می‌بینند؛
          برای ارسال متن تازه، این درخواست را لغو کنید و دوباره بفرستید.
        </InfoBox>
      ) : null}

      <SectionCard
        title={live ? "امضاکنندگان" : "تنظیم امضاکنندگان"}
        description={
          live
            ? "این فهرست ثابت است. برای تغییر افراد یا متن، درخواست فعلی را لغو کنید."
            : "هر امضاکننده به یکی از جای‌های امضای سند تخصیص می‌یابد؛ شمارهٔ همراه باید شمارهٔ موبایل باشد."
        }
        actions={
          live ? (
            <SecondaryButton onClick={() => setCancelOpen(true)} disabled={busy}>
              <XCircleIcon className="me-1 inline size-3.5" aria-hidden /> لغو درخواست امضا
            </SecondaryButton>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <SecondaryButton onClick={saveDraft} disabled={busy}>
                ذخیرهٔ فهرست
              </SecondaryButton>
              <PrimaryButton
                onClick={() => setConfirmSend(true)}
                disabled={busy || signers.length === 0 || slots.length === 0}
              >
                <SendIcon className="me-1 inline size-3.5" aria-hidden /> ارسال برای امضا
              </PrimaryButton>
            </div>
          )
        }
      >
        {live ? (
          <ul className="divide-y divide-border">
            {overview.signers.map((signer) => {
              const delivery = deliveries.find((item) => item.signerId === signer.id);
              return (
                <li key={signer.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      {signer.fullName}
                      <StatusBadge tone={signerTone(signer.status)}>
                        {SIGNER_STATUS_LABELS[signer.status]}
                      </StatusBadge>
                      {signer.required ? null : (
                        <StatusBadge tone="neutral">غیرالزامی</StatusBadge>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {signer.roleLabel ? `${signer.roleLabel} · ` : ""}
                      <span dir="ltr">{signer.maskedPhone}</span> · نوبت {toPersianDigits(signer.signOrder)} ·
                      جای امضا <span className="font-mono">{signer.slotId}</span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      دعوت: {jalaliDateTime(signer.invitedAt)} · مشاهده: {jalaliDateTime(signer.openedAt)} ·
                      امضا: {jalaliDateTime(signer.signedAt)}
                      {signer.declinedAt ? ` · رد: ${jalaliDateTime(signer.declinedAt)}` : ""}
                    </p>
                    {signer.declineReason ? (
                      <p className="mt-1 text-[11px] text-destructive">دلیل رد: {signer.declineReason}</p>
                    ) : null}
                    {delivery ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {delivery.delivered
                          ? "پیامک ارسال شد."
                          : DELIVERY_REASON_LABELS[delivery.reason ?? ""] ?? "ارسال انجام نشد."}
                      </p>
                    ) : null}
                    {delivery?.url ? <LinkBox url={delivery.url} /> : null}
                  </div>
                  {signer.status === "signed" || signer.status === "declined" ? null : (
                    <div className="flex flex-wrap items-center gap-2">
                      <SecondaryButton onClick={() => void resend(signer.id, "sms")} disabled={busy}>
                        ارسال دوبارهٔ پیامک
                      </SecondaryButton>
                      <SecondaryButton onClick={() => void resend(signer.id, "link")} disabled={busy}>
                        <CopyIcon className="me-1 inline size-3.5" aria-hidden /> لینک تازه
                      </SecondaryButton>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="روش امضا">
                <select
                  className={inputClass}
                  value={mode}
                  onChange={(event) => setMode(event.target.value as ContractSigningMode)}
                >
                  {(Object.keys(SIGNING_MODE_LABELS) as ContractSigningMode[]).map((key) => (
                    <option key={key} value={key}>
                      {SIGNING_MODE_LABELS[key]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="مهلت لینک (روز)" hint={`حداکثر ${toPersianDigits(data.expiresInDaysMax)} روز`}>
                {/* The design-system numeric control: localized digits, and it
                    clamps to the server's own maximum before the request goes
                    out, so the sender sees the boundary instead of a 400. */}
                <PersianNumberInput
                  className={inputClass}
                  value={String(expiresInDays)}
                  onChange={(event) => {
                    const next = Number(event.target.value.replace(/[^0-9۰-۹]/g, "") || 0);
                    setExpiresInDays(Math.min(Math.max(next, 1), data.expiresInDaysMax));
                  }}
                />
              </Field>
            </div>

            <div className="space-y-3">
              {signers.map((signer, index) => (
                <div key={signer.key} className="rounded-xl border border-border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-xs font-semibold text-foreground">
                      امضاکنندهٔ {toPersianDigits(index + 1)}
                    </p>
                    <button
                      type="button"
                      className="text-[11px] font-medium text-destructive hover:underline disabled:opacity-40"
                      disabled={signers.length === 1}
                      onClick={() => setSigners((current) => current.filter((item) => item.key !== signer.key))}
                    >
                      حذف
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <Field label="نام و نام خانوادگی">
                      <input
                        className={inputClass}
                        value={signer.fullName}
                        onChange={(event) => updateSigner(signer.key, { fullName: event.target.value })}
                      />
                    </Field>
                    <Field label="شمارهٔ همراه" hint="مثال: ۰۹۱۲۳۴۵۶۷۸۹">
                      <input
                        className={inputClass}
                        dir="ltr"
                        inputMode="tel"
                        value={signer.phone}
                        onChange={(event) => updateSigner(signer.key, { phone: event.target.value })}
                      />
                    </Field>
                    <Field label="سمت / نقش">
                      <input
                        className={inputClass}
                        placeholder="کارفرما، پیمان‌کار، شاهد…"
                        value={signer.roleLabel}
                        onChange={(event) => updateSigner(signer.key, { roleLabel: event.target.value })}
                      />
                    </Field>
                    <Field label="جای امضا در سند">
                      <select
                        className={inputClass}
                        value={signer.slotId}
                        onChange={(event) => updateSigner(signer.key, { slotId: event.target.value })}
                      >
                        {slots.map((slot) => (
                          <option key={slot.slotId} value={slot.slotId}>
                            {slot.label || slot.slotId}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <DateField
                      label="مهلت امضا (اختیاری)"
                      value={signer.deadline}
                      onChange={(next) => updateSigner(signer.key, { deadline: next })}
                    />
                    <label className="flex items-end gap-2 pb-2 text-xs text-foreground">
                      <input
                        type="checkbox"
                        checked={signer.required}
                        onChange={(event) => updateSigner(signer.key, { required: event.target.checked })}
                      />
                      امضای این شخص الزامی است
                    </label>
                  </div>
                </div>
              ))}
              <SecondaryButton onClick={addSigner} disabled={signers.length >= 10}>
                افزودن امضاکننده
              </SecondaryButton>
            </div>
          </div>
        )}
      </SectionCard>

      <SectionCard title="گاه‌شمار امضا" description="هر رویداد با زمان شمسی؛ این فهرست قابل ویرایش نیست.">
        {overview.events.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز رویدادی ثبت نشده است.</p>
        ) : (
          <ol className="space-y-2">
            {overview.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                <span className="text-foreground">
                  {SIGNING_EVENT_LABELS[event.kind] ?? event.label}
                  {event.signerName ? ` — ${event.signerName}` : ""}
                </span>
                <span className="text-muted-foreground">{jalaliDateTime(event.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
      </SectionCard>

      {confirmSend ? (
        <WorkspaceFormDialog title="ارسال برای امضا" width="lg" onClose={() => setConfirmSend(false)}>
          <div className="space-y-3 p-4">
            <p className="text-sm text-foreground">
              با تأیید، متن فعلی سند به‌صورت یک نسخهٔ ثابت درمی‌آید و برای
              {" "}
              {toPersianDigits(signers.length)}
              {" "}
              امضاکننده لینک اختصاصی ساخته می‌شود. پس از این مرحله تغییر متن روی همین درخواست ممکن
              نیست.
            </p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {signers.map((signer, index) => (
                <li key={signer.key}>
                  {toPersianDigits(index + 1)}. {signer.fullName || "بدون نام"} —{" "}
                  <span dir="ltr">{signer.phone || "بدون شماره"}</span> — {SIGNING_MODE_LABELS[mode]}
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              اعتبار لینک‌ها {toPersianDigits(expiresInDays)} روز است. ارسال پیامک از سرویس پیامک
              پلتفرم انجام می‌شود؛ اگر خط ارسال تنظیم نشده باشد، لینک‌ها همین‌جا نشان داده می‌شوند تا
              خودتان بفرستید.
            </p>
            <div className="flex items-center justify-end gap-2">
              <SecondaryButton onClick={() => setConfirmSend(false)}>انصراف</SecondaryButton>
              <PrimaryButton onClick={() => void send()} disabled={busy}>
                تأیید و ارسال
              </PrimaryButton>
            </div>
          </div>
        </WorkspaceFormDialog>
      ) : null}

      {cancelOpen ? (
        <WorkspaceFormDialog title="لغو درخواست امضا" width="lg" onClose={() => setCancelOpen(false)}>
          <div className="space-y-3 p-4">
            <p className="text-sm text-foreground">
              با لغو، همهٔ لینک‌ها باطل می‌شوند. امضاهای ثبت‌شده پاک نمی‌شوند، اما این درخواست دیگر
              امضاپذیر نیست.
            </p>
            <Field label="دلیل لغو (اختیاری)">
              <input
                className={inputClass}
                value={cancelReason}
                onChange={(event) => setCancelReason(event.target.value)}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <SecondaryButton onClick={() => setCancelOpen(false)}>انصراف</SecondaryButton>
              <PrimaryButton onClick={() => void cancel()} disabled={busy}>
                لغو درخواست
              </PrimaryButton>
            </div>
          </div>
        </WorkspaceFormDialog>
      ) : null}
    </div>
  );
}

/** One link, shown once, with a copy action. Never reconstructed from the DB. */
function LinkBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-muted/60 p-2">
      <code dir="ltr" className="min-w-0 flex-1 truncate text-[11px] text-foreground">
        {url}
      </code>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-foreground hover:bg-muted"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            setCopied(false);
          }
        }}
      >
        <CopyIcon className="size-3" aria-hidden />
        {copied ? "کپی شد" : "کپی لینک"}
      </button>
    </div>
  );
}
