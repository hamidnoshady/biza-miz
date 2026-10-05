/**
 * Lead management, and the conversion that turns one into a customer.
 *
 * ## Why a lead is not a party
 *
 * The tempting shortcut is to make every enquiry a `parties` row with a
 * "lead" flag. It is the wrong call, and the damage shows up about a year in:
 * the customer directory fills with four thousand people who never bought
 * anything, every count is inflated, duplicate detection drowns in noise, and
 * nobody can clean it out because some of those rows *did* eventually buy and
 * there is no way left to tell which.
 *
 * A lead lives in its own table with its own lifecycle, and is **converted**
 * into a party once it is worth being one. Until then it costs the customer
 * directory nothing.
 *
 * ## Conversion is transactional, and it deduplicates first
 *
 * Converting does up to three things — create or link a party, optionally open
 * a deal, and mark the lead converted — and a partial conversion is a mess
 * somebody has to unpick by hand: a party with no lead pointing at it, or a
 * lead marked converted with nothing to show for it. So it is one transaction,
 * with the lead row locked `FOR UPDATE` to make a double-submit impossible.
 *
 * Before creating anything it looks for an existing customer on the canonical
 * phone or email. Skipping that check is the single most common way a CRM
 * accumulates duplicates: the person enquired in March, bought in June, and
 * converting the March lead in July silently creates their second record.
 *
 * And — as everywhere else in this codebase — an **ambiguous** match is never
 * resolved by picking one. Two candidates means conversion stops and asks.
 */

import { businessToday } from "./business-day-service";
import { query, withTenantTransaction } from "./db";
import { phoneE164 } from "./phone";
import { phoneMatchKeys, phoneMatchSql, createParty } from "./parties-service";
import { recordCrmAudit } from "./crm-audit-service";
import { resolveOwner } from "./crm-ownership";
import { normaliseSource, type CrmSource } from "./crm-sources";
import { defaultPipeline } from "./crm-pipeline-service";
import { isUuid } from "./uuid";

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "working",
  "qualified",
  "unqualified",
  "converted",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_RATINGS = ["hot", "warm", "cold"] as const;
export type LeadRating = (typeof LEAD_RATINGS)[number];

/**
 * Statuses that mean "this lead is finished with".
 *
 * Kept as a named list because three separate places need the same answer —
 * the board's open count, the owner's workload, and the duplicate check — and
 * three copies of `status !== 'converted' && status !== 'unqualified'` is how
 * they drift.
 */
const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ["converted", "unqualified"];

interface CrmLead extends Record<string, unknown> {
  id: string;
  name: string;
  organization: string;
  phone: string | null;
  phoneE164: string | null;
  email: string | null;
  source: string;
  sourceDetail: string;
  status: LeadStatus;
  rating: LeadRating;
  ownerUserId: string | null;
  ownerName: string;
  notes: string;
  nextAction: string;
  nextActionAt: string | null;
  qualificationReason: string;
  disqualificationReason: string;
  lastActivityAt: string | null;
  convertedPartyId: string | null;
  convertedDealId: string | null;
  convertedAt: string | null;
  convertedBy: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const LEAD_COLUMNS = `id, name, organization, phone, phone_e164 AS "phoneE164", email,
  source, source_detail AS "sourceDetail", status, rating,
  owner_user_id AS "ownerUserId", owner_name AS "ownerName", notes,
  next_action AS "nextAction", next_action_at AS "nextActionAt",
  qualification_reason AS "qualificationReason",
  disqualification_reason AS "disqualificationReason",
  last_activity_at AS "lastActivityAt",
  converted_party_id AS "convertedPartyId", converted_deal_id AS "convertedDealId",
  converted_at AS "convertedAt", converted_by AS "convertedBy",
  created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`;

interface ListLeadsOptions {
  status?: LeadStatus | "open";
  ownerUserId?: string;
  rating?: LeadRating;
  source?: string;
  search?: string;
  /** Leads whose next action is due on or before the business's today. */
  dueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * The lead list, filtered **server-side**.
 *
 * Every filter is a SQL predicate, not a client-side `.filter()` over a
 * fetched page. Filtering in the browser is correct only while the whole table
 * fits in one response; past that the user is filtering a page rather than the
 * data, and the result is silently wrong — the classic symptom being a search
 * that finds nothing because the match was on page four.
 */
export async function listLeads(
  businessId: string,
  options: ListLeadsOptions = {},
): Promise<{ leads: CrmLead[]; total: number }> {
  const params: unknown[] = [businessId];
  let where = "business_id = $1";

  if (options.status === "open") {
    params.push([...CLOSED_LEAD_STATUSES]);
    where += ` AND status <> ALL($${params.length}::text[])`;
  } else if (options.status) {
    params.push(options.status);
    where += ` AND status = $${params.length}`;
  }
  if (options.ownerUserId && isUuid(options.ownerUserId)) {
    params.push(options.ownerUserId);
    where += ` AND owner_user_id = $${params.length}`;
  }
  if (options.rating) {
    params.push(options.rating);
    where += ` AND rating = $${params.length}`;
  }
  if (options.source) {
    params.push(options.source);
    where += ` AND source = $${params.length}`;
  }
  if (options.dueOnly) {
    const today = await businessToday(businessId);
    params.push(today);
    where += ` AND next_action_at IS NOT NULL AND next_action_at::date <= $${params.length}::date`;
  }

  const search = options.search?.trim();
  if (search) {
    // `\`, `%` and `_` escaped so a customer literally called «۱۰۰٪» does not
    // turn the query into a full scan with wildcards.
    params.push(`%${search.replace(/[\\%_]/g, (match) => `\\${match}`)}%`);
    const placeholder = `$${params.length}`;
    where += ` AND (name ILIKE ${placeholder} ESCAPE '\\'
                 OR organization ILIKE ${placeholder} ESCAPE '\\'
                 OR email ILIKE ${placeholder} ESCAPE '\\'
                 OR phone ILIKE ${placeholder} ESCAPE '\\')`;
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50) || 50, 1), 200);
  const offset = Math.max(Math.trunc(options.offset ?? 0) || 0, 0);

