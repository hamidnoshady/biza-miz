import "dotenv/config";
import { closeDatabasePool } from "../src/lib/db";
import {
  listStudioTours,
  publishStudioTour,
  saveStudioTour,
} from "../src/lib/tour-studio-service";
import { tourById } from "../src/lib/tours";

const actor = "guided-tours-e2e";
const fixtureIds = [
  "accounting.overview.ledger",
  "accounting.navigation.overview",
  "crm.directory.first-customer",
];

async function seedGuidedTours() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(databaseUrl).hostname)) {
    throw new Error("Guided tours E2E fixtures require a local disposable DATABASE_URL.");
  }

  const existing = new Map((await listStudioTours()).map((tour) => [tour.tourKey, tour]));
  for (const tourKey of fixtureIds) {
    const definition = tourById(tourKey);
    if (!definition) throw new Error(`Missing guided tours E2E fixture: ${tourKey}`);

    const current = existing.get(tourKey);
    if (current) {
      if (current.updatedBy !== actor) {
        throw new Error(`Refusing to replace a Studio tour not owned by the E2E fixture: ${tourKey}`);
      }
      if (current.status === "published" && current.publishedVersion === current.version) continue;
      if (current.status !== "draft") {
        throw new Error(`Unexpected E2E fixture state for ${tourKey}: ${current.status}`);
      }
      await publishStudioTour(current.id, actor, current.version);
      continue;
    }

    // Use the same tour shapes the browser scenarios exercised before the cutover.
    const { pageKey, route, title, description, eligibility, steps } = definition;
    const saved = await saveStudioTour(
      { tourKey, pageKey, route, title, description, eligibility, steps },
      actor,
    );
    await publishStudioTour(saved.id, actor, saved.version);
  }
}

seedGuidedTours()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeDatabasePool);
