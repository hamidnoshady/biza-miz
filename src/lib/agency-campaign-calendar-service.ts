import { query, withTenantTransaction } from "./db";
import { WORKSPACE_ROLES } from "./workspace-shared";
import type { ReportOwner } from "./agency-campaign-report-service";
import type { AgencyCampaignStatus } from "./agency-campaign";
import {
  readCampaignCalendarWindow,
  type CampaignCalendarWindow,
} from "./agency-campaign-calendar";

export interface CampaignCalendarEvent {
  id: string;
  number: string;
  title: string;
  partyName: string;
  projectId: string | null;
  start: string;
  end: string | null;
  status: AgencyCampaignStatus;
}
/** Filter authority BEFORE pagination; inaccessible project titles never reach callers.
 * Uses the same membership/override rules as Workspace view, with an independent
 * platform permission flag. Undated campaigns are not scheduled events.
 */
export async function listCampaignCalendar(
  owner: ReportOwner,
  window: CampaignCalendarWindow,
) {
  // Revalidate source calls, not only route input. Reject invalid dates and unsafe offsets.
  const checked = readCampaignCalendarWindow(
    new URLSearchParams({
      start: window.start,
      end: window.end,
      offset: String(window.offset),
      ...(window.partyId !== null ? { partyId: window.partyId } : {}),
    }),
  );
  return withTenantTransaction(owner.businessId, async () => {
    const { rows } = await query<
      CampaignCalendarEvent & Record<string, unknown>
    >(
      `SELECT c.id,c.campaign_number AS number,c.title,p.name AS "partyName",
      c.project_id AS "projectId",c.start_date::text AS start,c.end_date::text AS end,c.status
      FROM agency_client_campaigns c JOIN parties p ON p.id=c.party_id AND p.business_id=c.business_id
      WHERE c.business_id=$1 AND c.start_date <= $3::date AND (c.end_date IS NULL OR c.end_date >= $2::date)
      AND ($8::uuid IS NULL OR c.party_id=$8::uuid)
      AND (c.project_id IS NULL OR ($5::boolean AND EXISTS (
        SELECT 1 FROM ai_projects pj WHERE pj.id=c.project_id AND pj.business_id=$1
        AND ($6::boolean OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.project_id=pj.id
          AND m.user_id=$4::uuid AND m.role=ANY($7::text[]))))))
      ORDER BY c.start_date,c.id LIMIT 101 OFFSET $9`,
      [
        owner.businessId,
        checked.start,
        checked.end,
        owner.actorUserId,
        owner.workspaceAllowed,
        Boolean(owner.access?.override),
        WORKSPACE_ROLES,
        checked.partyId,
        checked.offset,
      ],
    );
    return {
      events: rows.slice(0, 100),
      nextOffset: rows.length > 100 ? checked.offset + 100 : null,
    };
  });
}
