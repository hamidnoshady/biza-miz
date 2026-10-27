import Link from "next/link";
import {
  ArrowLeftIcon,
  CheckIcon,
  ExternalLinkIcon,
  Globe2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  StoreIcon,
  WandSparklesIcon,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import { PageHeader, PageShell, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { Button } from "@/components/ui/button";
import { websiteHomeState } from "@/lib/website/managers-service";
import {
  completedStepCount,
  isStepComplete,
  WEBSITE_SETUP_STEPS,
  type WebsiteSetupState,
} from "@/lib/website/setup";
import { toPersianDigits } from "@/lib/digits";
import { CMS_NAV_ITEMS, WP_NAV_ITEMS } from "./website-nav";
import {
  cmsSectionHref,
  hasAnyWebsite,
  visibleCmsSections,
  visibleWpSections,
  wpSectionHref,
  type WebsiteManagersState,
} from "./website-routes";

/**
 * «مدیریت وب‌سایت» — a useful status dashboard, not merely a manager chooser.
 * Both website systems remain visible because a business may use either or both.
 */
export async function WebsiteAppHome() {
  const session = await getSession();
  // The parent layout rejects unauthenticated users. Keeping this guard also
  // makes the component safe when rendered on its own in a server test.
  if (!session) return null;

  // One snapshot supplies the manager cards and setup progress. Previously the
  // setup row was queried twice and could disagree with the manager status when
  // provisioning completed between the two reads.
  const { managers, setup } = await websiteHomeState(session.businessId);
  const built = completedStepCount(setup);
  const hasWebsite = hasAnyWebsite(managers);

  const cmsCard = (
    <CmsCard key="cms" managers={managers} setup={setup} built={built} />
  );
  const wpCard = <WpCard key="wp" managers={managers} />;

  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="مدیریت وب‌سایت"
        description={
          hasWebsite
            ? "وضعیت سایت‌های کسب‌وکار را یک‌جا ببینید و مستقیم وارد بخش مورد نظر شوید."
            : "سایت تازه بسازید یا فروشگاه وردپرسی خودتان را وصل کنید. سایت‌ساز بیزامیز و وردپرس مستقل‌اند و می‌توانید هم‌زمان از هر دو استفاده کنید."
        }
        actions={
          <>
            <KnowledgeHelpButton section="website" />
            <AskAssistant
              app="website"
              context="وضعیت وب‌سایت کسب‌وکار را بررسی کن: سایت روی سایت‌ساز پلتفرم و فروشگاه وردپرسی، اتصال‌ها و سفارش‌های آنلاین."
            />
          </>
        }
      />

      {hasWebsite ? (
        // A site exists: the page is its status, not an introduction. The
        // setup progress, the «which option» comparison and the empty-state
        // cards are for a business with no website and never show here.
        <>
          <div className={`grid items-stretch gap-4 ${managers.cms.connected && managers.wp.connected ? "lg:grid-cols-2" : ""}`}>
            {managers.cms.connected ? cmsCard : null}
            {managers.wp.connected ? wpCard : null}
          </div>
          {!managers.cms.connected || !managers.wp.connected ? (
            <AddAnotherSite managers={managers} built={built} />
          ) : null}
        </>
      ) : (
        <>
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            {cmsCard}
            {wpCard}
          </div>

          <SectionCard
            title="کدام گزینه برای من مناسب است؟"
            description="هر دو گزینه سایت کسب‌وکار شما را به صندوق متصل می‌کنند، اما مالکیت میزبانی و شیوهٔ مدیریتشان متفاوت است."
          >
            <div className="grid gap-4 text-sm sm:grid-cols-2">
              <ComparisonItem
                icon={Globe2Icon}
                title="سایت‌ساز بیزامیز"
                text="برای ساخت سایت تازه بدون درگیری با هاست، نگهداری و زیرساخت. دامنه، CDN و اشتراک را همین‌جا مدیریت می‌کنید."
              />
              <ComparisonItem
                icon={StoreIcon}
                title="وردپرس و ووکامرس"
                text="برای سایتی که از قبل دارید و روی هاست خودتان نگهداری می‌کنید. این سامانه فروشگاه را مدیریت و با صندوق همگام می‌کند."
              />
            </div>
            <div className="mt-4 flex items-start gap-2 border-t border-border/80 pt-4 text-xs leading-5 text-muted-foreground">
              <ShieldCheckIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
              در هر دو روش، صندوق منبع اصلی قیمت و موجودی است تا فروش حضوری و آنلاین با یکدیگر مغایرت پیدا نکنند.
            </div>
          </SectionCard>
        </>
      )}
    </PageShell>
  );
}

/** Links straight into a connected manager's sections — what the nav would list. */
function QuickLinks({ links }: { links: readonly { href: string; label: string }[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-2" aria-label="دسترسی سریع">
      {links.map((link) => (
        <li key={link.href}>
          <Link
            href={link.href}
            className="inline-flex min-h-8 items-center rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {link.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function CmsCard({
  managers,
  setup,
  built,
}: {
  managers: WebsiteManagersState;
  setup: WebsiteSetupState;
  built: number;
}) {
  const connected = managers.cms.connected;
  const links = CMS_NAV_ITEMS.filter(
    (item) => item.key !== "overview" && item.key !== "setup" && visibleCmsSections(managers).includes(item.key),
  ).map((item) => ({ href: cmsSectionHref(item.key), label: item.label }));
  return (
    <SectionCard
      className="flex h-full flex-col"
      bodyClassName="flex flex-1 flex-col"
      title={<ManagerTitle icon={Globe2Icon} eyebrow="سایت میزبانی‌شده" title="سایت‌ساز بیزامیز" />}
      description="دامنه، CDN، محتوا، فروشگاه و هزینه‌های سایت روی پلتفرم بیزامیز."
      actions={
        <StatusBadge tone={connected ? "positive" : "neutral"}>
          {connected ? "متصل و آماده" : "راه‌اندازی نشده"}
        </StatusBadge>
      }
    >
      {connected ? <ConnectedCms domain={managers.cms.domain} /> : <CmsSetupProgress setup={setup} completed={built} />}

      {connected ? <QuickLinks links={links} /> : null}

      {setup.lastError && !connected ? (
        <div role="alert" className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs leading-5 text-destructive">
          <span className="font-semibold">آخرین تلاش برای ساخت سایت ناموفق بود.</span>{" "}
          برای دیدن جزئیات و تلاش دوباره، ساخت سایت را ادامه دهید.
        </div>
      ) : null}

      <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
        {connected ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href={cmsSectionHref("overview")}>
              مدیریت سایت
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        ) : (
          <>
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link href={cmsSectionHref("setup")}>
                <WandSparklesIcon aria-hidden="true" className="size-4" />
                {built > 0 ? "ادامهٔ ساخت سایت" : "ساخت سایت جدید"}
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <Link href="/settings/connections?tab=website">
                <PlugZapIcon aria-hidden="true" className="size-4" />
                اتصال سایت موجود
              </Link>
            </Button>
          </>
        )}
        <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
          <Link href={cmsSectionHref("billing")}>اشتراک و صورت‌حساب</Link>
        </Button>
      </div>
    </SectionCard>
  );
}

function WpCard({ managers }: { managers: WebsiteManagersState }) {
  const connected = managers.wp.connected;
  const links = WP_NAV_ITEMS.filter((item) => item.key !== "overview" && visibleWpSections(managers).includes(item.key)).map(
    (item) => ({ href: wpSectionHref(item.key), label: item.label }),
  );
  return (
    <SectionCard
      className="flex h-full flex-col"
      bodyClassName="flex flex-1 flex-col"
      title={<ManagerTitle icon={StoreIcon} eyebrow="سایت مستقل" title="وردپرس و ووکامرس" />}
      description="مدیریت سایت وردپرسی خودتان و همگام‌سازی محصولات، سفارش‌ها و مشتریان."
      actions={
        <StatusBadge tone={connected ? "positive" : "neutral"}>{connected ? "متصل" : "وصل نشده"}</StatusBadge>
      }
    >
      {connected ? (
        <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/70 p-3.5 dark:border-emerald-500/20 dark:bg-emerald-500/10">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
              <ShieldCheckIcon aria-hidden="true" className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="font-semibold text-foreground">
                {toPersianDigits(managers.wp.storeCount)} فروشگاه متصل
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                برای بررسی سلامت هر اتصال و زمان آخرین همگام‌سازی، وارد میز کار فروشگاه شوید.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border p-4">
          <p className="text-sm font-medium text-foreground">فروشگاه وردپرسی دارید؟</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            با افزونهٔ وردپرس یا کلیدهای REST ووکامرس آن را متصل کنید. اطلاعات ورود فروشگاه در مرورگر نمایش داده نمی‌شود.
          </p>
        </div>
      )}

      {connected ? <QuickLinks links={links} /> : null}

      <div className="mt-4 flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        <RefreshCwIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        قیمت و موجودی از صندوق به فروشگاه ارسال می‌شود؛ سفارش‌ها و مشتریان فروشگاه به این سامانه برمی‌گردند.
      </div>

      <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
        {connected ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href={wpSectionHref("overview")}>
              مدیریت فروشگاه
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        ) : (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href="/settings/connections?tab=woocommerce">
              <PlugZapIcon aria-hidden="true" className="size-4" />
              اتصال فروشگاه وردپرسی
            </Link>
          </Button>
        )}
      </div>
    </SectionCard>
  );
}

/**
 * Once one site exists, the other manager is a quiet offer rather than a
 * second full card with its own empty state.
 */
function AddAnotherSite({ managers, built }: { managers: WebsiteManagersState; built: number }) {
  return (
    <SectionCard title="افزودن سایت دیگر" description="می‌توانید هم‌زمان از هر دو مدیر سایت استفاده کنید؛ هرکدام اتصال و منوی جدا دارد.">
      <div className="flex flex-wrap gap-2">
        {!managers.cms.connected ? (
          <Button asChild variant="outline">
            <Link href={cmsSectionHref("setup")}>
              <WandSparklesIcon aria-hidden="true" className="size-4" />
              {built > 0 ? "ادامهٔ ساخت سایت در بیزامیز" : "ساخت سایت در بیزامیز"}
            </Link>
          </Button>
        ) : null}
        {!managers.wp.connected ? (
          <Button asChild variant="outline">
            <Link href="/settings/connections?tab=woocommerce">
              <PlugZapIcon aria-hidden="true" className="size-4" />
              اتصال فروشگاه وردپرسی
            </Link>
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}

function ManagerTitle({
  icon: Icon,
  eyebrow,
  title,
}: {
  icon: typeof Globe2Icon;
  eyebrow: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-0.5 text-base font-semibold text-foreground sm:text-lg">{title}</h2>
      </div>
    </div>
  );
}

function ConnectedCms({ domain }: { domain: string | null }) {
  return (
    <div className="rounded-xl border border-emerald-200/70 bg-emerald-50/70 p-3.5 dark:border-emerald-500/20 dark:bg-emerald-500/10">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200">
          <ShieldCheckIcon aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-foreground">سایت فعال است</p>
          {domain ? (
            <a
              href={`https://${domain}`}
              target="_blank"
              rel="noreferrer"
              dir="ltr"
              className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-sm text-primary underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>{domain}</span>
              <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="sr-only">(در زبانهٔ جدید باز می‌شود)</span>
            </a>
          ) : (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              اتصال برقرار است؛ دامنه در میز کار سایت نمایش داده می‌شود.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function CmsSetupProgress({ setup, completed }: { setup: WebsiteSetupState; completed: number }) {
  const total = WEBSITE_SETUP_STEPS.length;
  const progress = Math.round((completed / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-foreground">پیشرفت راه‌اندازی</span>
        <span className="tabular-nums text-muted-foreground">
          {toPersianDigits(completed)} از {toPersianDigits(total)} گام
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="پیشرفت ساخت سایت"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        className="mt-2 h-2 overflow-hidden rounded-full bg-muted"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${progress}%` }} />
      </div>
      <ol className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {WEBSITE_SETUP_STEPS.map((step, index) => {
          const done = isStepComplete(setup, step.key);
          return (
            <li
              key={step.key}
              className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-xs ${
                done ? "border-primary/20 bg-primary/5 text-foreground" : "border-border text-muted-foreground"
              }`}
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {done ? <CheckIcon aria-hidden="true" className="size-3" /> : toPersianDigits(index + 1)}
              </span>
              <span className="truncate">{step.title}</span>
            </li>
          );
        })}
      </ol>
      {completed === 0 ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          هنوز شروع نشده است؛ اطلاعات هر گام به‌صورت خودکار ذخیره می‌شود.
        </p>
      ) : null}
    </div>
  );
}

function ComparisonItem({ icon: Icon, title, text }: { icon: typeof Globe2Icon; title: string; text: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <Icon aria-hidden="true" className="size-4.5" />
      </span>
      <div className="min-w-0">
        <h3 className="font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
