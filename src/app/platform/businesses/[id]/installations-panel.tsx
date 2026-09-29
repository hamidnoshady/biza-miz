"use client";

/**
 * The paired Windows installs of one business.
 *
 * Read from `/api/platform/businesses/[id]/devices`, which returns device
 * identities (branch, status, last seen, sync health, credential-rotation
 * state) alongside the pairing codes that created them. Revoking is the
 * operator's kill switch for a laptop that is lost, sold or being replaced;
 * credential rotation stays tenant-side, because only the running desktop can
 * acknowledge a staged credential.
 */
import { useCallback, useEffect, useState } from "react";
import { formatJalali } from "@/lib/jalali";
import { api, errorMessage, Card, ErrorBox, InfoBox, SkeletonRows, useCan } from "../../ui";
import { useBusiness } from "./context";

export interface SiteDeviceView {
  id: string;
  publicId: string;
  locationId: string;
  locationName: string;
  displayName: string;
  status: "pending" | "active" | "disabled" | "revoked";
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  credentialRotatedAt: string | null;
  credentialRotationPending: boolean;
  lastSuccessfulPushAt: string | null;
  lastSuccessfulPullAt: string | null;
  lastSyncError: string | null;
}

const DEVICE_STATUS: Record<SiteDeviceView["status"], { label: string; cls: string }> = {
  pending: { label: "در انتظار تکمیل", cls: "text-amber-700 dark:text-amber-300" },
  active: { label: "فعال", cls: "text-emerald-700 dark:text-emerald-300" },
  disabled: { label: "غیرفعال", cls: "text-muted-foreground" },
  revoked: { label: "لغوشده", cls: "text-red-700 dark:text-red-300" },
};

/** Shamsi, always — every date a user sees goes through `formatJalali`. */
function fmt(iso: string | null): string {
  return iso ? formatJalali(iso, { withMonthName: true, withTime: true }) : "—";
}

export function InstallationsPanel() {
  const { id, version, setNotice } = useBusiness();
  const can = useCan();
  const allowed = can("business.provision");

  const [devices, setDevices] = useState<SiteDeviceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!allowed) return;
    const { ok, data } = await api<{ installations?: SiteDeviceView[]; error?: string }>(
      `/api/platform/businesses/${id}/devices`,
    );
    if (ok) setDevices(data.installations ?? []);
    else setError(errorMessage(data.error));
  }, [id, allowed]);

  useEffect(() => {
    void load();
  }, [load, version]);

  async function revoke(device: SiteDeviceView) {
    if (!window.confirm(`دسترسی «${device.displayName}» برای همیشه لغو شود؟`)) return;
    setBusy(device.id);
    setError(null);
    const { ok, data } = await api<{ error?: string }>(`/api/platform/businesses/${id}/devices`, {
      method: "POST",
      body: JSON.stringify({ action: "revoke", deviceId: device.id }),
    });
    setBusy(null);
    if (ok) {
      setNotice("دسترسی دستگاه لغو شد.");
      void load();
    } else {
      setError(errorMessage(data.error));
    }
  }

  if (!allowed) return null;

  return (
    <Card title="نصب‌های متصل">
      <ErrorBox>{error}</ErrorBox>
      {devices === null ? (
        <SkeletonRows rows={3} />
      ) : devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          هیچ نصب دسکتاپی به این کسب‌وکار متصل نشده است. با ساخت کد اتصال زیر شروع کنید.
        </p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => {
            const status = DEVICE_STATUS[device.status];
            return (
              <div
                key={device.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border bg-card p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {device.displayName}{" "}
                    <span className={`text-xs ${status.cls}`}>{status.label}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    شعبه: {device.locationName} • شناسه: <span dir="ltr">{device.publicId.slice(0, 8)}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    آخرین اتصال: {fmt(device.lastSeenAt)} • آخرین ارسال موفق: {fmt(device.lastSuccessfulPushAt)}
                  </p>
                  {device.credentialRotationPending ? (
                    <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">
                      چرخش کلید در انتظار تأیید نصب — کلید فعلی تا تأیید معتبر می‌ماند.
                    </p>
                  ) : null}
                  {device.lastSyncError ? (
                    <p className="mt-0.5 text-xs text-red-700 dark:text-red-300" dir="ltr">
                      {device.lastSyncError}
                    </p>
                  ) : null}
                </div>
                {device.status !== "revoked" ? (
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-700 hover:bg-red-500/10 dark:text-red-300"
                    disabled={busy === device.id}
                    onClick={() => void revoke(device)}
                  >
                    لغو دسترسی
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        لغو دسترسی، کلیدهای همان نصب را باطل می‌کند؛ تاریخچهٔ همگام‌سازی و گزارش‌ها باقی می‌مانند.
        چرخش کلید از سمت خود نصب انجام می‌شود.
      </p>
      <InfoBox>
        این بخش فقط دستگاه‌ها و کدهای اتصال را مدیریت می‌کند؛ قابلیت‌های برنامه‌ها در «برنامه‌ها و
        قابلیت‌ها» و پیکربندی فنی در بخش‌های دیگر کنسول است.
      </InfoBox>
    </Card>
  );
}
