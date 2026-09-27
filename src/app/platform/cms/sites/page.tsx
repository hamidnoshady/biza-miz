"use client";

/**
 * «سایت‌ساز ← سایت‌ها» — every site on the website platform, and its lifecycle.
 *
 * The table reads the mirror, so it pages and filters without a network call per
 * row; the panel that opens for one site asks the CMS for its live figures and
 * falls back to the mirrored ones. Suspending, renaming, changing locales and
 * ticking domain verification all happen here, each one an audited call.
 *
 * The domain itself is deliberately not editable here. On the CMS its one write
 * path is `PATCH /api/site/domain`, which resets `domainVerified` and re-checks
 * uniqueness across every site's primary *and* alias hostnames; a second door onto
 * that column would be a second place for the invariant to be forgotten. Moving a
 * connected site's domain stays the business's own «تنظیمات و همگام‌سازی» flow.
 */
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, Globe, Plus, RefreshCw, X } from "lucide-react";

import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import type { MirroredCmsSite } from "@/lib/cms/platform-control";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  fmtDate,
  InfoBox,
  inputClass,
  selectClass,
  SkeletonRows,
  StatusBadge,
  useCan,
} from "../../ui";
import { cmsErrorText, SITE_STATUS_LABELS, SITE_TYPE_LABELS } from "../text";

interface SitesResponse {
  error?: string;
  sites?: MirroredCmsSite[];
}

