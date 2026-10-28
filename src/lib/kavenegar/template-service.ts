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

/**
 * Does the provider hold the CURRENT text?
 *
 * `submitted_body` is written on every successful add/update. Null means "never
 * submitted", which is why a tenant's untouched draft and a rejected row are
 * distinguishable without asking the provider. The comparison is deliberately
 * on the stored snapshot and not on a timestamp: an untouched resubmit must not
 * cost a review round-trip, and an edit must never be silently dropped.
 */
export function needsProviderUpdate(row: {
  provider_template_id: string | number | null;
  submitted_body: string | null;
  submitted_title: string | null;
  body: string;
  title: string;
}): boolean {
  if (row.provider_template_id === null || row.provider_template_id === undefined) return false;
  if (row.submitted_body === null) return true;
  return row.submitted_body !== row.body || row.submitted_title !== row.title;
}

export type RevisionPlan =
  /** Nothing to revise: the row is retired (create a new one instead). */
  | { kind: "forbidden"; reason: "archived" }
  /** draft/rejected — overwrite in place; no live traffic depends on it. */
  | { kind: "in_place" }
  /** approved/submitted — a new row supersedes the live one. */
  | { kind: "new_version" };

/**
 * How a revision must be applied.
 *
 * The rule exists so a working automation is never broken by an edit: an
 * `approved` template keeps serving sends until its successor is approved, and
 * a `submitted` one stays in the provider's queue instead of being replaced
 * underneath a review that is already running.
 */
