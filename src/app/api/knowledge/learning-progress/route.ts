import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { KNOWLEDGE_PAGES } from "@/lib/knowledge-base";
import { pageTourCandidates } from "@/lib/tour-baseline";
import { publishedToursForPage } from "@/lib/tour-studio-service";
import { loadTourProgress, tourViewerFor } from "@/lib/tours-service";
import { tourForViewer, tourProgressView } from "@/lib/tours";
import { loadLearningPathProgress, learningPathViewerFor } from "@/lib/learning-paths-service";
import { pathsForViewer, learningPathSummary } from "@/lib/learning-paths";
import type { TourDefinition } from "@/lib/tours";

/** Map route prefixes to the four apps plus platform-owned surfaces. */
const APP_BY_ROUTE_PREFIX: Record<string, { key: string; label: string }> = {
  "/accounting": { key: "accounting", label: "حسابداری" },
  "/crm": { key: "crm", label: "ارتباط با مشتری (CRM)" },
  "/growth": { key: "growth", label: "رشد و بازاریابی" },
  "/websites": { key: "websites", label: "وب‌سایت و بیزامیز CMS" },
  "/settings": { key: "settings", label: "تنظیمات پلتفرم" },
  "/workspace": { key: "workspace", label: "میز کار من" },
};

function appKeyForRoute(route: string): string | null {
  for (const prefix of Object.keys(APP_BY_ROUTE_PREFIX)) {
    if (route.startsWith(prefix)) return APP_BY_ROUTE_PREFIX[prefix].key;
  }
  return null;
}

function appInfoForKey(key: string): { key: string; label: string } | null {
  for (const info of Object.values(APP_BY_ROUTE_PREFIX)) {
    if (info.key === key) return info;
  }
  return null;
}

/** One page's learning state. */
interface PageProgress {
  pageKey: string;
  route: string;
  label: string;
  group: string;
  appKey: string | null;
  tours: Array<{
    id: string;
    title: string;
    status: "not_started" | "in_progress" | "completed";
    percent: number;
    resumeStepId: string | null;
    outdated: boolean;
  }>;
  paths: Array<{
    id: string;
    title: string;
    status: "not_started" | "in_progress" | "completed";
    percent: number;
    resumeStepId: string | null;
  }>;
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const guard = await requireMember();
  if (guard.error) return guard.error;

  const businessId = guard.session.businessId;
  const userId = guard.session.sub;
  const permissions = guard.membership.permissions;

  // ------------------------------------------------------------------
  // 1. Gather every tour the member could be offered across all pages.
  // ------------------------------------------------------------------
  const allCandidates: Array<{ pageKey: string; tour: TourDefinition }> = [];
  for (const page of KNOWLEDGE_PAGES) {
    try {
      const published = await publishedToursForPage(page.key).catch(() => []);
      const candidates = pageTourCandidates(page.key, published);
      for (const tour of candidates) {
        allCandidates.push({ pageKey: page.key, tour });
      }
    } catch {
      // A single page's lookup failure must not break the whole report.
    }
  }

  // 2. Build the viewer once — feature flags and costing system are read
  //    only if some tour on some page actually asks about them.
  const viewer = await tourViewerFor(businessId, permissions, allCandidates.map((c) => c.tour));

  // 3. Narrow to what this member may see, collect tour IDs.
  const eligibleTours: Array<{ pageKey: string; tour: TourDefinition }> = [];
  for (const { pageKey, tour } of allCandidates) {
    const visible = tourForViewer(tour, viewer);
    if (visible) eligibleTours.push({ pageKey, tour: visible });
  }

  const tourProgress = await loadTourProgress(
    businessId,
    userId,
    eligibleTours.map((t) => t.tour.id),
  );

  // ------------------------------------------------------------------
  // 4. Learning paths — same eligibility pattern.
  // ------------------------------------------------------------------
  const { LEARNING_PATHS } = await import("@/lib/learning-paths");
  const pathViewer = await learningPathViewerFor(businessId, permissions);
  const visiblePaths = pathsForViewer(LEARNING_PATHS, {
    permissions: pathViewer.permissions,
    industry: pathViewer.industry,
  });
  const pathProgress = await loadLearningPathProgress(
    businessId,
    userId,
    visiblePaths.map((p) => p.id),
  );

