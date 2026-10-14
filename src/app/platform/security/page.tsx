"use client";

/**
 * Phase 24 Wave 2 — «امنیت» in the console.
 *
 * Three things the phase spec asks for and nothing in `/platform` provided:
 *
 *   1. **The enrolment readout.** "Who is enrolled, who is in grace and how
 *      long remains" — across both platform admins and the business Owners the
 *      requirement applies to. A deadline nobody can see is a deadline that
 *      surprises everybody on the same morning.
 *   2. **Grace extension, per account, audited.** The escape valve for the
 *      person whose stored mobile is wrong or who is away when the window
 *      closes — and deliberately *not* a platform-wide switch, so rescuing one
 *      person never quietly disarms the requirement for everyone.
 *   3. **The Kavenegar connection.** Previously env-var only; the key now lives
 *      encrypted in `platform_sms_config`, edited here, with the environment
 *      kept as the operator bootstrap fallback.
 *
 * Plus the admin's own enrolment, so the grace nag on the login screen has
 * somewhere to send them.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  errorMessage,
  fmtDate,
  useCan,
} from "../ui";

type Requirement = "not_required" | "grace" | "required";

interface MfaAccount {
  subjectRealm: "platform_user" | "platform_admin";
  subjectId: string;
  email: string;
  fullName: string;
  role: string;
  businesses: { id: string; name: string }[];
  methods: ("totp" | "sms_otp")[];
  enrolledAt: string | null;
  graceUntil: string | null;
  recoveryCodesRemaining: number;
  requirement: Requirement;
}

interface SelfStatus {
  subjectId: string;
  requirement: Requirement;
  graceUntil: string | null;
  graceDaysLeft: number | null;
  methods: { method: "totp" | "sms_otp"; isPrimary: boolean; phoneHint: string | null }[];
  recoveryCodesRemaining: number;
}

interface SmsConfig {
  hasStoredKey: boolean;
  keyHint: string | null;
  otpTemplate: string;
  fromEnvironment: boolean;
  configured: boolean;
  updatedAt: string | null;
}

const METHOD_LABELS: Record<string, string> = {
  totp: "برنامهٔ رمزساز",
  sms_otp: "پیامک",
};

const REQUIREMENT_BADGES: Record<Requirement, { label: string; cls: string }> = {
  not_required: {
    label: "فعال",
    cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  },
  grace: { label: "در مهلت", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" },
  required: { label: "مسدود تا فعال‌سازی", cls: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30" },
};

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

export default function PlatformSecurityPage() {
  const can = useCan();
  const canManage = can("admins.manage");
  const canManageSms = can("ai.config.manage");

  const [accounts, setAccounts] = useState<MfaAccount[] | null>(null);
  const [self, setSelf] = useState<SelfStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ accounts?: MfaAccount[]; self?: SelfStatus; error?: string }>(
      "/api/platform/mfa",
    );
    if (!ok) {
      setError(errorMessage(data.error));
      setAccounts([]);
      return;
    }
    setAccounts(data.accounts ?? []);
    setSelf(data.self ?? null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function extendGrace(account: MfaAccount, days: number) {
    setError(null);
    setInfo(null);
    const { ok, data } = await api<{ error?: string; graceDaysLeft?: number | null }>(
      "/api/platform/mfa",
      {
        method: "POST",
        body: JSON.stringify({
          action: "extend_grace",
          subjectRealm: account.subjectRealm,
          subjectId: account.subjectId,
          days,
        }),
      },
    );
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(`مهلت ${account.email} تمدید شد.`);
    await load();
  }

  async function resetOwner(account: MfaAccount) {
    setError(null);
    setInfo(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/mfa", {
      method: "POST",
      body: JSON.stringify({
        action: "reset",
        subjectRealm: account.subjectRealm,
        subjectId: account.subjectId,
      }),
    });
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(`ورود دومرحله‌ای ${account.email} بازنشانی شد و مهلت تازه‌ای گرفت.`);
    await load();
  }

  const admins = (accounts ?? []).filter((a) => a.subjectRealm === "platform_admin");
  const owners = (accounts ?? []).filter((a) => a.subjectRealm === "platform_user");
  const pending = (accounts ?? []).filter((a) => a.requirement !== "not_required");

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-lg font-bold text-foreground">امنیت</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          وضعیت ورود دومرحله‌ای مدیران سکو و مالکان کسب‌وکارها، و تنظیمات سرویس پیامک.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{info}</InfoBox>

      <SelfEnrolmentCard self={self} onChanged={load} />

      <Card title="خلاصه">
        {accounts === null ? (
          <SkeletonRows rows={1} />
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="حساب‌های مشمول" value={accounts.length} />
            <Stat label="فعال‌شده" value={accounts.length - pending.length} />
            <Stat label="در انتظار فعال‌سازی" value={pending.length} />
          </div>
        )}
      </Card>

      <AccountTable
        title="مدیران سکو"
        accounts={admins}
        loading={accounts === null}
        canManage={canManage}
        onExtend={extendGrace}
        // A super-admin's own factor is deliberately not resettable from the
        // console: see /api/platform/mfa, which refuses it. The way back in for
        // a locked-out admin is a recovery code or scripts/reset-platform-mfa.ts.
        onReset={null}
      />

      <AccountTable
        title="مالکان کسب‌وکارها"
        accounts={owners}
        loading={accounts === null}
        canManage={canManage}
        onExtend={extendGrace}
        onReset={canManage ? resetOwner : null}
      />

      {canManageSms ? <SmsConfigCard /> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-bold text-foreground">{toPersianDigits(String(value))}</p>
    </div>
  );
}

function AccountTable({
  title,
  accounts,
  loading,
  canManage,
  onExtend,
  onReset,
}: {
  title: string;
  accounts: MfaAccount[];
  loading: boolean;
  canManage: boolean;
  onExtend: (account: MfaAccount, days: number) => void;
  onReset: ((account: MfaAccount) => void) | null;
}) {
  return (
    <Card title={title}>
      {loading ? (
        <SkeletonRows rows={3} />
      ) : accounts.length === 0 ? (
        <EmptyState title="حسابی در این بخش نیست." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 text-start font-medium">حساب</th>
                <th className="py-2 text-start font-medium">نقش</th>
                <th className="py-2 text-start font-medium">روش</th>
                <th className="py-2 text-start font-medium">وضعیت</th>
                <th className="py-2 text-start font-medium">مهلت</th>
                <th className="py-2 text-start font-medium">کد بازیابی</th>
                {canManage ? <th className="py-2 text-start font-medium">اقدام</th> : null}
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const badge = REQUIREMENT_BADGES[a.requirement];
                const left = daysUntil(a.graceUntil);
                return (
                  <tr key={`${a.subjectRealm}:${a.subjectId}`} className="border-t border-border">
                    <td className="py-2.5 pe-3">
                      <div className="font-medium text-foreground">{a.fullName}</div>
                      <div dir="ltr" className="text-xs text-muted-foreground">
                        {a.email}
                      </div>
                      {a.businesses.length > 0 ? (
                        <div className="text-xs text-muted-foreground">
                          {a.businesses.map((b) => b.name).join("، ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2.5 pe-3 text-muted-foreground">{a.role}</td>
                    <td className="py-2.5 pe-3 text-muted-foreground">
                      {a.methods.length === 0
                        ? "—"
                        : a.methods.map((m) => METHOD_LABELS[m] ?? m).join(" + ")}
                    </td>
                    <td className="py-2.5 pe-3">
                      <span
                        className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.cls}`}
                      >
                        {badge.label}
                      </span>
                    </td>
                    <td className="py-2.5 pe-3 text-muted-foreground">
                      {a.requirement === "not_required"
                        ? "—"
                        : a.graceUntil
                          ? `${fmtDate(a.graceUntil)}${
                              left === null ? "" : ` (${toPersianDigits(String(left))} روز)`
                            }`
                          : "—"}
                    </td>
                    <td className="py-2.5 pe-3 text-muted-foreground">
                      {toPersianDigits(String(a.recoveryCodesRemaining))}
                    </td>
                    {canManage ? (
                      <td className="py-2.5">
                        <div className="flex flex-wrap gap-2">
                          {a.requirement !== "not_required" ? (
                            <Button variant="ghost" onClick={() => onExtend(a, 7)}>
                              تمدید ۷ روز
                            </Button>
                          ) : null}
                          {onReset ? (
                            <Button variant="danger" onClick={() => onReset(a)}>
                              بازنشانی
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/**
 * The signed-in admin's own second factor.
 *
 * Never capability-gated: an admin is always allowed to protect their own
 * account better, whatever their role. This is where the login screen's grace
 * nag lands.
 */
