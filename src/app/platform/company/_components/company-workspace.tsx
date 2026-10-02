"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Building2Icon,
  CalculatorIcon,
  ContactRoundIcon,
  FolderKanbanIcon,
  MegaphoneIcon,
  ExternalLinkIcon,
  Globe2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MoneyProvider } from "@/components/money/money-context";
import { cn } from "@/lib/utils";
import { api, ErrorBox, InfoBox, PlatformPageSkeleton } from "../../ui";
import {
  COMPANY_APP_LABELS,
  PRESET_LABELS,
  type CompanyAppKey,
  type PlatformCompanyMemberSummary,
  type PlatformCompanyStatus,
  type PlatformCompanyState,
} from "@/lib/platform-company-types";

/** The five work areas. «فضای کاری من» is a work area of the shell, not a fifth app. */
const DESTINATIONS = [
  { key: "workspace", href: "/platform/company/workspace", icon: FolderKanbanIcon },
  { key: "accounting", href: "/platform/company/accounting", icon: CalculatorIcon },
  { key: "crm", href: "/platform/company/crm", icon: ContactRoundIcon },
  { key: "growth", href: "/platform/company/growth", icon: MegaphoneIcon },
  { key: "websites", href: "/platform/company/websites", icon: Globe2Icon },
] as const satisfies readonly { key: CompanyAppKey; href: string; icon: unknown }[];

type DestinationKey = (typeof DESTINATIONS)[number]["key"];

const STATE_MESSAGES: Record<PlatformCompanyState, { title: string; body: string }> = {
  not_provisioned: {
    title: "فضای داخلی هنوز راه‌اندازی نشده است",
    body:
      "این عملیات یک کسب‌وکار محافظت‌شده با پروفایل خدمات و SaaS، حساب‌های اولیه، چهار برنامه و میز کار ایجاد می‌کند. " +
      "اجرای دوباره امن است و داده یا ماندهٔ افتتاحیه را بازنویسی نمی‌کند.",
  },
  company_exists_not_member: {
    title: "شرکت پلتفرم وجود دارد اما شما عضو آن نیستید",
    body:
      "کسب‌وکار داخلی روی این استقرار ساخته شده است؛ فقط مدیر پلتفرمی که دسترسی «ایجاد کسب‌وکار» دارد می‌تواند عضویت شما را بسازد. " +
      "شرکت دومی ساخته نمی‌شود.",
  },
  member_inactive: {
    title: "عضویت شما در فضای شرکت غیرفعال است",
    body:
      "تغییر نقش و لغو دسترسی بلافاصله اعمال می‌شود. فعال‌سازی دوباره یک اقدام مدیریتی صریح است و به‌طور خودکار انجام نمی‌شود؛ " +
      "با مالک شرکت پلتفرم هماهنگ کنید.",
  },
  tenant_user_inactive: {
    title: "کاربر متناظر شما در شرکت غیرفعال است",
    body:
      "عضویت شما معتبر است اما رکورد کاربریِ متناظر در کسب‌وکار داخلی غیرفعال شده است، بنابراین نشستی ساخته نمی‌شود. " +
      "یک مدیر با دسترسی کافی می‌تواند عضویت را ترمیم کند.",
  },
  company_unavailable: {
    title: "کسب‌وکار پلتفرم در دسترس نیست",
    body:
      "وضعیت این کسب‌وکار «فعال» نیست. ابتدا وضعیت آن را در مدیریت پلتفرم بررسی کنید.",
  },
  ready: { title: "", body: "" },
};

