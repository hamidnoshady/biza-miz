import { NextRequest, NextResponse } from "next/server";
import {
  requirePlatformAdmin,
  requirePlatformCapability,
  platformAudit,
  withPlatformScope,
} from "@/lib/platform-auth";
import {
  getBusiness,
  setBusinessStatus,
  updateBusiness,
  renameBusinessSubdomain,
  changeBusinessIndustry,
  industryDataCounts,
  resetBusiness,
  hardDeleteBusiness,
  BusinessNotFoundError,
  BusinessDeleteBlockedError,
  ProtectedInternalBusinessError,
  ResetBusinessNotPossibleError,
  type BusinessStatus,
} from "@/lib/platform-service";
import { businessDestructivePhrase } from "@/lib/platform-admin";
import { AccountsError } from "@/lib/accounts-error";
import {
  businessLifecycleTransition,
  isBusinessLifecycleStatus,
} from "@/lib/platform-business-lifecycle";
import { ENABLED_INDUSTRIES, isIndustry, type Industry } from "@/lib/industries";
import { validateSubdomain } from "@/lib/slug";
import { rootDomain } from "@/lib/host";
import { listSubdomainAliases } from "@/lib/host-resolution";

interface Ctx {
  params: Promise<{ id: string }>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidTimezone(value: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** One business's summary — any admin reads. */
export const GET = withPlatformScope(async (_request: NextRequest, ctx: Ctx) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // rootDomain and the alias list: the console renders the business's real URL
  // and the old hosts still pointing at it, and is a client component that
  // cannot read either for itself. `industryCounts` is the same idea for the
  // industry panel — it warns with real numbers about what a type change would
  // orphan, and cannot count rows for itself.
  return NextResponse.json({
    business,
    rootDomain: rootDomain(),
    aliases: await listSubdomainAliases(id),
    industryCounts: await industryDataCounts(id),
  });
});

/**
 * Edit one business: lifecycle status, industry, subdomain or metadata.
 *
 * A `status` move is authorized by the *transition*, not the destination
 * (`src/lib/platform-business-lifecycle.ts`): an engineer may suspend and
 * reactivate but may not touch the archive in either direction. The plan is
 * deliberately **not** editable here — assigning a plan is a commercial
 * lifecycle act with its own service and permission contract
 * (`POST /api/platform/billing/subscriptions`, `billing.manage`), and a second
 * write path through this generic PATCH is exactly what used to let a
 * `features.write` holder change a plan.
 *
 * Everything here is audited with the admin, business, and new value —
 * suspension leaves data untouched (exit criterion 2); the block happens at
 * login and the API guard, not by deletion.
 */
export const PATCH = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  // A generic admin check first so we can 401 before parsing; the capability
  // depends on what is being changed and is checked once we know.
  const auth = await requirePlatformAdmin();
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const target = await getBusiness(id);
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "protected_internal_business" }, { status: 409 });
  }

  const hasStatus = body.status !== undefined;
  const hasMetadata = body.name !== undefined || body.timezone !== undefined;
  // Phase 23: renaming the public host is its own action, not another
  // metadata field — it writes an alias and invalidates live sessions, so it
  // must not ride along with an unrelated edit in the same request.
  const hasSubdomain = body.subdomain !== undefined;
  // Phase 25: changing the industry re-shapes which modules the tenant has and
  // tops up its chart of accounts, so — like a subdomain rename — it is its own
  // action rather than a metadata field riding along with an unrelated edit.
  const hasIndustry = body.industry !== undefined;
  // One action per request — except that naming `plan` at all is a retired
  // caller, refused with a pointer rather than silently ignored.
  if (body.plan !== undefined) {
    return NextResponse.json({ error: "plan_change_moved_to_billing" }, { status: 400 });
  }
  if (
    Number(hasStatus) + Number(hasMetadata) + Number(hasSubdomain) + Number(hasIndustry) !==
    1
  ) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (hasIndustry) {
    if (typeof body.industry !== "string" || !isIndustry(body.industry)) {
      return NextResponse.json({ error: "invalid_industry" }, { status: 400 });
    }
    const industry: Industry = body.industry;
    if (!ENABLED_INDUSTRIES.includes(industry)) {
      return NextResponse.json({ error: "industry_not_available" }, { status: 400 });
    }

    const guard = await requirePlatformCapability("business.edit");
    if (guard.error) return guard.error;

    const existing = await getBusiness(id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (existing.industry === industry) {
      return NextResponse.json({ business: existing, seededAccountCodes: [] });
    }

    let result: Awaited<ReturnType<typeof changeBusinessIndustry>>;
    try {
      result = await changeBusinessIndustry(id, industry);
    } catch (err) {
      // A live-chart conflict (an archived parent, or a parent of another type)
      // rolled the whole change back. It is reported as itself, not as a 500.
      if (err instanceof AccountsError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
    if (!result) return NextResponse.json({ error: "not_found" }, { status: 404 });

    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: "business.industry_change",
      entity: "business",
      entityId: id,
      // `from` is the whole point of this record: once the column is
      // overwritten, nothing else remembers what the tenant used to be.
      payload: {
        from: existing.industry,
        to: industry,
        seededAccountCodes: result.seededAccountCodes,
      },
    });
    return NextResponse.json({ business: result.business, seededAccountCodes: result.seededAccountCodes });
  }

  if (hasSubdomain) {
    if (typeof body.subdomain !== "string") {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    const subdomain = body.subdomain.trim().toLowerCase();
    const invalid = validateSubdomain(subdomain);
    if (invalid) return NextResponse.json({ error: invalid }, { status: 400 });

    // Same capability as any other business edit, and audited the same way
    // business.provision is — a rename changes the URL a customer was given.
    const guard = await requirePlatformCapability("business.edit");
    if (guard.error) return guard.error;

    const result = await renameBusinessSubdomain(id, subdomain);
    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.error === "not_found" ? 404 : 409 },
      );
    }

    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: "business.subdomain",
      entity: "business",
      entityId: id,
      payload: { subdomain, previous: result.previous },
    });
    return NextResponse.json({ business: result.business });
  }

  if (hasStatus) {
    if (typeof body.status !== "string" || !isBusinessLifecycleStatus(body.status)) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    const status: BusinessStatus = body.status;

    // The current status decides *which* capability the move needs, so it has
    // to be read before the guard rather than assumed from the request.
    const existing = await getBusiness(id);
    if (!existing) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const decision = businessLifecycleTransition(existing.status, status);
    if (!decision.ok) {
      return NextResponse.json(
        { error: decision.error, from: existing.status, to: status },
        { status: 409 },
      );
    }

    const guard = await requirePlatformCapability(decision.transition.capability);
    if (guard.error) return guard.error;

    // `expectFrom` makes the move atomic: if another operator changed the
    // status between the read above and here, nothing is written and the
    // operator is told their screen was stale instead of silently winning.
    const updated = await setBusinessStatus(id, status, { expectFrom: existing.status });
    if (!updated) {
      return NextResponse.json(
        { error: "transition_conflict", from: existing.status, to: status },
        { status: 409 },
      );
    }

    await platformAudit({
      adminId: guard.session.padmin,
      businessId: id,
      action: decision.transition.auditAction,
      entity: "business",
      entityId: id,
      payload: {
        from: existing.status,
        to: status,
        capability: decision.transition.capability,
      },
    });
    return NextResponse.json({ business: updated });
  }

  const name =
    body.name === undefined
      ? undefined
      : typeof body.name === "string"
        ? body.name.trim()
        : null;
  const timezone =
    body.timezone === undefined
      ? undefined
      : typeof body.timezone === "string"
        ? body.timezone.trim()
        : null;
  if (name === null || timezone === null) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (name !== undefined && !name) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (timezone !== undefined && (!timezone || !isValidTimezone(timezone))) {
    return NextResponse.json({ error: "invalid_timezone" }, { status: 400 });
  }

  const guard = await requirePlatformCapability("business.edit");
  if (guard.error) return guard.error;

  const updated = await updateBusiness(id, { name, timezone });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const payload: Record<string, string> = {};
  if (name !== undefined) payload.name = name;
  if (timezone !== undefined) payload.timezone = timezone;
  await platformAudit({
    adminId: guard.session.padmin,
    businessId: id,
    action: "business.edit",
    entity: "business",
    entityId: id,
    payload,
  });
  return NextResponse.json({ business: updated });
});

