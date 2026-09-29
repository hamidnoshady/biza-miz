"use client";

/**
 * The workspace overview — what used to be the top of the single 1,000-line
 * business page, rebuilt as a cockpit: identity, the owner and how to reach
 * them, headline numbers, what needs attention, the lifecycle switch, and one
 * card per section so the operator picks where to go instead of scrolling.
 *
 * Issue #755 §19 asks the workspace to read like a modern control centre rather
 * than a stack of admin forms, and names the things an operator should see
 * without opening a section: identity, status, plan, the owner/admin summary,
 * contact email and phone, locations, active members, usage health, last
 * activity and important warnings. Most of that the shell header and this page
 * already had; what was missing was everything about the *people* — the
 * acceptance criterion is explicit that the owner's email and phone must be
 * visible — and anything saying what needs attention.
 *
 * It adds no endpoints. The owner block reads the profile endpoint §1 already
 * built, the health block reads the usage snapshot that already existed, and
 * the warnings are derived from data this page is holding anyway. AI readiness
 * is deliberately *not* re-derived here: it needs the gateway probe, the
 * Features section already shows it properly (§13), and duplicating a heavy read
 * on the landing page is exactly what §11 removed.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { INDUSTRY_LABELS } from "@/lib/industries";
import { roleLabel } from "@/lib/role-labels";
import { allowedLifecycleTransitions } from "@/lib/platform-business-lifecycle";
import { api, Button, Card, fmtDate, SkeletonRows, useCapabilities } from "../../ui";
import { useBusiness } from "./context";
import { businessSections } from "./sections";

interface OwnerProfileMfa {
  method: "sms_otp" | "totp" | null;
  phoneE164: string | null;
  confirmedAt: string | null;
  recoveryCodesRemaining: number;
}

interface OwnerProfile {
  membershipId: string;
  role: string;
  membershipActive: boolean;
  fullName: string;
  email: string | null;
  identityActive: boolean;
  lastLoginAt: string | null;
  membershipCount: number;
  otherBusinesses: { id: string; name: string }[];
  mfa: OwnerProfileMfa;
}

interface Usage {
  orders: number;
  openOrders: number;
  members: number;
  locations: number;
  menuItems: number;
  journalEntries: number;
  lastActivity: string | null;
}

const MFA_LABELS: Record<string, string> = {
  sms_otp: "پیامک یک‌بارمصرف",
  totp: "برنامهٔ Authenticator",
};

/** How long without a single order before the business reads as dormant. */
const DORMANT_ACTIVITY_DAYS = 30;

