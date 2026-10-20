import { beforeEach, expect, it, vi } from "vitest";
import type { SessionPayload } from "../auth-edge";
import { getAccessibleConnection, listAccessibleConnections } from "./connection-access";
import { accessibleLocationsFor } from "../setup-state";
import { getConnection, listConnections } from "./connections-service";
vi.mock("../db", () => ({ query: vi.fn() }));
vi.mock("../setup-state", () => ({ accessibleLocationsFor: vi.fn() }));
vi.mock("./connections-service", () => ({ getConnection: vi.fn(), listConnections: vi.fn() }));
const session = { sub: "manager", businessId: "tenant-a" } as SessionPayload;
beforeEach(() => {
  vi.mocked(accessibleLocationsFor).mockResolvedValue({ locations: [{ id: "a1" }], businessLocationCount: 2 } as never);
});
it("filters operational lists and forbids a foreign/unassigned branch or business-wide link", async () => {
  vi.mocked(listConnections).mockResolvedValue([
    { id: "woo", provider: "woocommerce", locationId: "a1" },
    { id: "holoo", provider: "holoo", locationId: "a1" },
    { id: "other", locationId: "a2" }, { id: "unbound", locationId: null },
  ] as never);
  expect((await listAccessibleConnections(session)).map((c) => c.id)).toEqual(["woo", "holoo"]);
  for (const location_id of ["a2", "b1", null]) {
    vi.mocked(getConnection).mockResolvedValue({ location_id } as never);
    expect(await getAccessibleConnection(session, "id")).toBeNull();
    expect(getConnection).toHaveBeenCalledWith("tenant-a", "id");
  }
  vi.mocked(getConnection).mockResolvedValue({ location_id: "a1" } as never);
  expect(await getAccessibleConnection(session, "id")).not.toBeNull();
});
it("permits an unbound legacy link only with live access to every business branch", async () => {
  vi.mocked(accessibleLocationsFor).mockResolvedValue({ locations: [{ id: "a1" }, { id: "a2" }], businessLocationCount: 2 } as never);
  vi.mocked(getConnection).mockResolvedValue({ location_id: null } as never);
  expect(await getAccessibleConnection(session, "id")).not.toBeNull();
});
