import { NextResponse } from "next/server";
import type { MembershipContext } from "./authorize";
import type { Role } from "./auth";
import { payrollErrorResponse } from "./payroll-http";
import { ShareholderError, type CapitalMovementInput, type CreateDistributionInput, type DistributionPaymentInput, type OwnershipChangeInput, type ShareholderActor } from "./shareholder-service";
import type { OwnershipEventType, OwnershipTotalPolicy } from "./shareholder-accounting";

export function shareholderActorOf(session: { sub: string }, membership: MembershipContext): ShareholderActor {
  return { userId: session.sub, role: membership.role as Role, permissions: membership.permissions };
}

export function shareholderErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof ShareholderError) {
    return NextResponse.json({ error: error.message, ...(error.details ?? {}) }, { status: error.status });
  }
  return payrollErrorResponse(error);
}

export function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ShareholderError("invalid_request_body", 400);
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ShareholderError(`invalid_${field}`, 400);
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ShareholderError(`invalid_${field}`, 400);
  return value.trim() || null;
}

export function idempotencyKeyFrom(request: Request, body?: Record<string, unknown>): unknown {
  return request.headers.get("idempotency-key") ?? body?.idempotencyKey;
}

export function parseOwnershipPolicy(value: unknown): OwnershipTotalPolicy {
  if (value !== "at_most_100" && value !== "exactly_100") throw new ShareholderError("invalid_ownership_policy", 400);
  return value;
}

const OWNERSHIP_TYPES = new Set<OwnershipEventType>([
  "shareholder_added", "ownership_changed", "shareholder_removed", "ownership_transfer_out", "ownership_transfer_in",
]);

export function parseOwnershipEvents(value: unknown): OwnershipChangeInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new ShareholderError("invalid_ownership_events", 400);
  return value.map((item, index) => {
    const event = requireObject(item);
    const eventType = event.eventType;
    if (typeof eventType !== "string" || !OWNERSHIP_TYPES.has(eventType as OwnershipEventType)) {
      throw new ShareholderError("invalid_event_type", 400, { index });
    }
    for (const field of ["partyId", "effectiveOn", "ownershipPercent", "reason"] as const) {
      if (typeof event[field] !== "string" || !String(event[field]).trim()) {
        throw new ShareholderError(`invalid_${field}`, 400, { index });
      }
    }
    for (const field of ["shareUnits", "transferPercent", "transferGroupId", "sourceReference", "notes"] as const) {
      if (event[field] !== undefined && event[field] !== null && typeof event[field] !== "string") {
        throw new ShareholderError(`invalid_${field}`, 400, { index });
      }
    }
    return {
      partyId: event.partyId as string,
      eventType: eventType as OwnershipEventType,
      effectiveOn: event.effectiveOn as string,
      ownershipPercent: event.ownershipPercent as string,
      shareUnits: event.shareUnits as string | null | undefined,
      transferPercent: event.transferPercent as string | null | undefined,
      transferGroupId: event.transferGroupId as string | null | undefined,
      reason: event.reason as string,
      sourceReference: event.sourceReference as string | null | undefined,
      notes: event.notes as string | null | undefined,
    };
  });
}

export function parseCapitalMovement(bodyValue: unknown): CapitalMovementInput {
  const body = requireObject(bodyValue);
  const eventType = body.eventType;
  if (eventType !== "capital_contribution" && eventType !== "capital_withdrawal") {
    throw new ShareholderError("invalid_capital_event_type", 400);
  }
  const capitalClass = body.capitalClass;
  if (capitalClass !== "equity" && capitalClass !== "additional_paid_in_capital" && capitalClass !== "shareholder_loan") {
    throw new ShareholderError("invalid_capital_class", 400);
  }
  return {
    partyId: requiredString(body, "partyId"),
    eventType,
    capitalClass,
    amountRial: requiredString(body, "amountRial"),
    paymentAccountId: requiredString(body, "paymentAccountId"),
    effectiveOn: requiredString(body, "effectiveOn"),
    sourceReference: optionalString(body, "sourceReference"),
    reason: requiredString(body, "reason"),
    notes: optionalString(body, "notes"),
  };
}

export function parseDistribution(bodyValue: unknown): CreateDistributionInput {
  const body = requireObject(bodyValue);
  return {
    fiscalYearId: requiredString(body, "fiscalYearId"),
    snapshotOn: requiredString(body, "snapshotOn"),
    taxAdjustmentRial: requiredString(body, "taxAdjustmentRial"),
    reserveAdjustmentRial: requiredString(body, "reserveAdjustmentRial"),
    manualAdjustmentRial: typeof body.manualAdjustmentRial === "string" ? body.manualAdjustmentRial : "0",
    adjustmentReason: optionalString(body, "adjustmentReason"),
    sourceReference: optionalString(body, "sourceReference"),
  };
}

export function parseDistributionPayment(bodyValue: unknown): DistributionPaymentInput {
  const body = requireObject(bodyValue);
  return {
    shareholderId: requiredString(body, "shareholderId"),
    amountRial: requiredString(body, "amountRial"),
    paidOn: requiredString(body, "paidOn"),
    paymentAccountId: requiredString(body, "paymentAccountId"),
    note: optionalString(body, "note"),
  };
}

export function parseReason(bodyValue: unknown): string {
  const body = requireObject(bodyValue);
  return requiredString(body, "reason");
}
