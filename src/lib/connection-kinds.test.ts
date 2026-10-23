import { describe, expect, it } from "vitest";
import {
  CONNECTION_KINDS,
  isConnectionKindKey,
  resolveConnectionKind,
  visibleConnectionKinds,
} from "./connection-kinds";
import { effectivePermissions, PERMISSIONS } from "./permissions";
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
        "telegram",
      ],
    );
  });

  it("gives a Manager the connections their role can use, in hub order", () => {
    // Managers can connect their store/site and link their own Telegram
    // identity. The remaining machine credentials still stay owner-only.
    expect(
      visibleConnectionKinds({ role: "manager" }).map((k) => k.key),
    ).toEqual(["woocommerce", "website", "holoo", "telegram"]);
  });

  it("shows the personal Telegram account link to every active membership role", () => {
    for (const role of ["owner", "admin", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      expect(visibleConnectionKinds({ role }).map((kind) => kind.key)).toContain("telegram");
    }
    expect(visibleConnectionKinds({ role: "cashier" }).map((kind) => kind.key)).toEqual(["telegram"]);
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
    expect(owner.find((kind) => kind.key === "telegram")?.feature).toBe("integrations");
    // Cloud sync is now a feature-locked section inside the unified Desktop &
    // Cloud surface, rather than a second top-level tab.
    expect(owner.some((k) => k.feature === "api_platform")).toBe(true);
    // …and the desktop tab has no flag at all: connecting the desktop app is
    // not something a business buys.
    expect(owner.find((k) => k.key === "desktop")?.feature).toBeUndefined();
  });
});

it("intentionally gives admin operational tabs and the personal Telegram link, but never machine credentials", () => {
  expect(visibleConnectionKinds({ role: "admin" }).map((k) => k.key)).toEqual(["woocommerce", "website", "holoo", "telegram"]);
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

it("hides revoked operational forms but retains the personal Telegram link", () => {
  const permissions = effectivePermissions("admin", { revoked: [PERMISSIONS.integrationsView, PERMISSIONS.cmsView] });
  expect(visibleConnectionKinds({ role: "admin", permissions }).map((kind) => kind.key)).toEqual(["telegram"]);
});

it("uses explicitly delegated live operational grants for discovery without granting machine credentials", () => {
  const permissions = effectivePermissions("cashier", { granted: [PERMISSIONS.integrationsView, PERMISSIONS.apiManage, PERMISSIONS.mcpManage] });
  expect(visibleConnectionKinds({ role: "cashier", permissions }).map((k) => k.key)).toEqual(["woocommerce", "holoo", "telegram"]);
});