export default function BusinessOverviewPage() {
  const { business, changeStatus, rootDomain } = useBusiness();
  const caps = useCapabilities();
  const id = business?.id ?? "";

  // `undefined` while loading, `null` when the read failed — so a broken
  // side-read says so instead of rendering "nothing here" as if it were a fact.
  const [profiles, setProfiles] = useState<OwnerProfile[] | null | undefined>(undefined);
  const [usage, setUsage] = useState<Usage | null | undefined>(undefined);

  const load = useCallback(async () => {
    if (!id) return;
    const [owners, snapshot] = await Promise.all([
      api<{ profiles: OwnerProfile[] }>(`/api/platform/businesses/${id}/owner`),
      api<{ usage: Usage }>(`/api/platform/businesses/${id}/usage`),
    ]);
    setProfiles(owners.ok ? owners.data.profiles : null);
    setUsage(snapshot.ok ? snapshot.data.usage : null);
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!business) return null;

  // Transition-aware (see platform-business-lifecycle.ts): restoring from the
  // archive is an owner-level move, so «بازگردانی» is absent for an engineer
  // who holds only `business.suspend`.
  const lifecycle = allowedLifecycleTransitions(business.status, caps);

  const sections = businessSections(business.id, caps).filter(
    (s) => s.href !== `/platform/businesses/${business.id}`,
  );

  const stats = [
    { label: "سفارش‌ها", value: formatPersianNumber(business.orderCount) },
    { label: "اعضای فعال", value: formatPersianNumber(business.memberCount) },
    { label: "شعبه‌ها", value: formatPersianNumber(business.locationCount) },
  ];

  const warnings = buildWarnings(business, usage ?? null);

  return (
    <div className="space-y-4">
      {warnings.length > 0 ? (
        <Card title="نیازمند توجه">
          <ul className="space-y-2 text-sm">
            {warnings.map((w) => (
              <li key={w} className="flex items-start gap-2">
                <span aria-hidden className="mt-0.5 text-amber-600 dark:text-amber-400">
                  ●
                </span>
                <span className="text-foreground">{w}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <OwnerCard profiles={profiles} businessId={business.id} />

      <Card title="اطلاعات کلی">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">نوع کسب‌وکار</dt>
            <dd className="mt-0.5 text-foreground">{INDUSTRY_LABELS[business.industry]}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">منطقهٔ زمانی</dt>
            <dd className="mt-0.5 text-foreground" dir="ltr">
              {business.timezone}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">ایجاد</dt>
            <dd className="mt-0.5 text-foreground">{fmtDate(business.createdAt, true)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">آخرین فعالیت</dt>
            <dd className="mt-0.5 text-foreground">{fmtDate(business.lastActivityAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">تعلیق در</dt>
            <dd className="mt-0.5 text-foreground">{fmtDate(business.suspendedAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">بایگانی در</dt>
            <dd className="mt-0.5 text-foreground">{fmtDate(business.archivedAt)}</dd>
          </div>
        </dl>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{s.value}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card title="وضعیت بهره‌برداری">
        {usage === undefined ? (
          <SkeletonRows rows={2} label="در حال بارگذاری وضعیت بهره‌برداری" />
        ) : usage === null ? (
          <p className="py-3 text-sm text-muted-foreground">خواندن وضعیت بهره‌برداری ناموفق بود.</p>
        ) : (
          <>
            <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="سفارش‌ها" value={usage.orders} />
              <Metric label="سفارش‌های باز" value={usage.openOrders} />
              <Metric label="اعضای فعال" value={usage.members} />
              <Metric label="شعبه‌ها" value={usage.locations} />
              <Metric label="اقلام منو" value={usage.menuItems} />
              <Metric label="اسناد دفتر" value={usage.journalEntries} />
              <div>
                <dt className="text-xs text-muted-foreground">آخرین فعالیت</dt>
                <dd className="mt-0.5 text-foreground">{fmtDate(usage.lastActivity)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">
              وضعیت سلامت هوش مصنوعی (اتصال درگاه، کلید و مدل) در بخش{" "}
              <Link
                href={`/platform/businesses/${business.id}/features`}
                className="text-sky-700 hover:underline dark:text-sky-300"
              >
                برنامه‌ها و قابلیت‌ها
              </Link>{" "}
              نمایش داده می‌شود.
            </p>
          </>
        )}
      </Card>

      {lifecycle.length > 0 ? (
        <Card title="چرخهٔ حیات">
          <div className="flex flex-wrap items-center gap-2">
            {lifecycle.map((t) => (
              <Button
                key={`${t.from}-${t.to}`}
                variant={t.to === "archived" ? "ghost" : "primary"}
                onClick={() => void changeStatus(t.to, t.label)}
              >
                {t.label}
              </Button>
            ))}
            <span className="text-xs text-muted-foreground">
              تعلیق داده‌ها را پاک نمی‌کند؛ فقط ورود اعضا را می‌بندد.
            </span>
          </div>
        </Card>
      ) : null}

      {rootDomain ? (
        <p className="text-xs text-muted-foreground">
          نشانی:{" "}
          <a
            dir="ltr"
            className="text-sky-700 hover:underline dark:text-sky-300"
            href={`https://${business.subdomain}.${rootDomain}`}
            target="_blank"
            rel="noreferrer"
          >
            {business.subdomain}.{rootDomain}
          </a>
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        <Link
          href={`/platform/audit?businessId=${business.id}`}
          className="text-sky-700 hover:underline dark:text-sky-300"
        >
          رویدادهای این کسب‌وکار ←
        </Link>
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        {sections.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-sky-400/40 hover:bg-card"
          >
            <p className="text-sm font-semibold text-sky-700 group-hover:underline dark:text-sky-300">
              {s.label}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{s.hint}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Who runs this business, and how to reach them (§19's "owner/admin summary,
 * contact email/phone").
 *
 * A list, not a single card, because a business can have more than one
 * login-holding member — the same reason §1 built the profile section as a list.
 * The section holds the editors; this is the glance.
 */
function OwnerCard({
  profiles,
  businessId,
}: {
  profiles: OwnerProfile[] | null | undefined;
  businessId: string;
}) {
  return (
    <Card title="مالک و مدیران">
      {profiles === undefined ? (
        <SkeletonRows rows={2} label="در حال بارگذاری مالک و مدیران" />
      ) : profiles === null ? (
        <p className="py-3 text-sm text-muted-foreground">خواندن مالک و مدیران ناموفق بود.</p>
      ) : profiles.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          این کسب‌وکار هنوز مالک یا مدیری با حساب ورود ندارد.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {profiles.map((p) => (
            <li key={p.membershipId} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {p.fullName}{" "}
                  <span className="text-xs font-normal text-muted-foreground">
                    ({roleLabel(p.role)})
                  </span>
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <span dir="ltr" className="break-all">
                    {p.email ?? "—"}
                  </span>
                  {p.mfa.phoneE164 ? (
                    <>
                      {" • "}
                      <span dir="ltr">{p.mfa.phoneE164}</span>
                    </>
                  ) : null}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                {p.mfa.method ? (
                  <span>{MFA_LABELS[p.mfa.method] ?? p.mfa.method}</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">بدون ورود دومرحله‌ای</span>
                )}
                {!p.membershipActive ? (
                  <span className="text-red-700 dark:text-red-400">غیرفعال</span>
                ) : null}
                {p.membershipCount > 1 ? (
                  <span>عضو {toPersianDigits(p.membershipCount)} کسب‌وکار</span>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        <Link
          href={`/platform/businesses/${businessId}/profile`}
          className="text-sky-700 hover:underline dark:text-sky-300"
        >
          مشاهده و ویرایش مالک و مدیران ←
        </Link>
      </p>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-foreground">{formatPersianNumber(value)}</dd>
    </div>
  );
}

/**
 * The "important warnings" line of §19, derived rather than fetched.
 *
 * Each of these is something an operator would otherwise have to open two
 * sections to notice, and each is decided from data this page already holds —
 * no extra request, no second source of truth for the same fact.
 */
function buildWarnings(
  business: {
    status: string;
    memberCount: number;
    locationCount: number;
    lastActivityAt: string | null;
  },
  usage: Usage | null,
): string[] {
  const warnings: string[] = [];

  if (business.status === "suspended") {
    warnings.push("این کسب‌وکار معلق است؛ اعضا نمی‌توانند وارد شوند.");
  }
  if (business.status === "archived") {
    warnings.push("این کسب‌وکار بایگانی شده است. بازگردانی آن به `business.archive` نیاز دارد.");
  }
  if (business.memberCount === 0) {
    warnings.push("هیچ عضو فعالی ندارد؛ کسی نمی‌تواند وارد شود.");
  }
  if (business.locationCount === 0) {
    warnings.push("شعبه‌ای ثبت نشده است؛ فروش بدون شعبه ممکن نیست.");
  }

  const lastActivity = usage?.lastActivity ?? business.lastActivityAt;
  if (lastActivity) {
    const idleDays = Math.floor((Date.now() - new Date(lastActivity).getTime()) / 86_400_000);
    if (idleDays >= DORMANT_ACTIVITY_DAYS) {
      warnings.push(`هیچ فعالیتی در ${toPersianDigits(idleDays)} روز گذشته ثبت نشده است.`);
    }
  }

  return warnings;
}

