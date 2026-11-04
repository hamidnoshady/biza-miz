import Link from "next/link";
import {
  CheckIcon,
  DownloadIcon,
  Globe2Icon,
  PlugZapIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  StoreIcon,
  WandSparklesIcon,
} from "lucide-react";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import type { Permission } from "@/lib/permissions";
import { PageHeader, PageShell, SectionCard } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { Button } from "@/components/ui/button";
import { WORDPRESS_PLUGIN_ZIP_URL } from "@/lib/integrations/wp-plugin-release";
import { websiteHomeState } from "@/lib/website/managers-service";
import { websitePortfolioState } from "@/lib/website/portfolio-service";
import {
  portfolioCards,
  portfolioHasReadablePart,
  portfolioShowsOnboarding,
  sitePortfolioTotals,
  type SitePortfolioState,
  type SitePortfolioTotals,
} from "@/lib/website/site-portfolio";
import {
  completedStepCount,
  isStepComplete,
  WEBSITE_SETUP_STEPS,
  type WebsiteSetupState,
} from "@/lib/website/setup";
import { toPersianDigits } from "@/lib/digits";
import { wpAbilitiesOf } from "@/lib/wp-access";
import { visibleCmsSections, type WebsiteManagersState } from "./website-routes";
import { SiteCardGrid, type SiteCardPermissions } from "./site-cards";

/**
 * «مدیریت وب‌سایت» — the app's home, built as a **portfolio of actual sites**
 * (issue #1215 / P1‑1), not a manager chooser.
 *
 * Three rules shape this page:
 *
 *  1. **One card per site.** The CMS site and *each* non-deleted WooCommerce
 *     connection get their own card (`site-cards.tsx`), with the health and the
 *     timestamps they can actually evidence. The read model is
 *     `portfolio-service.ts`; a fact it could not read is «نامشخص», never green.
 *  2. **No false empty state.** Onboarding appears only when both halves were
 *     read *and* both are empty. A refused half says so, a failed half says so
 *     with a retry — neither is «شما هنوز سایتی ندارید».
 *  3. **The two ways to get another site sit at the bottom.** Once a site
 *     exists, «افزودن سایت دیگر» is a secondary section, shown even when the
 *     business already runs both kinds.
 */
export async function WebsiteAppHome() {
  const session = await getSession();
  // The parent layout rejects unauthenticated users. Keeping this guard also
  // makes the component safe when rendered on its own in a server test.
  if (!session) return null;

  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<Permission> = access?.permissions ?? new Set<Permission>();

  // One snapshot supplies the manager cards and setup progress; the portfolio
  // is the per-site half of the same page. Neither writes, and neither dials a
  // site: the cards' health is what the panel last recorded, with its timestamp.
  const [{ managers, setup }, portfolio] = await Promise.all([
    websiteHomeState(session.businessId),
    websitePortfolioState(session, permissions),
  ]);

  const built = completedStepCount(setup);
  const cards = portfolioCards(portfolio);
  const totals = sitePortfolioTotals(cards);
  const onboarding = portfolioShowsOnboarding(portfolio);
  const cardPermissions: SiteCardPermissions = {
    cmsSections: visibleCmsSections(managers),
    canConfigureCms: permissions.has("cms.configure"),
    wpAbilities: wpAbilitiesOf(permissions),
  };

  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="مدیریت وب‌سایت"
        description={onboarding ? ONBOARDING_DESCRIPTION : portfolioSummary(totals, portfolio)}
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

      {onboarding ? (
        <Onboarding setup={setup} built={built} />
      ) : (
        <>
          {!portfolioHasReadablePart(portfolio) ? (
            <PortfolioUnavailable
              denied={portfolio.cms.status === "denied" && portfolio.stores.status === "denied"}
            />
          ) : (
            <>
              {cards.length > 0 ? <SiteCardGrid cards={cards} permissions={cardPermissions} /> : null}
              {portfolio.cms.status === "error" ? (
                <PartProblem part="سایت بیزامیز" detail="وضعیت سایت روی سایت‌ساز پلتفرم خوانده نشد." />
              ) : null}
              {portfolio.cms.status === "denied" ? (
                <PartProblem
                  part="سایت بیزامیز"
                  detail="برای دیدن وضعیت سایت روی سایت‌ساز پلتفرم، مجوز «مشاهدهٔ سایت» لازم است. نبودِ دسترسی به معنی نبودِ سایت نیست."
                  denied
                />
              ) : null}
              {portfolio.stores.status === "error" ? (
                <PartProblem part="فروشگاه‌های وردپرس" detail="فهرست فروشگاه‌های وردپرسی خوانده نشد." />
              ) : null}
              {portfolio.stores.status === "denied" ? (
                <PartProblem
                  part="فروشگاه‌های وردپرس"
                  detail="برای دیدن فروشگاه‌های ووکامرس، مجوز «مشاهدهٔ ووکامرس» لازم است. نبودِ دسترسی به معنی نبودِ فروشگاه نیست."
                  denied
                />
              ) : null}
              <MoreSites managers={managers} built={built} portfolio={portfolio} />
            </>
          )}
        </>
      )}
    </PageShell>
  );
}