  // ------------------------------------------------------------------
  // 5. Build per-page progress.
  // ------------------------------------------------------------------
  const pageMap = new Map<string, PageProgress>();
  for (const page of KNOWLEDGE_PAGES) {
    const toursHere = eligibleTours.filter((t) => t.pageKey === page.key);
    const pathsHere = visiblePaths.filter((p) => p.group === page.group);

    const tourEntries = toursHere.map((t) => {
      const progress = tourProgress.get(t.tour.id) ?? null;
      const view = tourProgressView(t.tour, progress);
      return {
        id: t.tour.id,
        title: t.tour.title,
        status: view.status,
        percent: view.percent,
        resumeStepId: view.resumeStepId,
        outdated: view.outdated,
      };
    });

    const pathEntries = pathsHere.map((p) => {
      const progress = pathProgress.get(p.id) ?? null;
      const view = learningPathSummary(p, progress);
      return {
        id: p.id,
        title: p.title,
        status: view.progress.status,
        percent: view.progress.percent,
        resumeStepId: view.progress.resumeStepId,
      };
    });

    pageMap.set(page.key, {
      pageKey: page.key,
      route: page.route,
      label: page.label,
      group: page.group,
      appKey: appKeyForRoute(page.route),
      tours: tourEntries,
      paths: pathEntries,
    });
  }

  // ------------------------------------------------------------------
  // 6. Aggregate by section (group) and app (route prefix).
  // ------------------------------------------------------------------
  const sectionMap = new Map<string, {
    key: string;
    label: string;
    eligible: number;
    completed: number;
    pages: PageProgress[];
  }>();

  const appMap = new Map<string, {
    key: string;
    label: string;
    eligible: number;
    completed: number;
    sections: Map<string, {
      key: string;
      label: string;
      eligible: number;
      completed: number;
      pages: PageProgress[];
    }>;
  }>();

  for (const page of KNOWLEDGE_PAGES) {
    const pp = pageMap.get(page.key)!;
    const itemCount = pp.tours.length + pp.paths.length;
    const completedCount =
      pp.tours.filter((t) => t.status === "completed").length +
      pp.paths.filter((p) => p.status === "completed").length;

    // Section roll-up.
    let section = sectionMap.get(page.group);
    if (!section) {
      section = { key: page.group, label: page.group, eligible: 0, completed: 0, pages: [] };
      sectionMap.set(page.group, section);
    }
    section.eligible += itemCount;
    section.completed += completedCount;
    section.pages.push(pp);

    // App roll-up.
    const appKey = pp.appKey;
    if (!appKey) continue;
    let app = appMap.get(appKey);
    if (!app) {
      const info = appInfoForKey(appKey)!;
      app = { key: appKey, label: info.label, eligible: 0, completed: 0, sections: new Map() };
      appMap.set(appKey, app);
    }
    app.eligible += itemCount;
    app.completed += completedCount;

    let appSection = app.sections.get(page.group);
    if (!appSection) {
      appSection = { key: page.group, label: page.group, eligible: 0, completed: 0, pages: [] };
      app.sections.set(page.group, appSection);
    }
    appSection.eligible += itemCount;
    appSection.completed += completedCount;
    appSection.pages.push(pp);
  }

