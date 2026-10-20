import { describe, expect, it } from "vitest";
import { classifyStatusReplay, replayPermissionsFor } from "./offline-sync";

describe("replayPermissionsFor", () => {
  it("uses action-specific route permissions rather than registry roles", () => {
    expect(replayPermissionsFor("order.create")).toEqual(["orders.create"]);
    expect(replayPermissionsFor("order.add_items")).toEqual(["orders.create"]);
    expect(replayPermissionsFor("order_item.status", "preparing")).toEqual(["kitchen.view"]);
    expect(replayPermissionsFor("order_item.status", "ready")).toEqual(["kitchen.view"]);
    expect(replayPermissionsFor("order_item.status", "served")).toEqual(["orders.view"]);
    expect(replayPermissionsFor("order_item.status", "voided")).toBeNull();
  });
});

describe("classifyStatusReplay", () => {
  it("applies only the permitted transition family", () => {
    expect(classifyStatusReplay("sent", "preparing", true, false)).toBe("apply");
    expect(classifyStatusReplay("preparing", "ready", true, false)).toBe("apply");
    expect(classifyStatusReplay("ready", "served", false, true)).toBe("apply");
    expect(classifyStatusReplay("sent", "preparing", false, true)).toBe("conflict");
    expect(classifyStatusReplay("ready", "served", true, false)).toBe("conflict");
  });

  it("recognizes retries without allowing them to skip transitions", () => {
    expect(classifyStatusReplay("preparing", "preparing", true, false)).toBe("duplicate");
    expect(classifyStatusReplay("served", "served", false, true)).toBe("duplicate");
    expect(classifyStatusReplay("ready", "preparing", true, false)).toBe("conflict");
    expect(classifyStatusReplay("voided", "preparing", true, false)).toBe("conflict");
  });

  it("does not let a broad permission substitute for the required capability", () => {
    expect(classifyStatusReplay("ready", "served", true, false)).toBe("conflict");
    expect(classifyStatusReplay("sent", "preparing", false, true)).toBe("conflict");
  });
});
