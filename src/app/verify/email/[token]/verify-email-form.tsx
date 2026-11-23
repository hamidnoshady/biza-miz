"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorBox } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";

type State = "idle" | "busy" | "success" | "error";

export function VerifyEmailForm({ token }: { token: string }) {
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState("");

  async function verify() {
    setState("busy");
    setError("");
    try {
      const response = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!response.ok || !data.ok) {
        setState("error");
        setError(
          data.error === "email_changed"
            ? "ایمیل حساب پس از ارسال پیوند تغییر کرده است. لطفاً از حساب خود پیوند تازه بگیرید."
            : "این پیوند معتبر یا قابل استفاده نیست. ممکن است قبلاً استفاده شده یا منقضی شده باشد.",
        );
        return;
      }
      setState("success");
    } catch {
      setState("error");
      setError("تأیید ایمیل انجام نشد. اتصال خود را بررسی و دوباره تلاش کنید.");
    }
  }

  if (state === "success") {
    return (
      <div role="status">
        <p className="mb-5 rounded-lg bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200">
          ایمیل شما تأیید شد.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link href="/login">رفتن به صفحهٔ ورود</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/onboarding">ادامهٔ راه‌اندازی</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <ErrorBox>{error}</ErrorBox>
      <Button type="button" onClick={() => void verify()} disabled={state === "busy"} className="w-full">
        {state === "busy" ? "در حال تأیید…" : "تأیید ایمیل"}
      </Button>
      <p className="mt-4 text-center text-xs leading-5 text-muted-foreground">
        این پیوند یک‌بار مصرف است. اگر منقضی شده باشد، می‌توانید از حساب خود پیوند تازه بگیرید.
      </p>
    </div>
  );
}
