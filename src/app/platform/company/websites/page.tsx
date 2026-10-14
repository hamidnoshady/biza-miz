"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, ErrorBox, InfoBox, Field } from "../../ui";
import { CompanyWorkspace } from "../_components/company-workspace";
import { formatJalali } from "@/lib/jalali";
import type { PlatformCompanySiteOption, SiteCredentialSummary } from "@/lib/platform-company-types";

const PROVIDER_LABELS: Record<string, string> = { eshobe: "Eshobe", wordpress: "WordPress / Woo" };

/**
 * Platform Business website management.
 *
 * Two halves, both real:
 *
 *   * the **managers** — Eshobe CMS and WordPress/Woo — open in the shared
 *     Website app, exactly as they do for any business;
 *   * **lead-form credentials** — one per real site record, show-once, revocable
 *     and rate-limited, which is the part only the Platform Business console can
 *     issue because the credential belongs to the company's own public sites.
 *
 * A credential is bound to a site row (`eshobe_cms_connections` or
 * `integration_connections`), never to a free-text label alone, so it can submit
 * leads for that one site and nothing else — no fleet-wide content access.
 */
export default function Page() {
  const [credentials, setCredentials] = useState<SiteCredentialSummary[]>([]);
  const [sites, setSites] = useState<PlatformCompanySiteOption[]>([]);
  const [siteId, setSiteId] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [provider, setProvider] = useState<"eshobe" | "wordpress">("eshobe");
  const [shownToken, setShownToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "create" | string>("");

  const load = async () => {
    const [credentialResult, siteResult] = await Promise.all([
      api<{ credentials?: SiteCredentialSummary[]; error?: string }>(
        "/api/platform/company/websites/credentials",
      ),
      api<{ sites?: PlatformCompanySiteOption[]; error?: string }>(
        "/api/platform/company/websites/sites",
      ),
    ]);
    if (credentialResult.ok) setCredentials(credentialResult.data.credentials ?? []);
    else setError(credentialResult.data.error ?? "خواندن اعتبارهای سایت ناموفق بود.");
    if (siteResult.ok) setSites(siteResult.data.sites ?? []);
  };
  useEffect(() => {
    void load();
  }, []);

  const availableSites = sites.filter((site) => site.provider === provider);

  async function create() {
    setError("");
    setShownToken("");
    setBusy("create");
    const result = await api<{ token?: string; error?: string }>(
      "/api/platform/company/websites/credentials",
      {
        method: "POST",
        body: JSON.stringify({ siteKey, provider, requestsPerMinute: 30, siteId: siteId || null }),
      },
    );
    setBusy("");
    if (!result.ok) setError(result.data.error ?? "ساخت اعتبار ناموفق بود.");
    else {
      setShownToken(result.data.token ?? "");
      setSiteKey("");
      setSiteId("");
      await load();
    }
  }
  async function revoke(id: string) {
    setBusy(id);
    setError("");
    const result = await api<{ error?: string }>("/api/platform/company/websites/credentials", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    });
    setBusy("");
    if (!result.ok) setError(result.data.error ?? "لغو اعتبار ناموفق بود.");
    else await load();
  }

  return (
    <CompanyWorkspace active="websites">
      <div className="space-y-4">
        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="text-lg font-bold">مدیریت وب‌سایت</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Eshobe و WordPress/Woo همتای مستقل‌اند. مدیریت محتوا و اتصال‌ها در موتور مشترک انجام
            می‌شود.
          </p>
          <Button asChild className="mt-4">
            <a href="/api/platform/company/open?app=websites">ورود به مدیریت وب‌سایت</a>
          </Button>
        </section>

        <section className="rounded-2xl border border-border bg-card p-5">
          <h2 className="font-bold">اعتبار فرم لید سایت</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            هر اعتبار فقط به یک سایت واقعی متصل است، تنها امکان ثبت فرم دارد و پس از ساخت فقط یک‌بار
            نمایش داده می‌شود. چرخش کلید، کلید قبلی را بلافاصله بی‌اثر می‌کند.
          </p>
          {error ? (
            <div className="mt-3">
              <ErrorBox>{error}</ErrorBox>
            </div>
          ) : null}
          {shownToken ? (
            <div className="mt-3">
              <InfoBox>
                کلید را اکنون در محل امن ذخیره کنید:{" "}
                <code dir="ltr" className="select-all break-all">
                  {shownToken}
                </code>
              </InfoBox>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Field label="ارائه‌دهنده سایت">
              <select
                aria-label="ارائه‌دهنده سایت"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as typeof provider);
                  setSiteId("");
                }}
              >
                <option value="eshobe">Eshobe</option>
                <option value="wordpress">WordPress</option>
              </select>
            </Field>
            <Field label="سایت" hint="سایت باید در مدیریت وب‌سایتِ شرکت تعریف شده باشد.">
              <select
                aria-label="سایت"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                value={siteId}
                onChange={(event) => {
                  setSiteId(event.target.value);
                  const site = availableSites.find((candidate) => candidate.id === event.target.value);
                  if (site && !siteKey) setSiteKey(site.name);
                }}
              >
                <option value="">بدون اتصال به سایت مشخص</option>
                {availableSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                    {site.domain ? ` — ${site.domain}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="شناسه نمایشی">
              <input
                aria-label="شناسه سایت"
                value={siteKey}
                onChange={(event) => setSiteKey(event.target.value)}
                placeholder="مثلاً وب‌سایت اصلی"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </Field>
          </div>
          <Button
            className="mt-2"
            onClick={() => void create()}
            disabled={!siteKey.trim() || busy === "create"}
          >
            {busy === "create" ? "در حال ساخت…" : "ساخت یا چرخش کلید"}
          </Button>

          <div className="mt-4 space-y-2">
            {credentials.map((credential) => (
              <div
                key={credential.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 p-3 text-sm"
              >
                <span>
                  <strong>{credential.siteKey}</strong> · {PROVIDER_LABELS[credential.provider]}
                  {credential.siteId ? (
                    <span className="text-muted-foreground"> · متصل به سایت</span>
                  ) : (
                    <span className="text-muted-foreground"> · بدون اتصال به سایت</span>
                  )}{" "}
                  · سقف {credential.requestsPerMinute} درخواست در دقیقه
                  <div className="text-xs text-muted-foreground">
                    {credential.isActive
                      ? credential.lastUsedAt
                        ? `آخرین استفاده ${formatJalali(credential.lastUsedAt, { withTime: true })}`
                        : "تاکنون استفاده نشده"
                      : `لغو شده${
                          credential.revokedAt ? ` در ${formatJalali(credential.revokedAt)}` : ""
                        }`}
                  </div>
                </span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!credential.isActive || busy === credential.id}
                  onClick={() => void revoke(credential.id)}
                >
                  {credential.isActive ? "لغو" : "لغوشده"}
                </Button>
              </div>
            ))}
            {credentials.length === 0 ? (
              <p className="rounded-xl bg-muted/40 p-3 text-sm text-muted-foreground">
                هنوز اعتباری ساخته نشده است.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </CompanyWorkspace>
  );
}
