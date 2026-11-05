/**
 * Issue #902 §5 — the platform's approved message library.
 *
 * One table (`0264`), one purpose: the Superadmin decides *which* first-party
 * message a business may use for a given event, for *which trades and plans*,
 * and the business receives a copy in its own catalog. Three consequences shape
 * this service:
 *
 *   * **Targeting is a rule, not a permission.** An entry with empty
 *     `industries`/`plans` is offered to everyone (a login code is not a matter
 *     of what the business sells); an entry listing them is offered only where
 *     the business's trade/plan matches. Eligibility is resolved server-side
 *     from the business row and its subscription — a tenant cannot ask for an
 *     entry by id and bypass the rule, because the tenant route never takes an
 *     id: it names the entry, and the server decides.
 *   * **Edits are versioned.** Saving a changed body/title/variables moves
 *     `version`. Business copies record the version they came from
 *     (`master_version`), so "which message did this business approve?" has an
 *     answer. Rewriting a copy in place is never done here: an approved copy is
 *     the business's live automation and stays until the existing revision flow
 *     (0260) gives it a reviewed successor.
 *   * **Provider identity stays out.** Nothing in this module returns a
 *     provider name, id or error text to a tenant: the tenant sees a title, a
 *     ready-made sample and a status, all first-party (see `toTenantLibrary`).
 *
 * The rendering of a message's `%token` slots from business data lives in
 * `template-variables.ts`; this service only decides what exists and who may
 * have it.
 */
import { query, withoutTenantScope } from "../db";
import { getBusinessEntitlements } from "../entitlement-service";
import {
  renderTemplateSample,
  validateTemplateVariables,
  type RenderErrorCode,
  type TemplateVariable,
} from "./template-variables";
import {
  createLookupTemplate,
  type LookupPurpose,
  type LookupTemplateRow,
} from "./template-service";

const SCOPE = "kavenegar-master-templates";

export type MasterTemplateRow = {
  id: string;
  key: string;
  title: string;
  body: string;
  purpose: LookupPurpose;
  variables: TemplateVariable[];
  industries: string[];
  plans: string[];
  enabled: boolean;
  version: number;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
};

const COLUMN_LIST = [
  "id",
  "key",
  "title",
  "body",
  "purpose",
  "variables",
  "industries",
  "plans",
  "enabled",
  "version",
  "notes",
  "created_at",
  "updated_at",
  "updated_by",
] as const;

const COLUMNS = COLUMN_LIST.join(", ");
const PREFIXED_COLUMNS = COLUMN_LIST.map((column) => `m.${column}`).join(", ");

export class MasterTemplateError extends Error {
  constructor(
    readonly code:
      | RenderErrorCode
      | "master_template_not_found"
      | "master_template_disabled"
      | "master_template_not_offered"
      | "master_template_key_invalid"
      | "master_template_title_required"
      | "master_template_body_too_long"
      | "master_template_purpose_invalid",
  ) {
    super(code);
    this.name = "MasterTemplateError";
  }
}

/** The platform's whole library, newest edits first. Console-only. */
export async function listMasterTemplates(input: { limit?: number } = {}): Promise<
  (MasterTemplateRow & { business_copies: number })[]
