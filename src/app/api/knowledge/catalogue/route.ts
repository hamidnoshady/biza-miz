import { NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { listKbCatalogue } from "@/lib/knowledge-service";

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
  const { error } = await requireMember();
  if (error) return error;

  const catalogue = await listKbCatalogue();
  return NextResponse.json(catalogue);
});
