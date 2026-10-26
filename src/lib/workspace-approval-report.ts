/**
 * Issue #907 F03 — the safe reconciliation report for stuck workspace approvals.
 *
 * ## What it reports
 *
 * Two shapes got into the approval engine and neither is reachable from an
 * ordinary screen:
 *
 * 1. **Duplicate live requests.** Before migration 0258 nothing stopped a
 *    subject from carrying several `pending` requests at once. The first
 *    decision to land then moved the subject while the rest stayed pending, and
 *    every approver in the inbox saw the same subject more than once.
 *
 * 2. **Orphan subjects.** Withdrawing a request used to leave its subject in
 *    `pending_approval` (a contract) or `in_review` (a document) with nothing
 *    waiting on it — the live deployment's contract that "is pending approval"
 *    with an empty approval column is exactly this. The service reverts the
 *    subject when the last pending request is cancelled (F03), but rows written
 *    before that fix are still stranded.
 *
 * ## What may be done about it
 *
 * The issue is explicit: *do not invent approvals, silently activate contracts
 * or rewrite history*, and production data changes need the operator's own
 * authorization. Every finding therefore carries the authorized path that fixes
 * it, and there are exactly two:
 *
 * - a **duplicate** request is cancelled from the approvals inbox — «لغو» — which
 *   now also returns the subject to `draft` when it was the last pending request
 *   (`decideApproval` → `revertSubjectAfterWithdrawal`), leaving the cancelled
 *   row in the feed as history. This one needs no script at all;
 * - a **stranded subject** has no ordinary product path, and that is by design
 *   after F02: `pending_approval` / `in_review` are states the approval engine
 *   owns, so an edit may neither enter nor leave them (`contractStatusChangeError`
 *   refuses both ends) and `requestApproval` refuses a subject that is not a
 *   draft (`subject_not_requestable`). The remaining authorized path is the
 *   explicit, audited reconciliation below — `--apply` — which is precisely the
 *   "administrative reconciliation case, explicit and audited" the issue asks
 *   for instead of a form that silently substitutes for an approval.
 *
 * `buildApprovalReport` is therefore the safe half and writes nothing; running
 * it twice changes nothing. `npm run workspace:approvals` is the CLI
 * (`scripts/workspace-approval-report.ts`); the integration test calls the
 * functions directly against a disposable database.
 *
 * ## The authorized remediation half
 *
 * `applyApprovalRepairs` performs exactly the two repairs the report describes,
 * and only those, passing the *reviewed report* back in so what is fixed is what
 * the operator saw:
 *
 * - a duplicate live request becomes `cancelled` with a note saying why, and the
 *   newest one stays pending — the same choice migration 0258 makes for the rows
 *   that already existed when it ran, so the two can never disagree;
 * - a stranded subject returns to `draft` — the state it was in before the
 *   request that is no longer there — using the very predicates the service uses
 *   (`contractStatusAfterApprovalWithdrawn`, `documentStatusAfterApprovalWithdrawn`),
 *   so the script cannot drift from `decideApproval`'s own revert.
 *
 * It never approves anything, never activates a contract, and never deletes a
 * row: every repaired subject keeps its history and gains a `workspace_activity`
 * entry naming the reconciliation. It is off unless `--apply` is passed, because
 * it changes business data and the issue requires the operator's explicit
 * authorization for that.
 */
import type { Client } from "pg";
import {
  contractStatusAfterApprovalWithdrawn,
  documentStatusAfterApprovalWithdrawn,
  type WorkspaceContractStatus,
  type WorkspaceDocumentStatus,
} from "./workspace-shared";

export interface DuplicateGroup {
  businessId: string;
  subjectType: string;
  subjectId: string;
  subjectTitle: string;
  pending: Array<{
    approvalId: string;
    title: string;
    requestedByName: string;
    createdAt: string;
    /** The row the policy keeps; the others are the duplicates to cancel. */
    keeps: boolean;
  }>;
}

export interface OrphanSubject {
  businessId: string;
  subjectType: "contract" | "document";
  subjectId: string;
  title: string;
  status: string;
  /** Human instruction for the authorized remediation, printed with the finding. */
  remediation: string;
}

export interface ApprovalReport {
  duplicateRequests: DuplicateGroup[];
  orphanSubjects: OrphanSubject[];
}

// The remediation text is what the operator reads next to the finding, so it
// names the command that exists rather than an edit the F02 gate refuses.
const REMEDIATION_CONTRACT =
  "بازسازی صریح و ثبت‌شده: npm run workspace:approvals -- --business=<uuid> --apply " +
  "(ویرایش معمولی نمی‌تواند وضعیت «در انتظار تأیید» را تغییر دهد).";
const REMEDIATION_DOCUMENT =
  "بازسازی صریح و ثبت‌شده: npm run workspace:approvals -- --business=<uuid> --apply " +
  "(ویرایش معمولی نمی‌تواند وضعیت «در حال بررسی» را تغییر دهد).";

