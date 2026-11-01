"use client";

/**
 * Growth → «کانال ترب» (issue #894, Wave 1).
 *
 * Torob is a **channel**, not a second app: this screen lists the websites
 * Website Management already runs and says, one row each, whether Torob can
 * publish from it. There is deliberately no "add your site" field. The issue's
 * first rule is that only platform-managed, actively connected websites may
 * enroll, so the only thing a merchant can pick here is a website the platform
 * already knows — and the only way to add one is to connect it in the screen that
 * owns it, which every ineligible row links to.
 *
 * What this wave can honestly say, and what it may not:
 *
 *   - it knows **site catalogue ready** (the connection is active and, for
 *     WooCommerce, product sync is on) and **Torob authorization** (the merchant
 *     approved the shop, or pasted their own token);
 *   - it does *not* know whether Torob accepted a webhook, is fetching the feed,
 *     or has indexed a single product. Those arrive in Wave 2 beside the data that
 *     can prove them, so this screen says so out loud instead of rendering a green
 *     «منتشر شد» it cannot back up. «متصل» here means *authorized*, never *listed*.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangleIcon, CheckCircle2Icon, ExternalLinkIcon, PowerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, InfoBox, inputClass } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";
import { cmsSectionHref, wpSectionHref } from "@/app/(app)/websites/website-routes";
import type { TorobWebsiteKind, TorobWebsiteRow, TorobWebsiteState } from "@/lib/torob/eligibility";
import type { TorobShopView } from "@/app/api/growth/torob/shops/route";

/**
 * One row as the screen sees it: the eligibility view's shape, with the *API's*
 * shop in place of the narrow one `eligibility.ts` decides state from. The route
 * owns that type, so a field added to the payload is added here too.
 */
type TorobRow = Omit<TorobWebsiteRow, "shop"> & { shop: TorobShopView | null };

interface ShopsResponse {
  websites: TorobRow[];
  capabilities: { authorization: boolean; feed: boolean; listing: boolean; attribution: boolean };
}

/**
 * What each state says, in the merchant's words — never the internal `reason` —
 * and which of the design system's four status tones it wears. «آماده» and
 * «متصل» are positive, a waiting approval is in progress (amber), and the two
 * states that need a person's decision are the neutral and the danger tones.
 */
const STATE_COPY: Record<
  TorobWebsiteState,
  { label: string; tone: "active" | "positive" | "neutral" | "danger"; help: string }
> = {
  eligible: {
    label: "آمادهٔ اتصال",
    tone: "positive",
    help: "این وب‌سایت فعال است و کاتالوگش آماده؛ می‌توانید آن را به ترب وصل کنید.",
  },
  needs_attention: {
    label: "نیاز به رسیدگی",
    tone: "danger",
    help: "پیش از اتصال به ترب باید این وب‌سایت درست شود؛ دلیلش پایین نوشته شده است.",
  },
  connected: {
    label: "متصل و مجاز",
    tone: "positive",
    help: "اجازهٔ انتشار برای این وب‌سایت صادر شده است.",
  },
  pending_approval: {
    label: "در انتظار تأیید ترب",
    tone: "active",
    help: "درخواست به ترب فرستاده شده و منتظر تأیید آن است؛ تا تأیید نشود چیزی منتشر نمی‌شود.",
  },
  inactive: {
    label: "اتصال غیرفعال",
    tone: "neutral",
    help: "اتصال این وب‌سایت فعال نیست؛ تا وصل نشود ترب چیزی از آن نمی‌گیرد.",
  },
  disconnected: {
    label: "قطع‌شده",
    tone: "neutral",
    help: "اجازهٔ انتشار لغو شده است. ثبت‌نام فروشگاه در ترب حذف نشده و می‌توانید دوباره وصل کنید.",
  },
};

/**
 * The internal reason, said in the merchant's language. An unmapped reason is
 * shown as the raw value rather than hidden: an operator should not have to guess,
 * and a new registry error must not look like silence.
 */
const REASON_COPY: Record<string, string> = {
  product_sync_disabled: "همگام‌سازی محصولات این اتصال خاموش است.",
  catalogue_unavailable: "کاتالوگ محصولات این وب‌سایت در دسترس نیست.",
  connection_inactive: "اتصال وب‌سایت فعال نیست.",
  revoked_by_merchant: "اجازهٔ انتشار پیش‌تر لغو شده است.",
  domain_already_enrolled: "این دامنه پیش‌تر به یک فروشگاه ترب دیگر وصل شده است.",
  token_expired: "اعتبارنامهٔ ترب منقضی شده است.",
};

