import { describe, expect, it } from "vitest";
import {
  buildMediaKey,
  dailyStorageCharge,
  DEFAULT_MEDIA_CONFIG,
  folderDepthOf,
  folderMoveCreatesCycle,
  hasMatchingMediaSignature,
  isMediaSort,
  keyBelongsToBusiness,
  maskMediaConfig,
  mediaKindForMime,
  mediaSearchExpression,
  mediaSortOrderBy,
  normalizeKeyPrefix,
  normalizeSearchTerm,
  parseCategory,
  parseMediaTransformInput,
  parseTags,
  safeFileName,
  validateMediaConfigInput,
  validateMediaTariffInput,
  type MediaStorageConfig,
} from "./media";

const BIZ = "11111111-2222-3333-4444-555555555555";
const ASSET = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("mediaKindForMime", () => {
  it("shelves the accepted types and refuses the rest", () => {
    expect(mediaKindForMime("image/png")).toBe("image");
    expect(mediaKindForMime("image/webp")).toBe("image");
    expect(mediaKindForMime("video/mp4")).toBe("video");
    expect(mediaKindForMime("application/pdf")).toBe("document");
    expect(mediaKindForMime("text/csv")).toBe("document");
    expect(mediaKindForMime("application/x-msdownload")).toBeNull();
    expect(mediaKindForMime("text/html")).toBeNull();
  });
});

describe("hasMatchingMediaSignature", () => {
  it("accepts a real PNG header and refuses a fake one", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    expect(hasMatchingMediaSignature("image/png", png)).toBe(true);
    expect(hasMatchingMediaSignature("image/png", new Uint8Array([0, 1, 2, 3]))).toBe(false);
    // A script claiming to be a PNG must not pass.
    expect(hasMatchingMediaSignature("image/png", new TextEncoder().encode("<script>"))).toBe(false);
  });

  it("checks mp4 by the ftyp box at offset 4", () => {
    const mp4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(hasMatchingMediaSignature("video/mp4", mp4)).toBe(true);
    expect(hasMatchingMediaSignature("video/mp4", new Uint8Array(12))).toBe(false);
  });

  it("refuses an SVG that carries a script", () => {
    const clean = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const evil = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    expect(hasMatchingMediaSignature("image/svg+xml", clean)).toBe(true);
    expect(hasMatchingMediaSignature("image/svg+xml", evil)).toBe(false);
  });

  it("accepts a PDF magic and a ZIP-based office file", () => {
    expect(hasMatchingMediaSignature("application/pdf", new TextEncoder().encode("%PDF-1.7"))).toBe(true);
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    expect(
      hasMatchingMediaSignature("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", zip),
    ).toBe(true);
  });
});

describe("safeFileName", () => {
  it("keeps Persian, flattens separators and junk", () => {
    expect(safeFileName("عکس منو.jpg")).toBe("عکس-منو.jpg");
    expect(safeFileName("../../../etc/passwd")).toBe("etc-passwd");
    expect(safeFileName('a"b<c>d?e#f.png')).toBe("a-b-c-d-e-f.png");
  });
  it("never returns empty", () => {
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("///")).toBe("file");
  });
});

describe("object-key grammar and tenant isolation", () => {
  it("builds {prefix}{businessId}/{assetId}/{file}", () => {
    expect(buildMediaKey("media/", BIZ, ASSET, "photo.png")).toBe(`media/${BIZ}/${ASSET}/photo.png`);
    // Prefix is normalized either way it is stored.
    expect(buildMediaKey("media", BIZ, ASSET, "photo.png")).toBe(`media/${BIZ}/${ASSET}/photo.png`);
    expect(buildMediaKey("", BIZ, ASSET, "photo.png")).toBe(`${BIZ}/${ASSET}/photo.png`);
  });

  it("accepts only a key under the owning business's own prefix", () => {
    const key = buildMediaKey("media/", BIZ, ASSET, "photo.png");
    expect(keyBelongsToBusiness(key, "media/", BIZ)).toBe(true);
    // Another tenant's id — the exact leak the rule exists to prevent.
    expect(keyBelongsToBusiness(key, "media/", "99999999-2222-3333-4444-555555555555")).toBe(false);
    // Outside the configured prefix entirely.
    expect(keyBelongsToBusiness(`backups/${BIZ}/${ASSET}/photo.png`, "media/", BIZ)).toBe(false);
    // Traversal and malformed shapes fail closed.
    expect(keyBelongsToBusiness(`media/${BIZ}/${ASSET}/../x`, "media/", BIZ)).toBe(false);
    expect(keyBelongsToBusiness(`media/${BIZ}/not-a-uuid/photo.png`, "media/", BIZ)).toBe(false);
    expect(keyBelongsToBusiness(`media/${BIZ}/${ASSET}`, "media/", BIZ)).toBe(false);
    expect(keyBelongsToBusiness(`media/${BIZ}/${ASSET}/a/b`, "media/", BIZ)).toBe(false);
  });

  it("normalizes prefixes to a single trailing slash", () => {
    expect(normalizeKeyPrefix("media")).toBe("media/");
    expect(normalizeKeyPrefix("/media//")).toBe("media/");
    expect(normalizeKeyPrefix("  ")).toBe("");
  });
});

