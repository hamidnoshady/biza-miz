/**
 * «اسناد دوره‌ای» — templates, their occurrence register, and the controlled
 * draft generation behind them.
 *
 * ## What this is not
 *
 * It is not a posting engine. Every occurrence ends at
 * `manual-journal-service.ts`'s `createDraft()`, which means the review queue,
 * the `ledger.approve` permission, the fiscal-period trigger and the voucher
 * numbering are all the existing ones. There is no code path here that inserts
 * into `journal_entries`.
 *
 * ## Exactly-once
 *
 * Three layers, each of which is enough on its own for the common failure:
 *
 *  1. the template row is locked (`FOR UPDATE` + a transaction-scoped advisory
 *     lock) while its schedule is claimed, so two workers cannot both advance
 *     the same next date;
 *  2. `recurring_journal_occurrences (template_id, scheduled_date)` is unique,
 *     so a replayed claim is a no-op;
 *  3. the draft's idempotency key is deterministic
 *     (`recurring:<templateId>:<date>`) and `journal_entry_drafts
 *     (business_id, idempotency_key)` is unique, so even a crash between
 *     "claimed" and "drafted" cannot produce two vouchers.
 *
 * The draft is therefore safe to *attempt* repeatedly: it is the database that
 * decides, never a read-then-write.
 *
 * ## Missed schedules
 *
 * A tick claims at most `RECURRING_CATCH_UP_LIMIT` occurrences per template and
 * then stops; the next tick continues. A held occurrence (locked period,
 * archived account) is `failed` with a code and a message rather than being
 * back-posted — the reviewer sees «چرا متوقف شد» and decides. Nothing is ever
 * posted into a locked period because posting is a separate, permissioned act.
 */
import type { PoolClient } from "pg";
import { query, withTenantTransaction } from "./db";
import {
  createDraft,
  ManualJournalError,
  type DraftLineInput,
} from "./manual-journal-service";
import {
  dimensionColumnValues,
  dimensionsFromColumns,
} from "./accounting-dimensions-service";
import type { LineDimensions } from "./accounting-dimensions";
import {
  addDaysIso,
  firstOccurrenceOnOrAfter,
  nextOccurrenceAfter,
  recurringOccurrenceIdempotencyKey,
  recurringVoucherProblem,
  recurringVoucherTotals,
  upcomingOccurrenceDates,
  templateIsEditable,
  RECURRING_CATCH_UP_LIMIT,
  RECURRENCE_FREQUENCIES,
  MONTH_END_POLICIES,
  RECURRING_OCCURRENCE_STATUSES,
  type MonthEndPolicy,
  type RecurrenceFrequency,
  type RecurringOccurrenceStatus,
  type RecurringSchedule,
  type RecurringTemplateStatus,
  type RecurringVoucherLine,
} from "./recurring-voucher";
import { isUuid } from "./uuid";
import { businessToday } from "./business-day-service";
import { todayIsoDate } from "./jalali";
import { voucherReferenceProblem } from "./voucher-numbering";

export class RecurringVoucherError extends Error {
  status: number;
  constructor(code: string, status = 400) {
    super(code);
    this.status = status;
  }
}

export interface RecurringTemplateLineRecord {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  partyId: string | null;
  partyName: string | null;
  debit: number;
  credit: number;
  description: string | null;
  dimensions: LineDimensions;
}

export interface RecurringTemplateRecord {
  id: string;
  name: string;
  description: string | null;
  memo: string;
  voucherReference: string | null;
  frequency: RecurrenceFrequency;
  monthEndPolicy: MonthEndPolicy;
  startDate: string;
  endDate: string | null;
  status: RecurringTemplateStatus;
  currentVersion: number;
  nextOccurrenceDate: string | null;
  lastGeneratedDate: string | null;
  locationId: string | null;
  locationName: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  totalDebit: number;
  totalCredit: number;
  occurrenceCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringOccurrenceRecord {
  id: string;
  templateId: string;
  templateVersion: number;
  scheduledDate: string;
  status: RecurringOccurrenceStatus;
  draftId: string | null;
  entryId: string | null;
  attemptCount: number;
  lastError: string | null;
  heldReason: string | null;
  generatedAt: string | null;
  postedAt: string | null;
  overdue: boolean;
}

export interface RecurringTemplateVersionRecord {
  version: number;
  changeKind: "created" | "edited" | "status_changed";
  actorName: string | null;
  createdAt: string;
}

export interface RecurringTemplateDetail extends RecurringTemplateRecord {
  lines: RecurringTemplateLineRecord[];
  versions: RecurringTemplateVersionRecord[];
  occurrences: RecurringOccurrenceRecord[];
  upcoming: string[];
}

export interface RecurringTemplateInput {
  name: string;
  description?: string | null;
  memo: string;
  voucherReference?: string | null;
  frequency: string;
  monthEndPolicy: string;
  startDate: string;
  endDate?: string | null;
  locationId?: string | null;
  ownerUserId?: string | null;
  lines: RecurringVoucherLine[];
}

interface TemplateRow extends Record<string, unknown> {
  id: string;
  business_id: string;
  location_id: string | null;
  location_name: string | null;
  name: string;
  description: string | null;
  memo: string;
  voucher_reference: string | null;
  frequency: string;
  month_end_policy: string;
  start_date: string;
  end_date: string | null;
  status: string;
  current_version: number;
  next_occurrence_date: string | null;
  last_generated_date: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  total_debit?: string;
  total_credit?: string;
  occurrence_count?: string;
  failed_count?: string;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  template_id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  party_id: string | null;
  party_name: string | null;
  debit: string;
  credit: string;
  description: string | null;
  cost_center_id: string | null;
  profit_center_id: string | null;
  department_id: string | null;
  detail_dimension_id: string | null;
}

interface OccurrenceRow extends Record<string, unknown> {
  id: string;
  template_id: string;
  template_version: number;
  scheduled_date: string;
  status: string;
  idempotency_key: string;
  memo: string;
  location_id: string | null;
  lines_snapshot: OccurrenceSnapshotLine[];
  draft_id: string | null;
  entry_id: string | null;
  attempt_count: number;
  last_error: string | null;
  held_reason: string | null;
  generated_at: string | null;
  posted_at: string | null;
}

interface OccurrenceSnapshotLine {
  accountId: string;
  partyId: string | null;
  debit: number;
  credit: number;
  description: string | null;
  dimensions: LineDimensions | null;
}

function scheduleOf(row: Pick<TemplateRow, "frequency" | "month_end_policy" | "start_date" | "end_date">): RecurringSchedule {
  return {
    frequency: row.frequency as RecurrenceFrequency,
    monthEndPolicy: row.month_end_policy as MonthEndPolicy,
    startDate: row.start_date,
    endDate: row.end_date,
  };
}

function templateOf(row: TemplateRow): RecurringTemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    memo: row.memo,
    voucherReference: row.voucher_reference,
    frequency: row.frequency as RecurrenceFrequency,
    monthEndPolicy: row.month_end_policy as MonthEndPolicy,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status as RecurringTemplateStatus,
    currentVersion: row.current_version,
    nextOccurrenceDate: row.next_occurrence_date,
    lastGeneratedDate: row.last_generated_date,
    locationId: row.location_id,
    locationName: row.location_name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    totalDebit: Number(row.total_debit ?? 0),
    totalCredit: Number(row.total_credit ?? 0),
    occurrenceCount: Number(row.occurrence_count ?? 0),
    failedCount: Number(row.failed_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function lineOf(row: LineRow): RecurringTemplateLineRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    accountName: row.account_name,
    partyId: row.party_id,
    partyName: row.party_name,
    debit: Number(row.debit),
    credit: Number(row.credit),
    description: row.description,
    dimensions: dimensionsFromColumns(row),
  };
}

