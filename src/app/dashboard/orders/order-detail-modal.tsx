"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * The whole of an order — meta, lines, add-ons, discount, tender, and the
 * closed-order amendment panel — in one dialog over the orders screen.
 *
 * It replaces the standalone /dashboard/orders/[id] page (that route now
 * redirects here). Working an order is a *step inside* the queue, not a
 * departure from it: sending the cashier to another screen lost the queue,
 * the filters, and the shift context they were reading a second earlier, and
 * cost a round trip back for every next order. Everything the page showed is
 * here — nothing is deferred to a second screen.
 *
 * It is drawn in the operations design language the rest of the floor-facing
 * app uses (the dashboard overview, the POS, the KDS, and the orders queue
 * behind it): the warm canvas, `bg-card` surfaces on `border-border`
 * hairlines, the amber accent, pill status chips, and no control smaller than a 44–48px
 * touch target. Add-on chips are `tone="amber"` for the same reason — this is
 * a cash-desk surface, not a document one.
 *
 * Layout is one column on a phone and two from `lg` up (lines on one side,
 * money on the other); the line list itself becomes a real table from `md` up
 * and stays a stack of cards below that.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  MinusIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  Trash2Icon,
  UserIcon,
  XIcon,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  draftOpensDrawer,
  draftReceiptPayments,
  draftRequiresCustomer,
  emptyPaymentDraft,
  paymentDraftBody,
  type PaymentDraft,
} from "@/lib/payment-draft";
import { PaymentWays, usePaymentMethods } from "../payment-ways";
import { LoadingSkeleton } from "../page-chrome";
import { formatQueueLabel } from "@/lib/orders";
import { crmCustomerHref } from "@/app/(app)/crm/crm-routes";
import { kickDrawer, printReceipt } from "@/lib/printing/client";
import type { ReceiptData } from "@/lib/receipt-template";
import {
  formatModifierDelta,
  linePriceBreakdown,
  modifierDeltasOf,
  modifierNamesLabel,
  modifierQuantity,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { CustomerBalanceBadge, CustomerPicker, type PickerCustomer } from "../customer-picker";
import { HoldToConfirmButton } from "../hold-to-confirm-button";
import { isTableOccupied, isTableUnavailable } from "@/lib/pos-selection";
import {
  buildRestaurantMenuIndex,
  toRestaurantMenu,
  type MenuTreePayload,
  type RestaurantMenuData,
  type RestaurantMenuItem,
} from "@/lib/restaurant-menu";
import {
  ModifierPicker,
  type ModifierGroupWithModifiers,
} from "../modifier-picker";
import { apiOrQueue } from "../offline-queue";
import { api, errorMessage } from "../ui";
import { useBusinessInfo } from "../use-printers";
import { ClosedOrderAmendment } from "./closed-order-amendment";
import { usePromptDialog } from "../prompt-dialog";
import {
  CARD,
  DANGER_BUTTON,
  FOCUS,
  OPS_INPUT,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  STEPPER_BUTTON,
} from "./ops-styles";

/**
 * The columns the line table's header and its rows share, so the two align:
 * قلم | تعداد | مبلغ | (void). Below `md` the same children reflow into two
 * rows — name + amount, then the controls — which is why every cell carries an
 * explicit `md:col-start`/`md:row-start` rather than relying on source order.
 */
const LINE_GRID =
  "md:grid md:grid-cols-[minmax(0,1fr)_8.5rem_9rem_2.75rem] md:gap-3";

/** The same chips the dashboard overview and the queue use, so a status reads alike everywhere. */
const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  open: {
    label: "باز",
    className: "border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
  },
  held: {
    label: "نگه‌داشته",
    className: "border-border/80 bg-muted text-muted-foreground",
  },
  completed: {
    label: "تکمیل‌شده",
    className: "border-emerald-500/25 dark:border-emerald-500/25 bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  },
  voided: {
    label: "باطل‌شده",
    className: "border-destructive/30 bg-destructive/5 text-destructive",
  },
};

const TYPE_LABELS: Record<string, string> = {
  dine_in: "حضوری",
  takeaway: "بیرون‌بر",
  delivery: "ارسالی",
  retail: "فروشگاهی",
};

const PAYMENT_LABELS: Record<string, string> = {
  cash: "نقدی",
  card: "کارت‌خوان",
  card_to_card: "کارت‌به‌کارت",
  online: "پرداخت آنلاین",
  credit: "نسیه",
  cheque: "چک",
};

/** The dialog's three tabs — see the `tab` state for what belongs where. */
const ORDER_TABS = [
  { id: "register", label: "سفارش و صندوق" },
  { id: "info", label: "اطلاعات سفارش" },
  { id: "ops", label: "عملیات بیشتر" },
] as const;

function orderLabel(order: Pick<OrderRow, "type" | "order_number">): string {
  return order.type === "retail"
    ? `فاکتور ${order.order_number}`
    : formatQueueLabel(order.type, order.order_number);
}

/** A directory customer as this dialog needs it (see customer-picker.tsx). */
type Customer = PickerCustomer;

interface OrderRow {
  id: string;
  order_number: number;
  type: "dine_in" | "takeaway" | "delivery" | "retail";
  status: "open" | "held" | "completed" | "voided";
  table_id: string | null;
  table_name: string | null;
  /** Whom the sale is attributed to — set at the till, by a credit checkout, or by an imported sale. */
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  guest_count: number | null;
  subtotal: string | number;
  discount: string | number;
  discount_type: "percent" | "amount" | null;
  discount_value: string | number | null;
  service_charge: string | number | null;
  tax: string | number;
  total: string | number;
  tip_amount: string | number | null;
  note: string | null;
  voided_reason: string | null;
  opened_at: string;
  closed_at: string | null;
}

interface OrderItemRow {
  id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  unit_price: string | number;
  quantity: number;
  status: string;
  note: string | null;
  void_reason: string | null;
}

interface ModifierRow {
  id: string;
  order_item_id: string;
  /** Null only for a snapshot whose modifier row was deleted since the sale. */
  modifier_id: string | null;
  name_snapshot: string;
  price_delta: string | number;
  /** How many of this add-on the line carries («شات اضافه ×۳» = 3). */
  quantity: number | null;
}

interface PaymentRow {
  id: string;
  method: string;
  amount: string | number;
  reference: string | null;
  payment_method_name: string | null;
}

/**
 * The add-item panel consumes the canonical shared menu model
 * (restaurant-menu.ts) — the same rows, bounds resolution and ordering the
 * POS and the waiter screen sell from, so an add-on offered on one screen is
 * offered identically on the others.
 */
type MenuItem = RestaurantMenuItem;
type MenuData = RestaurantMenuData;

/** Which line the add-on picker is open for, and in which mode. */
type PickerTarget =
  | { mode: "add"; menuItem: MenuItem; quantity: number }
  | {
      mode: "edit";
      menuItem: MenuItem;
      item: OrderItemRow;
      modifiers: { id: string; quantity: number }[];
      note: string;
    };

function timeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return toPersianDigits(
    new Intl.DateTimeFormat("fa-IR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date),
  );
}

export function OrderDetailModal({
  orderId,
  open,
  onOpenChange,
  canEdit,
  canTakePayment,
  canAmendClosed = false,
  onChanged,
}: {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
  /** May take money and complete an order; deliberately independent of editing. */
  canTakePayment: boolean;
  /** may edit/remove an order that has already been paid for — a separate, back-office permission */
  canAmendClosed?: boolean;
  /** Lets the queue behind the dialog re-read itself after a paid/voided/edited order. */
  onChanged?: () => void;
}) {
  const [order, setOrder] = useState<OrderRow | null>(null);
  const [orderLoaded, setOrderLoaded] = useState(false);
  const loadRequest = useRef(0);
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [modifiers, setModifiers] = useState<ModifierRow[]>([]);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [addItemId, setAddItemId] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [editingNote, setEditingNote] = useState(false);
  const [showVoided, setShowVoided] = useState(false);
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    "",
  );
  const [discountValue, setDiscountValue] = useState("");
  // The business's own payment ways, and what the cashier has chosen — a
  // single way or a split across several (src/lib/payment-draft.ts). Shared
  // with the POS through <PaymentWays>, so the two checkouts stay identical.
  const {
    methods: paymentMethods,
    loaded: paymentMethodsLoaded,
    error: paymentMethodsError,
    reload: reloadPaymentMethods,
  } = usePaymentMethods(canTakePayment);
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(() => emptyPaymentDraft([]));
  // The ways land a render or two after the dialog opens, so the draft starts
  // pointing at nothing; this settles it on the first way once they arrive.
  useEffect(() => {
    setPaymentDraft((draft) =>
      paymentMethods.some((method) => method.id === draft.methodId) ? draft : emptyPaymentDraft(paymentMethods),
    );
  }, [paymentMethods]);
  const [tipInput, setTipInput] = useState("");
  const [paying, setPaying] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(
    null,
  );
  /** Bumped to open the customer picker from the payment preview's action. */
  const [customerPickerRequests, setCustomerPickerRequests] = useState(0);
  const [tables, setTables] = useState<{ id: string; name: string; status: string }[]>([]);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState("");
  /**
   * The dialog's three tabs — صندوق (the bill and its payment), اطلاعات
   * (the order's facts), عملیات (everything that is not the bill itself).
   * Working an order is usually a one-tab visit: the cashier opens صندوق,
   * takes the money, closes; the other two are there for the visits that
   * need them, without crowding the one that doesn't.
   */
  const [tab, setTab] = useState<"register" | "info" | "ops">("register");
  const business = useBusinessInfo();
  const money = useMoney();

  const load = useCallback(async () => {
    if (!orderId) {
      setOrderLoaded(true);
      return;
    }
    const requestId = ++loadRequest.current;
    try {
      const { ok, data } = await api<{
        order: OrderRow;
        items: OrderItemRow[];
        modifiers: ModifierRow[];
        payments: PaymentRow[];
        error?: string;
      }>(`/api/orders/${orderId}`);
      if (requestId !== loadRequest.current) return;
      if (!ok) {
        setError(errorMessage(data.error));
        return;
      }
      setOrder(data.order);
      setSelectedTableId(data.order.table_id ?? "");
      setItems(data.items);
      setModifiers(data.modifiers);
      setPayments(data.payments ?? []);
      // An order that already names a customer keeps naming them: the credit
      // checkout below re-uses this selection instead of making the cashier
      // search the directory again for a customer the order already has.
      // Only when nothing is picked yet — `load()` also runs after an item edit,
      // and must not throw away a pick the cashier just made mid-checkout. The
      // open-effect below clears it, so each fresh dialog starts from the order.
      setSelectedCustomer(
        (current) =>
          current ??
          (data.order.customer_id && data.order.customer_name
            ? {
                id: data.order.customer_id,
                name: data.order.customer_name,
                phone: data.order.customer_phone,
              }
            : null),
      );
      setDiscountType(data.order.discount_type ?? "");
      // `discount_value` is stored in Rial for an `amount` discount; the input
      // below is Toman, so present it back in Toman and re-convert on save.
      setDiscountValue(
        data.order.discount_value
          ? String(
              data.order.discount_type === "amount"
                ? money.toInput(Number(data.order.discount_value))
                : data.order.discount_value,
            )
          : "",
      );
      setNoteDraft(data.order.note ?? "");
    } catch {
      if (requestId === loadRequest.current) {
        setError("بارگذاری اطلاعات سفارش ممکن نشد.");
      }
    } finally {
      if (requestId === loadRequest.current) setOrderLoaded(true);
    }
  }, [money, orderId]);

  // A closed dialog holds no order: reopening on a different row must never
  // flash the previous order's lines while the fetch is in flight.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setOrder(null);
    setOrderLoaded(false);
    setItems([]);
    setModifiers([]);
    setPayments([]);
    setError("");
    setInfo("");
    setEditingNote(false);
    setShowVoided(false);
    setAddItemId("");
    setAddQty("1");
    setTipInput("");
    setSelectedCustomer(null);
    setTab("register");
    setPaymentDraft(emptyPaymentDraft(paymentMethods));
    setTables([]);
    setTablesLoaded(false);
    void load();
    void api<{ tables: { id: string; name: string; status: string }[] }>("/api/tables")
      .then(({ ok, data }) => {
        if (!cancelled && ok) setTables(data.tables);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setTablesLoaded(true);
      });
    return () => {
      cancelled = true;
      loadRequest.current += 1;
    };
  }, [load, open, paymentMethods]);

  useEffect(() => {
    if (!open || menu) return;
    void api<MenuTreePayload>("/api/menu")
      .then(({ ok, data }) =>
        setMenu(
          ok
            ? toRestaurantMenu(data)
            : { categories: [], items: [], modifierGroups: [], modifiers: [], itemModifierGroups: [] },
        ),
      )
      .catch(() =>
        setMenu({ categories: [], items: [], modifierGroups: [], modifiers: [], itemModifierGroups: [] }),
      );
  }, [menu, open]);

  const addOnsByItem = useMemo(() => {
    const map = new Map<
      string,
      (DisplayModifier & { modifierId: string | null })[]
    >();
    for (const modifier of modifiers) {
      const current = map.get(modifier.order_item_id) ?? [];
      current.push({
        name: modifier.name_snapshot,
        priceDelta: Number(modifier.price_delta),
        quantity: modifierQuantity({ quantity: modifier.quantity ?? 1 }),
        modifierId: modifier.modifier_id,
      });
      map.set(modifier.order_item_id, current);
    }
    return map;
  }, [modifiers]);

  /**
   * Picking is saving: choosing (or clearing, or quick-creating) a customer in
   * the picker patches the order right there, so there is no second «ذخیره»
   * button to forget on the way to payment.
   */
  async function saveOrderCustomer(customer: Customer | null) {
    setSelectedCustomer(customer);
    const saved = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ customerId: customer?.id ?? null }),
      }),
    );
    if (saved) setInfo(customer ? "مشتری سفارش ذخیره شد." : "مشتری سفارش حذف شد.");
  }

  async function saveOrderTable(tableId: string) {
    const saved = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ tableId }),
      }),
    );
    if (saved) setSelectedTableId(tableId);
  }

  const [promptDialog, askText] = usePromptDialog();

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    await load();
    onChanged?.();
    return true;
  }

  const menuIndex = useMemo(
    () => (menu ? buildRestaurantMenuIndex(menu) : null),
    [menu],
  );

  /** The add-on groups this item offers — resolved through the shared index. */
  function attachedGroups(menuItemId: string): ModifierGroupWithModifiers[] {
    return menuIndex?.groupsByItem.get(menuItemId) ?? [];
  }

  function startAddItem() {
    const menuItem = menu?.items.find((i) => i.id === addItemId);
    if (!menuItem) return;
    const quantity = Number(addQty) || 1;
    if (attachedGroups(menuItem.id).length === 0) {
      void addItem(menuItem.id, [], "");
    } else {
      setPicker({ mode: "add", menuItem, quantity });
    }
  }

  /** Re-open a line's add-ons in the same picker the till uses at intake. */
  function startEditAddOns(item: OrderItemRow) {
    if (!item.menu_item_id) return;
    const menuItem = menu?.items.find((i) => i.id === item.menu_item_id);
    if (!menuItem) return;
    setPicker({
      mode: "edit",
      menuItem,
      item,
      modifiers: (addOnsByItem.get(item.id) ?? []).flatMap((addOn) =>
        addOn.modifierId
          ? [{ id: addOn.modifierId, quantity: modifierQuantity(addOn) }]
          : [],
      ),
      note: item.note ?? "",
    });
  }

  async function addItem(
    menuItemId: string,
    picks: { id: string; quantity: number }[],
    note: string,
  ) {
    const quantity = Number(addQty) || 1;
    const payload = [
      { menuItemId, quantity, modifiers: picks, note: note || undefined },
    ];
    setBusy(true);
    setError("");
    setInfo("");
    const { ok, queued, data } = await apiOrQueue<{ error?: string }>(
      `/api/orders/${orderId}/items`,
      { method: "POST", body: { items: payload } },
      {
        type: "order.add_items",
        payload: { orderId, items: payload },
        description: "افزودن قلم به سفارش",
      },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    if (queued) {
      setInfo(
        "اتصال قطع است — افزودن این قلم ذخیره شد و پس از اتصال مجدد ارسال می‌شود.",
      );
    } else {
      await load();
      onChanged?.();
    }
    setAddItemId("");
    setAddQty("1");
  }

  async function saveAddOns(
    itemId: string,
    picks: { id: string; quantity: number }[],
    note: string,
  ) {
    const saved = await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ modifiers: picks, note }),
      }),
    );
    if (saved) toast.success("افزودنی‌های قلم به‌روز شد");
  }

  async function saveDiscount() {
    await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({
          discount: discountType
            ? {
                type: discountType,
                value:
                  discountType === "amount"
                    ? money.fromInput(Math.max(0, Math.round(Number(discountValue) || 0)))
                    : Number(discountValue) || 0,
              }
            : { type: null },
        }),
      }),
    );
  }

  async function saveNote() {
    const saved = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ note: noteDraft }),
      }),
    );
    if (saved) setEditingNote(false);
  }

  async function voidOrder() {
    const reason = await askText("دلیل ابطال سفارش؟");
    if (reason === null) return;
    const voided = await run(() =>
      api(`/api/orders/${orderId}`, {
        method: "PATCH",
        body: JSON.stringify({ void: { reason } }),
      }),
    );
    if (voided) toast.success("سفارش باطل شد");
  }

  async function voidItem(itemId: string) {
    const reason = await askText("دلیل ابطال قلم؟");
    if (reason === null) return;
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ void: { reason } }),
      }),
    );
  }

  async function setItemQty(itemId: string, quantity: number) {
    await run(() =>
      api(`/api/orders/${orderId}/items/${itemId}`, {
        method: "PATCH",
        body: JSON.stringify({ quantity }),
      }),
    );
  }

  function paymentsFromOrderRows(): { label: string; amount: number }[] {
    return payments.map((payment) => ({
      label: payment.payment_method_name ?? PAYMENT_LABELS[payment.method] ?? payment.method,
      amount: Number(payment.amount),
    }));
  }

  /** The receipt for this order as it stands — shared by checkout and reprint. */
  function buildReceipt(tipAmount: number, receiptPayments: { label: string; amount: number }[]): ReceiptData | null {
    if (!order) return null;
    return {
      business: {
        name: business.name,
        address: business.address,
        phone: business.phone,
      },
      orderLabel: orderLabel(order),
      orderTypeLabel:
        order.type === "dine_in"
          ? `حضوری${order.table_name ? ` — ${order.table_name}` : ""}`
          : TYPE_LABELS[order.type],
      issuedAt: new Date().toISOString(),
      lines: items
        .filter((it) => it.status !== "voided")
        .map((it) => {
          const addOns = addOnsByItem.get(it.id) ?? [];
          return {
            name: it.name_snapshot,
            quantity: it.quantity,
            lineTotal: linePriceBreakdown({
              unitPrice: Number(it.unit_price),
              modifierDeltas: addOns.map((addOn) => addOn.priceDelta),
              quantity: it.quantity,
            }).total,
            modifiersLabel: modifierNamesLabel(addOns) || null,
          };
        }),
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      tax: Number(order.tax),
      total: Number(order.total),
      tip: tipAmount,
      payments:
        payments.length > 0
          ? paymentsFromOrderRows()
          : receiptPayments,
    };
  }

  /** Reprint of an already-issued bill — no payment, no drawer kick. */
  function reprint() {
    const receipt = buildReceipt(
      Number(order?.tip_amount ?? 0),
      draftReceiptPayments(paymentDraft, paymentMethods, Number(order?.total ?? 0), money.unit),
    );
    if (!receipt) return;
    void printReceipt(null, receipt, { requestId: `reprint:${orderId}:${crypto.randomUUID()}`, entityId: orderId ?? undefined }).then((result) => {
      if (!result.ok) setError("ارسال رسید به چاپگر ناموفق بود.");
      else toast.success("رسید برای چاپ ارسال شد");
    });
  }

  /**
   * Checkout: records the payment (POST /api/orders/[id]/pay), then — best
   * effort, never blocking checkout success — asks the local print agent to
   * print the receipt and, for cash, kick the drawer. If no receipt printer
   * is configured or the agent isn't reachable, checkout still succeeds;
   * printing just silently doesn't happen (same principle as offline
   * queueing: the business transaction and the peripheral side-effect are
   * decoupled).
   */
  async function pay() {
    if (!order) return;
    const total = Number(order.total);
    if (draftRequiresCustomer(paymentDraft, paymentMethods, total) && !selectedCustomer) {
      return setError(errorMessage("customer_required"));
    }
    const built = paymentDraftBody(paymentDraft, paymentMethods, total, money.unit);
    if (!built.ok) return setError(errorMessage(built.error));
    let tipAmount = 0;
    if (tipInput.trim()) {
      try {
        tipAmount = money.parse(tipInput);
      } catch {
        return setError(errorMessage("invalid_tip_amount"));
      }
    }
    setPaying(true);
    setError("");
    const { ok, data } = await api<{
      error?: string;
      /** What the typed amount left on the customer's account (settle-with-difference). */
      balanceDue?: number;
      customerCredit?: number;
    }>(`/api/orders/${orderId}/pay`, {
      method: "POST",
      body: JSON.stringify({
        payments: built.value,
        customerId: selectedCustomer?.id,
        tipAmount,
      }),
    });
    setPaying(false);
    if (!ok) return setError(errorMessage(data.error));
    // The settle-with-difference outcomes are said out loud: they change the
    // customer's balance, and a silent success is how a debt goes unbilled.
    if (Number(data.balanceDue ?? 0) > 0) {
      toast.success(
        `پرداخت ثبت شد؛ ${money.format(Number(data.balanceDue))} به‌عنوان بدهی مشتری ثبت شد.`,
      );
    } else if (Number(data.customerCredit ?? 0) > 0) {
      toast.success(
        `پرداخت ثبت شد؛ ${money.format(Number(data.customerCredit))} به‌عنوان اعتبار مشتری ثبت شد.`,
      );
    } else {
      toast.success("پرداخت ثبت شد");
    }
    await load();
    onChanged?.();

    const receipt = buildReceipt(tipAmount, draftReceiptPayments(paymentDraft, paymentMethods, total, money.unit));
    if (receipt) {
      const receiptRequestId = `receipt:${orderId}`;
      void printReceipt(null, receipt, { requestId: receiptRequestId, entityId: orderId ?? undefined }).then((result) => {
        if (!result.ok && result.error !== "printer_not_configured") {
          toast.warning("چاپ رسید انجام نشد؛ پرداخت با موفقیت ثبت شده است.", {
            action: { label: "چاپ دوباره", onClick: () => void printReceipt(null, receipt, { requestId: `${receiptRequestId}:retry`, entityId: orderId ?? undefined }) },
          });
        }
        if (draftOpensDrawer(paymentDraft, paymentMethods) && result.supportsDrawer && result.printerId) {
          void kickDrawer(result.printerId);
        }
      });
    }
    setTipInput("");
  }

  const editable = canEdit && order?.status === "open";
  const activeItems = menu?.items.filter((i) => i.isActive) ?? [];
  const amendable = canAmendClosed && order?.status === "completed";
  const liveItems = items.filter((it) => it.status !== "voided");
  // Voided lines are the order's history — including the ones an add-on edit
  // superseded — so they are kept, but folded away from the bill being read.
  const voidedItems = items.filter((it) => it.status === "voided");
  const itemCount = liveItems.reduce((count, it) => count + it.quantity, 0);
  /** How much of the subtotal came from add-ons — the number a customer disputes most often. */
  const addOnTotal = liveItems.reduce(
    (sum, it) =>
      sum +
      (addOnsByItem.get(it.id) ?? []).reduce(
        (lineSum, addOn) => lineSum + addOn.priceDelta,
        0,
      ) *
        it.quantity,
    0,
  );
  const statusChip = order
    ? (STATUS_CHIP[order.status] ?? STATUS_CHIP.held)
    : null;

  /**
   * One line of the order. Live and superseded lines render identically —
   * only where they sit differs — so a voided line still shows the add-ons
   * and the price it carried, which is the point of keeping it.
   *
   * The grid is the responsive part: name and amount side by side on a phone
   * with the controls on their own row beneath, and a single table row from
   * `md` up, on the columns the header above it uses.
   */
  function renderLine(it: OrderItemRow) {
    const addOns = addOnsByItem.get(it.id) ?? [];
    const voided = it.status === "voided";
    const breakdown = linePriceBreakdown({
      unitPrice: Number(it.unit_price),
      modifierDeltas: addOns.map((addOn) => addOn.priceDelta),
      quantity: it.quantity,
    });
    const canPickAddOns =
      editable &&
      !voided &&
      Boolean(it.menu_item_id) &&
      attachedGroups(it.menu_item_id!).length > 0;

    return (
      <li
        key={it.id}
        className={`grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-3 border-b border-border px-4 py-3.5 last:border-b-0 md:items-center ${LINE_GRID}`}
      >
        <div className="col-start-1 row-start-1 min-w-0 md:row-start-1">
          <p
            className={`truncate text-sm font-semibold ${voided ? "text-muted-foreground line-through" : "text-foreground"}`}
          >
            {it.name_snapshot}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {money.format(breakdown.unit)} هر واحد
            {addOns.length > 0 ? (
              <span className="text-amber-700 dark:text-amber-300">
                {" "}
                — شامل{" "}
                {formatModifierDelta(breakdown.addOns, {
                  withUnit: false,
                  unit: money.unit,
                })}{" "}
                افزودنی
              </span>
            ) : null}
          </p>

          {addOns.length > 0 || canPickAddOns ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <ModifierBadges
                modifiers={addOns}
                tone="amber"
                showCaption={false}
              />
              {canPickAddOns ? (
                <button
                  type="button"
                  onClick={() => startEditAddOns(it)}
                  disabled={busy}
                  className={`inline-flex min-h-9 items-center gap-1 rounded-lg border border-dashed border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2.5 text-[11px] font-bold text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/15 ${FOCUS} disabled:opacity-55`}
                >
                  {addOns.length > 0 ? (
                    <>
                      <PencilIcon className="size-3" aria-hidden="true" />
                      ویرایش افزودنی‌ها
                    </>
                  ) : (
                    <>
                      <PlusIcon className="size-3" aria-hidden="true" />
                      افزودنی
                    </>
                  )}
                </button>
              ) : null}
            </div>
          ) : null}

          {it.note ? (
            <p className="mt-2 text-xs text-muted-foreground">یادداشت: {it.note}</p>
          ) : null}
          {voided && it.void_reason ? (
            <p className="mt-2 text-xs font-medium text-destructive">
              باطل: {it.void_reason}
            </p>
          ) : null}
        </div>

        <p
          className={`col-start-2 row-start-1 justify-self-end whitespace-nowrap text-sm font-bold tabular-nums md:col-start-3 md:justify-self-stretch md:text-end ${voided ? "text-muted-foreground line-through" : "text-foreground"}`}
        >
          {money.format(breakdown.total)}
        </p>

        <div className="col-start-1 row-start-2 flex items-center gap-1.5 md:col-start-2 md:row-start-1">
          {editable && !voided ? (
            <>
              <button
                type="button"
                aria-label="کاهش تعداد"
                onClick={() => setItemQty(it.id, it.quantity - 1)}
                disabled={busy || it.quantity <= 1}
                className={STEPPER_BUTTON}
              >
                <MinusIcon className="size-4" aria-hidden="true" />
              </button>
              <span className="w-7 text-center text-sm font-bold tabular-nums text-foreground">
                {toPersianDigits(it.quantity)}
              </span>
              <button
                type="button"
                aria-label="افزایش تعداد"
                onClick={() => setItemQty(it.id, it.quantity + 1)}
                disabled={busy}
                className={STEPPER_BUTTON}
              >
                <PlusIcon className="size-4" aria-hidden="true" />
              </button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              تعداد{" "}
              <span className="font-bold tabular-nums">
                {toPersianDigits(it.quantity)}
              </span>
            </span>
          )}
        </div>

        {editable && !voided ? (
          <button
            type="button"
            aria-label={`ابطال ${it.name_snapshot}`}
            title="ابطال قلم"
            onClick={() => voidItem(it.id)}
            disabled={busy}
            className={`${DANGER_BUTTON} col-start-2 row-start-2 size-11 justify-self-end px-0 md:col-start-4 md:row-start-1 md:justify-self-center`}
          >
            <Trash2Icon className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </li>
    );
  }

  const paidSum = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  const orderTip = Number(order?.tip_amount ?? 0);
  const remainingDue = order
    ? Math.max(0, Number(order.total) + orderTip - paidSum)
    : 0;

  return (
    <>
      {promptDialog}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[100dvh] max-h-[100dvh] w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none bg-muted p-0 ring-0 sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:rounded-2xl sm:ring-1 sm:ring-border/80"
        >
          <DialogHeader className="shrink-0 gap-0 border-b border-border/80 bg-card px-4 py-3 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="font-sans text-lg font-bold text-foreground sm:text-xl">
                    {order
                      ? toPersianDigits(
                          orderLabel(order),
                        )
                      : "جزئیات سفارش"}
                  </DialogTitle>
                  {statusChip ? (
                    <span
                      className={`inline-flex min-h-7 items-center rounded-full border px-2.5 text-xs font-medium ${statusChip.className}`}
                    >
                      {statusChip.label}
                    </span>
                  ) : null}
                  {/* Beside the order number rather than only down in the facts
                      list: on a phone the facts are a scroll away, and whose
                      bill this is belongs with what bill it is. */}
                  {order?.customer_name ? (
                    <span className="inline-flex min-h-7 max-w-full items-center gap-1 rounded-full border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2.5 text-xs font-bold text-amber-700 dark:text-amber-300">
                      <UserIcon className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate">{order.customer_name}</span>
                    </span>
                  ) : null}
                </div>
                <DialogDescription className="mt-1 text-xs text-muted-foreground">
                  {order ? (
                    <>
                      {TYPE_LABELS[order.type]}
                      {order.table_name ? ` · ${order.table_name}` : ""} · ثبت{" "}
                      {timeLabel(order.opened_at)}
                      {order.closed_at
                        ? ` · ${order.status === "voided" ? "ابطال" : "تسویه"} ${timeLabel(order.closed_at)}`
                        : ""}
                    </>
                  ) : (
                    orderLoaded ? "اطلاعات سفارش در دسترس نیست." : "در حال بارگذاری اطلاعات سفارش…"
                  )}
                </DialogDescription>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label="بستن"
                className={`flex size-11 shrink-0 items-center justify-center rounded-xl border border-border/80 bg-card text-muted-foreground transition-colors hover:bg-muted ${FOCUS} active:scale-[0.95]`}
              >
                <XIcon className="size-4" aria-hidden="true" />
              </button>
            </div>

            {/*
              The three tabs. صندوق is where 90% of visits start and end;
              اطلاعات and عملیات hold the rest without making the working
              tab scroll past them. Real tabs (role=tablist) so the structure
              is spoken, not just drawn.
            */}
            <div
              role="tablist"
              aria-label="بخش‌های جزئیات سفارش"
              className="mt-3 grid grid-cols-3 gap-1 rounded-xl bg-muted p-1"
            >
              {ORDER_TABS.map((entry) => {
                const selected = tab === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    onClick={() => setTab(entry.id)}
                    className={`min-h-11 rounded-lg px-2 text-xs font-bold transition-colors sm:text-sm ${
                      selected
                        ? "border border-amber-500/50 dark:border-amber-500/40 bg-card text-amber-700 dark:text-amber-300"
                        : "border border-transparent text-muted-foreground hover:bg-card/70"
                    } ${FOCUS}`}
                  >
                    {entry.label}
                  </button>
                );
              })}
            </div>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
            {!order ? (
              !orderLoaded ? (
                <div
                  className="mx-auto max-w-4xl space-y-3"
                  aria-busy="true"
                  aria-label="در حال بارگذاری جزئیات سفارش"
                >
                  <div className="ops-skeleton h-32 rounded-2xl" />
                  <div className="ops-skeleton h-40 rounded-2xl" />
                  <div className="ops-skeleton h-24 rounded-2xl" />
                </div>
              ) : (
                <div className="mx-auto max-w-4xl">
                  <div className="rounded-xl border border-destructive/20 bg-destructive/[0.035] px-4 py-6 text-center text-sm text-destructive">
                    <p>{error || "اطلاعات سفارش در دسترس نیست."}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setError("");
                        setOrderLoaded(false);
                        void load();
                      }}
                      className={`${SECONDARY_BUTTON} mt-3`}
                    >
                      تلاش دوباره
                    </button>
                  </div>
                </div>
              )
            ) : (
              <div className="mx-auto max-w-4xl">
                {error ? (
                  <div
                    className="mb-3 flex flex-col gap-2 rounded-xl border border-destructive/20 bg-destructive/[0.035] px-4 py-3 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between"
                    role="status"
                  >
                    <span>{error}</span>
                    <button
                      type="button"
                      onClick={() => setError("")}
                      className="min-h-11 shrink-0 rounded-lg border border-destructive/25 bg-card px-3 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/35"
                    >
                      باشد
                    </button>
                  </div>
                ) : null}
                {info ? (
                  <p
                    className="mb-3 rounded-xl border border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 px-4 py-3 text-sm leading-6 text-amber-800 dark:text-amber-300"
                    role="status"
                  >
                    {info}
                  </p>
                ) : null}
                {order.status === "voided" && order.voided_reason ? (
                  <p className="mb-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                    دلیل ابطال: {order.voided_reason}
                  </p>
                ) : null}

                {tab === "register" ? (
                  <>
                    <div className="space-y-3">
                      <section className={CARD} aria-label="اقلام سفارش">
                        <div className="flex items-center justify-between gap-3 border-b border-border/80 px-4 py-3">
                          <h3 className="font-semibold text-foreground">
                            اقلام سفارش
                          </h3>
                          <span className="text-xs text-muted-foreground">
                            {toPersianDigits(itemCount)} قلم
                          </span>
                        </div>

                        {liveItems.length === 0 ? (
                          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                            قلم فعالی برای این سفارش ثبت نشده است.
                          </p>
                        ) : (
                          <>
                            <div
                              className={`hidden border-b border-border/80 bg-muted px-4 py-2.5 text-xs font-medium text-muted-foreground ${LINE_GRID}`}
                              aria-hidden="true"
                            >
                              <span>قلم</span>
                              <span>تعداد</span>
                              <span className="text-end">مبلغ</span>
                              <span />
                            </div>
                            <ul>{liveItems.map(renderLine)}</ul>
                          </>
                        )}

                        {voidedItems.length > 0 ? (
                          <div className="border-t border-border/80">
                            <button
                              type="button"
                              onClick={() => setShowVoided((value) => !value)}
                              aria-expanded={showVoided}
                              className={`flex min-h-12 w-full items-center justify-between gap-2 px-4 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted ${FOCUS}`}
                            >
                              <span>
                                اقلام باطل‌شده (
                                {toPersianDigits(voidedItems.length)} مورد)
                              </span>
                              <span aria-hidden="true">
                                {showVoided ? "−" : "+"}
                              </span>
                            </button>
                            {showVoided ? (
                              <ul className="border-t border-border/80 bg-muted">
                                {voidedItems.map(renderLine)}
                              </ul>
                            ) : null}
                          </div>
                        ) : null}
                      </section>

                      {editable ? (
                        <section
                          className={`${CARD} p-4`}
                          aria-label="افزودن قلم"
                        >
                          <h3 className="mb-3 font-semibold text-foreground">
                            افزودن قلم
                          </h3>
                          {!menu ? (
                            <LoadingSkeleton rows={2} compact label="در حال بارگذاری منو" />
                          ) : (
                            <>
                              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <div className="min-w-0 flex-1">
                                  <SearchableSelect
                                    value={addItemId}
                                    onChange={setAddItemId}
                                    ariaLabel="انتخاب آیتم برای افزودن"
                                    className={OPS_INPUT}
                                    options={[
                                      { value: "", label: "آیتم…" },
                                      ...activeItems.map((i) => ({
                                        value: i.id,
                                        label: i.name,
                                      })),
                                    ]}
                                  />
                                </div>
                                <PersianNumberInput
                                  className={`${OPS_INPUT} sm:w-20`}
                                  dir="ltr"
                                  inputMode="numeric"
                                  aria-label="تعداد"
                                  value={addQty}
                                  onChange={(event) => setAddQty(event.target.value)}
                                />
                                <button
                                  type="button"
                                  onClick={startAddItem}
                                  disabled={busy || !addItemId}
                                  className={`${PRIMARY_BUTTON} sm:w-auto sm:min-w-28`}
                                >
                                  <PlusIcon className="size-4" aria-hidden="true" />
                                  افزودن
                                </button>
                              </div>
                              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                                آیتم‌هایی که گروه افزودنی دارند، پیش از ثبت پنجرهٔ
                                انتخاب افزودنی را باز می‌کنند.
                              </p>
                            </>
                          )}
                        </section>
                      ) : null}
                    </div>

                      <section className={`${CARD} mt-3 p-4`} aria-label="مبلغ و تخفیف سفارش">
                        {editable ? (
                          <div className="mb-4 border-b border-border/80 pb-4">
                            <h3 className="mb-2 font-semibold text-foreground">
                              تخفیف
                            </h3>
                            <div className="flex flex-col gap-2">
                              <div className="flex gap-2">
                                <div className="min-w-0 flex-1">
                                  <SearchableSelect
                                    value={discountType}
                                    onChange={(value) =>
                                      setDiscountType(
                                        value as "" | "percent" | "amount",
                                      )
                                    }
                                    ariaLabel="نوع تخفیف"
                                    className={OPS_INPUT}
                                    options={[
                                      { value: "", label: "بدون تخفیف" },
                                      { value: "percent", label: "درصدی" },
                                      { value: "amount", label: "مبلغ ثابت" },
                                    ]}
                                  />
                                </div>
                                {discountType ? (
                                  <PersianNumberInput
                                    className={`${OPS_INPUT} w-24`}
                                    dir="ltr"
                                    inputMode={discountType === "percent" ? "decimal" : "numeric"}
                                    aria-label="مقدار تخفیف"
                                    value={discountValue}
                                    onChange={(event) =>
                                      setDiscountValue(event.target.value)
                                    }
                                    placeholder={
                                      discountType === "percent" ? "٪" : money.unitLabel
                                    }
                                  />
                                ) : null}
                              </div>
                              <button
                                type="button"
                                onClick={saveDiscount}
                                disabled={busy}
                                className={`${SECONDARY_BUTTON} min-h-12 w-full`}
                              >
                                اعمال تخفیف
                              </button>
                            </div>
                          </div>
                        ) : null}

                        <dl className="space-y-2">
                          <Row
                            label="جمع جزء"
                            value={money.format(Number(order.subtotal))}
                          />
                          {addOnTotal !== 0 ? (
                            <Row
                              label="از این مبلغ، افزودنی‌ها"
                              value={formatModifierDelta(addOnTotal, { unit: money.unit })}
                              accent
                            />
                          ) : null}
                          {Number(order.discount) > 0 ? (
                            <Row
                              label="تخفیف"
                              value={`- ${money.format(Number(order.discount))}`}
                            />
                          ) : null}
                          {Number(order.service_charge ?? 0) > 0 ? (
                            <Row
                              label="هزینهٔ ارسال"
                              value={money.format(Number(order.service_charge))}
                            />
                          ) : null}
                          {Number(order.tax) > 0 ? (
                            <Row
                              label="مالیات"
                              value={money.format(Number(order.tax))}
                            />
                          ) : null}
                          <div className="mt-1 flex items-center justify-between gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2.5">
                            <dt className="text-sm font-bold text-foreground">
                              جمع کل
                            </dt>
                            <dd className="text-base font-bold tabular-nums text-amber-700 dark:text-amber-300">
                              {money.format(Number(order.total))}
                            </dd>
                          </div>
                        </dl>
                      </section>

                    {canTakePayment && order.status === "open" ? (
                      <section
                        className={`${CARD} mt-3 p-4`}
                        aria-label="دریافت وجه و تکمیل سفارش"
                      >
                        <h3 className="mb-3 font-semibold text-foreground">
                          دریافت وجه و تکمیل سفارش
                        </h3>

                        {/*
                          The customer sits with the payment because that is
                          where they matter: a difference (نسیه، بدهی، اعتبار)
                          is booked against a person, and the picker also
                          quick-creates one from a name and a mobile number.
                          Picking is saving — the order is patched immediately.
                        */}
                        <div className="mb-3">
                          <CustomerPicker
                            customer={selectedCustomer}
                            onChange={(customer) => void saveOrderCustomer(customer)}
                            disabled={busy}
                            idPrefix="order-customer"
                            requestOpen={customerPickerRequests}
                          />
                          <CustomerBalanceBadge customer={selectedCustomer} />
                        </div>

                        <div className="mb-3">
                          <PaymentWays
                            methods={paymentMethods}
                            loaded={paymentMethodsLoaded}
                            loadError={paymentMethodsError}
                            onReload={reloadPaymentMethods}
                            draft={paymentDraft}
                            onChange={setPaymentDraft}
                            due={Number(order.total)}
                            disabled={paying}
                            idPrefix="order"
                            customer={selectedCustomer}
                            onChooseCustomer={() =>
                              setCustomerPickerRequests((count) => count + 1)
                            }
                          />
                        </div>

                        <label className="mb-3 block">
                          <span className="mb-1.5 block text-xs font-semibold text-muted-foreground">
                            انعام{" "}
                            <span className="font-normal text-muted-foreground">
                              (اختیاری، {money.unitLabel})
                            </span>
                          </span>
                          <PersianNumberInput
                            className={OPS_INPUT}
                            dir="ltr"
                            inputMode="numeric"
                            value={tipInput}
                            onChange={(event) =>
                              setTipInput(event.target.value)
                            }
                            placeholder="۰"
                          />
                        </label>

                        <HoldToConfirmButton
                          durationMs={4000}
                          label={`ثبت پرداخت ${money.format(Number(order.total))}`}
                          holdingLabel="نگه دارید…"
                          busy={paying}
                          disabled={
                            !paymentMethodsLoaded ||
                            Boolean(paymentMethodsError) ||
                            paymentMethods.length === 0 ||
                            (draftRequiresCustomer(paymentDraft, paymentMethods, Number(order.total)) &&
                              !selectedCustomer)
                          }
                          onComplete={() => void pay()}
                        />
                      </section>
                    ) : null}
                  </>
                ) : null}

                {tab === "info" ? (
                  <div className="space-y-3">
                    <section
                      className={`${CARD} p-4`}
                      aria-label="مشخصات سفارش"
                    >
                      <h3 className="mb-3 font-semibold text-foreground">
                        مشخصات سفارش
                      </h3>
                      {/* Flex rather than a 2-column grid: the number of facts
                          varies by order, and an odd one out should fill the
                          row instead of leaving a hole beside it. */}
                      <dl className="flex flex-wrap gap-2">
                        <Fact
                          label="نوع سفارش"
                          value={TYPE_LABELS[order.type]}
                        />
                        {order.table_name ? (
                          <Fact label="میز" value={order.table_name} />
                        ) : null}
                        {order.customer_name ? (
                          <Fact
                            label="مشتری"
                            value={
                              order.customer_phone
                                ? `${order.customer_name} · ${toPersianDigits(order.customer_phone)}`
                                : order.customer_name
                            }
                          />
                        ) : null}
                        {order.guest_count ? (
                          <Fact
                            label="تعداد مهمان"
                            value={toPersianDigits(order.guest_count)}
                          />
                        ) : null}
                        <Fact
                          label="زمان ثبت"
                          value={timeLabel(order.opened_at)}
                        />
                        {order.closed_at ? (
                          <Fact
                            label={
                              order.status === "voided"
                                ? "زمان ابطال"
                                : "زمان تسویه"
                            }
                            value={timeLabel(order.closed_at)}
                          />
                        ) : null}
                        {Number(order.tip_amount ?? 0) > 0 ? (
                          <Fact
                            label="انعام"
                            value={money.format(Number(order.tip_amount))}
                          />
                        ) : null}
                      </dl>
                      {order.customer_id ? (
                        <a
                          href={crmCustomerHref(order.customer_id)}
                          className="mt-3 inline-block text-xs font-semibold text-teal-700 dark:text-teal-300 underline-offset-4 hover:underline"
                        >
                          پروندهٔ مشتری در CRM
                        </a>
                      ) : null}
                    </section>

                    <section
                      className={`${CARD} p-4`}
                      aria-label="یادداشت سفارش"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="font-semibold text-foreground">
                          یادداشت سفارش
                        </h3>
                        {editable && !editingNote ? (
                          <button
                            type="button"
                            onClick={() => setEditingNote(true)}
                            className={SECONDARY_BUTTON}
                          >
                            <PencilIcon className="size-4" aria-hidden="true" />
                            {order.note ? "ویرایش" : "افزودن"}
                          </button>
                        ) : null}
                      </div>
                      {editingNote ? (
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                          <input
                            className={OPS_INPUT}
                            value={noteDraft}
                            onChange={(event) =>
                              setNoteDraft(event.target.value)
                            }
                            placeholder="مثلاً: مهمان عجله دارد"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={saveNote}
                              disabled={busy}
                              className={`${PRIMARY_BUTTON} sm:w-auto sm:min-w-24`}
                            >
                              ذخیره
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setNoteDraft(order.note ?? "");
                                setEditingNote(false);
                              }}
                              disabled={busy}
                              className={`${SECONDARY_BUTTON} min-h-12`}
                            >
                              انصراف
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="mt-2 text-sm leading-6 text-muted-foreground">
                          {order.note || "یادداشتی ثبت نشده است."}
                        </p>
                      )}
                    </section>

                    {payments.length > 0 ? (
                      <section
                        className={`${CARD} p-4`}
                        aria-label="پرداخت‌های ثبت‌شده"
                      >
                        <h3 className="mb-3 font-semibold text-foreground">
                          پرداخت‌های ثبت‌شده
                        </h3>
                        <ul className="space-y-2">
                          {payments.map((payment) => (
                            <li
                              key={payment.id}
                              className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2.5 text-sm"
                            >
                              <span className="min-w-0 truncate text-foreground">
                                {payment.payment_method_name ?? PAYMENT_LABELS[payment.method] ?? payment.method}
                              </span>
                              <span className="shrink-0 font-bold tabular-nums text-foreground">
                                {money.format(Number(payment.amount))}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                  </div>
                ) : null}

                {tab === "ops" ? (
                  <div className="space-y-3">
                    <section className={`${CARD} p-4`} aria-label="عملیات سفارش">
                      <h3 className="mb-3 font-semibold text-foreground">
                        عملیات
                      </h3>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <button
                          type="button"
                          onClick={reprint}
                          className={`${SECONDARY_BUTTON} min-h-12`}
                        >
                          <PrinterIcon className="size-4" aria-hidden="true" />
                          {order.status === "open" ? "چاپ رسید" : "چاپ مجدد رسید"}
                        </button>
                        {editable ? (
                          <button
                            type="button"
                            onClick={voidOrder}
                            disabled={busy}
                            className={`${DANGER_BUTTON} min-h-12`}
                          >
                            <Trash2Icon className="size-4" aria-hidden="true" />
                            ابطال سفارش
                          </button>
                        ) : null}
                      </div>
                    </section>

                    {editable && order.type === "dine_in" ? (
                      <section className={`${CARD} p-4`} aria-label="تعیین میز">
                        <h3 className="mb-2 font-semibold text-foreground">تعیین میز</h3>
                        {/*
                          A seated table is offered too: moving a bill onto a
                          table that already has guests is how friends sitting
                          together keep separate invoices. Only a table being
                          cleaned or out of service is left out — PATCH refuses
                          those, so offering them would only produce an error.
                        */}
                        {!tablesLoaded ? (
                          <LoadingSkeleton rows={1} compact label="در حال بارگذاری میزها" />
                        ) : (
                          <SearchableSelect
                            value={selectedTableId}
                            onChange={(value) => void saveOrderTable(value)}
                            ariaLabel="تعیین میز سفارش"
                            className={OPS_INPUT}
                            options={[
                              { value: "", label: "بدون میز" },
                              ...tables
                                .filter(
                                  (table) =>
                                    !isTableUnavailable(table.status) ||
                                    table.id === selectedTableId,
                                )
                                .map((table) => ({
                                  value: table.id,
                                  label: isTableOccupied(table.status)
                                    ? `${table.name} — مهمان دارد`
                                    : table.name,
                                })),
                            ]}
                          />
                        )}
                      </section>
                    ) : null}

                    {/*
                      A friend joining a table that is already busy gets their
                      own bill, not extra lines on this one. Their order is rung
                      at the till like any other — `createOrder` cannot make an
                      empty order to add items to later — so this hands the POS
                      the table and lets it do the rest; the table's one session
                      ties the two bills to the same visit.
                    */}
                    {editable && order.type === "dine_in" && order.table_id ? (
                      <section className={`${CARD} p-4`} aria-label="مهمان جدید روی این میز">
                        <h3 className="mb-2 font-semibold text-foreground">مهمان جدید روی این میز</h3>
                        <p className="mb-3 text-xs leading-5 text-muted-foreground">
                          برای مهمانی که تازه به {order.table_name ?? "این میز"} اضافه شده، سفارش جداگانه ثبت کنید؛ صورت‌حساب و تسویهٔ آن کاملاً مستقل از این سفارش است.
                        </p>
                        <Link
                          href={`/accounting/pos?table=${encodeURIComponent(order.table_id)}`}
                          className={`${SECONDARY_BUTTON} flex min-h-12 w-full items-center justify-center`}
                        >
                          سفارش جدا برای مهمان جدید
                        </Link>
                      </section>
                    ) : null}

                    {amendable && orderId ? (
                      <ClosedOrderAmendment
                        orderId={orderId}
                        items={items.map((it) => ({
                          id: it.id,
                          name: it.name_snapshot,
                          quantity: it.quantity,
                          status: it.status,
                        }))}
                        menuItems={activeItems.map((item) => ({
                          id: item.id,
                          name: item.name,
                        }))}
                        discountType={order.discount_type}
                        discountValue={
                          order.discount_value === null
                            ? null
                            : Number(order.discount_value)
                        }
                        onDone={() => {
                          void load();
                          onChanged?.();
                        }}
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/*
            Pinned, so scrolling a long bill never takes the amount being
            collected off-screen. One figure only: the order total, with the
            compact item count beside it — «جمع کل · ۲ قلم — ۳۰۰٬۰۰۰ تومان».

            The باقی‌مانده badge that used to sit here is gone on purpose. A
            persistent footer is the wrong place for a figure that only means
            anything mid-checkout: it competed with the total on every width,
            and on a phone it pushed the total itself to the edge. The
            remaining balance is still computed and still shown — inside the
            صندوق (payment) section, next to the amount being entered, which
            is the only moment it is actionable.
          */}
          {order ? (
            <div
              className="flex shrink-0 items-center justify-between gap-3 border-t border-border/80 bg-card px-4 py-3 sm:px-5"
              style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
            >
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-foreground">جمع کل</span>
                <span className="text-xs text-muted-foreground">
                  {toPersianDigits(itemCount)} قلم
                </span>
              </div>
              <span className="text-base font-bold tabular-nums text-amber-700 dark:text-amber-300">
                {money.format(Number(order.total))}
              </span>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      {picker ? (
        <ModifierPicker
          itemName={picker.menuItem.name}
          itemPrice={Number(picker.menuItem.price)}
          quantity={
            picker.mode === "add" ? picker.quantity : picker.item.quantity
          }
          groups={attachedGroups(picker.menuItem.id)}
          tone="amber"
          menuItemId={picker.menuItem.id}
          initialModifiers={
            picker.mode === "edit"
              ? picker.modifiers.map((modifier) => ({
                  id: modifier.id,
                  quantity: modifierQuantity(modifier),
                }))
              : undefined
          }
          initialNote={picker.mode === "edit" ? picker.note : ""}
          confirmLabel={
            picker.mode === "edit" ? "ذخیرهٔ افزودنی‌ها" : undefined
          }
          onCancel={() => setPicker(null)}
          onConfirm={(picks, note) => {
            if (picker.mode === "add") {
              void addItem(picker.menuItem.id, picks, note);
            } else {
              void saveAddOns(picker.item.id, picks, note);
            }
            setPicker(null);
          }}
        />
      ) : null}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 basis-[calc(50%-0.25rem)] rounded-xl border border-border bg-muted p-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-bold text-foreground">
        {value}
      </dd>
    </div>
  );
}

function Row({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`tabular-nums ${accent ? "font-semibold text-amber-700 dark:text-amber-300" : "text-muted-foreground"}`}
      >
        {value}
      </dd>
    </div>
  );
}