describe("validateMediaConfigInput", () => {
  const stored: MediaStorageConfig = {
    ...DEFAULT_MEDIA_CONFIG,
    endpoint: "https://s3.parspack.com",
    bucket: "pos-media",
    accessKeyId: "AK",
    secretAccessKey: "stored-secret",
  };

  it("keeps the stored secret when the field is omitted, clears it on empty string", () => {
    const kept = validateMediaConfigInput({ bucket: "pos-media-2" }, stored);
    expect(kept.ok && kept.config.secretAccessKey).toBe("stored-secret");
    const cleared = validateMediaConfigInput({ secretAccessKey: "", enabled: false }, stored);
    expect(cleared.ok && cleared.config.secretAccessKey).toBe("");
  });

  it("requires endpoint/bucket/credentials only when enabling", () => {
    expect(validateMediaConfigInput({ enabled: false }, DEFAULT_MEDIA_CONFIG).ok).toBe(true);
    const missing = validateMediaConfigInput({ enabled: true }, DEFAULT_MEDIA_CONFIG);
    expect(missing.ok).toBe(false);
    const bad = validateMediaConfigInput({ enabled: true, endpoint: "not-a-url", bucket: "b", accessKeyId: "a", secretAccessKey: "s" }, DEFAULT_MEDIA_CONFIG);
    expect(bad.ok === false && bad.error).toBe("endpoint_invalid");
    const good = validateMediaConfigInput(
      { enabled: true, endpoint: "https://s3.parspack.com/", bucket: "b", accessKeyId: "a", secretAccessKey: "s" },
      DEFAULT_MEDIA_CONFIG,
    );
    expect(good.ok && good.config.endpoint).toBe("https://s3.parspack.com");
  });

  it("keeps the tariff untouched on a technical save (Billing owns prices now)", () => {
    // Migration 0176: /platform/media's save validates the TECHNICAL
    // connection only. Tariff fields sent here are ignored — the stored
    // values survive — even nonsense ones.
    const ignored = validateMediaConfigInput(
      { dailyFlatRial: -5, dailyPerGbRial: "x", freeQuotaMb: -1 },
      stored,
    );
    expect(ignored.ok && ignored.config.dailyFlatRial).toBe(stored.dailyFlatRial);
    expect(ignored.ok && ignored.config.dailyPerGbRial).toBe(stored.dailyPerGbRial);
    expect(ignored.ok && ignored.config.freeQuotaMb).toBe(stored.freeQuotaMb);
  });

  it("the Billing tariff validator refuses negative or non-numeric prices", () => {
    expect(validateMediaTariffInput({ dailyFlatRial: -5 }, stored).ok).toBe(false);
    expect(validateMediaTariffInput({ dailyPerGbRial: "x" }, stored).ok).toBe(false);
    expect(validateMediaTariffInput({ freeQuotaMb: 1.5 }, stored).ok).toBe(false);
    const ok = validateMediaTariffInput(
      { dailyFlatRial: 5000, dailyPerGbRial: 20000, freeQuotaMb: 100 },
      stored,
    );
    expect(ok.ok && ok.tariff.dailyFlatRial).toBe(5000);
  });

  it("masks the secret on read", () => {
    const masked = maskMediaConfig(stored);
    expect("secretAccessKey" in masked).toBe(false);
    expect(masked.secretAccessKeySet).toBe(true);
  });
});