function occurrenceOf(row: OccurrenceRow, today: string): RecurringOccurrenceRecord {
  const status = row.status as RecurringOccurrenceStatus;
  return {
    id: row.id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    scheduledDate: row.scheduled_date,
    status,
    draftId: row.draft_id,
    entryId: row.entry_id,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    heldReason: row.held_reason,
    generatedAt: row.generated_at,
    postedAt: row.posted_at,
    overdue:
      (status === "pending" || status === "failed") && row.scheduled_date < today,
  };
}

/**
 * The template columns with every `date` cast to text.
 *
 * `pg` in this codebase parses a `date` column into a JavaScript `Date`, and a
 * `Date` compared with an ISO string is never "before" or "after" it — it is
 * silently coerced to NaN. Every schedule comparison here is a string
 * comparison of `YYYY-MM-DD`, so the read must be text. This is the same
 * `::text` discipline the journal and fiscal-period services use.
 */
const TEMPLATE_ROW_COLUMNS = `id, business_id, location_id, name, description, memo, voucher_reference,
        frequency, month_end_policy, start_date::text AS start_date, end_date::text AS end_date,
        status, current_version, next_occurrence_date::text AS next_occurrence_date,
        last_generated_date::text AS last_generated_date, owner_user_id, created_by,
        created_at::text AS created_at, updated_at::text AS updated_at`;

const TEMPLATE_SELECT = `SELECT t.id, t.business_id, t.location_id, t.name, t.description, t.memo,
        t.voucher_reference, t.frequency, t.month_end_policy,
        t.start_date::text AS start_date, t.end_date::text AS end_date,
        t.status, t.current_version,
        t.next_occurrence_date::text AS next_occurrence_date,
        t.last_generated_date::text AS last_generated_date,
        t.owner_user_id, t.created_by,
        t.created_at::text AS created_at, t.updated_at::text AS updated_at,
        l.name AS location_name,
        u.full_name AS owner_name,
        (SELECT coalesce(sum(dl.debit), 0)::text FROM recurring_journal_template_lines dl WHERE dl.template_id = t.id) AS total_debit,
        (SELECT coalesce(sum(dl.credit), 0)::text FROM recurring_journal_template_lines dl WHERE dl.template_id = t.id) AS total_credit,
        (SELECT count(*)::text FROM recurring_journal_occurrences o WHERE o.template_id = t.id) AS occurrence_count,
        (SELECT count(*)::text FROM recurring_journal_occurrences o WHERE o.template_id = t.id AND o.status = 'failed') AS failed_count
   FROM recurring_journal_templates t
   LEFT JOIN locations l ON l.id = t.location_id
   LEFT JOIN users u ON u.id = t.owner_user_id`;

const LINE_SELECT = `SELECT dl.id, dl.template_id, dl.account_id, a.code AS account_code, a.name AS account_name,
        dl.party_id, p.name AS party_name, dl.debit::text AS debit, dl.credit::text AS credit,
        dl.description, dl.cost_center_id, dl.profit_center_id, dl.department_id, dl.detail_dimension_id
   FROM recurring_journal_template_lines dl
   JOIN recurring_journal_templates t ON t.id = dl.template_id AND t.business_id = $1
   JOIN accounts a ON a.id = dl.account_id
   LEFT JOIN parties p ON p.id = dl.party_id
  WHERE dl.template_id = ANY($2::uuid[])
  ORDER BY dl.template_id, dl.line_no`;

