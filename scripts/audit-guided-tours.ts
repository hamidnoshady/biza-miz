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
  console.log(`steps offered:    ${report.steps}`);

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
}

if (check && report.issues.length > 0) process.exitCode = 1;