  const appOrder = ["accounting", "crm", "growth", "websites", "settings", "workspace"];
  const apps = appOrder
    .map((key) => appMap.get(key))
    .filter((app): app is { key: string; label: string; eligible: number; completed: number; sections: Map<string, { key: string; label: string; eligible: number; completed: number; pages: PageProgress[] }> } => !!app)
    .map((app) => {
      const sections = [...app.sections.values()].map((s) => ({
        key: s.key,
        label: s.label,
        eligible: s.eligible,
        completed: s.completed,
        percent: s.eligible === 0 ? 0 : Math.floor((s.completed / s.eligible) * 100),
        pages: s.pages,
      }));
      return {
        key: app.key,
        label: app.label,
        eligible: app.eligible,
        completed: app.completed,
        percent: app.eligible === 0 ? 0 : Math.floor((app.completed / app.eligible) * 100),
        sections,
      };
    })
    .concat(
      [...appMap.values()]
        .filter((app) => !appOrder.includes(app.key))
        .map((app) => ({
          key: app.key,
          label: app.label,
          eligible: app.eligible,
          completed: app.completed,
          percent: app.eligible === 0 ? 0 : Math.floor((app.completed / app.eligible) * 100),
          sections: [...app.sections.values()].map((s) => ({
            key: s.key,
            label: s.label,
            eligible: s.eligible,
            completed: s.completed,
            percent: s.eligible === 0 ? 0 : Math.floor((s.completed / s.eligible) * 100),
            pages: s.pages,
          })),
        })),
    );

  // ------------------------------------------------------------------
  // 7. Platform roll-up.
  // ------------------------------------------------------------------
  const allPages = KNOWLEDGE_PAGES.map((page) => pageMap.get(page.key)!);
  const platformEligible = allPages.reduce((sum, pp) => sum + pp.tours.length + pp.paths.length, 0);
  const platformCompleted = allPages.reduce(
    (sum, pp) =>
      sum +
      pp.tours.filter((t) => t.status === "completed").length +
      pp.paths.filter((p) => p.status === "completed").length,
    0,
  );
  const platformPercent = platformEligible === 0 ? 0 : Math.floor((platformCompleted / platformEligible) * 100);

  // ------------------------------------------------------------------
  // 8. Next lesson: first incomplete eligible item in page order.
  // ------------------------------------------------------------------
  let nextLesson:
    | { id: string; title: string; type: "tour" | "path"; route: string }
    | null = null;
  outer: for (const page of KNOWLEDGE_PAGES) {
    const pp = pageMap.get(page.key)!;
    for (const tour of pp.tours) {
      if (tour.status !== "completed") {
        nextLesson = { id: tour.id, title: tour.title, type: "tour", route: pp.route };
        break outer;
      }
    }
    for (const path of pp.paths) {
      if (path.status !== "completed") {
        nextLesson = { id: path.id, title: path.title, type: "path", route: pp.route };
        break outer;
      }
    }
  }

  // ------------------------------------------------------------------
  // 9. Resume last tour: incomplete item with the most recent activity.
  // ------------------------------------------------------------------
  let resumeLast:
    | {
        id: string;
        title: string;
        type: "tour" | "path";
        route: string;
        resumeStepId: string | null;
        lastActiveAt: string | null;
      }
    | null = null;
  let resumeLatestAt: Date | null = null;

  for (const page of KNOWLEDGE_PAGES) {
    const pp = pageMap.get(page.key)!;
    for (const tour of pp.tours) {
      if (tour.status === "completed") continue;
      const progress = tourProgress.get(tour.id) ?? null;
      if (!progress) continue;
      const lastAt = new Date(progress.lastActiveAt);
      if (!resumeLatestAt || lastAt > resumeLatestAt) {
        resumeLatestAt = lastAt;
        resumeLast = {
          id: tour.id,
          title: tour.title,
          type: "tour",
          route: pp.route,
          resumeStepId: tour.resumeStepId,
          lastActiveAt: progress.lastActiveAt,
        };
      }
    }
    for (const path of pp.paths) {
      if (path.status === "completed") continue;
      const progress = pathProgress.get(path.id) ?? null;
      if (!progress) continue;
      const lastAt = new Date(progress.lastActiveAt);
      if (!resumeLatestAt || lastAt > resumeLatestAt) {
        resumeLatestAt = lastAt;
        resumeLast = {
          id: path.id,
          title: path.title,
          type: "path",
          route: pp.route,
          resumeStepId: path.resumeStepId,
          lastActiveAt: progress.lastActiveAt,
        };
      }
    }
  }

  return NextResponse.json({
    platform: {
      eligible: platformEligible,
      completed: platformCompleted,
      percent: platformPercent,
    },
    apps,
    nextLesson,
    resumeLastTour: resumeLast,
  });
});