function SelfEnrolmentCard({ self }: { self: SelfStatus | null; onChanged: () => void }) {
  const enrolled = (self?.methods.length ?? 0) > 0;

  return (
    <Card title="وضعیت ورود دومرحله‌ای و امنیت حساب شما">
      {self === null ? (
        <SkeletonRows rows={1} />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-foreground">
          <div className="space-y-1">
            {enrolled ? (
              <>
                <p>
                  روش‌های فعال:{" "}
                  {self.methods
                    .map(
                      (m) =>
                        `${METHOD_LABELS[m.method] ?? m.method}${m.isPrimary ? " (روش اصلی)" : ""}${
                          m.phoneHint ? ` (${m.phoneHint})` : ""
                        }`,
                    )
                    .join(" + ")}
                </p>
                <p className="text-xs text-muted-foreground">
                  کدهای بازیابی باقی‌مانده: {toPersianDigits(String(self.recoveryCodesRemaining))}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {self.requirement === "required"
                  ? "مهلت فعال‌سازی تمام شده است؛ ورود بعدی شما تا فعال‌سازی مسدود می‌شود."
                  : self.graceDaysLeft !== null
                    ? `${toPersianDigits(String(self.graceDaysLeft))} روز تا اجباری‌شدن باقی مانده است.`
                    : "هنوز روش دومرحله‌ای تأییدشده‌ای فعال نکرده‌اید."}
              </p>
            )}
          </div>
          <a
            href="/platform/account"
            className="rounded-lg bg-sky-500 px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-sky-400"
          >
            مدیریت حساب و امنیت من
          </a>
        </div>
      )}
    </Card>
  );
}

