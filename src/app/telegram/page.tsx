import type { Metadata } from "next";
import Script from "next/script";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { PageShell, SectionCard } from "@/app/dashboard/page-chrome";
import { getSession } from "@/lib/auth";
import { telegramConfig } from "@/lib/telegram-contract";
import { TelegramMiniAppClient } from "./telegram-mini-app-client";

export const metadata: Metadata = {
  title: "مینی‌اپ تلگرام | Biza Miz",
  description: "ورود امن به Biza Miz از طریق مینی‌اپ رسمی تلگرام",
};

export const dynamic = "force-dynamic";

export default async function TelegramMiniAppPage() {
  const session = await getSession();
  if (session) redirect("/dashboard");

  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const configured = telegramConfig();
  const botHref = configured.enabled
    ? `https://t.me/${configured.config.botUsername}`
    : null;

  return (
    <PageShell>
      <div className="mx-auto w-full max-w-xl py-8">
        <SectionCard
          title="ورود امن به مینی‌اپ Biza Miz"
          description="هویت تلگرام فقط پس از پیوند حساب موجود شما پذیرفته می‌شود؛ دسترسی کسب‌وکار از سمت سرور بررسی خواهد شد."
        >
          <div className="space-y-4">
            <Script
              src="https://telegram.org/js/telegram-web-app.js"
              strategy="afterInteractive"
              nonce={nonce}
            />
            <TelegramMiniAppClient botHref={botHref} />
          </div>
        </SectionCard>
      </div>
    </PageShell>
  );
}