  // The count runs against the same predicate, so the pager reports the size
  // of the filtered set rather than of the table — the bug the CRM overview
  // had, where a LIMIT was reported as a total.
  const [list, count] = await Promise.all([
    query<CrmLead>(
      `SELECT ${LEAD_COLUMNS} FROM crm_leads
        WHERE ${where}
        ORDER BY
          CASE WHEN next_action_at IS NOT NULL AND next_action_at <= now() THEN 0 ELSE 1 END,
          next_action_at NULLS LAST,
          created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    ),
    query<{ count: number }>(`SELECT count(*)::int AS count FROM crm_leads WHERE ${where}`, params),
  ]);

  return { leads: list.rows, total: count.rows[0]?.count ?? 0 };
}

export async function getLead(businessId: string, leadId: string): Promise<CrmLead | null> {
  if (!isUuid(leadId)) return null;
  const { rows } = await query<CrmLead>(
    `SELECT ${LEAD_COLUMNS} FROM crm_leads WHERE business_id = $1 AND id = $2`,
    [businessId, leadId],
  );
  return rows[0] ?? null;
}

interface SaveLeadInput {
  id?: string;
  name: string;
  organization?: string;
  phone?: string | null;
  email?: string | null;
  source?: CrmSource | string;
  sourceDetail?: string;
  status?: LeadStatus;
  rating?: LeadRating;
  /** The owner as a **member id**; preferred over the name below. */
  ownerUserId?: string | null;
  /** A name, for integrations and legacy callers. Resolved, never trusted. */
  ownerName?: string;
  notes?: string;
  nextAction?: string;
  nextActionAt?: string | null;
  qualificationReason?: string;
  disqualificationReason?: string;
  /** Set only by integrations delivering a lead from outside. */
  connectionId?: string | null;
  externalRef?: string | null;
  utm?: Record<string, unknown>;
}

/**
 * Create or update a lead.
 *
 * `phone_e164` is derived here rather than trusted from the caller, so a lead
 * typed «۰۹۱۲…» and a customer stored «+98912…» are comparable — without which
 * the dedupe check at conversion finds nothing and every lead becomes a
 * duplicate customer.
 */
export async function saveLead(
  businessId: string,
  input: SaveLeadInput,
  actor: { name: string; userId?: string | null },
): Promise<CrmLead | null> {
  const name = input.name?.trim();
  if (!name) return null;

  const phone = input.phone?.trim() || null;
  const e164 = phoneE164(phone);
  const email = input.email?.trim().toLowerCase() || null;
  const status: LeadStatus = LEAD_STATUSES.includes(input.status as LeadStatus)
    ? (input.status as LeadStatus)
    : "new";
  const rating: LeadRating = LEAD_RATINGS.includes(input.rating as LeadRating)
    ? (input.rating as LeadRating)
    : "warm";

  // Ownership is a member id, with the name kept beside it as the row's
  // snapshot (see `crm-ownership.ts`). Resolved here rather than trusted from
  // the body so an integration that sends a name — or a stale id from another
  // business — cannot assign a lead to somebody who does not exist here.
  const owner = await resolveOwner(businessId, input.ownerUserId ?? input.ownerName);

  if (input.id) {
    if (!isUuid(input.id)) return null;
    // A converted lead is history. Editing it would let somebody rewrite what
    // was converted after the fact, and the party it became is the live record
    // now — that is where edits belong.
    const existing = await getLead(businessId, input.id);
    if (!existing) return null;
    if (existing.status === "converted") return existing;

    await query(
      `UPDATE crm_leads
          SET name = $3, organization = $4, phone = $5, phone_e164 = $6, email = $7,
              source = $8, source_detail = $9, status = $10, rating = $11,
              owner_user_id = $12, owner_name = $13, notes = $14,
              next_action = $15, next_action_at = $16::timestamptz,
              qualification_reason = $17, disqualification_reason = $18,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        businessId,
        input.id,
        name,
        input.organization?.trim() ?? "",
        phone,
        e164,
        email,
        normaliseSource(input.source ?? existing.source),
        input.sourceDetail?.trim() ?? "",
        status,
        rating,
        owner.userId,
        owner.name,
        input.notes?.trim() ?? "",
        input.nextAction?.trim() ?? "",
        input.nextActionAt ?? null,
        input.qualificationReason?.trim() ?? "",
        input.disqualificationReason?.trim() ?? "",
      ],
    );

    if (existing.status !== status) {
      await recordCrmAudit({
        businessId,
        kind: "lead.status_changed",
        entityType: "lead",
        entityId: input.id,
        summary: `وضعیت سرنخ «${name}» از «${existing.status}» به «${status}» تغییر کرد`,
        detail: { from: existing.status, to: status },
        actorUserId: actor.userId ?? null,
        actorName: actor.name,
      });
    }
    return getLead(businessId, input.id);
  }

