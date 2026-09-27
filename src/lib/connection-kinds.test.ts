import { describe, expect, it } from "vitest";
import {
  CONNECTION_KINDS,
  isConnectionKindKey,
  resolveConnectionKind,
  visibleConnectionKinds,
} from "./connection-kinds";
import { INDUSTRIES } from "./industries";

describe("visibleConnectionKinds", () => {
  it("gives an Owner every technical connection, websites included", () => {
    // The hub is the one home for *every* technical connection — including
    // the two website ones, which the managers that use them link to. Order
    // is the hub's tab order: the connections a business meets first come
    // first.
    expect(visibleConnectionKinds({ role: "owner" }).map((k) => k.key)).toEqual(
      [
        "desktop",
        "local_devices",
        "woocommerce",
        "website",
        "holoo",
        "mcp",
        "api",
      ],
    );
  });

  it("gives a Manager the connections their role can use, in hub order", () => {
    // Manager work: the WooCommerce store, the Eshobe CMS site, Holoo. Every
    // other tab hands out a credential that reaches a whole business: a
    // pairing code redeems a full snapshot, an API key reads a branch's
    // orders, menu, inventory and reports, an MCP connection can be granted
    // the right to change them, and the server-sync token reaches the whole
    // central dataset.
    expect(
      visibleConnectionKinds({ role: "manager" }).map((k) => k.key),
    ).toEqual(["woocommerce", "website", "holoo"]);
  });

  it("gives a floor role nothing, so the page redirects rather than rendering empty", () => {
    for (const role of [
      "cashier",
      "waiter",
      "kitchen",
      "accountant",
    ] as const) {
      expect(visibleConnectionKinds({ role })).toEqual([]);
    }
  });

  it("keeps every technical tab for every industry — `connections` is a core module", () => {
    for (const industry of INDUSTRIES) {
      expect(visibleConnectionKinds({ role: "owner", industry })).toHaveLength(
        CONNECTION_KINDS.length,
      );
    }
  });

  it("does not filter on the feature flag — a locked tab is previewed, not hidden", () => {
    // The flag decides whether the tab is *inert*, not whether it exists; a
    // business cannot ask for something it is never shown.
    const owner = visibleConnectionKinds({ role: "owner" });
    expect(owner.some((k) => k.feature === "integrations")).toBe(true);
    // Cloud sync is now a feature-locked section inside the unified Desktop &
    // Cloud surface, rather than a second top-level tab.
    expect(owner.some((k) => k.feature === "api_platform")).toBe(true);
    // …and the desktop tab has no flag at all: connecting the desktop app is
    // not something a business buys.
    expect(owner.find((k) => k.key === "desktop")?.feature).toBeUndefined();
  });
});

describe("resolveConnectionKind", () => {
  const owner = visibleConnectionKinds({ role: "owner" });
  const manager = visibleConnectionKinds({ role: "manager" });

  it("honours a valid, visible request", () => {
    expect(resolveConnectionKind("holoo", owner)).toBe("holoo");
    expect(resolveConnectionKind("api", owner)).toBe("api");
    expect(resolveConnectionKind("server_sync", owner)).toBe("desktop");
    expect(resolveConnectionKind("woocommerce", manager)).toBe("woocommerce");
  });

  it("falls back to the first visible tab for anything it cannot honour", () => {
    expect(resolveConnectionKind(null, owner)).toBe("desktop");
    expect(resolveConnectionKind(undefined, owner)).toBe("desktop");
    expect(resolveConnectionKind("nonsense", owner)).toBe("desktop");
  });

  it("never lands a Manager on a tab their role cannot see", () => {
    // A shared link to ?tab=api must not render an owner-only credential form.
    expect(resolveConnectionKind("api", manager)).toBe("woocommerce");
    expect(resolveConnectionKind("desktop", manager)).toBe("woocommerce");
    expect(resolveConnectionKind("server_sync", manager)).toBe("woocommerce");
  });

  it("returns null when there is nothing to show", () => {
    expect(resolveConnectionKind("desktop", [])).toBeNull();
  });
});

describe("isConnectionKindKey", () => {
  it("recognises exactly the declared keys", () => {
    expect(
      CONNECTION_KINDS.every((kind) => isConnectionKindKey(kind.key)),
    ).toBe(true);
    expect(isConnectionKindKey("integrations")).toBe(false);
    expect(isConnectionKindKey(null)).toBe(false);
    expect(isConnectionKindKey(undefined)).toBe(false);
  });
});
