import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { withTenant } from "@/lib/db";
import { cardClass } from "@/app/dashboard/page-chrome";
import { readEnrollmentRequest } from "@/lib/desktop-enroll-service";
import { readEnrollmentReadiness } from "@/lib/desktop-enrollment-readiness-service";
import { businessLocations } from "@/lib/setup-state";
import { DesktopEnrollConfirm } from "./desktop-enroll-confirm";

export const dynamic = "force-dynamic";

/**
 * Issue #1115 §A.3 — the page the unpaired Windows app opens in the system
 * browser, where the signed-in owner approves the device.
 *
 * Signed out, middleware sends the visitor through this business's own login
 * and back here. The reservation is read in tenant scope, so a page reached on
 * one business's origin can never show or approve another business's device.
 */
export default async function DesktopEnrollPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  const { id } = await params;

  const request = await readEnrollmentRequest(session.businessId, id);
  const locations = await withTenant(session.businessId, () =>
    businessLocations(session.businessId),
  ).then((rows) => rows.map((row) => ({ id: row.id, name: row.name })));

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10" dir="rtl">
      <div className={`w-full max-w-lg ${cardClass} p-8`}>
        {!request ? (
          <div className="text-center">
            <h1 className="text-lg font-bold text-foreground">این درخواست پیدا نشد</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              درخواست اتصال منقضی شده یا به کسب‌وکار دیگری تعلق دارد. در برنامهٔ ویندوز دوباره
              «ورود با حساب ابری» را بزنید.
            </p>
          </div>
        ) : request.state === "expired" ? (
          <div className="text-center">
            <h1 className="text-lg font-bold text-foreground">مهلت این درخواست تمام شد</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              برای امنیت، درخواست اتصال دستگاه کوتاه‌عمر است. در برنامهٔ ویندوز دوباره
              «ورود با حساب ابری» را بزنید تا درخواست تازه‌ای ساخته شود.
            </p>
          </div>
        ) : request.state === "approved" ? (
          <div className="text-center">
            <h1 className="text-lg font-bold text-foreground">این دستگاه قبلاً تأیید شده است</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              اگر دستگاه هنوز وصل نشده، در برنامهٔ ویندوز یک درخواست تازه بسازید.
            </p>
          </div>
        ) : request.state === "denied" ? (
          <div className="text-center">
            <h1 className="text-lg font-bold text-foreground">این درخواست رد شده است</h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground">
              هیچ دستگاهی متصل نشد. برای تلاش دوباره، از برنامهٔ ویندوز درخواست تازه بسازید.
            </p>
          </div>
        ) : (
          <DesktopEnrollConfirm
            requestId={request.id}
            businessName={request.businessName}
            deviceName={request.deviceName}
            userCode={request.userCode}
            maxSnapshotVersion={request.maxSnapshotVersion}
            locations={locations}
            initialLocationId={
              request.locationId ?? (locations.length === 1 ? locations[0].id : null)
            }
            initialReadiness={await readEnrollmentReadiness({
              businessId: session.businessId,
              locationId: request.locationId ?? (locations.length === 1 ? locations[0].id : null),
              clientMaxSnapshotVersion: request.maxSnapshotVersion,
            })}
          />
        )}
      </div>
    </main>
  );
}
