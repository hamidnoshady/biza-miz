"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import type { CmsDeploymentRow, CmsSiteDeploymentState, CmsThemePackage } from "@/lib/cms/platform-client";
import type { MirroredCmsSite } from "@/lib/cms/platform-control";
import { formatPersianNumber } from "@/lib/digits";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  StatusBadge,
  fmtDate,
  inputClass,
  selectClass,
  useCan,
} from "../../../ui";
import { cmsErrorText, SITE_STATUS_LABELS } from "../../text";

const TABS = [
  { key: "overview", label: "نمای کلی" },
  { key: "domain", label: "دامنه" },
  { key: "deployment", label: "پوسته و استقرار" },
  { key: "usage", label: "مصرف و entitlement" },
  { key: "keys", label: "کلیدها" },
  { key: "sync", label: "همگام‌سازی محتوا" },
  { key: "activity", label: "فعالیت" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const PENDING_STATUSES = new Set(["queued", "creating", "building", "verifying"]);

export default function CmsSiteDetailPage() {
  const params = useParams();
  const siteId = String(params.id ?? "");
  const can = useCan();
  const manage = can("cms.manage");
  const [tab, setTab] = useState<TabKey>("overview");
  const [site, setSite] = useState<MirroredCmsSite | null>(null);
  const [live, setLive] = useState<Record<string, unknown> | null>(null);
  const [deployment, setDeployment] = useState<CmsSiteDeploymentState | null>(null);
  const [packages, setPackages] = useState<CmsThemePackage[]>([]);
  const [billing, setBilling] = useState<Record<string, unknown> | null>(null);
  const [keys, setKeys] = useState<{ disabledAt?: null | string; id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<null | string>(null);
  const [notice, setNotice] = useState<null | string>(null);
  const [busy, setBusy] = useState(false);
  const [deployPackage, setDeployPackage] = useState("");
  const [deployMode, setDeployMode] = useState("preview");

  const loadSite = useCallback(async () => {
    const { ok, data } = await api<{
      error?: string;
      live?: Record<string, unknown>;
      site?: MirroredCmsSite;
    }>(`/api/platform/cms/sites/${encodeURIComponent(siteId)}`);
    if (!ok) setError(cmsErrorText(data.error));
    else {
      setSite(data.site ?? null);
      setLive(data.live ?? null);
    }
  }, [siteId]);

  const loadDeployment = useCallback(async () => {
    const { ok, data } = await api<{ deployment?: CmsSiteDeploymentState; error?: string }>(
      `/api/platform/cms/sites/${encodeURIComponent(siteId)}/deployment`,
    );
    if (ok && data.deployment) setDeployment(data.deployment);
  }, [siteId]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadSite();
      setLoading(false);
    })();
  }, [loadSite]);

  useEffect(() => {
    if (tab === "deployment") {
      void loadDeployment();
      void api<{ packages?: CmsThemePackage[] }>("/api/platform/cms/theme-packages").then((res) => {
        if (res.ok) setPackages(res.data.packages ?? []);
      });
    }
    if (tab === "usage") {
      void api<{ billing?: Record<string, unknown>; entitlement?: Record<string, unknown> }>(
        `/api/platform/cms/sites/${encodeURIComponent(siteId)}/billing`,
      ).then((res) => {
        if (res.ok) setBilling({ billing: res.data.billing, entitlement: res.data.entitlement });
      });
    }
    if (tab === "keys") {
      void api<{ keys?: { disabledAt?: null | string; id: string; name: string }[] }>(
        `/api/platform/cms/keys?siteId=${encodeURIComponent(siteId)}`,
      ).then((res) => {
        if (res.ok) setKeys(res.data.keys ?? []);
      });
    }
  }, [tab, siteId, loadDeployment]);

  const pendingRow = useMemo(() => {
    const rows = deployment?.deployments ?? [];
    return rows.find((row) => PENDING_STATUSES.has(row.status)) ?? null;
  }, [deployment]);

  useEffect(() => {
    if (!pendingRow || tab !== "deployment") return undefined;
    const timer = window.setInterval(() => {
      void (async () => {
        await api(
          `/api/platform/cms/sites/${encodeURIComponent(siteId)}/deployment/poll`,
          { body: JSON.stringify({ deployment: pendingRow.id }), method: "POST" },
        );
        await loadDeployment();
      })();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [pendingRow, siteId, tab, loadDeployment]);

  async function startDeploy() {
    if (!deployPackage) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/platform/cms/sites/${encodeURIComponent(siteId)}/deployment`,
      {
        body: JSON.stringify({ domainMode: deployMode, package: deployPackage }),
        method: "POST",
      },
    );
    if (!ok) setError(data.message ?? cmsErrorText(data.error));
    else {
      setNotice("استقرار در صف قرار گرفت.");
      await loadDeployment();
    }
    setBusy(false);
  }

  async function redeploy() {
    setBusy(true);
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/platform/cms/sites/${encodeURIComponent(siteId)}/deployment/redeploy`,
      { body: JSON.stringify({}), method: "POST" },
    );
    if (!ok) setError(data.message ?? cmsErrorText(data.error));
    else {
      setNotice("استقرار مجدد در صف است.");
      await loadDeployment();
    }
    setBusy(false);
  }

  if (loading) return <SkeletonRows label="در حال خواندن سایت" rows={6} />;
  if (!site) return <ErrorBox>سایت پیدا نشد.</ErrorBox>;

  return (
    <div className="space-y-4">
      <div>
        <Link className="text-sm text-teal-700 dark:text-teal-300" href="/platform/cms/sites">
          ← بازگشت به فهرست
        </Link>
        <h1 className="mt-2 text-lg font-bold">{site.name}</h1>
        <p className="text-xs text-muted-foreground" dir="ltr">{site.domain}</p>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <div className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <Button
            key={item.key}
            onClick={() => setTab(item.key)}
            variant={tab === item.key ? "primary" : "ghost"}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {tab === "overview" ? (
        <Card title="نمای کلی">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">وضعیت</dt><dd>{SITE_STATUS_LABELS[site.status] ?? site.status}</dd></div>
            <div><dt className="text-muted-foreground">تأیید دامنه</dt><dd>{site.domainVerified ? "بله" : "خیر"}</dd></div>
            <div><dt className="text-muted-foreground">صفحات</dt><dd>{formatPersianNumber(site.totals.pages ?? 0)}</dd></div>
            <div><dt className="text-muted-foreground">سفارش‌ها</dt><dd>{formatPersianNumber(site.totals.orders ?? 0)}</dd></div>
          </dl>
          {live ? (
            <pre className="mt-3 max-h-40 overflow-auto rounded-lg bg-muted p-2 text-xs" dir="ltr">
              {JSON.stringify(live, null, 2)}
            </pre>
          ) : null}
        </Card>
      ) : null}

      {tab === "domain" ? (
        <Card title="دامنه">
          <p className="text-sm">دامنهٔ اصلی: <span dir="ltr">{site.domain}</span></p>
          <p className="mt-2 text-xs text-muted-foreground">
            تغییر دامنه از کنسول سکو انجام نمی‌شود؛ کسب‌وکار از «تنظیمات و همگام‌سازی» خودش دامنه را عوض می‌کند.
          </p>
          {site.aliases.length ? (
            <ul className="mt-3 text-sm">
              {site.aliases.map((a) => (
                <li dir="ltr" key={a.hostname}>{a.hostname} {a.verified ? "✓" : "؟"}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {tab === "deployment" ? (
        <div className="space-y-3">
          <Card title="وضعیت فعلی">
            {deployment ? (
              <>
                <p className="text-sm">
                  رندر: <strong>{deployment.renderedBy}</strong>
                  {deployment.needsRedeploy ? (
                    <span className="ms-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-800 dark:text-amber-200">
                      نیاز به استقرار مجدد
                    </span>
                  ) : null}
                </p>
                {deployment.current ? (
                  <DeploymentSummary row={deployment.current} />
                ) : (
                  <InfoBox>استقرار فعالی نیست.</InfoBox>
                )}
                {deployment.update?.updateAvailable ? (
                  <InfoBox>به‌روزرسانی commit در دسترس است.</InfoBox>
                ) : null}
                {manage ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void redeploy()}>استقرار مجدد</Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void api(
                          `/api/platform/cms/sites/${encodeURIComponent(siteId)}/deployment/revert`,
                          { body: JSON.stringify({}), method: "POST" },
                        ).then(() => loadDeployment())
                      }
                      variant="ghost"
                    >
                      بازگشت به رندر داخلی
                    </Button>
                  </div>
                ) : null}
              </>
            ) : (
              <InfoBox>در حال خواندن…</InfoBox>
            )}
          </Card>
          {manage ? (
            <Card title="استقرار پوسته">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="بسته">
                  <select className={selectClass} onChange={(e) => setDeployPackage(e.target.value)} value={deployPackage}>
                    <option value="">انتخاب…</option>
                    {packages.filter((p) => p.status === "published").map((p) => (
                      <option key={p.id} value={p.key}>{p.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label="domainMode">
                  <select className={selectClass} onChange={(e) => setDeployMode(e.target.value)} value={deployMode}>
                    <option value="preview">preview</option>
                    <option value="edge">edge</option>
                    <option value="direct">direct</option>
                  </select>
                </Field>
              </div>
              <Button className="mt-3" disabled={busy} onClick={() => void startDeploy()}>شروع استقرار</Button>
            </Card>
          ) : null}
          {deployment?.deployments?.length ? (
            <Card title="تاریخچه">
              <ul className="space-y-2 text-xs">
                {deployment.deployments.map((row) => (
                  <li className="rounded-lg border border-border p-2" key={row.id}>
                    <DeploymentSummary row={row} />
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      ) : null}

      {tab === "usage" ? (
        <Card title="مصرف و entitlement">
          {billing ? (
            <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs" dir="ltr">
              {JSON.stringify(billing, null, 2)}
            </pre>
          ) : (
            <InfoBox>در حال بارگذاری…</InfoBox>
          )}
        </Card>
      ) : null}

      {tab === "keys" ? (
        <Card title="کلیدهای API">
          <ul className="space-y-2 text-sm">
            {keys.map((key) => (
              <li key={key.id}>{key.name} {key.disabledAt ? "(غیرفعال)" : ""}</li>
            ))}
          </ul>
          {manage ? (
            <Button
              className="mt-3"
              onClick={() =>
                void api("/api/platform/cms/keys", {
                  body: JSON.stringify({ name: `کنسول (${site.domain})`, siteId }),
                  method: "POST",
                }).then(() =>
                  api<{ keys?: { disabledAt?: null | string; id: string; name: string }[] }>(
                    `/api/platform/cms/keys?siteId=${encodeURIComponent(siteId)}`,
                  ).then((res) => {
                    if (res.ok) setKeys(res.data.keys ?? []);
                  }),
                )
              }
            >
              صدور کلید
            </Button>
          ) : null}
        </Card>
      ) : null}

      {tab === "sync" ? (
        <Card title="همگام‌سازی محتوا">
          <p className="text-sm text-muted-foreground">
            عملیات push/pull محتوا از صفحهٔ{" "}
            <Link className="text-teal-700 dark:text-teal-300" href="/platform/cms/sync">همگام‌سازی محتوا</Link>
            {" "}با انتخاب این سایت انجام می‌شود.
          </p>
        </Card>
      ) : null}

      {tab === "activity" ? (
        <Card title="فعالیت">
          <p className="text-sm text-muted-foreground">
            رویدادهای سایت در{" "}
            <Link className="text-teal-700 dark:text-teal-300" href="/platform/cms/logs">گزارش فعالیت</Link>
            {" "}فیلتر می‌شوند.
          </p>
        </Card>
      ) : null}
    </div>
  );
}

function DeploymentSummary({ row }: { row: CmsDeploymentRow }) {
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={row.status === "live" ? "active" : "suspended"} />
        <span className="text-xs text-muted-foreground">{row.status}</span>
        <span>{row.packageName ?? row.themePackage}</span>
        <span className="text-muted-foreground" dir="ltr">{row.ref}</span>
      </div>
      {row.lastError ? <p className="text-xs text-red-700 dark:text-red-300">{row.lastError}</p> : null}
      {row.deployedAt ? <p className="text-xs text-muted-foreground">{fmtDate(row.deployedAt)}</p> : null}
    </div>
  );
}