> {
  const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 100)), 200);
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<MasterTemplateRow & { business_copies: string }>(
      `SELECT ${PREFIXED_COLUMNS},
              (SELECT count(*) FROM kavenegar_lookup_templates t
                WHERE t.master_template_id = m.id) AS business_copies
         FROM kavenegar_master_templates m
        ORDER BY m.enabled DESC, m.key
        LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({ ...row, business_copies: Number(row.business_copies) }));
  });
}

async function readMasterTemplate(idOrKey: string): Promise<MasterTemplateRow | null> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<MasterTemplateRow>(
      `SELECT ${COLUMNS} FROM kavenegar_master_templates
        WHERE ${isUuid(idOrKey) ? "id = $1" : "key = $1"}`,
      [idOrKey],
    );
    return rows[0] ?? null;
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

const MAX_MASTER_TEMPLATE_BODY = 268;

/**
 * Create or update a library entry.
 *
 * The body is validated by the same renderer that will later fill it, so a
 * template that cannot be rendered can never be saved — and therefore never be
 * instantiated by a business. `version` moves only when the message itself
 * changes; enabling/disabling or retargeting an entry is not a new version,
 * because no business's approved copy changes.
 */
export async function saveMasterTemplate(input: {
  key: string;
  title: string;
  body: string;
  purpose: LookupPurpose;
  variables: readonly string[];
  industries?: readonly string[];
  plans?: readonly string[];
  enabled?: boolean;
  notes?: string | null;
  actorId: string | null;
}): Promise<MasterTemplateRow> {
  const key = input.key.trim();
  if (!/^[a-z][a-z0-9_]{2,63}$/.test(key)) throw new MasterTemplateError("master_template_key_invalid");
  const title = input.title.trim().replace(/\s+/g, " ");
  if (!title) throw new MasterTemplateError("master_template_title_required");
  const body = input.body.replace(/\r\n/g, "\n").trim();
  if (body.length > MAX_MASTER_TEMPLATE_BODY) throw new MasterTemplateError("master_template_body_too_long");
  if (input.purpose !== "verification" && input.purpose !== "transactional") {
    throw new MasterTemplateError("master_template_purpose_invalid");
  }
  const checked = validateTemplateVariables({ body, variables: input.variables });
  if (!checked.ok) throw new MasterTemplateError(checked.code);

  return withoutTenantScope(SCOPE, async () => {
    const existing = await readMasterTemplate(key);
    if (existing && existing.body === body && existing.title === title) {
      const { rows } = await query<MasterTemplateRow>(
        `UPDATE kavenegar_master_templates
            SET purpose = $2, variables = $3, industries = $4, plans = $5,
                enabled = COALESCE($6, enabled), notes = $7,
                updated_at = now(), updated_by = $8
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [
          existing.id,
          input.purpose,
          checked.variables,
          input.industries ?? existing.industries,
          input.plans ?? existing.plans,
          input.enabled ?? null,
          input.notes ?? existing.notes,
          input.actorId,
        ],
      );
      return rows[0];
    }
    const { rows } = await query<MasterTemplateRow>(
      `INSERT INTO kavenegar_master_templates
         (key, title, body, purpose, variables, industries, plans, enabled, notes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, true), $9, $10)
       ON CONFLICT (key) DO UPDATE
         SET title = EXCLUDED.title,
             body = EXCLUDED.body,
             purpose = EXCLUDED.purpose,
             variables = EXCLUDED.variables,
             industries = EXCLUDED.industries,
             plans = EXCLUDED.plans,
             enabled = EXCLUDED.enabled,
             notes = EXCLUDED.notes,
             -- The message changed, so this is a new version. A business's
             -- existing copy keeps sending on the version it approved.
             version = kavenegar_master_templates.version + 1,
             updated_at = now(),
             updated_by = EXCLUDED.updated_by
       RETURNING ${COLUMNS}`,
      [
        key,
        title,
        body,
        input.purpose,
        checked.variables,
        input.industries ?? [],
        input.plans ?? [],
        input.enabled ?? true,
        input.notes ?? null,
        input.actorId,
      ],
    );
    return rows[0];
  });
}

/** Enable or disable an entry. No version bump: no message changed. */
export async function setMasterTemplateEnabled(input: {
  id: string;
  enabled: boolean;
  actorId: string | null;
}): Promise<MasterTemplateRow> {
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<MasterTemplateRow>(
      `UPDATE kavenegar_master_templates
          SET enabled = $2, updated_at = now(), updated_by = $3
        WHERE id = $1
        RETURNING ${COLUMNS}`,
      [input.id, input.enabled, input.actorId],
    );
    if (!rows[0]) throw new MasterTemplateError("master_template_not_found");
    return rows[0];
  });
}

/**
 * The library entries a business is offered.
 *
 * Trade and plan are read from the platform's own records — `businesses.industry`
 * and the subscription's plan — never from the caller. That is what makes
 * targeting a rule rather than a request parameter.
 */
export async function masterTemplatesForBusiness(businessId: string): Promise<MasterTemplateRow[]> {
  const context = await withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<{ industry: string | null }>(
      `SELECT industry FROM businesses WHERE id = $1`,
      [businessId],
    );
    return rows[0] ?? null;
  });
  if (!context) return [];
  const entitlement = await withoutTenantScope(SCOPE, () => getBusinessEntitlements(businessId));
  return withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<MasterTemplateRow>(
      `SELECT ${COLUMNS}
         FROM kavenegar_master_templates
        WHERE enabled
          AND (cardinality(industries) = 0 OR $1 = ANY(industries))
          AND (cardinality(plans) = 0 OR $2 = ANY(plans))
        ORDER BY purpose, key`,
      [context.industry, entitlement.planKey],
    );
    return rows;
  });
}

