import { createHash } from "node:crypto";
import { query, withoutTenantScope } from "@/lib/db";
import { normalizeContractContent } from "./blocks";
import { frozenContentHash } from "./crypto";

const VERIFICATION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface ContractPdfVerification {
  version: number;
  contentHash: string;
  pdfSha256: string;
  signatureCount: number;
  completedAt: string;
  generatedAt: string;
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
