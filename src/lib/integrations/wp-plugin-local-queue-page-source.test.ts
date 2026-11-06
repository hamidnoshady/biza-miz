import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1076 — the plugin half of the paged plugin-local queue.
 *
 * PHPUnit covers the media importer, not this protocol, and nothing in the
 * Tauri/Next suites can execute the plugin. These are source assertions: they
 * pin the three things the app relies on so a later edit cannot quietly drop
 * one and leave the screen waiting for an answer nobody sends.
 */

const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");
const queue = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-queue.php", "utf8");
const main = readFileSync("wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php", "utf8");

describe("#1076 plugin-local queue paging protocol", () => {
  it("advertises the capability the app gates the control on", () => {
    expect(sync).toContain("'localQueuePaging'  => true");
  });

  it("sends the answer in telemetry and stores the request the handshake received", () => {
    expect(sync).toContain("'localQueuePage'      => self::local_queue_page_answer()");
    expect(sync).toContain("$response['data']['localQueuePageRequest']");
    expect(sync).toContain("'local_queue_page_request'");
  });

  it("clears the request before answering, so a fatal cannot resend the same page forever", () => {
    const builder = sync.slice(sync.indexOf("private static function local_queue_page_answer()"));
    const cleared = builder.indexOf("'local_queue_page_request' => array()");
    const read = builder.indexOf("POS_Connector_Queue::page(");
    expect(cleared).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(cleared);
  });

  it("pages by row id with a bounded size, never by the strip's failure ordering", () => {
    const page = queue.slice(queue.indexOf("public static function page( $after = 0, $limit = 10 )"));
    expect(page).toContain("AND id > %d");
    expect(page).toContain("ORDER BY id ASC");
    expect(page).toContain("min( 25, (int) $limit )");
    // One extra row proves a further page exists without a second query.
    expect(page).toContain("$limit + 1");
    expect(page).toContain("array_slice( $rows, 0, $limit )");
  });

  it("sends metadata only — the same row shape the aggregate strip uses", () => {
    const formatter = queue.slice(queue.indexOf("private static function format_problem_row"));
    expect(formatter).toContain("'lastError'");
    expect(formatter).toContain("'remoteId'");
    expect(formatter).not.toContain("payload");
  });

  it("keeps the request in the option defaults so it survives a settings merge", () => {
    expect(main).toContain("'local_queue_page_request' => array()");
  });
});