/**
 * The audit `reason` for a failed destructive action. Deliberately a small
 * vocabulary of stable tokens instead of `err.message`: raw database text
 * (constraint names, deadlock detail, SQLSTATE…) is not operator-audit
 * material and must stay in the server logs, not in the audit trail
 * (issue #822).
 */
function safeDestructiveFailureReason(err: unknown, action: "reset" | "delete"): string {
  if (err instanceof ResetBusinessNotPossibleError) return "reset_not_possible";
  if (err instanceof ProtectedInternalBusinessError) return "protected_internal_business";
  if (err instanceof BusinessNotFoundError) return "not_found";
  if (err instanceof BusinessDeleteBlockedError) return "reference_blocked";
  return `${action}_unexpected_error`;
}

/**
 * Factory-reset one business after typing the target-specific confirmation
 * phrase (`RESET {slug}`). The business row itself survives — id, status,
 * creation date, subscription, wallet, invoices/payments and the platform-
 * company mappings are all preserved (see `resetBusiness`); the tenant's
 * operational data is cleared and the owner returns to the first-run setup
 * wizard.
 *
 * Audit lifecycle (same standard as hard delete): `business.reset.requested`
 * only after a valid permission + confirmation, `business.reset.completed`
 * only after the transaction committed, `business.reset.failed` when it did
 * not — with an audit-safe reason.
 */