  const { rows } = await query<{ id: string }>(
    `INSERT INTO crm_leads
       (business_id, name, organization, phone, phone_e164, email, source, source_detail,
        status, rating, owner_user_id, owner_name, notes, next_action, next_action_at,
        connection_id, external_ref, utm, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::timestamptz,
             $16, $17, $18::jsonb, $19)
     ON CONFLICT (business_id, connection_id, external_ref)
       WHERE connection_id IS NOT NULL AND external_ref IS NOT NULL
       DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      businessId,
      name,
      input.organization?.trim() ?? "",
      phone,
      e164,
      email,
      normaliseSource(input.source ?? "manual"),
      input.sourceDetail?.trim() ?? "",
      status,
      rating,
      owner.userId,
      owner.name,
      input.notes?.trim() ?? "",
      input.nextAction?.trim() ?? "",
      input.nextActionAt ?? null,
      input.connectionId ?? null,
      input.externalRef ?? null,
      JSON.stringify(input.utm ?? {}),
      actor.name,
    ],
  );

  await recordCrmAudit({
    businessId,
    kind: "lead.created",
    entityType: "lead",
    entityId: rows[0].id,
    summary: `سرنخ «${name}» ثبت شد`,
    detail: { source: normaliseSource(input.source ?? "manual") },
    actorUserId: actor.userId ?? null,
    actorName: actor.name,
  });

  return getLead(businessId, rows[0].id);
}

interface LeadDuplicate {
  partyId: string;
  name: string;
  matchedOn: "phone" | "email";
  note: string;
}

/**
 * Existing customers this lead might already be.
 *
 * Returns **all** matches. A function that returns one forces its caller to
 * pick, and picking without evidence is how the wrong person gets a stranger's
 * purchase history attached to them.
 */
export async function findLeadDuplicates(
  businessId: string,
  lead: { phone?: string | null; email?: string | null },
): Promise<LeadDuplicate[]> {
  const found = new Map<string, LeadDuplicate>();

  const e164 = phoneE164(lead.phone ?? null);
  if (e164) {
    const keys = await phoneMatchKeys(businessId, lead.phone ?? null);
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND ${phoneMatchSql("", "$2", "$3")}
          AND merged_into_id IS NULL AND is_active
        ORDER BY name LIMIT 20`,
      [businessId, keys.bidx, keys.e164],
    );
    for (const row of rows) {
      found.set(row.id, {
        partyId: row.id,
        name: row.name,
        matchedOn: "phone",
        note: "شمارهٔ تلفن یکسان",
      });
    }
  }

  const email = lead.email?.trim().toLowerCase() || null;
  if (email) {
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND lower(email) = $2
          AND merged_into_id IS NULL AND is_active
        ORDER BY name LIMIT 20`,
      [businessId, email],
    );
    for (const row of rows) {
      if (found.has(row.id)) continue;
      found.set(row.id, {
        partyId: row.id,
        name: row.name,
        matchedOn: "email",
        note: "نشانی ایمیل یکسان",
      });
    }
  }

  return [...found.values()];
}

interface ConvertLeadInput {
  /** Link to this existing customer instead of creating one. */
  partyId?: string;
  /** Open a deal at the same time. */
  createDeal?: boolean;
  dealTitle?: string;
  dealValueRial?: number;
  dealExpectedCloseDate?: string | null;
  /**
   * Proceed even though duplicates were found — set only after a person has
   * been shown them and chosen to create a new record anyway.
   */
  acknowledgeDuplicates?: boolean;
}

type ConvertLeadResult =
  | { ok: true; partyId: string; dealId: string | null; linkedExisting: boolean }
  | { ok: false; error: "not_found" | "already_converted" | "party_not_found" }
  | { ok: false; error: "duplicates_found"; duplicates: LeadDuplicate[] };

/**
 * Turn a lead into a customer, in one transaction.
 *
 * Order matters and is not arbitrary:
 *
 * 1. Lock the lead. A double-clicked "convert" button is the normal case, not
 *    an edge case, and without the lock it produces two customers.
 * 2. Refuse if already converted — idempotence at the data level, not at the
 *    button.
 * 3. Dedupe, unless the caller is linking to a party it already chose. One
 *    match is reported so the UI can offer it; two or more **stops the
 *    conversion**, because there is no honest way to choose between them here.
 * 4. Create or link the party, through `createParty` so field encryption,
 *    blind indexes, phone normalisation and accounting codes all happen the
 *    one way they are supposed to. Writing the INSERT by hand here is how a
 *    record ends up unsearchable by phone.
 * 5. Optionally open a deal in the default pipeline's first open stage.
 * 6. Mark the lead converted, pointing at both halves.
 *
 * Consent is **not** copied from the lead. An enquiry is not permission to
 * market, and there is no consent on a lead to copy — the columns do not exist
 * there, deliberately.
 */
export async function convertLead(
  businessId: string,
  leadId: string,
  input: ConvertLeadInput,
  actor: { name: string; userId?: string | null },
): Promise<ConvertLeadResult> {
  if (!isUuid(leadId)) return { ok: false, error: "not_found" };

  // The duplicate check runs before the transaction opens: it is a read, and
  // holding a row lock across it buys nothing. The lock below is what makes
  // the conversion itself safe.
  const preview = await getLead(businessId, leadId);
  if (!preview) return { ok: false, error: "not_found" };
  if (preview.status === "converted") return { ok: false, error: "already_converted" };

  if (!input.partyId) {
    const duplicates = await findLeadDuplicates(businessId, {
      phone: preview.phone,
      email: preview.email,
    });
    // Two or more candidates: stop. This is the same rule the WooCommerce
    // identity path follows, for the same reason — guessing attaches a real
    // person's history to the wrong record and nothing ever says so.
    if (duplicates.length > 1) {
      return { ok: false, error: "duplicates_found", duplicates };
    }
    if (duplicates.length === 1 && !input.acknowledgeDuplicates) {
      return { ok: false, error: "duplicates_found", duplicates };
    }
  }

  const pipeline = input.createDeal ? await defaultPipeline(businessId) : null;
  const firstOpenStage = pipeline?.stages.find((stage) => stage.outcome === "open" && stage.isActive);

  // withTenantTransaction, not withTenant: the FOR UPDATE below is only a
  // lock if it is inside a transaction. Outside one, each query takes its own
  // pooled connection and the lock is released before the next statement runs
  // — which is exactly how a double-clicked convert button produces two
  // customers.
  const result = await withTenantTransaction(businessId, async () => {
    const { rows: locked } = await query<{
      id: string;
      name: string;
      organization: string;
      phone: string | null;
      email: string | null;
      source: string;
      source_detail: string;
      notes: string;
      status: LeadStatus;
    }>(
      `SELECT id, name, organization, phone, email, source, source_detail, notes, status
         FROM crm_leads WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [businessId, leadId],
    );
    const lead = locked[0];
    if (!lead) return { ok: false as const, error: "not_found" as const };
    if (lead.status === "converted") return { ok: false as const, error: "already_converted" as const };

    let partyId = input.partyId ?? null;
    let linkedExisting = Boolean(partyId);

    if (partyId) {
      // The id came from a browser. Prove it is a live customer of this
      // business rather than trusting the session to have constrained it.
      const { rows: target } = await query<{ id: string }>(
        `SELECT id FROM parties
          WHERE business_id = $1 AND id = $2 AND merged_into_id IS NULL AND is_active`,
        [businessId, partyId],
      );
      if (!target[0]) return { ok: false as const, error: "party_not_found" as const };
    } else {
      // Through the canonical service, never a hand-written INSERT — see the
      // doc comment.
      const party = await createParty(businessId, {
        displayName: lead.name,
        role: "customer",
        roles: ["customer"],
        phone: lead.phone,
        email: lead.email,
        notes: lead.notes,
        // Consent is absent on purpose. An enquiry is not permission.
      });
      partyId = party.id;
      linkedExisting = false;

      // First-touch attribution, stamped at creation so the acquisition
      // channel is recorded once and never overwritten by a later touch.
      await query(
        `UPDATE parties
            SET acquisition_source = $3, acquisition_detail = $4,
                acquisition_at = now(), last_source = $3,
                crm_owner_user_id = COALESCE(crm_owner_user_id, $5)
          WHERE business_id = $1 AND id = $2 AND acquisition_source IS NULL`,
        [businessId, partyId, normaliseSource(lead.source), lead.source_detail, actor.userId ?? null],
      );
    }

    let dealId: string | null = null;
    if (input.createDeal && firstOpenStage) {
      const title = input.dealTitle?.trim() || `فرصت فروش — ${lead.name}`;
      const { rows: deal } = await query<{ id: string }>(
        `INSERT INTO crm_deals
           (business_id, customer_id, title, stage, stage_id, pipeline_id, value_rial,
            probability, expected_close_date, owner_user, owner_user_id, source,
            source_detail, lead_id, stage_entered_at, last_activity_at, created_by)
         VALUES ($1, $2, $3, 'lead', $4, $5, $6, $7, $8::date, $9, $10, $11, $12, $13,
                 now(), now(), $9)
         RETURNING id`,
        [
          businessId,
          partyId,
          title,
          firstOpenStage.id,
          firstOpenStage.pipelineId,
          Math.max(0, Math.round(input.dealValueRial ?? 0)),
          firstOpenStage.defaultProbability,
          input.dealExpectedCloseDate ?? null,
          actor.name,
          actor.userId ?? null,
          normaliseSource(lead.source),
          lead.source_detail,
          leadId,
        ],
      );
      dealId = deal[0].id;

      // The deal's first history row, so "time in stage" has a start.
      await query(
        `INSERT INTO crm_deal_stage_history
           (business_id, deal_id, from_stage_id, to_stage_id, to_stage_name, changed_by_id, changed_by, note)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, 'ایجاد از تبدیل سرنخ')`,
        [businessId, dealId, firstOpenStage.id, firstOpenStage.name, actor.userId ?? null, actor.name],
      );
    }

    await query(
      `UPDATE crm_leads
          SET status = 'converted', converted_party_id = $3, converted_deal_id = $4,
              converted_at = now(), converted_by = $5, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [businessId, leadId, partyId, dealId, actor.name],
    );

    return { ok: true as const, partyId: partyId!, dealId, linkedExisting, leadName: lead.name };
  });

  if (result.ok) {
    await recordCrmAudit({
      businessId,
      kind: "lead.converted",
      entityType: "lead",
      entityId: leadId,
      partyId: result.partyId,
      summary: result.linkedExisting
        ? `سرنخ «${result.leadName}» به مشتری موجود وصل شد`
        : `سرنخ «${result.leadName}» به مشتری تبدیل شد`,
      detail: {
        partyId: result.partyId,
        dealId: result.dealId,
        linkedExisting: result.linkedExisting,
      },
      actorUserId: actor.userId ?? null,
      actorName: actor.name,
    });
    return {
      ok: true,
      partyId: result.partyId,
      dealId: result.dealId,
      linkedExisting: result.linkedExisting,
    };
  }
  return result;
}
