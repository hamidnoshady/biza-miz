import { describe, expect, it } from "vitest";
import { rankLearningRecommendations, type LearningCandidate } from "./learning-recommendations";

const candidate = (overrides: Partial<LearningCandidate>): LearningCandidate => ({
  kind: "tour",
  id: "tour.a",
  title: "تور",
  route: "/accounting/products",
  status: "not_started",
  percent: 0,
  stepCount: 3,
  ...overrides,
});

describe("learning recommendations", () => {
  it("prefers what is on the current page, then what is already started", () => {
    const ranked = rankLearningRecommendations(
      [
        candidate({ id: "elsewhere", pageKey: "page:/crm/overview", percent: 80, status: "in_progress" }),
        candidate({ id: "here", pageKey: "page:/accounting/products" }),
        candidate({ id: "started", percent: 40, status: "in_progress" }),
      ],
      { currentPageKey: "page:/accounting/products" },
    );
    expect(ranked.map((item) => item.id)).toEqual(["here", "elsewhere", "started"]);
    expect(ranked[0].reason).toContain("همین صفحه");
  });

  it("never recommends completed or empty content, and never duplicates", () => {
    const ranked = rankLearningRecommendations([
      candidate({ id: "done", status: "completed" }),
      candidate({ id: "empty", stepCount: 0 }),
      candidate({ id: "dup" }),
      candidate({ id: "dup" }),
    ]);
    expect(ranked.map((item) => item.id)).toEqual(["dup"]);
  });

  it("caps the list and can include a starter path", () => {
    const ranked = rankLearningRecommendations(
      [
        candidate({ id: "path", kind: "path", starter: true, route: "/knowledge/learning" }),
        ...Array.from({ length: 5 }, (_, index) =>
          candidate({ id: `tour-${index}`, percent: index * 10, status: "in_progress" }),
        ),
      ],
      { limit: 3 },
    );
    expect(ranked).toHaveLength(3);
    expect(new Set(ranked.map((item) => `${item.kind}:${item.id}`)).size).toBe(3);

    const pathOnly = rankLearningRecommendations([
      candidate({ id: "path", kind: "path", starter: true, route: "/knowledge/learning" }),
    ]);
    expect(pathOnly[0]).toMatchObject({ kind: "path", id: "path" });
  });
});
