/**
 * CRM adapters — customers, companies, leads, deals, activities, party
 * categories and pipeline stages.
 *
 * Every write goes through the module's own service (`createParty`,
 * `updateParty`, `createPartyCategory`) rather than a hand-written INSERT.
 * That is not tidiness: `parties` carries field-level encryption, a blind
 * index for phone lookup, a phone_e164 normalisation and an auto-generated
 * accounting code, and a row inserted around `createParty` would be a customer
 * nobody can find by phone and the ledger cannot settle against.
 *
 * Reads are written here because an export is a *projection* — the columns the
 * operator asked for, joined to human-readable labels — and no existing
 * service answers that shape.
 */

import { query } from "../../db";
import {
  createParty,
  createPartyCategory,
  updateParty,
  PartyValidationError,
} from "../../parties-service";
import { phoneE164 } from "../../phone";
import { postgresDateToIso } from "../../jalali";
import { FULL_PARTY_AUDIENCE, restrictPartyColumnsForAudience } from "../../personnel-access";
import {
  registerAdapter,
  RowRejection,
  type AdapterContext,
  type EntityAdapter,
  type ReadOptions,
  type WriteOptions,
  type WriteOutcome,
} from "../adapters";

/** A date column as ISO, whatever node-postgres handed back. */
function isoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return postgresDateToIso(value);
  return String(value).slice(0, 10);
}

function text(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

function tagList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value.trim()) {
    return value.split(/[,،;|]/).map((part) => part.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Find an existing party by the chosen duplicate rule.
 *
 * Phone matching goes through `phone_e164` rather than the raw column: the
 * plaintext `phone` is whatever the operator typed («۰۹۱۲ ۱۱۱ ۲۲۳۳»,
 * «+989121112233»), and comparing those to each other finds nothing.
 */
async function findParty(
  businessId: string,
  rule: string | null,
  values: Record<string, unknown>,
  roles: readonly string[],
): Promise<{ id: string; name: string } | null> {
  const roleClause = roles.length > 0 ? "AND p.roles && $2::text[]" : "";
  const roleParam = roles.length > 0 ? [roles] : [];

  const byPhone = async () => {
    const raw = text(values.phone);
    if (!raw) return null;
    const e164 = phoneE164(raw) ?? raw;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM parties p
        WHERE p.business_id = $1 ${roleClause}
          AND p.merged_into_id IS NULL
          AND (p.phone_e164 = $${roleParam.length + 2} OR p.phone = $${roleParam.length + 3})
        LIMIT 1`,
      [businessId, ...roleParam, e164, raw],
    );
    return rows[0] ?? null;
  };

  const byEmail = async () => {
    const email = text(values.email)?.toLowerCase();
    if (!email) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM parties p
        WHERE p.business_id = $1 ${roleClause}
          AND p.merged_into_id IS NULL AND lower(p.email) = $${roleParam.length + 2}
        LIMIT 1`,
      [businessId, ...roleParam, email],
    );
    return rows[0] ?? null;
  };

  const byNationalId = async () => {
    const nationalId = text(values.nationalId);
    if (!nationalId) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM parties p
        WHERE p.business_id = $1 ${roleClause}
          AND p.merged_into_id IS NULL AND p.national_id = $${roleParam.length + 2}
        LIMIT 1`,
      [businessId, ...roleParam, nationalId],
    );
    return rows[0] ?? null;
  };

  const byEconomicCode = async () => {
    const code = text(values.economicCode);
    if (!code) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM parties p
        WHERE p.business_id = $1 ${roleClause}
          AND p.merged_into_id IS NULL AND p.economic_code = $${roleParam.length + 2}
        LIMIT 1`,
      [businessId, ...roleParam, code],
    );
    return rows[0] ?? null;
  };

  const byName = async () => {
    const name = text(values.name);
    if (!name) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT p.id, p.name FROM parties p
        WHERE p.business_id = $1 ${roleClause}
          AND p.merged_into_id IS NULL AND lower(btrim(p.name)) = lower(btrim($${roleParam.length + 2}))
        LIMIT 1`,
      [businessId, ...roleParam, name],
    );
    return rows[0] ?? null;
  };

  switch (rule) {
    case "email":
      return byEmail();
    case "national_id":
      return byNationalId();
    case "economic_code":
      return byEconomicCode();
    case "name":
      return byName();
    case "phone":
    default:
      return (await byPhone()) ?? (await byEmail()) ?? (await byNationalId());
  }
}

/** Resolve (and optionally create) a party category by name. */
async function resolvePartyCategory(
  businessId: string,
  name: string,
  create: boolean,
  role: "customer" | "supplier" | "employee" | null,
): Promise<{ id: string; label: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM party_categories
      WHERE business_id = $1 AND lower(btrim(name)) = lower(btrim($2))
      LIMIT 1`,
    [businessId, trimmed],
  );
  if (rows[0]) return { id: rows[0].id, label: rows[0].name };
  if (!create) return null;
  const created = await createPartyCategory(businessId, {
    name: trimmed,
    role: role === "customer" ? "Customer" : role === "supplier" ? "Supplier" : null,
  });
  return created ? { id: created.id, label: created.name } : null;
}

