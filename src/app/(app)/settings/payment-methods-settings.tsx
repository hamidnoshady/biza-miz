"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronUpIcon, RotateCwIcon, TrashIcon } from "lucide-react";
import {
  CUSTOM_PAYMENT_SETTLEMENTS,
  MAX_PAYMENT_METHOD_NAME,
  type PaymentMethodView,
  type PaymentSettlement,
} from "@/lib/payment-methods";
import { paymentWayIcon } from "@/app/dashboard/payment-ways";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
  StatusBadge,
} from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";

const SETTLEMENT_LABELS: Record<PaymentSettlement, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت‌به‌کارت",
  online: "درگاه آنلاین",
  credit: "نسیه",
  cheque: "چک",
  snappfood: "اسنپ‌فود",
  // Not a way a business can add (CUSTOM_PAYMENT_SETTLEMENTS excludes it), and
  // no seeded way settles this way: a campaign reward spent at the till is the
  // reward engine's, not the settings screen's. Named anyway so this map stays
  // exhaustive over the settlement vocabulary.
  cashback: "بازگشت وجه کمپین",
};

const SETTLEMENT_ACCOUNTS: Record<PaymentSettlement, string> = {
  cash: "صندوق (۱۰۱۰)",
  card: "بانک در راه (۱۰۲۰)",
  card_to_card: "بانک در راه (۱۰۲۰)",
  online: "بانک در راه (۱۰۲۰)",
  credit: "حساب‌های دریافتنی (۱۳۰۰)",
  cheque: "چک‌های نزد صندوق (۱۲۴۱)",
  snappfood: "مطالبات از پلتفرم",
  cashback: "بازگشت وجه تبلیغاتی (۲۴۴۵)",
};

function settlementText(value: PaymentSettlement): string {
  return `${SETTLEMENT_LABELS[value]} — ${SETTLEMENT_ACCOUNTS[value]}`;
}