export const POST = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.reset");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (business.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "protected_internal_business" }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
  if (confirmation !== businessDestructivePhrase("reset", business.slug)) {
    return NextResponse.json({ error: "reset_confirmation_required" }, { status: 400 });
  }

  const identity = {
    name: business.name,
    slug: business.slug,
    plan: business.plan,
    status: business.status,
  };
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "business.reset.requested",
    entity: "business",
    entityId: id,
    payload: identity,
  });

  try {
    await resetBusiness(id);
  } catch (err) {
    if (err instanceof ResetBusinessNotPossibleError) {
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "business.reset.failed",
        entity: "business",
        entityId: id,
        payload: { ...identity, reason: safeDestructiveFailureReason(err, "reset") },
      });
      return NextResponse.json({ error: "reset_not_possible" }, { status: 409 });
    }
    if (err instanceof ProtectedInternalBusinessError) {
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "business.reset.failed",
        entity: "business",
        entityId: id,
        payload: { ...identity, reason: safeDestructiveFailureReason(err, "reset") },
      });
      return NextResponse.json({ error: "protected_internal_business" }, { status: 409 });
    }
    // resetBusiness is one transaction, so this response also guarantees that
    // no partial reset was committed. Keep the database detail in server logs.
    console.error("platform business reset failed", { businessId: id, err });
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "business.reset.failed",
      entity: "business",
      entityId: id,
      payload: { ...identity, reason: safeDestructiveFailureReason(err, "reset") },
    });
    return NextResponse.json({ error: "reset_failed" }, { status: 500 });
  }

  // The business row survived the reset (that is the point of the refactor),
  // so the completion keeps its business_id — unlike hard delete's.
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "business.reset.completed",
    entity: "business",
    entityId: id,
    payload: identity,
  });
  return NextResponse.json({ ok: true });
});

/**
 * Hard-delete a business — immediately, irreversibly, no archive step and no
 * grace window. Owner-only (`business.delete`) and gated on the target-
 * specific typed phrase (`DELETE {slug}`) — with the grace window gone, that
 * pairing (owner capability + typed phrase) is the only safety net left. The
 * audit row survives the delete because `platform_audit_log.business_id` is
 * ON DELETE SET NULL, so the record that it happened outlives the thing it
 * happened to.
 */
