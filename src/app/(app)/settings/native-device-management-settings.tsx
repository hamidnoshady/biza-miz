"use client";

/**
 * Issue #884 — the device-registry admin surface (owner decision #1,
 * ISSUE_884_PLAN.md): every Android app installation registered across the
 * business, for an owner or a member explicitly holding
 * `native_devices.manage` to revoke or reactivate. A plain member's own
 * installations are `/settings/profile`'s "نصب‌های اپ اندروید" card instead —
 * this component never reaches another member's device without that
 * permission, and the server (`requirePermission(PERMISSIONS.nativeDevicesManage)`
 * on every route here) refuses it even if this check were bypassed.
 *
 * Mounted inside the "دستگاه‌های ثبت‌شده" settings tab, next to the unrelated
 * login-picker terminal registry (`DeviceSettings`) — a different table, a
 * different security relationship (see `native-device-service.ts`'s header),
 * presented as its own card rather than merged into that list.
 */
import { useCallback, useEffect, useState } from "react";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, SecondaryButton, api, errorMessage } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { PERMISSIONS } from "@/lib/permissions";

interface NativeDevice {
  id: string;
  userId: string;
  userName: string | null;
  appEnvironment: "development" | "staging" | "production";
  appVersionName: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  reactivatedAt: string | null;
}

function nativeEnvironmentLabel(env: NativeDevice["appEnvironment"]): string {
  if (env === "production") return "نسخهٔ اصلی";
  if (env === "staging") return "نسخهٔ آزمایشی";
  return "نسخهٔ توسعه";
}

function formatMoment(iso: string | null): string {
  if (!iso) return "هرگز";
  return formatJalali(iso, { withMonthName: true, withTime: true });
}

export interface NativeDeviceManagementSettingsProps {
  isOwner: boolean;
  /** The signed-in member's effective permission keys (see `settings-manager.tsx`). */
  permissions?: readonly string[];
}

export function NativeDeviceManagementSettings({
  isOwner,
  permissions,
}: NativeDeviceManagementSettingsProps) {
  const canManage = isOwner || (permissions ?? []).includes(PERMISSIONS.nativeDevicesManage);

  const [devices, setDevices] = useState<NativeDevice[] | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ devices?: NativeDevice[] }>("/api/native-devices");
    if (ok) {
      setDevices(data.devices ?? []);
    } else {
      setError("دریافت فهرست نصب‌های اپ اندروید ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    if (canManage) void load();
  }, [canManage, load]);

  // Not rendered at all for a member without the permission — server-side
  // enforcement (`requirePermission`) stands on its own, this just avoids
  // showing a card whose every action would 403.
  if (!canManage) return null;

  const activeDevices = (devices ?? []).filter((device) => !device.revokedAt);
  const revokedDevices = (devices ?? []).filter((device) => device.revokedAt);

  async function revoke(device: NativeDevice) {
    setPendingAction(device.id);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/native-devices/${device.id}`, {
      method: "DELETE",
    });
    setPendingAction(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(
      `ثبت نصب${device.userName ? ` «${device.userName}»` : ""} لغو شد. دسترسی آن از درخواست بعدی قطع می‌شود.`,
    );
    await load();
  }

  async function reactivate(device: NativeDevice) {
    setPendingAction(device.id);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/native-devices/${device.id}/reactivate`, {
      method: "POST",
    });
    setPendingAction(null);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(
      `نصب${device.userName ? ` «${device.userName}»` : ""} دوباره فعال شد؛ برای ادامهٔ کار باید دوباره وارد شود.`,
    );
    await load();
  }

  return (
    <SectionCard
      title="نصب‌های اپ اندروید"
      description="هر نصب اپ اندروید در کل کسب‌وکار که با این یا آن حساب وارد شده است. لغو ثبت، دسترسی همان نصب را از درخواست بعدی قطع می‌کند؛ روی دستگاه آفلاین تا اتصال دوباره اعمال نمی‌شود."
      actions={
        devices !== null ? (
          <StatusBadge tone={activeDevices.length > 0 ? "positive" : "neutral"}>
            {toPersianDigits(String(activeDevices.length))} فعال
          </StatusBadge>
        ) : null
      }
      flush
    >
      <div className="px-4 pt-4 sm:px-5">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
      </div>

      {devices === null ? <LoadingSkeleton rows={2} className="p-4 sm:p-5" /> : null}
      {devices !== null && activeDevices.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>هیچ نصب فعالی از اپ اندروید در این کسب‌وکار ثبت نشده است.</EmptyState>
        </div>
      ) : null}

      {activeDevices.length > 0 ? (
        <ul className="divide-y divide-border/80">
          {activeDevices.map((device) => (
            <li
              key={device.id}
              className="flex flex-col gap-3 px-4 py-4 sm:px-5 md:flex-row md:items-center md:justify-between"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="min-w-0 break-words font-semibold text-foreground">
                    {device.userName ?? "کاربر حذف‌شده"}
                  </p>
                  {device.appEnvironment !== "production" ? (
                    <StatusBadge tone="active">{nativeEnvironmentLabel(device.appEnvironment)}</StatusBadge>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  نسخه {toPersianDigits(device.appVersionName)} · ثبت: {formatMoment(device.registeredAt)} ·
                  آخرین فعالیت: {formatMoment(device.lastSeenAt)}
                </p>
              </div>
              <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
                <SecondaryButton
                  onClick={() => void revoke(device)}
                  disabled={pendingAction === device.id}
                >
                  {pendingAction === device.id ? "در حال لغو…" : "لغو ثبت"}
                </SecondaryButton>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {revokedDevices.length > 0 ? (
        <details className="border-t border-border/80">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/60 sm:px-5">
            سابقهٔ نصب‌های لغوشده ({toPersianDigits(String(revokedDevices.length))})
          </summary>
          <ul className="divide-y divide-border/80 border-t border-border/80">
            {revokedDevices.map((device) => (
              <li key={device.id} className="flex flex-col gap-3 px-4 py-3 text-sm sm:px-5 md:flex-row md:items-center md:justify-between">
                <div className="min-w-0 opacity-70">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-foreground">{device.userName ?? "کاربر حذف‌شده"}</p>
                    <StatusBadge tone="neutral">ثبت لغوشده</StatusBadge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    نسخه {toPersianDigits(device.appVersionName)} · ثبت: {formatMoment(device.registeredAt)} ·
                    لغو: {formatMoment(device.revokedAt)}
                  </p>
                </div>
                <div className="flex w-full flex-wrap gap-2 md:w-auto md:justify-end">
                  <SecondaryButton
                    onClick={() => void reactivate(device)}
                    disabled={pendingAction === device.id}
                  >
                    {pendingAction === device.id ? "در حال فعال‌سازی…" : "فعال‌سازی دوباره"}
                  </SecondaryButton>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </SectionCard>
  );
}
