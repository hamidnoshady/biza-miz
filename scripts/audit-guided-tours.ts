/**
 * Guided-tour coverage audit (issue #972) — read-only, no database.
 *
 * Lists every page in the canonical Knowledge registry with the tour its
 * «آموزش» button offers:
 *
 *   ADVANCED  an authored tour in `src/lib/tours.ts` owns the page;
 *   BASELINE  the page falls back to the automatic, metadata-derived tour in
 *             `src/lib/tour-baseline.ts` — real guidance, but the editorial
 *             backlog for a step-by-step walkthrough.
 *
 * The report covers the code catalogue and every registered page. Published
 * tours authored in the console (migration 0288) are included when a caller
 * passes them in (`tourCoverage(tours, regions, published)`); this CLI is
 * deliberately offline, so it reports the code catalogue and the baselines,
 * and the console shows the published ones beside them.
 *
 * It also prints contract problems (an anchor nobody registers, a region for a
 * page that does not exist, an authored tour attached to an unregistered page,
 * a duplicate id). `--check` exits non-zero when there is one, so a workflow
 * can gate on it; the unit suite already fails on the same report.
 *
 * Usage:
 *   npm run tours:audit
 *   npm run tours:audit -- --json
 *   npm run tours:audit -- --check
 */
import { tourCoverage } from "../src/lib/tour-coverage";
import type { TourCoverageRow } from "../src/lib/tour-coverage";

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const check = args.has("--check");

const report = tourCoverage();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const icon = (row: TourCoverageRow) => (row.kind === "advanced" ? "ADVANCED" : "baseline");
  let group = "";
  for (const row of report.pages) {
    if (row.group !== group) {
      group = row.group;
      console.log(`\n${group}`);
    }
    const anchors = row.anchors.length > 0 ? row.anchors.join(", ") : "—";
    console.log(
      `  ${icon(row).padEnd(8)} ${row.route.padEnd(42)} ${String(row.stepCount).padStart(2)} steps ` +
        `${String(row.spotlightCount).padStart(2)} ${row.spotlightCount === 1 ? "spotlight " : "spotlights"}  ${anchors}`,
    );
  }

  console.log("");
  console.log(`pages:            ${report.pages.length}`);
  console.log(`advanced:         ${report.advancedPages}`);
  console.log(`baseline:         ${report.baselinePages}`);
  console.log(`authored tours:   ${report.authoredTours}`);
  console.log(`studio tours:     ${report.studioTours}`);
  console.log(`steps offered:    ${report.steps}`);
  console.log(`  spotlights:     ${report.spotlightSteps}`);
  console.log(`  actions:        ${report.actionSteps}`);
  console.log(`  hand-offs:      ${report.navigateSteps}`);
  console.log(`spotlight pages:  ${report.spotlightPages}`);
  console.log(`explanation-only: ${report.explanationOnlyPages}`);
  console.log(`uncovered pages:  ${report.uncoveredPages.length}`);
  console.log(`stale tours:      ${report.staleTourIds.length}`);

  if (report.issues.length > 0) {
    console.log("");
    console.log("contract problems:");
    for (const issue of report.issues) console.log(`  - ${issue}`);
  } else {
    console.log("contract problems: none");
  }

  if (report.editorialGaps.length > 0) {
    console.log("");
    console.log(`editorial backlog (${report.editorialGaps.length} pages on their baseline):`);
    for (const pageKey of report.editorialGaps) console.log(`  - ${pageKey}`);
  }
  if (report.uncoveredPages.length > 0) {
    console.log("");
    console.log(`uncovered pages (${report.uncoveredPages.length}) — every registered page must answer:`);
    for (const pageKey of report.uncoveredPages) console.log(`  - ${pageKey}`);
  }

  if (report.staleTourIds.length > 0) {
    console.log("");
    console.log(`stale tours (${report.staleTourIds.length}) — attached to an unregistered page:`);
    for (const id of report.staleTourIds) console.log(`  - ${id}`);
  }
}

if (check && (report.issues.length > 0 || report.uncoveredPages.length > 0)) process.exitCode = 1;
