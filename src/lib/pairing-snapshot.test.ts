import { describe, expect, it } from "vitest";
import { PAIRING_SNAPSHOT_VERSION, validateSnapshot, type PairingSnapshot } from "./pairing-snapshot";

function validSnapshot(): PairingSnapshot {
  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "کافه بهار",
      slug: "cafe-bahar",
      timezone: "Asia/Tehran",
    },
    location: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "شعبه مرکزی",
      address: null,
      phone: null,
      timezone: "Asia/Tehran",
    },
    locationIdentities: [
      { id: "22222222-2222-2222-2222-222222222222", name: "شعبه مرکزی", timezone: "Asia/Tehran" },
      { id: "aaaaaaaa-1111-1111-1111-111111111111", name: "شعبه دوم", timezone: "Asia/Tehran" },
    ],
    siteDevice: {
      id: "77777777-7777-7777-7777-777777777777",
      publicId: "88888888-8888-8888-8888-888888888888",
      displayName: "Main till server",
    },
    users: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        role: "owner",
        fullName: "حمید",
        email: "owner@example.com",
        customRoleId: null,
        permissions: {},
        isActive: true,
        membershipStatus: "active",
        locationScope: "all",
        defaultLocationId: "22222222-2222-2222-2222-222222222222",
        locationIds: ["22222222-2222-2222-2222-222222222222"],
        membershipRevision: 1,
        cloudIdentityRef: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        credentialMetadata: [{ type: "password", status: "active" }],
      },
    ],
    tenantRoles: [],
    iam: { schemaVersion: 1, lastSequence: 0, stateHash: "a".repeat(64) },
    accounts: [
      { id: "44444444-4444-4444-4444-444444444444", parentCode: null, code: "1000", name: "دارایی", type: "asset" },
    ],
    menu: {
      categories: [
        { id: "55555555-5555-5555-5555-555555555555", name: "نوشیدنی گرم", sortOrder: 0, isActive: true },
      ],
      items: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          categoryId: "55555555-5555-5555-5555-555555555555",
          name: "اسپرسو",
          description: null,
          sku: null,
          price: "850000",
          imageUrl: null,
          imageMediaId: "99999999-9999-9999-9999-999999999999",
          isActive: true,
          sortOrder: 0,
        },
      ],
      mediaAssets: [
        {
          id: "99999999-9999-9999-9999-999999999999",
          kind: "image",
          fileName: "espresso.jpg",
          mimeType: "image/jpeg",
          byteSize: "10240",
          storageKey: "media/11111111-1111-1111-1111-111111111111/99999999-9999-9999-9999-999999999999/file",
          sha256: "a".repeat(64),
        },
      ],
      modifierGroups: [
        { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "شیر", minSelect: 0, maxSelect: 1, isActive: true, sortOrder: 0 },
      ],
      modifiers: [],
      itemModifierGroups: [
        {
          menuItemId: "66666666-6666-6666-6666-666666666666",
          modifierGroupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          minSelectOverride: null,
          maxSelectOverride: 1,
          sortOrder: 0,
          isActive: true,
        },
      ],
    },
    diningTables: [],
    inventory: { items: [], menuIngredients: [], modifierIngredients: [] },
    paymentMethods: [],
    dataClassification: {
      bootstrapMasterData: ["menu"],
      ongoingDomainEvents: ["order.created"],
      siteLocalOperationalData: ["logs"],
      centralOnlyData: ["platform admins"],
      notYetReplicated: ["accounting history"],
    },
    settings: [{ key: "business.prefs", value: { currencyDisplay: "toman" } }],
    features: { inventory: true, ai_assistant: false },
    syncToken: "a".repeat(64),
  };
}

