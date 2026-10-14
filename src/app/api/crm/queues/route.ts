import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { crmQueues, queueKeysForSection, type CrmQueueKey } from "@/lib/crm-queues";

/**
 * Smart queues — «چه کسی به توجه نیاز دارد».
 *
 * `crm.view`, because every queue is a view over records the member could
 * already open one at a time: the queues *prioritise*, they do not disclose.
 * A queue that named a customer the reader is not allowed to see would be a
 * disclosure — which is why each row is a link into a section whose own gate
 * decides, rather than a copy of the record.
 *
 * `?section=` narrows the answer to the queues that section owns, so a section
 * screen can show its own outstanding work without recomputing all twelve. The
 * value is matched against the closed key list; an unknown section returns an
 * empty list rather than everything.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmView);
  if (error) return error;

  const section = request.nextUrl.searchParams.get("section");
  const queues = await crmQueues(session.businessId);
  if (!section) return NextResponse.json({ queues });

  const wanted = new Set<CrmQueueKey>(queueKeysForSection(section));
  return NextResponse.json({ queues: queues.filter((queue) => wanted.has(queue.key)) });
});
