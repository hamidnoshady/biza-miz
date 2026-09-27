"use client";

import { useCallback, useEffect, useState } from "react";

import type { CmsDeployTargetRow } from "@/lib/cms/platform-client";
import { formatPersianNumber } from "@/lib/digits";
import { api, Button, Card, ErrorBox, InfoBox, SkeletonRows, StatusBadge, useCan } from "../../ui";
import { cmsErrorText } from "../text";

export default function CmsInfrastructurePage() {
  const can = useCan();
  const manage = can("cms.manage");
  const [targets, setTargets] = useState<CmsDeployTargetRow[]>([]);
  const [routes, setRoutes] = useState<{ host: string; upstream: string }[]>([]);
  const [generatedAt, setGeneratedAt] = useState<null | string>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<null | string>(null);
  const [busyId, setBusyId] = useState<null | string>(null);

  const load = useCallback(async () => {
    setError(null);
    const [targetsRes, routingRes] = await Promise.all([
      api<{ error?: string; targets?: CmsDeployTargetRow[] }>("/api/platform/cms/deploy-targets"),
      api<{ error?: string; routing?: { generatedAt: string; routes: { host: string; upstream: string }[] } }>(
        "/api/platform/cms/infrastructure",
      ),
    ]);
    if (!targetsRes.ok) setError(cmsErrorText(targetsRes.data.error));
    else setTargets(targetsRes.data.targets ?? []);
    if (routingRes.ok && routingRes.data.routing) {
      setGeneratedAt(routingRes.data.routing.generatedAt);
      setRoutes(routingRes.data.routing.routes ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function selfTest(id: string) {
    setBusyId(id);
    const { ok, data } = await api<{ message?: string; ok?: boolean }>(
      "/api/platform/cms/deploy-targets/self-test",
      { body: JSON.stringify({ id }), method: "POST" },
    );
    if (!ok) setError(data.message ?? "خودآزمایی ناموفق بود.");
    await load();
    setBusyId(null);
  }

  if (loading) return <SkeletonRows label="در حال خواندن زیرساخت" rows={5} />;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-bold">زیرساخت استقرار</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          سرورهای Coolify و نقشهٔ مسیریابی لبه — توکن‌ها هرگز در این کنسول نمایش داده نمی‌شوند.
        </p>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <Card title="سرورهای استقرار">
        {targets.length === 0 ? (
          <InfoBox>سرور استقراری ثبت نشده است؛ از پنل سایت‌ساز یا API مجموعهٔ deploy-targets اضافه کنید.</InfoBox>
        ) : (
          <ul className="space-y-3 text-sm">
            {targets.map((target) => (
              <li className="rounded-xl border border-border bg-card p-3" key={target.id}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{target.name}</span>
                  <StatusBadge status={target.active ? "active" : "suspended"} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground" dir="ltr">{target.baseUrl}</p>
                <p className="text-xs text-muted-foreground">
                  خودآزمایی:{" "}
                  {target.lastSelfTestOk === true ? "موفق" : target.lastSelfTestOk === false ? "ناموفق" : "انجام نشده"}
                </p>
                {target.lastSelfTestDetail ? (
                  <p className="text-xs text-muted-foreground">{target.lastSelfTestDetail}</p>
                ) : null}
                {manage ? (
                  <Button
                    className="mt-2"
                    disabled={busyId === target.id}
                    onClick={() => void selfTest(target.id)}
                    variant="ghost"
                  >
                    خودآزمایی Coolify
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="نقشهٔ مسیریابی لبه">
        <p className="text-xs text-muted-foreground">
          {generatedAt ? `تولید: ${generatedAt}` : "—"} · {formatPersianNumber(routes.length)} میزبان
        </p>
        {routes.length === 0 ? (
          <InfoBox>هیچ مسیر edge فعالی ثبت نشده است.</InfoBox>
        ) : (
          <div className="mt-3 max-h-80 overflow-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/60 text-muted-foreground">
                  <th className="px-2 py-1 text-start">میزبان</th>
                  <th className="px-2 py-1 text-start">upstream</th>
                </tr>
              </thead>
              <tbody>
                {routes.map((row) => (
                  <tr className="border-b border-border/60" key={row.host}>
                    <td className="px-2 py-1" dir="ltr">{row.host}</td>
                    <td className="px-2 py-1" dir="ltr">{row.upstream}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
