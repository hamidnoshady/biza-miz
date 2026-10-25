#!/usr/bin/env tsx
/** Writes docs/architecture/sync-controls-inventory.md from src/lib/sync-controls-inventory.ts. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderSyncControlsMarkdown } from "../src/lib/sync-controls-inventory";

writeFileSync(join(process.cwd(), "docs/architecture/sync-controls-inventory.md"), renderSyncControlsMarkdown(), "utf8");
