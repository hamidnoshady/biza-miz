"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import {
  platformAdminContractMessage,
  type PlatformAdminCreateRequest,
  type PlatformAdminUpdateRequest,
} from "@/lib/platform-admin-contract";
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

type PendingMutation =
  | { kind: "create"; body: PlatformAdminCreateRequest }
  | { kind: "change"; body: PlatformAdminUpdateRequest };

const LAST_OWNER_HINT =
  "این تنها مالک فعال سکو است؛ برای تعلیق یا تغییر نقش، ابتدا مالک فعال دیگری تعیین کنید.";

function successNotice(mutation: PendingMutation): string {
  if (mutation.kind === "create") return "مدیر جدید سکو با موفقیت ایجاد شد.";
  switch (mutation.body.action) {
    case "revoke_sessions":
      return "تمام نشست‌های فعال و ورودهای کمکی این مدیر بلافاصله باطل شدند.";
    case "reset_password":
      return "لینک یک‌بارمصرف بازیابی رمز عبور برای این مدیر صادر شد.";
    default:
      return "تغییرات با موفقیت ذخیره شد.";
  }
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

  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpPassword, setStepUpPassword] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingMutation | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ admins: Admin[]; error?: string }>("/api/platform/admins");
    if (!ok) {
      setError(platformAdminContractMessage(data.error));
      setAdmins([]);
      return;
    }
    setAdmins(data.admins);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Every administrator mutation goes through here. Creation is POST; every
   * change to an existing administrator is PATCH with a typed `action`. A
   * stale session answers 403 `recent_auth_required`; the step-up prompt then
   * replays exactly this request after re-verification.
   */
  async function mutate(mutation: PendingMutation): Promise<boolean> {
    setBusy(true);
    setError(null);
    setNotice(null);
    setIssuedResetUrl(null);
    const method = mutation.kind === "create" ? "POST" : "PATCH";
    const { ok, status, data } = await api<{
      ok?: boolean;
      error?: string;
      resetUrl?: string | null;
    }>("/api/platform/admins", {
      method,
      body: JSON.stringify(mutation.body),
    });
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setPendingAction(mutation);
        setStepUpOpen(true);
        return false;
      }
      setError(platformAdminContractMessage(data.error));
      return false;
    }
    if (data.resetUrl) {
      setIssuedResetUrl(data.resetUrl);
    }
    setNotice(successNotice(mutation));
    await load();
    return true;
  }

  function changeAdmin(body: PlatformAdminUpdateRequest) {
    void mutate({ kind: "change", body });
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();
    const body: PlatformAdminCreateRequest = {
      email: createEmail.trim().toLowerCase(),
      fullName: createName.trim(),
      role: createRole,
    };
    const ok = await mutate({ kind: "create", body });
    if (ok) {
      setCreateEmail("");
      setCreateName("");
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
          پس از ایجاد مدیر، یک لینک یک‌بارمصرف دعوت صادر می‌شود تا خود اپراتور رمز عبورش را تعیین کند. رمز عبور هیچ‌کس دیگری را نمی‌بینید یا تعیین نمی‌کنید.
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
              {admins.map((a) => {
                // Mirrors the server rule (audit F27): the only active owner cannot be
                // suspended or demoted. Shown before submission, not as a 409 afterwards.
                const lastActiveOwner =
                  a.role === "owner" &&
                  a.isActive &&
                  admins.filter((o) => o.role === "owner" && o.isActive).length <= 1;
                return (
                <tr key={a.id} className="border-t border-border">
                  <td className="px-4 py-3 font-medium text-foreground">{a.fullName}</td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground" dir="ltr">
                    {a.email}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={a.role}
                      disabled={busy || lastActiveOwner}
                      title={lastActiveOwner ? LAST_OWNER_HINT : undefined}
                      aria-describedby={lastActiveOwner ? `last-owner-${a.id}` : undefined}
                      aria-label={`نقش ${a.fullName}`}
                      onChange={(e) =>
                        changeAdmin({
                          action: "update",
                          adminId: a.id,
                          role: e.target.value as PlatformAdminRole,
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
                    {lastActiveOwner ? (
                      <p id={`last-owner-${a.id}`} className="mt-1 max-w-[16rem] text-xs text-amber-700 dark:text-amber-300">
                        {LAST_OWNER_HINT}
                      </p>
                    ) : null}
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
                        disabled={busy || (a.isActive && lastActiveOwner)}
                        title={a.isActive && lastActiveOwner ? LAST_OWNER_HINT : undefined}
                        onClick={() =>
                          changeAdmin({
                            action: "update",
                            adminId: a.id,
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
                          changeAdmin({
                            action: "revoke_sessions",
                            adminId: a.id,
                          })
                        }
                      >
                        ابطال نشست‌ها
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          changeAdmin({
                            action: "reset_password",
                            adminId: a.id,
                          })
                        }
                      >
                        لینک بازیابی رمز
                      </Button>
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
