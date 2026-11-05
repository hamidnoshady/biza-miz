/**
 * The per-site cards at the top of «مدیریت وب‌سایت» (issue #1215 / P1‑1).
 *
 * One card per *actual* site — the Eshobe CMS site and every
 * non-deleted WooCommerce connection — instead of one card per manager with a
 * «N فروشگاه متصل» line. Every fact on a card is either a local count or a
 * recorded timestamp; when a fact is missing the card says «نامشخص» rather than
 * letting a site look ready because a row exists.
 *
 * Server-rendered and link-only: nothing here needs client JavaScript, so the
 * page still paints when the network is poor (the epic's acceptance criterion).
 */
import Link from "next/link";
import {
  ArrowLeftIcon,
  ExternalLinkIcon,
  FileTextIcon,
  Globe2Icon,
  PackageIcon,
  PlugZapIcon,
  ReceiptTextIcon,
  SettingsIcon,
  ShieldAlertIcon,
  StoreIcon,
} from "lucide-react";
import { SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import type { WpAbility } from "@/lib/wp-access";
import {
  SITE_STATE_EXPLANATIONS,
  SITE_STATE_LABELS,
  STORE_VERIFICATION_SOURCE_LABELS,
  siteNeedsAttention,
  siteStateTone,
  siteWorkLabel,
  storeCardTitle,
  type CmsSiteCard,
  type SiteCard,
  type StoreSiteCard,
} from "@/lib/website/site-portfolio";
import { cmsSectionHref, wpSectionHref, type CmsSectionKey } from "./website-routes";

/** What the cards may offer this member — the API re-checks every action. */
export interface SiteCardPermissions {
  /** The CMS sections this business sees (a portfolio site has no shop). */
  cmsSections: readonly CmsSectionKey[];
  canConfigureCms: boolean;
  wpAbilities: readonly WpAbility[];
}

const UNKNOWN_FACT = "نامشخص";

function formatFact(value: string | null): string {
  return value ? formatJalali(value, { withMonthName: true, withTime: true }) : UNKNOWN_FACT;
}

/** Whether the CMS half of the card's quick links may point at a section. */
function cmsLink(key: CmsSectionKey, label: string, icon: typeof Globe2Icon, permissions: SiteCardPermissions) {
  if (!permissions.cmsSections.includes(key)) return null;
  return <QuickLink key={key} href={cmsSectionHref(key)} label={label} icon={icon} />;
}

function storeHref(card: StoreSiteCard, key: "overview" | "orders" | "products" | "content") {
  const href = wpSectionHref(key);
  return `${href}?store=${encodeURIComponent(card.id)}`;
}

function QuickLink({ href, label, icon: Icon }: { href: string; label: string; icon: typeof Globe2Icon }) {
  return (
    <Link
      href={href}
      className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      {label}
    </Link>
  );
}

function Fact({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "danger" }) {
  const unknown = value === UNKNOWN_FACT;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd
        className={`mt-0.5 truncate text-xs font-medium tabular-nums ${
          tone === "danger" ? "text-destructive" : unknown ? "text-muted-foreground" : "text-foreground"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function SiteTitle({
  icon: Icon,
  eyebrow,
  title,
  domain,
  externalHref,
}: {
  icon: typeof Globe2Icon;
  eyebrow: string;
  title: string;
  domain: string | null;
  externalHref: string | null;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-[11px] font-medium text-muted-foreground">{eyebrow}</p>
        <h2 className="mt-0.5 truncate text-base font-semibold text-foreground">{title}</h2>
        {domain && externalHref ? (
          <a
            href={externalHref}
            target="_blank"
            rel="noreferrer"
            dir="ltr"
            className="mt-0.5 inline-flex max-w-full items-center gap-1 text-xs text-primary underline-offset-4 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{domain}</span>
            <ExternalLinkIcon aria-hidden="true" className="size-3 shrink-0" />
            <span className="sr-only">(در زبانهٔ جدید باز می‌شود)</span>
          </a>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">دامنه‌ای ثبت نشده است</p>
        )}
      </div>
    </div>
  );
}

/** The alert a card shows when its state needs a person, with the way to act. */
function AttentionNote({
  card,
  fixHref,
  fixLabel,
}: {
  card: SiteCard;
  fixHref: string | null;
  fixLabel: string;
}) {
  if (!siteNeedsAttention(card.state)) return null;
  const dangerous = card.state === "degraded" || card.state === "action_required";
  return (
    <div
      className={`mt-4 rounded-xl border px-3 py-2.5 text-xs leading-5 ${
        dangerous
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : "border-border bg-muted/60 text-muted-foreground"
      }`}
    >
      <p className="flex items-start gap-2">
        <ShieldAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <span>{SITE_STATE_EXPLANATIONS[card.state]}</span>
      </p>
      {fixHref ? (
        <Link
          href={fixHref}
          className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-full border border-current px-3 text-[11px] font-semibold underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PlugZapIcon aria-hidden="true" className="size-3.5" />
          {fixLabel}
        </Link>
      ) : null}
    </div>
  );
}

function CmsSiteCardView({ card, permissions }: { card: CmsSiteCard; permissions: SiteCardPermissions }) {
  return (
    <SectionCard
      className="flex h-full flex-col"
      bodyClassName="flex flex-1 flex-col"
      title={
        <SiteTitle
          icon={Globe2Icon}
          eyebrow="سایت میزبانی‌شده"
          title={card.domain ?? "سایت بیزامیز"}
          domain={card.domain}
          externalHref={card.domain ? `https://${card.domain}` : null}
        />
      }
      actions={
        <StatusBadge tone={siteStateTone(card.state)} dot>
          {SITE_STATE_LABELS[card.state]}
        </StatusBadge>
      }
    >
      <dl className="grid grid-cols-2 gap-3">
        <Fact label="آخرین بررسی اتصال" value={formatFact(card.lastCheckedAt)} />
        <Fact label="آخرین دادهٔ اعمال‌شده" value={formatFact(card.lastAppliedAt)} />
        <Fact label="محصولات همگام‌شده" value={toPersianDigits(card.syncedProducts)} />
        <Fact
          label="کارهای معوق"
          value={siteWorkLabel(card.work) ?? "ندارد"}
          tone={card.work.failed > 0 ? "danger" : "default"}
        />
      </dl>

      <AttentionNote
        card={card}
        fixHref={permissions.canConfigureCms ? "/settings/connections?tab=website" : null}
        fixLabel="رفع اتصال سایت"
      />

      {permissions.cmsSections.length > 0 ? (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="دسترسی سریع">
          {cmsLink("orders", "سفارش‌ها", ReceiptTextIcon, permissions)}
          {cmsLink("products", "محصولات", PackageIcon, permissions)}
          {cmsLink("pages", "برگه‌ها", FileTextIcon, permissions)}
        </div>
      ) : null}

      <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
        <Button asChild size="lg" className="w-full sm:w-auto">
          <Link href={cmsSectionHref("overview")}>
            مدیریت سایت
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
          </Link>
        </Button>
        {permissions.canConfigureCms ? (
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <Link href={cmsSectionHref("settings")}>
              <SettingsIcon aria-hidden="true" className="size-4" />
              تنظیمات سایت
            </Link>
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}

function StoreSiteCardView({ card, permissions }: { card: StoreSiteCard; permissions: SiteCardPermissions }) {
  const canOpen = permissions.wpAbilities.includes("view");
  const canConfigure = permissions.wpAbilities.includes("configure");
  // The recorded address, so «بازکردن فروشگاه» opens the shop itself rather
  // than a scheme-less host the browser would guess at.
  const openHref = card.url ?? (card.domain ? `https://${card.domain}` : null);
  return (
    <SectionCard
      className="flex h-full flex-col"
      bodyClassName="flex flex-1 flex-col"
      title={
        <SiteTitle
          icon={StoreIcon}
          eyebrow="فروشگاه وردپرس"
          title={storeCardTitle(card)}
          domain={card.domain}
          externalHref={openHref}
        />
      }
      actions={
        <>
          <StatusBadge tone={siteStateTone(card.state)} dot>
            {SITE_STATE_LABELS[card.state]}
          </StatusBadge>
          <StatusBadge>{card.linkMode === "plugin" ? "افزونهٔ وردپرس" : card.linkMode === "rest_api" ? "REST API" : UNKNOWN_FACT}</StatusBadge>
        </>
      }
    >
      <dl className="grid grid-cols-2 gap-3">
        <Fact
          label={card.verificationSource ? STORE_VERIFICATION_SOURCE_LABELS[card.verificationSource] : "آخرین تأیید اتصال"}
          value={formatFact(card.lastVerifiedAt)}
        />
        <Fact label="آخرین دادهٔ اعمال‌شده" value={formatFact(card.lastAppliedAt)} />
        <Fact label="محصولات همگام‌شده" value={toPersianDigits(card.products)} />
        <Fact label="سفارش‌های همگام‌شده" value={toPersianDigits(card.orders)} />
        <Fact
          label="کارهای معوق"
          value={siteWorkLabel(card.work) ?? "ندارد"}
          tone={card.work.failed > 0 ? "danger" : "default"}
        />
      </dl>

      <AttentionNote
        card={card}
        fixHref={canConfigure ? "/settings/connections?tab=woocommerce" : null}
        fixLabel="رفع اتصال فروشگاه"
      />

      {canOpen ? (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="دسترسی سریع">
          <QuickLink href={storeHref(card, "orders")} label="سفارش‌ها" icon={ReceiptTextIcon} />
          <QuickLink href={storeHref(card, "products")} label="محصولات" icon={PackageIcon} />
          <QuickLink href={storeHref(card, "content")} label="محتوا" icon={FileTextIcon} />
        </div>
      ) : null}

      <div className="mt-auto grid gap-2 pt-5 sm:flex sm:flex-wrap">
        {canOpen ? (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link href={storeHref(card, "overview")}>
              مدیریت فروشگاه
              <ArrowLeftIcon aria-hidden="true" className="size-4" />
            </Link>
          </Button>
        ) : null}
        {openHref ? (
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <a href={openHref} target="_blank" rel="noreferrer">
              <ExternalLinkIcon aria-hidden="true" className="size-4" />
              بازکردن فروشگاه
              <span className="sr-only">(در زبانهٔ جدید باز می‌شود)</span>
            </a>
          </Button>
        ) : null}
        {canConfigure ? (
          <Button asChild size="lg" variant="outline" className="w-full sm:w-auto">
            <Link href="/settings/connections?tab=woocommerce">
              <SettingsIcon aria-hidden="true" className="size-4" />
              تنظیمات اتصال
            </Link>
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}

/**
 * The grid of site cards. Attention-first ordering comes from the read model's
 * `portfolioCards`, so a paused or broken site is never below a healthy one.
 */
export function SiteCardGrid({
  cards,
  permissions,
}: {
  cards: readonly SiteCard[];
  permissions: SiteCardPermissions;
}) {
  return (
    <div className="grid items-stretch gap-4 lg:grid-cols-2">
      {cards.map((card) =>
        card.kind === "cms" ? (
          <CmsSiteCardView key={`cms-${card.id}`} card={card} permissions={permissions} />
        ) : (
          <StoreSiteCardView key={`woo-${card.id}`} card={card} permissions={permissions} />
        ),
      )}
    </div>
  );
}
