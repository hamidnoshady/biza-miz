// @vitest-environment jsdom

/**
 * Issue #910 — per-item add-on order on *every* surface that offers add-ons.
 *
 * `buildRestaurantMenuIndex` decides the order once (the item's own attachment
 * order, proven against real rows in
 * `integration/menu-ordering-precedence.integration.test.ts`). Three screens
 * consume it — the till (`pos-screen.tsx`), the waiter panel
 * (`table-order-panel.tsx`) and the open-order editor
 * (`order-detail-modal.tsx`) — and each one hands the resolved groups to the
 * same `ModifierPicker`, which renders them in the order it receives.
 *
 * So this file asserts the two halves a cashier can actually see:
 *
 *   1. the picker renders groups in the order given, with no sorting of its
 *      own (a second sort would silently override the item's order again);
 *   2. all three surfaces take their groups from `menuIndex.groupsByItem` and
 *      none re-sorts by the group's global position — the regression that made
 *      the editor's arrows a lie.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModifierGroupWithModifiers } from "./modifier-picker";
import { ModifierPicker } from "./modifier-picker";

beforeEach(() => {
  // The picker fetches the item's past notes on mount; nothing here depends on
  // them, and an unhandled rejection would fail the run.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ notes: [] }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function group(id: string, name: string, optionCount = 1): ModifierGroupWithModifiers {
  return {
    id,
    name,
    minSelect: 0,
    maxSelect: optionCount,
    modifiers: Array.from({ length: optionCount }, (_, index) => ({
      id: `${id}-option-${index}`,
      name: `${name} گزینه ${index + 1}`,
      priceDelta: 0,
    })),
  };
}

/** The add-on groups this item carries, in the order the index resolved. */
const ITEM_ORDER = [group("extras", "افزودنی‌ها"), group("size", "اندازه"), group("milk", "شیر")];

describe("ModifierPicker — renders the order it is given", () => {
  it("keeps the caller's group order instead of re-sorting it", () => {
    render(
      <ModifierPicker itemName="لاته" groups={ITEM_ORDER} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );

    const groups = ITEM_ORDER.map((entry) =>
      screen.getByText(entry.name, { selector: "span" }),
    );
    // compareDocumentPosition: FOLLOWING (4) means the first node comes before
    // the second in the document, i.e. the picker rendered the given order.
    expect(groups[0].compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(groups[1].compareDocumentPosition(groups[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders a reordered list in the new order", () => {
    const reversed = [...ITEM_ORDER].reverse();
    render(
      <ModifierPicker itemName="لاته" groups={reversed} onCancel={vi.fn()} onConfirm={vi.fn()} />,
    );

    const groups = reversed.map((entry) =>
      screen.getByText(entry.name, { selector: "span" }),
    );
    expect(groups[0].compareDocumentPosition(groups[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(groups[1].compareDocumentPosition(groups[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the three surfaces resolve add-ons through the shared index", () => {
  const SURFACES = [
    { name: "the till", file: "pos/pos-screen.tsx", resolver: "groupsByItem" },
    { name: "the waiter panel", file: "waiter/table-order-panel.tsx", resolver: "groupsByItem" },
    { name: "the open-order editor", file: "orders/order-detail-modal.tsx", resolver: "groupsByItem" },
  ] as const;

  function source(file: string): string {
    return readFileSync(join(__dirname, file), "utf8");
  }

  it.each(SURFACES)("$name builds its add-on groups from buildRestaurantMenuIndex", ({ file, resolver }) => {
    const text = source(file);
    expect(text).toContain("buildRestaurantMenuIndex");
    expect(text).toContain(`menuIndex?.${resolver}.get(`);
  });

  it.each(SURFACES)("$name renders ModifierPicker with the resolved order", ({ file }) => {
    const text = source(file);
    expect(text).toContain("ModifierPicker");
    // The picker receives the resolved array and nothing that sorts it again.
    expect(text).not.toMatch(/groupsByItem\.get\([^)]*\)[^;]*\.sort\(/);
    expect(text).not.toMatch(/groups[^;]*\.sort\(\s*\(\s*a\s*,\s*b\s*\)\s*=>\s*a\.sortOrder/);
  });
});
