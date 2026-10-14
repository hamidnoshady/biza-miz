/**
 * «میز کار من» adapters — projects, tasks, contracts, documents and (issue
 * #799 §7) the BOQ's measured rows.
 *
 * The schema names are `ai_projects` / `ai_project_tasks`: migration 0167
 * renamed the *module* and not the tables, deliberately, because renaming them
 * would have meant rewriting eight migrations' worth of foreign keys for a
 * cosmetic gain. The engine speaks the product's vocabulary («پروژه», «کار»)
 * and the adapter maps it onto the schema's.
 *
 * Documents are export-only: a document row is a pointer into the media
 * library with a version and a lifecycle, and a row with no file behind it is
 * a broken link rather than a document.
 */

import { query } from "../../db";
import { postgresDateToIso } from "../../jalali";
import * as boq from "../../aec-boq-service";
import {
  registerAdapter,
  RowRejection,
  type AdapterContext,
  type EntityAdapter,
} from "../adapters";

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

async function findParty(
  businessId: string,
  lookup: string,
): Promise<{ id: string; name: string } | null> {
  const needle = lookup.trim();
  if (!needle) return null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM parties
      WHERE business_id = $1 AND merged_into_id IS NULL
        AND (lower(btrim(name)) = lower(btrim($2)) OR phone = $2)
      ORDER BY is_active DESC LIMIT 1`,
    [businessId, needle],
  );
  return rows[0] ?? null;
}

async function resolveProject(
  context: AdapterContext,
  name: string,
  create: boolean,
): Promise<{ id: string; label: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM ai_projects
      WHERE business_id = $1 AND lower(btrim(name)) = lower(btrim($2))
      ORDER BY archived_at NULLS FIRST LIMIT 1`,
    [context.businessId, trimmed],
  );
  if (rows[0]) return { id: rows[0].id, label: rows[0].name };
  if (!create) return null;
  const { rows: created } = await query<{ id: string; name: string }>(
    `INSERT INTO ai_projects (business_id, name, instructions, created_by, owner_user_id)
     VALUES ($1, $2, '', $3, $4::uuid)
     RETURNING id, name`,
    [context.businessId, trimmed, context.actorName, context.actorUserId],
  );
  return { id: created[0].id, label: created[0].name };
}

const projectsAdapter: EntityAdapter = {
  entity: "workspace.projects",
  async read(context, options) {
    const where = ["p.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`p.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`p.status = $${params.length}`);
    }
    if (options.filters.activeOnly === true) where.push("p.archived_at IS NULL");
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT p.id, p.name, p.status, p.priority, party.name AS "partyName",
              p.start_date AS "startDate", p.end_date AS "endDate",
              p.budget_rial AS "budgetRial", p.description, p.project_type AS "projectType",
              p.tags, p.created_at AS "createdAt",
              (SELECT count(*)::int FROM ai_project_tasks t WHERE t.project_id = p.id)
                AS "taskCount"
         FROM ai_projects p
         LEFT JOIN parties party ON party.id = p.party_id
        WHERE ${where.join(" AND ")}
        ORDER BY p.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      budgetRial: row.budgetRial === null ? null : Number(row.budgetRial),
      startDate: isoDate(row.startDate),
      endDate: isoDate(row.endDate),
      createdAt: isoDate(row.createdAt),
      tags: tagList(row.tags),
    }));
  },
  async write(context, values, options) {
    const name = text(values.name);
    if (!name) throw new RowRejection("نام پروژه الزامی است.");
    const warnings: string[] = [];

    let partyId: string | null = null;
    const partyName = text(values.partyName);
    if (partyName) {
      const party = await findParty(context.businessId, partyName);
      if (party) partyId = party.id;
      else {
        const strategy = options.relationStrategy.partyName ?? "warn";
        if (strategy === "skip") {
          return { status: "skipped", reason: `کارفرمای «${partyName}» یافت نشد.` };
        }
        warnings.push(`کارفرمای «${partyName}» یافت نشد و پروژه بدون کارفرما ثبت شد.`);
      }
    }

    const existing = await resolveProject(context, name, false);
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `پروژهٔ «${name}» از پیش وجود دارد.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE ai_projects
            SET status = coalesce($3, status), priority = coalesce($4, priority),
                party_id = coalesce($5::uuid, party_id),
                start_date = coalesce($6::date, start_date),
                end_date = coalesce($7::date, end_date),
                budget_rial = coalesce($8, budget_rial),
                description = coalesce($9, description),
                project_type = coalesce($10, project_type),
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          text(values.status),
          text(values.priority),
          partyId,
          values.startDate ?? null,
          values.endDate ?? null,
          values.budgetRial ?? null,
          text(values.description),
          text(values.projectType),
        ],
      );
      return { status: "updated", id: existing.id, warnings };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO ai_projects
         (business_id, name, instructions, description, status, priority, party_id,
          start_date, end_date, budget_rial, project_type, tags, created_by, owner_user_id)
       VALUES ($1, $2, '', coalesce($3, ''), coalesce($4, 'active'), coalesce($5, 'normal'),
               $6::uuid, $7::date, $8::date, $9, $10, coalesce($11::text[], '{}'), $12, $13::uuid)
       RETURNING id`,
      [
        context.businessId,
        name,
        text(values.description),
        text(values.status),
        text(values.priority),
        partyId,
        values.startDate ?? null,
        values.endDate ?? null,
        values.budgetRial ?? null,
        text(values.projectType),
        tagList(values.tags),
        context.actorName,
        context.actorUserId,
      ],
    );
    return { status: "created", id: rows[0].id, warnings };
  },
  resolveReference: (context, lookup, { create }) => resolveProject(context, lookup, create),
};

