"use client";

/**
 * Quick-create `+` bottom sheet (`QuickCreateSheet`) for the mobile bottom
 * navigation bar (issue #884).
 *
 * Shows only actions that are enabled for the active business and authorized
 * for the signed-in user (derived from `allowedHrefs` and `enabledFeatures`),
 * and reuses canonical Biza Miz APIs (`POST /api/parties`,
 * `POST /api/crm/activities`) and canonical module routes.
 */
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  CheckSquareIcon,
  CreditCardIcon,
  PhoneCallIcon,
  QrCodeIcon,
  ReceiptIcon,
  ShoppingBagIcon,
  UserPlusIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CameraBarcodeScanner } from "@/components/scanner/camera-barcode-scanner";
import {
  buildQuickCrmActivityPayload,
  buildQuickCustomerPartyPayload,
} from "@/lib/native/capabilities-client";
import { AppSheet } from "./app-sheet";

export interface QuickCreateActionSpec {
  id:
    | "new_order"
    | "new_customer"
    | "record_payment"
    | "record_expense"
    | "scan_barcode"
    | "crm_activity"
    | "new_task";
  label: string;
  description: string;
  href?: string;
}

export function resolveAuthorizedQuickActions(input: {
  allowedHrefs: ReadonlySet<string>;
  crmEnabled?: boolean;
  inventoryEnabled?: boolean;
}): QuickCreateActionSpec[] {
  const { allowedHrefs, crmEnabled = true, inventoryEnabled = true } = input;
  const actions: QuickCreateActionSpec[] = [];

  if (allowedHrefs.has("/pos") || allowedHrefs.has("/accounting/pos")) {
    actions.push({
      id: "new_order",
      label: "ثبت سفارش / فروش جدید",
      description: "باز کردن صندوق فروش و ثبت سفارش مشتری",
      href: allowedHrefs.has("/pos") ? "/pos" : "/accounting/pos",
    });
  } else if (allowedHrefs.has("/accounting/orders")) {
    actions.push({
      id: "new_order",
      label: "ثبت سفارش / فاکتور فروش",
      description: "ثبت سفارش یا فاکتور فروش جدید",
      href: "/accounting/orders",
    });
  }

  if (crmEnabled && (allowedHrefs.has("/crm/customers") || allowedHrefs.has("/accounting/customers"))) {
    actions.push({
      id: "new_customer",
      label: "افزودن مشتری جدید",
      description: "ثبت سریع نام و شماره تماس مشتری در فهرست اشخاص",
      href: allowedHrefs.has("/crm/customers") ? "/crm/customers" : "/accounting/customers",
    });
  }

  if (allowedHrefs.has("/accounting/receipts")) {
    actions.push({
      id: "record_payment",
      label: "ثبت دریافت / پرداخت",
      description: "ثبت رسید دریافت وجه یا پرداخت به طرف حساب",
      href: "/accounting/receipts",
    });
  }

  if (allowedHrefs.has("/accounting/expenses")) {
    actions.push({
      id: "record_expense",
      label: "ثبت هزینه",
      description: "ثبت سند هزینهٔ روزانه یا تنخواه",
      href: "/accounting/expenses",
    });
  }

  if (
    inventoryEnabled &&
    (allowedHrefs.has("/accounting/inventory") ||
      allowedHrefs.has("/accounting/products") ||
      allowedHrefs.has("/pos") ||
      allowedHrefs.has("/accounting/pos"))
  ) {
    actions.push({
      id: "scan_barcode",
      label: "اسکن بارکد / QR کالا",
      description: "جستجوی کالا یا سفارش با اسکنر دوربین",
    });
  }

  if (crmEnabled && (allowedHrefs.has("/crm/activities") || allowedHrefs.has("/crm"))) {
    actions.push({
      id: "crm_activity",
      label: "ثبت تماس یا پیگیری CRM",
      description: "ثبت نتیجهٔ تماس، جلسه یا یادداشت مشتری",
      href: "/crm/activities",
    });
  }

  if (allowedHrefs.has("/workspace/tasks") || allowedHrefs.has("/crm/activities")) {
    actions.push({
      id: "new_task",
      label: "ایجاد وظیفه یا یادآور",
      description: "ثبت سریع کار روزانه یا پیگیری",
      href: allowedHrefs.has("/workspace/tasks") ? "/workspace/tasks" : "/crm/activities",
    });
  }

  return actions;
}

