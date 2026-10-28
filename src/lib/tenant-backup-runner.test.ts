import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentArtifactCustodyKey: vi.fn(),
  query: vi.fn(),
  getMasterKey: vi.fn<() => Buffer | null>(),
}));

vi.mock("./tenant-backup-artifacts-service", () => ({
  currentArtifactCustodyKey: mocks.currentArtifactCustodyKey,
  artifactSecretForVersion: vi.fn(async () => ({ ok: true, version: 1, secret: "k1" })),
  installedSchemaVersion: vi.fn(async () => 268),
  recordTenantArtifact: vi.fn(),
  resolveOwnedArtifact: vi.fn(),
}));
vi.mock("./db", () => ({ query: mocks.query }));
vi.mock("./master-key", () => ({ getMasterKey: () => mocks.getMasterKey() }));

import {
  artifactEncryptionFor,
  buildComponentInventory,
  capturedAtOf,
  decryptionSecretFor,
  mediaAttachmentCount,
  physicalComponentInventory,
} from "./tenant-backup-runner";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMasterKey.mockReturnValue(Buffer.alloc(32, 3));
});

describe("artifactEncryptionFor", () => {
  it("prefers managed custody — a tenant-held passphrase is the fallback, not the rule", async () => {
    mocks.currentArtifactCustodyKey.mockResolvedValue({ ok: true, version: 4, secret: "managed-secret" });
    const choice = await artifactEncryptionFor("b1", "owner-passphrase");
    expect(choice).toEqual({
      ok: true,
      encryption: { scheme: "managed_envelope_v1", keyVersion: 4, secret: "managed-secret" },
    });
  });

  it("falls back to the Owner's passphrase when the platform holds no key", async () => {
    mocks.currentArtifactCustodyKey.mockResolvedValue({ ok: false, error: "backup_encryption_unconfigured" });
    const choice = await artifactEncryptionFor("b1", "owner-passphrase");
    expect(choice).toEqual({
      ok: true,
      encryption: { scheme: "legacy_passphrase_v1", keyVersion: null, secret: "owner-passphrase" },
    });
  });

  it("refuses to write an unencrypted artifact when there is no secret at all", async () => {
    mocks.currentArtifactCustodyKey.mockResolvedValue({ ok: false, error: "backup_encryption_unconfigured" });
    const choice = await artifactEncryptionFor("b1", "");
    expect(choice).toEqual({ ok: false, error: "backup_encryption_unconfigured" });
  });
});

describe("decryptionSecretFor", () => {
  it("uses the artifact's own key generation, not the current one", async () => {
    const result = await decryptionSecretFor(
      "b1",
      { encryption: "managed_envelope_v1", keyVersion: 2, manifest: null },
      "",
    );
    expect(result).toEqual({ ok: true, secret: "k1" });
  });

  it("needs the Owner's passphrase for a legacy artifact", async () => {
    expect(
      await decryptionSecretFor("b1", { encryption: "legacy_passphrase_v1", keyVersion: null, manifest: null }, ""),
    ).toEqual({ ok: false, error: "passphrase_required" });
    expect(
      await decryptionSecretFor(
        "b1",
        { encryption: "legacy_passphrase_v1", keyVersion: null, manifest: null },
        "owner-passphrase",
      ),
    ).toEqual({ ok: true, secret: "owner-passphrase" });
  });

  it("refuses a managed artifact with no recorded generation", async () => {
    expect(
      await decryptionSecretFor("b1", { encryption: "managed_envelope_v1", keyVersion: null, manifest: null }, ""),
    ).toEqual({ ok: false, error: "backup_key_missing" });
  });
});

describe("buildComponentInventory", () => {
  it("files each captured table under the component it belongs to", () => {
    const components = buildComponentInventory([
      { name: "orders", rows: 12 },
      { name: "order_items", rows: 40 },
      { name: "website_pages", rows: 3 },
      { name: "media_assets", rows: 5 },
      { name: "wp_posts", rows: 2 },
      { name: "aec_boq_versions", rows: 7 },
      { name: "settings", rows: 1 },
    ]);
    const byKey = Object.fromEntries(components.map((component) => [component.key, component]));
    expect(byKey["accounting.core"].rows).toBe(52);
    expect(byKey["website.cms"].rows).toBe(3);
    expect(byKey["media.metadata"].rows).toBe(5);
    expect(byKey["website.wp"].rows).toBe(2);
    // Nothing captured is filed under a component whose name would lie.
    expect(byKey["app.data"].rows).toBe(7);
    expect(byKey["shared.settings"].rows).toBe(1);
    // Captured components are `included`; the external/omitted ones are declared
    // separately (asserted in the next case).
    expect(
      components.filter((component) => component.state === "included").map((component) => component.key).sort(),
    ).toEqual(["accounting.core", "app.data", "media.metadata", "shared.settings", "website.cms", "website.wp"]);
  });

  it("declares what it does not capture instead of omitting it", () => {
    const components = buildComponentInventory([{ name: "orders", rows: 1 }], 9);
    const states = Object.fromEntries(components.map((component) => [component.key, component.state]));
    expect(states["media.attachments"]).toBe("excluded");
    expect(states["external.woocommerce"]).toBe("external");
    expect(states["external.eshobe_assets"]).toBe("external");
  });

  it("drops the attachments component when the business has none", () => {
    const components = buildComponentInventory([{ name: "orders", rows: 1 }], 0);
    expect(components.some((component) => component.key === "media.attachments")).toBe(false);
  });

  it("keeps an empty component captured rather than missing", () => {
    const components = buildComponentInventory([{ name: "crm_contacts", rows: 0 }]);
    expect(components).toContainEqual({ key: "crm.core", state: "included", rows: 0 });
  });
});

describe("physicalComponentInventory", () => {
  it("declares the whole local database captured, plus the external gaps", () => {
    const components = physicalComponentInventory();
    const states = Object.fromEntries(components.map((component) => [component.key, component.state]));
    expect(states["accounting.core"]).toBe("included");
    expect(states["app.data"]).toBe("included");
    expect(states["external.woocommerce"]).toBe("external");
  });
});

describe("mediaAttachmentCount", () => {
  it("counts live attachments for the business", async () => {
    mocks.query.mockResolvedValue({ rows: [{ total: "17" }] });
    expect(await mediaAttachmentCount("b1")).toBe(17);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("media_assets"), ["b1"]);
  });

  it("reports zero on an installation without a media table", async () => {
    mocks.query.mockRejectedValue(new Error('relation "media_assets" does not exist'));
    expect(await mediaAttachmentCount("b1")).toBe(0);
  });
});

describe("capturedAtOf", () => {
  it("reads the artifact's own UTC stamp", () => {
    expect(capturedAtOf("biz-20261028-090102-local.dump.enc").toISOString()).toBe("2026-10-28T09:01:02.000Z");
  });

  it("falls back to now for a name that carries no stamp", () => {
    const before = Date.now();
    const parsed = capturedAtOf("artifact.dump.enc").getTime();
    expect(parsed).toBeGreaterThanOrEqual(before - 1000);
  });
});