/**
 * The tenant-facing shape: a first-party name, what it is for, and a sample.
 *
 * No provider name, no template id, no internal key. `already_added` is what
 * lets the screen say «افزوده شده» instead of offering the same message twice.
 */
export type TenantLibraryEntry = {
  id: string;
  title: string;
  purpose: LookupPurpose;
  sample: string;
  /**
   * The ordered domain variables the message declares, so the tenant screen can
   * name what the message needs (issue #902 §5) instead of showing `%token2`.
   * Safe to send: they are this product's own vocabulary, not the provider's.
   */
  variables: string[];
  alreadyAdded: boolean;
};

export async function tenantTemplateLibrary(businessId: string): Promise<TenantLibraryEntry[]> {
  const [offered, existing] = await Promise.all([
    masterTemplatesForBusiness(businessId),
    withoutTenantScope(SCOPE, async () => {
      const { rows } = await query<{ master_template_id: string | null }>(
        `SELECT master_template_id FROM kavenegar_lookup_templates
          WHERE business_id = $1 AND master_template_id IS NOT NULL AND archived_at IS NULL`,
        [businessId],
      );
      return new Set(rows.map((row) => row.master_template_id).filter((id): id is string => id !== null));
    }),
  ]);
  return offered.map((entry) => ({
    id: entry.id,
    title: entry.title,
    purpose: entry.purpose,
    sample: renderTemplateSample({ body: entry.body, variables: entry.variables }),
    variables: [...entry.variables],
    alreadyAdded: existing.has(entry.id),
  }));
}

/**
 * Give one business a copy of one library entry.
 *
 * Idempotent by construction: the copy is created through `createLookupTemplate`,
 * whose provider name is derived from (business, title, body), so adding the
 * same entry twice lands on the same row instead of a second draft. The copy
 * starts as a `draft` — nothing may send an unapproved message, and the
 * platform's submit path is what asks the provider for approval.
 */
export async function instantiateMasterTemplate(input: {
  businessId: string;
  masterTemplateId: string;
}): Promise<{ template: LookupTemplateRow; master: MasterTemplateRow; created: boolean }> {
  const master = await readMasterTemplate(input.masterTemplateId);
  if (!master) throw new MasterTemplateError("master_template_not_found");
  if (!master.enabled) throw new MasterTemplateError("master_template_disabled");

  // Re-resolve eligibility for THIS business: a disabled entry and an entry
  // targeted at another trade are both refusals, never "look it up by id".
  const offered = (await masterTemplatesForBusiness(input.businessId)).some((row) => row.id === master.id);
  if (!offered) throw new MasterTemplateError("master_template_not_offered");

  const existing = await withoutTenantScope(SCOPE, async () => {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM kavenegar_lookup_templates
        WHERE business_id = $1 AND master_template_id = $2 AND archived_at IS NULL
        LIMIT 1`,
      [input.businessId, master.id],
    );
    return rows[0] ?? null;
  });

  // The copy is created through the tenant-facing path on purpose: its provider
  // name is derived from (business, title, body), so a second instantiation of
  // the same entry lands on the same row rather than a second draft.
  const template = await createLookupTemplate({
    businessId: input.businessId,
    title: master.title,
    body: master.body,
    purpose: master.purpose,
    // The mapping travels with the copy: it is what makes the copy safe to send.
    variables: master.variables,
  });

  await withoutTenantScope(SCOPE, async () => {
    await query(
      `UPDATE kavenegar_lookup_templates
          SET master_template_id = $2,
              -- Keep the origin version of an existing copy: it records what the
              -- business's message was approved against.
              master_version = COALESCE(master_version, $3),
              updated_at = now()
        WHERE id = $1`,
      [template.id, master.id, master.version],
    );
  });
  return {
    template: {
      ...template,
      master_template_id: master.id,
      master_version: template.master_version ?? master.version,
    },
    master,
    created: existing === null,
  };
}
