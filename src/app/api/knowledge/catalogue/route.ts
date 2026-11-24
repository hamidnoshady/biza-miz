import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listKbCatalogue } from "@/lib/knowledge-service";
import { workspaceAccessFor } from "@/lib/workspace-access";
import { WORKSPACE_KNOWLEDGE_SECTION_KEYS } from "@/lib/workspace-eligibility";

/**
 * The knowledge centre's full catalogue (migration 0131): active categories —
 * flat, ordered, so the member side menu nests them client-side — with every
 * published article and the tags actually in use. One payload the whole
 * /knowledge shell renders from: side menu, category cards, tag
 * chips, latest list.
 *
 * Platform catalogue: no business data, the same published content for every
 * member of every business — hence requireMember only, and the api-guards
 * test whitelists it from the session.sub sweep just like /api/knowledge.
 */
export const GET = withTenantScope(async () => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const catalogue = await listKbCatalogue();
  // Issue #1110 — My Workspace guides are not offered to a business that does
  // not have the feature. The catalogue is platform-wide, so the filter is per
  // request from trusted tenant context.
  const workspaceUnavailable = !(await workspaceAccessFor(
    session.businessId,
    membership.permissions,
  )).available;
  if (!workspaceUnavailable) return NextResponse.json(catalogue);
  const hidden = new Set<string>(WORKSPACE_KNOWLEDGE_SECTION_KEYS);
  return NextResponse.json({
    ...catalogue,
    articles: catalogue.articles.filter(
      (article) => !article.sectionKeys.some((key) => hidden.has(key)),
    ),
  });
});