const ONBOARDING_DESCRIPTION =
  "سایت تازه بسازید یا فروشگاه وردپرسی خودتان را وصل کنید. سایت‌ساز بیزامیز و وردپرس مستقل‌اند و می‌توانید هم‌زمان از هر دو استفاده کنید.";

/** The one-line header summary: counts only, and «نامشخص» is never dressed up. */
function portfolioSummary(totals: SitePortfolioTotals, portfolio: SitePortfolioState): string {
  const parts = [portfolio.cms, portfolio.stores];
  const failed = parts.some((part) => part.status === "error");
  const denied = parts.some((part) => part.status === "denied");
  const suffix = failed
    ? " · بخشی از وضعیت خوانده نشد"
    : denied
      ? " · دسترسی به بخشی از سایت‌ها ندارید"
      : "";

  if (totals.sites === 0) {
    return failed
      ? "وضعیت سایت‌ها در این لحظه خوانده نشد؛ این به معنی نبودِ سایت نیست."
      : "سایت یا فروشگاهی برای نمایش خوانده نشد؛ پایین صفحه می‌توانید یکی بسازید یا وصل کنید.";
  }

  const line = [`${toPersianDigits(totals.sites)} سایت`];
  if (totals.stores > 0) line.push(`${toPersianDigits(totals.stores)} فروشگاه وردپرس`);
  line.push(
    totals.needingAttention > 0
      ? `${toPersianDigits(totals.needingAttention)} مورد نیازمند اقدام`
      : "همه فعال",
  );
  if (totals.failedWork > 0) line.push(`${toPersianDigits(totals.failedWork)} کار ناموفق`);
  else if (totals.pendingWork > 0) line.push(`${toPersianDigits(totals.pendingWork)} کار در صف`);
  return `${line.join(" · ")}${suffix}`;
}

/**
 * Neither half could be read: a failure gets a retry, a refusal gets its own
 * words. Neither is dressed up as «you have no website».
 */