/**
 * The report itself. Exported so the integration test can call it against the
 * database it built instead of shelling out and re-parsing a subprocess.
 *
 * The caller owns the tenancy scope: `main` reads with the RLS bypass (a
 * maintenance tool asked for every tenant or one named tenant), the integration
 * test calls it inside `withTenant`. Passing `businessId` narrows the SQL as
 * well, so a scoped call cannot report another tenant's rows even if the scope
 * around it is wider than intended.
 */
export async function buildApprovalReport(
  client: Client,
  businessId: string | null,
): Promise<ApprovalReport> {
  // One parameter, or none: the SQL shape is fixed at build time so a tenant
  // filter can never be dropped by an interpolated alias.
  const params = businessId ? [businessId] : [];
  const approvalScope = businessId ? "AND a.business_id = $1::uuid" : "";
  const contractScope = businessId ? "AND c.business_id = $1::uuid" : "";
  const documentScope = businessId ? "AND d.business_id = $1::uuid" : "";

  // Grouped first so a clean tenant costs two queries rather than one per
  // contract: the interesting rows are rare, the register is not.
  const keys = await client.query<{ business_id: string; subject_type: string; subject_id: string }>(
    `SELECT a.business_id, a.subject_type, a.subject_id
       FROM workspace_approvals a
      WHERE a.status = 'pending' ${approvalScope}
      GROUP BY a.business_id, a.subject_type, a.subject_id
     HAVING count(*) > 1
      ORDER BY a.business_id, a.subject_type, a.subject_id`,
    params,
  );

  const duplicateRequests: DuplicateGroup[] = [];
  for (const key of keys.rows) {
    const rows = await client.query<{
      id: string;
      title: string;
      requested_by_name: string;
      created_at: Date;
    }>(
      `SELECT a.id, a.title, coalesce(u.full_name, '') AS requested_by_name, a.created_at
         FROM workspace_approvals a
         LEFT JOIN users u ON u.id = a.requested_by AND u.business_id = a.business_id
        WHERE a.business_id = $1 AND a.subject_type = $2 AND a.subject_id = $3
          AND a.status = 'pending'
        ORDER BY a.created_at DESC, a.id DESC`,
      [key.business_id, key.subject_type, key.subject_id],
    );
    const title = await subjectTitle(client, key.business_id, key.subject_type, key.subject_id);
    duplicateRequests.push({
      businessId: key.business_id,
      subjectType: key.subject_type,
      subjectId: key.subject_id,
      subjectTitle: title,
      // Newest first; the head of the list is the one the policy keeps, which is
      // the same choice migration 0258 makes, so the report and the migration
      // cannot disagree about which request is «the» one.
      pending: rows.rows.map((row, index) => ({
        approvalId: row.id,
        title: row.title,
        requestedByName: row.requested_by_name,
        createdAt: row.created_at.toISOString(),
        keeps: index === 0,
      })),
    });
  }

  const contracts = await client.query<{ business_id: string; id: string; title: string; status: string }>(
    `SELECT c.business_id, c.id, c.title, c.status
       FROM workspace_contracts c
      WHERE c.status = 'pending_approval' ${contractScope}
        AND NOT EXISTS (
          SELECT 1 FROM workspace_approvals a
           WHERE a.business_id = c.business_id AND a.subject_type = 'contract'
             AND a.subject_id = c.id AND a.status = 'pending')
      ORDER BY c.business_id, c.id`,
    params,
  );

  const documents = await client.query<{ business_id: string; id: string; title: string; status: string }>(
    `SELECT d.business_id, d.id, d.title, d.status
       FROM workspace_documents d
      WHERE d.status = 'in_review' ${documentScope}
        AND NOT EXISTS (
          SELECT 1 FROM workspace_approvals a
           WHERE a.business_id = d.business_id AND a.subject_type = 'document'
             AND a.subject_id = d.id AND a.status = 'pending')
      ORDER BY d.business_id, d.id`,
    params,
  );

  const orphanSubjects: OrphanSubject[] = [
    ...contracts.rows.map((row) => ({
      businessId: row.business_id,
      subjectType: "contract" as const,
      subjectId: row.id,
      title: row.title,
      status: row.status,
      remediation: REMEDIATION_CONTRACT,
    })),
    ...documents.rows.map((row) => ({
      businessId: row.business_id,
      subjectType: "document" as const,
      subjectId: row.id,
      title: row.title,
      status: row.status,
      remediation: REMEDIATION_DOCUMENT,
    })),
  ];

  return { duplicateRequests, orphanSubjects };
}

/** The subject's own title, so the report names what the operator will open. */
async function subjectTitle(
  client: Client,
  businessId: string,
  subjectType: string,
  subjectId: string,
): Promise<string> {
  const table = subjectType === "contract"
    ? "workspace_contracts"
    : subjectType === "document"
      ? "workspace_documents"
      : null;
  if (!table) return "";
  const { rows } = await client.query<{ title: string }>(
    `SELECT title FROM ${table} WHERE id = $1 AND business_id = $2`,
    [subjectId, businessId],
  );
  return rows[0]?.title ?? "";
}