export const DELETE = withPlatformScope(async (request: NextRequest, ctx: Ctx) => {
  const { session, error } = await requirePlatformCapability("business.delete");
  if (error) return error;

  const { id } = await ctx.params;
  const business = await getBusiness(id);
  if (!business) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (business.ownershipKind === "platform_internal") {
    return NextResponse.json({ error: "protected_internal_business" }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!isObject(raw)) throw new Error("invalid_body");
    body = raw;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const confirmation = typeof body.confirmation === "string" ? body.confirmation.trim() : "";
  if (confirmation !== businessDestructivePhrase("delete", business.slug)) {
    return NextResponse.json({ error: "delete_confirmation_required" }, { status: 400 });
  }

  // The identity of the business has to be captured before the row disappears,
  // and the audit trail has to say what actually happened. A single
  // "business.delete" written up front claimed success even when the delete
  // then threw, so the trail is three explicit lifecycle events:
  //   requested -> completed | failed
  // `completed` is written only after the delete committed, so its presence is
  // evidence the business is really gone.
  const identity = {
    name: business.name,
    slug: business.slug,
    plan: business.plan,
    status: business.status,
  };
  await platformAudit({
    adminId: session.padmin,
    businessId: id,
    action: "business.delete.requested",
    entity: "business",
    entityId: id,
    payload: identity,
  });

  let result: Awaited<ReturnType<typeof hardDeleteBusiness>>;
  try {
    result = await hardDeleteBusiness(id);
  } catch (err) {
    if (err instanceof BusinessNotFoundError) {
      // A race: the row was there when `requested` was audited and is gone
      // by the time the service takes its lock (a concurrent delete won).
      // The trail must not dangle a `requested` with no terminal event.
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "business.delete.failed",
        entity: "business",
        entityId: id,
        payload: { ...identity, reason: "not_found" },
      });
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (err instanceof ProtectedInternalBusinessError) {
      // Defense-in-depth only — the route refuses platform-internal tenants
      // before auditing `requested` — but if the deeper service check ever
      // fires, it maps to the same operator-facing 409, never a raw 500.
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "business.delete.failed",
        entity: "business",
        entityId: id,
        payload: { ...identity, reason: "protected_internal_business" },
      });
      return NextResponse.json({ error: "protected_internal_business" }, { status: 409 });
    }
    if (err instanceof BusinessDeleteBlockedError) {
      // A live reference the service has no deliberate rule for — a specific
      // operator-facing blocker (issue #822), never a raw FK error.
      await platformAudit({
        adminId: session.padmin,
        businessId: id,
        action: "business.delete.failed",
        entity: "business",
        entityId: id,
        payload: {
          ...identity,
          reason: "reference_blocked",
          reference: err.reference,
        },
      });
      return NextResponse.json(
        { error: "delete_blocked", reference: err.reference },
        { status: 409 },
      );
    }
    // hardDeleteBusiness is one transaction, so this response also guarantees
    // no partial delete was committed. Keep the database detail in server logs.
    console.error("platform business delete failed", { businessId: id, err });
    await platformAudit({
      adminId: session.padmin,
      businessId: id,
      action: "business.delete.failed",
      entity: "business",
      entityId: id,
      payload: {
        ...identity,
        reason: safeDestructiveFailureReason(err, "delete"),
      },
    });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  // The business row is gone. `platform_audit_log.business_id` has an FK to
  // `businesses`, so a completion written *after* the delete must leave it NULL
  // (a value would violate the FK) — the identity in the payload plus
  // `entity_id` is what still names what was deleted, which is why the same
  // payload rides on both the request and the completion.
  await platformAudit({
    adminId: session.padmin,
    businessId: null,
    action: "business.delete.completed",
    entity: "business",
    entityId: id,
    payload: {
      ...identity,
      detachedCustomerTenantMappings: result.detachedCustomerTenantMappings,
    },
  });
  return NextResponse.json({ ok: true });
});