const OCCURRENCE_SELECT = `SELECT id, template_id, template_version, scheduled_date::text AS scheduled_date,
        status, idempotency_key, memo, location_id, lines_snapshot, draft_id, entry_id,
        attempt_count, last_error, held_reason,
        generated_at::text AS generated_at, posted_at::text AS posted_at
   FROM recurring_journal_occurrences`;

/** A stable JSON snapshot of the document, frozen for one occurrence or one version. */
function snapshotLines(lines: RecurringTemplateLineRecord[]): OccurrenceSnapshotLine[] {
  return lines.map((line) => ({
    accountId: line.accountId,
    partyId: line.partyId,
    debit: line.debit,
    credit: line.credit,
    description: line.description,
    dimensions: line.dimensions,
  }));
}

function snapshotOf(row: TemplateRow, lines: RecurringTemplateLineRecord[]) {
  return {
    name: row.name,
    description: row.description,
    memo: row.memo,
    voucherReference: row.voucher_reference,
    frequency: row.frequency,
    monthEndPolicy: row.month_end_policy,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    locationId: row.location_id,
    ownerUserId: row.owner_user_id,
    lines: snapshotLines(lines),
  };
}

/**
 * Append one audit row. `client` joins the caller's transaction; `null` writes
 * a standalone row (the generation path, whose claim transaction has already
 * committed by the time the draft is attempted).
 */
