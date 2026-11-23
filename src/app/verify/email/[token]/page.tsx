import { cardClass } from "@/app/dashboard/page-chrome";
import { VerifyEmailForm } from "./verify-email-form";

/**
 * ESH-199 / #1384 follow-up — the page an email verification link opens.
 *
 * It renders a confirm action rather than consuming the token on GET: a mail
 * scanner that prefetches the link must not spend the single-use proof before
 * the person sees it. The token itself is never rendered as visible text.
 */
export default async function VerifyEmailPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10 sm:px-6">
      <div className={`w-full max-w-md ${cardClass} p-6 sm:p-8`}>
        <h1 className="mb-2 text-xl font-bold text-foreground">تأیید ایمیل</h1>
        <p className="mb-6 text-sm leading-6 text-muted-foreground">
          با تأیید این ایمیل، می‌توانید از آن برای اطلاع‌رسانی حساس و بازیابی حساب استفاده کنید.
        </p>
        <VerifyEmailForm token={token} />
      </div>
    </main>
  );
}
