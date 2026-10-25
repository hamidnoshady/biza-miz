"use client";

/**
 * «سایت‌ساز بیزامیز» — the «اتصال‌های فنی» hub's tab for the platform-site
 * connection: which CMS site this account points at, its domain, its key.
 *
 * This is the *only* place the connection is made: the credential is posted
 * once, probed before it is stored, and kept encrypted server-side
 * (migration 0122) — the browser never sees it again. Everything *about* the
 * site once it exists — content, the store, DNS and publishing, what the POS
 * pushes to it — stays in «مدیریت وب‌سایت», which links here for the
 * connection itself.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { CmsConnectionSummary } from "@/lib/cms/connections";
import { WEBSITE_ERROR_LABELS } from "@/lib/website/adapter";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";
import {
  api,
  ErrorBox,
  errorMessageOrRaw,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
} from "@/app/dashboard/ui";
import { DomainDialog } from "@/app/(app)/websites/cms/cms-sections";
import { cmsSectionHref } from "@/app/(app)/websites/website-routes";

export function CmsConnectionPanel() {
  const [connection, setConnection] = useState<CmsConnectionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"test" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editingDomain, setEditingDomain] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<{ connected: boolean; connection: CmsConnectionSummary | null }>(
      "/api/cms/website/state",
    );
    setLoading(false);
    if (!ok) {
      setError(errorMessageOrRaw((data as { error?: string }).error));
      return;
    }
    setError(null);
    setConnection(data.connection);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function test() {
    setBusy("test");
    setError(null);
    setMessage(null);
    const res = await api<{ siteName: string | null; error?: string }>("/api/connections/website/test", {
      method: "POST",
    });
    setBusy(null);
    if (!res.ok) {
      const code = (res.data as { error?: string }).error;
      setError((WEBSITE_ERROR_LABELS as Record<string, string>)[code ?? ""] ?? errorMessageOrRaw(code));
    } else {
      setMessage(res.data.siteName ? `اتصال برقرار است — «${res.data.siteName}»` : "اتصال برقرار است.");
    }
  }

  async function disconnect() {
    if (!window.confirm("قطع اتصال؟ سایت و محتوای آن روی سایت‌ساز می‌ماند؛ فقط این اتصال برداشته می‌شود."))
      return;
    setBusy("disconnect");
    const { ok, data } = await api<{ error?: string }>("/api/cms/website/connection", { method: "DELETE" });
    setBusy(null);
    if (!ok) {
      toast.error(errorMessageOrRaw(data.error) || "قطع اتصال انجام نشد؛ دوباره تلاش کنید.");
      return;
    }
    setMessage(null);
    toast.success("اتصال برداشته شد.");
    await load();
  }

  if (loading) {
    return <SectionCardSkeleton rows={4} />;
  }

  if (!connection) {
    return (
      <div className="space-y-4 sm:space-y-5">
        <SectionCard
          title="اتصال سایت"
          description="سایتی که روی سایت‌ساز بیزامیز ساخته شده را به همین حساب وصل کنید. کلید پیش از ذخیره آزمایش می‌شود و پس از ذخیره، رمزنگاری‌شده روی سرور می‌ماند و دیگر نمایش داده نمی‌شود."
        >
          <ErrorBox>{error}</ErrorBox>
          <ConnectExistingSite onDone={load} />
        </SectionCard>
        <SectionCard
          title="هنوز سایتی نساخته‌اید؟"
          description="ساخت سایت — دامنه، CDN، نوع سایت و ساخت — در «مدیریت وب‌سایت» انجام می‌شود؛ پس از ساخت، همین‌جا وصل است."
        >
          <Button asChild variant="outline" className="px-4">
            <Link href={cmsSectionHref("setup")}>رفتن به ساخت سایت</Link>
          </Button>
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <SectionCard
        title="اتصال سایت"
        description="کلید این اتصال روی سرور و رمزنگاری‌شده نگه‌داری می‌شود و هیچ‌وقت به مرورگر داده نمی‌شود."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={test} disabled={busy !== null}>
              {busy === "test" ? "در حال آزمایش…" : "آزمایش اتصال"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setEditingDomain(true)}>
              <PencilIcon className="size-4" />
              تغییر دامنه
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              disabled={busy !== null}
              onClick={disconnect}
            >
              <Trash2Icon className="size-4" />
              قطع اتصال
            </Button>
          </div>
        }
      >
        <ErrorBox>{error}</ErrorBox>
        {message ? <InfoBox>{message}</InfoBox> : null}
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">دامنهٔ سایت</dt>
            <dd dir="ltr" className="mt-0.5 truncate text-start text-sm font-medium text-foreground">
              {connection.siteDomain}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">آدرس سایت‌ساز</dt>
            <dd dir="ltr" className="mt-0.5 truncate text-start text-sm font-medium text-foreground">
              {connection.baseUrl}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">وضعیت اتصال</dt>
            <dd className="mt-0.5">
              <StatusBadge tone={connection.status === "active" ? "positive" : "neutral"}>
                {connection.status === "active" ? "فعال" : "غیرفعال"}
              </StatusBadge>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">کلید API</dt>
            <dd className="mt-0.5 text-sm font-medium text-foreground">ذخیره‌شده و رمزنگاری‌شده</dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard
        title="مدیریت سایت"
        description="محتوا، فروشگاه، دامنه و انتشار، و اینکه چه چیزی از صندوق به سایت فرستاده شود — همه در «مدیریت وب‌سایت»."
      >
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" className="px-4">
            <Link href={cmsSectionHref("overview")}>میز کار سایت</Link>
          </Button>
          <Button asChild variant="outline" className="px-4">
            <Link href={cmsSectionHref("settings")}>تنظیمات همگام‌سازی</Link>
          </Button>
        </div>
      </SectionCard>

      {editingDomain ? (
        <DomainDialog
          currentDomain={connection.siteDomain}
          onClose={() => setEditingDomain(false)}
          onSaved={() => {
            setEditingDomain(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connect a site that already exists on the CMS                       */