async function insertEvent(
  client: Pick<PoolClient, "query"> | null,
  params: {
    businessId: string;
    templateId: string | null;
    occurrenceId?: string | null;
    action: string;
    actorUserId: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  const sql = `INSERT INTO recurring_journal_occurrence_events
       (business_id, template_id, occurrence_id, action, actor_user_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6)`;
  const args = [
    params.businessId,
    params.templateId,
    params.occurrenceId ?? null,
    params.action,
    params.actorUserId,
    params.detail ?? null,
  ];
  if (client) await client.query(sql, args);
  else await query(sql, args);
}

/**
 * Every referenced account must belong to this business, be active, and be a
 * leaf; every party must belong to the business too.
 *
 * The leaf rule is the manual-journal rule (see `assertAccountsPostable` in
 * `manual-journal-service.ts`): a hand-chosen document posts to a leaf, while
 * system postings may legitimately write to a parent. A recurring template is
 * a hand-composed document, so it follows the manual rule.
 */
async function assertTemplateReferences(
  businessId: string,
  lines: RecurringVoucherLine[],
  client?: Pick<PoolClient, "query">,
): Promise<void> {
  const accountIds = [...new Set(lines.map((line) => line.accountId))];
  if (accountIds.some((id) => !isUuid(id))) throw new RecurringVoucherError("unknown_account");
  const accountSql = `SELECT a.id, a.is_active,
                             EXISTS (SELECT 1 FROM accounts k WHERE k.parent_id = a.id) AS has_children
                        FROM accounts a
                       WHERE a.business_id = $1 AND a.id = ANY($2::uuid[])`;
  const { rows: accounts } = client
    ? await client.query<{ id: string; is_active: boolean; has_children: boolean }>(accountSql, [
        businessId,
        accountIds,
      ])
    : await query<{ id: string; is_active: boolean; has_children: boolean }>(accountSql, [
        businessId,
        accountIds,
      ]);
  if (accounts.length !== accountIds.length) throw new RecurringVoucherError("unknown_account");
  if (accounts.some((row) => !row.is_active)) throw new RecurringVoucherError("account_inactive");
  if (accounts.some((row) => row.has_children)) throw new RecurringVoucherError("not_a_leaf_account");

  const partyIds = [...new Set(lines.map((line) => line.partyId).filter((id): id is string => !!id))];
  if (partyIds.length === 0) return;
  if (partyIds.some((id) => !isUuid(id))) throw new RecurringVoucherError("unknown_party");
  const partySql = `SELECT id FROM parties WHERE business_id = $1 AND id = ANY($2::uuid[])`;
  const { rows: parties } = client
    ? await client.query<{ id: string }>(partySql, [businessId, partyIds])
    : await query<{ id: string }>(partySql, [businessId, partyIds]);
  if (parties.length !== partyIds.length) throw new RecurringVoucherError("unknown_party");
}

function validatedInput(input: RecurringTemplateInput): {
  name: string;
  description: string | null;
  memo: string;
  voucherReference: string | null;
  frequency: RecurrenceFrequency;
  monthEndPolicy: MonthEndPolicy;
  startDate: string;
  endDate: string | null;
  lines: RecurringVoucherLine[];
} {
  const draft = {
    name: input.name,
    description: input.description ?? null,
    memo: input.memo,
    frequency: input.frequency,
    monthEndPolicy: input.monthEndPolicy,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    lines: input.lines,
  };
  const problem = recurringVoucherProblem(draft);
  if (problem) throw new RecurringVoucherError(problem);
  const voucherReference = input.voucherReference?.trim() || null;
  if (voucherReference && voucherReferenceProblem(voucherReference)) {
    throw new RecurringVoucherError("voucher_reference_invalid");
  }
  return {
    name: draft.name.trim(),
    description: draft.description?.trim() || null,
    memo: draft.memo.trim(),
    voucherReference,
    frequency: draft.frequency as RecurrenceFrequency,
    monthEndPolicy: draft.monthEndPolicy as MonthEndPolicy,
    startDate: draft.startDate,
    endDate: draft.endDate,
    lines: draft.lines,
  };
}

async function writeLines(
  client: Pick<PoolClient, "query">,
  templateId: string,
  lines: RecurringVoucherLine[],
): Promise<void> {
  for (const [index, line] of lines.entries()) {
    const dims = dimensionColumnValues(line.dimensions ?? null);
    await client.query(
      `INSERT INTO recurring_journal_template_lines
         (template_id, line_no, account_id, party_id, debit, credit, description,
          cost_center_id, profit_center_id, department_id, detail_dimension_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        templateId,
        index,
        line.accountId,
        line.partyId ?? null,
        line.debit,
        line.credit,
        line.description?.trim() || null,
        dims.cost_center_id,
        dims.profit_center_id,
        dims.department_id,
        dims.detail_dimension_id,
      ],
    );
  }
}

async function readLines(
  businessId: string,
  templateIds: string[],
  client?: Pick<PoolClient, "query">,
): Promise<Map<string, RecurringTemplateLineRecord[]>> {
  const out = new Map<string, RecurringTemplateLineRecord[]>();
  if (templateIds.length === 0) return out;
  const { rows } = client
    ? await client.query<LineRow>(LINE_SELECT, [businessId, templateIds])
    : await query<LineRow>(LINE_SELECT, [businessId, templateIds]);
  for (const row of rows) {
    const list = out.get(row.template_id) ?? [];
    list.push(lineOf(row));
    out.set(row.template_id, list);
  }
  return out;
}

/** Page of templates for the register. */
export async function listRecurringTemplates(
  businessId: string,
  filters: { status?: RecurringTemplateStatus | null } = {},
): Promise<RecurringTemplateRecord[]> {
  const status = filters.status ?? null;
  if (status && !["active", "paused", "completed", "cancelled"].includes(status)) {
    throw new RecurringVoucherError("invalid_status");
  }
  const { rows } = await query<TemplateRow>(
    `${TEMPLATE_SELECT}
      WHERE t.business_id = $1 AND ($2::text IS NULL OR t.status = $2::text)
      ORDER BY t.created_at DESC, t.id DESC`,
    [businessId, status],
  );
  return rows.map(templateOf);
}

export async function getRecurringTemplate(
  businessId: string,
  id: string,
): Promise<RecurringTemplateDetail | null> {
  if (!isUuid(id)) return null;
  const [{ rows }, today] = await Promise.all([
    query<TemplateRow>(`${TEMPLATE_SELECT} WHERE t.business_id = $1 AND t.id = $2`, [businessId, id]),
    businessToday(businessId),
  ]);
  const row = rows[0];
  if (!row) return null;
  const linesByTemplate = await readLines(businessId, [id]);
  const lines = linesByTemplate.get(id) ?? [];
  const [{ rows: occurrenceRows }, { rows: versionRows }] = await Promise.all([
    query<OccurrenceRow>(
      `${OCCURRENCE_SELECT}
        WHERE business_id = $1 AND template_id = $2
        ORDER BY scheduled_date DESC, id DESC LIMIT 120`,
      [businessId, id],
    ),
    query<{ version: number; change_kind: string; created_at: string; actor_name: string | null }>(
      `SELECT v.version, v.change_kind, v.created_at::text AS created_at, u.full_name AS actor_name
         FROM recurring_journal_template_versions v
         LEFT JOIN users u ON u.id = v.actor_user_id
        WHERE v.business_id = $1 AND v.template_id = $2
        ORDER BY v.version DESC LIMIT 30`,
      [businessId, id],
    ),
  ]);
  return {
    ...templateOf(row),
    lines,
    upcoming: upcomingOccurrenceDates(scheduleOf(row), today, 8),
    occurrences: occurrenceRows.map((occurrence) => occurrenceOf(occurrence, today)),
    versions: versionRows.map((version) => ({
      version: version.version,
      changeKind: version.change_kind as "created" | "edited" | "status_changed",
      actorName: version.actor_name,
      createdAt: version.created_at,
    })),
  };
}

export async function createRecurringTemplate(params: {
  businessId: string;
  actorId: string | null;
  input: RecurringTemplateInput;
}): Promise<{ id: string }> {
  const input = validatedInput(params.input);
  await assertTemplateReferences(params.businessId, input.lines);
  if (params.input.locationId && !isUuid(params.input.locationId)) {
    throw new RecurringVoucherError("invalid_location");
  }
  if (params.input.locationId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.input.locationId],
    );
    if (!rows[0]) throw new RecurringVoucherError("invalid_location");
  }

  const schedule: RecurringSchedule = {
    frequency: input.frequency,
    monthEndPolicy: input.monthEndPolicy,
    startDate: input.startDate,
    endDate: input.endDate,
  };
  const next = firstOccurrenceOnOrAfter(schedule, input.startDate);

  return withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO recurring_journal_templates
         (business_id, location_id, name, description, memo, voucher_reference,
          frequency, month_end_policy, start_date, end_date, status,
          current_version, next_occurrence_date, owner_user_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', 1, $11, $12, $13)
       RETURNING id`,
      [
        params.businessId,
        params.input.locationId ?? null,
        input.name,
        input.description,
        input.memo,
        input.voucherReference,
        input.frequency,
        input.monthEndPolicy,
        input.startDate,
        input.endDate,
        next,
        params.input.ownerUserId && isUuid(params.input.ownerUserId) ? params.input.ownerUserId : params.actorId,
        params.actorId,
      ],
    );
    const templateId = rows[0].id;
    await writeLines(client, templateId, input.lines);
    const linesByTemplate = await readLines(params.businessId, [templateId], client);
    const lines = linesByTemplate.get(templateId) ?? [];
    const createdRows = await client.query<TemplateRow>(
      `${TEMPLATE_SELECT} WHERE t.business_id = $1 AND t.id = $2`,
      [params.businessId, templateId],
    );
    await client.query(
      `INSERT INTO recurring_journal_template_versions
         (business_id, template_id, version, change_kind, snapshot, actor_user_id)
       VALUES ($1, $2, 1, 'created', $3, $4)`,
      [params.businessId, templateId, snapshotOf(createdRows.rows[0], lines), params.actorId],
    );
    await insertEvent(client, {
      businessId: params.businessId,
      templateId,
      action: "template_created",
      actorUserId: params.actorId,
      detail: { version: 1, nextOccurrenceDate: next },
    });
    return { id: templateId };
  });
}

