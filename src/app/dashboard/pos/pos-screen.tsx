"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useDeferredValue,
} from "react";
import { toast } from "sonner";
import {
  CheckIcon,
  MinusIcon,
  PlusIcon,
  ReceiptTextIcon,
  RefreshCwIcon,
  SearchIcon,
  ShoppingBagIcon,
  SlidersHorizontalIcon,
  WifiIcon,
  WifiOffIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { toPersianDigits } from "@/lib/digits";
import type { KitchenTicketData } from "@/lib/kitchen-ticket-template";
import type { ReceiptData } from "@/lib/receipt-template";
import { useMoney } from "@/components/money/money-context";
import {
  draftOpensDrawer,
  draftReceiptPayments,
  draftRequiresCustomer,
  emptyPaymentDraft,
  methodOf,
  paymentDraftBody,
  type PaymentDraft,
  type PaymentDraftBody,
} from "@/lib/payment-draft";
import { PaymentWays, usePaymentMethods } from "../payment-ways";
import {
  computeOrderTotals,
  formatQueueLabel,
  type CartLine,
  type DiscountInput,
} from "@/lib/orders";
import {
  kickDrawer,
  printKitchenTicket,
  printReceipt,
} from "@/lib/printing/client";
import {
  cartQuantitiesByItem,
  isGlobalCashierShortcutEligible,
  isTableOccupied,
  missingCheckoutRequirement,
  requiresTableSelection,
  searchPosMenuItems,
  warmPosItemSearchCache,
  type PosCheckoutRequirement,
  type PosTable,
} from "@/lib/pos-selection";
import {
  buildRestaurantMenuIndex,
  toRestaurantMenu,
  type MenuTreePayload,
  type RestaurantGroupView,
  type RestaurantMenuItem,
  type RestaurantMenuData,
} from "@/lib/restaurant-menu";
import { MenuItemImage } from "../menu-item-image";
import {
  formatModifierDelta,
  linePriceBreakdown,
  modifierDeltasOf,
  modifierNamesLabel,
  sumModifierDeltas,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { ModifierPicker } from "../modifier-picker";
import { CustomerBalanceBadge, CustomerPicker, type PickerCustomer } from "../customer-picker";
import { HoldToConfirmButton } from "../hold-to-confirm-button";
import { CartLineCard } from "./cart-line-card";
import {
  addOrMergeLine,
  addPlainUnit,
  countLinesForItem,
  decideTilePlus,
  stepLastLineForItem,
  stepLineQuantity,
  upsertLine,
  type PosCartModifierPick,
} from "@/lib/pos-cart";
import { TablePickerDialog } from "./table-picker-dialog";
import {
  SearchableSelect,
  type SelectOption,
} from "@/components/ui/searchable-select";
import { BranchSwitcher } from "../branch-switcher";
import { FilterChip } from "../filters";
import { KnowledgeHelpButton } from "../knowledge-help";
import { apiOrQueue, useOfflineQueue } from "../offline-queue";
import { api, ErrorBox, errorMessage, inputClass } from "../ui";
import { useBusinessInfo } from "../use-printers";
import { cardClass } from "../page-chrome";
import { safeRandomId } from "@/lib/client-id";

/**
 * The menu is the canonical shared model (restaurant-menu.ts): the POS, the
 * waiter screen and the menu manager all consume the same rows, the same
 * per-item bounds resolution and the same image fallback. No more
 * screen-local redefinitions that quietly dropped SKU/image fields.
 */
type MenuData = RestaurantMenuData;
type Item = RestaurantMenuItem;
interface Courier {
  id: string;
  name: string;
  phone: string | null;
}

interface CartUiLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  taxRatePercent: number;
  /** Add-on picks with quantities, sorted by id — the line's configuration. */
  modifierPicks: PosCartModifierPick[];
  /**
   * Name + price of every chosen add-on, kept together so any surface that
   * renders this line can show what was added *and* what it costs. The label
   * and the deltas the printer/total code needs are derived from this rather
   * than stored beside it, so they can't drift apart.
   */
  modifiers: DisplayModifier[];
  note: string;
}

type OrderType = "dine_in" | "takeaway" | "delivery";
type CheckoutIntent = "order" | "payment";

interface CheckoutResult {
  orderNumber: number | null;
  type: OrderType;
  tableName: string | null;
  total: number;
  queued: boolean;
  paid: boolean;
  paymentPending: boolean;
  paymentError?: string;
  /** Snapshot of what was sent, so the confirmation can restate the lines and their add-ons. */
  lines: CartUiLine[];
}

export function PosScreen({
  initialTableId,
}: {
  initialTableId?: string | null;
}) {
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [tables, setTables] = useState<PosTable[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [customer, setCustomer] = useState<PickerCustomer | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [searchActiveIndex, setSearchActiveIndex] = useState(0);
  const [cart, setCart] = useState<CartUiLine[]>([]);
  const [orderType, setOrderType] = useState<OrderType>("dine_in");
  /**
   * `?table=<id>` seats this sale before a single item is rung — that is how
   * «مهمان جدید روی این میز» on an order's detail hands a friend at an already
   * busy table their own, separate bill.
   */
  const [tableId, setTableId] = useState(initialTableId ?? "");
  /**
   * Which checkout the table prompt is standing in front of, or null when it is
   * closed: `"select"` when the cashier opened it from the cart themselves,
   * `"order"`/`"payment"` when they pressed a close-the-sale button with no
   * table yet and confirming should carry straight on into it.
   */
  const [tablePickerFor, setTablePickerFor] = useState<
    CheckoutIntent | "select" | null
  >(null);
  const [guestCount, setGuestCount] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryPhone, setDeliveryPhone] = useState("");
  const [deliveryFee, setDeliveryFee] = useState("");
  const [deliveryCourierId, setDeliveryCourierId] = useState("");
  const [discountType, setDiscountType] = useState<"" | "percent" | "amount">(
    "",
  );
  const [discountValue, setDiscountValue] = useState("");
  const [pickerItem, setPickerItem] = useState<Item | null>(null);
  /**
   * The cart line whose add-ons/note/quantity are being re-picked, set when a
   * cashier presses «تغییر افزودنی‌ها» on a line. Null means the only picker on
   * screen (if any) is the add-new one. Editing is how «this coffee should not
   * have had chocolate» is fixed in one press instead of delete-then-re-add.
   */
  const [editingLineKey, setEditingLineKey] = useState<string | null>(null);
  const [cartSheetOpen, setCartSheetOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [checkoutIntent, setCheckoutIntent] = useState<CheckoutIntent>("order");
  /** Bumped to ask the payment step's own customer picker to open (from the difference preview). */
  const [reviewCustomerPickerRequests, setReviewCustomerPickerRequests] = useState(0);
  /**
   * The product tile that was last added to, flashed for a moment so a tap on a
   * grid of near-identical tiles is visibly acknowledged. Purely cosmetic: the
   * count badge on the tile is the durable feedback.
   */
  const [flashItemId, setFlashItemId] = useState<string | null>(null);
  // The ways this business takes money, in its own order — no longer three
  // hard-coded buttons. `paymentDraft` is what the cashier has chosen,
  // including a split across several of them (src/lib/payment-draft.ts).
  const {
    methods: paymentMethods,
    loaded: paymentMethodsLoaded,
    error: paymentMethodsError,
    reload: reloadPaymentMethods,
  } = usePaymentMethods();
  const [paymentDraft, setPaymentDraft] = useState<PaymentDraft>(() =>
    emptyPaymentDraft([]),
  );
  // The ways arrive after the first render, so the draft starts pointing at
  // nothing; this settles it on the business's first way once they land (and
  // again if a way the draft was holding gets retired mid-shift).
  useEffect(() => {
    setPaymentDraft((draft) =>
      methodOf(paymentMethods, draft.methodId)
        ? draft
        : emptyPaymentDraft(paymentMethods),
    );
  }, [paymentMethods]);
  const [tipInput, setTipInput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CheckoutResult | null>(null);
  const business = useBusinessInfo();
  const money = useMoney();
  const { isOnline, pendingCount } = useOfflineQueue();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const submissionInFlight = useRef(false);
  // Minted once per submission attempt and reused across retries of that same
  // attempt (a lost response the cashier resubmits, a proxy retry) so the
  // server's idempotency check on POST /api/orders sees one id, not a fresh
  // one each time — cleared once the order is actually created.
  const clientRequestIdRef = useRef<string | null>(null);

  const load = useCallback(() => {
    setIsRefreshing(true);
    // Couriers are fetched separately (below) and only while the delivery
    // order type is actually offered: `/api/couriers` is gated on the
    // `delivery` feature, and a till that cannot sell delivery must not ask
    // for the courier list at all — the 403 used to read as a load error.
    Promise.all([
      api<MenuTreePayload>("/api/menu"),
      api<{ tables: PosTable[] }>("/api/tables"),
    ])
      .then(([menuRes, tablesRes]) => {
        if (menuRes.ok) {
          const menu = toRestaurantMenu(menuRes.data);
          setMenu(menu);
          setActiveCategory(
            (current) =>
              current ||
              menu.categories.find((category) => category.isActive)?.id ||
              "",
          );
        }
        if (tablesRes.ok) setTables(tablesRes.data.tables);
        setLoadError(
          !menuRes.ok || !tablesRes.ok
            ? "بخشی از اطلاعات صندوق به‌روز نشد. داده‌های موجود حفظ شده‌اند."
            : "",
        );
      })
      .catch(() =>
        setLoadError("ارتباط با صندوق برقرار نشد. داده‌های موجود حفظ شده‌اند."),
      )
      .finally(() => {
        setInitialLoading(false);
        setIsRefreshing(false);
      });
  }, []);

  useEffect(load, [load]);

  /**
   * Delivery is an entitlement, and the domain layer refuses a delivery order
   * for a business whose `delivery` feature is off (order-mutations.ts). The
   * till aligns with it: no delivery tab, and the courier list is never
   * requested. While `business.features` has not loaded yet the tab stays
   * available — the server's `feature_disabled` refusal is the last word.
   */
  const deliveryEnabled = business.features?.delivery !== false;

  const menuIndex = useMemo(
    () => (menu ? buildRestaurantMenuIndex(menu) : null),
    [menu],
  );
  const activeCategories = useMemo(
    () => menuIndex?.activeCategories ?? [],
    [menuIndex],
  );

  // The courier list is only worth a request while a delivery sale is
  // actually being placed — and only when the business may deliver at all.
  useEffect(() => {
    if (!deliveryEnabled || orderType !== "delivery") return;
    let cancelled = false;
    api<{ couriers: Courier[] }>("/api/couriers")
      .then(({ ok, data }) => {
        if (!cancelled && ok) setCouriers(data.couriers);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deliveryEnabled, orderType]);

  // A delivery sale already on screen when the feature turns out to be off
  // falls back to takeaway rather than submitting something the domain
  // would refuse.
  useEffect(() => {
    if (!deliveryEnabled && orderType === "delivery") setOrderType("takeaway");
  }, [deliveryEnabled, orderType]);

  // ⚡ Bolt: Separate static data operations (filtering and map creation) into
  // distinct useMemo so they are not recalculated on every search query tick.
  // Only sellable items (active, categorized) reach the search model, which
  // now carries each item's SKU so the code search the box promises works.
  const posItems = useMemo(
    () =>
      menu?.items.filter(
        (item): item is Item & { categoryId: string } =>
          item.isActive && item.categoryId !== null,
      ) ?? [],
    [menu],
  );
  useEffect(() => {
    warmPosItemSearchCache(posItems);
  }, [posItems]);

  const itemsById = useMemo(
    () => menuIndex?.itemsById ?? new Map<string, Item>(),
    [menuIndex],
  );

  const visibleProducts = useMemo(() => {
    if (!menu) return [];
    const searchResults = searchPosMenuItems({
      categories: menu.categories,
      items: posItems,
      selectedCategoryId: activeCategory,
      // ⚡ Bolt: Use deferredSearchQuery to prevent typing lag during expensive menu searches
      query: deferredSearchQuery,
    });
    return searchResults.flatMap((result) => {
      const item = itemsById.get(result.id);
      return item ? [{ item, categoryLabel: result.categoryLabel }] : [];
    });
  }, [activeCategory, menu, deferredSearchQuery, posItems, itemsById]);

  useEffect(() => {
    setSearchActiveIndex((index) =>
      Math.min(index, Math.max(visibleProducts.length - 1, 0)),
    );
  }, [visibleProducts.length]);

  useEffect(() => {
    const activeResult = visibleProducts[searchActiveIndex];
    document
      .getElementById(activeResult ? `pos-product-${activeResult.item.id}` : "")
      ?.scrollIntoView({ block: "nearest" });
  }, [searchActiveIndex, visibleProducts]);

  /**
   * `startCheckout` closes over the whole cart, so it is a plain function that
   * this render rebuilds; the global shortcut below reads it through a ref
   * rather than resubscribing its listener on every keystroke.
   */
  const startCheckoutRef = useRef<(intent: CheckoutIntent) => void>(() => {});

  // `result` counts as an overlay in its own right: an order opened in one tap
  // shows its confirmation without ever setting `reviewOpen`, and "/" must not
  // reach the product search behind it.
  const hasOpenOverlay = Boolean(
    pickerItem ||
    editingLineKey ||
    reviewOpen ||
    cartSheetOpen ||
    result ||
    tablePickerFor,
  );
  useEffect(() => {
    function handleGlobalShortcut(event: KeyboardEvent) {
      const eligible = isGlobalCashierShortcutEligible({
        activeElement: document.activeElement,
        hasOpenDialog: hasOpenOverlay,
      });
      if (!eligible) return;

      if (
        event.key === "/" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        /^\d$/.test(event.key)
      ) {
        const category = activeCategories[Number(event.key) - 1];
        if (category) {
          event.preventDefault();
          setActiveCategory(category.id);
          setSearchQuery("");
          setSearchActiveIndex(0);
        }
        return;
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter" &&
        cart.length > 0
      ) {
        event.preventDefault();
        startCheckoutRef.current(checkoutIntent);
      }
    }

    window.addEventListener("keydown", handleGlobalShortcut);
    return () => window.removeEventListener("keydown", handleGlobalShortcut);
  }, [activeCategories, cart.length, checkoutIntent, hasOpenOverlay]);

  /**
   * The add-on groups an item offers, pre-resolved once per menu load by the
   * shared index: per-item bounds (override → group default), only active
   * groups actively attached, options ordered the way the manager laid them
   * out. O(1) per tile; no per-render filtering of three arrays.
   */
  const attachedGroups = useCallback(
    (itemId: string): RestaurantGroupView[] =>
      menuIndex?.groupsByItem.get(itemId) ?? [],
    [menuIndex],
  );

  function categoryTaxRate(categoryId: string | null): number {
    return menuIndex?.categoriesById.get(categoryId ?? "")?.taxRate ?? 0;
  }

  /**
   * Builds a line for an item with the chosen add-ons, honouring the one rule
   * that keeps a cart readable: the item and its add-ons are one *configuration*,
   * and a different configuration (coffee without the chocolate the first one
   * had) is a separate line with its own quantity — not a bigger number on the
   * same row. Two lines that carry the same item/add-ons/note merge via
   * `addOrMergeLine`, so repeat taps don't spawn duplicate cards.
   */
  function buildCartLine(
    item: Item,
    picks: { id: string; quantity: number }[],
    note: string,
    quantity: number,
    key?: string,
  ): CartUiLine {
    const units = Math.max(1, Math.round(quantity));
    // The picker only hands back ids it displayed, so every one resolves; a
    // menu reload between pick and confirm still degrades to a lookup over
    // the modifier list rather than a crash at the till.
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
    return {
      key: key ?? `${item.id}-${safeRandomId()}`,
      menuItemId: item.id,
      name: item.name,
      unitPrice: item.price,
      quantity: units,
      taxRatePercent: categoryTaxRate(item.categoryId),
      modifierPicks: sortedPicks,
      modifiers,
      note,
    };
  }

  function addToCart(
    item: Item,
    picks: { id: string; quantity: number }[],
    note: string,
    quantity = 1,
  ) {
    const line = buildCartLine(item, picks, note, quantity);
    setCart((prev) => addOrMergeLine(prev, line));
    flashItem(item.id);
  }

  /**
   * Commits an edit of a line already in the cart: it is rebuilt with the new
   * add-ons/note/quantity and re-merged via `upsertLine`, so stripping the
   * chocolate off one coffee joins the plain coffee already in the cart rather
   * than leaving two cards for what is now the same thing.
   */
  function commitLineEdit(
    lineKey: string,
    item: Item,
    picks: { id: string; quantity: number }[],
    note: string,
    quantity: number,
  ) {
    const line = buildCartLine(
      item,
      picks,
      note,
      quantity,
      `${item.id}-${safeRandomId()}`,
    );
    setCart((prev) => upsertLine(prev, lineKey, line));
    flashItem(item.id);
  }

  function flashItem(itemId: string) {
    setFlashItemId(itemId);
    window.setTimeout(
      () => setFlashItemId((current) => (current === itemId ? null : current)),
      450,
    );
  }

  /**
   * The − / + on a product tile, so a count can be corrected without opening the
   * cart at all — the step that used to mean "open the sheet, find the line,
   * press +" on a phone.
   *
   * − always undoes the cashier's *last* touch of the product (the most recent
   * line — `stepLastLineForItem`), which is the one they just added.
   *
   * + never copies add-ons. It means "another unit of this product, without
   * extra add-ons": a new plain line, or one more on the plain line already in
   * the cart. A coffee that already carries chocolate stays at its own quantity;
   * the extra unit is a separate coffee without chocolate. Growing the
   * chocolate line is the stepper *on that cart line*. When the item requires a
   * modifier choice (size, …) a plain unit isn't valid, so + opens the picker
   * instead of guessing.
   */
  function stepTileQuantity(item: Item, delta: 1 | -1) {
    if (delta === -1) {
      setCart((prev) => stepLastLineForItem(prev, item.id, -1));
      return;
    }
    const requiresConfiguration =
      menuIndex?.requiresConfigurationByItem.get(item.id) ?? false;
    const decision = decideTilePlus(cart, item.id, requiresConfiguration);
    if (decision.type === "configure") {
      setPickerItem(item);
      return;
    }
    if (decision.type === "pick") {
      pickItem(item);
      return;
    }
    setCart((prev) => addPlainUnit(prev, buildCartLine(item, [], "", 1)));
    flashItem(item.id);
  }

  /**
   * Switching the order type drops what no longer applies, so a table chosen for
   * a dine-in sale cannot ride along on a takeaway. The guest count goes with it:
   * the two are only ever asked for together.
   */
  function changeOrderType(next: OrderType) {
    // A disabled delivery feature is enforced by the domain; the tab is gone,
    // and this guard keeps a stale keyboard shortcut or a cached state from
    // selecting it anyway.
    if (next === "delivery" && !deliveryEnabled) return;
    setOrderType(next);
    if (next !== "dine_in") {
      setTableId("");
      setGuestCount("");
    }
  }

  /** Tapping a tile: straight into the cart, or into the picker when the item has add-ons to answer for. */
  function pickItem(item: Item) {
    const groups = attachedGroups(item.id);
    if (groups.length === 0) {
      addToCart(item, [], "");
    } else {
      setPickerItem(item);
    }
  }

  /**
   * The − / + printed on a cart line's own card: it can only ever move that one
   * line's count (and removes the line at zero), which is why the stepper lives
   * on the card itself rather than in any shared strip.
   */
  function stepLine(key: string, delta: 1 | -1) {
    setCart((prev) => stepLineQuantity(prev, key, delta));
  }
  function removeLine(key: string) {
    setCart((prev) => prev.filter((l) => l.key !== key));
    if (editingLineKey === key) setEditingLineKey(null);
  }
  /** Opens the add-on picker pre-filled with a line, to re-pick in place. */
  function editLine(key: string) {
    setEditingLineKey(key);
  }

  // ⚡ Bolt: Memoize cart computations to prevent jank on frequent state changes (e.g., search typing)
  // The discount amount is entered in the business's display unit (like every
  // other money input in this screen) but `computeOrderTotals` works in Rial,
  // so convert it here — the same boundary `feeNum`/`tipNum` below use. Percent
  // stays a percent.
  const discount: DiscountInput = useMemo(
    () =>
      discountType
        ? {
            type: discountType,
            value:
              discountType === "amount"
                ? money.fromInput(
                    Math.max(0, Math.round(Number(discountValue) || 0)),
                  )
                : Number(discountValue) || 0,
          }
        : { type: null },
    [discountType, discountValue, money],
  );
  const cartLines: CartLine[] = useMemo(
    () =>
      cart.map((l) => ({
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        modifierDeltas: modifierDeltasOf(l.modifiers),
        taxRatePercent: l.taxRatePercent,
      })),
    [cart],
  );
  const cartItemCount = useMemo(
    () => cart.reduce((count, line) => count + line.quantity, 0),
    [cart],
  );
  /** How many of each product the cart holds, for the count badge on its tile. */
  const cartCountsByItem = useMemo(() => cartQuantitiesByItem(cart), [cart]);
  /**
   * What is still missing, named before the cashier commits to anything. The two
   * close-the-sale buttons label themselves with it instead of sitting enabled
   * and failing three screens later.
   */
  const blocker = useMemo<PosCheckoutRequirement | null>(
    () =>
      missingCheckoutRequirement({
        orderType,
        tableId,
        deliveryAddress,
        lineCount: cart.length,
      }),
    [cart.length, deliveryAddress, orderType, tableId],
  );
  /** The chosen table, once it is one this branch still has. */
  const selectedTable = useMemo(
    () => tables.find((table) => table.id === tableId) ?? null,
    [tableId, tables],
  );
  /**
   * A table arriving by `?table=` may not be in the list yet (it is still
   * loading) or at all — the sale is still seated, so say so rather than
   * claiming no table was chosen.
   */
  const tableLabel =
    selectedTable?.name ?? (tableId ? "میز انتخاب‌شده" : "میزی انتخاب نشده");
  const cartAddOnTotal = useMemo(
    () =>
      cart.reduce(
        (sum, line) =>
          sum + sumModifierDeltas(modifierDeltasOf(line.modifiers)) * line.quantity,
        0,
      ),
    [cart],
  );
  // Fee/tip are entered in Toman (like menu prices) but stored/sent in Rial.
  const feeNum =
    orderType === "delivery"
      ? money.fromInput(Math.max(0, Math.round(Number(deliveryFee) || 0)))
      : 0;
  const tipNum = money.fromInput(
    Math.max(0, Math.round(Number(tipInput) || 0)),
  );
  const totals = useMemo(
    () => computeOrderTotals(cartLines, discount, feeNum),
    [cartLines, discount, feeNum],
  );
  /**
   * A payment whose typed amount (or way) books a difference needs a named
   * customer — the server refuses it otherwise, so the hold button says so
   * here instead of failing after the ۴ seconds.
   */
  const paymentNeedsCustomer =
    checkoutIntent === "payment" &&
    draftRequiresCustomer(paymentDraft, paymentMethods, totals.total) &&
    !customer;
  /**
   * `overrides` is how the table prompt places an order with the table that was
   * just chosen in it: confirming the prompt sets the state *and* submits in the
   * same tick, and the state this closure captured is still the old one.
   */
  async function submit(
    intent: CheckoutIntent = "order",
    overrides?: { tableId?: string; guestCount?: string },
  ): Promise<boolean> {
    if (busy || submissionInFlight.current) return false;
    setError("");
    const effectiveTableId = overrides?.tableId ?? tableId;
    const effectiveGuestCount = overrides?.guestCount ?? guestCount;
    if (cart.length === 0) {
      setError("سبد خرید خالی است.");
      return false;
    }
    if (requiresTableSelection({ orderType, tableId: effectiveTableId })) {
      setError("برای سفارش حضوری، میز را انتخاب کنید.");
      return false;
    }
    if (orderType === "delivery" && !deliveryAddress.trim()) {
      setError("برای سفارش ارسالی آدرس الزامی است.");
      return false;
    }

    // How the money is being taken is settled *before* the order is created:
    // a split that doesn't add up would otherwise leave an open order behind
    // and a cashier wondering which of the two things failed.
    let paymentBody: PaymentDraftBody[] = [];
    if (intent === "payment") {
      const built = paymentDraftBody(
        paymentDraft,
        paymentMethods,
        totals.total,
        money.unit,
      );
      if (!built.ok) {
        setError(errorMessage(built.error));
        return false;
      }
      if (
        built.value.some(
          (tender) =>
            methodOf(paymentMethods, tender.methodId)?.settlement === "credit",
        ) &&
        !customer
      ) {
        setError(errorMessage("customer_required"));
        return false;
      }
      paymentBody = built.value;
    }

    submissionInFlight.current = true;
    setBusy(true);
    if (!clientRequestIdRef.current) {
      clientRequestIdRef.current = safeRandomId();
    }
    const orderBody = {
      type: orderType,
      clientRequestId: clientRequestIdRef.current,
      tableId: orderType === "dine_in" ? effectiveTableId : undefined,
      customerId: customer?.id ?? undefined,
      guestCount: effectiveGuestCount ? Number(effectiveGuestCount) : undefined,
      discount: discountType
        ? {
            type: discountType,
            value:
              discountType === "amount"
                ? money.fromInput(
                    Math.max(0, Math.round(Number(discountValue) || 0)),
                  )
                : Number(discountValue) || 0,
          }
        : undefined,
      items: cart.map((line) => ({
        menuItemId: line.menuItemId,
        quantity: line.quantity,
        modifiers: line.modifierPicks,
        note: line.note || undefined,
      })),
      delivery:
        orderType === "delivery"
          ? {
              address: deliveryAddress.trim(),
              phone: deliveryPhone.trim() || undefined,
              fee: feeNum,
              courierId: deliveryCourierId || undefined,
            }
          : undefined,
    };
    const typeLabel =
      orderType === "dine_in"
        ? "حضوری"
        : orderType === "takeaway"
          ? "بیرون‌بر"
          : "ارسالی";
    const tableName =
      orderType === "dine_in"
        ? (tables.find((table) => table.id === effectiveTableId)?.name ?? null)
        : null;

    let creation: {
      ok: boolean;
      queued: boolean;
      data: { error?: string; orderNumber?: number; id?: string };
    };
    try {
      creation = await apiOrQueue<{
        error?: string;
        orderNumber?: number;
        id?: string;
      }>(
        "/api/orders",
        { method: "POST", body: orderBody },
        {
          type: "order.create",
          payload: orderBody,
          description: "سفارش " + typeLabel,
        },
      );
    } catch {
      setBusy(false);
      submissionInFlight.current = false;
      setError("ثبت سفارش ممکن نشد. دوباره تلاش کنید.");
      return false;
    }

    if (!creation.ok) {
      setBusy(false);
      submissionInFlight.current = false;
      setError(errorMessage(creation.data.error));
      return false;
    }

    const orderNumber = creation.queued
      ? null
      : creation.data.orderNumber || null;
    let paid = false;
    let paymentPending = false;
    let paymentError: string | undefined;

    if (intent === "payment") {
      if (creation.queued || !creation.data.id) {
        paymentPending = true;
        paymentError =
          "سفارش در صف همگام‌سازی است؛ دریافت وجه را پس از اتصال از بخش سفارش‌ها تکمیل کنید.";
      } else {
        try {
          const payment = await api<{ error?: string }>(
            "/api/orders/" + creation.data.id + "/pay",
            {
              method: "POST",
              body: JSON.stringify({
                payments: paymentBody,
                customerId: customer?.id ?? undefined,
                tipAmount: tipNum,
              }),
            },
          );
          if (payment.ok) {
            paid = true;
          } else {
            paymentPending = true;
            paymentError = errorMessage(payment.data.error);
          }
        } catch {
          paymentPending = true;
          paymentError =
            "سفارش ثبت شد، اما ارتباط هنگام دریافت وجه قطع شد. وضعیت سفارش را از بخش سفارش‌ها بررسی کنید.";
        }
      }
    }

    const kitchenRequestId = `kitchen:${creation.data.id ?? crypto.randomUUID()}`;
    {
      // The big line on a kitchen ticket is the table when there is one — that
      // is what the runner carries the tray to.
      const label = tableName ?? typeLabel;
      const ticket: KitchenTicketData = {
        label,
        orderTypeLabel: typeLabel,
        sentAt: new Date().toISOString(),
        lines: cart.map((line) => ({
          name: line.name,
          quantity: line.quantity,
          modifiersLabel: modifierNamesLabel(line.modifiers) || null,
          note: line.note || null,
        })),
      };
      void printKitchenTicket(null, ticket, { requestId: kitchenRequestId, entityId: creation.data.id }).then((result) => {
        if (!result.ok && result.error !== "printer_not_configured") {
          toast.warning("سفارش ثبت شد اما ارسال به چاپگر آشپزخانه ناموفق بود.", {
            duration: Infinity,
            action: { label: "تلاش دوباره", onClick: () => void printKitchenTicket(null, ticket, { requestId: `${kitchenRequestId}:retry`, entityId: creation.data.id }) },
          });
        }
      });
    }

    if (paid) {
        const receipt: ReceiptData = {
          business: {
            name: business.name,
            address: business.address,
            phone: business.phone,
          },
          orderLabel: orderNumber
            ? formatQueueLabel(orderType, orderNumber)
            : typeLabel,
          orderTypeLabel:
            orderType === "dine_in"
              ? "حضوری" + (tableName ? " — " + tableName : "")
              : typeLabel,
          issuedAt: new Date().toISOString(),
          lines: cart.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            lineTotal: linePriceBreakdown({
              unitPrice: line.unitPrice,
              modifierDeltas: modifierDeltasOf(line.modifiers),
              quantity: line.quantity,
            }).total,
            modifiersLabel: modifierNamesLabel(line.modifiers) || null,
          })),
          subtotal: totals.subtotal,
          discount: totals.discount,
          tax: totals.tax,
          total: totals.total,
          tip: tipNum,
          payments: draftReceiptPayments(
            paymentDraft,
            paymentMethods,
            totals.total,
            money.unit,
          ),
        };
        const receiptRequestId = `receipt:${creation.data.id ?? crypto.randomUUID()}`;
        void printReceipt(null, receipt, { requestId: receiptRequestId, entityId: creation.data.id }).then((result) => {
          if (!result.ok && result.error !== "printer_not_configured") {
            toast.warning("چاپ رسید انجام نشد؛ سفارش با موفقیت ثبت شده است.", {
              action: { label: "چاپ دوباره", onClick: () => void printReceipt(null, receipt, { requestId: `${receiptRequestId}:retry`, entityId: creation.data.id }) },
            });
          }
          if (draftOpensDrawer(paymentDraft, paymentMethods) && result.supportsDrawer && result.printerId) {
            void kickDrawer(result.printerId);
          }
        });
    }

    setResult({
      orderNumber,
      type: orderType,
      tableName,
      total: totals.total,
      queued: creation.queued,
      paid,
      paymentPending,
      paymentError,
      lines: cart,
    });
    setCart([]);
    setTableId("");
    setGuestCount("");
    setCustomer(null);
    setDiscountType("");
    setDiscountValue("");
    setDeliveryAddress("");
    setDeliveryPhone("");
    setDeliveryFee("");
    setDeliveryCourierId("");
    setCheckoutIntent("order");
    setPaymentDraft(emptyPaymentDraft(paymentMethods));
    setTipInput("");
    setCartSheetOpen(false);
    setBusy(false);
    submissionInFlight.current = false;
    clientRequestIdRef.current = null;
    load();
    return true;
  }

  /**
   * The one way into the checkout, whichever button (or shortcut) starts it.
   *
   * Two things happen here rather than at the last press. An in-person sale with
   * no table yet is asked for one and carries on afterwards instead of being
   * rejected. And opening a tab goes straight through: «ثبت سفارش باز» creates an
   * order that is fully editable, re-priced and voidable from the orders screen,
   * so a confirmation in front of it only asked the cashier to approve something
   * they can undo — while «دریافت وجه» keeps its review, because that is the press
   * that moves money. Either way the confirmation *after* the fact still shows
   * what was created.
   */
  function startCheckout(intent: CheckoutIntent) {
    setError("");
    setCheckoutIntent(intent);
    if (requiresTableSelection({ orderType, tableId })) {
      setTablePickerFor(intent);
      return;
    }
    if (intent === "order") {
      void submit("order");
      return;
    }
    setReviewOpen(true);
  }
  startCheckoutRef.current = startCheckout;

  if (!menu)
    return (
      <PosLoadingState
        loading={initialLoading}
        error={loadError}
        onRetry={load}
      />
    );

  /**
   * Dismissing the confirmation is what ends one sale and starts the next: the
   * cart and every order-level field were already reset by submit(), so closing
   * the dialog just drops the receipt and hands the cashier an empty POS.
   */
  function closeCheckout() {
    setResult(null);
    setReviewOpen(false);
    setError("");
  }

  /**
   * The line being edited and its menu item. The item is looked up the same way
   * the grid looks things up; if either has vanished (menu reloaded, line
   * removed) the edit picker simply doesn't open rather than guessing.
   */
  const editingLine = editingLineKey
    ? (cart.find((line) => line.key === editingLineKey) ?? null)
    : null;
  const editingItem = editingLine
    ? (itemsById.get(editingLine.menuItemId) ?? null)
    : null;

  return (
    <div
      /*
        `pb-16` below `md`: the cart summary is fixed to the bottom bar and so
        takes no room in the flow — without this the last row of products ends
        under it.
      */
      className="flex flex-col gap-3 pb-16 md:h-[calc(100dvh-2rem)] md:flex-row md:pb-0"
    >
      {/*
        Below `md` this panel is *not* a scroller. It was: `flex-1` +
        `overflow-hidden` around a grid that scrolled inside it, which on a
        phone left the grid a couple of rows tall — past the fourth product the
        tiles were clipped behind the cart bar, and the panel had swallowed the
        page's scroll so there was no way to reach them. On a phone the grid
        simply runs down the page and the page scrolls, the way every other
        screen does; from `md` up the two-column till is unchanged.
      */}
      <div
        className={`flex flex-col overflow-hidden ${cardClass} md:min-h-0 md:flex-1`}
      >
        {/*
          Item 8 — the phone's sell header is deliberately tighter than the
          desktop's: `p-2` rather than `p-3`, a 44px search row rather than 48,
          and a 44px category strip rather than 56. Three rows of chrome at
          desktop proportions cost about a third of a 360px screen before the
          first product tile, which is the row a cashier is actually reaching
          for. From `md` up nothing changes — that till is not short of space.
        */}
        <div className="border-b border-border/80 p-2 md:p-4">
          <div className="mb-3 hidden flex-wrap items-center gap-2 md:flex">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300">
                <ShoppingBagIcon className="size-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-base font-bold text-foreground">
                  صندوق فروش
                </h1>
                <p className="truncate text-xs text-muted-foreground">
                  عملیات فروش جاری
                </p>
              </div>
            </div>
            <KnowledgeHelpButton section="pos" />
            <BranchSwitcher compact />
            <span
              className={
                "inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-xs font-semibold " +
                (isOnline
                  ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300")
              }
              role="status"
              aria-live="polite"
            >
              {isOnline ? (
                <WifiIcon className="size-4" aria-hidden="true" />
              ) : (
                <WifiOffIcon className="size-4" aria-hidden="true" />
              )}
              {isOnline
                ? pendingCount > 0
                  ? toPersianDigits(pendingCount) + " عملیات در صف"
                  : "همگام"
                : "آفلاین"}
            </span>
            <button
              type="button"
              onClick={load}
              disabled={isRefreshing}
              className="flex size-11 items-center justify-center rounded-xl border border-border/80 bg-card text-muted-foreground transition duration-200 hover:bg-muted active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-60 motion-reduce:transition-none"
              aria-label={
                isRefreshing ? "در حال به‌روزرسانی صندوق" : "به‌روزرسانی صندوق"
              }
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
            </button>
          </div>
          {loadError ? (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-amber-500/25 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-muted-foreground"
              role="status"
            >
              <span>{loadError}</span>
              <button
                type="button"
                onClick={load}
                className="min-h-11 px-2 font-bold text-amber-700 dark:text-amber-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
              >
                تلاش دوباره
              </button>
            </div>
          ) : null}
          <label className="sr-only" htmlFor="pos-product-search">
            جستجوی محصول یا کد کالا
          </label>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon
                className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={searchInputRef}
                id="pos-product-search"
                className={
                  inputClass +
                  " min-h-11 border-border/80 bg-muted ps-10 shadow-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-500/25 dark:focus-visible:ring-amber-400/45 md:min-h-12"
                }
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  setSearchActiveIndex(0);
                }}
                onKeyDown={(event) => {
                  if (
                    visibleProducts.length === 0 ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const offset = event.key === "ArrowDown" ? 1 : -1;
                    setSearchActiveIndex(
                      (index) =>
                        (index + offset + visibleProducts.length) %
                        visibleProducts.length,
                    );
                  }
                  if (event.key === "Enter") {
                    event.preventDefault();

                    // ⚡ Bolt: Handle fast-input race conditions (like barcode scanners)
                    // If the user hit enter before the deferred query caught up, we must compute
                    // the results synchronously on the immediate query so we don't drop the scan.
                    let currentResults = visibleProducts;
                    if (searchQuery !== deferredSearchQuery) {
                      const immediateSearchResults = searchPosMenuItems({
                        categories: menu?.categories ?? [],
                        // ⚡ Bolt: Re-use precomputed items array
                        items: posItems,
                        selectedCategoryId: activeCategory,
                        query: searchQuery,
                      });

                      currentResults = immediateSearchResults.flatMap(
                        (result) => {
                          // ⚡ Bolt: Re-use precomputed items map
                          const item = itemsById.get(result.id);
                          return item
                            ? [{ item, categoryLabel: result.categoryLabel }]
                            : [];
                        },
                      );
                    }

                    const selected = currentResults[searchActiveIndex];
                    if (selected) pickItem(selected.item);
                  }
                }}
                placeholder="جستجوی محصول (/)"
                role="combobox"
                aria-expanded={visibleProducts.length > 0}
                aria-controls="pos-product-results"
                aria-activedescendant={
                  visibleProducts[searchActiveIndex]
                    ? `pos-product-${visibleProducts[searchActiveIndex].item.id}`
                    : undefined
                }
              />
            </div>
            {/* Mobile: the top bar above is desktop-only, so the learning icon
                rides beside the search row on phones. */}
            <span className="shrink-0 md:hidden">
              <KnowledgeHelpButton section="pos" />
            </span>
          </div>
          {/*
            One horizontal lane, never a wrapping block: on a phone a wrapped
            category row grew a second and third line as a menu gained
            sections, and each line pushed the grid further down. The
            scrollbar is hidden because a visible one on a 44px strip is
            noise, and the negative margin lets the first and last chip reach
            the panel's real edge so neither looks clipped mid-scroll.
          */}
          <div
            className="-mx-2 mt-2 flex min-h-11 flex-nowrap gap-1.5 overflow-x-auto px-2 pb-0.5 [scrollbar-width:none] md:-mx-0 md:mt-3 md:min-h-14 md:gap-2 md:px-0 md:pb-1 [&::-webkit-scrollbar]:hidden"
            aria-label="دسته‌های فعال"
          >
            {/*
              The shared chip, at the till's own density: `dense` is its 44px
              touch target, and the only thing added is the desktop's taller
              56px lane. Writing the amber selected state again here is what
              gave the product three different active fills.
            */}
            {activeCategories.map((category, index) => (
              <FilterChip
                key={category.id}
                dense
                selected={activeCategory === category.id}
                onClick={() => {
                  setActiveCategory(category.id);
                  setSearchQuery("");
                  setSearchActiveIndex(0);
                }}
                className="whitespace-nowrap px-3 text-[13px] md:min-h-14 md:px-4 md:text-sm"
                aria-keyshortcuts={index < 9 ? `Alt+${index + 1}` : undefined}
              >
                {category.name}
              </FilterChip>
            ))}
          </div>
        </div>
        <div
          id="pos-product-results"
          role="listbox"
          /*
            Sized by the space the tiles actually get, not by the viewport. Fixed
            per-breakpoint column counts kept being wrong here because two other
            things eat the width first — the sidebar from `md` up and the 23–25rem
            cart panel beside it — so a 1024px laptop had ~370px for what the
            breakpoint thought was a four-column grid, and every tile truncated
            its category and its price. `auto-fill` with a 10rem floor asks the
            container instead: two columns on a phone, two beside the panel on a
            laptop, five on a wide till, with no breakpoint to keep in sync.
          */
          className="grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] content-start gap-2.5 p-3 md:flex-1 md:overflow-y-auto md:p-4"
        >
          {visibleProducts.map(({ item, categoryLabel }, index) => {
            const inCart = cartCountsByItem.get(item.id) ?? 0;
            const requiresConfiguration =
              menuIndex?.requiresConfigurationByItem.get(item.id) ?? false;
            const plusDecision = decideTilePlus(
              cart,
              item.id,
              requiresConfiguration,
            );
            // Required-choice items can't take a plain unit, so + opens the
            // picker. Otherwise + adds without add-ons, even when a customised
            // sibling is already in the cart.
            const plusOpensPicker = plusDecision.type === "configure";
            const variantCount =
              inCart > 0 ? countLinesForItem(cart, item.id) : 0;
            const active = index === searchActiveIndex;
            return (
              /*
                A tile is three controls in one frame, so it can no longer be a
                single <button>: tapping it adds one, «تنظیم» opens the picker for
                add-ons, a note and a count, and once the product is in the cart a
                − / + strip corrects that count in place. That strip is the step
                the walkthrough was missing — the quantity used to be reachable
                only from the cart, which on a phone meant opening the sheet.
              */
              <div
                key={item.id}
                role="presentation"
                className={
                  "group relative flex touch-manipulation flex-col overflow-hidden rounded-2xl border transition duration-200 motion-reduce:transition-none " +
                  (active
                    ? "border-amber-500 dark:border-amber-500/60 bg-amber-50 dark:bg-amber-500/15 ring-1 ring-amber-500/25 dark:ring-amber-400/45"
                    : inCart > 0
                      ? "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15"
                      : "border-border/80 bg-card hover:border-amber-200 dark:hover:border-amber-500/30 hover:bg-muted") +
                  (flashItemId === item.id
                    ? " ring-2 ring-amber-500 dark:ring-amber-400/45 ring-offset-1"
                    : "")
                }
              >
                <button
                  id={"pos-product-" + item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pickItem(item)}
                  className="flex min-h-28 flex-1 flex-col items-stretch justify-between p-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 active:scale-[0.99] md:min-h-32 lg:min-h-36"
                  aria-label={
                    "افزودن " +
                    item.name +
                    " به سفارش" +
                    (inCart > 0
                      ? "؛ " + toPersianDigits(inCart) + " عدد در سبد"
                      : "")
                  }
                >
                  {/*
                    The catalogue photo rides above the text — but only when
                    the item actually has one. A photo-less item renders the
                    compact tile it always was (name + category + price),
                    rather than a tall gray placeholder box; a photo that
                    exists but cannot load (offline, media storage down) still
                    keeps the band, so a present picture never reflows the
                    grid. A fixed-height band means the tile never shifts when
                    the image arrives; loading is lazy so a long menu paints
                    instantly.
                  */}
                  {item.imageMediaId || item.imageUrl ? (
                    <span className="block h-20 w-full overflow-hidden rounded-lg md:h-24">
                      <MenuItemImage
                        mediaId={item.imageMediaId}
                        url={item.imageUrl}
                        className="size-full"
                        iconClassName="size-6"
                      />
                    </span>
                  ) : null}
                  {/*
                    Name, category and price each own a full row. They used to
                    share it with a 40px badge, which at the widths a tile
                    actually gets beside the cart panel meant «نوشیدنی گ…» and a
                    wrapped price on every card. The count lives in the strip
                    below instead, where it is also adjustable.
                  */}
                  <span className="line-clamp-2 pe-8 text-sm font-bold leading-6 text-foreground">
                    {item.name}
                  </span>
                  <div className="mt-3">
                    <span className="block truncate text-xs text-muted-foreground">
                      {categoryLabel}
                      {item.sku ? (
                        <span dir="ltr" className="ms-1.5 opacity-80">
                          · {item.sku}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block text-base font-bold text-amber-700 dark:text-amber-300">
                      {money.format(item.price)}
                    </span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setPickerItem(item)}
                  className="absolute end-2 top-2 flex size-9 items-center justify-center rounded-lg text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                  aria-label={"تعداد، افزودنی و یادداشت برای " + item.name}
                  title="تعداد، افزودنی و یادداشت"
                >
                  <SlidersHorizontalIcon
                    className="size-4"
                    aria-hidden="true"
                  />
                </button>
                {inCart > 0 ? (
                  <div className="flex items-center justify-between gap-1 border-t border-amber-200 dark:border-amber-500/30 bg-white/70 px-1.5 py-1">
                    <button
                      type="button"
                      onClick={() => stepTileQuantity(item, -1)}
                      className="flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
                      aria-label={
                        "کاهش تعداد آخرین " +
                        item.name +
                        (variantCount > 1
                          ? " (تنظیمات افزودنی در سبد خرید)"
                          : "")
                      }
                    >
                      <MinusIcon className="size-4" aria-hidden="true" />
                    </button>
                    <span
                      className="text-sm font-bold text-foreground"
                      aria-live="polite"
                    >
                      {toPersianDigits(inCart)}
                    </span>
                    <button
                      type="button"
                      onClick={() => stepTileQuantity(item, 1)}
                      className={
                        "flex size-11 items-center justify-center rounded-lg text-amber-700 dark:text-amber-300 transition-colors hover:bg-amber-100 dark:hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 " +
                        (plusOpensPicker
                          ? "ring-1 ring-amber-500/50 dark:ring-amber-400/45"
                          : "")
                      }
                      aria-label={
                        plusOpensPicker
                          ? "افزودن " +
                            item.name +
                            " — انتخاب افزودنی‌ها برای واحد جدید"
                          : "افزودن یک واحد " + item.name + " بدون افزودنی"
                      }
                      title={
                        plusOpensPicker
                          ? "این محصول انتخاب الزامی دارد؛ ترکیب واحد جدید را مشخص کنید"
                          : "یک واحد بدون افزودنی اضافه می‌شود؛ برای همان ترکیب، تعداد را در سبد زیاد کنید"
                      }
                    >
                      {plusOpensPicker ? (
                        <SlidersHorizontalIcon
                          className="size-4"
                          aria-hidden="true"
                        />
                      ) : (
                        <PlusIcon className="size-4" aria-hidden="true" />
                      )}
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {visibleProducts.length === 0 ? (
            <div className="col-span-full flex min-h-48 flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 bg-muted p-4 text-center">
              <SearchIcon
                className="size-6 text-muted-foreground"
                aria-hidden="true"
              />
              <p className="mt-3 text-sm font-bold text-muted-foreground">
                آیتمی پیدا نشد
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                عبارت جستجو یا دسته‌بندی را تغییر دهید.
              </p>
            </div>
          ) : null}
        </div>
      </div>
      {/* Cart */}
      {/*
        Same squeeze as the mobile sheet, milder: on a short laptop the intake
        header and the payment block can leave the line list a few pixels of
        scroll. `min-h-40` on the list is its floor, and the column itself
        scrolls once the three sections together outgrow the viewport.
      */}
      <div
        className={`hidden max-h-[46dvh] w-full shrink-0 flex-col overflow-y-auto ${cardClass} md:flex md:max-h-none md:w-[23rem] xl:w-[25rem]`}
      >
        <div className="shrink-0 border-b border-border/80 p-4">
          <ErrorBox>{error}</ErrorBox>
          <OrderTypeTabs value={orderType} onChange={changeOrderType} deliveryEnabled={deliveryEnabled} />
          {orderType === "dine_in" ? (
            <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
              <TableField
                label={tableLabel}
                chosen={tableId !== ""}
                occupied={isTableOccupied(selectedTable?.status)}
                onPick={() => setTablePickerFor("select")}
              />
              <label
                className="block text-xs font-semibold text-muted-foreground"
                htmlFor="pos-guest-count"
              >
                مهمان
                <PersianNumberInput
                  id="pos-guest-count"
                  className={
                    inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                  }
                  dir="ltr"
                  inputMode="numeric"
                  value={guestCount}
                  onChange={(event) => setGuestCount(event.target.value)}
                  placeholder="—"
                />
              </label>
            </div>
          ) : null}
          {orderType === "delivery" ? (
            <div className="space-y-3">
              <label
                className="block text-xs font-semibold text-muted-foreground"
                htmlFor="pos-delivery-address"
              >
                آدرس تحویل
                <textarea
                  id="pos-delivery-address"
                  className={
                    inputClass +
                    " mt-1 h-auto min-h-20 border-border/80 bg-muted py-2 focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60 focus-visible:ring-amber-500/25 dark:focus-visible:ring-amber-400/45"
                  }
                  rows={2}
                  value={deliveryAddress}
                  onChange={(event) => setDeliveryAddress(event.target.value)}
                  placeholder="آدرس کامل تحویل"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label
                  className="block text-xs font-semibold text-muted-foreground"
                  htmlFor="pos-delivery-phone"
                >
                  تلفن مشتری
                  <input
                    id="pos-delivery-phone"
                    className={
                      inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                    }
                    dir="ltr"
                    inputMode="tel"
                    value={deliveryPhone}
                    onChange={(event) => setDeliveryPhone(event.target.value)}
                    placeholder="اختیاری"
                  />
                </label>
                <label
                  className="block text-xs font-semibold text-muted-foreground"
                  htmlFor="pos-delivery-fee"
                >
                  هزینهٔ ارسال
                  <PersianNumberInput
                    id="pos-delivery-fee"
                    className={
                      inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                    }
                    dir="ltr"
                    inputMode="numeric"
                    value={deliveryFee}
                    onChange={(event) => setDeliveryFee(event.target.value)}
                    placeholder={money.unitLabel}
                  />
                </label>
              </div>
              <label className="block text-xs font-semibold text-muted-foreground">
                پیک
                <SearchableSelect
                  className={
                    inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                  }
                  value={deliveryCourierId}
                  onChange={setDeliveryCourierId}
                  ariaLabel="پیک ارسال"
                  options={[
                    { value: "", label: "تخصیص پیک بعداً (در صف ارسال)" },
                    ...couriers.map((courier) => ({
                      value: courier.id,
                      label: courier.name,
                    })),
                  ]}
                />
              </label>
            </div>
          ) : null}
          <div className="mt-3">
            <CustomerPicker
              customer={customer}
              onChange={setCustomer}
              idPrefix="pos-customer"
            />
            <CustomerBalanceBadge customer={customer} />
          </div>
        </div>

        {/*
          The lines grow; the column around them scrolls. This used to be a
          `flex-1` scroll box with a 10rem floor, which on a laptop meant the
          cart — the one part of the panel that changes with every tap — was the
          smallest region on screen: a two-line order showed one line, with the
          second hidden in a scroll box nothing pointed at, while the payment
          block below kept its 300px. `shrink-0` is what makes it grow instead of
          being squeezed into the leftovers. The footer is sticky, so a long cart
          never pushes the pay button out of reach.
        */}
        <div className="shrink-0 p-4">
          {cart.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/80 bg-muted p-4 text-center text-sm text-muted-foreground">
              سبد خالی است. از فهرست محصولات، آیتم‌ها را اضافه کنید.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                هر ردیف یک ترکیب است. + روی کارت محصول یک واحد بدون افزودنی
                اضافه می‌کند؛ + روی ردیف سبد همان ترکیب (با افزودنی) را زیاد
                می‌کند.
              </p>
              <ul className="space-y-2.5">
                {cart.map((l) => (
                  <CartLineCard
                    key={l.key}
                    line={l}
                    onStep={stepLine}
                    onEdit={editLine}
                    onRemove={removeLine}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        {/* Sticky, so the column scrolling never takes the pay button
            off-screen the way a plain flow footer would. */}
        <div className="sticky bottom-0 z-10 shrink-0 border-t border-border bg-card p-4">
          <div className="mb-3 flex gap-2">
            <SearchableSelect
              value={discountType}
              onChange={(value) =>
                setDiscountType(value as "" | "percent" | "amount")
              }
              ariaLabel="نوع تخفیف"
              options={[
                { value: "", label: "بدون تخفیف" },
                { value: "percent", label: "درصدی" },
                { value: "amount", label: "مبلغ ثابت" },
              ]}
            />
            {discountType ? (
              <PersianNumberInput
                className={inputClass}
                aria-label="مقدار تخفیف"
                dir="ltr"
                inputMode={discountType === "percent" ? "decimal" : "numeric"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
                placeholder={
                  discountType === "percent"
                    ? "درصد"
                    : money.unit === "rial"
                      ? "ریال"
                      : "تومان"
                }
              />
            ) : null}
          </div>

          <dl className="mb-3 space-y-1 text-sm">
            <Row label="جمع جزء" value={money.format(totals.subtotal)} />
            {cartAddOnTotal !== 0 ? (
              <Row
                label="از این مبلغ، افزودنی‌ها"
                value={formatModifierDelta(cartAddOnTotal, {
                  unit: money.unit,
                })}
              />
            ) : null}
            {totals.discount > 0 ? (
              <Row label="تخفیف" value={`- ${money.format(totals.discount)}`} />
            ) : null}
            {totals.tax > 0 ? (
              <Row label="مالیات" value={money.format(totals.tax)} />
            ) : null}
            {feeNum > 0 ? (
              <Row label="هزینهٔ ارسال" value={money.format(feeNum)} />
            ) : null}
            <Row label="جمع کل" value={money.format(totals.total)} bold />
          </dl>

          {/*
            How the money is taken is asked in the payment step, not here. Six
            payment ways plus a tip field held ~300px of the panel at all times —
            on a laptop that is what squeezed the cart down to a single visible
            line — and every one of those controls only matters once the cashier
            has decided to settle. Pressing «دریافت وجه» is where they are now.
          */}
          <CheckoutActions
            blocker={blocker}
            busy={busy}
            onPay={() => startCheckout("payment")}
            onOpenOrder={() => startCheckout("order")}
          />
        </div>
      </div>

      {/*
        The phone's one-line summary of where the order stands: what is in it,
        what it comes to, and which table or type it is for. It stays visible over
        the product grid so the cashier never has to open the sheet to check —
        opening it is now only for the order's details and the payment.
      */}
      {/*
        `fixed`, not `sticky`, and offset from `--app-bottom-nav` so it rests
        directly on the bottom bar. As a sticky element it drifted: Chrome
        measures a sticky offset from the scrollport's *content* box, so the
        dashboard scroller's own bottom padding was added to this offset and
        the bar floated ~110px above the nav with the assistant's button
        stranded in the gap between them. A fixed offset is measured from the
        viewport, which is the thing it is supposed to be attached to, and
        every engine measures it the same way.
      */}
      <div
        data-bottom-dock
        className="fixed inset-x-2 bottom-[var(--app-bottom-nav)] z-30 md:hidden"
      >
        <button
          type="button"
          onClick={() => setCartSheetOpen(true)}
          className={
            "flex min-h-14 w-full items-center justify-between gap-3 rounded-2xl px-4 text-sm font-bold shadow-[0_8px_20px_rgba(233,161,27,0.22)] transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 motion-reduce:transition-none " +
            (cart.length === 0
              ? "border border-border/80 bg-card text-muted-foreground shadow-none"
              : "bg-amber-500 dark:bg-amber-400 text-amber-950")
          }
          aria-label={
            cart.length === 0
              ? "باز کردن سبد خرید؛ سبد خالی است"
              : `باز کردن سبد خرید؛ ${toPersianDigits(cartItemCount)} قلم، ${money.format(totals.total)}`
          }
        >
          <span className="flex min-w-0 items-center gap-2">
            <ShoppingBagIcon className="size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate text-start">
              {cart.length === 0
                ? "سبد خالی است"
                : `${toPersianDigits(cartItemCount)} قلم در سبد`}
              <span className="block truncate text-[11px] font-normal opacity-80">
                {orderType === "dine_in"
                  ? "حضوری — " + tableLabel
                  : orderType === "takeaway"
                    ? "بیرون‌بر"
                    : "ارسالی"}
              </span>
            </span>
          </span>
          <span className="shrink-0">{money.format(totals.total)}</span>
        </button>
      </div>

      <Sheet open={cartSheetOpen} onOpenChange={setCartSheetOpen}>
        <SheetContent
          side="bottom"
          className="flex max-h-[92dvh] flex-col gap-0 rounded-t-3xl border-border/80 p-0 data-[state=open]:duration-200 data-[state=closed]:duration-200 md:hidden"
        >
          <div className="shrink-0 border-b border-border px-4 py-3">
            <SheetTitle>سبد خرید</SheetTitle>
            <ErrorBox>{error}</ErrorBox>
          </div>
          {/* One scroll region keeps the cart usable on short phone screens. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            <div className="border-b border-border p-4">
              <OrderTypeTabs value={orderType} onChange={changeOrderType} deliveryEnabled={deliveryEnabled} />
              {orderType === "dine_in" ? (
                <div className="mt-3 grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
                  <TableField
                    label={tableLabel}
                    chosen={tableId !== ""}
                    occupied={isTableOccupied(selectedTable?.status)}
                    onPick={() => setTablePickerFor("select")}
                  />
                  <label
                    className="block text-xs font-semibold text-muted-foreground"
                    htmlFor="pos-mobile-guest-count"
                  >
                    مهمان
                    <PersianNumberInput
                      id="pos-mobile-guest-count"
                      className={
                        inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                      }
                      dir="ltr"
                      inputMode="numeric"
                      value={guestCount}
                      onChange={(event) => setGuestCount(event.target.value)}
                      placeholder="—"
                    />
                  </label>
                </div>
              ) : null}
              {orderType === "delivery" ? (
                <div className="mt-3 space-y-3">
                  <label
                    className="block text-xs font-semibold text-muted-foreground"
                    htmlFor="pos-mobile-delivery-address"
                  >
                    آدرس تحویل
                    <textarea
                      id="pos-mobile-delivery-address"
                      className={
                        inputClass +
                        " mt-1 h-auto min-h-20 border-border/80 bg-muted py-2"
                      }
                      rows={2}
                      value={deliveryAddress}
                      onChange={(event) =>
                        setDeliveryAddress(event.target.value)
                      }
                      placeholder="آدرس کامل تحویل"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label
                      className="block text-xs font-semibold text-muted-foreground"
                      htmlFor="pos-mobile-delivery-phone"
                    >
                      تلفن مشتری
                      <input
                        id="pos-mobile-delivery-phone"
                        className={
                          inputClass +
                          " mt-1 min-h-11 border-border/80 bg-muted"
                        }
                        dir="ltr"
                        inputMode="tel"
                        value={deliveryPhone}
                        onChange={(event) =>
                          setDeliveryPhone(event.target.value)
                        }
                        placeholder="اختیاری"
                      />
                    </label>
                    <label
                      className="block text-xs font-semibold text-muted-foreground"
                      htmlFor="pos-mobile-delivery-fee"
                    >
                      هزینهٔ ارسال
                      <PersianNumberInput
                        id="pos-mobile-delivery-fee"
                        className={
                          inputClass +
                          " mt-1 min-h-11 border-border/80 bg-muted"
                        }
                        dir="ltr"
                        inputMode="numeric"
                        value={deliveryFee}
                        onChange={(event) => setDeliveryFee(event.target.value)}
                        placeholder={money.unitLabel}
                      />
                    </label>
                  </div>
                  <label className="block text-xs font-semibold text-muted-foreground">
                    پیک
                    <SearchableSelect
                      className={
                        inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                      }
                      value={deliveryCourierId}
                      onChange={setDeliveryCourierId}
                      ariaLabel="پیک ارسال"
                      options={[
                        { value: "", label: "تخصیص پیک بعداً" },
                        ...couriers.map((courier) => ({
                          value: courier.id,
                          label: courier.name,
                        })),
                      ]}
                    />
                  </label>
                </div>
              ) : null}
              <div className="mt-3">
                <CustomerPicker
                  customer={customer}
                  onChange={setCustomer}
                  idPrefix="pos-customer-sheet"
                />
                <CustomerBalanceBadge customer={customer} />
              </div>
            </div>
            <div className="p-4">
              {cart.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  سبد خرید خالی است.
                </p>
              ) : (
                <>
                  <p className="mb-2 text-[11px] font-semibold text-muted-foreground">
                    هر ردیف یک ترکیب است. + روی کارت محصول یک واحد بدون افزودنی
                    اضافه می‌کند؛ + روی ردیف سبد همان ترکیب (با افزودنی) را زیاد
                    می‌کند.
                  </p>
                  <ul className="space-y-2.5">
                    {cart.map((line) => (
                      <CartLineCard
                        key={line.key}
                        line={line}
                        onStep={stepLine}
                        onEdit={editLine}
                        onRemove={removeLine}
                      />
                    ))}
                  </ul>
                </>
              )}
            </div>
            <div className="border-t border-border p-4">
              <div className="mb-3 flex gap-2">
                <SearchableSelect
                  value={discountType}
                  onChange={(value) =>
                    setDiscountType(value as "" | "percent" | "amount")
                  }
                  ariaLabel="نوع تخفیف"
                  options={[
                    { value: "", label: "بدون تخفیف" },
                    { value: "percent", label: "درصدی" },
                    { value: "amount", label: "مبلغ ثابت" },
                  ]}
                />
                {discountType ? (
                  <PersianNumberInput
                    className={inputClass}
                    dir="ltr"
                    inputMode={
                      discountType === "percent" ? "decimal" : "numeric"
                    }
                    value={discountValue}
                    onChange={(event) => setDiscountValue(event.target.value)}
                    placeholder={
                      discountType === "percent"
                        ? "درصد"
                        : money.unit === "rial"
                          ? "ریال"
                          : "تومان"
                    }
                    aria-label="مقدار تخفیف"
                  />
                ) : null}
              </div>
              {cartAddOnTotal !== 0 ? (
                <Row
                  label="از این مبلغ، افزودنی‌ها"
                  value={formatModifierDelta(cartAddOnTotal, {
                    unit: money.unit,
                  })}
                />
              ) : null}
            </div>
          </div>
          <div className="shrink-0 border-t border-border bg-card p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-bold text-muted-foreground">
                جمع کل
              </span>
              <span className="text-base font-bold text-foreground">
                {money.format(totals.total)}
              </span>
            </div>
            <CheckoutActions
              blocker={blocker}
              busy={busy}
              onPay={() => startCheckout("payment")}
              onOpenOrder={() => startCheckout("order")}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/*
        One dialog carries the whole close of a sale: it reviews the order, and
        once submit() succeeds it turns into that order's confirmation instead
        of taking over the page. Dismissing it is what starts the next order —
        the POS behind it is already empty by then.
      */}
      <Dialog
        open={reviewOpen || result !== null}
        onOpenChange={(open) => (open ? setReviewOpen(true) : closeCheckout())}
      >
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
          {result ? (
            <CheckoutConfirmation result={result} onDone={closeCheckout} />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>
                  {checkoutIntent === "payment"
                    ? "تأیید دریافت وجه"
                    : "بررسی سفارش"}
                </DialogTitle>
                <DialogDescription>
                  {checkoutIntent === "payment"
                    ? "پرداخت فقط پس از ثبت موفق سفارش به جریان موجود پرداخت ارسال می‌شود."
                    : "پیش از ثبت، جزئیات سفارش را بررسی کنید."}
                </DialogDescription>
                <ErrorBox>{error}</ErrorBox>
              </DialogHeader>
              <section aria-label="اقلام سفارش">
                <h3 className="mb-2 text-xs font-bold text-muted-foreground">
                  اقلام سفارش
                </h3>
                <ul className="space-y-2">
                  {cart.map((line) => (
                    <CheckoutLineRow key={line.key} line={line} />
                  ))}
                </ul>
              </section>
              <dl className="space-y-2 text-sm">
                <Row
                  label="نوع سفارش"
                  value={
                    orderType === "dine_in"
                      ? "حضوری"
                      : orderType === "takeaway"
                        ? "بیرون‌بر"
                        : "ارسالی"
                  }
                />
                {orderType === "dine_in" ? (
                  <Row label="میز" value={tableLabel} />
                ) : null}
                {orderType === "delivery" ? (
                  <Row
                    label="آدرس"
                    value={deliveryAddress.trim() || "ثبت نشده"}
                  />
                ) : null}
                <Row label="مشتری" value={customer?.name ?? "بدون مشتری"} />
                <Row
                  label="تعداد اقلام"
                  value={toPersianDigits(cartItemCount)}
                />
                {cartAddOnTotal !== 0 ? (
                  <Row
                    label="افزودنی‌ها"
                    value={formatModifierDelta(cartAddOnTotal, {
                      unit: money.unit,
                    })}
                  />
                ) : null}
                <Row
                  label="مبلغ قابل پرداخت"
                  value={money.format(totals.total)}
                  bold
                />
                {checkoutIntent === "payment" && tipNum > 0 ? (
                  <>
                    <Row label="انعام" value={money.format(tipNum)} />
                    <Row
                      label="مبلغ دریافتی"
                      value={money.format(totals.total + tipNum)}
                      bold
                    />
                  </>
                ) : null}
              </dl>
              {/*
                The payment step, in the dialog that *is* the payment step. The
                cart panel used to carry these permanently, whether or not the
                cashier was settling; here they are asked for once, next to the
                amount they apply to.
              */}
              {checkoutIntent === "payment" ? (
                <section aria-label="روش دریافت وجه">
                  {/*
                    The customer sits with the payment because that is where
                    they matter: a difference (نسیه، بدهی، اعتبار) is booked
                    against a person, and the picker also quick-creates one
                    from a name and a mobile number.
                  */}
                  <div className="mb-3">
                    <CustomerPicker
                      customer={customer}
                      onChange={setCustomer}
                      disabled={busy}
                      idPrefix="pos-review-customer"
                      requestOpen={reviewCustomerPickerRequests}
                    />
                    <CustomerBalanceBadge customer={customer} />
                  </div>
                  <PaymentWays
                    methods={paymentMethods}
                    loaded={paymentMethodsLoaded}
                    loadError={paymentMethodsError}
                    onReload={reloadPaymentMethods}
                    draft={paymentDraft}
                    onChange={setPaymentDraft}
                    due={totals.total}
                    disabled={busy}
                    idPrefix="pos-checkout"
                    customer={customer}
                    onChooseCustomer={() => {
                      // The difference needs a person; open the picker that
                      // sits right here in the payment step.
                      setReviewCustomerPickerRequests((count) => count + 1);
                    }}
                  />
                  <label
                    htmlFor="pos-checkout-tip"
                    className="mt-3 block text-xs font-bold text-muted-foreground"
                  >
                    انعام{" "}
                    <span className="font-normal text-muted-foreground">
                      (اختیاری، تومان)
                    </span>
                  </label>
                  <PersianNumberInput
                    id="pos-checkout-tip"
                    className={
                      inputClass + " mt-1 min-h-11 border-border/80 bg-muted"
                    }
                    dir="ltr"
                    inputMode="numeric"
                    value={tipInput}
                    onChange={(event) => setTipInput(event.target.value)}
                    placeholder="۰"
                  />
                </section>
              ) : null}
              <DialogFooter>
                <button
                  type="button"
                  onClick={() => setReviewOpen(false)}
                  className="min-h-11 rounded-lg border border-input px-4 text-sm font-medium"
                >
                  بازگشت
                </button>
                {checkoutIntent === "payment" ? (
                  <HoldToConfirmButton
                    durationMs={4000}
                    label="ثبت پرداخت"
                    holdingLabel="نگه دارید…"
                    busy={busy}
                    disabled={
                      cart.length === 0 ||
                      paymentNeedsCustomer ||
                      !paymentMethodsLoaded ||
                      Boolean(paymentMethodsError) ||
                      paymentMethods.length === 0
                    }
                    onComplete={() => {
                      void submit("payment");
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    disabled={busy || cart.length === 0}
                    onClick={() => {
                      void submit(checkoutIntent);
                    }}
                    className="min-h-12 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55"
                  >
                    {busy ? "در حال ثبت…" : "تأیید و ثبت سفارش"}
                  </button>
                )}
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
      {pickerItem ? (
        <ModifierPicker
          itemName={pickerItem.name}
          itemPrice={Number(pickerItem.price)}
          menuItemId={pickerItem.id}
          selectQuantity
          groups={attachedGroups(pickerItem.id)}
          tone="amber"
          onCancel={() => setPickerItem(null)}
          onConfirm={(picks, note, quantity) => {
            addToCart(pickerItem, picks, note, quantity);
            setPickerItem(null);
          }}
        />
      ) : null}
      {/*
        Re-picking an existing line's add-ons/note/count. It is pre-filled with
        the line's current choice; confirming rebuilds the line and re-merges it
        (commitLineEdit → upsertLine), so «remove the chocolate from one of the
        coffees» collapses into the plain coffee instead of duplicating it. A
        plain item shows the quantity + note controls only, and still opens here
        because fixing a note is the same motion.
      */}
      {editingLine && editingItem && !pickerItem ? (
        <ModifierPicker
          itemName={editingItem.name}
          itemPrice={Number(editingItem.price)}
          menuItemId={editingItem.id}
          selectQuantity
          quantity={editingLine.quantity}
          initialModifiers={editingLine.modifierPicks}
          initialNote={editingLine.note}
          confirmLabel="اعمال تغییر"
          groups={attachedGroups(editingItem.id)}
          tone="amber"
          onCancel={() => setEditingLineKey(null)}
          onConfirm={(picks, note, quantity) => {
            commitLineEdit(
              editingLine.key,
              editingItem,
              picks,
              note,
              quantity,
            );
            setEditingLineKey(null);
          }}
        />
      ) : null}
      {/*
        Choosing the table is the last question of a dine-in sale, so confirming
        it carries straight on into whatever asked: «ثبت سفارش باز» places the
        order right there, «دریافت وجه» opens its review. The chosen table is
        passed to submit() rather than read back from state, which this tick has
        not yet re-rendered with.
      */}
      <TablePickerDialog
        open={tablePickerFor !== null}
        intent={tablePickerFor ?? "select"}
        tables={tables}
        selectedTableId={tableId}
        guestCount={guestCount}
        onCancel={() => setTablePickerFor(null)}
        onConfirm={(chosenTableId, chosenGuestCount) => {
          setTableId(chosenTableId);
          setGuestCount(chosenGuestCount);
          const pending = tablePickerFor;
          setTablePickerFor(null);
          if (pending === "order") {
            void submit("order", {
              tableId: chosenTableId,
              guestCount: chosenGuestCount,
            });
          } else if (pending === "payment") {
            setReviewOpen(true);
          }
        }}
      />
    </div>
  );
}

/** One cart line as it reads in the review dialog and in the confirmation: what it is, its add-ons, and what it costs. */
function CheckoutLineRow({ line }: { line: CartUiLine }) {
  const money = useMoney();
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: modifierDeltasOf(line.modifiers),
    quantity: line.quantity,
  });
  return (
    <li
      className={
        "rounded-xl border p-2.5 " +
        (line.modifiers.length > 0
          ? "border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15"
          : "border-border/80 bg-muted")
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-bold text-foreground">
            {line.name}{" "}
            <span className="text-xs font-semibold text-muted-foreground">
              × {toPersianDigits(line.quantity)}
            </span>
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {money.format(breakdown.unit)} هر واحد
          </p>
        </div>
        <p className="shrink-0 text-sm font-bold text-amber-700 dark:text-amber-300">
          {money.format(breakdown.total)}
        </p>
      </div>
      <ModifierBadges
        modifiers={line.modifiers}
        tone="amber"
        className="mt-2"
      />
      {line.note ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          یادداشت: {line.note}
        </p>
      ) : null}
    </li>
  );
}

/**
 * What the review dialog becomes once the order is in: the receipt for the sale
 * that just closed, restated line by line (add-ons included) so the cashier can
 * check it against what the customer asked for before starting the next one.
 */
function CheckoutConfirmation({
  result,
  onDone,
}: {
  result: CheckoutResult;
  onDone: () => void;
}) {
  const money = useMoney();
  const settled = result.paid && !result.queued;
  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <span
            className={
              "flex size-11 shrink-0 items-center justify-center rounded-2xl " +
              (settled
                ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                : "bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300")
            }
            aria-hidden="true"
          >
            {settled ? (
              <CheckIcon className="size-6" />
            ) : (
              <ReceiptTextIcon className="size-6" />
            )}
          </span>
          <div className="min-w-0">
            <DialogTitle>
              {result.queued
                ? "سفارش در صف همگام‌سازی ثبت شد"
                : result.paid
                  ? "پرداخت ثبت و سفارش تکمیل شد"
                  : result.paymentPending
                    ? "سفارش ثبت شد؛ پرداخت تکمیل نشد"
                    : "سفارش باز ثبت شد"}
            </DialogTitle>
            <DialogDescription>
              {result.queued
                ? result.paymentPending
                  ? "دریافت وجه را پس از اتصال از بخش سفارش‌ها تکمیل کنید."
                  : "با اتصال مجدد، سفارش بدون از دست رفتن داده‌ها ارسال می‌شود."
                : result.paid
                  ? "رسید و کشوی پول، در صورت اتصال چاپگر، اجرا شدند."
                  : result.paymentPending
                    ? result.paymentError ||
                      "پرداخت را از بخش سفارش‌ها ادامه دهید."
                    : "سفارش در فهرست سفارش‌های باز در دسترس است."}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="rounded-2xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-4 text-center">
        <p className="text-2xl font-bold text-foreground">
          {toPersianDigits(
            result.orderNumber
              ? formatQueueLabel(result.type, result.orderNumber)
              : "سفارش جدید",
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {result.type === "dine_in"
            ? "حضوری" + (result.tableName ? " — " + result.tableName : "")
            : result.type === "takeaway"
              ? "بیرون‌بر"
              : "ارسالی"}
        </p>
        <p className="mt-2 text-lg font-bold text-amber-700 dark:text-amber-300">
          {money.format(result.total)}
        </p>
      </div>

      {result.lines.length > 0 ? (
        <section aria-label="اقلام سفارش ثبت‌شده">
          <h3 className="mb-2 text-xs font-bold text-muted-foreground">
            اقلام ثبت‌شده
          </h3>
          <ul className="space-y-2">
            {result.lines.map((line) => (
              <CheckoutLineRow key={line.key} line={line} />
            ))}
          </ul>
        </section>
      ) : null}

      <DialogFooter>
        <button
          type="button"
          onClick={onDone}
          className="min-h-12 w-full rounded-xl bg-amber-500 dark:bg-amber-400 px-5 text-sm font-bold text-amber-950 transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 motion-reduce:transition-none"
        >
          بستن و شروع سفارش بعدی
        </button>
      </DialogFooter>
    </>
  );
}

function PosLoadingState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string;
  onRetry: () => void;
}) {
  if (!loading && error) {
    return (
      <section
        className={`mx-auto flex min-h-[55dvh] max-w-md flex-col items-center justify-center ${cardClass} p-6 text-center`}
      >
        <WifiOffIcon
          className="size-7 text-amber-700 dark:text-amber-300"
          aria-hidden="true"
        />
        <h1 className="mt-4 text-base font-bold text-foreground">
          صندوق در دسترس نیست
        </h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{error}</p>
        <button
          type="button"
          onClick={onRetry}
          className="mt-5 min-h-12 rounded-xl bg-amber-500 dark:bg-amber-400 px-5 text-sm font-bold text-amber-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45"
        >
          تلاش دوباره
        </button>
      </section>
    );
  }

  return (
    <div
      className="flex min-h-[calc(100dvh-6rem)] flex-col gap-3 md:h-[calc(100dvh-2rem)]"
      aria-busy="true"
      aria-label="در حال بارگذاری صندوق"
    >
      <div
        className={`grid gap-3 ${cardClass} p-3 md:grid-cols-[0.8fr_1.2fr_0.7fr]`}
      >
        <div className="ops-skeleton h-12 rounded-xl" />
        <div className="ops-skeleton h-12 rounded-xl" />
        <div className="ops-skeleton h-12 rounded-xl" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        <section className={`flex min-h-0 flex-1 flex-col ${cardClass} p-4`}>
          <div className="flex gap-2 overflow-hidden">
            {[1, 2, 3, 4].map((item) => (
              <div
                key={item}
                className="ops-skeleton h-14 w-28 shrink-0 rounded-xl"
              />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {Array.from({ length: 15 }, (_, index) => (
              <div key={index} className="ops-skeleton min-h-32 rounded-2xl" />
            ))}
          </div>
        </section>
        <aside
          className={`hidden w-[23rem] shrink-0 ${cardClass} p-4 md:block`}
        >
          <div className="ops-skeleton h-7 w-28 rounded-lg" />
          <div className="mt-4 grid grid-cols-3 gap-2">
            {[1, 2, 3].map((item) => (
              <div key={item} className="ops-skeleton h-12 rounded-xl" />
            ))}
          </div>
          <div className="mt-5 space-y-3">
            {[1, 2, 3].map((item) => (
              <div key={item} className="ops-skeleton h-16 rounded-xl" />
            ))}
          </div>
          <div className="mt-6 space-y-2">
            <div className="ops-skeleton h-5 rounded-lg" />
            <div className="ops-skeleton h-5 rounded-lg" />
            <div className="ops-skeleton h-14 rounded-xl" />
          </div>
        </aside>
      </div>
    </div>
  );
}

const ORDER_TYPE_TABS: { value: OrderType; label: string }[] = [
  { value: "dine_in", label: "حضوری" },
  { value: "takeaway", label: "بیرون‌بر" },
  { value: "delivery", label: "ارسالی" },
];

/**
 * Where the order is going, as one control on every device.
 *
 * The cart panel wrote out three buttons by hand and the mobile sheet mapped
 * over the same three with a different palette — the phone's selected tab came
 * out in the theme's teal while every other selected thing in the till is amber.
 */
function OrderTypeTabs({
  value,
  onChange,
  deliveryEnabled = true,
}: {
  value: OrderType;
  onChange: (next: OrderType) => void;
  /** The domain refuses delivery orders when the feature is off; the till does not offer the tab. */
  deliveryEnabled?: boolean;
}) {
  const tabs = deliveryEnabled
    ? ORDER_TYPE_TABS
    : ORDER_TYPE_TABS.filter((tab) => tab.value !== "delivery");
  return (
    <div
      className="mb-3 grid gap-2 text-sm font-medium"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      role="group"
      aria-label="نوع سفارش"
    >
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          aria-pressed={value === tab.value}
          onClick={() => onChange(tab.value)}
          className={`min-h-12 rounded-lg px-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 ${
            value === tab.value
              ? "bg-amber-100 dark:bg-amber-500/20 font-bold text-amber-700 dark:text-amber-300"
              : "bg-muted text-muted-foreground hover:text-foreground"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/** What each unmet requirement says on the button that is waiting for it. */
const BLOCKER_LABELS: Record<PosCheckoutRequirement, string> = {
  empty_cart: "ابتدا آیتمی به سبد اضافه کنید",
  table_required: "انتخاب میز و ادامه",
  delivery_address_required: "آدرس تحویل را وارد کنید",
};

/**
 * The end of the walkthrough: keep the order open, or take the money now.
 *
 * Both buttons live here so the cart panel and the mobile sheet can never offer
 * different wording or a different disabled rule — they used to be two copies.
 * A missing table does *not* disable them: it relabels them, and the press opens
 * the table prompt and then carries on into the checkout it interrupted.
 */
function CheckoutActions({
  blocker,
  busy,
  onPay,
  onOpenOrder,
}: {
  blocker: PosCheckoutRequirement | null;
  busy: boolean;
  onPay: () => void;
  onOpenOrder: () => void;
}) {
  const stopped =
    blocker === "empty_cart" || blocker === "delivery_address_required";
  const disabled = busy || stopped;

  return (
    <>
      <button
        type="button"
        onClick={onPay}
        disabled={disabled}
        className="mt-3 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55 motion-reduce:transition-none"
      >
        <ReceiptTextIcon className="size-5" aria-hidden="true" />
        {blocker ? BLOCKER_LABELS[blocker] : "دریافت وجه و تکمیل"}
      </button>
      <button
        type="button"
        onClick={onOpenOrder}
        disabled={disabled}
        className="mt-2 min-h-12 w-full rounded-xl border border-border/80 bg-card px-4 text-sm font-semibold text-muted-foreground transition duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 disabled:opacity-55 motion-reduce:transition-none"
      >
        {busy ? "در حال ثبت…" : "ثبت سفارش باز (بدون دریافت وجه)"}
      </button>
    </>
  );
}

/**
 * Which table this sale is for, in the desktop panel and the mobile sheet alike.
 * The row states the answer so it can be read without reopening anything, and a
 * press hands the question to the one picker — this deliberately draws no grid
 * of its own, which is how the two used to drift apart.
 */
function TableField({
  label,
  chosen,
  occupied,
  onPick,
}: {
  label: string;
  chosen: boolean;
  occupied: boolean;
  onPick: () => void;
}) {
  return (
    <div>
      <span className="block text-xs font-semibold text-muted-foreground">
        میز
      </span>
      <button
        type="button"
        onClick={onPick}
        className={
          "mt-1 flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 dark:focus-visible:ring-amber-400/45 " +
          (chosen
            ? "border-amber-500 dark:border-amber-500/60 bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300"
            : "border-border/80 bg-muted text-muted-foreground hover:border-amber-500/60 dark:hover:border-amber-500/60")
        }
      >
        <span className="min-w-0 truncate">{label}</span>
        <span className="shrink-0 text-xs font-semibold text-amber-700 dark:text-amber-300">
          {chosen ? "تغییر میز" : "انتخاب میز"}
        </span>
      </button>
      {occupied ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          این میز مهمان دارد؛ این سفارش صورت‌حساب جداگانهٔ خودش را می‌گیرد.
        </p>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div
      className={`flex justify-between ${bold ? "text-base font-bold" : "text-muted-foreground"}`}
    >
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
