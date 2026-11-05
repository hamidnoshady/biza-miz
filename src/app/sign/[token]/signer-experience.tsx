"use client";

/**
 * Issue #908 — the external signatory's flow, in four steps:
 *
 *  1. **read** the exact frozen document (never a draft);
 *  2. **acknowledge** it explicitly — a row on the server, not a local flag;
 *  3. **prove the phone** with a one-time code;
 *  4. **sign** by hand, and receive a receipt with the content hash.
 *
 * The page is mobile-first because of who uses it: a contractor on a phone, in a
 * car park, opening an SMS link. Every step states what happens next, the phone
 * number is shown masked (they told us the number; we do not reprint it), and
 * the document is the full frozen text — not a summary — because "I signed what
 * I was shown" is the only claim this system can honestly support.
 *
 * Failure is never dressed up: if no SMS provider is configured, the page says
 * so and explains who to contact, rather than showing "code sent" for a message
 * that never left the building.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, FileSignatureIcon, ShieldCheckIcon } from "lucide-react";
import { LoadingSkeleton, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import { ContractDocumentSheet } from "@/components/contracts/contract-document-sheet";
import {
  DELIVERY_REASON_LABELS,
  SIGNING_ERROR_MESSAGES,
} from "@/lib/contracts/labels";
import type {
  SigningReceipt,
  SigningSessionView,
  SubmitSignatureResult,
} from "@/lib/contracts/view";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { SignaturePad } from "./signature-pad";

function jalaliDateTime(value: string | null): string {
  if (!value) return "—";
  return formatJalali(value, { withMonthName: true, withTime: true });
}

function messageFor(code: string | undefined): string {
  if (!code) return "انجام این کار ممکن نشد؛ دوباره تلاش کنید.";
  return SIGNING_ERROR_MESSAGES[code] ?? "انجام این کار ممکن نشد؛ دوباره تلاش کنید.";
}

const STEPS = [
  { key: "review", label: "مطالعهٔ سند" },
  { key: "verify", label: "تأیید شمارهٔ همراه" },
  { key: "sign", label: "امضا و رسید" },
] as const;

export function SignerExperience({ token }: { token: string }) {
  const [session, setSession] = useState<SigningSessionView | null>(null);
  const [receipt, setReceipt] = useState<SigningReceipt | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [consent, setConsent] = useState(false);
  const [fullName, setFullName] = useState("");
  const [code, setCode] = useState("");
  const [drawn, setDrawn] = useState<string | null>(null);
  const [otpState, setOtpState] = useState<{ delivered: boolean; reason: string | null } | null>(null);
  const [result, setResult] = useState<SubmitSignatureResult | null>(null);
  const [declineOpen, setDeclineOpen] = useState(false);
  const [declineReason, setDeclineReason] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      session?: SigningSessionView;
      receipt?: SigningReceipt | null;
      error?: string;
    }>(`/api/sign/${token}`);
    setLoading(false);
    if (!ok) {
      setFatal(messageFor(data?.error));
      return;
    }
    setSession(data.session ?? null);
    setReceipt(data.receipt ?? null);
    if (data.session?.signer.fullName) setFullName(data.session.signer.fullName);
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    const { ok, data } = await api<Record<string, unknown> & { error?: string }>(
      `/api/sign/${token}`,
      { method: "POST", body: JSON.stringify(body) },
    );
    setBusy(false);
    if (!ok) {
      setError(messageFor(data?.error));
      return { ok: false as const, data };
    }
    setError("");
    return { ok: true as const, data };
  };

  if (loading) {
    return (
      <div className={`${cardClass} space-y-4 p-5`}>
        <LoadingSkeleton rows={2} label="در حال آماده‌سازی سند امضا" />
        <LoadingSkeleton rows={8} label="در حال بارگذاری متن سند" />
      </div>
    );
  }

  if (fatal) {
    return (
      <div className={`${cardClass} p-6`}>
        <h1 className="text-base font-semibold text-foreground">لینک امضا</h1>
        <p className="mt-2 text-sm text-muted-foreground">{fatal}</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={`${cardClass} p-6 text-sm text-muted-foreground`}>
        سندی برای نمایش پیدا نشد.
      </div>
    );
  }

  // The server's own state is the truth about whether a signature exists; the
  // local `result` only shortens the gap between POST and the refresh.
  const signedNow = result !== null || session.state === "receipt";
  const stepIndex = session.step === "review" ? 0 : signedNow ? 2 : 1;
  const document = session.document;

  return (
    <div className="space-y-4">
      <header className={`${cardClass} p-5 print:hidden`}>
        <p className="text-xs text-muted-foreground">{session.business.name}</p>
        <h1 className="mt-1 text-lg font-semibold text-foreground">{document.title || session.contract.title}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          نسخهٔ ثابت v{toPersianDigits(document.version)} · تاریخ ثابت‌شدن: {jalaliDateTime(document.frozenAt)} ·
          اثر انگشت محتوا: <span dir="ltr" className="font-mono">{document.contentHash.slice(0, 16)}…</span>
        </p>
        <ol className="mt-4 grid gap-2 sm:grid-cols-3">
          {STEPS.map((step, index) => {
            const done = index < stepIndex || signedNow;
            const current = index === stepIndex && !signedNow;
            return (
              <li
                key={step.key}
                className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${
                  done
                    ? "border-emerald-300/60 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100"
                    : current
                      ? "border-amber-300/60 bg-amber-50 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100"
                      : "border-border text-muted-foreground"
                }`}
              >
                <span className="font-mono">{toPersianDigits(index + 1)}</span>
                {step.label}
              </li>
            );
          })}
        </ol>
      </header>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? (
        <div role="status" aria-live="polite">
          <InfoBox>{notice}</InfoBox>
        </div>
      ) : null}

      {session.step === "closed" ? (
        <section className={`${cardClass} p-5`}>
          <h2 className="text-sm font-semibold text-foreground">این درخواست امضا بسته شده است</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {session.failure ? SIGNING_ERROR_MESSAGES[session.failure] : "این لینک دیگر قابل استفاده نیست."}
          </p>
        </section>
      ) : null}

      {session.step === "turn_pending" ? (
        <section className={`${cardClass} p-5`}>
          <h2 className="text-sm font-semibold text-foreground">نوبت شما هنوز نرسیده است</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            این قرارداد به‌ترتیب امضا می‌شود. پس از امضای طرف قبلی، پیامک تازه‌ای برای شما ارسال
            می‌شود. متن سند در همین صفحه برای مطالعه در دسترس است.
          </p>
        </section>
      ) : null}

      {/* The frozen document — the thing being signed. */}
      <ContractDocumentSheet content={session.document.content} values={session.document.content.values ?? {}} />

      {session.step === "review" ? (
        <section className={`${cardClass} p-5 print:hidden`}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldCheckIcon className="size-4" aria-hidden />
            تأیید مطالعهٔ سند
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {session.signer.fullName} عزیز، متن بالا همان نسخهٔ ثابت‌شدهٔ قرارداد است. با زدن دکمهٔ زیر
            تأیید می‌کنید که همهٔ آن را خوانده‌اید و با آن موافقید؛ سپس برای تأیید شمارهٔ همراه پیامک
            می‌گیرید.
          </p>
          <label className="mt-3 flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            متن این سند را کامل خواندم و با آن موافقم.
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <PrimaryButton
              disabled={!consent || busy}
              onClick={async () => {
                const response = await post({ action: "acknowledge", consent: true });
                if (response.ok) {
                  setConsent(false);
                  setNotice("تأیید مطالعه ثبت شد. برای دریافت کد، شمارهٔ همراه را تأیید کنید.");
                  await load();
                }
              }}
            >
              تأیید مطالعهٔ سند و ادامه
            </PrimaryButton>
            <SecondaryButton onClick={() => setDeclineOpen(true)} disabled={busy}>
              امضا نمی‌کنم
            </SecondaryButton>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            شمارهٔ همراه این دعوت: <span dir="ltr">{session.signer.maskedPhone}</span>
          </p>
        </section>
      ) : null}

      {session.step === "verify" && !signedNow ? (
        <section className={`${cardClass} space-y-4 p-5 print:hidden`}>
          <h2 className="text-sm font-semibold text-foreground">تأیید شمارهٔ همراه و امضا</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                کد تأیید به شمارهٔ <span dir="ltr">{session.signer.maskedPhone}</span> فرستاده می‌شود.
              </p>
              <SecondaryButton
                disabled={busy}
                onClick={async () => {
                  const response = await post({ action: "otp" });
                  if (!response.ok) return;
                  const delivered = Boolean(response.data?.delivered);
                  const reason = (response.data?.reason as string | null) ?? null;
                  setOtpState({ delivered, reason });
                  setNotice(
                    delivered
                      ? "کد تأیید فرستاده شد. پیامک تا یک دقیقه می‌رسد."
                      : (DELIVERY_REASON_LABELS[reason ?? ""] ??
                        "ارسال پیامک انجام نشد؛ با طرف قرارداد تماس بگیرید."),
                  );
                }}
              >
                دریافت کد تأیید
              </SecondaryButton>
              {otpState && !otpState.delivered ? (
                <p className="text-xs text-destructive">
                  ارسال پیامک ناموفق بود؛ با طرف قرارداد تماس بگیرید تا دوباره بفرستد.
                </p>
              ) : null}
            </div>
            <Field label="کد تأیید شش‌رقمی">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
          </div>

          <Field label="نام و نام خانوادگی امضاکننده">
            <input
              className={inputClass}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          </Field>

          <div>
            <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
              <FileSignatureIcon className="size-4" aria-hidden />
              امضای دست‌نویس
            </p>
            <SignaturePad onChange={setDrawn} disabled={busy} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <PrimaryButton
              disabled={busy || !code || !fullName.trim() || !drawn}
              onClick={async () => {
                const response = await post({
                  action: "sign",
                  code,
                  fullName,
                  drawnImage: drawn,
                });
                if (!response.ok) return;
                setResult({
                  signedAt: String(response.data.signedAt ?? new Date().toISOString()),
                  contentHash: String(response.data.contentHash ?? document.contentHash),
                  version: Number(response.data.version ?? document.version),
                  envelopeStatus: response.data.envelopeStatus as SubmitSignatureResult["envelopeStatus"],
                  completed: Boolean(response.data.completed),
                });
                setNotice(
                  response.data.completed
                    ? "امضای شما ثبت شد و این قرارداد کامل امضا شد."
                    : "امضای شما ثبت شد؛ قرارداد در انتظار امضای طرف‌های دیگر است.",
                );
                await load();
              }}
            >
              ثبت امضا
            </PrimaryButton>
            <span className="text-xs text-muted-foreground">
              با ثبت امضا، کد تأیید مصرف می‌شود و متن همین نسخه به امضای شما گره می‌خورد.
            </span>
          </div>
        </section>
      ) : null}

      {signedNow ? (
        <section className={`${cardClass} p-5 print:hidden`}>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <CheckCircle2Icon className="size-4" aria-hidden />
            رسید امضا
          </h2>
          <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">امضاکننده</dt>
              <dd className="text-foreground">{receipt?.fullName ?? session.signer.fullName}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">زمان امضا</dt>
              <dd className="text-foreground">
                {jalaliDateTime(result?.signedAt ?? receipt?.signedAt ?? session.signedAt)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">نسخهٔ سند</dt>
              <dd className="text-foreground">v{toPersianDigits(document.version)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">اثر انگشت محتوا (SHA-256)</dt>
              <dd dir="ltr" className="break-all font-mono text-[11px] text-foreground">
                {result?.contentHash ?? receipt?.contentHash ?? document.contentHash}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            وضعیت قرارداد: {session.progress.complete ? "همهٔ امضاها کامل شده است." : "در انتظار امضای طرف‌های دیگر."}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <SecondaryButton onClick={() => window.print()}>چاپ / ذخیرهٔ PDF این سند</SecondaryButton>
          </div>
        </section>
      ) : null}

      {declineOpen ? (
        <section className={`${cardClass} p-5 print:hidden`}>
          <h2 className="text-sm font-semibold text-foreground">امضا نمی‌کنم</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            با ثبت این پاسخ، درخواست امضا بسته می‌شود و طرف قرارداد مطلع می‌شود.
          </p>
          <Field label="دلیل (اختیاری)">
            <input
              className={inputClass}
              value={declineReason}
              onChange={(event) => setDeclineReason(event.target.value)}
            />
          </Field>
          <div className="mt-3 flex items-center gap-2">
            <SecondaryButton onClick={() => setDeclineOpen(false)}>انصراف</SecondaryButton>
            <PrimaryButton
              disabled={busy}
              onClick={async () => {
                const response = await post({ action: "decline", reason: declineReason });
                if (response.ok) {
                  setDeclineOpen(false);
                  await load();
                }
              }}
            >
              ثبت پاسخ و بستن درخواست
            </PrimaryButton>
          </div>
        </section>
      ) : null}
    </div>
  );
}