/** The business-owned payment ways and the exact order shown at checkout. */
export function PaymentMethodsSettings() {
  const [methods, setMethods] = useState<PaymentMethodView[]>([]);
  const [nameDrafts, setNameDrafts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PaymentMethodView | null>(null);

  const [name, setName] = useState("");
  const [settlement, setSettlement] = useState<PaymentSettlement>("cash");
  const [opensDrawer, setOpensDrawer] = useState(true);
  const [requiresReference, setRequiresReference] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { ok, data } = await api<{ paymentMethods: PaymentMethodView[]; error?: string }>(
        "/api/settings/payment-methods",
      );
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      const next = data.paymentMethods ?? [];
      setMethods(next);
      setNameDrafts(Object.fromEntries(next.map((method) => [method.id, method.name])));
    } catch {
      setError("ارتباط با سرور برقرار نشد. اتصال را بررسی و دوباره تلاش کنید.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function request<T extends { error?: string }>(
    key: string,
    url: string,
    init: RequestInit,
    success: string,
  ): Promise<T | null> {
    setPending((current) => new Set(current).add(key));
    setError("");
    setInfo("");
    try {
      const { ok, data } = await api<T>(url, init);
      if (!ok) {
        setError(errorMessage(data.error));
        return null;
      }
      setInfo(success);
      return data;
    } catch {
      setError("ارتباط با سرور برقرار نشد؛ تغییری ذخیره نشد. دوباره تلاش کنید.");
      return null;
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  function replaceMethod(updated: PaymentMethodView) {
    setMethods((current) => current.map((method) => (method.id === updated.id ? updated : method)));
    setNameDrafts((current) => ({ ...current, [updated.id]: updated.name }));
  }

  async function patch(
    method: PaymentMethodView,
    key: string,
    body: Record<string, unknown>,
    success: string,
  ) {
    const data = await request<{ paymentMethod: PaymentMethodView; error?: string }>(
      `${key}:${method.id}`,
      `/api/settings/payment-methods/${method.id}`,
      { method: "PATCH", body: JSON.stringify(body) },
      success,
    );
    if (data?.paymentMethod) replaceMethod(data.paymentMethod);
    return Boolean(data);
  }

  async function saveName(method: PaymentMethodView) {
    const value = (nameDrafts[method.id] ?? method.name).trim();
    if (!value || value.length > MAX_PAYMENT_METHOD_NAME) {
      setError(`نام روش پرداخت باید بین ۱ تا ${MAX_PAYMENT_METHOD_NAME.toLocaleString("fa-IR")} نویسه باشد.`);
      return;
    }
    if (value === method.name) {
      setNameDrafts((current) => ({ ...current, [method.id]: method.name }));
      return;
    }
    await patch(method, "name", { name: value }, "نام روش پرداخت ذخیره شد.");
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > MAX_PAYMENT_METHOD_NAME) {
      setError(`نام روش پرداخت باید بین ۱ تا ${MAX_PAYMENT_METHOD_NAME.toLocaleString("fa-IR")} نویسه باشد.`);
      return;
    }
    const data = await request<{ paymentMethod: PaymentMethodView; error?: string }>(
      "add",
      "/api/settings/payment-methods",
      {
        method: "POST",
        body: JSON.stringify({ name: trimmedName, settlement, opensDrawer, requiresReference }),
      },
      "روش پرداخت اضافه شد.",
    );
    if (!data?.paymentMethod) return;
    setMethods((current) => [...current, data.paymentMethod]);
    setNameDrafts((current) => ({ ...current, [data.paymentMethod.id]: data.paymentMethod.name }));
    setName("");
    setSettlement("cash");
    setOpensDrawer(true);
    setRequiresReference(false);
  }

  async function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= methods.length || pending.has("order")) return;
    const previous = methods;
    const next = [...methods];
    [next[index], next[target]] = [next[target], next[index]];
    setMethods(next);
    const data = await request<{ paymentMethods: PaymentMethodView[]; error?: string }>(
      "order",
      "/api/settings/payment-methods",
      { method: "PUT", body: JSON.stringify({ order: next.map((method) => method.id) }) },
      "ترتیب نمایش ذخیره شد.",
    );
    if (data?.paymentMethods) setMethods(data.paymentMethods);
    else setMethods(previous);
  }

  async function remove() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    const data = await request<{ ok: boolean; error?: string }>(
      `delete:${target.id}`,
      `/api/settings/payment-methods/${target.id}`,
      { method: "DELETE" },
      "روش پرداخت حذف شد.",
    );
    if (!data?.ok) {
      // The actionable error is shown above the list; close the modal so it is
      // not hidden behind an inert overlay.
      setDeleteTarget(null);
      return;
    }
    setMethods((current) => current.filter((method) => method.id !== target.id));
    setNameDrafts((current) => {
      const next = { ...current };
      delete next[target.id];
      return next;
    });
    setDeleteTarget(null);
  }

  if (loading) return <LoadingSkeleton rows={5} label="در حال بارگذاری روش‌های پرداخت" />;

  if (error && methods.length === 0) {
    return (
      <SectionCard title="روش‌های دریافت وجه">
        <ErrorBox>{error}</ErrorBox>
        <Button type="button" variant="outline" onClick={() => void load()}>
          <RotateCwIcon aria-hidden="true" />
          تلاش دوباره
        </Button>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <div aria-live="polite">
        <ErrorBox>{error}</ErrorBox>
        {info ? <InfoBox>{info}</InfoBox> : null}
      </div>

      <SectionCard
        title="روش‌های دریافت وجه"
        description="این فهرست با همین ترتیب در صندوق فروش و سفارش‌ها نمایش داده می‌شود. برای کنارگذاشتن روشی که سابقه دارد، آن را غیرفعال کنید."
        footer="نحوهٔ تسویه تعیین می‌کند وجه در کدام حساب ثبت شود. پس از نخستین دریافت، نحوهٔ تسویه دیگر قابل تغییر نیست."
      >
        {methods.length === 0 ? (
          <EmptyState>هنوز روش پرداختی ثبت نشده است. از فرم پایین یک روش اضافه کنید.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {methods.map((method, index) => {
              const Icon = paymentWayIcon(method);
              const namePending = pending.has(`name:${method.id}`);
              const rowPending = [...pending].some((key) => key.endsWith(`:${method.id}`) && key !== `name:${method.id}`);
              return (
                <li
                  key={method.id}
                  className={`rounded-xl border border-border/80 p-3 sm:p-4 ${method.isActive ? "bg-card" : "bg-muted/40"}`}
                >
                  <div className="flex min-w-0 flex-wrap items-start gap-3 sm:flex-nowrap">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1 basis-[calc(100%-3.25rem)] sm:basis-auto">
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={`payment-name-${method.id}`} className="sr-only">
                          نام روش پرداخت
                        </label>
                        <input
                          id={`payment-name-${method.id}`}
                          className={`${inputClass} min-w-[10rem] flex-1 sm:max-w-72`}
                          value={nameDrafts[method.id] ?? method.name}
                          maxLength={MAX_PAYMENT_METHOD_NAME}
                          disabled={namePending}
                          aria-describedby={`payment-name-hint-${method.id}`}
                          onChange={(event) =>
                            setNameDrafts((current) => ({ ...current, [method.id]: event.target.value }))
                          }
                          onBlur={() => void saveName(method)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.currentTarget.blur();
                            if (event.key === "Escape") {
                              setNameDrafts((current) => ({ ...current, [method.id]: method.name }));
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        <StatusBadge tone={method.isActive ? "positive" : "neutral"}>
                          {method.isActive ? "فعال" : "غیرفعال"}
                        </StatusBadge>
                        {method.isBuiltin ? <StatusBadge>پیش‌فرض</StatusBadge> : null}
                      </div>
                      <p id={`payment-name-hint-${method.id}`} className="mt-1 text-xs text-muted-foreground">
                        {settlementText(method.settlement)}
                      </p>
                    </div>
                    <div className="ms-[3.25rem] flex w-[calc(100%-3.25rem)] shrink-0 items-center justify-end gap-1 sm:ms-0 sm:w-auto">
                      <Button
                        type="button"
                        onClick={() => void move(index, -1)}
                        disabled={pending.has("order") || index === 0}
                        variant="outline"
                        size="icon"
                        aria-label={`بردن ${method.name} به بالا`}
                      >
                        <ChevronUpIcon aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        onClick={() => void move(index, 1)}
                        disabled={pending.has("order") || index === methods.length - 1}
                        variant="outline"
                        size="icon"
                        aria-label={`بردن ${method.name} به پایین`}
                      >
                        <ChevronDownIcon aria-hidden="true" />
                      </Button>
                      {!method.isBuiltin ? (
                        <Button
                          type="button"
                          onClick={() => setDeleteTarget(method)}
                          disabled={rowPending}
                          variant="destructive"
                          size="icon"
                          aria-label={`حذف ${method.name}`}
                        >
                          <TrashIcon aria-hidden="true" />
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2 border-t border-border/80 pt-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-lg bg-muted/50 px-3 py-2">
                      <label htmlFor={`settlement-${method.id}`} className="block text-xs font-medium text-foreground">
                        نحوهٔ تسویه
                      </label>
                      {method.isBuiltin ? (
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{settlementText(method.settlement)}</p>
                      ) : (
                        <select
                          id={`settlement-${method.id}`}
                          className={`${inputClass} mt-1 h-9`}
                          value={method.settlement}
                          disabled={pending.has(`settlement:${method.id}`)}
                          onChange={(event) =>
                            void patch(
                              method,
                              "settlement",
                              { settlement: event.target.value },
                              "نحوهٔ تسویه ذخیره شد.",
                            )
                          }
                        >
                          {CUSTOM_PAYMENT_SETTLEMENTS.map((value) => (
                            <option key={value} value={value}>{settlementText(value)}</option>
                          ))}
                        </select>
                      )}
                    </div>
                    <SettingSwitch
                      label="نمایش در صندوق"
                      description={method.isActive ? "قابل انتخاب هنگام دریافت" : "از انتخاب‌ها پنهان است"}
                      checked={method.isActive}
                      disabled={pending.has(`active:${method.id}`)}
                      onCheckedChange={(checked) =>
                        void patch(
                          method,
                          "active",
                          { isActive: checked },
                          checked ? "روش پرداخت فعال شد." : "روش پرداخت غیرفعال شد.",
                        )
                      }
                    />
                    <SettingSwitch
                      label="شمارهٔ پیگیری"
                      description="هنگام دریافت الزامی باشد"
                      checked={method.requiresReference}
                      disabled={pending.has(`reference:${method.id}`)}
                      onCheckedChange={(checked) =>
                        void patch(method, "reference", { requiresReference: checked }, "تنظیم شمارهٔ پیگیری ذخیره شد.")
                      }
                    />
                    <SettingSwitch
                      label="باز کردن کشوی پول"
                      description="پس از ثبت این روش"
                      checked={method.opensDrawer}
                      disabled={pending.has(`drawer:${method.id}`)}
                      onCheckedChange={(checked) =>
                        void patch(method, "drawer", { opensDrawer: checked }, "تنظیم کشوی پول ذخیره شد.")
                      }
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="افزودن روش پرداخت"
        description="برای کارت‌خوان دوم، کیف پول یا هر روش دیگری یک نام روشن و نحوهٔ ثبت حسابداری انتخاب کنید."
      >
        <form onSubmit={add} className="space-y-1">
          <div className="grid gap-x-4 sm:grid-cols-2">
            <Field
              label="نام روش"
              hint={`حداکثر ${MAX_PAYMENT_METHOD_NAME.toLocaleString("fa-IR")} نویسه؛ مثلاً «پوز بانک ملت»`}
            >
              <input
                className={inputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="مثلاً پوز بانک ملت"
                maxLength={MAX_PAYMENT_METHOD_NAME}
                autoComplete="off"
              />
            </Field>
            <Field label="نحوهٔ تسویه" hint="حساب مقصد این دریافت در دفتر کل">
              <select
                className={inputClass}
                value={settlement}
                onChange={(event) => {
                  const value = event.target.value as PaymentSettlement;
                  setSettlement(value);
                  setOpensDrawer(value === "cash");
                }}
              >
                {CUSTOM_PAYMENT_SETTLEMENTS.map((value) => (
                  <option key={value} value={value}>{settlementText(value)}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            <SettingSwitch
              label="شمارهٔ پیگیری الزامی باشد"
              description="صندوق‌دار باید کد پیگیری وارد کند"
              checked={requiresReference}
              onCheckedChange={setRequiresReference}
            />
            <SettingSwitch
              label="کشوی پول باز شود"
              description="معمولاً فقط برای دریافت نقدی"
              checked={opensDrawer}
              onCheckedChange={setOpensDrawer}
            />
          </div>
          <Button type="submit" disabled={pending.has("add") || !name.trim()}>
            {pending.has("add") ? "در حال افزودن…" : "افزودن روش پرداخت"}
          </Button>
        </form>
      </SectionCard>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف روش پرداخت</DialogTitle>
            <DialogDescription>
              روش «{deleteTarget?.name}» حذف شود؟ فقط روشی که تاکنون با آن وجهی دریافت نشده باشد قابل حذف است.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="destructive"
              disabled={deleteTarget ? pending.has(`delete:${deleteTarget.id}`) : false}
              onClick={() => void remove()}
            >
              {deleteTarget && pending.has(`delete:${deleteTarget.id}`) ? "در حال حذف…" : "حذف روش"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              انصراف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SettingSwitch({
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        aria-label={label}
      />
    </div>
  );
}
