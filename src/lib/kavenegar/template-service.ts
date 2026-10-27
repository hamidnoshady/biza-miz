/**
 * Issue #902 — the tenant-visible Lookup template catalog.
 *
 * The provider gates verification/transactional messages behind approved
 * templates. A tenant must be able to say "کد ورود" and get the approved
 * message, without ever learning that a template exists, that it is under
 * review, or why a supplier rejected it.
 *
 * Therefore:
 *
 *   * a tenant creates a **draft** with its own first-party title and body;
 *   * the platform (Superadmin path) submits it to the provider, on the
 *     business's own child account, never the master;
 *   * approval is synchronised back into a provider-neutral state, and any
 *     rejection is shown as an actionable sentence — never provider wording;
 *   * the provider's ASCII template name is derived deterministically, so a
 *     retried submission is recognisable and cannot create a second template.
 *
 * The pure half (validation, name derivation, state mapping) is at the top and
 * tested without a database. The provider call lives at the bottom and takes an
 * injectable client; nothing here is reachable from a tenant route.
 */
import { createHash } from "node:crypto";
import { query, withoutTenantScope } from "../db";
import { readAccountApiKey } from "./credentials";
import type { KavenegarManagementClient } from "./rest";
import type { KavenegarTemplate } from "./client";

export type LookupPurpose = "verification" | "transactional";
export type LookupTemplateState = "draft" | "submitted" | "approved" | "rejected" | "disabled";

/** First-party statuses a tenant may see. */
export type TenantTemplateStatus = "in_review" | "ready" | "needs_action" | "disabled";

export const TENANT_TEMPLATE_STATUS_LABELS: Record<TenantTemplateStatus, string> = {
  in_review: "در حال بررسی",
  ready: "آمادهٔ استفاده",
  needs_action: "نیازمند اصلاح",
  disabled: "غیرفعال",
};

export type LookupTemplateValidation =
  | { ok: true; title: string; body: string; purpose: LookupPurpose }
  | { ok: false; code: LookupTemplateErrorCode };

export type LookupTemplateErrorCode =
  | "title_required"
  | "title_too_long"
  | "body_required"
  | "body_too_long"
  | "missing_token"
  | "unsupported_token"
  | "unknown_purpose";

/** Provider limit for one UCS-2 segment of a Persian template. */
export const MAX_PERSIAN_TEMPLATE_CHARS = 268;
/** Provider limit for one Latin template. */
export const MAX_LATIN_TEMPLATE_CHARS = 612;

/**
 * Validate a tenant-authored template.
 *
 * The body rule is the provider's (`%token` required, numbered variants up to
 * `%token20` allowed). Everything else is ours: a title is required because the
 * tenant's screen identifies the message by its title, never by the derived
 * provider name.
 */
export function validateLookupTemplate(input: {
  title: string;
  body: string;
  purpose: string;
}): LookupTemplateValidation {
  const title = input.title.trim().replace(/\s+/g, " ");
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (!title) return { ok: false, code: "title_required" };
  if (title.length > 80) return { ok: false, code: "title_too_long" };
  if (!body) return { ok: false, code: "body_required" };
  const limit = /[^\u0000-\u007f]/.test(body)
    ? MAX_PERSIAN_TEMPLATE_CHARS
    : MAX_LATIN_TEMPLATE_CHARS;
  if (body.length > limit) return { ok: false, code: "body_too_long" };
  if (!/%token\d{0,2}/.test(body)) return { ok: false, code: "missing_token" };
  // Every `%` must start a supported token: a stray `%name` would be sent
  // literally and the customer would receive it verbatim.
  for (const match of body.matchAll(/%[A-Za-z0-9_]*/g)) {
    if (!/^%token\d{0,2}$/.test(match[0])) return { ok: false, code: "unsupported_token" };
  }
  if (input.purpose !== "verification" && input.purpose !== "transactional") {
    return { ok: false, code: "unknown_purpose" };
  }
  return { ok: true, title, body, purpose: input.purpose };
}

/**
 * The provider's template name: ASCII, no spaces, stable for the same input.
 *
 * A provider name is an implementation detail. Deriving it from the content
 * means a double-submit produces the same name (and therefore the provider's
 * duplicate-name error, which the sync path resolves), rather than two approved
 * templates with different names for the same message.
 */
export function lookupTemplateName(input: {
  businessId: string;
  title: string;
  body: string;
  purpose: LookupPurpose;
}): string {
  const digest = createHash("sha256")
    .update(`${input.businessId}\u0000${input.purpose}\u0000${input.title}\u0000${input.body}`)
    .digest("hex")
    .slice(0, 10);
  return `${input.purpose === "verification" ? "bmv" : "bmt"}${digest}`;
}

