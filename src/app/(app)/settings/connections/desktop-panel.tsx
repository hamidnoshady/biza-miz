"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * «برنامه دسکتاپ» — the screen that fixes the reported failure.
 *
 * The complaint was: install the desktop app, choose "connect to cloud", go to
 * the cloud to get a token, press the only generate button there is, paste it,
 * and be told the token is wrong. It was wrong — that button, in the sync
 * settings tab, mints a `POS1-…` server-sync token for the server-to-server
 * channel, not a desktop pairing code, and no button anywhere in a business's
 * own dashboard minted one of those.
 *
 * So this panel shows the two things the desktop app asks for, side by side,
 * in the order it asks for them: **this account's address** (the origin the
 * owner is signed in at right now, not a configured constant that might name
 * some other host) and **a connection code** they can generate themselves.
 * Both copyable, with the desktop app's own field labels quoted so there is no
 * question which box each goes in.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface PairingCodeSummary {
  id: string;
  expiresAt: string;
  redeemedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  state: "valid" | "code_pending_activation" | "code_expired" | "code_already_redeemed" | "code_revoked";
}

interface SiteDeviceView {
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

interface DesktopView {
  address: string;
  codes: PairingCodeSummary[];
  ttlHours: number;
  role: "central" | "site";
  locations: Array<{ id: string; name: string }>;
  devices: SiteDeviceView[];
}

const STATE_LABELS: Record<PairingCodeSummary["state"], { label: string; className: string }> = {
  valid: { label: "آماده استفاده", className: "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200" },
  code_already_redeemed: { label: "استفاده‌شده", className: "bg-sky-100 dark:bg-sky-500/20 text-sky-800 dark:text-sky-200" },
  code_pending_activation: { label: "در انتظار فعال‌سازی", className: "bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200" },
  code_expired: { label: "منقضی", className: "bg-muted text-muted-foreground" },
  code_revoked: { label: "لغوشده", className: "bg-muted text-muted-foreground" },
};

function formatDateTime(iso: string): string {
  return toPersianDigits(
    new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" }),
  );
}

/** A value with a copy button. Both of this panel's outputs are things to copy, so both use it. */
function CopyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (an insecure origin, a locked-down
      // browser). The value is selectable text either way, which is why it is
      // rendered as `select-all` rather than hidden behind the button.
      setCopied(false);
    }
  }

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <code
          dir="ltr"
          className="flex h-11 flex-1 select-all items-center overflow-x-auto rounded-lg border border-input bg-muted/40 px-3 font-mono text-sm"
        >
          {value || "—"}
        </code>
        <SecondaryButton onClick={copy} disabled={!value}>
          {copied ? "کپی شد" : "کپی"}
        </SecondaryButton>
      </div>
    </div>
  );
}

