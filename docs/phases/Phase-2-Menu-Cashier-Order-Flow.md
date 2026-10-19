# Phase 2 — Menu & Cashier Order Flow

**Project:** Cafe/Restaurant POS
**Depends on:** Phase 0 (Foundation), Phase 1 (Setup Wizard)
**Goal:** A cashier can build and submit a correct order, dine-in or takeaway. No printing, no ledger posting, no inventory deduction yet — just correct order records.

---

## Scope

- CRUD: categories, menu items, modifiers (beyond what the wizard's import created — ongoing management)
- Cashier POS screen: item grid, cart, quantity adjust, modifiers, discounts
- Order type selection: dine-in (requires table — table picker can be a simple stub list here, real floor plan comes in Phase 3) or takeaway (issues queue number)
- Order submission creates correct `Orders` + `OrderItems` records
- Basic order status field present (`open`) — full state machine comes with kitchen/waiter in Phase 4

## Out of scope (later phases)

- Real floor plan / table map (Phase 3)
- Reservations (Phase 3)
- Waiter app, kitchen display (Phase 4)
- Printing (Phase 5)
- Inventory deduction (Phase 6)
- Ledger posting (Phase 7)

## Exit criteria

- A cashier can add items with modifiers to a cart, apply a discount, and submit either a dine-in order (against a stub table) or a takeaway order (gets a queue number)
- Order records are correct and queryable in the DB
- Menu CRUD works independently of the setup wizard's initial import

---

## Questions to answer before/during this phase

1. **Discounts** — what discount types do you need: percentage off, fixed amount off, specific item free, manager-approval-required above a threshold?
2. **Modifiers** — are modifiers simple price add-ons (e.g. "extra shot +5000 rial"), or do some modifiers also need to affect inventory deduction later (e.g. "oat milk" swaps an ingredient)? This affects the Recipe/BOM design in Phase 6, worth flagging now even if not built yet.
3. **Menu structure depth** — just Category → Item → Modifier, or do you need sub-categories / combo items (e.g. a "breakfast set" bundling multiple items at a special price)?
4. **Order editing** — can a cashier edit/void items on an order after submission but before payment? What about after payment (refunds)?
5. **Queue numbers for takeaway** — reset daily starting at 1, or continuously incrementing? Any format preference (e.g. "T-042")?
6. **Price changes** — if a menu item's price changes, should already-open orders keep the old price or update live?

---

## Decisions on Phase 2 open questions

Defaults chosen to keep moving; each is easy to revisit.

1. **Discounts** — order-level only, two types: percent off or fixed amount off (`orders.discount_type` + `discount_value`, alongside the already-computed `orders.discount` Rial amount). No per-item "free item" or manager-approval threshold in v1 — the schema doesn't block adding either later. A discount is distributed proportionally across cart lines so each line's tax is computed on its own category rate against its post-discount share (`src/lib/orders.ts`).
2. **Modifiers** — price add-ons only in this phase (`modifiers.price_delta`, may be negative). The schema doesn't yet link a modifier to an inventory item/ingredient swap; that mapping is deferred to the Recipe/BOM design in Phase 6, as flagged.
3. **Menu structure depth** — Category → Item → Modifier Group → Modifier, matching the existing schema. No sub-categories or combo/bundle items in v1.
4. **Order editing** — a cashier can add items, change an item's quantity, or void an item/the whole order while the order's status is `open`. There is no payment/checkout step in this phase (the `payments` table arrives with the order state machine in Phase 4), so "after payment" editing and refunds aren't addressed yet.
5. **Queue numbers for takeaway** — reused from the same per-location, continuously-incrementing `orders.order_number` (never resets), atomically assigned via a small `order_number_counters` table. Takeaway orders display as `T-{number}` (e.g. `T-42`), dine-in as `#{number}` (`formatQueueLabel` in `src/lib/orders.ts`).
6. **Price changes** — `order_items.unit_price` is a snapshot taken at order creation and is never touched by later menu price edits; already-open orders keep the old price. Category `tax_rate` is *not* snapshotted (mirroring how the rest of the app already keeps `tax_rate` live on the category rather than per-sale), so a tax rate change is picked up by any later recompute (adding/voiding an item, editing the discount) on still-open orders — an accepted, documented looseness.

## Where exit criteria are satisfied

| Criterion | Where |
|---|---|
| Cashier adds items with modifiers, applies a discount, submits dine-in (stub table) or takeaway (queue number) | `/accounting/pos` (`src/app/dashboard/pos/pos-screen.tsx`) → `POST /api/orders` |
| Order records correct and queryable | `orders` + `order_items` + `order_item_modifiers` (migration `0003_menu_cashier_order_flow.sql`); view/edit in the orders dialog at `/accounting/orders` (`/dashboard/orders/[id]` deep links redirect there) |
| Menu CRUD independent of the wizard's import | `/accounting/menu` (`src/app/(app)/accounting/menu/menu-workspace.tsx`) → `/api/menu/categories`, `/api/menu/items`, `/api/menu/modifier-groups`, `/api/menu/modifiers`, `/api/menu/item-modifier-groups` |