/**
 * Where a website with a problem is fixed — the screen that owns it, not this
 * one. Both are routes of the Website app, taken from its own route helpers so a
 * manager that moves cannot leave this link pointing at nothing.
 */
const FIX_HREF: Record<TorobWebsiteKind, string> = {
  woocommerce: wpSectionHref("overview"),
  eshobe_cms: cmsSectionHref("overview"),
};

function StateBadge({ state }: { state: TorobWebsiteState }) {
  const copy = STATE_COPY[state];
  return (
    <span className="inline-flex items-center gap-1">
      {state === "connected" ? <CheckCircle2Icon className="h-3.5 w-3.5 text-emerald-700 dark:text-emerald-300" aria-hidden /> : null}
      {state === "needs_attention" ? <AlertTriangleIcon className="h-3.5 w-3.5 text-destructive" aria-hidden /> : null}
      <StatusBadge tone={copy.tone}>{copy.label}</StatusBadge>
    </span>
  );
}

type Shop = TorobShopView;

export function TorobSection({ canManage, canConfigure }: { canManage: boolean; canConfigure: boolean }) {
  const [data, setData] = useState<ShopsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** The row whose token form is open — one at a time, so a pasted secret is never left in a second row. */
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [actionError, setActionError] = useState("");

  const load = useCallback(async () => {
    const { ok, data: body, status } = await api<Partial<ShopsResponse> & { error?: string }>(
      "/api/growth/torob/shops",
    );
    if (!ok || !body.websites) {
      setLoadError(errorMessageOrRaw(body.error) ?? `دریافت وضعیت ترب ناموفق بود (${status}).`);
      return;
    }
    setData(body as ShopsResponse);
    setLoadError("");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(key: string, body: Record<string, unknown>, field: string) {
    setBusy(`${key}:${field}`);
    setActionError("");
    const { ok, data: answer } = await api<{ error?: string }>("/api/growth/torob/shops", {
      method: "POST",
      body: JSON.stringify(body),
    });
    setBusy(null);
    if (!ok) {
      setActionError(errorMessageOrRaw(answer.error) ?? "این کار انجام نشد.");
      return;
    }
    setTokenFor(null);
    setToken("");
    await load();
  }

  if (loadError) return <ErrorBox>{loadError}</ErrorBox>;
  if (!data) return <SectionCardSkeleton />;

  const websites = data.websites;
  const working = (key: string, field: string) => busy === `${key}:${field}`;

  return (
    <div className="space-y-5">
      <SectionCard
        title="انتشار در ترب"
        description="هر وب‌سایتی که در بیزامیز مدیریت می‌کنید، یک فروشگاه مستقل و جدا در ترب دارد."
      >
        <InfoBox>
          این نسخه اتصال و اجازهٔ انتشار را مدیریت می‌کند. وضعیت ارسال فید و ایندکس‌شدن محصولات در ترب
          هنوز نمایش داده نمی‌شود: «متصل» یعنی ترب اجازهٔ انتشار داده است، نه اینکه محصولی در ترب دیده
          می‌شود.
        </InfoBox>
      </SectionCard>

      {websites.length === 0 ? (
        <SectionCard title="وب‌سایتی برای اتصال نیست">
          <p className="text-sm text-muted-foreground">
            ترب فقط از وب‌سایت‌هایی منتشر می‌کند که در بیزامیز ساخته و به‌طور فعال متصل شده باشند. برای
            شروع، یک فروشگاه ووکامرس یا یک سایت را در بخش وب‌سایت وصل کنید.
          </p>
          <div className="mt-3 text-sm">
            <Link className="font-medium text-primary hover:underline" href="/websites/overview">
              رفتن به مدیریت وب‌سایت
            </Link>
          </div>
        </SectionCard>
      ) : null}

      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

      {websites.map((row) => {
        const key = `${row.kind}:${row.connectionId}`;
        const copy = STATE_COPY[row.state];
        const shop = row.shop;
        const canConnect = canManage && (row.state === "eligible" || row.state === "disconnected");
        const fixable = row.state === "needs_attention" || row.state === "inactive";

        return (
          <SectionCard key={key}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground" dir="ltr">
                    {row.domain}
                  </span>
                  <StateBadge state={row.state} />
                  <span className="text-xs text-muted-foreground">
                    {row.kind === "woocommerce" ? "ووکامرس" : "سایت"}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{copy.help}</p>
                {row.reason ? (
                  <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{REASON_COPY[row.reason] ?? row.reason}</p>
                ) : null}
                {fixable ? (
                  <Link
                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    href={FIX_HREF[row.kind]}
                  >
                    رسیدگی در بخش وب‌سایت
                    <ExternalLinkIcon className="h-3 w-3" aria-hidden />
                  </Link>
                ) : null}
                {shop ? <ShopLine shop={shop} /> : null}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {canConnect ? (
                  <Button
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        key,
                        { action: "connect", kind: row.kind, connectionId: row.connectionId },
                        "connect",
                      )
                    }
                  >
                    {working(key, "connect")
                      ? "در حال اتصال…"
                      : row.state === "disconnected"
                        ? "اتصال دوباره"
                        : "اتصال به ترب"}
                  </Button>
                ) : null}

                {canConfigure && shop && shop.authorizationState !== "revoked" ? (
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => {
                      setTokenFor(tokenFor === key ? null : key);
                      setToken("");
                    }}
                  >
                    ثبت توکن ترب
                  </Button>
                ) : null}

                {canManage && shop && shop.authorizationState === "authorized" ? (
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(key, { action: shop.enabled ? "disable" : "enable", shopId: shop.id }, "switch")
                    }
                  >
                    <PowerIcon className="h-4 w-4" aria-hidden />
                    {shop.enabled ? "خاموش کردن انتشار" : "روشن کردن انتشار"}
                  </Button>
                ) : null}

                {canManage && shop && shop.authorizationState === "authorized" ? (
                  <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => void act(key, { action: "revoke", shopId: shop.id }, "revoke")}
                  >
                    قطع اتصال
                  </Button>
                ) : null}
              </div>
            </div>

            {canConfigure && tokenFor === key && shop ? (
              <form
                className="mt-3 space-y-2 border-t border-border pt-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(key, { action: "token", shopId: shop.id, token }, "token");
                }}
              >
                <label className="block text-sm font-medium text-foreground" htmlFor={`torob-token-${key}`}>
                  توکن فروشگاهی ترب
                </label>
                <p className="text-xs text-muted-foreground">
                  اگر فروشگاه شما در ترب تأیید شده است، توکن خود را از پنل ترب بردارید. توکن رمزگذاری
                  می‌شود و دیگر نمایش داده نمی‌شود.
                </p>
                <input
                  id={`torob-token-${key}`}
                  className={inputClass}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                />
                <div className="flex gap-2">
                  <Button type="submit" disabled={busy !== null || token.trim().length === 0}>
                    ثبت توکن
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setTokenFor(null)}>
                    انصراف
                  </Button>
                </div>
              </form>
            ) : null}
          </SectionCard>
        );
      })}

      {data.capabilities.feed ? null : (
        <p className="text-xs text-muted-foreground">
          گزارش فید و ایندکس محصولات در ترب در نسخهٔ بعدی این بخش اضافه می‌شود.
        </p>
      )}
    </div>
  );
}

/**
 * The facts a shop row carries. Every one of them is something the platform
 * stored itself — no figure here is Torob's claim about the shop, because Wave 1
 * has not asked Torob anything yet.
 */
function ShopLine({ shop }: { shop: Shop }) {
  const parts = [
    shop.authMode === "manual_token"
      ? `اعتبارنامهٔ دستی${shop.tokenHint ? ` (پایان: ${shop.tokenHint})` : ""}`
      : "تأییدشده از سوی ترب",
    shop.publicationRule === "all" ? "همهٔ محصولات" : "محصولات انتخابی",
    shop.enabled ? "انتشار روشن" : "انتشار خاموش",
  ];
  if (shop.lastCheckedAt) {
    parts.push(`آخرین بررسی: ${toPersianDigits(formatJalali(new Date(shop.lastCheckedAt)))}`);
  }
  return <p className="mt-2 text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}