export function DesktopPanel() {
  const [view, setView] = useState<DesktopView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  /** The plaintext code, held only until this component unmounts — it is never retrievable again. */
  const [issued, setIssued] = useState("");
  const [rotationPendingFor, setRotationPendingFor] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{ device: SiteDeviceView; action: "rotate" | "revoke" } | null>(null);
  const [locationId, setLocationId] = useState("");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairAddress, setRepairAddress] = useState("");
  const [repairCode, setRepairCode] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<DesktopView & { error?: string }>("/api/connections/desktop");
    if (ok) {
      setView(data);
      setLocationId((current) => current || data.locations?.[0]?.id || "");
      setError("");
    } else {
      setError(errorMessage(data.error) || "بارگذاری اطلاعات اتصال ممکن نشد.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function generate() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ code?: string; error?: string }>("/api/connections/desktop", {
      method: "POST",
      body: JSON.stringify({ locationId }),
    });
    setBusy(false);
    if (!ok || !data.code) {
      setError(
        data.error === "not_central_server"
          ? "این نصب خودش یک نصب محلی است و کد اتصال صادر نمی‌کند؛ کد را از حساب ابری بگیرید."
          : data.error === "no_location"
            ? "برای این کسب‌وکار هنوز شعبه‌ای ثبت نشده است."
            : errorMessage(data.error) || "ساخت کد اتصال ممکن نشد.",
      );
      return;
    }
    setIssued(data.code);
    setNotice("کد ساخته شد. همین حالا آن را در برنامهٔ دسکتاپ وارد کنید — دوباره نمایش داده نمی‌شود.");
    await load();
  }

  async function revoke(codeId: string) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>("/api/connections/desktop", {
      method: "DELETE",
      body: JSON.stringify({ codeId }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || "لغو کد ممکن نشد.");
      return;
    }
    setIssued("");
    setNotice("کد لغو شد.");
    await load();
  }

  async function repairConnection() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ activationPending?: boolean; error?: string }>("/api/setup/reconnect", {
      method: "POST",
      body: JSON.stringify({ remoteUrl: repairAddress, code: repairCode }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error) || "ترمیم اتصال ممکن نشد.");
      return;
    }
    setRepairCode("");
    setRepairOpen(false);
    setNotice(data.activationPending
      ? "داده‌های محلی حفظ شد؛ فعال‌سازی ابری در صف تلاش دوباره است."
      : "دستگاه بدون حذف داده‌های محلی دوباره متصل شد و همگام‌سازی فعال است.");
    await load();
  }

  async function manageDevice(device: SiteDeviceView, action: "rotate" | "revoke") {
    setBusy(true);
    setError("");
    setNotice("");
    setRotationPendingFor(null);
    const { ok, data } = await api<{ token?: string; error?: string }>("/api/connections/desktop", {
      method: "PATCH",
      body: JSON.stringify({ deviceId: device.id, action }),
    });
    setBusy(false);
    if (!ok) {
      setError(
        data.error === "device_not_active"
          ? "این دستگاه فعال نیست و اعتبارنامهٔ آن قابل چرخش نیست."
          : errorMessage(data.error) || "تغییر وضعیت دستگاه ممکن نشد.",
      );
      return;
    }
    if (action === "rotate") {
      setRotationPendingFor(device.id);
      setNotice("چرخش با دورهٔ هم‌پوشانی امن آغاز شد. نصب محلی اعتبارنامهٔ تازه را خودکار دریافت و تأیید می‌کند؛ اعتبارنامهٔ فعلی تا پایان انتقال معتبر می‌ماند.");
    } else {
      setNotice("دستگاه و تمام اعتبارنامه‌های آن لغو شد.");
    }
    await load();
  }

  if (loading) return <LoadingSkeleton rows={3} />;

  // A site install (the café laptop itself) is the thing that *redeems* a
  // code. It holds a copy of the business, not the original, so issuing one
  // here would point a second desktop at a replica.
  if (view?.role === "site") {
    return (
      <SectionCard title="این نصب، نسخهٔ محلی است">
        <p className="text-sm leading-6 text-muted-foreground">
          کد اتصال دسکتاپ در حساب ابری ساخته می‌شود، نه روی نصب محلی. برای اتصال معمول، کد را از حساب ابری بگیرید.
          اگر دستگاه لغو شده یا اعتبارنامه‌اش از بین رفته است، از ترمیم استفاده کنید؛ داده و رویدادهای صف‌شدهٔ محلی پاک نمی‌شوند.
        </p>
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        {!repairOpen ? (
          <PrimaryButton onClick={() => setRepairOpen(true)}>ترمیم / اتصال دوبارهٔ دسکتاپ</PrimaryButton>
        ) : (
          <div className="mt-4 space-y-3 rounded-xl border border-border p-4">
            <p className="text-sm text-muted-foreground">یک کد تازه برای همین شعبه از حساب ابری بسازید، سپس آدرس و کد را وارد کنید.</p>
            <input className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" dir="ltr" value={repairAddress} onChange={(event) => setRepairAddress(event.target.value)} placeholder="https://cloud.example.com" />
            <input className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm" dir="ltr" value={repairCode} onChange={(event) => setRepairCode(event.target.value)} placeholder="XXXX-XXXX-XXXX" />
            <div className="flex flex-wrap gap-2">
              <PrimaryButton onClick={() => void repairConnection()} disabled={busy || !repairAddress || !repairCode}>{busy ? "در حال ترمیم…" : "اتصال دوباره"}</PrimaryButton>
              <SecondaryButton onClick={() => setRepairOpen(false)} disabled={busy}>انصراف</SecondaryButton>
            </div>
          </div>
        )}
      </SectionCard>
    );
  }

  const liveCode = view?.codes.find((code) => code.state === "valid");

  return (
    <div className="space-y-6">
      <SectionCard title="دسکتاپ و همگام‌سازی ابری">
        <p className="mb-4 text-sm leading-6 text-muted-foreground">چرخهٔ اتصال: کد → دادهٔ اولیه → فعال‌سازی امن → همگام‌سازی زنده. دستگاه تا تأیید دادهٔ اولیه، فعال یا «متصل» نمایش داده نمی‌شود.</p>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          در برنامهٔ دسکتاپ، «اتصال به پلتفرم آنلاین» را انتخاب کنید و این دو مقدار را وارد کنید.
        </p>

        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        <div className="space-y-4">
          <div>
            <label className="mb-1 block text-sm font-medium" htmlFor="desktop-pair-location">شعبهٔ این سرور ویندوز</label>
            <select
              id="desktop-pair-location"
              value={locationId}
              onChange={(event) => setLocationId(event.target.value)}
              disabled={busy || Boolean(issued)}
              className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
            >
              {(view?.locations ?? []).map((location) => (
                <option key={location.id} value={location.id}>{location.name}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted-foreground">هر شعبه هویت و اعتبارنامهٔ مستقل و قابل لغو دارد؛ انتخاب خودکار «اولین شعبه» انجام نمی‌شود.</p>
          </div>
          <CopyRow
            label="۱. آدرس سرور"
            value={view?.address ?? ""}
            hint="همان آدرسی که الان با آن وارد شده‌اید"
          />

          {issued ? (
            <CopyRow
              label="۲. کد اتصال"
              value={issued}
              hint={`فقط یک بار نمایش داده می‌شود • تا ${toPersianDigits(String(view?.ttlHours ?? 72))} ساعت معتبر`}
            />
          ) : (
            <div>
              <p className="mb-1 text-sm font-medium">۲. کد اتصال</p>
              <p className="mb-2 text-xs leading-5 text-muted-foreground">
                کد یک‌بارمصرف است و پس از ساخت فقط همین یک بار نمایش داده می‌شود. ساخت کد تازه، کد فعال قبلی
                را لغو می‌کند.
              </p>
              <PrimaryButton onClick={generate} disabled={busy || !locationId}>
                {busy ? "در حال ساخت…" : "ساخت کد اتصال"}
              </PrimaryButton>
            </div>
          )}
        </div>

        <div className="mt-5 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/15 p-4 text-xs leading-6 text-amber-900 dark:text-amber-200">
          <p className="font-semibold">اشتباه رایج</p>
          <p>
            «توکن همگام‌سازی» در بخش تنظیمات (مقداری که با <code dir="ltr">POS1-</code> شروع می‌شود) کد اتصال
            دسکتاپ <span className="font-semibold">نیست</span> و در این مرحله کار نمی‌کند. آن توکن برای
            همگام‌سازی سرور با سرور است و بعد از اتصال، خودکار تنظیم می‌شود.
          </p>
        </div>
      </SectionCard>

      <SectionCard title="سرورهای ویندوز متصل">
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          هر ردیف یک هویت مستقل و محدود به همان شعبه است. چرخش با یک دورهٔ هم‌پوشانی کوتاه انجام می‌شود تا همگام‌سازی قطع نشود؛ لغو دائمی است و سابقهٔ دستگاه را برای حسابرسی نگه می‌دارد.
        </p>
        {!view || view.devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز دستگاهی با موفقیت متصل نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {view.devices.map((device) => {
              const active = device.status === "active";
              return (
                <li key={device.id} className="rounded-xl border border-border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">{device.displayName}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        شعبه: {device.locationName} • شناسه: <code dir="ltr">{device.publicId}</code>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        احراز هویت: {device.lastSeenAt ? formatDateTime(device.lastSeenAt) : "هنوز ارتباطی ثبت نشده"}
                        {device.credentialRotatedAt ? ` • چرخش اعتبارنامه: ${formatDateTime(device.credentialRotatedAt)}` : ""}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        آخرین ارسال موفق: {device.lastSuccessfulPushAt ? formatDateTime(device.lastSuccessfulPushAt) : "هنوز ثبت نشده"} • دریافت موفق: {device.lastSuccessfulPullAt ? formatDateTime(device.lastSuccessfulPullAt) : "هنوز ثبت نشده"}
                        {device.lastSyncError ? ` • خطا: ${device.lastSyncError}` : ""}
                      </p>
                    </div>
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        active
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {active ? "فعال" : device.status === "pending" ? "در انتظار فعال‌سازی" : device.status === "revoked" ? "لغوشده" : "غیرفعال"}
                    </span>
                  </div>
                  {rotationPendingFor === device.id || device.credentialRotationPending ? (
                    <InfoBox>اعتبارنامهٔ تازه در حال تحویل امن به نصب محلی است. تا زمان تأیید، اعتبارنامهٔ قبلی معتبر می‌ماند.</InfoBox>
                  ) : null}
                  {active ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <SecondaryButton onClick={() => setConfirmAction({ device, action: "rotate" })} disabled={busy}>
                        چرخش اعتبارنامه
                      </SecondaryButton>
                      <SecondaryButton onClick={() => setConfirmAction({ device, action: "revoke" })} disabled={busy}>
                        لغو دستگاه
                      </SecondaryButton>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="کدهای صادرشده">
        <p className="mb-4 text-sm text-muted-foreground">
          سابقهٔ کدهای این کسب‌وکار. «استفاده‌شده» یعنی دستگاهی با آن متصل شده است.
        </p>
        {!view || view.codes.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز کدی صادر نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {view.codes.map((code) => {
              const state = STATE_LABELS[code.state];
              return (
                <li
                  key={code.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm"
                >
                  <span className={`rounded-full px-2 py-0.5 text-xs ${state.className}`}>{state.label}</span>
                  <span className="text-xs text-muted-foreground">ساخته‌شده: {formatDateTime(code.createdAt)}</span>
                  <span className="text-xs text-muted-foreground">
                    {code.redeemedAt ? `استفاده: ${formatDateTime(code.redeemedAt)}` : `انقضا: ${formatDateTime(code.expiresAt)}`}
                  </span>
                  {code.id === liveCode?.id ? (
                    <SecondaryButton onClick={() => revoke(code.id)} disabled={busy}>
                      لغو
                    </SecondaryButton>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
      {confirmAction ? (
        <Dialog open onOpenChange={(open) => (open ? undefined : setConfirmAction(null))}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{confirmAction.action === "rotate" ? "چرخش امن اعتبارنامه" : "لغو دستگاه"}</DialogTitle>
              <DialogDescription>
                {confirmAction.action === "rotate"
                  ? `اعتبارنامهٔ تازه برای «${confirmAction.device.displayName}» به‌صورت خودکار و با دورهٔ هم‌پوشانی تحویل می‌شود. ادامه می‌دهید؟`
                  : `دستگاه «${confirmAction.device.displayName}» دیگر اجازهٔ همگام‌سازی نخواهد داشت. این کار قابل بازگشت نیست.`}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <SecondaryButton onClick={() => setConfirmAction(null)} disabled={busy}>انصراف</SecondaryButton>
              <PrimaryButton onClick={() => { const action = confirmAction; setConfirmAction(null); void manageDevice(action.device, action.action); }} disabled={busy}>
                {confirmAction.action === "rotate" ? "شروع چرخش" : "لغو دستگاه"}
              </PrimaryButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