/** Provider approval → our lifecycle. */
export function stateForProviderApproval(
  approval: KavenegarTemplate["approvalStatus"],
): LookupTemplateState {
  switch (approval) {
    case "approved":
      return "approved";
    case "pending":
      return "submitted";
    case "rejected":
      return "rejected";
    default:
      return "submitted";
  }
}

/** Internal state → the only status a tenant sees. */
export function tenantTemplateStatus(state: LookupTemplateState): TenantTemplateStatus {
  switch (state) {
    case "approved":
      return "ready";
    case "rejected":
      return "needs_action";
    case "disabled":
      return "disabled";
    case "draft":
    case "submitted":
      return "in_review";
  }
}

export type LookupTemplateRow = {
  id: string;
  business_id: string;
  name: string;
  title: string;
  body: string;
  purpose: LookupPurpose;
  state: LookupTemplateState;
  provider_template_id: string | number | null;
  last_sync_error: string | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const TEMPLATE_COLUMNS = `id, business_id, name, title, body, purpose, state,
       provider_template_id, last_sync_error, submitted_at, decided_at,
       last_synced_at, created_at, updated_at`;

/** Tenant-scoped read: the business's own catalog, never another's. */
export async function listLookupTemplates(businessId: string): Promise<LookupTemplateRow[]> {
  const { rows } = await query<LookupTemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM kavenegar_lookup_templates
      WHERE business_id = $1
      ORDER BY created_at DESC`,
    [businessId],
  );
  return rows;
}

/** What a tenant screen is allowed to receive. */
export interface TenantLookupTemplate {
  id: string;
  title: string;
  purpose: LookupPurpose;
  status: TenantTemplateStatus;
  statusLabel: string;
  updatedAt: string;
}

export function toTenantLookupTemplates(rows: LookupTemplateRow[]): TenantLookupTemplate[] {
  return rows.map((row) => {
    const status = tenantTemplateStatus(row.state);
    return {
      id: row.id,
      title: row.title,
      purpose: row.purpose,
      status,
      statusLabel: TENANT_TEMPLATE_STATUS_LABELS[status],
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export class LookupTemplateError extends Error {
  constructor(readonly code: LookupTemplateErrorCode | "template_not_found") {
    super(code);
    this.name = "LookupTemplateError";
  }
}

/**
 * Create a draft for the current business.
 *
 * The tenant never chooses the provider name, and a draft cannot be used for
 * sending: `sendManagedLookup` only accepts `approved`.
 */
export async function createLookupTemplate(input: {
  businessId: string;
  title: string;
  body: string;
  purpose: string;
}): Promise<LookupTemplateRow> {
  const validated = validateLookupTemplate(input);
  if (!validated.ok) throw new LookupTemplateError(validated.code);
  const name = lookupTemplateName({
    businessId: input.businessId,
    title: validated.title,
    body: validated.body,
    purpose: validated.purpose,
  });
  const { rows } = await query<LookupTemplateRow>(
    `INSERT INTO kavenegar_lookup_templates (business_id, name, title, body, purpose)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (business_id, name) DO UPDATE
       SET updated_at = now()
     RETURNING ${TEMPLATE_COLUMNS}`,
    [input.businessId, name, validated.title, validated.body, validated.purpose],
  );
  return rows[0];
}

/** Platform-only read by id (the submit/sync paths act across tenants). */
async function readTemplateById(templateId: string): Promise<LookupTemplateRow | null> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<LookupTemplateRow>(
      `SELECT ${TEMPLATE_COLUMNS} FROM kavenegar_lookup_templates WHERE id = $1`,
      [templateId],
    ),
  );
  return rows[0] ?? null;
}

async function activeChildFor(businessId: string): Promise<{
  accountId: string;
  apiKey: string;
} | null> {
  const account = await withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<{ id: string; provision_state: string }>(
      `SELECT id, provision_state FROM kavenegar_business_accounts WHERE business_id = $1`,
      [businessId],
    );
    return rows[0] ?? null;
  });
  if (!account || account.provision_state !== "active") return null;
  const credential = await readAccountApiKey(account.id);
  if (!credential.ok) return null;
  return { accountId: account.id, apiKey: credential.credential.apiKey };
}

/**
 * Submit a draft to the provider on the business's own child account.
 *
 * An ambiguous response is NOT retried blindly: the row records
 * `outcome_unknown` and the sync (which reads the provider's template list by
 * name) resolves it. That is the template counterpart of the account's
 * `fetchbylocalid` recovery.
 */
export async function submitLookupTemplate(input: {
  templateId: string;
  client: KavenegarManagementClient;
  primaryLineNumber?: string;
}): Promise<LookupTemplateRow> {
  const template = await readTemplateById(input.templateId);
  if (!template) throw new LookupTemplateError("template_not_found");
  if (template.state === "approved" || template.state === "disabled") return template;

  const child = await activeChildFor(template.business_id);
  if (!child) {
    return updateTemplate(template.id, {
      lastSyncError: "child_not_active",
    });
  }

  try {
    const created = await input.client.addTemplate({
      childApiKey: child.apiKey,
      name: template.name,
      textMessage: template.body,
      primaryLineNumber: input.primaryLineNumber,
    });
    return updateTemplate(template.id, {
      state: stateForProviderApproval(created.approvalStatus),
      providerTemplateId: created.templateId,
      submitted: true,
      lastSyncError: null,
    });
  } catch (error) {
    const ambiguous = (error as { ambiguous?: boolean })?.ambiguous === true;
    const classification = (error as { classification?: { code?: string } })?.classification;
    const providerStatus = (error as { providerStatus?: number | null })?.providerStatus ?? null;
    // The provider's "template name already exists" (602) also means "it is
    // already there" — the sync adopts it instead of creating a second one.
    const duplicate = providerStatus === 602;
    return updateTemplate(template.id, {
      state: duplicate ? "submitted" : template.state,
      submitted: duplicate,
      lastSyncError: ambiguous ? "outcome_unknown" : (classification?.code ?? "submit_failed"),
    });
  }
}

/**
 * Read the child's provider templates and reconcile our rows by derived name.
 *
 * Only templates WE created are touched: an operator's hand-made template in the
 * provider panel is not silently adopted into a tenant's catalog.
 */
export async function syncLookupTemplates(input: {
  businessId: string;
  client: KavenegarManagementClient;
}): Promise<{ updated: number; approved: number; rejected: number }> {
  const rows = await listLookupTemplates(input.businessId);
  if (rows.length === 0) return { updated: 0, approved: 0, rejected: 0 };
  const child = await activeChildFor(input.businessId);
  if (!child) return { updated: 0, approved: 0, rejected: 0 };

  const provider = await input.client.listTemplates({ childApiKey: child.apiKey });
  const byName = new Map(provider.templates.map((template) => [template.name, template]));
  let updated = 0;
  let approved = 0;
  let rejected = 0;
  for (const row of rows) {
    if (row.state === "disabled") continue;
    const remote = byName.get(row.name);
    if (!remote) continue;
    const state = stateForProviderApproval(remote.approvalStatus);
    if (state === row.state && String(remote.templateId) === String(row.provider_template_id ?? "")) {
      continue;
    }
    await updateTemplate(row.id, {
      state,
      providerTemplateId: remote.templateId,
      submitted: state !== "draft",
      lastSyncError: null,
    });
    updated += 1;
    if (state === "approved") approved += 1;
    if (state === "rejected") rejected += 1;
  }
  return { updated, approved, rejected };
}

/** Stop automation for a template without deleting its history. */
export async function disableLookupTemplate(templateId: string): Promise<LookupTemplateRow> {
  const template = await readTemplateById(templateId);
  if (!template) throw new LookupTemplateError("template_not_found");
  return updateTemplate(template.id, { state: "disabled" });
}

async function updateTemplate(
  id: string,
  patch: {
    state?: LookupTemplateState;
    providerTemplateId?: string | number | null;
    submitted?: boolean;
    lastSyncError?: string | null;
  },
): Promise<LookupTemplateRow> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<LookupTemplateRow>(
      `UPDATE kavenegar_lookup_templates
          SET state = COALESCE($2, state),
              provider_template_id = COALESCE($3, provider_template_id),
              submitted_at = CASE WHEN $4 THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
              decided_at = CASE WHEN $2 IN ('approved','rejected') AND $2 IS DISTINCT FROM state
                                THEN now() ELSE decided_at END,
              last_sync_error = $5,
              last_synced_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING ${TEMPLATE_COLUMNS}`,
      [id, patch.state ?? null, patch.providerTemplateId ?? null, patch.submitted ?? false, patch.lastSyncError ?? null],
    ),
  );
  return rows[0];
}

/**
 * The one template a transactional trigger may use.
 *
 * A caller passes the tenant-facing title it wants; the helper resolves the
 * approved row. No approval ⇒ no send, which is the provider's own rule
 * (status 424) enforced before a request leaves the building.
 */
export async function approvedLookupTemplate(input: {
  businessId: string;
  title: string;
  purpose?: LookupPurpose;
}): Promise<LookupTemplateRow | null> {
  const { rows } = await query<LookupTemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM kavenegar_lookup_templates
      WHERE business_id = $1 AND title = $2 AND state = 'approved'
        AND ($3::text IS NULL OR purpose = $3)
      ORDER BY decided_at DESC NULLS LAST
      LIMIT 1`,
    [input.businessId, input.title, input.purpose ?? null],
  );
  return rows[0] ?? null;
}
