import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { requireManager } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { isPlatformAiConfigured } from "@/lib/ai-config";
import { resolveAiConfigFor } from "@/lib/ai-runtime";
import { getAiKnowledgeStatus } from "@/lib/ai-knowledge-service";

/**
 * AI Knowledge — a read-only view of the business's retrieval index.
 *
 * A manager may read what the assistant can recall from their own stored text
 * (`ai_embeddings`): the per-kind breakdown, whether retrieval infra and the
 * embedding connection are available, and when the index was last refreshed.
 * It writes nothing; the manual reindex is a separate POST (`/api/ai/rag/reindex`).
 */
export const GET = withTenantScope(async () => {
  const guard = await requireManager(PERMISSIONS.aiKnowledgeManage);
  if (guard.error) return guard.error;

  const config = await resolveAiConfigFor(guard.session.businessId, null, { ensureVirtualKey: true });
  const aiConfigured = isPlatformAiConfigured(config);
  const status = await getAiKnowledgeStatus(guard.session.businessId, aiConfigured);
  return NextResponse.json({ status });
});
