"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { formatPersianNumber } from "@/lib/digits";
import { api, Button, Card, ErrorBox, InfoBox, SkeletonRows, fmtDate } from "../../ui";
import { cmsErrorText } from "../text";

interface BillingSyncResponse {
  centralBillingHref?: string;
  cmsHealth?: Record<string, unknown> | null;
  cmsHealthError?: null | string;
  config?: { billingEntitlementKeyId: string; billingEntitlementSecretHint: string };
  localOutbox?: {
    dead: number;
    failed: number;
    lastSentAt: null | string;
    pending: number;
    sent: number;
  };
}

export default function CmsBillingSyncPage() {
  const [data, setData] = useState<BillingSyncResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<null | string>(null);

  const load = useCallback(async () => {
    const { ok, data: payload } = await api<BillingSyncResponse & { error?: string }>(
      "/api/platform/cms/billing-sync",
    );
    if (!ok) setError(cmsErrorText(payload.error));
    else setData(payload);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <SkeletonRows label="در حال خواندن وضعیت صورتحساب" rows={4} />;

  const outbox = data?.localOutbox;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold">همگام‌سازی صورتحساب</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            وضعیت فقط خواندنی — مدیریت طرح و فاکتور در صورتحساب مرکزی سکو انجام می‌شود.
          </p>
        </div>
        <Link href={data?.centralBillingHref ?? "/platform/billing"}>
          <Button variant="ghost">صورتحساب مرکزی</Button>
        </Link>
      </div>
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <Card title="اعتبارنامهٔ entitlement (این کنسول)">
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">شناسهٔ کلید</dt>
            <dd dir="ltr">{data?.config?.billingEntitlementKeyId || "—"}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">راز امضا</dt>
            <dd>{data?.config?.billingEntitlementSecretHint || "تنظیم نشده"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">
          ویرایش در «اتصال». آخرین ارسال موفق:{" "}
          {outbox?.lastSentAt ? fmtDate(outbox.lastSentAt) : "هرگز"}
        </p>
      </Card>

      <Card title="صف entitlement محلی">
        {outbox ? (
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            <li>در انتظار: {formatPersianNumber(outbox.pending)}</li>
            <li>ناموفق: {formatPersianNumber(outbox.failed)}</li>
            <li>ارسال‌شده: {formatPersianNumber(outbox.sent)}</li>
            <li>بایگانی خطا: {formatPersianNumber(outbox.dead)}</li>
          </ul>
        ) : (
          <InfoBox>داده‌ای نیست.</InfoBox>
        )}
      </Card>

      <Card title="سلامت یکپارچگی روی سایت‌ساز">
        {data?.cmsHealthError ? (
          <ErrorBox>{cmsErrorText(data.cmsHealthError)}</ErrorBox>
        ) : data?.cmsHealth ? (
          <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs" dir="ltr">
            {JSON.stringify(data.cmsHealth, null, 2)}
          </pre>
        ) : (
          <InfoBox>گزارش سلامت از سایت‌ساز در دسترس نیست.</InfoBox>
        )}
      </Card>
    </div>
  );
}
