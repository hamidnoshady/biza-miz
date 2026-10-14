import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { isLoginToken } from "@/lib/desktop-cloud-login";
import { cardClass } from "@/app/dashboard/page-chrome";
import { DesktopLoginConfirm } from "./desktop-login-confirm";

export const dynamic = "force-dynamic";

/**
 * Phase 46 — «ورود با حساب ابری», the page the desktop opens in the system
 * browser. Middleware has already sent a signed-out visitor through the
 * business's own login and back here (`next`). Confirming mints a single-use
 * code for that one paired install and hands the browser back to the app.
 */
export default async function DesktopLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; device?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { state, device } = await searchParams;
  const valid = isLoginToken(state) && typeof device === "string" && device.length === 36;
  return (
    <main className="flex min-h-screen items-center justify-center p-6" dir="rtl">
      <div className={`w-full max-w-md ${cardClass} p-8 text-center`}>
        <h1 className="mb-2 text-lg font-bold text-foreground">ورود به برنامهٔ دسکتاپ</h1>
        {valid ? (
          <DesktopLoginConfirm state={state} device={device} fullName={session.fullName} />
        ) : (
          <p className="text-sm leading-7 text-muted-foreground">
            این پیوند کامل نیست. در برنامهٔ دسکتاپ دوباره «ورود با حساب ابری» را بزنید.
          </p>
        )}
      </div>
    </main>
  );
}
