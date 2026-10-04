"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import {
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  api,
  errorMessage,
  fmtDate,
  inputClass,
  selectClass,
} from "../ui";

interface Admin {
  id: string;
  email: string;
  fullName: string;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  mfaMethods: string[];
  activeSessionsCount: number;
}

const ROLE_DESCRIPTIONS: Record<PlatformAdminRole, string> = {
  owner: "دسترسی کامل به تمام بخش‌ها، مدیریت مدیران و کلیدهای سکو.",
  engineer: "کسب‌وکارها، وضعیت سیستم، صورت‌حساب، صف‌ها و نسخه‌ها.",
  support: "جست‌وجوی کسب‌وکارها و ورود کمکی زمان‌دار.",
};

function adminErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    email_exists: "این ایمیل قبلاً برای مدیر دیگری ثبت شده است.",
    last_platform_owner: "نمی‌توان آخرین مالک فعال سکو را غیرفعال کرد یا نقش او را تغییر داد.",
    cannot_deactivate_self: "نمی‌توانید حساب خودتان را غیرفعال کنید.",
    recent_auth_required: "برای انجام این عملیات حساس، ابتدا هویت خود را مجدداً تأیید کنید.",
    invalid_role: "نقش انتخاب‌شده معتبر نیست.",
  };
  return (code && map[code]) || errorMessage(code);
}

