import { NextResponse } from "next/server";
import { requirePlatformCapability, platformAudit, withPlatformScope } from "@/lib/platform-auth";
import { query } from "@/lib/db";

/**
 * Per-business commercial overrides (§25, migration 0176): a super-admin
 * exception that never mutates the global plan — a custom limit or a
 * temporary capability. Every override carries a reason, its author, an
 * optional expiry and a full audit entry with before/after values.
 */
const LIMIT_TARGETS = new Set(["branch_limit", "member_limit", "monthly_order_limit"]);

export const POST = withPlatformScope(
  async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const guard = await requirePlatformCapability("adjustments.manage");
    if (guard.error) return guard.error;
    const { id: businessId } = await ctx.params;

    let body: {
      action?: string;
      kind?: string;
      target?: string;
      id?: string;
      unlimited?: boolean;
      value?: number;
      enabled?: boolean;
      reason?: string;
      expiresAt?: string | null;
    };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }

    const action = body.action ?? "set";

    if (action === "remove") {
      const target = String(body.target ?? "").trim();
      const kind = body.kind === "capability" ? "capability" : body.kind === "limit" ? "limit" : null;
      const id = typeof body.id === "string" && body.id.trim() ? body.id.trim() : null;
      // Removal must name the row: the override id, or the (kind, target) pair.
      // A bare target is refused rather than allowed to sweep every kind that
      // happens to share the name — which is what the old removal did.
      if (!id && !(target && kind)) {
        return NextResponse.json({ error: "missing_fields" }, { status: 400 });
      }

      // Removal is scoped by the same key as uniqueness — (business, kind,
      // target), plus the override id when the caller has it. Keying on
      // (business, target) alone deleted *both* a limit and a capability
      // override that happened to share a target name, silently.
      const { rows } = await query<{
        id: string;
        kind: string;
        target: string;
        value_int: number | null;
        value_bool: boolean | null;
        expires_at: string | null;
      }>(
        `DELETE FROM business_billing_overrides
          WHERE business_id = $1
            AND ($2::uuid IS NULL OR id = $2::uuid)
            AND ($3::text IS NULL OR kind = $3)
            AND ($4::text IS NULL OR target = $4)
          RETURNING id, kind, target, value_int, value_bool, expires_at`,
        [businessId, id, kind, target || null],
      );
      for (const row of rows) {
        await platformAudit({
          adminId: guard.session.padmin,
          businessId,
          action: "business.override.removed",
          entity: "business_billing_overrides",
          entityId: row.id,
          payload: {
            target: row.target,
            kind: row.kind,
            before: { valueInt: row.value_int, valueBool: row.value_bool, expiresAt: row.expires_at },
            after: null,
          },
        });
      }
      return NextResponse.json({ ok: true, removed: rows.length });
    }

    const kind = body.kind === "capability" ? "capability" : "limit";
    const target = String(body.target ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!target || reason.length < 4) {
      return NextResponse.json({ error: "missing_fields" }, { status: 400 });
    }

    let valueInt: number | null = null;
    let valueBool: boolean | null = null;
    if (kind === "limit") {
      if (!LIMIT_TARGETS.has(target)) {
        return NextResponse.json({ error: "bad_request" }, { status: 400 });
      }
      if (body.unlimited === true) {
        valueInt = null;
      } else {
        const value = Math.floor(Number(body.value ?? NaN));
        if (!Number.isSafeInteger(value) || value < 0) {
          return NextResponse.json({ error: "invalid_limit" }, { status: 400 });
        }
        valueInt = value;
      }
    } else {
      valueBool = body.enabled === true;
    }

    // Validate first, serialize second. Calling `.toISOString()` on the result
    // of an unvalidated `new Date("garbage")` throws `RangeError`, which used to
    // surface as a 500 for what is simply a bad request body.
    let expiresAt: string | null = null;
    if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
      if (typeof body.expiresAt !== "string") {
        return NextResponse.json({ error: "invalid_date" }, { status: 400 });
      }
      const parsed = new Date(body.expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "invalid_date" }, { status: 400 });
      }
      expiresAt = parsed.toISOString();
    }

    const { rows: before } = await query<{
      id: string;
      value_int: number | null;
      value_bool: boolean | null;
      expires_at: string | null;
      active: boolean;
    }>(
      `SELECT id, value_int, value_bool, expires_at, active FROM business_billing_overrides
        WHERE business_id = $1 AND kind = $2 AND target = $3`,
      [businessId, kind, target],
    );

    const { rows } = await query<{ id: string }>(
      `INSERT INTO business_billing_overrides
         (business_id, kind, target, value_int, value_bool, reason, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, kind, target) DO UPDATE SET
         value_int = EXCLUDED.value_int,
         value_bool = EXCLUDED.value_bool,
         reason = EXCLUDED.reason,
         created_by = EXCLUDED.created_by,
         created_at = now(),
         expires_at = EXCLUDED.expires_at,
         active = true
       RETURNING id`,
      [businessId, kind, target, valueInt, valueBool, reason, guard.session.padmin, expiresAt],
    );

    // Create and update are different events: an update that moves an expiry is
    // the one that silently changes access later, so it must not read as "a new
    // override was created".
    const previous = before[0];
    await platformAudit({
      adminId: guard.session.padmin,
      businessId,
      action: previous ? "business.override.updated" : "business.override.created",
      entity: "business_billing_overrides",
      entityId: rows[0].id,
      payload: {
        kind,
        target,
        reason,
        before: previous
          ? { valueInt: previous.value_int, valueBool: previous.value_bool, expiresAt: previous.expires_at, active: previous.active }
          : null,
        after: { valueInt, valueBool, expiresAt, active: true },
      },
    });
    return NextResponse.json({ ok: true, id: rows[0].id });
  },
);
