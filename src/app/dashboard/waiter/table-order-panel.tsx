"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  ORDER_ITEM_STATUS_LABELS,
  type OrderItemStatus,
} from "@/lib/order-item-status";
import { printKitchenTicket } from "@/lib/printing/client";
import type { DisplayModifier } from "@/lib/modifier-display";
import { MAX_ORDER_LINE_QUANTITY } from "@/lib/order-quantity";
import {
  buildRestaurantMenuIndex,
  toRestaurantMenu,
  type MenuTreePayload,
  type RestaurantGroupView,
  type RestaurantMenuItem,
  type RestaurantMenuData,
} from "@/lib/restaurant-menu";
import { searchPosMenuItems, warmPosItemSearchCache } from "@/lib/pos-selection";
import { ModifierBadges } from "../modifier-badges";
import { ModifierPicker } from "../modifier-picker";
import { MenuItemImage } from "../menu-item-image";
import { apiOrQueue } from "../offline-queue";
import { useRealtime } from "../use-realtime";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { cardClass } from "../page-chrome";
import { safeRandomId } from "@/lib/client-id";
import { SearchIcon } from "lucide-react";

interface OrderItem {
  id: string;
  name_snapshot: string;
  quantity: number;
  status: OrderItemStatus;
  note: string | null;
}
interface OrderModifier {
  order_item_id: string;
  name_snapshot: string;
  price_delta: string | number;
}

interface CartUiLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  /** Add-on picks with quantities, sorted by id — the line's configuration. */
  modifierPicks: { id: string; quantity: number }[];
  modifiers: DisplayModifier[];
  note: string;
}

interface WaiterTable {
  id: string;
  name: string;
  status: string;
  session_id: string | null;
  guest_name: string | null;
  order_id: string | null;
}

const STATUS_BADGE: Record<OrderItemStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  sent: "bg-muted text-muted-foreground",
  preparing: "bg-primary/10 text-primary",
  ready:
    "bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200",
  served: "bg-muted text-muted-foreground",
  voided: "bg-destructive/10 text-destructive",
};