describe("validateSnapshot", () => {
  it("accepts a complete snapshot", () => {
    const result = validateSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.business.slug).toBe("cafe-bahar");
  });

  it("rejects Cloud credential material even when the rest of the snapshot is valid", () => {
    const snapshot = validSnapshot() as PairingSnapshot & { users: Array<PairingSnapshot["users"][number] & { platformUserPasswordHash?: string }> };
    snapshot.users[0].platformUserPasswordHash = "$2b$12$must-never-travel";
    expect(validateSnapshot(snapshot)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a non-object", () => {
    expect(validateSnapshot(null)).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot("nope")).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot([])).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects an unknown version rather than guessing at the shape", () => {
    expect(validateSnapshot({ ...validSnapshot(), version: 999 })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
    expect(validateSnapshot({ ...validSnapshot(), version: undefined })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
  });

  it("rejects a missing business", () => {
    const s = validSnapshot() as unknown as Record<string, unknown>;
    delete s.business;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a business whose id is not a uuid", () => {
    const s = validSnapshot();
    s.business.id = "not-a-uuid";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("carries the business's industry across", () => {
    const s = validSnapshot();
    s.business.industry = "jewelry";
    const result = validateSnapshot(s);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.business.industry).toBe("jewelry");
  });

  it("accepts a snapshot from an older central server that sends no industry", () => {
    // The desktop side then falls back to 'food_service' (pairing-apply.ts),
    // which is exactly what a paired install got before the field existed —
    // so an upgrade must not start rejecting in-flight pairings.
    const s = validSnapshot();
    expect(s.business.industry).toBeUndefined();
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects an industry the app does not know", () => {
    const s = validSnapshot() as unknown as { business: Record<string, unknown> };
    s.business.industry = "bakery";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a location belonging to no business slug/timezone shape", () => {
    const s = validSnapshot() as unknown as Record<string, unknown>;
    s.location = { id: "22222222-2222-2222-2222-222222222222" };
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no users, since there would be nobody to sign in as", () => {
    const s = validSnapshot();
    s.users = [];
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no owner among its users", () => {
    const s = validSnapshot();
    s.users[0].role = "cashier";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a menu item priced as a float, since money is integer Rial", () => {
    const s = validSnapshot();
    s.menu.items[0].price = "12.5";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a negative price", () => {
    const s = validSnapshot();
    s.menu.items[0].price = "-1";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects an item whose photo references an asset that did not travel", () => {
    // menu_items.image_media_id is a real foreign key; a dangling reference
    // would abort the whole pairing transaction at insert time with a raw
    // PG error instead of this clean refusal.
    const s = validSnapshot();
    s.menu.items[0].imageMediaId = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a v4 snapshot that omits the mediaAssets array", () => {
    const s = validSnapshot() as unknown as { menu: Record<string, unknown> };
    delete s.menu.mediaAssets;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("carries the photo reference and its asset row together", () => {
    const s = validSnapshot();
    const result = validateSnapshot(s);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.snapshot.menu.items[0].imageMediaId).toBe(
        "99999999-9999-9999-9999-999999999999",
      );
      expect(result.snapshot.menu.mediaAssets[0].fileName).toBe("espresso.jpg");
    }
  });

  it("rejects link overrides where the per-item min exceeds the max", () => {
    const s = validSnapshot();
    s.menu.itemModifierGroups[0].minSelectOverride = 2;
    s.menu.itemModifierGroups[0].maxSelectOverride = 1;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts link overrides and the 0165 group columns", () => {
    const s = validSnapshot();
    s.menu.modifierGroups[0].isActive = false;
    s.menu.modifierGroups[0].sortOrder = 3;
    s.menu.itemModifierGroups[0].minSelectOverride = 0;
    s.menu.itemModifierGroups[0].maxSelectOverride = 1;
    s.menu.itemModifierGroups[0].sortOrder = 2;
    s.menu.itemModifierGroups[0].isActive = false;
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects a link whose isActive or sortOrder is missing", () => {
    const s = validSnapshot() as unknown as {
      menu: { itemModifierGroups: Array<Record<string, unknown>> };
    };
    delete s.menu.itemModifierGroups[0].sortOrder;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a sync token that is too short to be a real secret", () => {
    const s = validSnapshot();
    s.syncToken = "short";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts empty accounts, menu and settings — a business may be freshly provisioned", () => {
    const s = validSnapshot();
    s.accounts = [];
    s.menu = { categories: [], items: [], mediaAssets: [], modifierGroups: [], modifiers: [], itemModifierGroups: [] };
    s.settings = [];
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects a menu item pointing at a category that is not in the snapshot", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = "99999999-9999-9999-9999-999999999999";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts a menu item with no category", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = null;
    expect(validateSnapshot(s).ok).toBe(true);
  });
});
