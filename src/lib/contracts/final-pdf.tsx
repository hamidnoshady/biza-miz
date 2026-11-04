import { createHash, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import QRCode from "qrcode";
import { ContractDocumentSheet } from "@/components/contracts/contract-document-sheet";
import { query, withoutTenantScope } from "@/lib/db";
import { handoffOriginContext, resolveHandoffOrigin } from "@/lib/public-origin";
import {
  getMediaConfig,
  isMediaStorageReady,
  readMediaObject,
  softDeleteMediaAsset,
  storeMediaAsset,
} from "@/lib/media-service";
import { renderStaticHtmlToPdf } from "@/lib/pdf-render";
import { WorkspaceError, type WorkspaceContract, type WorkspaceOwner } from "@/lib/workspace";
import { frozenContentHash } from "./crypto";
import { latestFrozenVersion, type FrozenContractVersion } from "./service";
import { normalizeContractContent } from "./blocks";
import { listCompletedSignatureSlots } from "./signing";

const MAX_FINAL_PDF_BYTES = 25 * 1024 * 1024;
const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface ContractPdfVerification {
  version: number;
  contentHash: string;
  pdfSha256: string;
  signatureCount: number;
  completedAt: string;
  generatedAt: string;
}

function safeFileStem(value: string): string {
  return value
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "contract";
}

function publicOrigin(requestUrl: string, headers: Headers): string {
  const request = new URL(requestUrl);
  const resolved = resolveHandoffOrigin(
    handoffOriginContext({ headers, nextUrl: request }, null),
  );
  if (!resolved.ok) throw new WorkspaceError("contract_final_pdf_origin_unavailable");
  return resolved.origin;
}

function finalPdfHtml(input: {
  version: FrozenContractVersion;
  signatures: Awaited<ReturnType<typeof listCompletedSignatureSlots>>;
  qrDataUrl: string;
  verificationUrl: string;
}): string {
  const markup = renderToStaticMarkup(
    <>
      <ContractDocumentSheet content={input.version.content} values={input.version.content.values} signed={input.signatures} />
      <section className="contract-proof" dir="rtl" aria-label="گواهی اصالت سند">
        <div className="contract-proof-copy">
          <strong>نسخهٔ نهایی قرارداد — امضاشده</strong>
          <span>نسخهٔ {input.version.version}</span>
          <span>اثر انگشت محتوای امضاشده (SHA-256)</span>
          <code dir="ltr">{input.version.contentHash}</code>
          <span>برای بررسی اصالت، کد QR را اسکن کنید.</span>
          <code dir="ltr">{input.verificationUrl}</code>
        </div>
        <img src={input.qrDataUrl} alt="کد QR بررسی اصالت قرارداد" />
      </section>
    </>,
  );
  const css = `
    @page{size:A4;margin:14mm}
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;background:#fff;color:#201f1e;font-family:Vazirmatn,Arial,sans-serif;direction:rtl}
    body{font-size:10pt;line-height:1.85}
    article{width:100%;max-width:none;min-height:0;margin:0;padding:0;background:#fff;color:#201f1e;box-shadow:none;border:0}
    article>p{margin:0 0 6mm;padding-bottom:3mm;border-bottom:1px solid #cfcfcf;color:#555;font-size:9pt}
    header{text-align:center;margin:0 0 9mm}
    h1{font-size:18pt;margin:0;font-weight:700}
    h2{font-size:13pt;margin:7mm 0 2mm;break-after:avoid}
    h3{font-size:11pt;margin:3mm 0 1mm;break-after:avoid}
    p{margin:0 0 3mm}
    ul,ol{padding-right:7mm;margin:0 0 4mm}
    li{margin:0 0 1mm}
    figure{margin:4mm 0;break-inside:avoid}
    figcaption{font-size:9pt;margin-bottom:1mm}
    table{width:100%;border-collapse:collapse;font-size:9pt;break-inside:auto}
    thead{display:table-header-group}
    tr{break-inside:avoid}
    th,td{border:1px solid #777;padding:1.4mm 2mm;text-align:right;vertical-align:top}
    th{background:#efefef;font-weight:700}
    hr{border:0;border-top:1px solid #aaa;margin:6mm 0}
    img{max-width:80mm;max-height:22mm;object-fit:contain}
    article>div[class*="grid"]{display:block;margin:6mm 0}
    article>div[class*="grid"]>div{border:1px solid #888;border-radius:2mm;padding:3mm;margin:0 0 3mm;break-inside:avoid}
    article>div[class*="grid"] p{margin:0 0 2mm}
    [class~="print:break-after-page"]{break-after:page;page-break-after:always;border:0!important;margin:0!important}
    article>footer{margin-top:8mm;padding-top:3mm;border-top:1px solid #aaa;font-size:8.5pt}
    .contract-proof{display:flex;align-items:center;gap:8mm;margin-top:12mm;padding-top:5mm;border-top:1px solid #555;break-inside:avoid;font-size:8.5pt}
    .contract-proof-copy{display:flex;flex:1;flex-direction:column;gap:1mm;min-width:0}
    .contract-proof code{font-family:monospace;font-size:7.5pt;overflow-wrap:anywhere;direction:ltr;text-align:left}
    .contract-proof img{width:34mm;height:34mm;max-height:none}
  `;
  return `<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>نسخهٔ نهایی قرارداد</title><style>${css}</style></head><body>${markup}</body></html>`;
}

async function completedEnvelopeForVersion(businessId: string, contractId: string, versionId: string) {
  const { rows } = await query<{
    completed_at: Date;
    signature_count: string;
  }>(
    `SELECT e.completed_at, count(sig.id)::text AS signature_count
       FROM contract_signing_envelopes e
       JOIN contract_signatures sig
         ON sig.envelope_id = e.id AND sig.business_id = e.business_id
      WHERE e.business_id = $1 AND e.contract_id = $2
        AND e.document_version_id = $3 AND e.status = 'completed'
      GROUP BY e.id
      ORDER BY e.completed_at DESC NULLS LAST
      LIMIT 1`,
    [businessId, contractId, versionId],
  );
  return rows[0] ?? null;
}

async function archivedPdfRow(businessId: string, versionId: string) {
  const { rows } = await query<{
    media_asset_id: string;
    content_hash: string;
    pdf_sha256: string;
    created_at: Date;
  }>(
    `SELECT media_asset_id, content_hash, pdf_sha256, created_at
       FROM contract_final_pdfs
      WHERE business_id = $1 AND document_version_id = $2`,
    [businessId, versionId],
  );
  return rows[0] ?? null;
}

async function readArchivedPdf(businessId: string, version: FrozenContractVersion) {
  const row = await archivedPdfRow(businessId, version.id);
  if (!row) return null;
  if (row.content_hash !== version.contentHash) throw new WorkspaceError("contract_final_pdf_integrity_error");
  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) throw new WorkspaceError("contract_final_pdf_storage_unavailable");
  const stored = await readMediaObject(businessId, row.media_asset_id, config).catch(() => null);
  if (!stored || stored.asset.deletedAt) {
    throw new WorkspaceError("contract_final_pdf_asset_unavailable");
  }
  const actualSha256 = createHash("sha256").update(stored.bytes).digest("hex");
  if (actualSha256 !== row.pdf_sha256) {
    throw new WorkspaceError("contract_final_pdf_integrity_error");
  }
  return {
    bytes: stored.bytes,
    fileName: stored.asset.fileName,
    pdfSha256: row.pdf_sha256,
    createdAt: row.created_at,
  };
}

