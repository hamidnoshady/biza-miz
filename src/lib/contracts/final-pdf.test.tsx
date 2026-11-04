import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { frozenContentHash, sha256Hex } from "./crypto";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  withoutTenantScope: vi.fn(async (_reason: string, run: () => Promise<unknown>) => run()),
  latestFrozenVersion: vi.fn(),
  listCompletedSignatureSlots: vi.fn(),
  getMediaConfig: vi.fn(),
  isMediaStorageReady: vi.fn(),
  readMediaObject: vi.fn(),
  softDeleteMediaAsset: vi.fn(),
  storeMediaAsset: vi.fn(),
  renderStaticHtmlToPdf: vi.fn(),
  qr: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ query: mocks.query, withoutTenantScope: mocks.withoutTenantScope }));
vi.mock("./service", () => ({ latestFrozenVersion: mocks.latestFrozenVersion }));
vi.mock("./signing", () => ({ listCompletedSignatureSlots: mocks.listCompletedSignatureSlots }));
vi.mock("@/lib/media-service", () => ({
  getMediaConfig: mocks.getMediaConfig,
  isMediaStorageReady: mocks.isMediaStorageReady,
  readMediaObject: mocks.readMediaObject,
  softDeleteMediaAsset: mocks.softDeleteMediaAsset,
  storeMediaAsset: mocks.storeMediaAsset,
}));
vi.mock("@/lib/pdf-render", () => ({ renderStaticHtmlToPdf: mocks.renderStaticHtmlToPdf }));
vi.mock("qrcode", () => ({ default: { toDataURL: mocks.qr } }));

import { generateOrReadFinalContractPdf, verifyFinalContractPdfToken } from "./final-pdf";

const content = {
  version: 1,
  title: "قرارداد آزمایشی",
  headerText: "",
  footerText: "",
  fields: [],
  values: {},
  blocks: [{ id: "p1", type: "paragraph" as const, text: "متن قرارداد" }],
};
const version = {
  id: "version-1",
  version: 4,
  title: content.title,
  content,
  contentHash: frozenContentHash(content),
  frozenAt: "2026-10-20T10:00:00.000Z",
  frozenBy: "actor-1",
};
const bytes = Buffer.from("%PDF-1.7\nverified final pdf");
const mediaAsset = {
  id: "asset-1",
  fileName: "قرارداد-آزمایشی-v4-signed.pdf",
  createdAt: "2026-10-20T11:00:00.000Z",
};
const pdfSha256 = sha256Hex(bytes.toString("utf8"));

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.clearAllMocks();
  mocks.latestFrozenVersion.mockResolvedValue(version);
  mocks.listCompletedSignatureSlots.mockResolvedValue({ employer: {
    fullName: "امضاکننده",
    signedAt: "۱ آبان ۱۴۰۵",
    drawnImage: null,
  } });
  mocks.getMediaConfig.mockResolvedValue({ enabled: true });
  mocks.isMediaStorageReady.mockReturnValue(true);
  mocks.qr.mockResolvedValue("data:image/png;base64,qr-data");
  mocks.renderStaticHtmlToPdf.mockImplementation(async (html: string) => {
    expect(html).toContain("قرارداد آزمایشی");
    expect(html).toContain(version.contentHash);
    expect(html).toContain("data:image/png;base64,qr-data");
    return bytes;
  });
  mocks.storeMediaAsset.mockResolvedValue(mediaAsset);
  mocks.softDeleteMediaAsset.mockResolvedValue(true);
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM contract_signing_envelopes")) {
      return { rows: [{ completed_at: new Date("2026-10-20T10:30:00Z"), signature_count: "2" }] };
    }
    if (sql.includes("FROM contract_final_pdfs") && sql.includes("verification_token_hash")) {
      return { rows: [] };
    }
    if (sql.includes("FROM contract_final_pdfs")) return { rows: [] };
    if (sql.includes("INSERT INTO contract_final_pdfs")) return { rows: [{ id: "final-1" }] };
    return { rows: [] };
  });
});

const owner = { businessId: "business-1", actorUserId: "actor-1" };
const contract = { id: "contract-1", title: "قرارداد آزمایشی" };

