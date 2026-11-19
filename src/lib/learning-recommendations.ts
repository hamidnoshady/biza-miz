/**
 * Contextual learning recommendations (issue #972, Phase F) — the pure half.
 *
 * The recommendation is a *ranking of things that already exist*: a published
 * or code tour, or a curated learning path. It never invents an id, never
 * describes an unavailable module, and never starts anything: the member
 * chooses from the list and the existing «آموزش» runtime starts it.
 *
 * The caller (server) has already applied eligibility and progress; this module
 * only decides what is worth showing first. Keeping it pure makes the rules
 * testable without a database or a model.
 */

export type LearningCandidateKind = "tour" | "path";

export interface LearningCandidate {
  kind: LearningCandidateKind;
  id: string;
  title: string;
  route: string;
  /** The Knowledge page a tour belongs to; paths have none. */
  pageKey?: string;
  status: "not_started" | "in_progress" | "completed";
  percent: number;
  stepCount: number;
  /** Part of the business's first-day/first-sale path for a new team. */
  starter?: boolean;
}

export interface LearningRecommendation {
  kind: LearningCandidateKind;
  id: string;
  title: string;
  route: string;
  percent: number;
  /** Why this one, in the member's language. */
  reason: string;
}

function score(candidate: LearningCandidate, currentPageKey: string | null): number {
  if (candidate.status === "completed") return -1;
  let value = 0;
  if (candidate.status === "in_progress") value += 40;
  if (currentPageKey && candidate.pageKey === currentPageKey) value += 50;
  if (candidate.starter) value += 15;
  if (candidate.kind === "path") value += 5;
  // Near the end of something already started is more motivating than a new
  // long path; the percentage is capped at 99 by the progress rules.
  value += Math.min(10, Math.floor(candidate.percent / 10));
  return value;
}

function reasonFor(candidate: LearningCandidate, currentPageKey: string | null): string {
  if (currentPageKey && candidate.pageKey === currentPageKey) {
    return "همین حالا در همین صفحه می‌توانید شروعش کنید.";
  }
  if (candidate.status === "in_progress") {
    return `نیمه‌کاره مانده — ${candidate.percent}٪ را دیده‌اید.`;
  }
  if (candidate.starter) return "نقطهٔ شروع پیشنهادی برای تیم تازه.";
  if (candidate.kind === "path") return "چند تور و راهنما را به یک هدف کاری وصل می‌کند.";
  return "قدم بعدی مناسب برای نقش شما.";
}

/**
 * Ranks candidates and drops completed ones, duplicates and anything with no
 * meaningful content. Deterministic: equal scores keep the caller's order.
 */
export function rankLearningRecommendations(
  candidates: readonly LearningCandidate[],
  options: { currentPageKey?: string | null; limit?: number } = {},
): LearningRecommendation[] {
  const currentPageKey = options.currentPageKey ?? null;
  const limit = Math.max(1, Math.min(10, options.limit ?? 3));
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      if (candidate.status === "completed" || candidate.stepCount === 0) return false;
      const key = `${candidate.kind}:${candidate.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((candidate) => ({
      candidate,
      score: score(candidate, currentPageKey),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ candidate }) => ({
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      route: candidate.route,
      percent: candidate.percent,
      reason: reasonFor(candidate, currentPageKey),
    }));
}
