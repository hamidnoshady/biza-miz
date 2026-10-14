import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getPool, withTenant, withoutTenantScope } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { platformCompanyLog } from "@/lib/platform-company";

const MAX_BODY = 32_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class IntakeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type ResolvedCredential = {
  id: string;
  business_id: string;
  site_key: string;
  provider: string;
  site_id: string | null;
};

/**
 * Public website lead intake.
 *
 * The request arrives with no tenant session — the site credential IS the
 * authentication — so the flow is deliberately two-phased:
 *
 *   1. **platform/system scope** — resolve the bearer token to one credential
 *      row and apply its rate limit. This is the documented
 *      "identify the tenant first" hole, and it reads and writes ONE table.
 *   2. **tenant scope** — every tenant-owned write (the platform web lead and
 *      the CRM lead) then runs inside `withTenant(credential.business_id)`, so
 *      RLS is doing its normal job for the records that belong to the internal
 *      company.
 *
 * A credential can therefore only ever submit into the business that owns it;
 * there is no way for one site's token to write into another business, and no
 * broad bypass is left open around the CRM insert.
 */
export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (raw.length > MAX_BODY) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!bearer) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  // Honeypots deliberately answer success so automated submitters receive no signal.
  if (typeof body.website === "string" && body.website.trim()) {
    return NextResponse.json({ accepted: true }, { status: 202 });
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 160) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  const rawPhone = typeof body.phone === "string" ? body.phone.trim().slice(0, 40) : "";
  const phone = normalizePhone(rawPhone);
  const message = typeof body.message === "string" ? body.message.trim().slice(0, 5000) : "";
  const idempotencyKey = (
    request.headers.get("idempotency-key") ??
    (typeof body.idempotencyKey === "string" ? body.idempotencyKey : "")
  ).trim();
  if (
    !name ||
    (!email && !phone.valid) ||
    (email && !emailPattern.test(email)) ||
    idempotencyKey.length < 8 ||
    idempotencyKey.length > 200
  ) {
    return NextResponse.json({ error: "invalid_lead" }, { status: 400 });
  }
  const source = body.source && typeof body.source === "object" && !Array.isArray(body.source) ? body.source : {};
  const consent = body.consent && typeof body.consent === "object" && !Array.isArray(body.consent) ? body.consent : {};
  const tokenHash = createHash("sha256").update(bearer).digest("hex");

  try {
    // ---- Phase 1: resolve the credential (platform scope) -------------------
    const credential = await withoutTenantScope("platform", async (): Promise<ResolvedCredential> => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const { rows: credentials } = await client.query<
          ResolvedCredential & {
            requests_per_minute: number;
            window_started_at: Date;
            window_count: number;
          }
        >(
          `SELECT id, business_id, site_key, provider, site_id, requests_per_minute,
                  window_started_at, window_count
             FROM platform_company_site_credentials
            WHERE token_hash = $1 AND is_active
            FOR UPDATE`,
          [tokenHash],
        );
        const found = credentials[0];
        if (!found) throw new IntakeError("unauthorized", 401);
        const expired = Date.now() - found.window_started_at.getTime() >= RATE_LIMIT_WINDOW_MS;
        const count = expired ? 1 : found.window_count + 1;
        if (count > found.requests_per_minute) {
          await client.query(
            `UPDATE platform_company_site_credentials
                SET last_used_at = now() WHERE id = $1`,
            [found.id],
          );
          await client.query("COMMIT");
          platformCompanyLog("lead.rate_limited", {
            credentialId: found.id,
            businessId: found.business_id,
          });
          throw new IntakeError("rate_limited", 429);
        }
        await client.query(
          `UPDATE platform_company_site_credentials
              SET window_started_at = CASE WHEN $2 THEN now() ELSE window_started_at END,
                  window_count = $3, last_used_at = now()
            WHERE id = $1`,
          [found.id, expired, count],
        );
        await client.query("COMMIT");
        return {
          id: found.id,
          business_id: found.business_id,
          site_key: found.site_key,
          provider: found.provider,
          site_id: found.site_id,
        };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });

    // ---- Phase 2: tenant-owned writes (internal company tenant scope) -------
    const value = await withTenant(credential.business_id, async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO platform_company_web_leads
             (business_id, site_key, idempotency_key, email_normalized, phone_normalized,
              name, message, source, consent, credential_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
           ON CONFLICT (business_id, site_key, idempotency_key) DO NOTHING
           RETURNING id`,
          [
            credential.business_id,
            credential.site_key,
            idempotencyKey,
            email || null,
            phone.e164,
            name,
            message,
            JSON.stringify({ ...source, provider: credential.provider, siteId: credential.site_id }),
            JSON.stringify(consent),
            credential.id,
          ],
        );
        if (!inserted.rows[0]) {
          const { rows } = await client.query<{ id: string; lead_id: string | null }>(
            `SELECT id, lead_id FROM platform_company_web_leads
              WHERE business_id = $1 AND site_key = $2 AND idempotency_key = $3`,
            [credential.business_id, credential.site_key, idempotencyKey],
          );
          await client.query("COMMIT");
          return { id: rows[0].id, leadId: rows[0].lead_id, duplicate: true };
        }
        const { rows: leads } = await client.query<{ id: string }>(
          `INSERT INTO crm_leads
             (business_id, name, phone, phone_e164, email, source, source_detail, utm,
              external_ref, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,'website',$6,$7::jsonb,$8,$9,'website_form')
           RETURNING id`,
          [
            credential.business_id,
            name,
            rawPhone || null,
            phone.e164,
            email || null,
            credential.site_key,
            JSON.stringify(source),
            idempotencyKey,
            message,
          ],
        );
        await client.query(`UPDATE platform_company_web_leads SET lead_id = $2 WHERE id = $1`, [
          inserted.rows[0].id,
          leads[0].id,
        ]);
        await client.query("COMMIT");
        return { id: inserted.rows[0].id, leadId: leads[0].id, duplicate: false };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    });
    return NextResponse.json({ accepted: true, ...value }, { status: value.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof IntakeError) return NextResponse.json({ error: error.message }, { status: error.status });
    // Never echo the credential, the token or the contact payload into a log.
    platformCompanyLog("lead.intake_failed", {
      error: error instanceof Error ? error.message.slice(0, 300) : "unknown_error",
    });
    return NextResponse.json({ error: "lead_intake_failed" }, { status: 500 });
  }
}
