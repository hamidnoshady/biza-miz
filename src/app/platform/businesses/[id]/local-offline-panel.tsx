"use client";

import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  ErrorBox,
  InfoBox,
  inputClass,
  SkeletonRows,
  useCan,
  errorMessage,
} from "../../ui";
import { useBusiness } from "./context";
import type { RemoteSupportCommandType, LocalSupportSessionMode } from "@/lib/local-activation-contract";

interface LocalInstallationItem {
  id: string;
  publicId: string;
  locationId: string | null;
  locationName: string | null;
  displayName: string;
  status: "pending" | "pending_ack" | "active" | "disabled" | "revoked";
  appVersion: string | null;
  platformInfo: string | null;
  lastSeenAt: string | null;
  lastVerifiedAt?: string | null;
  lastValidatedAt?: string | null;
  revokedAt: string | null;
  offlineLeaseDays: number | null;
  onlineNow: boolean;
}

interface LocalCodeItem {
  id: string;
  locationId: string | null;
  locationName?: string | null;
  codeHint?: string | null;
  label?: string | null;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  state:
    | "valid"
    | "code_pending_activation"
    | "code_expired"
    | "code_already_redeemed"
    | "code_revoked";
}

interface SupportCommandItem {
  id: string;
  sessionId: string;
  commandType: RemoteSupportCommandType;
  state: "queued" | "delivered" | "completed" | "rejected" | "expired";
  result: unknown;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface SupportSessionItem {
  id: string;
  localInstallationId: string;
  operatorName: string;
  ticketId: string | null;
  reason: string;
  mode: LocalSupportSessionMode;
  state:
    | "pending_owner_consent"
    | "awaiting_local_consent"
    | "active"
    | "paused_disconnected"
    | "ended"
    | "revoked"
    | "denied"
    | "expired";
  requestedDurationMinutes: number;
  approvedAt: string | null;
  expiresAt: string | null;
  lastSiteHeartbeatAt?: string | null;
  endReason?: string | null;
  createdAt: string;
}

const INST_STATUS: Record<LocalInstallationItem["status"], { label: string; cls: string }> = {
  pending: { label: "در انتظار تأیید نصب", cls: "text-amber-700 dark:text-amber-300" },
  pending_ack: { label: "در انتظار تأیید نصب", cls: "text-amber-700 dark:text-amber-300" },
  active: { label: "فعال", cls: "text-emerald-700 dark:text-emerald-300" },
  disabled: { label: "قفل / غیرفعال", cls: "text-amber-700 dark:text-amber-300" },
  revoked: { label: "لغوشده", cls: "text-red-700 dark:text-red-300" },
};

const SESSION_STATE_LABELS: Record<SupportSessionItem["state"], string> = {
  pending_owner_consent: "در انتظار تأیید مالک محلی",
  awaiting_local_consent: "در انتظار تأیید مالک محلی",
  active: "فعال (متصل)",
  paused_disconnected: "متوقف (قطع ارتباط دستگاه)",
  ended: "پایان‌یافته",
  revoked: "لغوشده توسط مالک محلی",
  denied: "ردشده توسط مالک محلی",
  expired: "منقضی‌شده",
};

const MODE_LABELS: Record<LocalSupportSessionMode, string> = {
  read_only: "فقط خواندنی",
  controlled: "دسترسی محدود فنی",
  recovery_only: "بازیابی محدود دستگاه قفل‌شده",
};

function fmt(iso: string | null | undefined): string {
  return iso ? toPersianDigits(formatJalali(iso, { withMonthName: true, withTime: true })) : "—";
}

export function LocalOfflineFleetPanel() {
  const { id, version, setNotice } = useBusiness();
  const can = useCan();
  const canProvision = can("business.provision");
  const canSupport = can("impersonate.readOnly");

  const [installations, setInstallations] = useState<LocalInstallationItem[] | null>(null);
  const [codes, setCodes] = useState<LocalCodeItem[]>([]);
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<SupportSessionItem[]>([]);
  const [commandsBySession, setCommandsBySession] = useState<Record<string, SupportCommandItem[]>>({});

  const [locationId, setLocationId] = useState("");
  const [codeLabel, setCodeLabel] = useState("");
  const [issuedCode, setIssuedCode] = useState<string | null>(null);

  const [supportOpenFor, setSupportOpenFor] = useState<string | null>(null);
  const [supportMode, setSupportMode] = useState<LocalSupportSessionMode>("read_only");
  const [supportDuration, setSupportDuration] = useState("30");
  const [supportTicketId, setSupportTicketId] = useState("");
  const [supportReason, setSupportReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localNotice, setLocalNotice] = useState<string | null>(null);

  const loadFleet = useCallback(async () => {
    if (!canProvision && !canSupport) return;
    if (canProvision) {
      const [devRes, pairRes] = await Promise.all([
        api<{
          localInstallations?: LocalInstallationItem[];
          localCodes?: LocalCodeItem[];
          error?: string;
        }>(`/api/platform/businesses/${id}/devices`),
        api<{ locations?: Array<{ id: string; name: string }> }>(
          `/api/platform/pairing?businessId=${encodeURIComponent(id)}`,
        ),
      ]);
      if (devRes.ok) {
        setInstallations(devRes.data.localInstallations ?? []);
        setCodes(devRes.data.localCodes ?? []);
      } else {
        setError(errorMessage(devRes.data.error));
      }
      if (pairRes.ok && pairRes.data.locations) {
        setLocations(pairRes.data.locations);
        setLocationId((cur) => cur || pairRes.data.locations?.[0]?.id || "");
      }
    }
    if (canSupport) {
      const sesRes = await api<{ sessions?: SupportSessionItem[] }>(
        `/api/platform/local-support-sessions?businessId=${encodeURIComponent(id)}`,
      );
      if (sesRes.ok) {
        setSessions(sesRes.data.sessions ?? []);
      }
    }
  }, [id, canProvision, canSupport]);

  useEffect(() => {
    void loadFleet();
  }, [loadFleet, version]);

  const hasLiveSession = sessions.some(
    (s) =>
      s.state === "pending_owner_consent" ||
      s.state === "awaiting_local_consent" ||
      s.state === "active" ||
      s.state === "paused_disconnected",
  );

  useEffect(() => {
    if (!hasLiveSession || !canSupport) return;
    const timer = window.setInterval(() => {
      void loadFleet();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [hasLiveSession, canSupport, loadFleet]);

  async function issueLocalCode() {
    setBusy(true);
    setError(null);
    setLocalNotice(null);
    const { ok, data } = await api<{ code?: string; error?: string }>(
      `/api/platform/businesses/${id}/devices`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "issue_local_code",
          locationId: locationId || null,
          label: codeLabel.trim() || null,
        }),
      },
    );
    setBusy(false);
    if (ok && data.code) {
      setIssuedCode(data.code);
      setCodeLabel("");
      setLocalNotice("توکن تمام‌آفلاین (OFL1) ساخته شد — همین حالا کپی کنید.");
      void loadFleet();
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function deviceAction(
    action: "revoke_local_installation" | "rotate_local_installation" | "update_local_installation",
    extra: Record<string, unknown>,
    successMsg: string,
  ) {
    setBusy(true);
    setError(null);
    setLocalNotice(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${id}/devices`, {
      method: "POST",
      body: JSON.stringify({ action, ...extra }),
    });
    setBusy(false);
    if (ok) {
      setNotice(successMsg);
      void loadFleet();
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function startRemoteSupport(localInstallationId: string) {
    setBusy(true);
    setError(null);
    setLocalNotice(null);
    const { ok, data } = await api<{ session?: SupportSessionItem; error?: string }>(
      "/api/platform/local-support-sessions",
      {
        method: "POST",
        body: JSON.stringify({
          action: "request_session",
          businessId: id,
          localInstallationId,
          mode: supportMode,
          durationMinutes: Number(supportDuration) || 30,
          ticketId: supportTicketId.trim() || null,
          reason: supportReason.trim(),
        }),
      },
    );
    setBusy(false);
    if (ok && data.session) {
      setSupportOpenFor(null);
      setSupportReason("");
      setLocalNotice("درخواست جلسهٔ پشتیبانی ارسال شد؛ در انتظار تأیید مالک محلی روی دستگاه.");
      void loadFleet();
    } else {
      setError(
        data.error === "installation_offline"
          ? "دستگاه در حال حاضر آفلاین است؛ شروع جلسهٔ پشتیبانی از راه دور فقط برای دستگاه آنلاین امکان‌پذیر است."
          : data.error === "reason_required"
            ? "علت شروع جلسه (حداقل ۵ کاراکتر) الزامی است."
            : errorMessage(data.error),
      );
    }
  }

  async function sendSupportCommand(sessionId: string, commandType: RemoteSupportCommandType) {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string }>("/api/platform/local-support-sessions", {
      method: "POST",
      body: JSON.stringify({
        action: "queue_command",
        businessId: id,
        sessionId,
        commandType,
      }),
    });
    setBusy(false);
    if (ok) {
      setLocalNotice("دستور تشخیصی در صف ارسال قرار گرفت و در نظرسنجی بعدی دستگاه اجرا می‌شود.");
      void refreshSessionCommands(sessionId);
    } else {
      setError(errorMessage(data.error));
    }
  }

  async function refreshSessionCommands(sessionId: string) {
    const { ok, data } = await api<{ commands?: SupportCommandItem[] }>(
      `/api/platform/local-support-sessions?businessId=${encodeURIComponent(id)}`,
    );
    if (ok && data.commands) {
      setCommandsBySession((prev) => ({
        ...prev,
        [sessionId]: (data.commands ?? []).filter((c) => c.sessionId === sessionId),
      }));
    }
  }

  async function endRemoteSupport(sessionId: string) {
    setBusy(true);
    await api("/api/platform/local-support-sessions", {
      method: "POST",
      body: JSON.stringify({ action: "end_session", businessId: id, sessionId }),
    });
    setBusy(false);
    setLocalNotice("جلسهٔ پشتیبانی پایان یافت.");
    void loadFleet();
  }

  if (!canProvision && !canSupport) return null;

  return (
    <div className="space-y-4">
      <Card title="نصب‌های دسکتاپ تمام‌آفلاین (محلی — بدون همگام‌سازی تراکنش)">
        <ErrorBox>{error}</ErrorBox>
        <InfoBox>{localNotice}</InfoBox>

        {installations === null && canProvision ? (
          <SkeletonRows rows={2} />
        ) : (installations ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">
            هنوز هیچ نصب تمام‌آفلاینی (OFL1) برای این کسب‌وکار ثبت نشده است.
          </p>
        ) : (
          <div className="space-y-3">
            {(installations ?? []).map((inst) => {
              const st = INST_STATUS[inst.status];
              return (
                <div key={inst.id} className="rounded-lg border border-border p-3 text-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{inst.displayName}</span>
                        <span className={`text-xs font-medium ${st.cls}`}>{st.label}</span>
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs ${
                            inst.onlineNow
                              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                              : "bg-muted text-muted-foreground"
                          }`}
                        >
                          {inst.onlineNow ? "آنلاین (آمادهٔ پشتیبانی)" : "آفلاین"}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        شعبه: {inst.locationName ?? "—"} • شناسه: <code dir="ltr">{inst.publicId}</code>
                        {inst.appVersion ? ` • نسخه: ${inst.appVersion}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        آخرین تأیید ابری: {fmt(inst.lastValidatedAt ?? inst.lastVerifiedAt)} • مهلت آفلاین:{" "}
                        {inst.offlineLeaseDays ? `${toPersianDigits(String(inst.offlineLeaseDays))} روز` : "نامحدود"}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {canSupport && (inst.status === "active" || inst.status === "disabled") ? (
                        <Button
                          onClick={() => setSupportOpenFor(supportOpenFor === inst.id ? null : inst.id)}
                          disabled={!inst.onlineNow || busy}
                        >
                          {inst.onlineNow
                            ? "جلسهٔ پشتیبانی از راه دور"
                            : "پشتیبانی غیرفعال (آفلاین)"}
                        </Button>
                      ) : null}
                      {canProvision && inst.status === "active" ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void deviceAction(
                                "rotate_local_installation",
                                { deviceId: inst.id },
                                "چرخش اعتبارنامهٔ نصب تمام‌آفلاین آغاز شد.",
                              )
                            }
                          >
                            چرخش اعتبارنامه
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void deviceAction(
                                "update_local_installation",
                                { deviceId: inst.id, status: "disabled" },
                                "نصب تمام‌آفلاین قفل موقت شد.",
                              )
                            }
                          >
                            قفل موقت
                          </Button>
                        </>
                      ) : null}
                      {canProvision && inst.status === "disabled" ? (
                        <Button
                          variant="ghost"
                          disabled={busy}
                          onClick={() =>
                            void deviceAction(
                              "update_local_installation",
                              { deviceId: inst.id, status: "active" },
                              "قفل نصب تمام‌آفلاین برداشته شد.",
                            )
                          }
                        >
                          رفع قفل
                        </Button>
                      ) : null}
                      {canProvision && inst.status !== "revoked" ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => {
                            if (window.confirm(`نصب تمام‌آفلاین «${inst.displayName}» لغو شود؟`)) {
                              void deviceAction(
                                "revoke_local_installation",
                                { deviceId: inst.id },
                                "نصب تمام‌آفلاین لغو شد.",
                              );
                            }
                          }}
                        >
                          لغو نصب
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {supportOpenFor === inst.id ? (
                    <div className="mt-3 space-y-3 rounded-lg border border-border bg-muted/40 p-3">
                      <p className="text-xs font-semibold">
                        شروع جلسهٔ پشتیبانی امن (نیازمند تأیید مالک محلی روی دستگاه)
                      </p>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="block text-xs">
                          <span className="mb-1 block">سطح دسترسی</span>
                          <select
                            className={inputClass}
                            value={supportMode}
                            onChange={(e) => setSupportMode(e.target.value as LocalSupportSessionMode)}
                          >
                            <option value="read_only">فقط خواندنی</option>
                            <option value="controlled">دسترسی محدود فنی</option>
                            <option value="recovery_only">بازیابی محدود دستگاه قفل‌شده</option>
                          </select>
                        </label>
                        <label className="block text-xs">
                          <span className="mb-1 block">مدت زمان (دقیقه)</span>
                          <select
                            className={inputClass}
                            value={supportDuration}
                            onChange={(e) => setSupportDuration(e.target.value)}
                          >
                            <option value="15">۱۵ دقیقه</option>
                            <option value="30">۳۰ دقیقه</option>
                            <option value="60">۶۰ دقیقه</option>
                            <option value="120">۱۲۰ دقیقه</option>
                          </select>
                        </label>
                        <label className="block text-xs">
                          <span className="mb-1 block">شناسهٔ تیکت (اختیاری)</span>
                          <input
                            dir="ltr"
                            className={inputClass}
                            value={supportTicketId}
                            onChange={(e) => setSupportTicketId(e.target.value)}
                            placeholder="UUID / Ref"
                          />
                        </label>
                      </div>
                      <label className="block text-xs">
                        <span className="mb-1 block">علت جلسه (الزامی — برای ثبت در گزارش حسابرسی دوطرفه)</span>
                        <input
                          className={inputClass}
                          value={supportReason}
                          onChange={(e) => setSupportReason(e.target.value)}
                          placeholder="مثلاً بررسی وضعیت پایگاه‌داده پس از تماس پشتیبانی مالک"
                        />
                      </label>
                      <div className="flex gap-2">
                        <Button
                          disabled={busy || supportReason.trim().length < 5}
                          onClick={() => void startRemoteSupport(inst.id)}
                        >
                          ارسال درخواست به مالک محلی
                        </Button>
                        <Button variant="ghost" onClick={() => setSupportOpenFor(null)}>
                          انصراف
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {sessions.length > 0 ? (
          <div className="mt-5 space-y-2 border-t border-border pt-4">
            <h4 className="text-xs font-semibold text-muted-foreground">
              جلسه‌های پشتیبانی از راه دور (نصب‌های تمام‌آفلاین)
            </h4>
            {sessions.slice(0, 8).map((s) => {
              const cmds = commandsBySession[s.id] ?? [];
              return (
                <div key={s.id} className="rounded-lg border border-border p-3 text-xs space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold">{SESSION_STATE_LABELS[s.state]}</span>
                      {" • "}
                      <span>{MODE_LABELS[s.mode]}</span>
                      {" • "}
                      <span>اپراتور: {s.operatorName}</span>
                      {s.expiresAt ? ` • انقضا: ${fmt(s.expiresAt)}` : ""}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.state === "active" ? (
                        <>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void sendSupportCommand(s.id, "inspect_system_diagnostics")}
                          >
                            گزارش تشخیصی
                          </Button>
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void sendSupportCommand(s.id, "inspect_operational_summary")}
                          >
                            خلاصهٔ سلامت عملیاتی
                          </Button>
                          {s.mode !== "read_only" ? (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void sendSupportCommand(s.id, "trigger_cloud_revalidation")}
                            >
                              همگام‌سازی مجوز ابری
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void refreshSessionCommands(s.id)}
                          >
                            مشاهدهٔ پاسخ‌ها
                          </Button>
                        </>
                      ) : null}
                      {(s.state === "pending_owner_consent" ||
                        s.state === "awaiting_local_consent" ||
                        s.state === "active" ||
                        s.state === "paused_disconnected") ? (
                        <Button
                          variant="danger"
                          disabled={busy}
                          onClick={() => void endRemoteSupport(s.id)}
                        >
                          پایان جلسه
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <p className="text-muted-foreground">علت: {s.reason}</p>
                  {cmds.length > 0 ? (
                    <div className="space-y-1 rounded bg-muted/50 p-2">
                      {cmds.map((cmd) => (
                        <div key={cmd.id} className="border-b border-border/50 pb-1 last:border-b-0">
                          <span className="font-mono" dir="ltr">
                            {cmd.commandType} ({cmd.state})
                          </span>
                          {cmd.result ? (
                            <pre
                              dir="ltr"
                              className="mt-1 overflow-x-auto rounded bg-background p-2 text-[11px]"
                            >
                              {JSON.stringify(cmd.result, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}
      </Card>

      {canProvision ? (
        <Card title="صدور توکن یک‌بارمصرف تمام‌آفلاین (OFL1)">
          <p className="mb-3 text-sm text-muted-foreground">
            این توکن فقط برای فعال‌سازی اولیه یا جایگزینی اعتبارنامهٔ دسکتاپ تمام‌آفلاین است و همگام‌سازی تراکنش‌های هیبرید را فعال نمی‌کند.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {locations.length > 0 ? (
              <label className="block text-xs">
                <span className="mb-1 block">شعبه</span>
                <select
                  className={inputClass}
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                >
                  {locations.map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="block text-xs">
              <span className="mb-1 block">برچسب دستگاه (اختیاری)</span>
              <input
                className={inputClass}
                value={codeLabel}
                onChange={(e) => setCodeLabel(e.target.value)}
                placeholder="مثلاً شعبهٔ ولیعصر"
              />
            </label>
            <div className="flex items-end">
              <Button disabled={busy} onClick={() => void issueLocalCode()}>
                {busy ? "در حال ساخت…" : "ساخت توکن تمام‌آفلاین (OFL1)"}
              </Button>
            </div>
          </div>

          {issuedCode ? (
            <div className="mt-3 rounded-lg border border-primary/40 bg-primary/10 p-3">
              <p className="text-xs font-semibold">توکن یک‌بارمصرف صادرشده (همین حالا کپی کنید):</p>
              <code dir="ltr" className="mt-1 block select-all font-mono text-base font-bold">
                {issuedCode}
              </code>
            </div>
          ) : null}

          {codes.length > 0 ? (
            <div className="mt-4 space-y-1.5">
              {codes.slice(0, 6).map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2 text-xs"
                >
                  <code dir="ltr">{c.codeHint ?? "OFL1-••••"}</code>
                  <span className="text-muted-foreground">
                    {c.state === "valid"
                      ? `فعال تا ${fmt(c.expiresAt)}`
                      : c.state === "code_already_redeemed"
                        ? `استفاده‌شده (${fmt(c.redeemedAt)})`
                        : c.state === "code_revoked"
                          ? "لغوشده"
                          : "منقضی"}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