export function CompanyWorkspace({
  active,
  children,
}: {
  active?: DestinationKey;
  children?: React.ReactNode;
}) {
  const [status, setStatus] = useState<PlatformCompanyStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "setup" | "repair">("");
  const load = async () => {
    const result = await api<{ company: PlatformCompanyStatus; error?: string }>(
      "/api/platform/company/status",
    );
    if (!result.ok) setError(result.data.error ?? "خواندن وضعیت فضای شرکت ناموفق بود.");
    else {
      setStatus(result.data.company);
      setError("");
    }
  };
  useEffect(() => {
    void load();
  }, []);

  async function runSetup(repairMembership: boolean) {
    setBusy(repairMembership ? "repair" : "setup");
    setError("");
    const result = await api<{ error?: string }>("/api/platform/company/setup", {
      method: "POST",
      body: JSON.stringify({ repairMembership }),
    });
    setBusy("");
    if (!result.ok) setError(result.data.error ?? "راه‌اندازی انجام نشد.");
    else await load();
  }

  if (!status && !error) return <PlatformPageSkeleton />;

  const company = status?.company ?? null;
  const entitlements = useMemo(() => new Set(status?.entitlements ?? []), [status]);
  const state = status?.state ?? "not_provisioned";
  const message = STATE_MESSAGES[state];

  return (
    <MoneyProvider unit={status?.moneyUnit ?? "toman"}>
      <div className="mx-auto w-full max-w-6xl space-y-5" dir="rtl">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-700 dark:text-teal-300">
              <Building2Icon className="size-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold">کسب‌وکار پلتفرم</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                فضای عملیاتی داخلی شرکت؛ جدا از مدیریت زیرساخت و مشتریان پلتفرم
              </p>
            </div>
          </div>
          <Link className="text-sm text-primary hover:underline" href="/platform">
            بازگشت به مدیریت پلتفرم
          </Link>
        </header>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        {state !== "ready" ? (
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-bold">{message.title}</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{message.body}</p>
            {!status?.provisioningSupported ? (
              <p className="mt-3 text-sm text-muted-foreground">
                راه‌اندازی فقط روی استقرار مرکزی انجام می‌شود؛ این گره نقش مرکزی ندارد.
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {status?.canProvision && status.provisioningSupported && state !== "company_unavailable" ? (
                <>
                  <Button onClick={() => void runSetup(false)} disabled={busy !== ""}>
                    {busy === "setup"
                      ? "در حال راه‌اندازی…"
                      : state === "not_provisioned"
                        ? "راه‌اندازی کسب‌وکار پلتفرم"
                        : "تکمیل و ترمیم دسترسی"}
                  </Button>
                  {state === "member_inactive" || state === "tenant_user_inactive" ? (
                    <Button
                      variant="ghost"
                      onClick={() => void runSetup(true)}
                      disabled={busy !== ""}
                      title="فعال‌سازی دوبارهٔ عضویت یک اقدام مدیریتی صریح است"
                    >
                      {busy === "repair" ? "در حال ترمیم…" : "فعال‌سازی عضویت من"}
                    </Button>
                  ) : null}
                </>
              ) : (
                <p className="text-sm text-muted-foreground">
                  شما اجازهٔ راه‌اندازی ندارید؛ این دکمه فقط برای مدیر پلتفرمی با دسترسی «ایجاد
                  کسب‌وکار» نمایش داده می‌شود.
                </p>
              )}
            </div>
          </section>
        ) : (
          <>
            <InfoBox>
              {company?.name} · نقش دسترسی:{" "}
              {status?.membership ? PRESET_LABELS[status.membership.preset] : "—"}
            </InfoBox>
            <nav
              aria-label="بخش‌های کسب‌وکار پلتفرم"
              className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5"
            >
              {DESTINATIONS.map((item) => {
                const Icon = item.icon;
                const enabled = entitlements.has(item.key);
                if (!enabled) {
                  return (
                    <span
                      key={item.key}
                      title="این بخش برای شرکت پلتفرم غیرفعال است"
                      aria-disabled="true"
                      className="flex min-h-12 items-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
                    >
                      <Icon className="size-4" />
                      {COMPANY_APP_LABELS[item.key]}
                    </span>
                  );
                }
                return (
                  <Link
                    key={item.key}
                    href={item.href}
                    aria-current={active === item.key ? "page" : undefined}
                    className={cn(
                      "flex min-h-12 items-center gap-2 rounded-xl border px-3 py-2 text-sm transition-colors",
                      active === item.key
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-card hover:bg-muted",
                    )}
                  >
                    <Icon className="size-4" />
                    {COMPANY_APP_LABELS[item.key]}
                  </Link>
                );
              })}
            </nav>
            {children ?? <CompanyHome />}
          </>
        )}
      </div>
    </MoneyProvider>
  );
}

function CompanyHome() {
  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {DESTINATIONS.map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.key} className="rounded-2xl border border-border bg-card p-4">
              <Icon className="size-5 text-primary" />
              <h2 className="mt-3 font-bold">{COMPANY_APP_LABELS[item.key]}</h2>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                ورود به موتور مشترک و داده‌های ایزولهٔ شرکت پلتفرم.
              </p>
              <Link
                href={item.href}
                className="mt-3 inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                باز کردن <ExternalLinkIcon className="size-3.5" />
              </Link>
            </article>
          );
        })}
      </section>
      <CompanyMembers />
    </>
  );
}