/**
 * The party read, shared by the customers and companies adapters.
 *
 * The purchase aggregates come from the same business-day-dated, completed
 * orders the sales reports read, so a customer export and the sales screen
 * cannot disagree about how much somebody spent.
 */
async function readParties(
  context: AdapterContext,
  options: ReadOptions,
  personType: "real" | "legal" | null,
): Promise<Record<string, unknown>[]> {
  const where = [
    "p.business_id = $1",
    "p.merged_into_id IS NULL",
    "p.roles && ARRAY['customer']::text[]",
  ];
  const params: unknown[] = [context.businessId];
  const add = (fragment: string, value: unknown) => {
    params.push(value);
    where.push(fragment.replace("$n", `$${params.length}`));
  };

  if (personType) add("p.person_type = $n", personType);
  if (options.ids && options.ids.length > 0) add("p.id = ANY($n::uuid[])", [...options.ids]);
  const filters = options.filters;
  if (typeof filters.tag === "string" && filters.tag) add("$n = ANY(p.tags)", filters.tag);
  if (typeof filters.lifecycle === "string" && filters.lifecycle) {
    add("p.lifecycle_stage = $n", filters.lifecycle);
  }
  if (typeof filters.categoryId === "string" && filters.categoryId) {
    add("p.category_id = $n::uuid", filters.categoryId);
  }
  if (filters.activeOnly === true) where.push("p.is_active");
  if (typeof filters.dateFrom === "string" && filters.dateFrom) {
    add("p.created_at >= $n::date", filters.dateFrom);
  }
  if (typeof filters.dateTo === "string" && filters.dateTo) {
    add("p.created_at < ($n::date + interval '1 day')", filters.dateTo);
  }
  if (typeof filters.search === "string" && filters.search.trim()) {
    add("(p.name ILIKE '%' || $n || '%' OR p.phone ILIKE '%' || $n || '%')", filters.search.trim());
  }

  params.push(options.limit);

  const { rows } = await query<Record<string, unknown>>(
    `WITH order_stats AS (
       SELECT o.customer_id,
              count(*)::int                     AS order_count,
              coalesce(sum(o.total), 0)::bigint AS total_spent,
              max(o.closed_at)                  AS last_purchase_at
         FROM orders o
         JOIN locations l ON l.id = o.location_id
        WHERE l.business_id = $1
          AND o.status = 'completed'
          AND o.closed_at IS NOT NULL
          AND o.customer_id IS NOT NULL
        GROUP BY o.customer_id
     )
     SELECT p.id,
            p.name,
            p.first_name        AS "firstName",
            p.last_name         AS "lastName",
            p.phone,
            p.email,
            p.national_id       AS "nationalId",
            p.economic_code     AS "economicCode",
            p.address,
            p.notes,
            -- Issue #947 (TEAM-F01): the row has to say what it is before the
            -- projection can decide — an Employee file's address is HR data, the
            -- same column on a plain customer is ordinary CRM data. Compared on the
            -- *stored* spelling (PARTY_ROLE_STORAGE in parties.ts), the one p.roles holds.
            'employee' = ANY(p.roles) AS "isEmployee",
            p.tags,
            p.accounting_code   AS "accountingCode",
            p.is_active         AS "isActive",
            p.lifecycle_stage   AS "lifecycleStage",
            p.created_at        AS "createdAt",
            pc.name             AS "categoryName",
            coalesce(os.order_count, 0)       AS "orderCount",
            coalesce(os.total_spent, 0)::text AS "totalSpentRial",
            os.last_purchase_at               AS "lastPurchaseAt"
       FROM parties p
       LEFT JOIN party_categories pc ON pc.id = p.category_id
       LEFT JOIN order_stats os ON os.customer_id = p.id
      WHERE ${where.join(" AND ")}
      ORDER BY p.name
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((row) => {
    // The audience is applied *here*, at the row, because this adapter never builds a
    // `Party`: `restrictPartyColumnsForAudience` is the flat half of the same rule
    // `partyForAudience` applies to `/api/parties`, so a customer export and the
    // directory screen cannot disagree about an Employee's national ID. `isEmployee` is
    // dropped again afterwards — it is the projection's input, not a column the entity
    // declares, and `buildExport` keeps only the fields the operator asked for anyway.
    const { isEmployee, ...projected } = restrictPartyColumnsForAudience(
      row as Record<string, unknown> & { isEmployee?: boolean },
      context.partyAudience ?? FULL_PARTY_AUDIENCE,
      row.isEmployee === true,
    );
    return {
      ...projected,
      totalSpentRial: Number(row.totalSpentRial ?? 0),
      lastPurchaseAt: isoDate(row.lastPurchaseAt),
      createdAt: isoDate(row.createdAt),
      tags: tagList(row.tags),
    };
  });
}

async function writeParty(
  context: AdapterContext,
  values: Record<string, unknown>,
  options: WriteOptions,
  personType: "Real" | "Legal",
): Promise<WriteOutcome> {
  const warnings: string[] = [];
  let categoryId: string | null = null;

  const categoryName = text(values.categoryName);
  if (categoryName) {
    const strategy = options.relationStrategy.categoryName ?? "create";
    const resolved = await resolvePartyCategory(
      context.businessId,
      categoryName,
      strategy === "create",
      "customer",
    );
    if (resolved) categoryId = resolved.id;
    else if (strategy === "skip") {
      return { status: "skipped", reason: `دستهٔ شخص «${categoryName}» وجود ندارد.` };
    } else warnings.push(`دستهٔ شخص «${categoryName}» وجود ندارد و بدون دسته ثبت شد.`);
  }

  const existing = await findParty(
    context.businessId,
    options.duplicateRule,
    values,
    ["customer"],
  );

  if (existing && options.duplicateStrategy === "skip") {
    return {
      status: "skipped",
      id: existing.id,
      reason: `«${existing.name}» از پیش در سیستم ثبت شده است.`,
    };
  }

  // Deliberately no consent field anywhere in this input. A spreadsheet of
  // names is not permission to text those people: consent is a legal record
  // with a source and a timestamp, and a CSV cell is not that.
  const input = {
    displayName: text(values.name) ?? "",
    firstName: text(values.firstName),
    lastName: text(values.lastName),
    role: "Customer",
    roles: ["Customer"],
    personType,
    phone: text(values.phone),
    email: text(values.email),
    address: text(values.address),
    notes: text(values.notes),
    tags: tagList(values.tags),
    categoryId,
    accountingCode: text(values.accountingCode),
    accountingCodeMode: text(values.accountingCode) ? "Manual" : "Automatic",
    generalInfo: {
      nationalId: text(values.nationalId) ?? "",
      economicCode: text(values.economicCode) ?? "",
    },
    status: values.isActive === undefined ? true : values.isActive !== false,
  };

  try {
    if (existing && options.duplicateStrategy === "update") {
      await updateParty(context.businessId, existing.id, input);
      return { status: "updated", id: existing.id, warnings };
    }
    const party = await createParty(context.businessId, input, {
      locationId: context.locationId,
    });
    return { status: "created", id: String(party.id), warnings };
  } catch (error) {
    if (error instanceof PartyValidationError) {
      throw new RowRejection(partyErrorMessage(error));
    }
    throw error;
  }
}

/** The service's error codes, in the operator's language. */
function partyErrorMessage(error: PartyValidationError): string {
  switch (error.code) {
    case "national_id_taken":
      return "کد ملی تکراری است و شخص دیگری با همین کد ثبت شده.";
    case "accounting_code_taken":
      return "کد حسابداری تکراری است.";
    case "invalid_national_id":
      return "کد ملی معتبر نیست.";
    case "invalid_economic_code":
      return "کد اقتصادی معتبر نیست.";
    case "name_required":
      return "نام شخص الزامی است.";
    case "invalid_role":
      return "نقش شخص معتبر نیست.";
    default:
      return `ثبت شخص ممکن نشد (${error.code}).`;
  }
}

const customersAdapter: EntityAdapter = {
  entity: "crm.customers",
  read: (context, options) => readParties(context, options, null),
  write: (context, values, options) => writeParty(context, values, options, "Real"),
  async resolveReference(context, lookup, { create }) {
    const needle = lookup.trim();
    if (!needle) return null;
    const e164 = phoneE164(needle);
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM parties
        WHERE business_id = $1 AND merged_into_id IS NULL
          AND roles && ARRAY['customer']::text[]
          AND (lower(btrim(name)) = lower(btrim($2))
               OR lower(email) = lower($2)
               OR phone = $2
               OR ($3::text IS NOT NULL AND phone_e164 = $3))
        ORDER BY is_active DESC
        LIMIT 1`,
      [context.businessId, needle, e164],
    );
    if (rows[0]) return { id: rows[0].id, label: rows[0].name };
    if (!create) return null;
    const party = await createParty(
      context.businessId,
      { displayName: needle, role: "Customer", roles: ["Customer"] },
      { locationId: context.locationId },
    );
    return { id: String(party.id), label: String(party.name ?? needle) };
  },
};

