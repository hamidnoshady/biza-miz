"use client";

/**
 * #1585 — «دستگاه‌هایی که به خاطر سپرده شده‌اند».
 *
 * The visible half of the persistent-login authority. It lists the browser
 * authorizations this membership holds in this business and lets the member end
 * one or all of them.
 *
 * Boundaries this card keeps:
 *
 *  - **A different list from trusted devices.** Trust waives a routine second
 *    factor for seven days; this keeps the browser signed in. Revoking one does
 *    not revoke the other, and the card says so, because a member who wants
 *    "ask for my code again" and a member who wants "stop signing me in here"
 *    are asking for different things.
 *  - **No secrets, no fingerprints.** The API returns a coarse browser/OS
 *    family, the dates and nothing else — never a token, never an address.
 *  - **The current browser is marked** and can end itself, which is a sign-out
 *    and needs no re-proving. Ending *another* device, or all of them, is a
 *    security action and takes the shared recent-authentication rule; when the
 *    server says so, the card says so plainly rather than pretending it failed.
 *  - **Dates are Shamsi**, through `formatJalali`.
 */
import { useCallback, useEffect, useState } from "react";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, SecondaryButton, api } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { RECENT_AUTH_MESSAGE } from "@/components/auth/step-up-prompt";

interface RememberedDevice {
  id: string;
  deviceLabel: string | null;
  browserFamily: string | null;
  osFamily: string | null;
  issuedAt: string;
  lastUsedAt: string | null;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  revokedAt: string | null;
  isCurrent: boolean;
}

const BROWSER_LABELS: Record<string, string> = {
  chrome: "کروم",
  edge: "اج",
  firefox: "فایرفاکس",
  safari: "سافاری",
  opera: "اپرا",
  samsung: "سامسونگ اینترنت",
};

const OS_LABELS: Record<string, string> = {
  windows: "ویندوز",
  macos: "مک",
  linux: "لینوکس",
  android: "اندروید",
  ios: "آی‌اواس",
};

function deviceTitle(device: RememberedDevice): string {
  const browser = device.browserFamily ? BROWSER_LABELS[device.browserFamily] : null;
  const os = device.osFamily ? OS_LABELS[device.osFamily] : null;
  if (browser && os) return `${browser} روی ${os}`;
  if (browser) return browser;
  if (os) return os;
  return device.deviceLabel ?? "مرورگر ناشناس";
}

function jalali(iso: string | null): string {
  if (!iso) return "—";
  try {
    return formatJalali(iso);
  } catch {
    return "—";
  }
}

export function RememberedDevicesCard({ onSignedOut }: { onSignedOut?: () => void }) {
  const [devices, setDevices] = useState<RememberedDevice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ devices?: RememberedDevice[] }>("/api/auth/remembered-devices");
    if (ok && data.devices) {
      setDevices(data.devices);
      setError(null);
    } else {
      setError("بارگذاری دستگاه‌های به‌خاطر‌سپرده ممکن نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(device: RememberedDevice) {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status, data } = await api<{ error?: string; isCurrent?: boolean }>(
      "/api/auth/remembered-devices",
      { method: "DELETE", body: JSON.stringify({ id: device.id }) },
    );
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setError(RECENT_AUTH_MESSAGE);
        return;
      }
      setError("لغو این دستگاه ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    if (data.isCurrent) {
      setNotice("از این دستگاه خارج شدید.");
      onSignedOut?.();
      return;
    }
    setNotice("این دستگاه دیگر به‌صورت خودکار وارد نمی‌شود.");
    await load();
  }

  async function revokeAll() {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { ok, status, data } = await api<{ error?: string; revokedCount?: number }>(
      "/api/auth/remembered-devices",
      { method: "DELETE", body: JSON.stringify({ all: true }) },
    );
    setBusy(false);
    if (!ok) {
      if (status === 403 && data.error === "recent_auth_required") {
        setError(RECENT_AUTH_MESSAGE);
        return;
      }
      setError("خروج از همهٔ دستگاه‌ها ممکن نشد؛ دوباره تلاش کنید.");
      return;
    }
    setNotice(
      `از ${toPersianDigits(String(data.revokedCount ?? 0))} دستگاه به‌خاطر‌سپرده خارج شدید.`,
    );
    onSignedOut?.();
  }

  const active = (devices ?? []).filter((device) => !device.revokedAt);

  return (
    <SectionCard
      title="دستگاه‌هایی که مرا به خاطر می‌سپارند"
      description="مرورگرهایی که با انتخاب «مرا در این دستگاه به خاطر بسپار» وارد می‌مانند. این فهرست جدای از «اعتماد هفت‌روزه به دستگاه» است؛ لغو یکی، دیگری را تغییر نمی‌دهد."
    >
      {devices === null ? (
        <LoadingSkeleton />
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          هیچ دستگاهی به خاطر سپرده نشده است. با فعال‌کردن گزینهٔ «مرا در این دستگاه به خاطر
          بسپار» هنگام ورود، این مرورگر پس از بستن هم وارد می‌ماند.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((device) => (
            <li key={device.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  {deviceTitle(device)}
                  {device.isCurrent ? (
                    <span className="rounded-xl bg-amber-100 px-2 py-0.5 text-xs text-amber-950">
                      همین دستگاه
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  به خاطر سپرده‌شده از {jalali(device.issuedAt)}
                  {" · "}
                  آخرین استفاده {jalali(device.lastUsedAt ?? device.issuedAt)}
                  {" · "}
                  معتبر تا {jalali(device.absoluteExpiresAt)}
                </p>
              </div>
              <SecondaryButton disabled={busy} onClick={() => void revoke(device)}>
                {device.isCurrent ? "خروج از این دستگاه" : "فراموش کردن این دستگاه"}
              </SecondaryButton>
            </li>
          ))}
        </ul>
      )}

      {notice ? (
        <p role="status" className="rounded-xl bg-muted/60 px-3 py-2 text-sm">
          {notice}
        </p>
      ) : null}
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      {active.length > 0 ? (
        <div className="flex justify-end">
          <SecondaryButton disabled={busy} onClick={() => void revokeAll()}>
            خروج از همه دستگاه‌ها
          </SecondaryButton>
        </div>
      ) : null}
    </SectionCard>
  );
}