/**
 * Edit a template prospectively.
 *
 * The lines are replaced and `current_version` is bumped, but **no occurrence,
 * draft or posted entry is touched**. Every occurrence already carries its own
 * `lines_snapshot`/`template_version`, so «از این پس» is a property of the
 * data, not a convention. The next due date is recomputed from today, so an
 * edit can never backfill a past period.
 */
export async function updateRecurringTemplate(params: {
  businessId: string;
  templateId: string;
  actorId: string | null;
  input: RecurringTemplateInput;
}): Promise<{ id: string; version: number }> {
  if (!isUuid(params.templateId)) throw new RecurringVoucherError("template_not_found", 404);
  const input = validatedInput(params.input);
  await assertTemplateReferences(params.businessId, input.lines);
  if (params.input.locationId) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM locations WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.input.locationId],
    );
    if (!rows[0]) throw new RecurringVoucherError("invalid_location");
  }
  return withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_ROW_COLUMNS} FROM recurring_journal_templates
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.templateId],
    );
    const row = rows[0];
    if (!row) throw new RecurringVoucherError("template_not_found", 404);
    if (!templateIsEditable(row.status as RecurringTemplateStatus)) {
      throw new RecurringVoucherError("template_not_editable", 409);
    }
    const schedule: RecurringSchedule = {
      frequency: input.frequency,
      monthEndPolicy: input.monthEndPolicy,
      startDate: input.startDate,
      endDate: input.endDate,
    };
    /*
     * Prospective, not "from today". The next ungenerated date under the new
     * schedule is the first occurrence after the last one already claimed, so
     * an edit made while a catch-up is pending does not silently drop the
     * dates between the last claim and today. Occurrences that already exist —
     * drafted, posted or held — are never re-created or rewritten.
     */
    const next = firstOccurrenceOnOrAfter(
      schedule,
      row.last_generated_date ? addDaysIso(row.last_generated_date, 1) : row.start_date,
    );
    const version = row.current_version + 1;

    await client.query(
      `UPDATE recurring_journal_templates
          SET location_id = $3, name = $4, description = $5, memo = $6, voucher_reference = $7,
              frequency = $8, month_end_policy = $9, start_date = $10, end_date = $11,
              current_version = $12, next_occurrence_date = $13, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [
        params.businessId,
        params.templateId,
        params.input.locationId ?? null,
        input.name,
        input.description,
        input.memo,
        input.voucherReference,
        input.frequency,
        input.monthEndPolicy,
        input.startDate,
        input.endDate,
        version,
        next,
      ],
    );
    await client.query(
      `DELETE FROM recurring_journal_template_lines WHERE template_id = $1`,
      [params.templateId],
    );
    await writeLines(client, params.templateId, input.lines);
    const updated = await client.query<TemplateRow>(
      `${TEMPLATE_SELECT} WHERE t.business_id = $1 AND t.id = $2`,
      [params.businessId, params.templateId],
    );
    const linesByTemplate = await readLines(params.businessId, [params.templateId], client);
    await client.query(
      `INSERT INTO recurring_journal_template_versions
         (business_id, template_id, version, change_kind, snapshot, actor_user_id)
       VALUES ($1, $2, $3, 'edited', $4, $5)`,
      [
        params.businessId,
        params.templateId,
        version,
        snapshotOf(updated.rows[0], linesByTemplate.get(params.templateId) ?? []),
        params.actorId,
      ],
    );
    await insertEvent(client, {
      businessId: params.businessId,
      templateId: params.templateId,
      action: "template_edited",
      actorUserId: params.actorId,
      detail: { version, nextOccurrenceDate: next },
    });
    return { id: params.templateId, version };
  });
}

const ALLOWED_STATUS_TRANSITIONS: Record<
  RecurringTemplateStatus,
  RecurringTemplateStatus[]
> = {
  active: ["paused", "cancelled"],
  paused: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export async function setRecurringTemplateStatus(params: {
  businessId: string;
  templateId: string;
  actorId: string | null;
  status: RecurringTemplateStatus;
}): Promise<{ id: string; status: RecurringTemplateStatus }> {
  if (!isUuid(params.templateId)) throw new RecurringVoucherError("template_not_found", 404);
  if (!["active", "paused", "cancelled", "completed"].includes(params.status)) {
    throw new RecurringVoucherError("invalid_status");
  }
  const today = await businessToday(params.businessId);
  return withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_ROW_COLUMNS} FROM recurring_journal_templates
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.templateId],
    );
    const row = rows[0];
    if (!row) throw new RecurringVoucherError("template_not_found", 404);
    const from = row.status as RecurringTemplateStatus;
    if (from === params.status) {
      return { id: row.id, status: from };
    }
    if (!ALLOWED_STATUS_TRANSITIONS[from].includes(params.status)) {
      throw new RecurringVoucherError("invalid_status_transition", 409);
    }
    const schedule = scheduleOf(row);
    const next =
      params.status === "active"
        ? (row.next_occurrence_date ?? firstOccurrenceOnOrAfter(schedule, today))
        : params.status === "paused"
          ? row.next_occurrence_date
          : null;
    await client.query(
      `UPDATE recurring_journal_templates
          SET status = $3, next_occurrence_date = $4, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.templateId, params.status, next],
    );
    await client.query(
      `INSERT INTO recurring_journal_template_versions
         (business_id, template_id, version, change_kind, snapshot, actor_user_id)
       VALUES ($1, $2, $3, 'status_changed', $4, $5)`,
      [
        params.businessId,
        params.templateId,
        row.current_version,
        { from, to: params.status, changedAt: new Date().toISOString() },
        params.actorId,
      ],
    );
    await insertEvent(client, {
      businessId: params.businessId,
      templateId: params.templateId,
      action: "template_status_changed",
      actorUserId: params.actorId,
      detail: { from, to: params.status },
    });
    return { id: params.templateId, status: params.status };
  });
}