export interface QuickCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allowedHrefs: ReadonlySet<string>;
  crmEnabled?: boolean;
  inventoryEnabled?: boolean;
}

export function QuickCreateSheet({
  open,
  onOpenChange,
  allowedHrefs,
  crmEnabled = true,
  inventoryEnabled = true,
}: QuickCreateSheetProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"menu" | "customer" | "activity" | "task">("menu");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [activitySubject, setActivitySubject] = useState("");
  const [activityBody, setActivityBody] = useState("");
  const [activityDueDate, setActivityDueDate] = useState("");

  const actions = resolveAuthorizedQuickActions({
    allowedHrefs,
    crmEnabled,
    inventoryEnabled,
  });

  function resetAndClose() {
    setMode("menu");
    setError(null);
    setCustomerName("");
    setCustomerPhone("");
    setActivitySubject("");
    setActivityBody("");
    setActivityDueDate("");
    onOpenChange(false);
  }

  async function submitQuickCustomer(e: FormEvent) {
    e.preventDefault();
    const payload = buildQuickCustomerPartyPayload({
      displayName: customerName,
      phone: customerPhone,
    });
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/parties", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError("ثبت مشتری انجام نشد. دوباره تلاش کنید.");
        return;
      }
      resetAndClose();
      router.push(allowedHrefs.has("/crm/customers") ? "/crm/customers" : "/accounting/customers");
      router.refresh();
    } catch {
      setError("خطا در ارتباط با سرور.");
    } finally {
      setBusy(false);
    }
  }

  async function submitQuickActivity(e: FormEvent, kind: "call" | "task") {
    e.preventDefault();
    const payload = buildQuickCrmActivityPayload({
      kind,
      subject: activitySubject,
      body: activityBody,
      dueAt: activityDueDate ? new Date(activityDueDate).toISOString() : null,
      completed: false,
    });
    if (!payload) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/crm/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        setError("ثبت مورد انجام نشد. دوباره تلاش کنید.");
        return;
      }
      resetAndClose();
      if (allowedHrefs.has("/crm/activities")) {
        router.push("/crm/activities");
        router.refresh();
      }
    } catch {
      setError("خطا در ارتباط با سرور.");
    } finally {
      setBusy(false);
    }
  }

  function renderIcon(id: QuickCreateActionSpec["id"]) {
    switch (id) {
      case "new_order":
        return <ShoppingBagIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "new_customer":
        return <UserPlusIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "record_payment":
        return <CreditCardIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "record_expense":
        return <ReceiptIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "scan_barcode":
        return <QrCodeIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "crm_activity":
        return <PhoneCallIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
      case "new_task":
        return <CheckSquareIcon className="size-5 text-amber-600 dark:text-amber-400" aria-hidden="true" />;
    }
  }

  return (
    <>
      <AppSheet
        open={open}
        onOpenChange={(next) => {
          if (!next) resetAndClose();
          else onOpenChange(true);
        }}
        title={
          mode === "customer"
            ? "افزودن سریع مشتری"
            : mode === "activity"
              ? "ثبت سریع تماس / پیگیری CRM"
              : mode === "task"
                ? "ایجاد سریع وظیفه"
                : "ایجاد سریع"
        }
        description={
          mode === "menu"
            ? "یکی از عملیات‌های مجاز کسب‌وکار را انتخاب کنید"
            : undefined
        }
      >
        {mode === "menu" ? (
          <div className="grid grid-cols-1 gap-2">
            {actions.map((action) => (
              <button
                key={action.id}
                type="button"
                onClick={() => {
                  if (action.id === "scan_barcode") {
                    onOpenChange(false);
                    setScannerOpen(true);
                    return;
                  }
                  if (action.id === "new_customer") {
                    setMode("customer");
                    return;
                  }
                  if (action.id === "crm_activity") {
                    setMode("activity");
                    return;
                  }
                  if (action.id === "new_task" && allowedHrefs.has("/crm/activities")) {
                    setMode("task");
                    return;
                  }
                  if (action.href) {
                    resetAndClose();
                    router.push(action.href);
                  }
                }}
                className="flex min-h-14 w-full items-center gap-3 rounded-xl border border-border/80 bg-secondary/50 px-3.5 py-2.5 text-start transition hover:bg-muted"
              >
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-card">
                  {renderIcon(action.id)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-foreground">
                    {action.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {action.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : mode === "customer" ? (
          <form onSubmit={(e) => void submitQuickCustomer(e)} className="space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="qc-customer-name">
                نام مشتری
              </label>
              <input
                id="qc-customer-name"
                required
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="مثلاً علی رضایی"
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="qc-customer-phone">
                شماره تماس
              </label>
              <input
                id="qc-customer-phone"
                dir="ltr"
                inputMode="tel"
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="09123456789"
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
            {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
            <div className="flex items-center gap-2 pt-2">
              <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => setMode("menu")}>
                بازگشت
              </Button>
              <Button type="submit" disabled={busy || !customerName.trim()} className="min-h-11 flex-1">
                {busy ? "در حال ثبت…" : "ثبت مشتری"}
              </Button>
            </div>
          </form>
        ) : (
          <form
            onSubmit={(e) => void submitQuickActivity(e, mode === "task" ? "task" : "call")}
            className="space-y-3"
          >
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="qc-activity-subject">
                موضوع
              </label>
              <input
                id="qc-activity-subject"
                required
                value={activitySubject}
                onChange={(e) => setActivitySubject(e.target.value)}
                placeholder={mode === "task" ? "مثلاً ارسال پیش‌فاکتور" : "مثلاً تماس پیگیری سفارش"}
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="qc-activity-body">
                توضیحات (اختیاری)
              </label>
              <textarea
                id="qc-activity-body"
                rows={3}
                value={activityBody}
                onChange={(e) => setActivityBody(e.target.value)}
                className="w-full rounded-xl border border-border bg-card p-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-foreground" htmlFor="qc-activity-due">
                موعد انجام / پیگیری (اختیاری)
              </label>
              <input
                id="qc-activity-due"
                type="datetime-local"
                dir="ltr"
                value={activityDueDate}
                onChange={(e) => setActivityDueDate(e.target.value)}
                className="min-h-11 w-full rounded-xl border border-border bg-card px-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-400"
              />
            </div>
            {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
            <div className="flex items-center gap-2 pt-2">
              <Button type="button" variant="outline" className="min-h-11 flex-1" onClick={() => setMode("menu")}>
                بازگشت
              </Button>
              <Button type="submit" disabled={busy || !activitySubject.trim()} className="min-h-11 flex-1">
                {busy ? "در حال ثبت…" : "ذخیره"}
              </Button>
            </div>
          </form>
        )}
      </AppSheet>

      <CameraBarcodeScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScan={(code) => {
          setScannerOpen(false);
          const target = allowedHrefs.has("/accounting/products")
            ? `/accounting/products?q=${encodeURIComponent(code)}`
            : allowedHrefs.has("/accounting/inventory")
              ? `/accounting/inventory?q=${encodeURIComponent(code)}`
              : `/pos?barcode=${encodeURIComponent(code)}`;
          router.push(target);
        }}
      />
    </>
  );
}
