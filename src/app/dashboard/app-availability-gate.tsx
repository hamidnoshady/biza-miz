"use client";

/**
 * What a business sees when an app is switched off in the super-admin console.
 *
 * The rule the console's states encode (src/lib/app-availability.ts) is
 * "announce, don't hide": «به‌زودی» and «در حال تعمیر» are temporary facts about
 * the product, and an app that silently disappears from the sidebar looks like
 * a product that never had the capability. So the nav entry stays, wearing its
 * badge, and the route lands here instead of on the app's own screen — the
 * state, the operator's note if they wrote one, and (in Shamsi, like every
 * other date in this product) when it is expected back.
 *
 * This is a UI affordance and nothing more, exactly like `FeatureLock`: the
 * enforcement is `withTenantScope`'s `app_unavailable` refusal in
 * src/lib/auth.ts, which answers 503 for every route the app owns regardless
 * of what the browser renders. A `beta` app is *usable* and so never reaches
 * this screen — it only picks up the badge.
 */
import { ClockIcon, WrenchIcon, CircleSlashIcon, type LucideIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  appForPagePath,
  type AppAvailabilityState,
  type ResolvedAppAvailability,
} from "@/lib/app-availability";
import { appForKey, type AppKey } from "@/lib/apps";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { SERVICE_STATE_META, type ServiceState } from "@/lib/service-activation/catalog";
import { cardClass, PageHeader, PageShell } from "./page-chrome";

const STATE_ICONS: Record<AppAvailabilityState, LucideIcon> = {
  available: ClockIcon,
  beta: ClockIcon,
  coming_soon: ClockIcon,
  maintenance: WrenchIcon,
  disabled: CircleSlashIcon,
};

/** The serialisable slice of the availability map the server hands the client. */
export type AppAvailabilityProps = Partial<Record<AppKey, ResolvedAppAvailability>>;
export type AppActivationProps = Partial<Record<AppKey, ServiceState>>;

function ActivationNotice({ app, state }: { app: AppKey; state: ServiceState }) {
  const meta = SERVICE_STATE_META[state];
  const disabled = meta.customerDisabled;
  const appLabel = appForKey(app).label;
  const description = !meta.retainsData
    ? state === "purging"
      ? "پاک‌سازی داده‌های عملیاتی در جریان است؛ بخشی از داده‌ها ممکن است دیگر در دسترس نباشند. سوابق فعال‌سازی و پرداخت حفظ می‌شوند."
      : "پاک‌سازی داده‌های عملیاتی پایان یافته است؛ سوابق فعال‌سازی و پرداخت حفظ می‌شوند."
    : disabled
      ? "داده‌های موجود تا پایان دورهٔ نگهداری قابل خواندن و خروجی‌گرفتن هستند؛ عملیات نوشتن این برنامه متوقف است."
      : state === "suspended_insufficient_credit"
        ? "اعتبار کیف پول برای اجرای سرویس کافی نیست؛ کارهای زمان‌بندی‌شده متوقف‌اند. این توقف به‌معنای غیرفعال‌سازی توسط شما نیست و داده‌ها حفظ می‌شوند."
        : state === "platform_unavailable"
          ? "سرویس پلتفرم موقتاً در دسترس نیست؛ داده‌های موجود حفظ می‌شوند."
          : `وضعیت سرویس: ${meta.label}. داده‌های موجود حفظ می‌شوند.`;

  return (
    <div
      role="status"
      className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <p className="font-semibold">{appLabel} — {meta.label}</p>
      <p className="mt-1 leading-6">{description}</p>
      <Link href="/settings/services" className="mt-2 inline-flex font-medium underline underline-offset-4">
        مشاهدهٔ وضعیت سرویس‌ها
      </Link>
    </div>
  );
}

/**
 * The badge the sidebar and this screen share, so «به‌زودی» is spelled and
 * coloured the same in both places.
 *
 * Amber is the product's selection/warning hue (docs/design-system.md); a
 * withdrawn app is the only genuinely negative state and takes the muted
 * neutral rather than red — nothing is broken, the app is simply not here.
 */
export function AppStateBadge({
  state,
  label,
  className,
}: {
  state: AppAvailabilityState;
  label: string;
  className?: string;
}) {
  if (state === "available") return null;
  const tone =
    state === "disabled"
      ? "border-border bg-muted text-muted-foreground"
      : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-200";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone} ${className ?? ""}`}
    >
      {label}
    </span>
  );
}

function AvailabilityNotice({
  availability,
  backHref,
  backLabel,
  hideBack,
}: {
  availability: ResolvedAppAvailability;
  /** Where «back» escapes to — a surface that is never gated itself. */
  backHref: string;
  backLabel: string;
  /** True when this screen *is* the back target (no self-links). */
  hideBack: boolean;
}) {
  const Icon = STATE_ICONS[availability.state] ?? ClockIcon;
  const appLabel = appForKey(availability.app).label;
  return (
    <PageShell className="py-6">
      {/* The app's own name is the title — the state is the badge beside it —
          so the screen answers "which app, and why" in one line rather than
          leaving the member to work out what «در حال تعمیر» refers to. */}
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {appLabel}
            <AppStateBadge state={availability.state} label={availability.label} />
          </span>
        }
        description={`«${appLabel}» در حال حاضر در دسترس نیست.`}
      />
      <div className={`${cardClass} mt-4 p-6`}>
        <div className="flex items-start gap-4">
          <span
            aria-hidden="true"
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-border bg-muted text-muted-foreground"
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 space-y-3">
            <p className="text-sm leading-7 text-foreground">{availability.notice}</p>
            {availability.availableFrom ? (
              <p className="text-sm text-muted-foreground">
                زمان در دسترس بودن:{" "}
                <span className="font-medium text-foreground">
                  {toPersianDigits(
                    formatJalali(availability.availableFrom, { withMonthName: true }),
                  )}
                </span>
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              بقیهٔ بخش‌های برنامه مثل همیشه در دسترس هستند.
            </p>
            {hideBack ? null : (
              <Link
                href={backHref}
                className="inline-flex h-9 items-center rounded-lg border border-border bg-card px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted"
              >
                {backLabel}
              </Link>
            )}
          </div>
        </div>
      </div>
    </PageShell>
  );
}

/**
 * Renders `children` when the app that owns the current route is usable, and
 * the explanation screen when it is not.
 *
 * Which app owns the route is answered from the path (`appForPagePath`) rather
 * than threaded through every page, so a page added later is covered by the
 * module registration it already has to make. Routes with no owning app — the
 * workspace chat home `/dashboard`, projects, the connections hub — are never
 * gated, which is also what keeps this screen's "back" link reachable.
 */
export function AppAvailabilityGate({
  availability,
  activationStates,
  children,
}: {
  availability: AppAvailabilityProps;
  activationStates: AppActivationProps;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const app: AppKey | null = appForPagePath(pathname);
  const state = app ? availability[app] : undefined;
  const activationState = app ? activationStates[app] : undefined;
  if (!state || state.usable) {
    return (
      <>
        {app && activationState && activationState !== "active" ? (
          <div className="px-4 pt-4 md:px-6">
            <ActivationNotice app={app} state={activationState} />
          </div>
        ) : null}
        {children}
      </>
    );
  }
  // The escape hatch is the one home that is never gated — the workspace chat
  // /dashboard — unless this screen is already sitting on it.
  return (
    <AvailabilityNotice
      availability={state}
      backHref="/dashboard"
      backLabel="بازگشت به میز کار"
      hideBack={pathname === "/dashboard"}
    />
  );
}