export default function CmsSitesPage() {
  const can = useCan();
  const manage = can("cms.manage");
  const [sites, setSites] = useState<MirroredCmsSite[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [notice, setNotice] = useState<null | string>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [openId, setOpenId] = useState<null | string>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<SitesResponse>("/api/platform/cms/sites");
    if (!ok) setError(cmsErrorText(data.error));
    setSites(data.sites ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sites.filter((site) => {
      if (status !== "all" && site.status !== status) return false;
      if (!needle) return true;
      return (
        site.domain.toLowerCase().includes(needle) ||
        site.name.toLowerCase().includes(needle) ||
        (site.businessName ?? "").toLowerCase().includes(needle)
      );
    });
  }, [q, sites, status]);

  async function refreshMirror() {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string; sites?: MirroredCmsSite[] }>(
      "/api/platform/cms/sync",
      { body: JSON.stringify({ kind: "mirror" }), method: "POST" },
    );
    if (!ok) setError(cmsErrorText(data.error));
    else if (data.sites) setSites(data.sites);
    setBusy(false);
  }

  if (loading) return <SkeletonRows label="در حال خواندن فهرست سایت‌ها" rows={6} />;

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[12rem] flex-1">
          <Field label="جست‌وجو">
            <input
              className={inputClass}
              onChange={(event) => setQ(event.target.value)}
              placeholder="دامنه، نام سایت یا کسب‌وکار"
              value={q}
            />
          </Field>
        </div>
        <div className="w-40">
          <Field label="وضعیت">
            <select
              className={selectClass}
              onChange={(event) => setStatus(event.target.value)}
              value={status}
            >
              <option value="all">همه</option>
              <option value="active">فعال</option>
              <option value="suspended">معلق</option>
              <option value="archived">بایگانی‌شده</option>
            </select>
          </Field>
        </div>
        <Button disabled={busy} onClick={refreshMirror} variant="ghost">
          <RefreshCw className="size-4" />
          {busy ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
        </Button>
        {manage ? (
          <Button onClick={() => setCreating((value) => !value)} variant="ghost">
            <Plus className="size-4" />
            سایت جدید
          </Button>
        ) : null}
      </div>

      {creating && manage ? (
        <NewSiteForm
          onClose={() => setCreating(false)}
          onCreated={(message, next) => {
            setNotice(message);
            if (next) setSites(next);
            setCreating(false);
          }}
        />
      ) : null}

      {filtered.length === 0 ? (
        <EmptyState
          hint={
            sites.length === 0
              ? "آینهٔ سایت‌ها خالی است. «به‌روزرسانی» را بزنید تا فهرست از سایت‌ساز خوانده شود."
              : "هیچ سایتی با این فیلتر پیدا نشد."
          }
          title="سایتی برای نمایش نیست"
        />
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2 text-start font-normal">دامنه</th>
                  <th className="pb-2 text-start font-normal">کسب‌وکار</th>
                  <th className="pb-2 text-start font-normal">نوع</th>
                  <th className="pb-2 text-start font-normal">وضعیت</th>
                  <th className="pb-2 text-start font-normal">محتوا</th>
                  <th className="pb-2 text-start font-normal">سفارش‌ها</th>
                  <th className="pb-2 text-start font-normal" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((site) => (
                  <Fragment key={site.id}>
                    <tr className="border-t border-border">
                      <td className="py-2">
                        <div className="flex items-center gap-2">
                          <Globe className="size-3.5 text-muted-foreground" />
                          <span dir="ltr">{site.domain}</span>
                          {site.domainVerified ? null : (
                            <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                              تأییدنشده
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{site.name}</p>
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {site.businessName ?? (
                          <span className="text-muted-foreground">بدون کسب‌وکار</span>
                        )}
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {SITE_TYPE_LABELS[site.type] ?? site.type}
                      </td>
                      <td className="py-2">
                        <StatusBadge status={site.status} />
                      </td>
                      <td className="py-2 tabular-nums text-muted-foreground">
                        {formatPersianNumber(site.totals.pages ?? 0)} /{" "}
                        {formatPersianNumber(site.totals.posts ?? 0)} /{" "}
                        {formatPersianNumber(site.totals.products ?? 0)}
                      </td>
                      <td className="py-2 tabular-nums text-muted-foreground">
                        {formatPersianNumber(site.totals.ordersPaid ?? 0)}
                        <span className="text-muted-foreground">
                          {" / "}
                          {formatPersianNumber(site.totals.orders ?? 0)}
                        </span>
                      </td>
                      <td className="py-2 text-end">
                        <div className="flex flex-wrap justify-end gap-1">
                          <Link href={`/platform/cms/sites/${encodeURIComponent(site.id)}`}>
                            <Button variant="ghost">جزئیات</Button>
                          </Link>
                          <Button
                            onClick={() => setOpenId(openId === site.id ? null : site.id)}
                            variant="ghost"
                          >
                            {openId === site.id ? "بستن" : "سریع"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {openId === site.id ? (
                      <tr>
                        <td className="pb-4" colSpan={7}>
                          <SitePanel
                            manage={manage}
                            onSaved={(message, next) => {
                              setNotice(message);
                              if (next) setSites(next);
                            }}
                            site={site}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            ستون «محتوا» صفحه‌ها / نوشته‌ها / محصولات است. اعداد از آخرین آینه‌برداری‌اند.
          </p>
        </Card>
      )}
    </div>
  );
}

/** The lifecycle panel for one site. */
function SitePanel({
  manage,
  onSaved,
  site,
}: {
  manage: boolean;
  onSaved: (message: string, sites?: MirroredCmsSite[]) => void;
  site: MirroredCmsSite;
}) {
  const [name, setName] = useState(site.name);
  const [status, setStatus] = useState(site.status);
  const [type, setType] = useState(site.type);
  const [verified, setVerified] = useState(site.domainVerified);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [keys, setKeys] = useState<{ disabledAt?: null | string; id: string; name: string }[] | null>(
    null,
  );
  const [issued, setIssued] = useState<null | string>(null);

  async function save() {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{
      error?: string;
      message?: string;
      sites?: MirroredCmsSite[];
    }>(`/api/platform/cms/sites/${encodeURIComponent(site.id)}`, {
      body: JSON.stringify({ domainVerified: verified, name, status, type }),
      method: "PATCH",
    });
    if (!ok) setError(data.message ?? cmsErrorText(data.error));
    else onSaved(`تغییرات ${site.domain} ذخیره شد.`, data.sites);
    setBusy(false);
  }

  async function loadKeys() {
    const { ok, data } = await api<{
      error?: string;
      keys?: { disabledAt?: null | string; id: string; name: string }[];
    }>(`/api/platform/cms/keys?siteId=${encodeURIComponent(site.id)}`);
    if (!ok) setError(cmsErrorText(data.error));
    else setKeys(data.keys ?? []);
  }

  async function issueKey() {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{ error?: string; key?: { key?: string } }>(
      "/api/platform/cms/keys",
      {
        body: JSON.stringify({ name: `کنسول سکو (${site.domain})`, siteId: site.id }),
        method: "POST",
      },
    );
    if (!ok) setError(cmsErrorText(data.error));
    else {
      setIssued(data.key?.key ?? null);
      await loadKeys();
    }
    setBusy(false);
  }

  async function revokeKey(id: string) {
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/cms/keys?id=${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!ok) setError(cmsErrorText(data.error));
    await loadKeys();
    setBusy(false);
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-muted p-3">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="نام سایت">
          <input
            className={inputClass}
            disabled={!manage}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field label="وضعیت">
          <select
            className={selectClass}
            disabled={!manage}
            onChange={(event) => setStatus(event.target.value)}
            value={status}
          >
            {Object.entries(SITE_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="نوع">
          <select
            className={selectClass}
            disabled={!manage}
            onChange={(event) => setType(event.target.value)}
            value={type}
          >
            {Object.entries(SITE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تأیید دامنه">
          <label className="flex h-10 items-center gap-2 text-sm text-foreground">
            <input
              checked={verified}
              className="size-4"
              disabled={!manage}
              onChange={(event) => setVerified(event.target.checked)}
              type="checkbox"
            />
            {site.domain}
          </label>
        </Field>
      </div>

      <p className="text-xs leading-6 text-muted-foreground">
        دامنهٔ اصلی از این‌جا تغییر نمی‌کند: تنها مسیر نوشتن روی آن در سایت‌ساز، درخواستی است که
        تأیید دامنه را صفر می‌کند و یکتایی نام را در همهٔ سایت‌ها بازبینی می‌کند — همان مسیری که
        کسب‌وکار از «تنظیمات و همگام‌سازی» خودش استفاده می‌کند.
      </p>

      {site.aliases.length ? (
        <div className="text-xs text-muted-foreground">
          دامنه‌های فرعی:{" "}
          {site.aliases.map((alias) => (
            <span className="me-2" dir="ltr" key={alias.hostname}>
              {alias.hostname}
              {alias.verified ? (
                <Check className="ms-1 inline size-3 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <X className="ms-1 inline size-3 text-amber-600 dark:text-amber-400" />
              )}
            </span>
          ))}
        </div>
      ) : null}

      {site.gateways.length ? (
        <div className="text-xs text-muted-foreground">
          درگاه‌ها:{" "}
          {site.gateways.map((gateway) => (
            <span className="me-2" key={gateway.gateway}>
              {gateway.gateway}
              <span
                className={
                  gateway.selfTest === "failed"
                    ? "ms-1 text-red-700 dark:text-red-300"
                    : gateway.selfTest === "ok"
                      ? "ms-1 text-emerald-700 dark:text-emerald-300"
                      : "ms-1 text-muted-foreground"
                }
              >
                {gateway.selfTest === "failed"
                  ? "ناموفق"
                  : gateway.selfTest === "ok"
                    ? "سالم"
                    : "آزمایش‌نشده"}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {manage ? (
          <Button disabled={busy} onClick={save}>
            {busy ? "در حال ذخیره…" : "ذخیرهٔ تغییرات"}
          </Button>
        ) : null}
        <Button onClick={loadKeys} variant="ghost">
          کلیدهای این سایت
        </Button>
        {manage ? (
          <Button disabled={busy} onClick={issueKey} variant="ghost">
            صدور کلید تازه
          </Button>
        ) : null}
        <span className="text-xs text-muted-foreground">
          آینه‌برداری: {fmtDate(site.mirroredAt)}
        </span>
      </div>

      {issued ? (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="text-xs text-emerald-800 dark:text-emerald-200">
            این کلید فقط همین یک‌بار نمایش داده می‌شود؛ سایت‌ساز تنها هَش آن را نگه می‌دارد.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" dir="ltr">
              {issued}
            </code>
            <Button
              onClick={() => void navigator.clipboard?.writeText(issued)}
              variant="ghost"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {keys ? (
        keys.length === 0 ? (
          <p className="text-xs text-muted-foreground">این سایت هیچ کلیدی ندارد.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {keys.map((key) => (
              <li className="flex items-center justify-between gap-2" key={key.id}>
                <span className="text-muted-foreground">
                  {key.name}
                  {key.disabledAt ? (
                    <span className="ms-2 text-red-700 dark:text-red-300">لغوشده {fmtDate(key.disabledAt)}</span>
                  ) : null}
                </span>
                {manage && !key.disabledAt ? (
                  <Button disabled={busy} onClick={() => revokeKey(key.id)} variant="ghost">
                    لغو
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

/**
 * Provisioning a site from the console.
 *
 * Deliberately does not connect the new site to a business: that connection carries
 * billing, and creating a subscription for a business nobody named would bill
 * somebody for a site they did not order. The site shows up as «بدون کسب‌وکار» until
 * the business connects it from its own wizard.
 */
function NewSiteForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (message: string, sites?: MirroredCmsSite[]) => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [type, setType] = useState("business");
  const [issueKey, setIssueKey] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<null | string>(null);
  const [key, setKey] = useState<null | string>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    const { ok, data } = await api<{
      error?: string;
      key?: null | string;
      keyError?: null | string;
      sites?: MirroredCmsSite[];
    }>("/api/platform/cms/sites", {
      body: JSON.stringify({ domain, issueKey, name, type }),
      method: "POST",
    });
    if (!ok) {
      setError(cmsErrorText(data.error));
      setBusy(false);
      return;
    }
    if (data.key) {
      // Held on screen rather than closing the form: this is the only time the
      // CMS will show it.
      setKey(data.key);
      setBusy(false);
      return;
    }
    onCreated(
      data.keyError
        ? `سایت ساخته شد، اما صدور کلید ناموفق بود (${cmsErrorText(data.keyError)}).`
        : "سایت ساخته شد.",
      data.sites,
    );
    setBusy(false);
  }

  if (key) {
    return (
      <Card title="سایت ساخته شد">
        <p className="text-xs text-emerald-800 dark:text-emerald-200">
          کلید سایت فقط همین یک‌بار نمایش داده می‌شود. پیش از بستن این کادر آن را ذخیره کنید.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs" dir="ltr">
            {key}
          </code>
          <Button onClick={() => void navigator.clipboard?.writeText(key)} variant="ghost">
            <Copy className="size-4" />
          </Button>
        </div>
        <div className="mt-3">
          <Button onClick={onClose}>ذخیره کردم، ببند</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="ساخت سایت تازه در سایت‌ساز">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="نام سایت">
          <input className={inputClass} onChange={(e) => setName(e.target.value)} value={name} />
        </Field>
        <Field label="دامنه">
          <input
            className={inputClass}
            dir="ltr"
            onChange={(e) => setDomain(e.target.value)}
            placeholder="acme.ir"
            value={domain}
          />
        </Field>
        <Field label="نوع">
          <select className={selectClass} onChange={(e) => setType(e.target.value)} value={type}>
            {Object.entries(SITE_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="کلید سایت">
          <label className="flex h-10 items-center gap-2 text-sm text-foreground">
            <input
              checked={issueKey}
              className="size-4"
              onChange={(e) => setIssueKey(e.target.checked)}
              type="checkbox"
            />
            صدور کلید همراه ساخت
          </label>
        </Field>
      </div>
      <p className="mt-2 text-xs leading-6 text-muted-foreground">
        این سایت به هیچ کسب‌وکاری وصل نمی‌شود و صورت‌حسابی برایش ساخته نمی‌شود؛ اتصال و اشتراک،
        کارِ خودِ کسب‌وکار از «مدیریت وب‌سایت» است. تعداد {toPersianDigits(1)} سایت اضافه می‌شود.
      </p>
      <div className="mt-3 flex gap-2">
        <Button disabled={busy || !name || !domain} onClick={submit}>
          {busy ? "در حال ساخت…" : "ساخت سایت"}
        </Button>
        <Button onClick={onClose} variant="ghost">
          انصراف
        </Button>
      </div>
    </Card>
  );
}