/** The Kavenegar connection — owner-only, key never returned. */
function SmsConfigCard() {
  const [config, setConfig] = useState<SmsConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ config?: SmsConfig; error?: string }>("/api/platform/sms");
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setConfig(data.config ?? null);
    setTemplate(data.config?.otpTemplate ?? "");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(clearApiKey = false) {
    setBusy(true);
    setError(null);
    setInfo(null);
    const { ok, data } = await api<{ config?: SmsConfig; error?: string }>("/api/platform/sms", {
      method: "PUT",
      body: JSON.stringify({ apiKey: apiKey.trim() || undefined, otpTemplate: template, clearApiKey }),
    });
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "invalid_template"
          ? "نام الگو فقط می‌تواند شامل حروف انگلیسی، رقم، خط تیره و زیرخط باشد."
          : errorMessage(data.error),
      );
      return;
    }
    setApiKey("");
    setConfig(data.config ?? null);
    setInfo(clearApiKey ? "کلید ذخیره‌شده پاک شد." : "تنظیمات پیامک ذخیره شد.");
  }

  return (
    <Card title="سرویس پیامک (کاوه‌نگار)">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{info}</InfoBox>
      {config === null ? (
        <SkeletonRows rows={2} />
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {config.configured
              ? config.fromEnvironment
                ? `کلید فعال از متغیر محیطی KAVENEGAR_API_KEY خوانده می‌شود (${config.keyHint}).`
                : `کلید در پایگاه داده و رمزنگاری‌شده ذخیره شده است (${config.keyHint}).`
              : "هیچ کلیدی تنظیم نشده است؛ کدهای یک‌بارمصرف فقط در لاگ سرور نوشته می‌شوند و پیامکی ارسال نمی‌شود."}
            {config.updatedAt ? ` آخرین تغییر: ${fmtDate(config.updatedAt, true)}.` : ""}
          </p>
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field label="کلید API" hint="خالی بگذارید تا کلید فعلی تغییر نکند.">
              <input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config.hasStoredKey ? "بدون تغییر" : "کلید کاوه‌نگار"}
                className={inputClass}
              />
            </Field>
            <Field label="نام الگو (template)" hint="الگوی تأییدشدهٔ verify/lookup در پنل کاوه‌نگار.">
              <input
                dir="ltr"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
                placeholder="verify"
                className={inputClass}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => save(false)}>
              ذخیره
            </Button>
            {config.hasStoredKey ? (
              <Button variant="danger" disabled={busy} onClick={() => save(true)}>
                پاک‌کردن کلید ذخیره‌شده
              </Button>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}