export function TableOrderPanel({
  table,
  onBack,
  onChanged,
}: {
  table: WaiterTable;
  onBack: () => void;
  onChanged: () => void;
}) {
  const money = useMoney();
  const [menu, setMenu] = useState<RestaurantMenuData | null>(null);
  const [activeCategory, setActiveCategory] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [orderModifiers, setOrderModifiers] = useState<OrderModifier[]>([]);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [pickerItem, setPickerItem] = useState<RestaurantMenuItem | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  // Minted once for the first "send to kitchen" attempt that opens a new
  // order for this table, and reused across a manual resubmit after a failed
  // attempt (a lost response, a proxy retry) so the server's idempotency
  // check on POST /api/orders sees one id — cleared once an order actually
  // exists, since every send after that goes through the add-items branch
  // below instead.
  const clientRequestIdRef = useRef<string | null>(null);

  useEffect(() => {
    api<MenuTreePayload>("/api/menu").then(({ ok, data }) => {
      if (!ok) return;
      const restaurantMenu = toRestaurantMenu(data);
      setMenu(restaurantMenu);
      setActiveCategory(
        restaurantMenu.categories.find((c) => c.isActive)?.id ?? "",
      );
    });
  }, []);

  const loadOrder = useCallback(() => {
    if (!table.order_id) {
      setOrderItems([]);
      setOrderModifiers([]);
      return;
    }
    api<{ items: OrderItem[]; modifiers: OrderModifier[] }>(
      `/api/orders/${table.order_id}`,
    ).then(({ ok, data }) => {
      if (ok) {
        setOrderItems(data.items);
        setOrderModifiers(data.modifiers);
      }
    });
  }, [table.order_id]);
  useEffect(loadOrder, [loadOrder]);

  useRealtime(
    useCallback(
      (event) => {
        if (event.type === "order.updated" && event.orderId === table.order_id)
          loadOrder();
        if (
          event.type === "order.item_status" &&
          event.orderId === table.order_id
        )
          loadOrder();
        if (event.type === "order.created") {
          loadOrder();
          onChanged();
        }
      },
      [loadOrder, onChanged, table.order_id],
    ),
  );

  const modsByItem = useMemo(() => {
    const map = new Map<string, DisplayModifier[]>();
    for (const m of orderModifiers) {
      if (!map.has(m.order_item_id)) map.set(m.order_item_id, []);
      map.get(m.order_item_id)!.push({
        name: m.name_snapshot,
        priceDelta: Number(m.price_delta),
      });
    }
    return map;
  }, [orderModifiers]);

  /**
   * The waiter sells from the *same* shared menu index as the cashier: the
   * same categories, the same item ordering, the same per-item bounds, the
   * same inactive-group/inactive-modifier filtering. Only the layout and
   * the workflow differ — shared domain behaviour, separate shells.
   */
  const menuIndex = useMemo(
    () => (menu ? buildRestaurantMenuIndex(menu) : null),
    [menu],
  );
  const activeCategories = menuIndex?.activeCategories ?? [];

  const searchableItems = useMemo(
    () =>
      menu?.items.filter(
        (item): item is RestaurantMenuItem & { categoryId: string } =>
          item.isActive && item.categoryId !== null,
      ) ?? [],
    [menu],
  );
  useEffect(() => {
    warmPosItemSearchCache(searchableItems);
  }, [searchableItems]);

  /** The menu grid: the selected category, or a name/SKU search across all of them. */
  const visibleItems = useMemo(() => {
    if (!menu) return [];
    if (!searchQuery.trim()) {
      return menuIndex?.itemsByCategory.get(activeCategory) ?? [];
    }
    return searchPosMenuItems({
      categories: menu.categories,
      items: searchableItems,
      selectedCategoryId: activeCategory,
      query: searchQuery,
    });
  }, [menu, menuIndex, activeCategory, searchQuery, searchableItems]);

  const attachedGroups = useCallback(
    (itemId: string): RestaurantGroupView[] =>
      menuIndex?.groupsByItem.get(itemId) ?? [],
    [menuIndex],
  );

  function addToCart(
    item: RestaurantMenuItem,
    picks: { id: string; quantity: number }[],
    note: string,
  ) {
    const allModifiers = new Map(
      (menu?.modifiers ?? []).map((m) => [m.id, m]),
    );
    const sortedPicks = [...picks]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((pick) => ({ ...pick, quantity: Math.max(1, Math.round(pick.quantity)) }));
    const modifiers: DisplayModifier[] = sortedPicks.map((pick) => {
      const modifier = allModifiers.get(pick.id)!;
      return {
        name: modifier.name,
        priceDelta: modifier.priceDelta,
        quantity: pick.quantity,
      };
    });
    setCart((prev) => [
      ...prev,
      {
        key: `${item.id}-${safeRandomId()}`,
        menuItemId: item.id,
        name: item.name,
        unitPrice: item.price,
        quantity: 1,
        modifierPicks: sortedPicks,
        modifiers,
        note,
      },
    ]);
  }

  function pickItem(item: RestaurantMenuItem) {
    const groups = attachedGroups(item.id);
    if (groups.length === 0) addToCart(item, [], "");
    else setPickerItem(item);
  }

  function setQty(key: string, quantity: number) {
    setCart((prev) =>
      quantity <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) =>
            l.key === key
              ? { ...l, quantity: Math.min(quantity, MAX_ORDER_LINE_QUANTITY) }
              : l,
          ),
    );
  }

  async function sendToKitchen() {
    setError("");
    setInfo("");
    if (cart.length === 0) return;
    setBusy(true);
    const items = cart.map((l) => ({
      menuItemId: l.menuItemId,
      quantity: l.quantity,
      modifiers: l.modifierPicks,
      note: l.note || undefined,
    }));
    if (!table.order_id && !clientRequestIdRef.current) {
      clientRequestIdRef.current = safeRandomId();
    }
    const createBody = {
      type: "dine_in" as const,
      tableId: table.id,
      items,
      clientRequestId: clientRequestIdRef.current,
    };
    const res = table.order_id
      ? await apiOrQueue(
          `/api/orders/${table.order_id}/items`,
          { method: "POST", body: { items } },
          {
            type: "order.add_items",
            payload: { orderId: table.order_id, items },
            description: `افزودن قلم — ${table.name}`,
          },
        )
      : await apiOrQueue(
          "/api/orders",
          { method: "POST", body: createBody },
          {
            type: "order.create",
            payload: createBody,
            description: `سفارش حضوری — ${table.name}`,
          },
        );
    setBusy(false);
    if (!res.ok)
      return setError(errorMessage((res.data as { error?: string }).error));

    // Once queued or created, this attempt is settled one way or another —
    // the offline queue's own clientEventId owns retrying a queued one from
    // here, so the next "send to kitchen" is a new attempt and needs a fresh id.
    clientRequestIdRef.current = null;
    // The ticket is the server's document: it loads the order the items were
    // just written to (the same rows this panel is showing) and prints what is
    // on it. `table.order_id` is the pair of this table, created on demand.
    const ticketOrderId = table.order_id;
    if (ticketOrderId) {
      const kitchenRequestId = `kitchen:${ticketOrderId}:${crypto.randomUUID()}`;
      const issue = (requestId: string) => printKitchenTicket(null, ticketOrderId, { requestId });
      void issue(kitchenRequestId).then((result) => {
        if (!result.ok && result.error !== "printer_not_configured") {
          toast.warning("سفارش ثبت شد اما ارسال به چاپگر آشپزخانه ناموفق بود.", {
            duration: Infinity,
            action: { label: "تلاش دوباره", onClick: () => void issue(`${kitchenRequestId}:retry`) },
          });
        }
      });
    }
    if (res.queued) {
      setInfo(
        "اتصال قطع است — این ارسال ذخیره شد و پس از اتصال مجدد به آشپزخانه ارسال می‌شود.",
      );
    } else {
      toast.success("سفارش به آشپزخانه ارسال شد");
      onChanged();
      loadOrder();
    }
    setCart([]);
  }

  async function markServed(itemId: string) {
    const res = await apiOrQueue(
      `/api/kitchen/items/${itemId}`,
      { method: "PATCH", body: { status: "served" } },
      {
        type: "order_item.status",
        payload: { itemId, status: "served" },
        description: "تحویل قلم",
      },
    );
    if (res.ok && !res.queued) loadOrder();
  }

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <SecondaryButton onClick={onBack}>بازگشت</SecondaryButton>
        <h2 className="text-lg font-bold">{table.name}</h2>
        {table.guest_name ? (
          <span className="text-sm text-muted-foreground">
            {table.guest_name}
          </span>
        ) : null}
      </div>

      {!table.session_id ? (
        <p className="text-sm text-muted-foreground">
          این میز آزاد است. برای نشاندن مهمان از پلان سالن استفاده کنید.
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="w-full lg:w-64">
            <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
              سفارش فعلی
            </h3>
            {orderItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                هنوز آیتمی ثبت نشده.
              </p>
            ) : (
              <ul className="space-y-2">
                {orderItems.map((it) => (
                  <li key={it.id} className="rounded-xl border border-border/80 shadow-[0_1px_2px_rgb(41_37_36/0.035)] bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {toPersianDigits(it.quantity)}× {it.name_snapshot}
                        </p>
                        <ModifierBadges
                          modifiers={modsByItem.get(it.id) ?? []}
                          tone="brand"
                          className="mt-1.5"
                        />
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_BADGE[it.status]}`}
                      >
                        {ORDER_ITEM_STATUS_LABELS[it.status]}
                      </span>
                    </div>
                    {it.status === "ready" ? (
                      <button
                        type="button"
                        onClick={() => markServed(it.id)}
                        className="mt-2 w-full rounded-lg bg-emerald-700 dark:bg-emerald-300 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-emerald-800 dark:hover:bg-emerald-200"
                      >
                        تحویل داده شد
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className={`flex-1 ${cardClass} p-4`}>
            <ErrorBox>{error}</ErrorBox>
            {info ? <InfoBox>{info}</InfoBox> : null}
            {!menu ? (
              <LoadingSkeleton rows={5} label="در حال بارگذاری منو" />
            ) : (
              <>
                <div className="mb-3 flex gap-1 overflow-x-auto border-b border-border pb-3">
                  {activeCategories.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setActiveCategory(c.id);
                        setSearchQuery("");
                      }}
                      className={`shrink-0 rounded-lg px-4 py-2 text-sm ${
                        activeCategory === c.id
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-muted-foreground transition-colors hover:bg-muted-foreground/20 hover:text-foreground"
                      }`}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
                <div className="relative mb-4">
                  <SearchIcon
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                  />
                  <input
                    className={`${inputClass} ps-9`}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="جستجوی نام یا کد کالا…"
                    aria-label="جستجوی آیتم منو"
                    type="search"
                  />
                </div>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {visibleItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => pickItem(item)}
                      className="flex min-h-28 flex-col overflow-hidden rounded-xl border border-border bg-card text-start transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 active:scale-[0.99]"
                    >
                      {/*
                        Photo band only for items that have one — a photo-less
                        item renders the compact card it always was instead of
                        a gray placeholder strip; an unreachable photo keeps
                        the band (MenuItemImage's own placeholder) so the grid
                        never reflows.
                      */}
                      {item.imageMediaId || item.imageUrl ? (
                        <span className="block h-16 w-full overflow-hidden rounded-t-xl">
                          <MenuItemImage
                            mediaId={item.imageMediaId}
                            url={item.imageUrl}
                            className="size-full"
                            iconClassName="size-5"
                          />
                        </span>
                      ) : null}
                      <span className="flex flex-1 flex-col p-3">
                        <span className="text-sm font-medium">{item.name}</span>
                        <span className="mt-auto pt-1 text-xs text-muted-foreground">
                          {money.format(item.price)}
                        </span>
                      </span>
                    </button>
                  ))}
                  {visibleItems.length === 0 ? (
                    <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                      آیتمی پیدا نشد.
                    </p>
                  ) : null}
                </div>

                {cart.length > 0 ? (
                  <div className="border-t border-border pt-3 min-h-0 overflow-y-auto">
                    <ul className="mb-3 space-y-2">
                      {cart.map((l) => (
                        <li
                          key={l.key}
                          className="flex items-start justify-between gap-3 text-sm"
                        >
                          <span className="min-w-0">
                            <span className="block font-medium">{l.name}</span>
                            <ModifierBadges
                              modifiers={l.modifiers}
                              tone="brand"
                              showCaption={false}
                              className="mt-1"
                            />
                          </span>
                          <span className="flex items-center gap-2">
                            <button
                              type="button"
                              aria-label={"کاهش تعداد " + l.name}
                              onClick={() => setQty(l.key, l.quantity - 1)}
                              className="flex size-6 items-center justify-center rounded bg-muted transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95 focus-visible:ring focus-visible:ring-ring/50 outline-none"
                            >
                              −
                            </button>
                            <span className="w-4 text-center">
                              {toPersianDigits(l.quantity)}
                            </span>
                            <button
                              type="button"
                              aria-label={"افزایش تعداد " + l.name}
                              disabled={l.quantity >= MAX_ORDER_LINE_QUANTITY}
                              title={
                                l.quantity >= MAX_ORDER_LINE_QUANTITY
                                  ? `حداکثر تعداد هر ردیف ${MAX_ORDER_LINE_QUANTITY} است`
                                  : undefined
                              }
                              onClick={() => setQty(l.key, l.quantity + 1)}
                              className="flex size-6 items-center justify-center rounded bg-muted transition-colors hover:bg-muted-foreground/20 hover:text-foreground active:scale-95 focus-visible:ring focus-visible:ring-ring/50 outline-none disabled:opacity-40"
                            >
                              +
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                    <PrimaryButton
                      type="button"
                      onClick={sendToKitchen}
                      disabled={busy}
                    >
                      {busy ? "در حال ارسال…" : "ارسال به آشپزخانه"}
                    </PrimaryButton>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      )}

      {pickerItem ? (
        <ModifierPicker
          itemName={pickerItem.name}
          itemPrice={pickerItem.price}
          menuItemId={pickerItem.id}
          groups={attachedGroups(pickerItem.id)}
          onCancel={() => setPickerItem(null)}
          onConfirm={(picks, note) => {
            addToCart(pickerItem, picks, note);
            setPickerItem(null);
          }}
        />
      ) : null}
    </div>
  );
}
