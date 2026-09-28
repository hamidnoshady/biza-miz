import { IAM_EVENT_TYPES, IAM_SCHEMA_VERSION, type IamEvent, type IamEventType } from "./model";

const eventTypes = new Set<string>(IAM_EVENT_TYPES);
export type EventValidation = { ok: true; event: IamEvent } | { ok: false; code: "unknown_event" | "unsupported_schema" | "invalid_event" };

export function validateIamEvent(value: unknown): EventValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, code: "invalid_event" };
  const event = value as Partial<IamEvent>;
  if (event.schemaVersion !== IAM_SCHEMA_VERSION) return { ok: false, code: "unsupported_schema" };
  if (!eventTypes.has(String(event.eventType))) return { ok: false, code: "unknown_event" };
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) <= 0 || !event.id || !event.businessId || !event.entityId) {
    return { ok: false, code: "invalid_event" };
  }
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return { ok: false, code: "invalid_event" };
  return { ok: true, event: event as IamEvent };
}

export function iamEntityTypeFor(type: IamEventType): IamEvent["entityType"] {
  if (type.startsWith("membership.")) return "membership";
  if (type.startsWith("tenant_role.")) return "tenant_role";
  return "credential";
}
