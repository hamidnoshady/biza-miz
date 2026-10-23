"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { ACCOUNTING_WORKSPACE_HREFS } from "@/lib/app-routes";
import {
  api,
  errorMessage,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { useRealtime } from "../use-realtime";

interface SessionDetail {
  session: {
    id: string;
    status: string;
    party_size: number | null;
    guest_name: string | null;
    opened_at: string;
    bill_requested_at: string | null;
    note: string | null;
  };
  tables: { id: string; name: string; capacity: number }[];
  orders: {
    id: string;
    order_number: number;
    status: string;
    subtotal: number | string;
    total: number | string;
    opened_at: string;
    customer_name?: string | null;
  }[];
  guests: {
    guestNumber: number;
    customerId: string;
    customerName: string;
    customerPhone: string | null;
  }[];
}

/** Orders a guest could still add to or pay — the ones that hold the table. */
const ACTIVE_ORDER_STATUSES = new Set(["open", "held"]);

/**
 * The seating side of a table: who is sitting there, what they have ordered,
 * and the two things the floor actually does — merge another table in, or let
 * an empty table go.
 *
 * Deliberately not a checkout. This panel used to carry «درخواست صورتحساب»,
 * «تقسیم صورتحساب» (with its own guest/customer editor, its own split modes and
 * its own three payment-method buttons) and «بستن میز», which made the floor
 * screen a second, parallel till: a bill could be taken here with a payment UI
 * that knew nothing about payment ways, tips, نسیه, store credit or the
 * 4-second hold, and the table then had to be closed by hand afterwards. Money
 * belongs to an order, so every amount below links to that order's detail —
 * the one canonical checkout — and settling the last of them frees the table
 * on its own.
 */
export function SessionPanel({
  sessionId,
  onChange,
  setError,
}: {
  sessionId: string;
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const money = useMoney();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);
  const [freeTables, setFreeTables] = useState<{ id: string; name: string }[]>(
    [],
  );
  const [mergeTableId, setMergeTableId] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<SessionDetail>(`/api/table-sessions/${sessionId}`);
      if (res.ok) setDetail(res.data);
      else setError("بارگذاری نشست میز ممکن نشد.");
      const tRes = await api<{
        tables: { id: string; name: string; status: string }[];
      }>("/api/tables");
      if (tRes.ok)
        setFreeTables(tRes.data.tables.filter((t) => t.status === "free"));
    } catch {
      setError("بارگذاری نشست میز ممکن نشد.");
    } finally {
      setDetailLoaded(true);
    }
  }, [sessionId, setError]);

  useEffect(() => {
    setDetail(null);
    setDetailLoaded(false);
    void load();
  }, [load]);

  useRealtime((event) => {
    if (
      event.type === "floor.updated" ||
      event.type === "table.status" ||
      event.type === "table_session.updated" ||
      event.type === "order.created" ||
      event.type === "order.updated" ||
      event.type === "order.item_status"
    ) {
      void load();
    }
  });

  async function action(body: object) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(
      `/api/table-sessions/${sessionId}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return false;
    }
    await load();
    onChange();
    return true;
  }

  if (!detail) {
    return detailLoaded ? null : (
      <LoadingSkeleton
        rows={3}
        compact
        className="mt-4"
        label="در حال بارگذاری نشست"
      />
    );
  }

  const { session, tables, orders } = detail;
  const activeOrders = orders.filter((o) => ACTIVE_ORDER_STATUSES.has(o.status));
  const mergedIds = new Set(tables.map((t) => t.id));
  const mergeCandidates = freeTables.filter((t) => !mergedIds.has(t.id));

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="font-bold">نشست میز</h3>
        <span className="text-xs text-muted-foreground">
          {session.party_size
            ? `${toPersianDigits(session.party_size)} نفر`
            : "—"}
          {session.guest_name ? ` · ${session.guest_name}` : ""}
        </span>
      </div>
      {tables.length > 1 ? (
        <p className="mb-2 text-xs text-muted-foreground">
          میزها: {tables.map((t) => t.name).join("، ")}
        </p>
      ) : null}

      <div className="mb-3 rounded-lg bg-muted/50 p-3 text-sm">
        {orders.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            هنوز سفارشی ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-1">
            {orders.map((o) => (
              <li key={o.id}>
                {/*
                  Each round or customer order is settled independently on its
                  own order page rather than being folded into a shared table bill.
                */}
                <Link
                  href={`${ACCOUNTING_WORKSPACE_HREFS.orders}?order=${o.id}`}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-1 transition hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                >
                  <span className="text-muted-foreground">
                    سفارش #{toPersianDigits(o.order_number)}
                    {o.customer_name ? ` · ${o.customer_name}` : ""}
                    {o.status === "voided" ? " (باطل)" : ""}
                    {o.status === "completed" ? " (تسویه‌شده)" : ""}
                    {o.status === "held" ? " (نگه‌داشته‌شده)" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    مبلغ سفارش (اطلاعاتی): {money.format(Number(o.total))}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-between border-t border-border pt-2 text-xs font-semibold text-muted-foreground">
          <span>سفارش‌های فعال / کل سفارش‌ها (فقط اطلاعاتی)</span>
          <span>
            {toPersianDigits(activeOrders.length)} فعال از {toPersianDigits(orders.length)}
          </span>
        </div>
        {activeOrders.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            هر سفارش صورتحساب و تسویهٔ مستقل خود را در صفحهٔ سفارش‌ها دارد؛ بخش میزها فاقد جمع قابل پرداخت میز است.
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {activeOrders.length > 0 ? (
          <Button asChild size="lg" className="w-full px-5 font-semibold">
            <Link
              href={`${ACCOUNTING_WORKSPACE_HREFS.orders}?order=${activeOrders[0].id}`}
            >
              رفتن به سفارش #{toPersianDigits(activeOrders[0].order_number)}
            </Link>
          </Button>
        ) : (
          <div className="flex w-full flex-col gap-2">
            <PrimaryButton
              type="button"
              onClick={async () => {
                if (
                  await action({
                    action: "release",
                    nextTableStatus: "free",
                  })
                )
                  toast.success("نشست بسته و میز آزاد شد");
              }}
              disabled={busy}
            >
              پایان نشست و آزادکردن میز
            </PrimaryButton>
            <SecondaryButton
              onClick={async () => {
                if (
                  await action({
                    action: "release",
                    nextTableStatus: "cleaning",
                  })
                )
                  toast.success("نشست بسته شد و میز به حالت نظافت رفت");
              }}
              disabled={busy}
            >
              پایان نشست و انتقال به نظافت
            </SecondaryButton>
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <SearchableSelect
          className={`${inputClass} py-1 text-xs`}
          value={mergeTableId}
          onChange={setMergeTableId}
          options={[
            { value: "", label: "ادغام با میز آزاد…" },
            ...mergeCandidates.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
        <SecondaryButton
          onClick={() =>
            mergeTableId &&
            void action({ action: "merge", tableId: mergeTableId })
          }
          disabled={busy || !mergeTableId}
        >
          ادغام
        </SecondaryButton>
      </div>
    </div>
  );
}