describe("dailyStorageCharge", () => {
  const config: MediaStorageConfig = {
    ...DEFAULT_MEDIA_CONFIG,
    billingEnabled: true,
    dailyFlatRial: 5000,
    dailyPerGbRial: 20000,
    freeQuotaMb: 100,
  };
  const GB = 1024 * 1024 * 1024;
  const MB = 1024 * 1024;

  it("charges nothing when billing is off or nothing is stored", () => {
    expect(dailyStorageCharge(5 * GB, { ...config, billingEnabled: false }).totalRial).toBe(0);
    expect(dailyStorageCharge(0, config).totalRial).toBe(0);
  });

  it("charges the flat base for anything stored, per-GB only above the free quota", () => {
    // 50 MB — inside the quota, flat only.
    const small = dailyStorageCharge(50 * MB, config);
    expect(small.flatRial).toBe(5000);
    expect(small.perGbRial).toBe(0);
    expect(small.totalRial).toBe(5000);
    // 1 GB + 100 MB quota → exactly 1 GB billable.
    const oneGb = dailyStorageCharge(1 * GB + 100 * MB, config);
    expect(oneGb.billableBytes).toBe(1 * GB);
    expect(oneGb.perGbRial).toBe(20000);
    expect(oneGb.totalRial).toBe(25000);
  });

  it("rounds a fraction of a GB up, never down to free", () => {
    // 1 byte over the quota still owes 1 Rial of the per-GB rate.
    const justOver = dailyStorageCharge(100 * MB + 1, config);
    expect(justOver.perGbRial).toBe(1);
  });
});

describe("tag/category parsing", () => {
  it("cleans, dedupes and caps tags", () => {
    expect(parseTags(["  قهوه ", "قهوه", "منو"])).toEqual(["قهوه", "منو"]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags("not-an-array")).toBeNull();
    expect(parseTags([1])).toBeNull();
    expect(parseTags(["x".repeat(61)])).toBeNull();
  });
  it("treats empty category as null and refuses oversize", () => {
    expect(parseCategory("")).toBeNull();
    expect(parseCategory("  غذا ")).toBe("غذا");
    expect(parseCategory("x".repeat(81))).toBeUndefined();
    expect(parseCategory(5)).toBeUndefined();
  });
});

describe("mediaSortOrderBy / isMediaSort", () => {
  it("maps every declared sort to a concrete, safe ORDER BY clause", () => {
    expect(mediaSortOrderBy("newest")).toBe("created_at DESC");
    expect(mediaSortOrderBy(undefined)).toBe("created_at DESC");
    expect(mediaSortOrderBy("oldest")).toBe("created_at ASC");
    expect(mediaSortOrderBy("name_asc")).toBe("file_name ASC");
    expect(mediaSortOrderBy("name_desc")).toBe("file_name DESC");
    expect(mediaSortOrderBy("largest")).toBe("byte_size DESC");
    expect(mediaSortOrderBy("smallest")).toBe("byte_size ASC");
    expect(mediaSortOrderBy("updated")).toBe("updated_at DESC");
  });

  it("recognizes only the declared sort keys", () => {
    expect(isMediaSort("newest")).toBe(true);
    expect(isMediaSort("largest")).toBe(true);
    expect(isMediaSort("random; DROP TABLE media_assets;")).toBe(false);
    expect(isMediaSort(undefined)).toBe(false);
    expect(isMediaSort(42)).toBe(false);
  });
});

describe("search normalization", () => {
  it("trims, collapses whitespace and caps length without mutating meaning", () => {
    expect(normalizeSearchTerm("  اسپرسو   دوبل  ")).toBe("اسپرسو دوبل");
    expect(normalizeSearchTerm("a".repeat(200)).length).toBe(120);
  });

  it("folds Arabic letter variants onto their Persian equivalents", () => {
    // ي (Arabic yeh) and ك (Arabic kaf) are what many keyboards produce when
    // typing Persian ی/ک — a search for one must find the other.
    expect(normalizeSearchTerm("كتاب")).toBe("کتاب");
    expect(normalizeSearchTerm("چاي")).toBe("چای");
    expect(normalizeSearchTerm("قهوه")).toBe("قهوه");
  });

  it("builds a symmetric SQL expression so a stored value need never be rewritten", () => {
    expect(mediaSearchExpression("file_name")).toContain("translate(file_name");
  });
});