const companiesAdapter: EntityAdapter = {
  entity: "crm.companies",
  read: (context, options) => readParties(context, options, "legal"),
  write: (context, values, options) => writeParty(context, values, options, "Legal"),
};

const partyCategoriesAdapter: EntityAdapter = {
  entity: "crm.party_categories",
  async read(context, options) {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, name, role, sort_order AS "sortOrder", is_active AS "isActive"
         FROM party_categories
        WHERE business_id = $1
        ORDER BY sort_order, name
        LIMIT $2`,
      [context.businessId, options.limit],
    );
    return rows;
  },
  async write(context, values, options) {
    const name = text(values.name);
    if (!name) throw new RowRejection("نام دسته الزامی است.");
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM party_categories
        WHERE business_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      [context.businessId, name],
    );
    const existing = rows[0];
    if (existing) {
      if (options.duplicateStrategy === "skip") {
        return { status: "skipped", id: existing.id, reason: `دستهٔ «${name}» از پیش وجود دارد.` };
      }
      if (options.duplicateStrategy === "update") {
        await query(
          `UPDATE party_categories
              SET role = coalesce($3, role),
                  sort_order = coalesce($4, sort_order),
                  is_active = coalesce($5, is_active),
                  updated_at = now()
            WHERE business_id = $1 AND id = $2`,
          [
            context.businessId,
            existing.id,
            text(values.role),
            values.sortOrder ?? null,
            values.isActive ?? null,
          ],
        );
        return { status: "updated", id: existing.id };
      }
    }
    const role = text(values.role);
    const created = await createPartyCategory(context.businessId, {
      name,
      role: role === "supplier" ? "Supplier" : role === "employee" ? "Employee" : "Customer",
      sortOrder: typeof values.sortOrder === "number" ? values.sortOrder : 0,
    });
    if (!created) throw new RowRejection("ثبت دسته ممکن نشد.");
    return { status: "created", id: created.id };
  },
  resolveReference: async (context, lookup, { create }) =>
    resolvePartyCategory(context.businessId, lookup, create, "customer"),
};

const leadsAdapter: EntityAdapter = {
  entity: "crm.leads",
  async read(context, options) {
    const where = ["business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`id = ANY($${params.length}::uuid[])`);
    }
    const status = options.filters.status;
    if (typeof status === "string" && status) {
      params.push(status);
      where.push(`status = $${params.length}`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT id, name, organization, phone, email, source, status, rating,
              notes, created_at AS "createdAt"
         FROM crm_leads
        WHERE ${where.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({ ...row, createdAt: isoDate(row.createdAt) }));
  },
  async write(context, values, options) {
    const name = text(values.name);
    if (!name) throw new RowRejection("نام سرنخ الزامی است.");

    const phone = text(values.phone);
    const e164 = phone ? phoneE164(phone) : null;
    let existing: { id: string } | null = null;
    if (options.duplicateRule === "email" && text(values.email)) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM crm_leads WHERE business_id = $1 AND lower(email) = lower($2) LIMIT 1`,
        [context.businessId, text(values.email)],
      );
      existing = rows[0] ?? null;
    } else if (options.duplicateRule === "name_org") {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM crm_leads
          WHERE business_id = $1 AND lower(btrim(name)) = lower(btrim($2))
            AND lower(btrim(organization)) = lower(btrim(coalesce($3, '')))
          LIMIT 1`,
        [context.businessId, name, text(values.organization) ?? ""],
      );
      existing = rows[0] ?? null;
    } else if (phone) {
      const { rows } = await query<{ id: string }>(
        `SELECT id FROM crm_leads
          WHERE business_id = $1 AND (phone = $2 OR ($3::text IS NOT NULL AND phone_e164 = $3))
          LIMIT 1`,
        [context.businessId, phone, e164],
      );
      existing = rows[0] ?? null;
    }

    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `سرنخ «${name}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE crm_leads
            SET name = $3, organization = coalesce($4, organization),
                phone = coalesce($5, phone), phone_e164 = coalesce($6, phone_e164),
                email = coalesce($7, email), source = coalesce($8, source),
                status = coalesce($9, status), rating = coalesce($10, rating),
                notes = coalesce($11, notes), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          name,
          text(values.organization),
          phone,
          e164,
          text(values.email),
          text(values.source),
          text(values.status),
          text(values.rating),
          text(values.notes),
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_leads
         (business_id, name, organization, phone, phone_e164, email, source, status, rating,
          notes, created_by)
       VALUES ($1, $2, coalesce($3, ''), $4, $5, $6, coalesce($7, 'import'),
               coalesce($8, 'new'), coalesce($9, 'warm'), coalesce($10, ''), $11)
       RETURNING id`,
      [
        context.businessId,
        name,
        text(values.organization),
        phone,
        e164,
        text(values.email),
        text(values.source),
        text(values.status),
        text(values.rating),
        text(values.notes),
        context.actorName,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
};

const pipelineStagesAdapter: EntityAdapter = {
  entity: "crm.pipeline_stages",
  async read(context, options) {
    const { rows } = await query<Record<string, unknown>>(
      `SELECT s.id, s.name, p.name AS "pipelineName",
              s.default_probability AS "defaultProbability",
              s.display_order AS "displayOrder", s.is_active AS "isActive"
         FROM crm_pipeline_stages s
         JOIN crm_pipelines p ON p.id = s.pipeline_id
        WHERE s.business_id = $1
        ORDER BY p.display_order, s.display_order
        LIMIT $2`,
      [context.businessId, options.limit],
    );
    return rows;
  },
  async write(context, values, options) {
    const name = text(values.name);
    if (!name) throw new RowRejection("نام مرحله الزامی است.");
    const { rows: pipelines } = await query<{ id: string }>(
      `SELECT id FROM crm_pipelines
        WHERE business_id = $1 AND archived_at IS NULL
        ORDER BY is_default DESC, display_order LIMIT 1`,
      [context.businessId],
    );
    const pipelineId = pipelines[0]?.id;
    if (!pipelineId) throw new RowRejection("هیچ قیف فروشی تعریف نشده است.");

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM crm_pipeline_stages
        WHERE business_id = $1 AND pipeline_id = $2 AND lower(btrim(name)) = lower(btrim($3))
        LIMIT 1`,
      [context.businessId, pipelineId, name],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `مرحلهٔ «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE crm_pipeline_stages
            SET default_probability = coalesce($3, default_probability),
                display_order = coalesce($4, display_order),
                is_active = coalesce($5, is_active), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          values.defaultProbability ?? null,
          values.displayOrder ?? null,
          values.isActive ?? null,
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_pipeline_stages
         (business_id, pipeline_id, name, display_order, default_probability, outcome)
       VALUES ($1, $2, $3,
               coalesce($4, (SELECT coalesce(max(display_order), 0) + 1
                               FROM crm_pipeline_stages WHERE pipeline_id = $2)),
               coalesce($5, 50), 'open')
       RETURNING id`,
      [
        context.businessId,
        pipelineId,
        name,
        values.displayOrder ?? null,
        values.defaultProbability ?? null,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
  async resolveReference(context, lookup) {
    const needle = lookup.trim();
    if (!needle) return null;
    const { rows } = await query<{ id: string; name: string }>(
      `SELECT id, name FROM crm_pipeline_stages
        WHERE business_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND is_active
        ORDER BY display_order LIMIT 1`,
      [context.businessId, needle],
    );
    return rows[0] ? { id: rows[0].id, label: rows[0].name } : null;
  },
};

const dealsAdapter: EntityAdapter = {
  entity: "crm.deals",
  async read(context, options) {
    const where = ["d.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`d.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.stage === "string" && options.filters.stage) {
      params.push(options.filters.stage);
      where.push(`d.stage = $${params.length}`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`d.created_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`d.created_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, p.name AS "customerName", d.value_rial AS "valueRial",
              coalesce(s.name, d.stage) AS "stageName", d.probability,
              d.expected_close_date AS "expectedCloseDate", d.owner_user AS "ownerUser",
              d.description, d.tags, d.created_at AS "createdAt"
         FROM crm_deals d
         LEFT JOIN parties p ON p.id = d.customer_id
         LEFT JOIN crm_pipeline_stages s ON s.id = d.stage_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      valueRial: Number(row.valueRial ?? 0),
      expectedCloseDate: isoDate(row.expectedCloseDate),
      createdAt: isoDate(row.createdAt),
      tags: tagList(row.tags),
    }));
  },
  async write(context, values, options) {
    const title = text(values.title);
    if (!title) throw new RowRejection("عنوان معامله الزامی است.");
    const warnings: string[] = [];

    let customerId: string | null = null;
    const customerName = text(values.customerName);
    if (customerName) {
      const strategy = options.relationStrategy.customerName ?? "skip";
      const resolved = await customersAdapter.resolveReference!(context, customerName, {
        create: strategy === "create",
      });
      if (resolved) customerId = resolved.id;
      else if (strategy === "skip") {
        return { status: "skipped", reason: `مشتری «${customerName}» یافت نشد.` };
      } else warnings.push(`مشتری «${customerName}» یافت نشد و معامله بدون مشتری ثبت شد.`);
    }

    let stageId: string | null = null;
    let stageKey = "new";
    const stageName = text(values.stageName);
    if (stageName) {
      const resolved = await pipelineStagesAdapter.resolveReference!(context, stageName, {
        create: false,
      });
      if (resolved) {
        stageId = resolved.id;
        stageKey = resolved.label;
      } else {
        const strategy = options.relationStrategy.stageName ?? "warn";
        if (strategy === "skip") {
          return { status: "skipped", reason: `مرحلهٔ «${stageName}» یافت نشد.` };
        }
        warnings.push(`مرحلهٔ «${stageName}» یافت نشد؛ معامله در مرحلهٔ اول ثبت شد.`);
      }
    }
    if (!stageId) {
      const { rows } = await query<{ id: string; name: string }>(
        `SELECT s.id, s.name FROM crm_pipeline_stages s
           JOIN crm_pipelines p ON p.id = s.pipeline_id AND p.business_id = s.business_id
          WHERE s.business_id = $1 AND s.is_active AND p.archived_at IS NULL
          ORDER BY p.is_default DESC, p.display_order, s.display_order LIMIT 1`,
        [context.businessId],
      );
      if (rows[0]) {
        stageId = rows[0].id;
        stageKey = rows[0].name;
      }
    }

    const { rows: existingRows } = await query<{ id: string }>(
      options.duplicateRule === "title"
        ? `SELECT id FROM crm_deals
            WHERE business_id = $1 AND lower(btrim(title)) = lower(btrim($2)) LIMIT 1`
        : `SELECT id FROM crm_deals
            WHERE business_id = $1 AND lower(btrim(title)) = lower(btrim($2))
              AND customer_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,
      options.duplicateRule === "title"
        ? [context.businessId, title]
        : [context.businessId, title, customerId],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `معاملهٔ «${title}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE crm_deals
            SET customer_id = coalesce($3::uuid, customer_id),
                value_rial = coalesce($4, value_rial),
                stage_id = coalesce($5::uuid, stage_id),
                stage = coalesce($6, stage),
                probability = coalesce($7, probability),
                expected_close_date = coalesce($8::date, expected_close_date),
                owner_user = coalesce($9, owner_user),
                description = coalesce($10, description),
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          customerId,
          values.valueRial ?? null,
          stageId,
          stageKey,
          values.probability ?? null,
          values.expectedCloseDate ?? null,
          text(values.ownerUser),
          text(values.description),
        ],
      );
      return { status: "updated", id: existing.id, warnings };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_deals
         (business_id, customer_id, title, description, stage, stage_id, value_rial,
          probability, expected_close_date, owner_user, source, tags, created_by,
          stage_entered_at)
       VALUES ($1, $2::uuid, $3, coalesce($4, ''), coalesce($5, 'new'), $6::uuid,
               coalesce($7, 0), $8, $9::date, coalesce($10, ''), 'import',
               coalesce($11::text[], '{}'), $12, now())
       RETURNING id`,
      [
        context.businessId,
        customerId,
        title,
        text(values.description),
        stageKey,
        stageId,
        values.valueRial ?? 0,
        values.probability ?? null,
        values.expectedCloseDate ?? null,
        text(values.ownerUser),
        tagList(values.tags),
        context.actorName,
      ],
    );
    return { status: "created", id: rows[0].id, warnings };
  },
};

const activitiesAdapter: EntityAdapter = {
  entity: "crm.activities",
  async read(context, options) {
    const where = ["a.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`a.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.kind === "string" && options.filters.kind) {
      params.push(options.filters.kind);
      where.push(`a.kind = $${params.length}`);
    }
    if (typeof options.filters.dateFrom === "string" && options.filters.dateFrom) {
      params.push(options.filters.dateFrom);
      where.push(`a.created_at >= $${params.length}::date`);
    }
    if (typeof options.filters.dateTo === "string" && options.filters.dateTo) {
      params.push(options.filters.dateTo);
      where.push(`a.created_at < ($${params.length}::date + interval '1 day')`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT a.id, a.subject, a.kind, p.name AS "customerName", a.body,
              a.due_at AS "dueAt", a.priority, a.assigned_to AS "assignedTo",
              a.completed_at AS "completedAt", a.created_at AS "createdAt"
         FROM crm_activities a
         LEFT JOIN parties p ON p.id = a.customer_id
        WHERE ${where.join(" AND ")}
        ORDER BY a.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      dueAt: isoDate(row.dueAt),
      completedAt: isoDate(row.completedAt),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const subject = text(values.subject);
    if (!subject) throw new RowRejection("موضوع فعالیت الزامی است.");
    const warnings: string[] = [];

    let customerId: string | null = null;
    const customerName = text(values.customerName);
    if (customerName) {
      const strategy = options.relationStrategy.customerName ?? "warn";
      const resolved = await customersAdapter.resolveReference!(context, customerName, {
        create: strategy === "create",
      });
      if (resolved) customerId = resolved.id;
      else if (strategy === "skip") {
        return { status: "skipped", reason: `مشتری «${customerName}» یافت نشد.` };
      } else warnings.push(`مشتری «${customerName}» یافت نشد و فعالیت بدون مشتری ثبت شد.`);
    }

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM crm_activities
        WHERE business_id = $1 AND lower(btrim(subject)) = lower(btrim($2))
          AND customer_id IS NOT DISTINCT FROM $3::uuid
        LIMIT 1`,
      [context.businessId, subject, customerId],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `فعالیت «${subject}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE crm_activities
            SET kind = coalesce($3, kind), body = coalesce($4, body),
                due_at = coalesce($5::timestamptz, due_at),
                priority = coalesce($6, priority),
                assigned_to = coalesce($7, assigned_to), updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          text(values.kind),
          text(values.body),
          values.dueAt ?? null,
          text(values.priority),
          text(values.assignedTo),
        ],
      );
      return { status: "updated", id: existing.id, warnings };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO crm_activities
         (business_id, customer_id, kind, subject, body, due_at, priority,
          assigned_to, created_by)
       VALUES ($1, $2::uuid, coalesce($3, 'note'), $4, coalesce($5, ''), $6::timestamptz,
               coalesce($7, 'normal'), coalesce($8, ''), $9)
       RETURNING id`,
      [
        context.businessId,
        customerId,
        text(values.kind),
        subject,
        text(values.body),
        values.dueAt ?? null,
        text(values.priority),
        text(values.assignedTo),
        context.actorName,
      ],
    );
    return { status: "created", id: rows[0].id, warnings };
  },
};

export function registerCrmAdapters(): void {
  registerAdapter(customersAdapter);
  registerAdapter(companiesAdapter);
  registerAdapter(partyCategoriesAdapter);
  registerAdapter(leadsAdapter);
  registerAdapter(dealsAdapter);
  registerAdapter(activitiesAdapter);
  registerAdapter(pipelineStagesAdapter);
}
