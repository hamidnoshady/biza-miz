import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(".github/workflows/wp-media-phpunit.yml", "utf8");
const invocation = workflow.match(/--bootstrap\s+(wordpress-plugin\/tests\/bootstrap\.php)\s+(wordpress-plugin\/tests\/[\w.-]+\.php)\s+--log-junit/);

describe("native WordPress media PHPUnit entry point", () => {
  it("uses the declared test class as the single-file PHPUnit filename", () => {
    expect(invocation, "CI must invoke the WP bootstrap and the native test file").not.toBeNull();
    const filename = invocation![2];
    const source = readFileSync(filename, "utf8");
    const declaredClass = source.match(/class\s+(\w+)\s+extends\s+WP_UnitTestCase\b/);
    expect(declaredClass).not.toBeNull();
    // PHPUnit 9's single-file loader derives the requested class from this
    // basename. A kebab-case filename fails before executing any assertions.
    expect(basename(filename, ".php")).toBe(declaredClass![1]);
  });

  it("keeps all four native lifecycle scenarios runnable without a filter", () => {
    expect(invocation).not.toBeNull();
    const source = readFileSync(invocation![2], "utf8");
    for (const method of [
      "test_hook_payload_precedes_meta_but_fresh_confirmation_and_retry_include_it",
      "test_failure_between_import_and_meta_rolls_back_attachment_and_event",
      "test_metadata_usage_guard_trash_restore_and_idempotent_retry",
      "test_snapshot_reads_fresh_locked_rows_not_stale_cached_posts",
    ]) {
      expect(source).toContain(`public function ${method}()`);
    }
    expect(workflow).not.toContain("--filter");
  });

  it("provisions a persistent queue before WordPress installs per-test temporary-table rewrites", () => {
    expect(invocation).not.toBeNull();
    const source = readFileSync(invocation![2], "utf8");
    const fixture = source.match(/public static function wpSetUpBeforeClass\([^)]*\)\s*\{([\s\S]*?)\n\t\}/);
    expect(fixture, "Queue DDL must run in the class fixture, not inside a WP test transaction").not.toBeNull();
    expect(fixture![1]).toContain("POS_Connector_Queue::maybe_install()");
    expect(fixture![1]).toContain("information_schema.TABLES");
    expect(fixture![1]).toContain("innodb");
    expect(source).toContain("public static function wpTearDownAfterClass()");
    expect(source).toContain("DROP TABLE IF EXISTS");
    expect(source).toContain("parent::set_up()");
    expect(source).toContain("DELETE FROM");
  });

});
