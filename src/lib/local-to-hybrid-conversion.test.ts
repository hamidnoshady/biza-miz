import { describe, expect, it } from "vitest";
import { applyIdentityMap, conversionExport } from "../../scripts/convert-local-to-hybrid";

describe("Local to Hybrid conversion export", () => {
  it("excludes device-local tables and settings without dropping operational data", () => {
    const result = conversionExport([
      { name: "orders", columns: ["id"], rows: [{ id: "order-1" }] },
      { name: "printers", columns: ["id"], rows: [{ id: "printer-1" }] },
      { name: "cloud_exception_outbox", columns: ["event_id"], rows: [{ event_id: "event-1" }] },
      { name: "cloud_exception_response_receipts", columns: ["response_id"], rows: [{ response_id: "response-1" }] },
      { name: "settings", columns: ["key", "value"], rows: [
        { key: "backup.config", value: { path: "C:/private" } },
        { key: "server_sync.config", value: { token: "secret" } },
        { key: "tax.config", value: { defaultRate: 10 } },
      ] },
    ]);
    expect(result.map((table) => table.name)).toEqual(["orders", "settings"]);
    expect(result[1].rows).toEqual([{ key: "tax.config", value: { defaultRate: 10 } }]);
  });

  it("never exports Local credentials and disables identities without an explicit Cloud mapping", () => {
    const result = applyIdentityMap(conversionExport([
      { name: "employee_credentials", columns: ["employee_id", "secret_hash"], rows: [{ employee_id: "owner", secret_hash: "pin-secret" }] },
      { name: "employee_sessions", columns: ["employee_id", "token_hash"], rows: [{ employee_id: "owner", token_hash: "session-secret" }] },
      { name: "users", columns: ["id", "platform_user_id", "role", "is_active", "membership_status", "pin_hash", "password_hash"], rows: [
        { id: "owner", platform_user_id: "local-owner", role: "owner", is_active: true, membership_status: "active", pin_hash: "pin", password_hash: "password" },
        { id: "staff", platform_user_id: "local-staff", role: "staff", is_active: true, membership_status: "active", pin_hash: "pin2", password_hash: null },
      ] },
    ]), { owner: "10000000-0000-4000-8000-000000000001" });

    expect(result.map((table) => table.name)).toEqual(["users"]);
    expect(result[0].rows).toEqual([
      expect.objectContaining({ id: "owner", platform_user_id: "10000000-0000-4000-8000-000000000001", is_active: true, pin_hash: null, password_hash: null }),
      expect.objectContaining({ id: "staff", platform_user_id: null, is_active: false, membership_status: "offboarded", pin_hash: null, password_hash: null }),
    ]);
  });
});