export interface RepairOutcome {
  /** Approval rows moved to `cancelled`, with the note they were given. */
  cancelled: Array<{ approvalId: string; subjectType: string; subjectId: string; note: string }>;
  /** Subjects returned to `draft`, with the activity row that records it. */
  reverted: Array<{ subjectType: "contract" | "document"; subjectId: string; title: string }>;
  /** Rows that changed between the report and the write, and were left alone. */
  skipped: Array<{ subjectType: string; subjectId: string; reason: string }>;
}

const DUPLICATE_NOTE =
  "لغو خودکار درخواست تکراری هنگام یکتاسازی درخواست‌های در انتظار (issue #907 / F03).";
const ACTIVITY_SUMMARY = (title: string) =>
  `«${title}» از وضعیت در انتظار تأییدِ بدون درخواست به پیش‌نویس بازگشت (بازسازی حساب‌شده، #907).`;

/**
 * Applies the repairs a reviewed report named. Takes the report itself, not a
 * fresh query, so the operator's authorization covers the rows they were shown —
 * and re-checks each one as it writes, because a decision may have landed in
 * between (that subject is then `skipped`, not forced).
 */
export async function applyApprovalRepairs(
  client: Client,
  report: ApprovalReport,
  options: { businessId?: string | null } = {},
): Promise<RepairOutcome> {
  const outcome: RepairOutcome = { cancelled: [], reverted: [], skipped: [] };
  if (report.duplicateRequests.length === 0 && report.orphanSubjects.length === 0) return outcome;

  await client.query("BEGIN");
  try {
    for (const group of report.duplicateRequests) {
      for (const request of group.pending) {
        if (request.keeps) continue;
        const { rowCount } = await client.query(
          `UPDATE workspace_approvals
              SET status = 'cancelled',
                  note = CASE WHEN note = '' THEN $3 ELSE note || E'\\n' || $3 END,
                  updated_at = now()
            WHERE id = $1 AND business_id = $2 AND status = 'pending'`,
          [request.approvalId, group.businessId, DUPLICATE_NOTE],
        );
        if (!rowCount) {
          outcome.skipped.push({
            subjectType: group.subjectType,
            subjectId: group.subjectId,
            reason: "already decided between the report and the repair",
          });
          continue;
        }
        outcome.cancelled.push({
          approvalId: request.approvalId,
          subjectType: group.subjectType,
          subjectId: group.subjectId,
          note: DUPLICATE_NOTE,
        });
      }
    }

    for (const orphan of report.orphanSubjects) {
      const table = orphan.subjectType === "contract" ? "workspace_contracts" : "workspace_documents";
      const target = orphan.subjectType === "contract"
        ? contractStatusAfterApprovalWithdrawn(orphan.status as WorkspaceContractStatus)
        : documentStatusAfterApprovalWithdrawn(orphan.status as WorkspaceDocumentStatus);
      if (!target) {
        outcome.skipped.push({
          subjectType: orphan.subjectType,
          subjectId: orphan.subjectId,
          reason: `the service does not revert ${orphan.status}`,
        });
        continue;
      }
      // Conditional on both the status and the absence of a request, so a
      // request raised since the report is respected rather than overridden.
      const { rows } = await client.query<{ project_id: string | null }>(
        `UPDATE ${table} t
            SET status = $3, updated_at = now()
          WHERE t.id = $1 AND t.business_id = $2 AND t.status = $4
            AND NOT EXISTS (
              SELECT 1 FROM workspace_approvals a
               WHERE a.business_id = t.business_id AND a.subject_type = $5
                 AND a.subject_id = t.id AND a.status = 'pending')
          RETURNING t.project_id`,
        [orphan.subjectId, orphan.businessId, target, orphan.status, orphan.subjectType],
      );
      if (!rows[0]) {
        outcome.skipped.push({
          subjectType: orphan.subjectType,
          subjectId: orphan.subjectId,
          reason: "a request appeared (or the status moved) between the report and the repair",
        });
        continue;
      }
      await client.query(
        `INSERT INTO workspace_activity
           (business_id, project_id, subject_type, subject_id, action, summary, actor_id, actor_name)
         VALUES ($1, $2, $3, $4, 'approval_reconciled', $5, NULL, $6)`,
        [orphan.businessId, rows[0].project_id, orphan.subjectType, orphan.subjectId,
          ACTIVITY_SUMMARY(orphan.title), "reconciliation"],
      );
      outcome.reverted.push({
        subjectType: orphan.subjectType,
        subjectId: orphan.subjectId,
        title: orphan.title,
      });
    }

    await client.query("COMMIT");
    return outcome;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
