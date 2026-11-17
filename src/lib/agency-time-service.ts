import { query, withTenantTransaction } from "./db";
import {
  requireProjectCapability,
  WorkspaceError,
  type WorkspaceOwner,
} from "./workspace";
import { roleCan } from "./workspace-shared";
import { assertAgencyIndustry } from "./agency-commercial-service";
import { businessToday } from "./business-day-service";
import {
  AgencyTimeError,
  readAgencyTime,
  type AgencyTimeInput,
} from "./agency-time";

export interface AgencyTimeRow extends AgencyTimeInput {
  id: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  taskTitle: string;
  superseded: boolean;
}
export async function listAgencyTime(owner: WorkspaceOwner, projectId: string) {
  await assertAgencyIndustry(owner.businessId);
  return withTenantTransaction(owner.businessId, async () => {
    const role = await requireProjectCapability(owner, projectId, "view");
    const snapshot = (
      await query<{ rows: AgencyTimeRow[]; total_minutes: string | null }>(
        `WITH scoped AS MATERIALIZED (
      SELECT r.id,r.task_id AS "taskId",r.work_date::text AS "workDate",r.minutes,r.note,
      r.supersedes_id AS "supersedesId",r.request_id AS "requestId",r.created_by AS "createdBy",r.created_by_name AS "createdByName",
      r.created_at AS "createdAt",r.task_title AS "taskTitle",EXISTS(SELECT 1 FROM agency_task_time n WHERE n.supersedes_id=r.id) AS superseded
      FROM agency_task_time r WHERE r.business_id=$1 AND r.project_id=$2)
      SELECT COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."createdAt" DESC,p.id DESC)
        FROM (SELECT * FROM scoped ORDER BY "createdAt" DESC,id DESC LIMIT 100) p),'[]'::jsonb) AS rows,
      (SELECT sum(minutes)::text FROM scoped WHERE minutes>0 AND NOT superseded) AS total_minutes`,
        [owner.businessId, projectId],
      )
    ).rows[0];
    const tasks = await query<{ id: string; title: string }>(
      `SELECT t.id,t.title FROM ai_project_tasks t JOIN ai_projects p ON p.id=t.project_id
      WHERE p.business_id=$1 AND p.id=$2 ORDER BY t.created_at DESC,t.id LIMIT 200`,
      [owner.businessId, projectId],
    );
    return {
      rows: snapshot.rows,
      totalMinutes: snapshot.total_minutes,
      tasks: tasks.rows,
      canContribute: roleCan(role, "contribute"),
      actorUserId: owner.actorUserId,
    };
  });
}
export async function createAgencyTime(
  owner: WorkspaceOwner,
  projectId: string,
  input: Record<string, unknown>,
) {
  const data = readAgencyTime(input);
  await assertAgencyIndustry(owner.businessId);
  return withTenantTransaction(owner.businessId, async () => {
    const role = await requireProjectCapability(owner, projectId, "contribute");
    if (data.workDate > (await businessToday(owner.businessId)))
      throw new AgencyTimeError("invalid_time");
    await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      owner.businessId + owner.actorUserId + data.workDate,
    ]);
    const existing = (
      await query<{
        id: string;
        task_id: string;
        work_date: string;
        minutes: number;
        note: string;
        supersedes_id: string | null;
        project_id: string;
      }>(
        `SELECT id,task_id,work_date::text,minutes,note,supersedes_id,project_id FROM agency_task_time
      WHERE business_id=$1 AND created_by=$2 AND request_id=$3`,
        [owner.businessId, owner.actorUserId, data.requestId],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.project_id !== projectId ||
        existing.task_id !== data.taskId ||
        existing.work_date !== data.workDate ||
        existing.minutes !== data.minutes ||
        existing.note !== data.note ||
        existing.supersedes_id !== data.supersedesId
      )
        throw new AgencyTimeError("time_conflict");
      return { id: existing.id };
    }
    const task = (
      await query<{ assignee_user_id: string | null }>(
        `SELECT t.assignee_user_id FROM ai_project_tasks t JOIN ai_projects p ON p.id=t.project_id
      WHERE t.id=$1 AND p.id=$2 AND p.business_id=$3 FOR SHARE OF t`,
        [data.taskId, projectId, owner.businessId],
      )
    ).rows[0];
    if (!task) throw new WorkspaceError("task_not_found");
    if (
      !data.supersedesId &&
      !roleCan(role, "edit") &&
      task.assignee_user_id !== owner.actorUserId
    )
      throw new AgencyTimeError("time_forbidden");
    if (
      data.supersedesId &&
      !(
        await query(
          `SELECT r.id FROM agency_task_time r WHERE r.id=$1 AND r.business_id=$2 AND r.project_id=$3 AND r.created_by=$4
      AND r.task_id=$5 AND r.work_date=$6::date AND r.minutes>0 AND NOT EXISTS(SELECT 1 FROM agency_task_time n WHERE n.supersedes_id=r.id)`,
          [
            data.supersedesId,
            owner.businessId,
            projectId,
            owner.actorUserId,
            data.taskId,
            data.workDate,
          ],
        )
      ).rows.length
    )
      throw new AgencyTimeError("time_conflict");
    try {
      return (
        await query<{ id: string }>(
          `INSERT INTO agency_task_time(business_id,project_id,task_id,work_date,minutes,note,supersedes_id,request_id,created_by,created_by_name,task_title)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'') RETURNING id`,
          [
            owner.businessId,
            projectId,
            data.taskId,
            data.workDate,
            data.minutes,
            data.note,
            data.supersedesId,
            data.requestId,
            owner.actorUserId,
            (owner.actorName ?? "").slice(0, 200),
          ],
        )
      ).rows[0];
    } catch (err) {
      if (["23514", "23505"].includes(String((err as { code?: string }).code)))
        throw new AgencyTimeError("time_conflict");
      throw err;
    }
  });
}