/** Creates once per completed frozen version; repeat requests return the archived bytes. */
export async function generateOrReadFinalContractPdf(
  owner: WorkspaceOwner,
  contract: WorkspaceContract,
  requestUrl: string,
  headers: Headers,
) {
  const version = await latestFrozenVersion(owner.businessId, contract.id);
  if (!version) throw new WorkspaceError("contract_document_not_frozen");
  const completed = await completedEnvelopeForVersion(owner.businessId, contract.id, version.id);
  if (!completed || Number(completed.signature_count) < 1) throw new WorkspaceError("contract_not_completed");
  if (frozenContentHash(version.content) !== version.contentHash) throw new WorkspaceError("contract_final_pdf_integrity_error");

  const archived = await readArchivedPdf(owner.businessId, version);
  if (archived) return { ...archived, version: version.version, contentHash: version.contentHash };

  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) throw new WorkspaceError("contract_final_pdf_storage_unavailable");

  const verificationToken = randomBytes(32).toString("base64url");
  const verificationUrl = `${publicOrigin(requestUrl, headers)}/verify/contract/${verificationToken}`;
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 256,
  });
  const signatures = await listCompletedSignatureSlots(owner.businessId, contract.id, version.id);
  const html = finalPdfHtml({ version, signatures, qrDataUrl, verificationUrl });
  const bytes = await renderStaticHtmlToPdf(html, { format: "A4" });
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_FINAL_PDF_BYTES || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new WorkspaceError("contract_final_pdf_generation_failed");
  }
  const pdfSha256 = createHash("sha256").update(bytes).digest("hex");
  const mediaAsset = await storeMediaAsset({
    businessId: owner.businessId,
    userId: owner.actorUserId,
    config,
    kind: "document",
    fileName: `${safeFileStem(version.title)}-v${version.version}-signed.pdf`,
    mimeType: "application/pdf",
    contentType: "application/pdf",
    bytes,
    sha256: pdfSha256,
    source: "contract_final_pdf",
  });
  try {
    const verificationTokenHash = createHash("sha256").update(verificationToken, "utf8").digest("hex");
    const { rows } = await query<{ id: string }>(
      `INSERT INTO contract_final_pdfs
         (business_id, contract_id, document_version_id, media_asset_id, content_hash,
          pdf_sha256, verification_token_hash, signature_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (document_version_id) DO NOTHING
       RETURNING id`,
      [
        owner.businessId,
        contract.id,
        version.id,
        mediaAsset.id,
        version.contentHash,
        pdfSha256,
        verificationTokenHash,
        Number(completed.signature_count),
        owner.actorUserId,
      ],
    );
    if (!rows[0]) {
      await softDeleteMediaAsset(owner.businessId, mediaAsset.id).catch(() => false);
      const concurrent = await readArchivedPdf(owner.businessId, version);
      if (!concurrent) throw new WorkspaceError("contract_final_pdf_asset_unavailable");
      return { ...concurrent, version: version.version, contentHash: version.contentHash };
    }
  } catch (error) {
    await softDeleteMediaAsset(owner.businessId, mediaAsset.id).catch(() => false);
    throw error;
  }
  return {
    bytes,
    fileName: mediaAsset.fileName,
    pdfSha256,
    createdAt: mediaAsset.createdAt,
    version: version.version,
    contentHash: version.contentHash,
  };
}