const tasksAdapter: EntityAdapter = {
  entity: "workspace.tasks",
  async read(context, options) {
    const where = ["p.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`t.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`t.status = $${params.length}`);
    }
    if (typeof options.filters.projectId === "string" && options.filters.projectId) {
      params.push(options.filters.projectId);
      where.push(`t.project_id = $${params.length}::uuid`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT t.id, t.title, p.name AS "projectName", t.status, t.priority,
              t.due_date AS "dueDate", t.description, t.completed_at AS "completedAt",
              t.created_at AS "createdAt"
         FROM ai_project_tasks t
         JOIN ai_projects p ON p.id = t.project_id
        WHERE ${where.join(" AND ")}
        ORDER BY t.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      dueDate: isoDate(row.dueDate),
      completedAt: isoDate(row.completedAt),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const title = text(values.title);
    if (!title) throw new RowRejection("عنوان کار الزامی است.");
    const projectName = text(values.projectName);
    if (!projectName) throw new RowRejection("نام پروژه الزامی است.");

    const strategy = options.relationStrategy.projectName ?? "create";
    const project = await resolveProject(context, projectName, strategy === "create");
    if (!project) {
      return { status: "skipped", reason: `پروژهٔ «${projectName}» یافت نشد.` };
    }

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT t.id FROM ai_project_tasks t
        WHERE t.project_id = $1 AND lower(btrim(t.title)) = lower(btrim($2)) LIMIT 1`,
      [project.id, title],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `کار «${title}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE ai_project_tasks
            SET status = coalesce($2, status), priority = coalesce($3, priority),
                due_date = coalesce($4::date, due_date),
                description = coalesce($5, description), updated_at = now()
          WHERE id = $1`,
        [
          existing.id,
          text(values.status),
          text(values.priority),
          values.dueDate ?? null,
          text(values.description),
        ],
      );
      return { status: "updated", id: existing.id };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO ai_project_tasks
         (project_id, title, description, status, priority, due_date, source, created_by)
       VALUES ($1, $2, coalesce($3, ''), coalesce($4, 'todo'), coalesce($5, 'normal'),
               $6::date, 'import', $7)
       RETURNING id`,
      [
        project.id,
        title,
        text(values.description),
        text(values.status),
        text(values.priority),
        values.dueDate ?? null,
        context.actorName,
      ],
    );
    return { status: "created", id: rows[0].id };
  },
};

const contractsAdapter: EntityAdapter = {
  entity: "workspace.contracts",
  async read(context, options) {
    const where = ["c.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`c.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`c.status = $${params.length}`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT c.id, c.title, c.contract_type AS "contractType", party.name AS "partyName",
              p.name AS "projectName", c.value_rial AS "valueRial",
              c.start_date AS "startDate", c.end_date AS "endDate", c.status, c.notes,
              c.created_at AS "createdAt"
         FROM workspace_contracts c
         LEFT JOIN parties party ON party.id = c.party_id
         LEFT JOIN ai_projects p ON p.id = c.project_id
        WHERE ${where.join(" AND ")}
        ORDER BY c.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      valueRial: row.valueRial === null ? null : Number(row.valueRial),
      startDate: isoDate(row.startDate),
      endDate: isoDate(row.endDate),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const title = text(values.title);
    if (!title) throw new RowRejection("عنوان قرارداد الزامی است.");
    const warnings: string[] = [];

    let partyId: string | null = null;
    const partyName = text(values.partyName);
    if (partyName) {
      const party = await findParty(context.businessId, partyName);
      if (party) partyId = party.id;
      else {
        // The registry's default here is `skip`, and for good reason: a
        // contract commits money to a named third party, and inventing that
        // party from a spreadsheet cell is not an importer's decision.
        const strategy = options.relationStrategy.partyName ?? "skip";
        if (strategy === "skip") {
          return { status: "skipped", reason: `طرف قرارداد «${partyName}» یافت نشد.` };
        }
        warnings.push(`طرف قرارداد «${partyName}» یافت نشد و قرارداد بدون طرف ثبت شد.`);
      }
    }

    let projectId: string | null = null;
    const projectName = text(values.projectName);
    if (projectName) {
      const strategy = options.relationStrategy.projectName ?? "warn";
      const project = await resolveProject(context, projectName, strategy === "create");
      if (project) projectId = project.id;
      else if (strategy === "skip") {
        return { status: "skipped", reason: `پروژهٔ «${projectName}» یافت نشد.` };
      } else warnings.push(`پروژهٔ «${projectName}» یافت نشد و قرارداد بدون پروژه ثبت شد.`);
    }

    const { rows: existingRows } = await query<{ id: string }>(
      `SELECT id FROM workspace_contracts
        WHERE business_id = $1 AND lower(btrim(title)) = lower(btrim($2))
          AND party_id IS NOT DISTINCT FROM $3::uuid
        LIMIT 1`,
      [context.businessId, title, partyId],
    );
    const existing = existingRows[0];
    if (existing && options.duplicateStrategy === "skip") {
      return { status: "skipped", id: existing.id, reason: `قرارداد «${title}» از پیش ثبت شده است.` };
    }
    if (existing && options.duplicateStrategy === "update") {
      await query(
        `UPDATE workspace_contracts
            SET contract_type = coalesce($3, contract_type),
                project_id = coalesce($4::uuid, project_id),
                value_rial = coalesce($5, value_rial),
                start_date = coalesce($6::date, start_date),
                end_date = coalesce($7::date, end_date),
                status = coalesce($8, status), notes = coalesce($9, notes),
                updated_at = now()
          WHERE business_id = $1 AND id = $2`,
        [
          context.businessId,
          existing.id,
          text(values.contractType),
          projectId,
          values.valueRial ?? null,
          values.startDate ?? null,
          values.endDate ?? null,
          text(values.status),
          text(values.notes),
        ],
      );
      return { status: "updated", id: existing.id, warnings };
    }

    const { rows } = await query<{ id: string }>(
      `INSERT INTO workspace_contracts
         (business_id, project_id, party_id, title, contract_type, value_rial,
          start_date, end_date, status, notes, created_by)
       VALUES ($1, $2::uuid, $3::uuid, $4, coalesce($5, 'other'), $6, $7::date, $8::date,
               coalesce($9, 'draft'), coalesce($10, ''), $11)
       RETURNING id`,
      [
        context.businessId,
        projectId,
        partyId,
        title,
        text(values.contractType),
        values.valueRial ?? null,
        values.startDate ?? null,
        values.endDate ?? null,
        text(values.status),
        text(values.notes),
        context.actorName,
      ],
    );
    return { status: "created", id: rows[0].id, warnings };
  },
};

const documentsAdapter: EntityAdapter = {
  entity: "workspace.documents",
  async read(context, options) {
    const where = ["d.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`d.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.status === "string" && options.filters.status) {
      params.push(options.filters.status);
      where.push(`d.status = $${params.length}`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT d.id, d.title, p.name AS "projectName", c.title AS "contractTitle",
              d.status, d.version, d.tags, d.description, d.created_at AS "createdAt"
         FROM workspace_documents d
         LEFT JOIN ai_projects p ON p.id = d.project_id
         LEFT JOIN workspace_contracts c ON c.id = d.contract_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.created_at DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      version: Number(row.version ?? 1),
      tags: tagList(row.tags),
      createdAt: isoDate(row.createdAt),
    }));
  },
};

/**
 * Issue #799 §7 — a BOQ row, written through the estimating service rather
 * than by hand: the service is the one writer of these tables, so an import
 * gets the same validation, the same chapter handling and the same
 * "a non-draft revision cannot be changed" refusal an editor does.
 *
 * ## Where an imported row lands
 *
 *   * the project is named by the file. It must already exist — a BOQ row is
 *     not a reason to create a project (`onMissing: "skip"` in the registry),
 *     and the row comes back with the reason.
 *   * the estimate is named too, defaulting to «برآورد اصلی». It is created if
 *     the project has none, because the alternative is telling somebody to go
 *     and click a button before their spreadsheet can be read.
 *   * the revision: a row may name one. A named revision that is NOT a draft is
 *     refused (`aec-boq-service`'s own rule, surfaced here as a skipped row
 *     rather than a failed import), and a row naming none goes to the current
 *     draft — which is created if the estimate has no draft yet.
 *
 * The import therefore never touches an approved revision, which is the whole
 * of §7's "never overwrite an approved historical estimate".
 */
const boqItemsAdapter: EntityAdapter = {
  entity: "workspace.boq_items",
  async read(context, options) {
    const where = ["i.business_id = $1"];
    const params: unknown[] = [context.businessId];
    if (options.ids && options.ids.length > 0) {
      params.push([...options.ids]);
      where.push(`i.id = ANY($${params.length}::uuid[])`);
    }
    if (typeof options.filters.projectId === "string" && options.filters.projectId) {
      params.push(options.filters.projectId);
      where.push(`e.project_id = $${params.length}::uuid`);
    }
    params.push(options.limit);
    const { rows } = await query<Record<string, unknown>>(
      `SELECT i.id, p.name AS "projectName", e.title AS "estimateTitle",
              v.version_no AS "versionNo", s.code AS "sectionCode", s.title AS "sectionTitle",
              i.item_code AS "itemCode", i.description, i.unit, i.quantity::text AS quantity,
              i.material_rate_rial AS "materialRateRial", i.labor_rate_rial AS "laborRateRial",
              i.equipment_rate_rial AS "equipmentRateRial",
              i.subcontract_rate_rial AS "subcontractRateRial",
              i.waste_percent::text AS "wastePercent", i.overhead_percent::text AS "overheadPercent",
              i.markup_percent::text AS "markupPercent", i.unit_price_rial AS "unitPriceRial",
              i.total_rial AS "totalRial", i.work_package AS "workPackage",
              party.name AS "partyName", i.notes, i.created_at AS "createdAt"
         FROM aec_boq_items i
         JOIN aec_estimate_versions v ON v.id = i.version_id
         JOIN aec_estimates e ON e.id = v.estimate_id
         JOIN ai_projects p ON p.id = e.project_id
         LEFT JOIN aec_boq_sections s ON s.id = i.section_id
         LEFT JOIN parties party ON party.id = i.party_id
        WHERE ${where.join(" AND ")}
        ORDER BY v.version_no DESC, i.display_order
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((row) => ({
      ...row,
      quantity: String(row.quantity ?? "0"),
      materialRateRial: Number(row.materialRateRial ?? 0),
      laborRateRial: Number(row.laborRateRial ?? 0),
      equipmentRateRial: Number(row.equipmentRateRial ?? 0),
      subcontractRateRial: Number(row.subcontractRateRial ?? 0),
      wastePercent: String(row.wastePercent ?? "0"),
      overheadPercent: String(row.overheadPercent ?? "0"),
      markupPercent: String(row.markupPercent ?? "0"),
      unitPriceRial: Number(row.unitPriceRial ?? 0),
      totalRial: Number(row.totalRial ?? 0),
      createdAt: isoDate(row.createdAt),
    }));
  },
  async write(context, values, options) {
    const description = text(values.description);
    if (!description) throw new RowRejection("شرح ردیف الزامی است.");
    const projectName = text(values.projectName);
    if (!projectName) throw new RowRejection("نام پروژه الزامی است.");

    // A party that is not found is a warning, not a refusal: the line is still
    // a legitimate measurement, it just is not priced against a named supplier.
    const warnings: string[] = [];
    let partyId: string | null = null;
    const partyName = text(values.partyName);
    if (partyName) {
      const party = await findParty(context.businessId, partyName);
      if (party) partyId = party.id;
      else warnings.push(`«${partyName}» در پرونده‌ها پیدا نشد و ردیف بدون آن ثبت شد.`);
    }

    const estimateTitle = text(values.estimateTitle) ?? "برآورد اصلی";
    const result = await boq.importBoqItem(context, {
      projectName,
      estimateTitle,
      versionNo: values.versionNo === null || values.versionNo === undefined || values.versionNo === ""
        ? null
        : Number(values.versionNo),
      sectionCode: text(values.sectionCode) ?? "",
      sectionTitle: text(values.sectionTitle),
      itemCode: text(values.itemCode) ?? "",
      description,
      unit: text(values.unit) ?? "",
      quantity: values.quantity ?? 0,
      materialRateRial: values.materialRateRial ?? 0,
      laborRateRial: values.laborRateRial ?? 0,
      equipmentRateRial: values.equipmentRateRial ?? 0,
      subcontractRateRial: values.subcontractRateRial ?? 0,
      wastePercent: values.wastePercent ?? 0,
      overheadPercent: values.overheadPercent ?? 0,
      markupPercent: values.markupPercent ?? 0,
      workPackage: text(values.workPackage) ?? "",
      partyId,
      notes: text(values.notes) ?? "",
      duplicateStrategy: options.duplicateStrategy,
    });

    if (result.status === "skipped") {
      return { status: "skipped", id: result.id, reason: result.reason ?? "ردیف ثبت نشد." };
    }
    return { status: result.status, id: result.id ?? "", warnings };
  },
};

export function registerWorkspaceAdapters(): void {
  registerAdapter(projectsAdapter);
  registerAdapter(tasksAdapter);
  registerAdapter(contractsAdapter);
  registerAdapter(documentsAdapter);
  registerAdapter(boqItemsAdapter);
}
