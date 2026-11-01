// @vitest-environment jsdom

/**
 * WooCommerce order status truthfulness (issue #1215 / P1‑3): the store's own
 * registered display names first, the seven canonical Persian labels next, and
 * a *clearly marked raw slug* — never a prettified guess — when no real name
 * could be read.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CANONICAL_ORDER_STATUSES,
  orderStatusChoices,
  orderStatusLabel,
  orderStatusNamed,
  orderStatusRegistry,
  orderStatusTone,
} from "./order-status";
import { OrderStatusBadge } from "./order-status-badge";

/** What the plugin reports (`wc_get_order_statuses()` → `[{slug,label}]`). */
const CAPABILITIES = {
  orderStatuses: [
    { slug: "processing", label: "در حال آماده‌سازی" },
    { slug: "shipped", label: "ارسال شد" },
    { slug: "awaiting-pickup", label: "در انتظار تحویل" },
  ],
};

afterEach(cleanup);

describe("orderStatusRegistry", () => {
  it("reads the registry the plugin reported, keyed by its normalized slug", () => {
    const registry = orderStatusRegistry(CAPABILITIES);
    expect(registry.get("shipped")).toBe("ارسال شد");
    expect(registry.get("processing")).toBe("در حال آماده‌سازی");
    expect(registry.size).toBe(3);
  });

  it("is empty for a plugin that predates the registry, and never invents a name", () => {
    for (const caps of [null, undefined, {}, { orderStatuses: [] }, { orderStatuses: "shipped" }]) {
      expect(orderStatusRegistry(caps as never).size).toBe(0);
    }
  });
});

describe("orderStatusLabel", () => {
  const registry = orderStatusRegistry(CAPABILITIES);

  it("prefers the store's own display name, even for a canonical status", () => {
    expect(orderStatusLabel("processing", registry)).toBe("در حال آماده‌سازی");
    expect(orderStatusLabel("shipped", registry)).toBe("ارسال شد");
  });

  it("uses the canonical Persian label when the store reported nothing", () => {
    expect(orderStatusLabel("on-hold", registry)).toBe("معلق");
    expect(orderStatusLabel("wc-completed")).toBe("تکمیل‌شده");
  });

  it("shows an unknown status as its raw slug, not as a prettified guess", () => {
    expect(orderStatusLabel("awaiting_pickup")).toBe("awaiting_pickup");
    expect(orderStatusLabel("wc-awaiting-pickup")).toBe("awaiting-pickup");
    expect(orderStatusLabel("")).toBe("وضعیت نامشخص");
  });

  it("knows which labels are real names and which are raw slugs", () => {
    expect(orderStatusNamed("shipped", registry)).toBe(true);
    expect(orderStatusNamed("completed", registry)).toBe(true);
    expect(orderStatusNamed("awaiting_pickup", registry)).toBe(false);
    expect(orderStatusNamed("", registry)).toBe(false);
  });
});

describe("orderStatusTone", () => {
  it("tones canonical statuses the same way whichever prefix they arrive with", () => {
    expect(orderStatusTone("completed")).toBe("positive");
    expect(orderStatusTone("wc-processing")).toBe("active");
    expect(orderStatusTone("failed")).toBe("danger");
    expect(orderStatusTone("shipped")).toBe("neutral");
  });
});

describe("orderStatusChoices", () => {
  const registry = orderStatusRegistry(CAPABILITIES);

  it("offers canonical statuses, then those the store registered, then ones it merely used", () => {
    const choices = orderStatusChoices(["wc-refunded", "legacy-status"], registry);
    expect(choices.slice(0, CANONICAL_ORDER_STATUSES.length)).toEqual(CANONICAL_ORDER_STATUSES);
    // Registered but never used on an order — the whole point of the registry.
    expect(choices).toContain("shipped");
    expect(choices).toContain("awaiting-pickup");
    // Used but not registered still stays offerable (the server accepts it).
    expect(choices).toContain("legacy-status");
  });

  it("never repeats a status, whatever spelling or source it came from", () => {
    const choices = orderStatusChoices(["processing", "wc-processing", "completed"], registry);
    expect(new Set(choices).size).toBe(choices.length);
    expect(choices.filter((status) => status === "processing")).toHaveLength(1);
  });

  it("falls back to the canonical seven when the store reported nothing", () => {
    expect(orderStatusChoices([])).toEqual(CANONICAL_ORDER_STATUSES);
  });
});

describe("OrderStatusBadge", () => {
  it("renders the store's own name for a custom status", () => {
    render(<OrderStatusBadge status="shipped" registry={orderStatusRegistry(CAPABILITIES)} />);
    expect(screen.getByText("ارسال شد")).toBeTruthy();
  });

  it("marks a raw slug as unnamed instead of passing a guess off as the store's name", () => {
    render(<OrderStatusBadge status="mystery-status" />);
    expect(screen.getByText("mystery-status")).toBeTruthy();
    expect(screen.getByText(/نام این وضعیت از فروشگاه خوانده نشد/)).toBeTruthy();
  });
});
