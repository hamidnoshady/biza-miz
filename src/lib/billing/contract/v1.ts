import { meterByKey } from "../catalog/meters";

export const CONTRACT_NAMESPACE = "billing-contract/v1";
export const CONTRACT_VERSION = 1;
export const USAGE_SOURCE = "eshobe-cms";

export type UsageKind = "measurement" | "correction";

export type UsageEventV1 = {
  eventId: string;
  siteId: string;
  meterKey: string;
  quantity: number;
  unit: string;
  kind: UsageKind;
  occurredAt: string;
  periodStart: string;
  periodEnd: string;
  resourceType: string | null;
  resourceId: string | null;
  dimensions: Record<string, string>;
  correctsEventId: string | null;
  correctionReason: string | null;
  actor: string | null;
};

export type UsageBatchV1 = {
  contractVersion: number;
  source: typeof USAGE_SOURCE;
  events: UsageEventV1[];
};

const FORBIDDEN_KEYS = [
  "amount",
  "businessid",
  "business_id",
  "credit",
  "currency",
  "invoice",
  "price",
  "wallet",
] as const;

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
};

const stringDimensions = (value: unknown): Record<string, string> | null => {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9._-]{1,64}$/i.test(key)) return null;
    if (typeof raw !== "string" || raw.length > 200) return null;
    out[key] = raw;
  }
  return out;
};

export type ContractError = { code: string; path: string };

export function parseUsageEvent(input: unknown): { event: UsageEventV1 } | { error: ContractError } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: { code: "invalid_event", path: "" } };
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase() as (typeof FORBIDDEN_KEYS)[number])) {
      return { error: { code: "forbidden_field", path: key } };
    }
  }
  if (raw.contractVersion !== undefined && raw.contractVersion !== CONTRACT_VERSION) {
    return { error: { code: "contract_mismatch", path: "contractVersion" } };
  }
  const eventId = typeof raw.eventId === "string" ? raw.eventId : "";
  if (!/^[a-zA-Z0-9:._-]{8,200}$/.test(eventId)) {
    return { error: { code: "invalid_event", path: "eventId" } };
  }
  const siteId = typeof raw.siteId === "string" ? raw.siteId : "";
  if (siteId.length < 8) return { error: { code: "invalid_event", path: "siteId" } };

  const meterKey = typeof raw.meterKey === "string" ? raw.meterKey : "";
  const meter = meterByKey(meterKey);
  if (!meter || meter.source !== "eshobe-cms") {
    return { error: { code: "unknown_meter", path: "meterKey" } };
  }
  if (raw.unit !== meter.unit) {
    return { error: { code: "invalid_unit", path: "unit" } };
  }

  const kind: UsageKind = raw.kind === "correction" ? "correction" : "measurement";
  const quantity = raw.quantity;
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity)) {
    return { error: { code: "invalid_event", path: "quantity" } };
  }
  if (kind === "measurement" && quantity <= 0) {
    return { error: { code: "invalid_event", path: "quantity" } };
  }
  if (kind === "correction" && quantity === 0) {
    return { error: { code: "invalid_event", path: "quantity" } };
  }

  const periodStart = iso(raw.periodStart);
  const periodEnd = iso(raw.periodEnd);
  const occurredAt = iso(raw.occurredAt ?? raw.periodStart);
  if (!periodStart || !periodEnd || !occurredAt) {
    return { error: { code: "invalid_event", path: "periodStart" } };
  }
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) {
    return { error: { code: "invalid_event", path: "periodEnd" } };
  }

  const dimensions = stringDimensions(raw.dimensions);
  if (!dimensions) return { error: { code: "invalid_event", path: "dimensions" } };

  const correctsEventId = typeof raw.correctsEventId === "string" ? raw.correctsEventId : null;
  const correctionReason = typeof raw.correctionReason === "string" ? raw.correctionReason.slice(0, 500) : null;
  const actor = typeof raw.actor === "string" ? raw.actor.slice(0, 120) : null;
  if (kind === "correction" && (!correctsEventId || !correctionReason || !actor)) {
    return { error: { code: "invalid_event", path: "correctsEventId" } };
  }

  return {
    event: {
      actor: kind === "correction" ? actor : null,
      correctsEventId: kind === "correction" ? correctsEventId : null,
      correctionReason: kind === "correction" ? correctionReason : null,
      dimensions,
      eventId,
      kind,
      meterKey,
      occurredAt,
      periodEnd,
      periodStart,
      quantity,
      resourceId: typeof raw.resourceId === "string" ? raw.resourceId.slice(0, 200) : null,
      resourceType: typeof raw.resourceType === "string" ? raw.resourceType.slice(0, 64) : null,
      siteId,
      unit: meter.unit,
    },
  };
}

