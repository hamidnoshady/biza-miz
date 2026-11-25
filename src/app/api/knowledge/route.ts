import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { knowledgePage, knowledgeSection } from "@/lib/knowledge-base";
import {
  kbGuideBodyForSection,
  kbGuideForSection,
  kbRelatedGuidesForArticle,
} from "@/lib/knowledge-service";
import { extractGuideStepLines } from "@/lib/kb-step-excerpt";
import { setupStepHelp, setupStepPageKey } from "@/lib/setup-wizard-help";
import type { WizardStep } from "@/lib/wizard-steps";
import { isWorkspaceKnowledgeSection } from "@/lib/workspace-eligibility";
import { workspaceAccessFor } from "@/lib/workspace-access";

/**
 * The member-facing side of the knowledge base (migration 0117). A page's
 * «آموزش» icon asks here for its section's learning page; the response is the
 * URL of the active entry, or `entry: null` when the super-admin has not
 * published one yet (the modal then says so instead of failing).
 *
 * `knowledge_base_entries` is a platform catalogue — no business_id, the same
 * shape as `feature_flags` — so the read needs no tenant scope of its own;
 * `withTenantScope` only establishes the request's boundary the way every
 * other member route does. Any signed-in member may read: learning the
 * screen you are on is not a privilege, and the catalogue carries no
 * business data.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, membership, error } = await requireMember();
  if (error) return error;

  const section = (request.nextUrl.searchParams.get("section") ?? "").trim();
  const known = knowledgeSection(section);
  // Page keys are selected only from the server-owned registry, never treated
  // as arbitrary client-provided destinations. A new page can have no legacy
  // section at all (for example a CRM subpage).
  const page = knowledgePage(request.nextUrl.searchParams.get("page") ?? "");
  if (!known && !page) {
    return NextResponse.json({ error: "unknown_section" }, { status: 400 });
  }

  // Issue #1110 — no My Workspace guide or link for a business without it.
  const workspaceUnavailable = !(await workspaceAccessFor(
    session.businessId,
    membership.permissions,
  )).available;
  if (
    workspaceUnavailable &&
    (known?.key === "projects" ||
      (page && isWorkspaceKnowledgeSection(page.key)))
  ) {
    return NextResponse.json({ entry: null, guide: null, relatedGuides: [] });
  }

  const { rows } = known
    ? await query<{ section: string; url: string; is_active: boolean }>(
        "SELECT section, url, is_active FROM knowledge_base_entries WHERE section = $1 AND is_active = true",
        [known.key],
      )
    : { rows: [] as { section: string; url: string; is_active: boolean }[] };
  const entry = rows[0];

  // Migration 0131 — alongside the optional external page, the in-product
  // guide that teaches this section (a published article claiming the section
  // key). The «آموزش» modal links «مرکز آموزش» so a member can read the
  // built-in, Persian, fully-anchored guide without leaving the app.
  const guide =
    (page ? await kbGuideForSection(page.key) : null) ??
    (known ? await kbGuideForSection(known.key) : null);
  // Related guides are optional: a catalogue read failure must not break the
  // primary article, the tour, or the legacy external-learning link.
  const relatedGuides = guide
    ? await kbRelatedGuidesForArticle(guide.slug).catch(() => [])
    : [];
  const visibleRelated = workspaceUnavailable
    ? relatedGuides.filter(
        (related) => !related.sectionKeys.some(isWorkspaceKnowledgeSection),
      )
    : relatedGuides;

  // Issue #1239 / ESH-90 — the wizard step's inline help. Only a *known* step
  // id is accepted, and only when it names the `/setup` page the caller asked
  // for: the marker comes from our own registry, never from the query string.
  // A missing article (or an unpublished category) leaves this null, and the
  // step keeps its local fallback — that is the offline behaviour.
  const requestedStep = (request.nextUrl.searchParams.get("step") ?? "").trim();
  const stepPageKey = requestedStep ? setupStepPageKey(requestedStep) : null;
  const inlineHelp =
    page && stepPageKey && page.key === stepPageKey
      ? await inlineStepHelp(requestedStep as WizardStep)
      : null;

  return NextResponse.json({
    entry: entry ? { section: entry.section, label: known?.label ?? page?.label ?? "", url: entry.url } : null,
    guide,
    relatedGuides: visibleRelated,
    inlineHelp,
  });
});

/**
 * The published excerpt for one wizard step, or null.
 *
 * Reads the article attached to the `setup` section (the wizard's one guide),
 * then selects the paragraph whose bold heading is the step's marker. A read
 * failure is null rather than a 500: the step's own fallback copy is enough to
 * keep the owner moving.
 */
async function inlineStepHelp(
  step: WizardStep,
): Promise<{ guide: { slug: string; title: string }; lines: string[] } | null> {
  try {
    const article = await kbGuideBodyForSection("setup");
    if (!article) return null;
    const lines = extractGuideStepLines(article.bodyMarkdown, setupStepHelp(step).marker);
    if (lines.length === 0) return null;
    return { guide: { slug: article.slug, title: article.title }, lines };
  } catch {
    return null;
  }
}
