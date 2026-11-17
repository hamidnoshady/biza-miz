import { query, withTenantTransaction } from "./db";
import { requireProjectCapability, type WorkspaceOwner } from "./workspace";
import { roleCan } from "./workspace-shared";
import { assertAgencyIndustry } from "./agency-commercial-service";
import { businessTimeZone } from "./business-day-service";
import {
  AgencyReservationError,
  readReservation,
  reservationWindow,
  type ReservationInput,
} from "./agency-reservation";
export interface ReservationRow extends ReservationInput {
  id: string;
  createdBy: string;
  createdByName: string;
  workerName: string;
  taskTitle: string;
  createdAt: string;
  superseded: boolean;
}
export async function listReservations(
  owner: WorkspaceOwner,
  projectId: string,
  window: ReturnType<typeof reservationWindow>,
) {
  await assertAgencyIndustry(owner.businessId);
  const checked = reservationWindow(
    new URLSearchParams({
      from: window.from,
      to: window.to,
      offset: String(window.offset),
    }),
  );
  return withTenantTransaction(owner.businessId, async () => {
    const role = await requireProjectCapability(owner, projectId, "view");
    const timeZone = await businessTimeZone(owner.businessId);
    const { rows } = await query<ReservationRow & Record<string, unknown>>(
      `SELECT r.id,r.task_id AS "taskId",r.worker_id AS "workerId",r.starts_at AS "startAt",r.ends_at AS "endAt",
   r.status,r.note,r.supersedes_id AS "supersedesId",r.request_id AS "requestId",r.created_by AS "createdBy",r.created_by_name AS "createdByName",
   r.worker_name AS "workerName",r.task_title AS "taskTitle",r.created_at AS "createdAt",
   EXISTS(SELECT 1 FROM agency_resource_reservations n WHERE n.business_id=$1 AND n.supersedes_id=r.id) AS superseded
   FROM agency_resource_reservations r WHERE r.business_id=$1 AND r.project_id=$2
   AND r.starts_at < (($4::date+1)::timestamp AT TIME ZONE $5)
   AND r.ends_at > ($3::date::timestamp AT TIME ZONE $5)
   ORDER BY r.starts_at,r.created_at,r.id LIMIT 101 OFFSET $6`,
      [
        owner.businessId,
        projectId,
        checked.from,
        checked.to,
        timeZone,
        checked.offset,
      ],
    );
    const tasks = (
      await query<{ id: string; title: string }>(
        `SELECT t.id,t.title FROM ai_project_tasks t JOIN ai_projects p ON p.id=t.project_id
   WHERE p.business_id=$1 AND p.id=$2 ORDER BY t.created_at DESC,t.id LIMIT 200`,
        [owner.businessId, projectId],
      )
    ).rows;
    const workers = (
      await query<{ id: string; name: string }>(
        `SELECT u.id,u.full_name AS name FROM users u JOIN workspace_members m ON m.user_id=u.id
   WHERE u.business_id=$1 AND m.project_id=$2 AND u.is_active AND m.role IN ('owner','manager','editor','contributor') ORDER BY u.full_name,u.id LIMIT 200`,
        [owner.businessId, projectId],
      )
    ).rows;
    return {
      rows: rows
        .slice(0, 100)
        .map((r) => ({
          ...r,
          startAt: new Date(r.startAt).toISOString(),
          endAt: new Date(r.endAt).toISOString(),
          createdAt: new Date(r.createdAt).toISOString(),
        })),
      nextOffset: rows.length > 100 ? checked.offset + 100 : null,
      timeZone,
      tasks,
      workers,
      canManage: roleCan(role, "manage"),
    };
  });
}
export async function createReservation(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
) {
  const data = readReservation(input);
  await assertAgencyIndustry(owner.businessId);
  return withTenantTransaction(owner.businessId, async () => {
    await requireProjectCapability(owner, projectId, "manage");
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      "agency-reservation:" + owner.businessId + data.workerId,
    ]);
    const existing = (
      await query<{
        id: string;
        project_id: string;
        task_id: string;
        worker_id: string;
        starts_at: Date;
        ends_at: Date;
        status: string;
        note: string;
        supersedes_id: string | null;
      }>(
        `SELECT id,project_id,task_id,worker_id,starts_at,ends_at,status,note,supersedes_id FROM agency_resource_reservations WHERE business_id=$1 AND created_by=$2 AND request_id=$3`,
        [owner.businessId, owner.actorUserId, data.requestId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.project_id !== projectId ||
        existing.task_id !== data.taskId ||
        existing.worker_id !== data.workerId ||
        new Date(existing.starts_at).toISOString() !== data.startAt ||
        new Date(existing.ends_at).toISOString() !== data.endAt ||
        existing.status !== data.status ||
        existing.note !== data.note ||
        existing.supersedes_id !== data.supersedesId
      )
        throw new AgencyReservationError("reservation_conflict");
      return { id: existing.id };
    }
    if (data.supersedesId) {
      const previous = (
        await query(
          `SELECT r.id FROM agency_resource_reservations r WHERE r.id=$1 AND r.business_id=$2 AND r.project_id=$3 AND r.task_id=$4 AND r.worker_id=$5
    AND r.status='reserved' AND NOT EXISTS(SELECT 1 FROM agency_resource_reservations n WHERE n.supersedes_id=r.id)`,
          [
            data.supersedesId,
            owner.businessId,
            projectId,
            data.taskId,
            data.workerId,
          ],
        )
      ).rows[0];
      if (!previous) throw new AgencyReservationError("reservation_conflict");
    }
    try {
      return (
        await query<{ id: string }>(
          `INSERT INTO agency_resource_reservations(business_id,project_id,task_id,worker_id,starts_at,ends_at,status,note,supersedes_id,request_id,created_by,created_by_name,worker_name,task_title)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'','') RETURNING id`,
          [
            owner.businessId,
            projectId,
            data.taskId,
            data.workerId,
            data.startAt,
            data.endAt,
            data.status,
            data.note,
            data.supersedesId,
            data.requestId,
            owner.actorUserId,
            (owner.actorName ?? "").slice(0, 200),
          ],
        )
      ).rows[0];
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err ? String(err.code) : "";
      if (["23514", "23505", "23503"].includes(code))
        throw new AgencyReservationError("reservation_conflict");
      throw err;
    }
  });
}
