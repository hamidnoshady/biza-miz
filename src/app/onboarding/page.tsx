import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  ONBOARDING_COOKIE,
  readOnboardingIdentity,
} from "@/lib/iam/onboarding-session";

/**
 * ESH-200 / #1385 — the handoff target for a verified person who has no
 * business yet.
 *
 * The short business onboarding itself is #1387's work: it owns the industry,
 * business details, logo and the transition into the existing `/setup` wizard.
 * This page deliberately collects nothing and provisions nothing. It exists so
 * a successful signup lands on a real, guarded screen instead of a 404, and so
 * the continuation cookie is re-validated against the database before any
 * onboarding surface trusts it.
 *
 * When #1387 lands it replaces this body; the cookie and the guard stay.
 */
export default async function OnboardingEntryPage() {
  const cookieStore = await cookies();
  const platformUserId = await readOnboardingIdentity(
    cookieStore.get(ONBOARDING_COOKIE)?.value,
  );
  if (!platformUserId) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className={`w-full max-w-md ${cardClass} p-6 sm:p-8`}>
        <h1 className="mb-2 text-xl font-bold text-foreground">
          حساب شخصی شما ساخته شد
        </h1>
        <p className="mb-4 text-sm leading-6 text-muted-foreground">
          شمارهٔ موبایل شما تأیید شد. مرحلهٔ بعد، ثبت اطلاعات کسب‌وکار است؛ این
          جریان در همین مسیر ادامه پیدا می‌کند و تا آن زمان هیچ کسب‌وکار، شعبه یا
          اشتراکی ساخته نشده است.
        </p>
        <p className="mb-6 text-sm leading-6 text-muted-foreground">
          اگر می‌خواهید بعداً ادامه دهید، همین نشانی را دوباره باز کنید. برای
          ورود به حساب از صفحهٔ ورود استفاده کنید.
        </p>
        <Link
          href="/login"
          className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring focus-visible:ring-ring/50"
        >
          رفتن به صفحهٔ ورود
        </Link>
      </div>
    </main>
  );
}