export default function AdminsPage() {
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issuedResetUrl, setIssuedResetUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createRole, setCreateRole] = useState<PlatformAdminRole>("support");
  const [createPassword, setCreatePassword] = useState("");

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [pendingAction, setPendingAction] = useState<Record<string, unknown> | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ admins: Admin[]; error?: string }>("/api/platform/admins");
    if (!ok) {
      setError(adminErrorMessage(data.error));
      setAdmins([]);
      return;
    }
    setAdmins(data.admins);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setIssuedResetUrl(null);
    const { ok, status, data } = await api<{
      ok?: boolean;
      error?: string;
      resetUrl?: string | null;
    }>("/api/platform/admins", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setPendingAction(body);
        setStepUpOpen(true);
        return false;
      }
      setError(adminErrorMessage(data.error));
      return false;
    }
    if (data.resetUrl) {
      setIssuedResetUrl(data.resetUrl);
    }
    if (body.action === "create") {
      setNotice("مدیر جدید سکو با موفقیت ایجاد شد.");
    } else if (body.action === "revoke_sessions") {
      setNotice("تمام نشست‌های فعال و ورودهای کمکی این مدیر بلافاصله باطل شدند.");
    } else if (body.action === "send_password_reset") {
      setNotice("لینک یک‌بارمصرف بازیابی رمز عبور برای این مدیر صادر شد.");
    } else {
      setNotice("تغییرات با موفقیت ذخیره شد.");
    }
    await load();
    return true;
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const ok = await mutate({
      action: "create",
      email: createEmail.trim().toLowerCase(),
      fullName: createName.trim(),
      role: createRole,
      password: createPassword || undefined,
    });
    if (ok) {
      setCreateEmail("");
      setCreateName("");
      setCreatePassword("");
    }
  }

  async function submitStepUp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok } = await api("/api/platform/auth/step-up", {
      method: "POST",
      body: JSON.stringify({ password: stepUpPassword }),
    });
    setBusy(false);
    if (!ok) {
      setError("رمز عبور واردشده نادرست است.");
      return;
    }
    setStepUpOpen(false);
    setStepUpPassword("");
    const retry = pendingAction;
    setPendingAction(null);
    if (retry) {
      await mutate(retry);
    }
  }

  const roles = Object.keys(PLATFORM_ROLE_LABELS) as PlatformAdminRole[];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">مدیران سکو</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            فهرست، ایجاد، تغییر نقش، تعلیق، ابطال نشست‌ها و بازیابی امن رمز عبور اپراتورهای کنسول مدیریت سکو.
          </p>
        </div>
        <a
          href="/platform/account"
          className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-muted"
        >
          حساب کاربری و امنیت من
        </a>
      </header>

      <ErrorBox>{error}</ErrorBox>
      <InfoBox>{notice}</InfoBox>

      {issuedResetUrl ? (
        <Card title="لینک یک‌بارمصرف تنظیم / بازیابی رمز عبور">
          <p className="mb-2 text-xs text-muted-foreground">
            این لینک فقط یک بار نمایش داده می‌شود و به مدت محدود معتبر است.
          </p>
          <input
            dir="ltr"
            readOnly
            value={issuedResetUrl}
            onFocus={(e) => e.currentTarget.select()}
            className={`${inputClass} font-mono text-xs`}
          />
        </Card>
      ) : null}

      {stepUpOpen ? (
        <Card title="تأیید مجدد هویت برای تغییر دسترسی مدیران سکو">
          <form onSubmit={submitStepUp} className="space-y-3">
            <Field label="رمز عبور فعلی شما">
              <input
                type="password"
                dir="ltr"
                required
                value={stepUpPassword}
                onChange={(e) => setStepUpPassword(e.target.value)}
                className={inputClass}
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" disabled={busy || !stepUpPassword}>
                تأیید و ادامه
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setStepUpOpen(false);
                  setPendingAction(null);
                }}
              >
                انصراف
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      <Card title="افزودن مدیر جدید سکو">
        <p className="mb-4 text-xs text-muted-foreground">
          در صورت خالی گذاشتن رمز اولیه، لینک یک‌بارمصرف فعال‌سازی صادر می‌شود تا خود اپراتور رمز عبورش را تعیین کند.
        </p>
        <form onSubmit={submitCreate} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="نام و نام خانوادگی">
            <input
              required
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="ایمیل">
            <input
              type="email"
              dir="ltr"
              required
              value={createEmail}
              onChange={(e) => setCreateEmail(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="نقش">
            <select
              value={createRole}
              onChange={(e) => setCreateRole(e.target.value as PlatformAdminRole)}
              className={selectClass}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {PLATFORM_ROLE_LABELS[r]} ({r})
                </option>
              ))}
            </select>
          </Field>
          <Field label="رمز عبور اولیه (اختیاری)">
            <input
              type="password"
              dir="ltr"
              minLength={8}
              placeholder="خالی = صدور لینک دعوت"
              value={createPassword}
              onChange={(e) => setCreatePassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <div className="flex justify-end sm:col-span-2 lg:col-span-4">
            <Button
              type="submit"
              disabled={busy || !createEmail.trim() || !createName.trim()}
            >
              ایجاد مدیر سکو
            </Button>
          </div>
        </form>
      </Card>

      <Card title="راهنمای نقش‌ها">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
          {roles.map((r) => (
            <div key={r} className="rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-foreground">
                  {PLATFORM_ROLE_LABELS[r]}
                </span>
                <span className="rounded bg-sky-500/15 px-1.5 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                  {r}
                </span>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                {ROLE_DESCRIPTIONS[r]}
              </p>
            </div>
          ))}
        </div>
      </Card>

      {admins === null ? (
        <SkeletonRows rows={5} />
      ) : admins.length === 0 ? (
        <EmptyState title="مدیری ثبت نشده است." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="min-w-[760px] w-full text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-start font-medium">نام</th>
                <th className="px-4 py-3 text-start font-medium">ایمیل</th>
                <th className="px-4 py-3 text-start font-medium">نقش</th>
                <th className="px-4 py-3 text-start font-medium">وضعیت و 2FA</th>
                <th className="px-4 py-3 text-start font-medium">نشست‌ها</th>
                <th className="px-4 py-3 text-start font-medium">آخرین ورود</th>
                <th className="px-4 py-3 text-start font-medium">عملیات امنیتی</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">{a.fullName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground" dir="ltr">
                    {a.email}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={a.role}
                      disabled={busy}
                      onChange={(e) =>
                        void mutate({
                          action: "update",
                          id: a.id,
                          role: e.target.value,
                        })
                      }
                      className={selectClass}
                    >
                      {roles.map((r) => (
                        <option key={r} value={r}>
                          {PLATFORM_ROLE_LABELS[r]} ({r})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span
                        className={
                          a.isActive
                            ? "rounded-full bg-emerald-500/15 px-2 py-0.5 text-emerald-700 dark:text-emerald-300"
                            : "rounded-full bg-red-500/15 px-2 py-0.5 text-red-700 dark:text-red-300"
                        }
                      >
                        {a.isActive ? "فعال" : "غیرفعال"}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
                        {(a.mfaMethods?.length ?? 0) > 0
                          ? `2FA: ${a.mfaMethods.join(", ")}`
                          : "بدون 2FA"}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {toPersianDigits(String(a.activeSessionsCount ?? 0))} نشست
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {fmtDate(a.lastLoginAt)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1.5">
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            action: "update",
                            id: a.id,
                            isActive: !a.isActive,
                          })
                        }
                      >
                        {a.isActive ? "تعلیق" : "فعال‌سازی"}
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            action: "revoke_sessions",
                            id: a.id,
                          })
                        }
                      >
                        ابطال نشست‌ها
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void mutate({
                            action: "send_password_reset",
                            id: a.id,
                          })
                        }
                      >
                        لینک بازیابی رمز
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