function CompanyMembers() {
  const [members, setMembers] = useState<PlatformCompanyMemberSummary[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    const result = await api<{
      members?: PlatformCompanyMemberSummary[];
      presets?: string[];
      error?: string;
    }>("/api/platform/company/members");
    if (result.ok) {
      setMembers(result.data.members ?? []);
      setError("");
    } else if (result.data.error !== "company_permission_denied") {
      setError(result.data.error ?? "خواندن اعضا ناموفق بود.");
    } else {
      setMembers([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  async function update(member: PlatformCompanyMemberSummary, preset: string, active: boolean) {
    setError("");
    setBusy(member.platformAdminId);
    const result = await api<{ error?: string }>("/api/platform/company/members", {
      method: "PATCH",
      body: JSON.stringify({ platformAdminId: member.platformAdminId, preset, active }),
    });
    setBusy(null);
    if (!result.ok) setError(result.data.error ?? "ذخیرهٔ دسترسی ناموفق بود.");
    else await load();
  }
  if (members === null && !error) return null;
  if (members !== null && members.length === 0) return null;
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="font-bold">کارکنان کسب‌وکار پلتفرم</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        نقش‌های این بخش مستقل از نقش زیرساختی مدیر پلتفرم‌اند؛ لغو دسترسی بلافاصله اعمال می‌شود.
      </p>
      {error ? (
        <div className="mt-3">
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[42rem] text-sm">
          <thead>
            <tr className="border-b text-right text-muted-foreground">
              <th className="p-2">عضو</th>
              <th className="p-2">نقش شرکت</th>
              <th className="p-2">وضعیت</th>
            </tr>
          </thead>
          <tbody>
            {members?.map((member) => (
              <tr key={member.platformAdminId} className="border-b last:border-0">
                <td className="p-2">
                  <strong>{member.fullName}</strong>
                  <div dir="ltr" className="text-xs text-muted-foreground">
                    {member.email}
                  </div>
                </td>
                <td className="p-2">
                  <select
                    aria-label={`نقش ${member.fullName}`}
                    className="h-10 rounded-md border bg-background px-2"
                    value={member.preset ?? "sales_success"}
                    disabled={busy === member.platformAdminId}
                    onChange={(event) => void update(member, event.target.value, true)}
                  >
                    {Object.entries(PRESET_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="p-2">
                  <Button
                    variant={member.active ? "destructive" : "outline"}
                    size="sm"
                    disabled={busy === member.platformAdminId}
                    onClick={() => void update(member, member.preset ?? "sales_success", !member.active)}
                  >
                    {member.active ? "لغو دسترسی" : "فعال‌سازی"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * A thin adapter for the four work areas whose Platform Business value is the
 * relationship context around the shared engine, not a second copy of it.
 *
 * It states what the shared engine already does and adds the one thing the
 * tenant engine cannot discover on its own, then gets out of the way.
 */
export function CompanyEnginePage({
  active,
  title,
  description,
  notes,
  children,
  openLabel = "ورود به فضای عملیاتی",
}: {
  active: DestinationKey;
  title: string;
  description: string;
  notes: string[];
  children?: React.ReactNode;
  openLabel?: string;
}) {
  return (
    <CompanyWorkspace active={active}>
      <section className="rounded-2xl border border-border bg-card p-5">
        <h2 className="text-lg font-bold">{title}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
        <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
          {notes.map((note) => (
            <li key={note} className="rounded-xl bg-muted/60 px-3 py-2">
              {note}
            </li>
          ))}
        </ul>
        <Button asChild className="mt-5">
          <a href={`/api/platform/company/open?app=${active}`}>
            {openLabel} <ExternalLinkIcon />
          </a>
        </Button>
      </section>
      {children}
    </CompanyWorkspace>
  );
}
