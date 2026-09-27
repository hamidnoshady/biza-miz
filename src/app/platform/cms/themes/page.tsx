"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

import type { CmsThemePackage } from "@/lib/cms/platform-client";
import { formatPersianNumber } from "@/lib/digits";
import { api, Button, Card, ErrorBox, Field, InfoBox, SkeletonRows, StatusBadge, inputClass, useCan } from "../../ui";
import { cmsErrorText } from "../text";

export default function CmsThemesPage() {
  const can = useCan();
  const manage = can("cms.manage");
  const [packages, setPackages] = useState<CmsThemePackage[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<null | string>(null);
  const [error, setError] = useState<null | string>(null);
  const [notice, setNotice] = useState<null | string>(null);
  const [manifestId, setManifestId] = useState<null | string>(null);
  const [syncRef, setSyncRef] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{ error?: string; packages?: CmsThemePackage[] }>(
      "/api/platform/cms/theme-packages",
    );
    if (!ok) setError(cmsErrorText(data.error));
    else setPackages(data.packages ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function syncPackage(id: string) {
    setBusyId(id);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{ error?: string; commit?: string; manifest?: unknown }>(
      `/api/platform/cms/theme-packages/${encodeURIComponent(id)}/sync`,
      { body: JSON.stringify(syncRef.trim() ? { ref: syncRef.trim() } : {}), method: "POST" },
    );
    if (!ok) setError(cmsErrorText(data.error));
    else {
      setNotice("مانیفست از مخزن خوانده شد.");
      if (data.manifest) setManifestId(id);
      await load();
    }
    setBusyId(null);
  }

  async function publishPackage(id: string, status: "draft" | "deprecated" | "published") {
    setBusyId(id);
    const { ok, data } = await api<{ error?: string; message?: string }>(
      `/api/platform/cms/theme-packages/${encodeURIComponent(id)}/publish`,
      { body: JSON.stringify({ status }), method: "POST" },
    );
    if (!ok) setError(data.message ?? cmsErrorText(data.error));
    else {
      setNotice("وضعیت انتشار به‌روز شد.");
      await load();
    }
    setBusyId(null);
  }

  if (loading) return <SkeletonRows label="در حال خواندن کاتالوگ پوسته‌ها" rows={5} />;

  const manifestPkg = manifestId ? packages.find((p) => p.id === manifestId) : null;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">پوسته‌های مستقرپذیر</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          همگام‌سازی مانیفست از GitHub و انتشار برای استقرار — بدون نمایش هیچ راز یا مقدار محیطی مشتری.
        </p>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {manage ? (
        <Card title="شاخهٔ پیش‌فرض همگام‌سازی (اختیاری)">
          <Field hint="خالی = شاخهٔ ثبت‌شده روی بسته" label="ref">
            <input className={inputClass} dir="ltr" onChange={(e) => setSyncRef(e.target.value)} value={syncRef} />
          </Field>
        </Card>
      ) : null}

      {packages.length === 0 ? (
        <InfoBox>هنوز بستهٔ پوسته‌ای روی سایت‌ساز ثبت نشده است.</InfoBox>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {packages.map((pkg) => (
            <Card key={pkg.id} title={pkg.name}>
              <div className="space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={pkg.status === "published" ? "active" : "suspended"} />
                  <span className="text-xs text-muted-foreground">{pkg.status}</span>
                  <span className="text-muted-foreground" dir="ltr">{pkg.key}</span>
                </div>
                <p className="text-xs text-muted-foreground" dir="ltr">{pkg.repository ?? "—"}</p>
                {pkg.syncError ? <p className="text-xs text-red-700 dark:text-red-300">{pkg.syncError}</p> : null}
                <dl className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                  <dt>قرارداد</dt>
                  <dd dir="ltr">{pkg.contractVersion ?? "—"}</dd>
                  <dt>آخرین sync</dt>
                  <dd dir="ltr">{pkg.syncedCommitSha?.slice(0, 8) ?? "—"}</dd>
                  <dt>فیلد env</dt>
                  <dd>{formatPersianNumber(pkg.envSchema?.length ?? 0)}</dd>
                </dl>
                {manage ? (
                  <div className="flex flex-wrap gap-2 pt-2">
                    <Button disabled={busyId === pkg.id} onClick={() => void syncPackage(pkg.id)} variant="ghost">
                      <RefreshCw className="size-4" />
                      همگام‌سازی
                    </Button>
                    <Button disabled={busyId === pkg.id} onClick={() => void publishPackage(pkg.id, "published")}>
                      انتشار
                    </Button>
                    <Button
                      disabled={busyId === pkg.id}
                      onClick={() => setManifestId(manifestId === pkg.id ? null : pkg.id)}
                      variant="ghost"
                    >
                      مانیفست
                    </Button>
                  </div>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {manifestPkg ? (
        <Card title={`مانیفست — ${manifestPkg.name}`}>
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs" dir="ltr">
            {JSON.stringify(manifestPkg, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            فقط شکل فیلدها (`envSchema`) در فهرست بالا است؛ مقادیر هر سایت در جزئیات سایت نگه‌داری می‌شود.
          </p>
        </Card>
      ) : null}
    </div>
  );
}
