"use client";

import { useCallback, useEffect, useState } from "react";
import { api, errorMessage as sharedErrorMessage } from "../ui";
import { IndustryManagerShell, type Runner } from "../industry-manager-shell";
import { SectionCardSkeleton } from "../page-chrome";
import { UnitsSection } from "./units-section";
import { RepairsSection } from "./repairs-section";
import { ReportsSection } from "./reports-section";
import { RemindersSection } from "./reminders-section";

export type SerialStatus = "in_stock" | "reserved" | "sold" | "in_repair";
export type RepairStatus = "received" | "in_progress" | "ready" | "closed" | "cancelled";

export const SERIAL_STATUS_LABELS: Record<SerialStatus, string> = {
  in_stock: "موجود",
  reserved: "رزرو شده",
  sold: "فروخته‌شده",
  in_repair: "در تعمیر",
};

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  received: "پذیرش شده",
  in_progress: "در حال تعمیر",
  ready: "آماده تحویل",
  closed: "تحویل شده",
  cancelled: "لغو شده",
};

export interface WatchModel {
  id: string;
  name: string;
  sku: string | null;
}

export interface SerialUnit {
  id: string;
  itemId: string;
  itemName: string;
  serialNumber: string;
  status: SerialStatus;
  unitCost: number | null;
  warrantyMonths: number;
  soldAt: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
}

export interface RepairTicket {
  id: string;
  ticketNumber: number;
  serialId: string | null;
  itemDescription: string;
  reportedIssue: string | null;
  status: RepairStatus;
  underWarranty: boolean;
  /** The explicit out-of-coverage reason that permits billing an under-warranty job (issue #795). */
  nonCoveredReason: string | null;
  laborCharge: number;
  vatPercent: number;
  /** Phase 27 Wave 10 — the estimate the customer must approve before work starts. */
  estimatedTotalRial: number;
  estimatedLaborRial: number;
  estimatedPartsRial: number;
  estimateApprovedAt: string | null;
  closedAt: string | null;
  createdAt: string;
}

export interface RepairPart {
  id: string;
  description: string;
  quantity: string;
  unitCost: number;
  charge: number;
  /** 'stock' relieves the shop's own inventory at close; 'external' never does. */
  source: "stock" | "external";
}

export type ServiceReminderState = "overdue" | "due";

export interface ServiceReminder {
  serialId: string;
  serialNumber: string;
  itemName: string;
  customerName: string | null;
  referenceDate: string;
  state: ServiceReminderState;
}

export const SERVICE_REMINDER_STATE_LABELS: Record<ServiceReminderState, string> = {
  overdue: "گذشته از موعد",
  due: "نزدیک موعد",
};

const TABS = [
  { key: "units", label: "دستگاه‌ها" },
  { key: "repairs", label: "تعمیرات" },
  { key: "reminders", label: "یادآوری سرویس" },
  { key: "reports", label: "گزارش‌ها" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export type { Runner } from "../industry-manager-shell";

function watchErrorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    industry_mismatch: "این بخش فقط برای کسب‌وکارهای ساعت در دسترس است.",
    invalid_payment_method: "روش پرداخت نامعتبر است.",
    invalid_status: "وضعیت تیکت نامعتبر است.",
    serial_not_found: "دستگاه پیدا نشد.",
    ticket_not_found: "تیکت تعمیر پیدا نشد.",
  };
  return map[code ?? ""] ?? sharedErrorMessage(code);
}

export function WatchManager() {
  const [models, setModels] = useState<WatchModel[] | null>(null);
  const [units, setUnits] = useState<SerialUnit[] | null>(null);
  const [tickets, setTickets] = useState<RepairTicket[] | null>(null);
  const [reminders, setReminders] = useState<ServiceReminder[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("units");

  useEffect(() => setError(""), [tab]);

  const loadModels = useCallback(() => {
    api<{ items: WatchModel[] }>("/api/watch/items").then(({ ok, data }) => {
      if (ok) setModels(data.items);
    });
  }, []);
  useEffect(loadModels, [loadModels]);

  const loadUnits = useCallback(() => {
    api<{ units: SerialUnit[] }>("/api/watch/units").then(({ ok, data }) => {
      if (ok) setUnits(data.units);
    });
  }, []);
  useEffect(loadUnits, [loadUnits]);

  const loadTickets = useCallback(() => {
    api<{ tickets: RepairTicket[] }>("/api/watch/repairs").then(({ ok, data }) => {
      if (ok) setTickets(data.tickets);
    });
  }, []);
  useEffect(loadTickets, [loadTickets]);

  const loadReminders = useCallback(() => {
    api<{ reminders: ServiceReminder[] }>("/api/watch/reminders").then(({ ok, data }) => {
      if (ok) setReminders(data.reminders);
    });
  }, []);
  useEffect(loadReminders, [loadReminders]);

  const run: Runner = async (fn) => {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(data.message || watchErrorMessage(data.error));
      return false;
    }
    loadModels();
    loadUnits();
    loadTickets();
    loadReminders();
    return true;
  };

  return (
    <IndustryManagerShell
      idPrefix="watch"
      navLabel="بخش‌های ساعت"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      error={error}
    >
      {tab === "units" ? (
        models === null || units === null ? (
          <SectionCardSkeleton rows={5} />
        ) : (
          <UnitsSection models={models} units={units} busy={busy} run={run} />
        )
      ) : null}
      {tab === "repairs" ? (
        tickets === null || units === null ? (
          <SectionCardSkeleton rows={5} />
        ) : (
          <RepairsSection tickets={tickets} units={units} busy={busy} run={run} />
        )
      ) : null}
      {tab === "reminders" ? (
        reminders === null ? <SectionCardSkeleton rows={4} /> : <RemindersSection reminders={reminders} />
      ) : null}
      {tab === "reports" ? <ReportsSection /> : null}
    </IndustryManagerShell>
  );
}