/**
 * The fiscal-period status covering a date, or null when the business has not
 * adopted a period for it.
 *
 * A locked or soft-closed period is a *hold*, not a reason to drop the
 * occurrence: the reviewer must unlock it (or the template be paused), and the
 * register keeps saying why. The draft itself is only a draft, so there is no
 * posting to be refused — but creating a voucher that cannot be approved is
 * worse than holding it with an explanation.
 */
async function fiscalHoldFor(
  businessId: string,
  date: string,
  client?: Pick<PoolClient, "query">,
): Promise<string | null> {
  const sql = `SELECT status::text AS status FROM fiscal_periods
      WHERE business_id = $1 AND $2::date BETWEEN starts_on AND ends_on
      ORDER BY starts_on DESC LIMIT 1`;
  const { rows } = client
    ? await client.query<{ status: string }>(sql, [businessId, date])
    : await query<{ status: string }>(sql, [businessId, date]);
  const status = rows[0]?.status;
  if (status === "locked") return "fiscal_period_locked";
  if (status === "soft_closed") return "fiscal_period_soft_closed";
  return null;
}

async function markOccurrence(
  businessId: string,
  occurrenceId: string,
  patch: {
    status: RecurringOccurrenceStatus;
    draftId?: string | null;
    entryId?: string | null;
    lastError?: string | null;
    heldReason?: string | null;
    generated?: boolean;
  },
): Promise<void> {
  await query(
    `UPDATE recurring_journal_occurrences
        SET status = $3,
            draft_id = coalesce($4::uuid, draft_id),
            entry_id = coalesce($5::uuid, entry_id),
            last_error = $6,
            held_reason = $7,
            attempt_count = attempt_count + $8,
            generated_at = CASE WHEN $9::boolean THEN now() ELSE generated_at END,
            updated_at = now()
      WHERE business_id = $1 AND id = $2`,
    [
      businessId,
      occurrenceId,
      patch.status,
      patch.draftId ?? null,
      patch.entryId ?? null,
      patch.lastError ?? null,
      patch.heldReason ?? null,
      patch.status === "draft" ? 1 : 0,
      patch.generated === true,
    ],
  );
}

/**
 * Turn one claimed occurrence into a draft.
 *
 * Safe to call repeatedly: the draft's deterministic idempotency key makes the
 * second call return the first draft (`duplicate: true`) rather than create a
 * second one. That is what covers a crash after the occurrence was claimed and
 * before its `draft_id` was written.
 */
async function materializeOccurrence(params: {
  businessId: string;
  occurrence: OccurrenceRow;
  createdBy: string | null;
}): Promise<{ status: "draft" | "failed"; duplicate: boolean }> {
  const { businessId, occurrence } = params;

  // Recovery: the draft may already exist from an interrupted attempt.
  const { rows: existing } = await query<{ id: string }>(
    `SELECT id FROM journal_entry_drafts
      WHERE business_id = $1 AND idempotency_key = $2`,
    [businessId, occurrence.idempotency_key],
  );
  if (existing[0]) {
    await markOccurrence(businessId, occurrence.id, { status: "draft", draftId: existing[0].id });
    return { status: "draft", duplicate: true };
  }

  const hold = await fiscalHoldFor(businessId, occurrence.scheduled_date);
  if (hold) {
    await markOccurrence(businessId, occurrence.id, {
      status: "failed",
      lastError: hold,
      heldReason: hold,
    });
    await insertEvent(null, {
      businessId,
      templateId: occurrence.template_id,
      occurrenceId: occurrence.id,
      action: "occurrence_held",
      actorUserId: null,
      detail: { code: hold, scheduledDate: occurrence.scheduled_date },
    });
    return { status: "failed", duplicate: false };
  }

  const lines: DraftLineInput[] = occurrence.lines_snapshot.map((line) => ({
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    partyId: line.partyId,
    dimensions: line.dimensions ?? null,
  }));

  try {
    const { id, duplicate } = await createDraft({
      businessId,
      locationId: occurrence.location_id,
      entryDate: occurrence.scheduled_date,
      memo: occurrence.memo,
      lines,
      createdBy: params.createdBy,
      idempotencyKey: occurrence.idempotency_key,
    });
    await markOccurrence(businessId, occurrence.id, {
      status: "draft",
      draftId: id,
      generated: true,
    });
    await insertEvent(null, {
      businessId,
      templateId: occurrence.template_id,
      occurrenceId: occurrence.id,
      action: "occurrence_drafted",
      actorUserId: null,
      detail: { draftId: id, scheduledDate: occurrence.scheduled_date },
    });
    return { status: "draft", duplicate };
  } catch (err) {
    const code = err instanceof ManualJournalError ? err.message : "draft_generation_failed";
    await markOccurrence(businessId, occurrence.id, {
      status: "failed",
      lastError: code,
      heldReason: code,
    });
    await insertEvent(null, {
      businessId,
      templateId: occurrence.template_id,
      occurrenceId: occurrence.id,
      action: "occurrence_failed",
      actorUserId: null,
      detail: { code, scheduledDate: occurrence.scheduled_date },
    });
    return { status: "failed", duplicate: false };
  }
}