function PortfolioUnavailable({ denied }: { denied: boolean }) {
  if (denied) {
    return (
      <SectionCard title="دسترسی به وضعیت سایت‌ها">
        <div className="rounded-xl border border-border bg-muted/60 px-3 py-2.5 text-xs leading-6 text-muted-foreground">
          <p className="flex items-start gap-2">
            <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              برای دیدن وضعیت سایت روی سایت‌ساز پلتفرم مجوز «مشاهدهٔ سایت» و برای فروشگاه‌های ووکامرس مجوز
              «مشاهدهٔ ووکامرس» لازم است. نبودِ دسترسی به معنی نبودِ سایت نیست؛ برای دریافت دسترسی با مالک
              کسب‌وکار صحبت کنید.
            </span>
          </p>
        </div>
      </SectionCard>
    );
  }
  return (
    <SectionCard title="وضعیت سایت‌ها خوانده نشد">
      <div role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs leading-6 text-destructive">
        <p className="flex items-start gap-2 font-semibold">
          <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          این خطا به معنی نبودِ سایت نیست؛ فقط وضعیت سایت‌ها در این لحظه خوانده نشد.
        </p>
        <p className="mt-1 text-destructive/90">
          چند لحظه بعد دوباره تلاش کنید. اگر تکرار شد، وضعیت سرویس را از تیم پشتیبانی بپرسید.
        </p>
      </div>
      <div className="mt-4">
        <Button asChild variant="outline">
          <Link href="/websites/overview">
            <RefreshCwIcon aria-hidden="true" className="size-4" />
            تلاش دوباره
          </Link>
        </Button>
      </div>
    </SectionCard>
  );
}

/** One half failed or was refused: the other half's cards stay on the page. */
function PartProblem({ part, detail, denied = false }: { part: string; detail: string; denied?: boolean }) {
  return (
    <SectionCard title={denied ? `دسترسی به ${part}` : `وضعیت ${part} خوانده نشد`}>
      <div
        role={denied ? undefined : "alert"}
        className={`rounded-xl border px-3 py-2.5 text-xs leading-6 ${
          denied
            ? "border-border bg-muted/60 text-muted-foreground"
            : "border-destructive/20 bg-destructive/5 text-destructive"
        }`}
      >
        <p className="flex items-start gap-2">
          <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{detail}</span>
        </p>
      </div>
      {denied ? null : (
        <div className="mt-4">
          <Button asChild variant="outline">
            <Link href="/websites/overview">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
              تلاش دوباره
            </Link>
          </Button>
        </div>
      )}
    </SectionCard>
  );
}

/**
 * The secondary «another site» block. It stays on the page after the first
 * site exists — that is the whole point of moving it down rather than away —
 * and offers only what the two systems still allow: one CMS site per business,
 * any number of WooCommerce stores.
 */
function MoreSites({
  managers,
  built,
  portfolio,
}: {
  managers: WebsiteManagersState;
  built: number;
  portfolio: SitePortfolioState;
}) {
  const canBuildCms = portfolio.cms.status === "ok" && portfolio.cms.value === null;
  const canConnectStore = portfolio.stores.status === "ok";
  if (!canBuildCms && !canConnectStore) return null;

  return (
    <SectionCard
      title="افزودن سایت دیگر"
      description="سایت‌ساز بیزامیز و وردپرس مستقل‌اند؛ هرکدام اتصال و منوی جدا دارد و می‌توانید هم‌زمان از هر دو استفاده کنید."
    >
      <div className="flex flex-wrap gap-2">
        {canBuildCms ? (
          <Button asChild variant="outline">
            <Link href="/websites/cms/setup">
              <WandSparklesIcon aria-hidden="true" className="size-4" />
              {built > 0 ? "ادامهٔ ساخت سایت در بیزامیز" : "ساخت سایت در بیزامیز"}
            </Link>
          </Button>
        ) : null}
        {canConnectStore ? (
          <Button asChild variant="outline">
            <Link href="/settings/connections?tab=woocommerce">
              <PlugZapIcon aria-hidden="true" className="size-4" />
              اتصال فروشگاه وردپرسی دیگر
            </Link>
          </Button>
        ) : null}
      </div>
      {canConnectStore ? (
        <p className="mt-3 flex items-start gap-2 text-xs leading-6 text-muted-foreground">
          <DownloadIcon aria-hidden="true" className="mt-1 size-4 shrink-0" />
          <span>
            افزونهٔ وردپرس را از{" "}
            <a
              href={WORDPRESS_PLUGIN_ZIP_URL}
              className="font-medium text-primary hover:underline"
              dir="ltr"
            >
              نسخهٔ رسمی
            </a>{" "}
            دانلود کنید و در «افزونه‌ها ← افزودن ← بارگذاری افزونه» نصب کنید؛ مراحل کامل در صفحهٔ اتصال فروشگاه آمده است.
          </span>
        </p>
      ) : null}
      {managers.cms.connected && portfolio.cms.status === "ok" ? (
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          هر کسب‌وکار یک سایت روی سایت‌ساز بیزامیز دارد؛ برای تغییر دامنه یا طراحی همان سایت، «تنظیمات سایت» را باز کنید.
        </p>
      ) : null}
    </SectionCard>
  );
}

