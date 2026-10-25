#!/usr/bin/env tsx
/** Writes docs/architecture/replication-coverage.md from src/lib/replication-coverage.ts. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReplicationCoverageMarkdown } from "../src/lib/replication-coverage";

writeFileSync(join(process.cwd(), "docs/architecture/replication-coverage.md"), renderReplicationCoverageMarkdown(), "utf8");
