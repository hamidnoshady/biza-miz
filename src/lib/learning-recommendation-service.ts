/**
 * Contextual learning recommendations — the server half (issue #972, Phase F).
 *
 * Nothing here calls a model: the recommendation is a deterministic ranking of
 * the tours and paths this member is actually eligible for, computed from the
 * same server rules as the member lookup. A short in-memory TTL keeps it off
 * every page render; the assistant can call the same function as a tool, so a
 * conversational answer and the Learning Center never disagree.
 */
import { knowledgePageForPathname, KNOWLEDGE_PAGES } from "./knowledge-base";
import { LEARNING_PATHS, completedTourStepIds, learningPathProgressView, pathsForViewer } from "./learning-paths";
import { loadLearningPathProgress, learningPathViewerFor } from "./learning-paths-service";
import {
  rankLearningRecommendations,
  type LearningCandidate,
  type LearningRecommendation,
} from "./learning-recommendations";
import { pageTourCandidates, tourDefinitionById } from "./tour-baseline";
import { publishedTours } from "./tour-studio-service";
import { tourForViewer, tourProgressView } from "./tours";
import { loadTourProgress, tourViewerFor } from "./tours-service";

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: LearningRecommendation[] }>();

export interface RecommendationInput {
  businessId: string;
  userId: string;
  permissions: ReadonlySet<string>;
  /** Current pathname, when the caller knows it (the assistant does). */
  route?: string | null;
}

export async function learningRecommendationsFor({
  businessId,
  userId,
  permissions,
  route,
}: RecommendationInput): Promise<LearningRecommendation[]> {
  const page = route ? knowledgePageForPathname(route) : undefined;
  // A permission change must invalidate the feed: two members with the same id
  // cannot happen, but a role edit within the TTL can.
  const permissionKey = [...permissions].sort().join(",");
  const cacheKey = `${businessId}:${userId}:${page?.key ?? ""}:${permissionKey}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  // Only the current page and the curated paths are scanned: a recommendation
  // feed does not need the whole 100-page catalogue, and keeping it narrow is
  // what makes the cache cheap.
  const published = await publishedTours().catch(() => []);
  const publishedForPage = page
    ? published.filter((tour) => tour.pageKey === page.key)
    : [];
  const pageTourCandidatesList = page
    ? pageTourCandidates(page.key, publishedForPage)
    : [];

  const paths = pathsForViewer(
    LEARNING_PATHS,
    await learningPathViewerFor(businessId, permissions, LEARNING_PATHS),
  );

  // Tours named by the paths' `tour` steps, so a path that has not been opened
  // can still suggest its first real lesson.
  const pathTourIds = [
    ...new Set(
      paths.flatMap((path) =>
        path.steps.filter((step) => step.kind === "tour").map((step) => step.target),
      ),
    ),
  ];
  const pathTours = pathTourIds.flatMap((id) => {
    const tour = tourDefinitionById(id, published);
    return tour ? [tour] : [];
  });

  const candidatesForViewer = [...pageTourCandidatesList, ...pathTours];
  const viewer = await tourViewerFor(businessId, permissions, candidatesForViewer);
  const visibleTours = candidatesForViewer.flatMap((tour) => {
    const visible = tourForViewer(tour, viewer);
    return visible ? [visible] : [];
  });
  const uniqueTours = [...new Map(visibleTours.map((tour) => [tour.id, tour])).values()];

  const tourProgress = await loadTourProgress(
    businessId,
    userId,
    uniqueTours.map((tour) => tour.id),
  );
  const pathProgress = await loadLearningPathProgress(
    businessId,
    userId,
    paths.map((path) => path.id),
  );

  const completedTourIds = new Set(
    uniqueTours
      .filter(
        (tour) => tourProgressView(tour, tourProgress.get(tour.id) ?? null).status === "completed",
      )
      .map((tour) => tour.id),
  );

  const candidates: LearningCandidate[] = [
    ...uniqueTours.map((tour) => {
      const view = tourProgressView(tour, tourProgress.get(tour.id) ?? null);
      const home = KNOWLEDGE_PAGES.find(
        (entry) => entry.key === tour.pageKey || entry.route === tour.route,
      );
      return {
        kind: "tour" as const,
        id: tour.id,
        title: tour.title,
        route: tour.route,
        pageKey: home?.key,
        status: view.status,
        percent: view.percent,
        stepCount: tour.steps.length,
      };
    }),
    ...paths.map((path) => {
      const view = learningPathProgressView(
        path,
        pathProgress.get(path.id) ?? null,
        completedTourStepIds(path, completedTourIds),
      );
      return {
        kind: "path" as const,
        id: path.id,
        title: path.title,
        route: "/knowledge/learning",
        status: view.status,
        percent: view.percent,
        stepCount: path.steps.length,
        starter: path.id === "cafe.first-day" || path.id === "retail.first-sale",
      };
    }),
  ];

  const value = rankLearningRecommendations(candidates, {
    currentPageKey: page?.key ?? null,
  });
  if (cache.size > 1000) cache.clear();
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

/** Test/request boundary: forget one member's cached feed. */
export function clearLearningRecommendationCache(): void {
  cache.clear();
}