/* ------------------------------------------------------------------ */

/**
 * Connecting a site that already exists on the CMS.
 *
 * Deliberately *only* the connect half: creating a new site is the website
 * app's setup wizard's job, because a new site needs a domain, a CDN
 * decision, a type and a plan — four answers this three-field form has
 * nowhere to put. What is left here is the case the wizard cannot cover: a
 * site built already, waiting to be pointed at.
 */
function ConnectExistingSite({ onDone }: { onDone: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [siteDomain, setSiteDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyName, setKeyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = () => {
    setBusy(true);
    setError("");
    api<{ error?: string }>("/api/cms/website/connect", {
      method: "POST",
      body: JSON.stringify({ baseUrl, siteDomain, apiKey, keyName: keyName || undefined }),
    })
      .then(({ ok, data }) => {
        if (ok) {
          toast.success("وب‌سایت متصل شد.");
          onDone();
        } else setError(errorMessageOrRaw(data.error));
      })
      .finally(() => setBusy(false));
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ErrorBox>{error}</ErrorBox>
      <Field label="آدرس سرور سایت‌ساز" hint="آدرس کنترل‌پنل پلتفرم — بدون اسلش پایانی.">
        <input
          className={inputClass}
          dir="ltr"
          placeholder="https://cms.eshobe.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          required
        />
      </Field>
      <Field label="دامنهٔ سایت" hint="فقط میزبان — مثل acme.ir">
        <input
          className={inputClass}
          dir="ltr"
          placeholder="acme.ir"
          value={siteDomain}
          onChange={(event) => setSiteDomain(event.target.value)}
          required
        />
      </Field>
      <Field label="کلید API سایت" hint="از بخش کلیدهای API پلتفرم صادر می‌شود و فقط یک‌بار نمایش داده می‌شود.">
        <input
          className={inputClass}
          dir="ltr"
          type="password"
          placeholder="eshobe_live_…"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          required
        />
      </Field>
      <Field label="نام اتصال (اختیاری)">
        <input
          className={inputClass}
          placeholder="پنل مدیریت"
          value={keyName}
          onChange={(event) => setKeyName(event.target.value)}
        />
      </Field>
      <PrimaryButton disabled={busy}>{busy ? "در حال اتصال…" : "اتصال"}</PrimaryButton>
    </form>
  );
}