/** Public token-only verification lookup; returns hashes/status only, never contract or signer PII. */
export async function verifyFinalContractPdfToken(token: string): Promise<ContractPdfVerification | null> {
  if (!VERIFICATION_TOKEN.test(token)) return null;
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  return withoutTenantScope("contract-final-pdf-verification", async () => {
    const { rows } = await query<{
      version: number;
      content: unknown;
      version_content_hash: string;
      content_hash: string;
      pdf_sha256: string;
      signature_count: number;
      completed_at: Date;
      generated_at: Date;
    }>(
      `SELECT v.version, v.content, v.content_hash AS version_content_hash,
              f.content_hash, f.pdf_sha256, f.signature_count,
              e.completed_at, f.created_at AS generated_at
         FROM contract_final_pdfs f
         JOIN contract_document_versions v
           ON v.id = f.document_version_id AND v.business_id = f.business_id
         JOIN contract_signing_envelopes e
           ON e.business_id = f.business_id AND e.contract_id = f.contract_id
          AND e.document_version_id = v.id AND e.status = 'completed'
          AND e.completed_at IS NOT NULL
         JOIN media_assets m
           ON m.id = f.media_asset_id AND m.business_id = f.business_id AND m.deleted_at IS NULL
        WHERE f.verification_token_hash = $1
        ORDER BY e.completed_at DESC NULLS LAST
        LIMIT 1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    const content = normalizeContractContent(row.content);
    if (row.content_hash !== row.version_content_hash || frozenContentHash(content) !== row.content_hash) return null;
    return {
      version: Number(row.version),
      contentHash: row.content_hash,
      pdfSha256: row.pdf_sha256,
      signatureCount: Number(row.signature_count),
      completedAt: new Date(row.completed_at).toISOString(),
      generatedAt: new Date(row.generated_at).toISOString(),
    };
  });
}
