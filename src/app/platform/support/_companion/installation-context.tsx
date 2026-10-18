"use client";

/**
 * Issue #984 — the ticket's «کاربر و نصب» tab: authorized requester,
 * business and verified-installation context with freshness. An online
 * browser user is not proof the installed companion is online, so every
 * installation row shows its own observed contact time (or its absence).
 */
import { PlatformDetailSection, PlatformStatusBadge } from "@/components/platform";
import { usePlatformQuery } from "../../_lib/use-platform-data";
import { useCan } from "../../_lib/capability-context";
import { fmtDateTime } from "@/lib/platform-format";
import type { TicketSupportContext } from "./types";

const ENROLLMENT_TONE: Record<string, "success" | "warning" | "neutral" | "muted" | "danger" | "info"> = {
  active: "success",
  pending: "warning",
  disabled: "neutral",
  revoked: "danger",
};

const ENROLLMENT_LABELS: Record<string, string> = {
  active: "فعال",
  pending: "در انتظار",
  disabled: "غیرفعال",
  revoked: "باطل‌شده",
};

export function InstallationContext({ ticketId }: { ticketId: string }) {
  const can = useCan();
  const query = usePlatformQuery<{ context: TicketSupportContext }>(
    can("support.context.read") ? `/api/platform/support/tickets/${ticketId}/context` : null,
    [ticketId],
  );
  const context = query.data?.context ?? null;

  if (!can("support.context.read")) {
    return <p className="text-xs text-muted-foreground">نمایش زمینه پشتیبانی نیازمند مجوز «مشاهده زمینه» است.</p>;
  }
  if (query.loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری زمینه…</p>;
  if (query.errorText) return <p className="text-sm text-red-600 dark:text-red-400">{query.errorText}</p>;
  if (!context) return null;

  // Deep-link into the installed companion, focused on this ticket. The
  // protocol is handled by the Windows app; without it the click is a no-op
  // the operator explains to the customer ("open the Support app").
  const companionDeepLink = `biza-support://ticket/${ticketId}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={companionDeepLink}
          className="inline-flex items-center gap-1 rounded-md border border-primary/40 bg-primary/10 px-3 py-1.5 text-xs font-medium text-primary hover:bg-primary/15"
        >
          باز کردن اپ عیب‌یابی
        </a>
        <span className="text-[11px] text-muted-foreground">
          نیازمند نصب همراه پشتیبانی روی همین رایانه است؛ در غیر این صورت از مشتری بخواهید اپ را باز کند.
        </span>
      </div>
      <PlatformDetailSection title="کاربر و کسب‌وکار">
        <dl className="grid gap-1 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">کاربر</dt>
            <dd className="text-foreground">{context.userName ?? "کاربر حذف‌شده"}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">کسب‌وکار</dt>
            <dd className="text-foreground">{context.businessName}</dd>
          </div>
          {context.locationName ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">شعبه</dt>
              <dd className="text-foreground">{context.locationName}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">پروفایل استقرار</dt>
            <dd className="text-foreground" dir="ltr">
              {context.deploymentProfile ?? "نامشخص"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">سیاست دسترسی پشتیبانی</dt>
            <dd className="text-foreground" dir="ltr">
              {context.supportAccessPolicy ?? "نامشخص"}
            </dd>
          </div>
        </dl>
      </PlatformDetailSection>

      <PlatformDetailSection title="نصب‌های تأییدشده">
        {context.installations.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            نصبی برای این کسب‌وکار ثبت نشده است. عملیات دستگاهی تا زمان انتخاب یک نصب تأییدشده مسدود است.
          </p>
        ) : (
          <ul className="space-y-2">
            {context.installations.map((installation) => (
              <li key={installation.id} className="rounded-lg border border-border bg-card p-3">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {installation.displayName || "نصب ویندوز"}
                  </span>
                  <PlatformStatusBadge
                    tone={ENROLLMENT_TONE[installation.enrollmentState] ?? "neutral"}
                    label={ENROLLMENT_LABELS[installation.enrollmentState] ?? installation.enrollmentState}
                  />
                </div>
                <dl className="grid gap-0.5 text-xs text-muted-foreground">
                  {installation.locationName ? (
                    <div className="flex justify-between gap-3">
                      <dt>شعبه</dt>
                      <dd className="text-foreground">{installation.locationName}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3">
                    <dt>نسل نصب</dt>
                    <dd className="text-foreground" dir="ltr">
                      {installation.generation}
                    </dd>
                  </div>
                  {installation.mainVersion ? (
                    <div className="flex justify-between gap-3">
                      <dt>نسخه اصلی</dt>
                      <dd className="text-foreground" dir="ltr">
                        {installation.mainVersion}
                      </dd>
                    </div>
                  ) : null}
                  {installation.companionVersion ? (
                    <div className="flex justify-between gap-3">
                      <dt>نسخه همراه</dt>
                      <dd className="text-foreground" dir="ltr">
                        {installation.companionVersion}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3">
                    <dt>آخرین تماس مشاهده‌شده</dt>
                    <dd className="text-foreground">
                      {installation.lastContactAt ? fmtDateTime(installation.lastContactAt) : "هرگز — آفلاین"}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </PlatformDetailSection>

      <PlatformDetailSection title="آخرین سلامت">
        {context.latestHealth ? (
          <dl className="grid gap-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">وضعیت اجرا</dt>
              <dd className="text-foreground">{context.latestHealth.state}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">شدت</dt>
              <dd className="text-foreground">{context.latestHealth.severity}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">زمان مشاهده</dt>
              <dd className="text-foreground">
                {context.latestHealth.observedAt ? fmtDateTime(context.latestHealth.observedAt) : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">زمان دریافت</dt>
              <dd className="text-foreground">{fmtDateTime(context.latestHealth.receivedAt)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">وضعیت ارسال</dt>
              <dd className="text-foreground">{context.latestHealth.uploadState}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-xs text-muted-foreground">هنوز گزارشی برای این تیکت ثبت نشده است.</p>
        )}
      </PlatformDetailSection>

      {context.consent.length > 0 ? (
        <PlatformDetailSection title="رضایت‌های اخیر">
          <ul className="space-y-1.5 text-xs">
            {context.consent.map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-foreground">
                  {event.subject} — {event.decision}
                </span>
                <span className="text-muted-foreground">{fmtDateTime(event.createdAt)}</span>
              </li>
            ))}
          </ul>
        </PlatformDetailSection>
      ) : null}
    </div>
  );
}