export function revisionPlan(row: { state: LookupTemplateState; archived_at: Date | null }): RevisionPlan {
  if (row.archived_at !== null || row.state === "disabled") {
    return { kind: "forbidden", reason: "archived" };
  }
  if (row.state === "approved" || row.state === "submitted") return { kind: "new_version" };
  return { kind: "in_place" };
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
  /** In-place edits this row has taken (a new version starts at 0). */
  revision: number;
  /** What the provider was last asked to review — null until a submit. */
  submitted_title: string | null;
  submitted_body: string | null;
  /** The approved row this one was created to replace, if any. */
  supersedes_id: string | null;
  /** Which library entry this copy came from (issue #902 §5), if any. */
  master_template_id: string | null;
  /** The library version at the moment the copy was made. */
  master_version: number | null;
  archived_at: Date | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const TEMPLATE_COLUMNS = `id, business_id, name, title, body, purpose, state,
       provider_template_id, last_sync_error, revision, submitted_title,
       submitted_body, supersedes_id, master_template_id, master_version,
       archived_at, submitted_at, decided_at, last_synced_at, created_at,
       updated_at`;

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
  constructor(
    readonly code: LookupTemplateErrorCode | "template_not_found" | "template_archived",
  ) {
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

/**
 * Read one row inside the caller's tenant scope.
 *
 * The tenant path never uses `readTemplateById` (a platform bypass): a business
 * may only touch its own catalog, and RLS is the second line of defence rather
 * than the only one.
 */
export async function readTemplateForBusiness(
  businessId: string,
  templateId: string,
): Promise<LookupTemplateRow | null> {
  const { rows } = await query<LookupTemplateRow>(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM kavenegar_lookup_templates
      WHERE id = $1 AND business_id = $2`,
    [templateId, businessId],
  );
  return rows[0] ?? null;
}

/**
 * Tenant edit of its own message.
 *
 * Which of the two shapes applies is not the tenant's decision (see
 * `revisionPlan`): editing a draft or a rejected template rewrites it, while
 * editing an approved one produces a successor row so the live automation keeps
 * working until the replacement is approved.
 */
export async function reviseLookupTemplate(input: {
  businessId: string;
  templateId: string;
  title: string;
  body: string;
}): Promise<{ template: LookupTemplateRow; created: boolean }> {
  const current = await readTemplateForBusiness(input.businessId, input.templateId);
  if (!current) throw new LookupTemplateError("template_not_found");
  const plan = revisionPlan(current);
  if (plan.kind === "forbidden") throw new LookupTemplateError("template_archived");

  const validated = validateLookupTemplate({
    title: input.title,
    body: input.body,
    purpose: current.purpose,
  });
  if (!validated.ok) throw new LookupTemplateError(validated.code);

  if (plan.kind === "in_place") {
    const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
      query<LookupTemplateRow>(
        `UPDATE kavenegar_lookup_templates
            SET title = $2,
                body = $3,
                -- Back to draft: the text the provider reviewed is no longer
                -- what we hold, and needsProviderUpdate says so on submit.
                state = 'draft',
                revision = revision + 1,
                last_sync_error = NULL,
                decided_at = NULL,
                updated_at = now()
          WHERE id = $1 AND business_id = $4
          RETURNING ${TEMPLATE_COLUMNS}`,
        [current.id, validated.title, validated.body, input.businessId],
      ),
    );
    return { template: rows[0], created: false };
  }

  // Versioned revision: the successor carries the new text under its own
  // derived name, and points at the row it will replace.
  const next = await createLookupTemplate({
    businessId: input.businessId,
    title: validated.title,
    body: validated.body,
    purpose: current.purpose,
  });
  if (next.id === current.id) return { template: next, created: false };
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<LookupTemplateRow>(
      `UPDATE kavenegar_lookup_templates
          SET supersedes_id = $2,
              -- A revision of a library copy is still that library message, at
              -- the version it was taken from (issue #902 §5 lineage).
              master_template_id = COALESCE(master_template_id, $3),
              master_version = COALESCE(master_version, $4),
              updated_at = now()
        WHERE id = $1
        RETURNING ${TEMPLATE_COLUMNS}`,
      [next.id, current.id, current.master_template_id, current.master_version],
    ),
  );
  return { template: rows[0] ?? next, created: true };
}

/**
 * Retire a template: provider first, then our row.
 *
 * The provider's `deletetemplate` is idempotent in practice — a template that
 * is already gone answers 424/449 — and either answer means "it is not there",
 * which is what we wanted. An ambiguous transport failure still retires our row
 * (the tenant asked for it) but records `outcome_unknown` so the console shows a
 * manual cleanup instead of pretending the provider agrees.
 */
export async function archiveLookupTemplate(input: {
  templateId: string;
  client: KavenegarManagementClient;
}): Promise<LookupTemplateRow> {
  const template = await readTemplateById(input.templateId);
  if (!template) throw new LookupTemplateError("template_not_found");
  let syncError: string | null = null;

  if (template.provider_template_id !== null) {
    const child = await activeChildFor(template.business_id);
    if (!child) {
      syncError = "child_not_active";
    } else {
      try {
        await input.client.deleteTemplate({
          templateId: Number(template.provider_template_id),
          childApiKey: child.apiKey,
        });
      } catch (error) {
        const status = (error as { providerStatus?: number | null })?.providerStatus ?? null;
        // 424: not found / not editable; 449: record not found. Both mean the
        // provider no longer serves it, which is the outcome we asked for.
        if (status !== 424 && status !== 449) {
          syncError = (error as { ambiguous?: boolean })?.ambiguous
            ? "outcome_unknown"
            : ((error as { classification?: { code?: string } })?.classification?.code ??
              "delete_failed");
        }
      }
    }
  }

  return updateTemplate(template.id, { state: "disabled", archived: true, lastSyncError: syncError });
}

/**
 * The console's catalog: every business's templates in one list.
 *
 * Platform-only. Provider ids and tenant names are allowed here and nowhere
 * else; the tenant endpoint uses `toTenantLookupTemplates`.
 */
export async function listAllLookupTemplates(input: { limit?: number } = {}): Promise<
  (LookupTemplateRow & { business_name: string | null })[]
> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 100)), 500);
  return withoutTenantScope("kavenegar-provisioning", async () => {
    const { rows } = await query<LookupTemplateRow & { business_name: string | null }>(
      `SELECT t.id, t.business_id, t.name, t.title, t.body, t.purpose, t.state,
              t.provider_template_id, t.last_sync_error, t.revision,
              t.submitted_title, t.submitted_body, t.supersedes_id,
              t.master_template_id, t.master_version, t.archived_at,
              t.submitted_at, t.decided_at, t.last_synced_at, t.created_at, t.updated_at,
              b.name AS business_name
         FROM kavenegar_lookup_templates t
         JOIN businesses b ON b.id = t.business_id
        ORDER BY (t.state = 'rejected') DESC, (t.state = 'submitted') DESC, t.created_at DESC
        LIMIT $1`,
      [limit],
    );
    return rows;
  });
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
  if (template.archived_at !== null || template.state === "disabled") return template;

  // The provider already reviewed exactly this text and approved it: a resubmit
  // would be a no-op that still costs a review round-trip.
  if (template.state === "approved" && !needsProviderUpdate(template)) return template;

  const child = await activeChildFor(template.business_id);
  if (!child) {
    return updateTemplate(template.id, {
      lastSyncError: "child_not_active",
    });
  }

  const reviewed = { submittedTitle: template.title, submittedBody: template.body };

  try {
    if (needsProviderUpdate(template) && template.provider_template_id !== null) {
      // An edit of a template the provider already holds must be an UPDATE, not
      // a second `addtemplate`: the name is taken, and a rejection would attach
      // to the wrong row. The reply carries no approvalStatus (the documented
      // output), so an accepted edit means "back in review".
      const updated = await input.client.updateTemplate({
        templateId: Number(template.provider_template_id),
        childApiKey: child.apiKey,
        name: template.name,
        textMessage: template.body,
        primaryLineNumber: input.primaryLineNumber,
      });
      return updateTemplate(template.id, {
        state: "submitted",
        providerTemplateId: updated.templateId ?? template.provider_template_id,
        submitted: true,
        ...reviewed,
        lastSyncError: null,
      });
    }

    if (template.provider_template_id !== null) {
      // Already at the provider with the same text and not approved: a resubmit
      // changes nothing, so do not spend a review on it. A rejected row needs a
      // revision first (`reviseLookupTemplate`).
      return updateTemplate(template.id, { lastSyncError: null });
    }

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
      ...reviewed,
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
      ...(duplicate ? reviewed : {}),
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
    /** What the provider is now reviewing; omitted keeps the previous snapshot. */
    submittedTitle?: string;
    submittedBody?: string;
    archived?: boolean;
    lastSyncError?: string | null;
  },
): Promise<LookupTemplateRow> {
  const { rows } = await withoutTenantScope("kavenegar-provisioning", async () =>
    query<LookupTemplateRow>(
      `UPDATE kavenegar_lookup_templates
          SET state = COALESCE($2, state),
              provider_template_id = COALESCE($3, provider_template_id),
              submitted_at = CASE WHEN $4 THEN COALESCE(submitted_at, now()) ELSE submitted_at END,
              submitted_title = COALESCE($6, submitted_title),
              submitted_body = COALESCE($7, submitted_body),
              archived_at = CASE WHEN $8 THEN COALESCE(archived_at, now()) ELSE archived_at END,
              decided_at = CASE WHEN $2 IN ('approved','rejected') AND $2 IS DISTINCT FROM state
                                THEN now() ELSE decided_at END,
              last_sync_error = $5,
              last_synced_at = now(),
              updated_at = now()
        WHERE id = $1
        RETURNING ${TEMPLATE_COLUMNS}`,
      [
        id,
        patch.state ?? null,
        patch.providerTemplateId ?? null,
        patch.submitted ?? false,
        patch.lastSyncError ?? null,
        patch.submittedTitle ?? null,
        patch.submittedBody ?? null,
        patch.archived ?? false,
      ],
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
