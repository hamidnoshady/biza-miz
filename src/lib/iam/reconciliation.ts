import { createHash } from "node:crypto";
import type { IamEvent, IamMembership, IamTenantRole } from "./model";
import { validateIamEvent } from "./events";

export type SequenceDecision =
  | { action: "apply" }
  | { action: "ignore_duplicate" }
  | { action: "recover_gap"; expected: number; received: number }
  | { action: "dead_letter"; code: string };

/** Advancement is strict: duplicates are harmless, gaps stop the cursor. */
export function sequenceDecision(lastSequence: number, raw: unknown): SequenceDecision {
  const validation = validateIamEvent(raw);
  if (!validation.ok) return { action: "dead_letter", code: validation.code };
  const sequence = validation.event.sequence;
  if (sequence <= lastSequence) return { action: "ignore_duplicate" };
  if (sequence !== lastSequence + 1) return { action: "recover_gap", expected: lastSequence + 1, received: sequence };
  return { action: "apply" };
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function iamStateHash(memberships: readonly IamMembership[], roles: readonly IamTenantRole[]): string {
  const state = {
    memberships: [...memberships].sort((a, b) => a.id.localeCompare(b.id)),
    roles: [...roles].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return createHash("sha256").update(stable(state)).digest("hex");
}

export interface ReplicaMutation {
  memberships: Map<string, IamMembership>;
  roles: Map<string, IamTenantRole>;
}

/** Pure deterministic reducer used by the transactional DB applier. */
export function applyIamEvent(state: ReplicaMutation, event: IamEvent): void {
  if (event.entityType === "membership") {
    if (event.eventType === "membership.offboarded" || event.eventType === "membership.suspended") {
      const existing = state.memberships.get(event.entityId);
      if (!existing) return;
      state.memberships.set(event.entityId, {
        ...existing, isActive: false,
        status: event.eventType === "membership.offboarded" ? "offboarded" : "suspended",
        revision: Math.max(existing.revision, Number(event.payload.revision ?? existing.revision)),
      });
      return;
    }
    const canonical = event.payload.membership;
    if (canonical && typeof canonical === "object") {
      const incoming = canonical as IamMembership;
      const existing = state.memberships.get(event.entityId);
      if (!existing || incoming.revision >= existing.revision) state.memberships.set(event.entityId, incoming);
    }
    return;
  }
  if (event.entityType === "tenant_role") {
    const canonical = event.payload.role;
    if (canonical && typeof canonical === "object") {
      const incoming = canonical as IamTenantRole;
      const existing = state.roles.get(event.entityId);
      if (!existing || incoming.revision >= existing.revision) state.roles.set(event.entityId, incoming);
    }
  }
}
