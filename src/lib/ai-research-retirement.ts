/**
 * Issue #1367 — Deep Research retirement policy.
 *
 * Deep Research (`پژوهش عمیق`) was a separate, cost-approved, multi-round
 * workflow. It is **not** the `thinking` chat mode and is never remapped to it:
 * a historical run keeps its own mode, cost, findings and sources, and the
 * three everyday chat modes (Auto, Fast, Thinking) are untouched.
 *
 * This module is the one place the retirement is named, so the API routes, the
 * services, the tenant history panel and the tests all agree on the same stable
 * code and wording. It is framework-free (no `next`, no `db`, no environment
 * read) because the browser needs the error code and the message too.
 *
 * What retirement means, precisely:
 *
 *  - **New runs cannot be created.** `createResearchRun` refuses and every
 *    creation route answers `410 Gone` with `error: "research_retired"`. This
 *    is enforced on the server, not by hiding a button.
 *  - **Pending runs cannot be approved or executed.** The approval route and
 *    `runResearchRun` refuse before any provider call, so a direct API request
 *    cannot spend money.
 *  - **History stays readable.** The run rows, sourced findings and settlement
 *    rows are untouched.
 *  - **There is deliberately no runtime on/off switch.** A flag that re-opens a
 *    spending workflow is a spending bypass with a friendlier name. Rollback is
 *    a revert of this change: it carries no migration and no destructive data
 *    change, so reverting restores the previous behaviour with the existing
 *    rows intact. See `docs/architecture/deep-research-retirement.md`.
 */

/** The stable API error code for every retired Deep Research operation. */
export const RESEARCH_RETIRED_ERROR = "research_retired";

/** HTTP `410 Gone`: the functionality existed and is deliberately retired. */
export const RESEARCH_RETIRED_STATUS = 410;

/**
 * The single policy constant. It is a constant rather than an environment read
 * on purpose: the only way to un-retire is to ship code that says so, and the
 * three checks that depend on it (`createResearchRun`, `approveResearchRun`,
 * `runResearchRun`) are covered by tests that would fail if it flipped.
 *
 * Typed as `boolean` rather than the literal `true` so the guarded code below
 * each check stays ordinary, type-checked code rather than being narrowed away
 * as statically unreachable.
 */
export const RESEARCH_EXECUTION_RETIRED: boolean = true;

/** The three chat modes that remain, in the order the composer shows them. */
export const RESEARCH_SUPERSEDED_BY = ["auto", "instant", "thinking"] as const;

/** The one Persian message the API and the UI both use. */
export const RESEARCH_RETIRED_MESSAGE =
  "پژوهش عمیق بازنشسته شده است. از حالت‌های خودکار، سریع یا تفکر عمیق استفاده کنید.";

export interface ResearchRetiredBody {
  error: typeof RESEARCH_RETIRED_ERROR;
  message: string;
  /** The modes a caller should use instead — never a silent remap. */
  supersededBy: readonly string[];
}

/** The response body every retired endpoint returns, so clients can branch on it. */
export function researchRetiredBody(): ResearchRetiredBody {
  return {
    error: RESEARCH_RETIRED_ERROR,
    message: RESEARCH_RETIRED_MESSAGE,
    supersededBy: RESEARCH_SUPERSEDED_BY,
  };
}
