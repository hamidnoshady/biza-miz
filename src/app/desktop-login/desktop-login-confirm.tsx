"use client";

import { useState } from "react";
import { MonitorCheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

const ERRORS: Record<string, string> = {
  device_not_found: "این دستگاه به کسب‌وکار شما متصل نیست یا اتصالش لغو شده است.",
  branch_not_allowed: "شما به شعبه‌ای که این دستگاه در آن است دسترسی ندارید.",
};

export function DesktopLoginConfirm({ state, device, fullName }: { state: string; device: string; fullName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/desktop-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, device }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setError(ERRORS[data.error ?? ""] ?? "ورود ناموفق بود. دوباره تلاش کنید.");
        return;
      }
      // Hands the browser back to the desktop app (the businesssuite:// link).
      window.location.href = data.url;
      setSent(true);
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <p className="text-sm leading-7 text-muted-foreground">
        به برنامهٔ دسکتاپ برگردید؛ ورود شما آنجا کامل شد. این زبانه را می‌توانید ببندید.
      </p>
    );
  }
  return (
    <>
      <p className="mb-6 text-sm leading-7 text-muted-foreground">
        {`با حساب «${fullName}» وارد برنامهٔ دسکتاپ این کسب‌وکار می‌شوید. اگر این درخواست را خودتان از برنامهٔ دسکتاپ نزده‌اید، این صفحه را ببندید.`}
      </p>
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      <Button onClick={confirm} disabled={busy} className="w-full">
        <MonitorCheckIcon className="size-4" aria-hidden="true" />
        {busy ? "در حال ورود…" : "ورود به برنامهٔ دسکتاپ"}
      </Button>
    </>
  );
}
