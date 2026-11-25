"use client";

import { useEffect, useState } from "react";
import { ArrowLeftRightIcon } from "lucide-react";
import { ErrorBox, PrimaryButton } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

/**
 * Desktop multi-business (#1572) — the in-app way back to the saved-business
 * picker.
 *
 * The card exists only where the action can work: inside the packaged desktop
 * app, and only once the install actually holds more than one saved business.
 * A single-business install has nothing to switch to, so it renders nothing
 * rather than a disabled button that can only fail. The main process re-checks
 * both facts on the click; this panel never decides who may switch.
 */
export function DesktopBusinessSwitch() {
  const bridge = typeof window === "undefined" ? undefined : window.businessSuiteDesktop?.business;
  const [multiBusiness, setMultiBusiness] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .current()
      .then((current) => {
        if (!cancelled) setMultiBusiness(current?.multiBusiness === true);
      })
      .catch(() => {
        if (!cancelled) setMultiBusiness(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  async function change() {
    if (!bridge || busy) return;
    setBusy(true);
    setError("");
    try {
      await bridge.change();
    } catch {
      // The shell only rejects when it could not stop this business and restart;
      // a successful switch replaces the page before this line is reached.
      setBusy(false);
      setError("تغییر کسب‌وکار انجام نشد. برنامه را ببندید و از پنجرهٔ انتخاب کسب‌وکار دوباره باز کنید.");
    }
  }

  if (!bridge || !multiBusiness) return null;

  return (
    <SectionCard
      title="تغییر کسب‌وکار"
      description="جابه‌جایی بین کسب‌وکارهای ذخیره‌شده روی این رایانه"
    >
      <ErrorBox>{error}</ErrorBox>
      <p className="text-sm leading-6 text-muted-foreground">
        برنامه بسته و پنجرهٔ انتخاب کسب‌وکار باز می‌شود. پیش از ادامه، سفارش و شیفت باز را نهایی و کارهای
        ذخیره‌نشده را تمام کنید. داده‌های هر کسب‌وکار جدا می‌ماند.
      </p>
      <div className="mt-4">
        <PrimaryButton onClick={() => void change()} disabled={busy}>
          <ArrowLeftRightIcon className="size-4" aria-hidden="true" />
          {busy ? "در حال تغییر…" : "تغییر کسب‌وکار"}
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}
