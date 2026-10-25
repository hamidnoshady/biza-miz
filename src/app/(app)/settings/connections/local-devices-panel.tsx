"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";
import type { DesktopGatewayStatus } from "@/lib/desktop-bridge";

type GatewayStatus = DesktopGatewayStatus;

function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>{ok ? yes : no}</span>;
}

async function copy(value: string | null) {
  if (value) await navigator.clipboard.writeText(value);
}

export function LocalDevicesPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.businessSuiteDesktop;
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [siteQr, setSiteQr] = useState("");
  const [caQr, setCaQr] = useState("");
  const [mobilePlatform, setMobilePlatform] = useState<"android" | "ios">("android");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const next = await bridge.localGateway.status();
      setStatus(next);
      setSelected((current) => current || next.selectedAddress || next.interfaces[0]?.address || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خواندن وضعیت اتصال محلی ممکن نشد.");
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    if (!bridge) return;
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [bridge, refresh]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      const [site, ca] = await Promise.all([
        status?.url ? QRCode.toDataURL(status.url, { width: 220, margin: 1, errorCorrectionLevel: "M" }) : "",
        status?.caDownloadUrl ? QRCode.toDataURL(status.caDownloadUrl, { width: 180, margin: 1, errorCorrectionLevel: "M" }) : "",
      ]);
      if (!cancelled) { setSiteQr(site); setCaQr(ca); }
    }
    void render();
    return () => { cancelled = true; };
  }, [status?.url, status?.caDownloadUrl]);

  const selectedInterface = useMemo(
    () => status?.interfaces.find((item) => item.address === selected),
    [selected, status?.interfaces],
  );

  async function run(action: () => Promise<GatewayStatus>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await action();
      setStatus(next);
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "عملیات انجام نشد.");
    } finally {
      setBusy(false);
    }
  }

  if (!bridge) {
    return (
      <SectionCard title="اتصال دستگاه‌های محلی">
        <InfoBox>
          مدیریت درگاه شبکه و فایروال فقط داخل برنامهٔ ویندوز بیزامیز در دسترس است. این صفحه را روی رایانهٔ میزبان باز کنید؛ سرور ابری یا مرورگر عادی نباید پورت شبکهٔ رایانه را مدیریت کند.
        </InfoBox>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard title="وضعیت سرور محلی">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">نام رایانه</dt><dd dir="ltr" className="font-mono">{status?.computerName || "—"}</dd></div>
          <div><dt className="text-muted-foreground">سرور داخلی</dt><dd><State ok={true} yes="فعال روی حلقهٔ محلی" no="غیرفعال" /></dd></div>
          <div><dt className="text-muted-foreground">دسترسی موبایل</dt><dd><State ok={Boolean(status?.running)} yes="HTTPS فعال" no="غیرفعال" /></dd></div>
          <div><dt className="text-muted-foreground">فایروال ویندوز</dt><dd><State ok={Boolean(status?.firewall.installed)} yes="قانون شبکهٔ Private فعال" no="قانون فعال نیست" /></dd></div>
          <div><dt className="text-muted-foreground">پورت امن برنامه</dt><dd dir="ltr" className="font-mono">HTTPS/WSS {status?.port ?? 8443}</dd></div>
          <div><dt className="text-muted-foreground">پورت دریافت CA</dt><dd dir="ltr" className="font-mono">HTTP {status?.onboardingPort ?? 8444} (certificate only)</dd></div>
          <div><dt className="text-muted-foreground">گواهی</dt><dd><State ok={Boolean(status?.certificate.exists)} yes="ساخته شده" no="ساخته نشده" /></dd></div>
        </dl>
        {status?.firewall.publicNetwork ? (
          <div className="mt-4"><ErrorBox>ویندوز این شبکه را Public تشخیص داده است؛ قانون درگاه فقط در شبکهٔ Private اجازهٔ اتصال می‌دهد. فقط اگر به شبکه اعتماد دارید، نوع آن را در تنظیمات ویندوز به Private تغییر دهید.</ErrorBox></div>
        ) : null}
        {status?.enabled && !status.addressActive ? (
          <div className="mt-4"><ErrorBox>نشانی شبکهٔ ذخیره‌شده دیگر فعال نیست. شبکهٔ فعلی را انتخاب و درگاه را دوباره فعال کنید. برای جلوگیری از تکرار، در روتر برای رایانه نشانی ثابت (DHCP reservation) تنظیم کنید؛ پس از تغییر نشانی، آدرس جدید را در تلفن‌ها وارد کنید.</ErrorBox></div>
        ) : null}
      </SectionCard>

      <SectionCard title="شبکهٔ تلفن و تبلت">
        <label className="mb-2 block text-sm font-medium" htmlFor="lan-interface">کارت شبکهٔ خصوصی</label>
        <select
          id="lan-interface"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={busy || Boolean(status?.running)}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {(status?.interfaces ?? []).map((item) => (
            <option key={`${item.name}:${item.address}`} value={item.address}>{item.name} — {item.address}</option>
          ))}
        </select>
        {selectedInterface ? <p className="mt-2 text-xs text-muted-foreground">نشانی خصوصی: <span dir="ltr" className="font-mono">{selectedInterface.address}</span></p> : null}
        {!status?.interfaces.length ? <ErrorBox>شبکهٔ خصوصی فعالی پیدا نشد. Wi-Fi یا Ethernet را وصل کنید؛ آداپتورهای Docker، WSL و مجازی عمداً نمایش داده نمی‌شوند.</ErrorBox> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!status?.running ? (
            <PrimaryButton disabled={busy || !selected} onClick={() => run(() => bridge.localGateway.enable(selected), "درگاه امن بدون نیاز به دسترسی مدیر فعال شد. اگر فایروال اتصال را مسدود می‌کند، قانون اختیاری را جداگانه اضافه کنید.")}>
              {busy ? "در حال فعال‌سازی…" : "فعال‌کردن دسترسی موبایل"}
            </PrimaryButton>
          ) : (
            <PrimaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.disable(), "دسترسی موبایل غیرفعال شد. قانون فایروال، در صورت نصب، جداگانه قابل حذف است.")}>
              غیرفعال‌کردن دسترسی موبایل
            </PrimaryButton>
          )}
          {status?.firewall.supported && !status.firewall.installed ? (
            <SecondaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.installFirewallRule(), "قانون محدود فایروال نصب شد.")}>
              افزودن قانون فایروال (نیازمند UAC)
            </SecondaryButton>
          ) : null}
          {status?.firewall.supported && status.firewall.installed ? (
            <SecondaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.removeFirewallRule(), "قانون فایروال حذف شد.")}>
              حذف قانون فایروال (نیازمند UAC)
            </SecondaryButton>
          ) : null}
          <SecondaryButton disabled={busy || !status?.certificate.exists} onClick={() => run(() => bridge.localGateway.regenerateCertificate(), "گواهی درگاه بازسازی شد. CA محلی تغییر نکرده است.")}>
            بازسازی گواهی
          </SecondaryButton>
          <SecondaryButton onClick={() => void bridge.localGateway.openLogs()}>بازکردن گزارش‌ها</SecondaryButton>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          درخواست دسترسی مدیر ویندوز فقط برای افزودن یا حذف قانون ورودی دو پورت درگاه امن و دریافت عمومی CA، روی پروفایل Private، برای همین برنامه و محدودهٔ LocalSubnet است. پورت HTTP فقط فایل عمومی CA را از یک نشانی موقت می‌دهد و هیچ صفحه، API، کوکی یا WebSocket ندارد. PostgreSQL و Print Connector هرگز در فایروال باز نمی‌شوند.
        </p>
      </SectionCard>

      {status?.running && status.url ? (
        <SectionCard title="اتصال امن تلفن یا تبلت">
          <div className="mb-4 flex gap-2" role="tablist" aria-label="سیستم‌عامل تلفن">
            <SecondaryButton onClick={() => setMobilePlatform("android")} aria-pressed={mobilePlatform === "android"}>Android</SecondaryButton>
            <SecondaryButton onClick={() => setMobilePlatform("ios")} aria-pressed={mobilePlatform === "ios"}>iPhone / iPad</SecondaryButton>
          </div>

          <div className="rounded-xl border border-amber-300/60 bg-amber-50/60 p-4 text-sm leading-6 text-amber-950 dark:bg-amber-950/20 dark:text-amber-100">
            هشدار گواهی را رد یا دور نزنید. ابتدا CA را نصب کنید، اثر انگشت SHA-256 را با همین صفحه تطبیق دهید و فقط وقتی HTTPS بدون هشدار باز شد وارد حساب شوید.
          </div>

          <div className="mt-5 grid gap-6 md:grid-cols-[190px_1fr]">
            <div className="rounded-xl border bg-white p-2">{caQr ? <img src={caQr} alt="QR دریافت فقط فایل CA محلی" width={170} height={170} /> : null}</div>
            <div className="space-y-3 text-sm">
              <h3 className="font-semibold">۱. دریافت و نصب گواهی ریشه</h3>
              <p className="text-xs leading-6 text-muted-foreground">
                این QR عمداً از یک پورت HTTP جداگانه فقط فایل عمومی CA را می‌دهد؛ آن پورت هیچ صفحهٔ برنامه، API، کوکی، رمز یا WebSocket ارائه نمی‌کند و نشانی آن با هر راه‌اندازی درگاه تغییر می‌کند.
              </p>
              {mobilePlatform === "android" ? (
                <ol className="list-decimal space-y-1 pr-5 text-xs leading-6">
                  <li>QR را اسکن و فایل <span dir="ltr" className="font-mono">business-suite-local-ca.crt</span> را دریافت کنید.</li>
                  <li>Settings → Security &amp; privacy → More security settings → Install a certificate → CA certificate را باز کنید (نام منو بسته به سازنده متفاوت است).</li>
                  <li>گواهی را برای CA برنامه‌ها نصب کنید؛ اگر دستگاه سازمانی نصب CA را منع می‌کند، با مدیر دستگاه تماس بگیرید و محدودیت را دور نزنید.</li>
                </ol>
              ) : (
                <ol className="list-decimal space-y-1 pr-5 text-xs leading-6">
                  <li>QR را در Safari اسکن کنید و اجازهٔ دریافت Profile را بدهید.</li>
                  <li>Settings → General → VPN &amp; Device Management → Downloaded Profile را باز و Profile را نصب کنید.</li>
                  <li>Settings → General → About → Certificate Trust Settings را باز و Full Trust را فقط برای Business Suite Local CA روشن کنید.</li>
                </ol>
              )}
              <p className="text-xs">اثر انگشت مورد انتظار را پیش از اعتماد تطبیق دهید:</p>
              <code dir="ltr" className="block break-all rounded border bg-muted/40 p-2 text-xs">{status.certificate.caFingerprint || "—"}</code>
              <div className="flex flex-wrap gap-2">
                <SecondaryButton onClick={() => void copy(status.certificate.caFingerprint || null)}>کپی اثر انگشت</SecondaryButton>
                <SecondaryButton onClick={() => void bridge.localGateway.showCaCertificate()}>نمایش فایل CA در ویندوز</SecondaryButton>
              </div>
              <p className="text-xs text-muted-foreground">
                دریافت‌های این نشست: {status.onboardingDownloads.toLocaleString("fa-IR")}{status.lastOnboardingDownloadAt ? ` — آخرین دریافت ${new Date(status.lastOnboardingDownloadAt).toLocaleTimeString("fa-IR")}` : ""}
              </p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 border-t pt-5 md:grid-cols-[240px_1fr]">
            <div className="rounded-xl border bg-white p-2">{siteQr ? <img src={siteQr} alt="QR نشانی HTTPS سرور محلی" width={220} height={220} /> : null}</div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">۲. بازکردن برنامه فقط با HTTPS</h3>
              <p className="text-sm">پس از نصب و اعتماد به CA، این QR را اسکن کنید. قفل امن مرورگر باید بدون هشدار نمایش داده شود.</p>
              <div className="flex flex-wrap items-center gap-2">
                <code dir="ltr" className="select-all rounded-lg border bg-muted/40 px-3 py-2 text-sm">{status.url}</code>
                <SecondaryButton onClick={() => void copy(status.url)}>کپی نشانی HTTPS</SecondaryButton>
              </div>
              <p className="text-xs leading-6 text-muted-foreground">برای ورود، Pairing دستگاه و هم‌زمانی زنده فقط همین درگاه HTTPS/WSS استفاده می‌شود. تلفن هرگز مستقیماً به PostgreSQL، پورت داخلی برنامه یا Print Connector وصل نمی‌شود.</p>
            </div>
          </div>
          {status.tlsDiagnostics.last ? (
            <div className="mt-4"><ErrorBox>
              آخرین تلاش TLS در {new Date(status.tlsDiagnostics.last.at).toLocaleTimeString("fa-IR")} ناموفق بود ({status.tlsDiagnostics.last.code}). معمولاً CA هنوز نصب/Trusted نشده یا IP گواهی با شبکهٔ فعلی یکسان نیست. هشدار مرورگر را رد نکنید؛ مراحل بالا را بررسی و در صورت تغییر شبکه گواهی درگاه را بازسازی کنید.
            </ErrorBox></div>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title="دستگاه‌های دیده‌شده و رفع اشکال">
        {status?.clients.length ? (
          <ul className="space-y-2 text-sm">
            {status.clients.map((client) => (
              <li key={`${client.kind}:${client.address}`} className="flex justify-between rounded-lg border p-3">
                <span dir="ltr" className="font-mono">{client.address}</span>
                <span className="text-muted-foreground">{client.kind === "websocket" ? "هم‌زمان" : "HTTPS"} — {new Date(client.lastSeenAt).toLocaleTimeString("fa-IR")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">هنوز دستگاهی به درگاه وصل نشده است.</p>}
        <ol className="mt-4 list-decimal space-y-1 pr-5 text-xs leading-6 text-muted-foreground">
          <li>رایانه و تلفن باید روی یک Wi-Fi یا LAN خصوصی باشند؛ شبکهٔ Guest معمولاً ارتباط دستگاه‌ها را مسدود می‌کند.</li>
          <li>پروفایل شبکهٔ ویندوز باید Private باشد و پنجرهٔ UAC افزودن قانون فایروال تأیید شود.</li>
          <li>خطای گواهی یعنی CA نصب یا Trusted نشده، یا IP شبکه تغییر کرده است؛ کارت شبکه را دوباره انتخاب و گواهی را بازسازی کنید.</li>
          <li>قطع اینترنت به عملیات محلی آسیب نمی‌زند؛ قطع LAN فقط اقدامات پشتیبانی‌شده را در صف دستگاه نگه می‌دارد.</li>
        </ol>
      </SectionCard>
    </div>
  );
}