describe("folder tree safety", () => {
  // root -> a -> b -> c
  const tree = [
    { id: "root", parentId: null },
    { id: "a", parentId: "root" },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
  ];

  it("computes 1-based depth from the root", () => {
    expect(folderDepthOf(tree, "root")).toBe(1);
    expect(folderDepthOf(tree, "a")).toBe(2);
    expect(folderDepthOf(tree, "c")).toBe(4);
    expect(folderDepthOf(tree, null)).toBe(0);
  });

  it("refuses moving a folder into itself", () => {
    expect(folderMoveCreatesCycle(tree, "a", "a")).toBe(true);
  });

  it("refuses moving a folder into its own descendant", () => {
    expect(folderMoveCreatesCycle(tree, "a", "c")).toBe(true);
    expect(folderMoveCreatesCycle(tree, "root", "c")).toBe(true);
  });

  it("allows moving a folder under an unrelated folder, or to the root", () => {
    const withSibling = [...tree, { id: "d", parentId: null }];
    expect(folderMoveCreatesCycle(withSibling, "a", "d")).toBe(false);
    expect(folderMoveCreatesCycle(withSibling, "c", null)).toBe(false);
  });

  it("never loops forever even if the input already contains a corrupt cycle", () => {
    const corrupt = [
      { id: "x", parentId: "y" },
      { id: "y", parentId: "x" },
    ];
    expect(() => folderMoveCreatesCycle(corrupt, "x", "y")).not.toThrow();
    expect(() => folderDepthOf(corrupt, "x")).not.toThrow();
  });
});

describe("parseMediaTransformInput — the lightweight crop/rotate/resize contract", () => {
  it("accepts a well-formed crop and normalizes it to integers", () => {
    const result = parseMediaTransformInput({ operation: "crop", params: { x: 10, y: 20, width: 100, height: 200 } });
    expect(result).toEqual({ ok: true, value: { operation: "crop", params: { x: 10, y: 20, width: 100, height: 200 } } });
  });

  it("refuses a crop with negative offsets, non-integers, or a zero/oversized dimension", () => {
    expect(parseMediaTransformInput({ operation: "crop", params: { x: -1, y: 0, width: 10, height: 10 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "crop", params: { x: 0, y: 0, width: 10.5, height: 10 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "crop", params: { x: 0, y: 0, width: 0, height: 10 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "crop", params: { x: 0, y: 0, width: 5000, height: 10 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "crop", params: { x: 0, y: 0 } }).ok).toBe(false);
  });

  it("accepts a rotate within ±360° and refuses a no-op or out-of-range one", () => {
    expect(parseMediaTransformInput({ operation: "rotate", params: { degrees: 90 } })).toEqual({
      ok: true,
      value: { operation: "rotate", params: { degrees: 90 } },
    });
    expect(parseMediaTransformInput({ operation: "rotate", params: { degrees: -45 } }).ok).toBe(true);
    expect(parseMediaTransformInput({ operation: "rotate", params: { degrees: 0 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "rotate", params: { degrees: 720 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "rotate", params: {} }).ok).toBe(false);
  });

  it("accepts a resize with at least one dimension and defaults fit to 'inside'", () => {
    const result = parseMediaTransformInput({ operation: "resize", params: { width: 400 } });
    expect(result).toEqual({ ok: true, value: { operation: "resize", params: { width: 400, height: undefined, fit: "inside" } } });
    expect(parseMediaTransformInput({ operation: "resize", params: { height: 300, fit: "cover" } }).ok).toBe(true);
    expect(parseMediaTransformInput({ operation: "resize", params: {} }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "resize", params: { width: 0 } }).ok).toBe(false);
    expect(parseMediaTransformInput({ operation: "resize", params: { width: 100, fit: "not-a-fit" } })).toMatchObject({
      ok: true,
      value: { params: { fit: "inside" } },
    });
  });

  it("refuses an unknown operation or a non-object body", () => {
    expect(parseMediaTransformInput({ operation: "sepia", params: {} }).ok).toBe(false);
    expect(parseMediaTransformInput(null).ok).toBe(false);
    expect(parseMediaTransformInput("crop").ok).toBe(false);
    expect(parseMediaTransformInput(42).ok).toBe(false);
  });
});