export interface RecurringGenerationResult {
  templates: number;
  draftsCreated: number;
  failed: number;
  occurrences: { id: string; scheduledDate: string; status: "draft" | "failed" }[];
}

/**
 * Generate everything due for one template up to `asOfDate`.
 *
 * The claim (insert occurrence + advance the schedule) happens in one locked
 * transaction. The draft is created *after* it commits, because
 * `createDraft()` owns its own transaction and nesting two `BEGIN`s on
 * different connections would hold the template lock across a second
 * connection's work. The two-phase shape is what the idempotency key exists
 * for.
 */
export async function generateForTemplate(params: {
  businessId: string;
  templateId: string;
  asOfDate: string;
}): Promise<RecurringGenerationResult> {
  if (!isUuid(params.templateId)) throw new RecurringVoucherError("template_not_found", 404);
  const claim = await withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<TemplateRow>(
      `SELECT ${TEMPLATE_ROW_COLUMNS} FROM recurring_journal_templates
        WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.templateId],
    );
    const row = rows[0];
    if (!row) throw new RecurringVoucherError("template_not_found", 404);
    if (row.status !== "active") {
      return { pending: [] as OccurrenceRow[], createdBy: row.created_by, advanced: false };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `recurring-journal:${params.templateId}`,
    ]);

    const pending: OccurrenceRow[] = [];
    const budget = RECURRING_CATCH_UP_LIMIT;
    const { rows: pendingRows } = await client.query<OccurrenceRow>(
      `${OCCURRENCE_SELECT}
        WHERE business_id = $1 AND template_id = $2 AND status = 'pending' AND scheduled_date <= $3
        ORDER BY scheduled_date ASC LIMIT $4`,
      [params.businessId, params.templateId, params.asOfDate, budget],
    );
    pending.push(...pendingRows);

    const schedule = scheduleOf(row);
    let cursor =
      row.next_occurrence_date ?? firstOccurrenceOnOrAfter(schedule, row.start_date);
    let created = 0;
    let lastClaimed = row.last_generated_date;
    const remaining = Math.max(budget - pending.length, 0);
    const linesByTemplate = await readLines(params.businessId, [params.templateId], client);
    const snapshot = snapshotLines(linesByTemplate.get(params.templateId) ?? []);

    while (cursor && cursor <= params.asOfDate && created < remaining) {
      if (row.end_date && cursor > row.end_date) {
        cursor = null;
        break;
      }
      const key = recurringOccurrenceIdempotencyKey(params.templateId, cursor);
      const inserted = await client.query<OccurrenceRow>(
        `INSERT INTO recurring_journal_occurrences
           (business_id, template_id, template_version, scheduled_date, status,
            idempotency_key, memo, location_id, lines_snapshot)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $8)
         ON CONFLICT (template_id, scheduled_date) DO NOTHING
         RETURNING id, template_id, template_version, scheduled_date::text AS scheduled_date,
                   status, idempotency_key, memo, location_id, lines_snapshot, draft_id, entry_id,
                   attempt_count, last_error, held_reason,
                   generated_at::text AS generated_at, posted_at::text AS posted_at`,
        [
          params.businessId,
          params.templateId,
          row.current_version,
          cursor,
          key,
          row.memo,
          row.location_id,
          JSON.stringify(snapshot),
        ],
      );
      if (inserted.rows[0]) {
        pending.push(inserted.rows[0]);
        created++;
      }
      lastClaimed = cursor;
      cursor = nextOccurrenceAfter(schedule, cursor);
    }

    const finished = cursor === null;
    await client.query(
      `UPDATE recurring_journal_templates
          SET next_occurrence_date = $3,
              last_generated_date = coalesce($4, last_generated_date),
              status = CASE WHEN $5 THEN 'completed' ELSE status END,
              updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.templateId, cursor, lastClaimed, finished],
    );
    if (finished) {
      await insertEvent(client, {
        businessId: params.businessId,
        templateId: params.templateId,
        action: "template_completed",
        actorUserId: null,
        detail: {},
      });
    }
    return { pending, createdBy: row.created_by, advanced: created > 0 };
  });

  let draftsCreated = 0;
  let failed = 0;
  const occurrences: RecurringGenerationResult["occurrences"] = [];
  for (const occurrence of claim.pending) {
    const outcome = await materializeOccurrence({
      businessId: params.businessId,
      occurrence,
      createdBy: claim.createdBy,
    });
    // A second worker may re-attempt a claimed occurrence and get the existing
    // draft back (`duplicate`). The draft is real, but *this* call did not
    // create it — counting it would make two workers report two vouchers each.
    if (outcome.status === "draft" && !outcome.duplicate) draftsCreated++;
    if (outcome.status === "failed") failed++;
    occurrences.push({
      id: occurrence.id,
      scheduledDate: occurrence.scheduled_date,
      status: outcome.status,
    });
  }
  return { templates: 1, draftsCreated, failed, occurrences };
}

