import { describe, expect, it } from "vitest";
import { DEFAULT_BACKUP_CONFIG } from "./backup";
import { applyTenantBackupSettings, tenantBackupSettings, tenantBackupError } from "./tenant-backup-contract";

const current = { ...DEFAULT_BACKUP_CONFIG, passphrase: "historic-secret", directory: "/private", cloud: { ...DEFAULT_BACKUP_CONFIG.cloud, endpoint: "https://private", accessKeyId: "private-key" } };
const schedule = { enabled: true, intervalHours: 12, anchorTime: "04:30" };
describe("managed tenant backup contract", () => {
  it("serializes only tenant settings", () => {
    expect(tenantBackupSettings(current)).toEqual({ enabled: false, intervalHours: 24, anchorTime: "03:30", localRetention: 14 });
  });
  it("preserves historic encryption and operator infrastructure on schedule changes", () => {
    const result = applyTenantBackupSettings(current, schedule);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.cloud).toEqual(current.cloud);
      expect(result.config.passphrase).toBe(current.passphrase);
      expect(result.config.directory).toBe(current.directory);
      expect(result.config.localRetention).toBe(current.localRetention);
    }
  });
  for (const field of ["cloud", "passphrase", "encryptLocal", "directory", "localRetention", "endpoint", "__proto__"]) {
    it(`rejects tenant override ${field}`, () => {
      expect(applyTenantBackupSettings(current, { ...schedule, [field]: {} })).toEqual({ ok: false, error: "managed_backup_settings_only" });
    });
  }
  for (const input of [null, [], "bad", { ...schedule, enabled: "false" }, { ...schedule, intervalHours: 0 }, { ...schedule, anchorTime: "24:00" }]) {
    it(`rejects malformed schedule ${JSON.stringify(input)}`, () => {
      expect(applyTenantBackupSettings(current, input).ok).toBe(false);
    });
  }
  it("never passes supplier error details through", () => {
    expect(tenantBackupError("https://vendor/private?secret=key")).toBe("backup_operation_failed");
    expect(tenantBackupError(null)).toBeNull();
  });
});