describe("final contract PDFs", () => {
  it("generates one QR-bearing PDF, archives it in Media Library, and records both hashes", async () => {
    const result = await generateOrReadFinalContractPdf(owner as never, contract as never, "https://example.test/api", new Headers({ host: "example.test" }));
    expect(result.bytes).toEqual(bytes);
    expect(result.contentHash).toBe(version.contentHash);
    expect(result.pdfSha256).toBe(pdfSha256);
    expect(mocks.qr).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/example\.test\/verify\/contract\/[A-Za-z0-9_-]{43}$/), expect.any(Object));
    expect(mocks.storeMediaAsset).toHaveBeenCalledWith(expect.objectContaining({
      businessId: owner.businessId,
      kind: "document",
      mimeType: "application/pdf",
      source: "contract_final_pdf",
      sha256: pdfSha256,
      bytes,
    }));
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO contract_final_pdfs"), expect.arrayContaining([
      owner.businessId,
      contract.id,
      version.id,
      mediaAsset.id,
      version.contentHash,
      pdfSha256,
      expect.any(String),
      2,
      owner.actorUserId,
    ]));
  });

  it("returns the archived PDF on later requests without regenerating or re-uploading", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM contract_signing_envelopes")) {
        return { rows: [{ completed_at: new Date("2026-10-20T10:30:00Z"), signature_count: "2" }] };
      }
      if (sql.includes("FROM contract_final_pdfs")) {
        return { rows: [{ media_asset_id: mediaAsset.id, content_hash: version.contentHash, pdf_sha256: pdfSha256, created_at: new Date("2026-10-20T11:00:00Z") }] };
      }
      return { rows: [] };
    });
    mocks.readMediaObject.mockResolvedValue({ asset: { ...mediaAsset, deletedAt: null }, bytes });

    const result = await generateOrReadFinalContractPdf(owner as never, contract as never, "https://example.test", new Headers());
    expect(result.bytes).toEqual(bytes);
    expect(result.pdfSha256).toBe(pdfSha256);
    expect(mocks.renderStaticHtmlToPdf).not.toHaveBeenCalled();
    expect(mocks.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("refuses to generate before the envelope has completed", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(generateOrReadFinalContractPdf(owner as never, contract as never, "https://example.test", new Headers()))
      .rejects.toMatchObject({ code: "contract_not_completed" });
    expect(mocks.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("fails closed when production cannot resolve a trustworthy public QR origin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUBLIC_ORIGIN", "");
    vi.stubEnv("ROOT_DOMAIN", "");
    vi.stubEnv("DEPLOYMENT_ROLE", "central");
    vi.stubEnv("TRUST_FORWARDED_HOST", "");

    await expect(
      generateOrReadFinalContractPdf(
        owner as never,
        contract as never,
        "https://safe.example.test/api",
        new Headers({ host: "web.internal" }),
      ),
    ).rejects.toMatchObject({ code: "contract_final_pdf_origin_unavailable" });
    expect(mocks.qr).not.toHaveBeenCalled();
    expect(mocks.storeMediaAsset).not.toHaveBeenCalled();
  });

  it("verifies an opaque token, recomputes the frozen content hash and reveals no identity fields", async () => {
    const token = "A".repeat(43);
    const completedAt = new Date("2026-10-20T10:30:00Z");
    const generatedAt = new Date("2026-10-20T11:00:00Z");
    mocks.query.mockResolvedValue({ rows: [{
      version: version.version,
      content,
      version_content_hash: version.contentHash,
      content_hash: version.contentHash,
      pdf_sha256: pdfSha256,
      signature_count: 2,
      completed_at: completedAt,
      generated_at: generatedAt,
    }] });
    const result = await verifyFinalContractPdfToken(token);
    expect(result).toEqual({
      version: version.version,
      contentHash: version.contentHash,
      pdfSha256,
      signatureCount: 2,
      completedAt: completedAt.toISOString(),
      generatedAt: generatedAt.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain("fullName");
    expect(mocks.withoutTenantScope).toHaveBeenCalledWith("contract-final-pdf-verification", expect.any(Function));
    expect(mocks.query.mock.calls.at(-1)?.[1]).toEqual([sha256Hex(token)]);
  });

  it("rejects malformed verification tokens before using the documented bypass", async () => {
    expect(await verifyFinalContractPdfToken("not-a-token")).toBeNull();
    expect(mocks.withoutTenantScope).not.toHaveBeenCalled();
  });
});