/** Generate everything due for a business — the tick's entry point. */
export async function generateDueOccurrences(params: {
  businessId: string;
  asOfDate?: string;
}): Promise<RecurringGenerationResult> {
  const asOf = params.asOfDate ?? (await businessToday(params.businessId));
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM recurring_journal_templates
      WHERE business_id = $1 AND status = 'active'
        AND next_occurrence_date IS NOT NULL
        AND next_occurrence_date <= $2::date
      ORDER BY next_occurrence_date ASC, id ASC`,
    [params.businessId, asOf],
  );
  const total: RecurringGenerationResult = {
    templates: rows.length,
    draftsCreated: 0,
    failed: 0,
    occurrences: [],
  };
  for (const row of rows) {
    const result = await generateForTemplate({
      businessId: params.businessId,
      templateId: row.id,
      asOfDate: asOf,
    });
    total.draftsCreated += result.draftsCreated;
    total.failed += result.failed;
    total.occurrences.push(...result.occurrences);
  }
  return total;
}

/** Retry a held occurrence. A posted one is immutable and a drafted one is the reviewer's. */
export async function retryOccurrence(params: {
  businessId: string;
  occurrenceId: string;
  actorId: string | null;
}): Promise<{ status: "draft" | "failed" }> {
  if (!isUuid(params.occurrenceId)) throw new RecurringVoucherError("occurrence_not_found", 404);
  const occurrence = await withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<OccurrenceRow & { created_by: string | null }>(
      `SELECT o.id, o.template_id, o.template_version, o.scheduled_date::text AS scheduled_date,
              o.status, o.idempotency_key, o.memo, o.location_id, o.lines_snapshot,
              o.draft_id, o.entry_id, o.attempt_count, o.last_error, o.held_reason,
              o.generated_at::text AS generated_at, o.posted_at::text AS posted_at,
              t.created_by
         FROM recurring_journal_occurrences o
         JOIN recurring_journal_templates t ON t.id = o.template_id
        WHERE o.business_id = $1 AND o.id = $2
        FOR UPDATE OF o`,
      [params.businessId, params.occurrenceId],
    );
    const row = rows[0];
    if (!row) throw new RecurringVoucherError("occurrence_not_found", 404);
    if (row.status === "posted") throw new RecurringVoucherError("occurrence_already_posted", 409);
    if (row.status === "draft") throw new RecurringVoucherError("occurrence_has_draft", 409);
    await client.query(
      `UPDATE recurring_journal_occurrences
          SET status = 'pending', last_error = NULL, held_reason = NULL, updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.occurrenceId],
    );
    await insertEvent(client, {
      businessId: params.businessId,
      templateId: row.template_id,
      occurrenceId: row.id,
      action: "occurrence_retry_requested",
      actorUserId: params.actorId,
      detail: { previousStatus: row.status },
    });
    return { ...row, status: "pending" as const };
  });
  const materialized = await materializeOccurrence({
    businessId: params.businessId,
    occurrence,
    createdBy: occurrence.created_by,
  });
  return { status: materialized.status };
}

/** Skip a held or pending occurrence. It never had a journal effect. */
export async function skipOccurrence(params: {
  businessId: string;
  occurrenceId: string;
  actorId: string | null;
}): Promise<void> {
  if (!isUuid(params.occurrenceId)) throw new RecurringVoucherError("occurrence_not_found", 404);
  await withTenantTransaction(params.businessId, async (client) => {
    const { rows } = await client.query<OccurrenceRow>(
      `${OCCURRENCE_SELECT} WHERE business_id = $1 AND id = $2 FOR UPDATE`,
      [params.businessId, params.occurrenceId],
    );
    const row = rows[0];
    if (!row) throw new RecurringVoucherError("occurrence_not_found", 404);
    if (row.status === "posted") throw new RecurringVoucherError("occurrence_already_posted", 409);
    if (row.status === "draft") throw new RecurringVoucherError("occurrence_has_draft", 409);
    await client.query(
      `UPDATE recurring_journal_occurrences
          SET status = 'skipped', held_reason = 'skipped_by_user', updated_at = now()
        WHERE business_id = $1 AND id = $2`,
      [params.businessId, params.occurrenceId],
    );
    await insertEvent(client, {
      businessId: params.businessId,
      templateId: row.template_id,
      occurrenceId: row.id,
      action: "occurrence_skipped",
      actorUserId: params.actorId,
      detail: { scheduledDate: row.scheduled_date },
    });
  });
}

/**
 * The balanced preview a create/edit form shows before saving.
 *
 * Pure: it validates the document, totals it and lists the next dates. Kept in
 * the service file so the route and any future caller share it, but it touches
 * no database.
 */
export function previewRecurringTemplate(
  input: RecurringTemplateInput,
  fromDate: string,
  count = 8,
): {
  problem: string | null;
  totalDebit: number;
  totalCredit: number;
  upcoming: string[];
} {
  const totals = recurringVoucherTotals(input.lines);
  const problem = recurringVoucherProblem({
    name: input.name,
    description: input.description ?? null,
    memo: input.memo,
    frequency: input.frequency,
    monthEndPolicy: input.monthEndPolicy,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
    lines: input.lines,
  });
  if (problem) {
    return { problem, totalDebit: totals.debit, totalCredit: totals.credit, upcoming: [] };
  }
  const schedule: RecurringSchedule = {
    frequency: input.frequency as RecurrenceFrequency,
    monthEndPolicy: input.monthEndPolicy as MonthEndPolicy,
    startDate: input.startDate,
    endDate: input.endDate ?? null,
  };
  return {
    problem: null,
    totalDebit: totals.debit,
    totalCredit: totals.credit,
    upcoming: upcomingOccurrenceDates(schedule, fromDate, count),
  };
}

/** The branches a template may be scoped to — the one list the form's branch picker uses. */
export async function listRecurringLocations(
  businessId: string,
): Promise<{ id: string; name: string }[]> {
  const { rows } = await query<{ id: string; name: string }>(
    `SELECT id, name FROM locations WHERE business_id = $1 AND is_active ORDER BY name`,
    [businessId],
  );
  return rows;
}

/** The `?asOf=` default for a manual "generate now" request: the business's own today. */
export async function recurringAsOfDefault(businessId: string): Promise<string> {
  const today = await businessToday(businessId).catch(() => todayIsoDate());
  return today;
}

export {
  RECURRENCE_FREQUENCIES,
  MONTH_END_POLICIES,
  RECURRING_OCCURRENCE_STATUSES,
};
export type { RecurringTemplateStatus };