/** Validates batch envelope only; events are parsed per-item at ingest time. */
export function parseUsageBatchEnvelope(
  input: unknown,
): { envelope: { events: unknown[] } } | { error: ContractError } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: { code: "contract_mismatch", path: "" } };
  }
  const raw = input as Record<string, unknown>;
  if (raw.source !== USAGE_SOURCE) {
    return { error: { code: "contract_mismatch", path: "source" } };
  }
  if (raw.contractVersion !== CONTRACT_VERSION) {
    return { error: { code: "contract_mismatch", path: "contractVersion" } };
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > 100) {
    return { error: { code: "contract_mismatch", path: "events" } };
  }
  return { envelope: { events: raw.events } };
}

export function parseUsageBatch(input: unknown): { batch: UsageBatchV1 } | { error: ContractError } {
  const envelope = parseUsageBatchEnvelope(input);
  if ("error" in envelope) return envelope;
  const events: UsageEventV1[] = [];
  for (const [index, item] of envelope.envelope.events.entries()) {
    const parsed = parseUsageEvent(item);
    if ("error" in parsed) {
      return { error: { ...parsed.error, path: `events[${index}].${parsed.error.path}` } };
    }
    events.push(parsed.event);
  }
  return { batch: { contractVersion: CONTRACT_VERSION, events, source: USAGE_SOURCE } };
}

export type EntitlementLimitClause = { state: "limit"; value: number } | { state: "unlimited" };

export type EntitlementPayloadV1 = {
  siteId: string;
  version: number;
  planCode: string;
  serving: boolean;
  features: Record<string, boolean>;
  limits: Record<string, EntitlementLimitClause>;
  billingCycleStart?: string | null;
  billingCycleEnd?: string | null;
  subscriptionStatus?: string | null;
  effectiveAt?: string | null;
};

const QUOTA_METRICS = [
  "pages",
  "posts",
  "products",
  "media",
  "mediaStorageMb",
  "categories",
  "users",
  "apiKeys",
  "ordersPerMonth",
  "apiRequestsPerMonth",
  "domains",
] as const;

export function parseLimitMap(input: unknown): { limits: Record<string, EntitlementLimitClause> } | { error: string } {
  if (input == null) return { limits: {} };
  if (typeof input !== "object" || Array.isArray(input)) return { error: "limits must be an object" };
  const limits: Record<string, EntitlementLimitClause> = {};
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!(QUOTA_METRICS as readonly string[]).includes(key)) return { error: `unknown limit metric: ${key}` };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `invalid limit clause: ${key}` };
    const clause = raw as { state?: unknown; value?: unknown };
    if (clause.state === "unlimited") {
      limits[key] = { state: "unlimited" };
      continue;
    }
    if (clause.state === "limit") {
      if (typeof clause.value !== "number" || !Number.isSafeInteger(clause.value) || clause.value <= 0) {
        return { error: `limit value for ${key} must be a positive integer` };
      }
      limits[key] = { state: "limit", value: clause.value };
      continue;
    }
    return { error: `limit state for ${key} must be limit or unlimited` };
  }
  return { limits };
}

export function parseEntitlementPush(body: unknown): { payload: EntitlementPayloadV1 } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body must be an object" };
  const raw = body as Record<string, unknown>;
  if ("businessId" in raw || "business_id" in raw || "price" in raw || "wallet" in raw) {
    return { error: "entitlement push cannot carry business id or money fields" };
  }
  const siteId = typeof raw.siteId === "string" ? raw.siteId : "";
  if (siteId.length < 8) return { error: "invalid siteId" };
  const version = Number(raw.version);
  if (!Number.isSafeInteger(version) || version < 1) return { error: "version must be a positive integer" };
  const planCode = typeof raw.planCode === "string" ? raw.planCode.trim() : "";
  if (!planCode || planCode.length > 64) return { error: "planCode is required" };
  const limitsParsed = parseLimitMap(raw.limits);
  if ("error" in limitsParsed) return limitsParsed;
  const features: Record<string, boolean> = {};
  if (raw.features && typeof raw.features === "object" && !Array.isArray(raw.features)) {
    for (const [key, value] of Object.entries(raw.features as Record<string, unknown>)) {
      if (typeof value === "boolean") features[key] = value;
    }
  }
  return {
    payload: {
      features,
      limits: limitsParsed.limits,
      planCode,
      serving: raw.serving === true,
      siteId,
      subscriptionStatus: typeof raw.subscriptionStatus === "string" ? raw.subscriptionStatus.slice(0, 32) : null,
      version,
      billingCycleEnd: typeof raw.billingCycleEnd === "string" ? raw.billingCycleEnd : null,
      billingCycleStart: typeof raw.billingCycleStart === "string" ? raw.billingCycleStart : null,
      effectiveAt: typeof raw.effectiveAt === "string" ? raw.effectiveAt : null,
    },
  };
}