/** The no-website page: the two real options, in the order the epic names them. */
function Onboarding({ setup, built }: { setup: WebsiteSetupState; built: number }) {
  return (
    <>
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <SectionCard
          className="flex h-full flex-col"
          bodyClassName="flex flex-1 flex-col"
          title={
            <OptionTitle
              icon={Globe2Icon}
              eyebrow="گزینهٔ ۱ — سایت میزبانی‌شده"
              title="ساخت سایت در بیزامیز"
            />
          }
          description="دامنه، CDN، محتوا، فروشگاه و هزینه‌های سایت روی پلتفرم بیزامیز."
        >
          <CmsSetupProgress setup={setup} completed={built} />

          {setup.lastError && built === 0 ? (
            <div
              role="alert"
              className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-xs leading-5 text-destructive"
            >
              <span className="font-semibold">آخرین تلاش برای ساخت سایت ناموفق بود.</span>{" "}
              برای دیدن جزئیات و تلاش دوباره، ساخت سایت را ادامه دهید.
            </div>
          ) : null}

          <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link href="/websites/cms/setup">
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
          </div>
        </SectionCard>

        <SectionCard
          className="flex h-full flex-col"
          bodyClassName="flex flex-1 flex-col"
          title={
            <OptionTitle
              icon={StoreIcon}
              eyebrow="گزینهٔ ۲ — سایت خودتان"
              title="اتصال فروشگاه وردپرسی"
            />
          }
          description="سایتی که از قبل دارید و روی هاست خودتان میزبانی می‌شود."
        >
          <ol className="list-inside list-decimal space-y-2 text-xs leading-6 text-muted-foreground">
            <li>
              فایل{" "}
              <a
                href={WORDPRESS_PLUGIN_ZIP_URL}
                className="font-medium text-primary hover:underline"
                dir="ltr"
              >
                افزونهٔ رسمی بیزامیز
              </a>{" "}
              را دانلود کنید — همین نسخهٔ نصب‌شدنی، نه مخزن گیت‌هاب و نه فایل به‌روزرسانی.
            </li>
            <li>در وردپرس، «افزونه‌ها ← افزودن ← بارگذاری افزونه» را باز کنید و همان فایل را نصب و فعال کنید.</li>
            <li>منوی «بیزامیز» در پیشخوان وردپرس را باز کنید و آدرس این پنل و توکن اتصال را وارد کنید.</li>
          </ol>

          <div className="mt-4 flex items-start gap-2 rounded-xl bg-muted/60 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
            <RefreshCwIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              روش جایگزین: بدون افزونه هم می‌توانید با کلیدهای REST ووکامرس وصل شوید؛ در همان صفحهٔ اتصال، «REST API» را انتخاب کنید.
            </span>
          </div>

          <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
            <Button asChild size="lg" className="w-full sm:w-auto">
              <Link href="/settings/connections?tab=woocommerce">
                <PlugZapIcon aria-hidden="true" className="size-4" />
                اتصال فروشگاه وردپرسی
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
              <a href={WORDPRESS_PLUGIN_ZIP_URL} download>
                <DownloadIcon aria-hidden="true" className="size-4" />
                دانلود افزونه
              </a>
            </Button>
          </div>
        </SectionCard>
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
  );
}

function OptionTitle({
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
