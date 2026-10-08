import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  JOURNAL_EXPORT_ROW_CAP,
  parseJournalFilters,
  type JournalExportFormat,
} from "@/lib/journal-filters";
import { listJournalEntries, listJournalEntriesForExport } from "@/lib/journal-service";
import { buildJournalExportTable, journalExportFilename } from "@/lib/journal-export";
import { rowsToCsv, rowsToXlsxBuffer } from "@/lib/report-export";

/**
 * «دفتر روزنامه» — every posted entry (auto-posted and manual), its lines, and
 * the audit metadata the ledger model already carries.
 *
 * Manual entries are not posted from this route — see
 * /api/ledger/entries/drafts for the draft → review → post workflow, and
 * /api/ledger/entries/[id]/reverse for reversing a posted one — but every
 * entry, however it was posted, shows up here, including both directions of a
 * reversal link (`reversesEntryId` ⇄ `reversedByEntryId`) so the screen can
 * walk between an original and the document that reversed it.
 *
 * Three things this route is deliberate about:
 *
 *  - **Filters are the book's index.** A date range, a source, a branch, an
 *    account, a poster, a project, reversal state, manual-vs-system, an amount
 *    band, and free text over the memo / poster / accounts touched. Every one
 *    of them is parsed and *validated* by `journal-filters.ts`; an unusable
 *    parameter is a named 400, never a silently-dropped filter, because a
 *    filter the server ignores shows the reader a different book than the one
 *    they asked for. Impossible calendar dates (`2026-02-31`) are part of that:
 *    they used to reach PostgreSQL's `::date` cast as a 500.
 *  - **Pagination is keyset.** The journal is live. `OFFSET n` over
 *    `entry_date DESC, posted_at DESC, id DESC` duplicated or skipped rows
 *    whenever something was posted between two page requests; `cursor` is that
 *    exact ordering tuple instead. `totalCount` is the filter's real total,
 *    returned on the first page, so the screen never presents a loaded page
 *    count as the number of matches.
 *  - **`?format=csv|xlsx` exports the complete filtered result**, not the rows
 *    that happen to be loaded — same parameters, same SQL, bounded by
 *    `JOURNAL_EXPORT_ROW_CAP`, amounts kept as exact BIGINT Rial. One route, so
 *    «خروجی» can never answer a different question than the list above it.
 */

const FILTER_PROBLEM_STATUS = 400;

function exportFormat(value: string | null): JournalExportFormat | null | undefined {
  if (value === null || value.trim() === "") return null;
  const text = value.trim();
  if (text === "csv" || text === "xlsx") return text;
  return undefined;
}

/** A Persian filename must be RFC 5987-encoded; the journal's is ASCII, so this is simply the attachment header. */
function fileResponse(body: string | Buffer, contentType: string, filename: string): NextResponse {
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.ledgerView);
  if (error) return error;

  const params = request.nextUrl.searchParams;
  const format = exportFormat(params.get("format"));
  if (format === undefined) {
    return NextResponse.json({ error: "invalid_format" }, { status: FILTER_PROBLEM_STATUS });
  }

  const parsed = parseJournalFilters(params);
  if ("error" in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: FILTER_PROBLEM_STATUS });
  }

  if (format) {
    const { entries, truncated } = await listJournalEntriesForExport(session.businessId, parsed.filters);
    const table = buildJournalExportTable(entries);
    const response =
      format === "xlsx"
        ? fileResponse(
            await rowsToXlsxBuffer(table, "دفتر روزنامه"),
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            journalExportFilename("xlsx"),
          )
        : fileResponse(rowsToCsv(table), "text/csv; charset=utf-8", journalExportFilename("csv"));
    // A truncated export is a fact the operator has to know before they
    // reconcile against it; the header is read by the screen, which says so.
    if (truncated) response.headers.set("X-Journal-Export-Truncated", String(JOURNAL_EXPORT_ROW_CAP));
    return response;
  }

  return NextResponse.json(await listJournalEntries(session.businessId, parsed.filters));
});
