import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const queue = readFileSync(
  "wordpress-plugin/pos-accounting-connector/includes/class-pos-queue.php",
  "utf8",
);
const sync = readFileSync(
  "wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php",
  "utf8",
);
const main = readFileSync(
  "wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php",
  "utf8",
);

describe("WordPress plugin queue table install", () => {
  it("does not pass SQL line comments to dbDelta for the queue table", () => {
    const createBlock = queue.slice(queue.indexOf("dbDelta("), queue.indexOf(");", queue.indexOf("dbDelta(")) + 2);
    expect(createBlock).not.toMatch(/^\s*--/m);
    expect(createBlock).not.toContain("-- Earliest");
  });

  it("self-heals a missing queue table on plugins_loaded", () => {
    expect(main).toContain("pos_connector_maybe_upgrade_db");
    expect(main).toContain("POS_CONNECTOR_DB_VERSION_OPTION");
    expect(queue).toContain("maybe_install");
    expect(queue).toContain("table_exists");
  });
});

describe("WordPress plugin product attribute payload", () => {
  it("normalizes string, array and object attributes without calling methods on strings", () => {
    expect(sync).toContain("rest_attribute_from_raw");
    expect(sync).toContain("is_string( $attr )");
    expect(sync).toContain("method_exists( $attr, 'get_id' )");
    expect(sync).toContain("foreach ( $product->get_attributes() as $attr_key => $attr )");
    expect(sync).not.toMatch(
      /foreach \( \$product->get_attributes\(\) as \$attr \)[\s\S]{0,400}\$attr->get_id\(\)/,
    );
  });

  it("documents variable product 13199 as a regression example", () => {
    expect(sync).toContain("13199");
  });

  it("wraps WooCommerce hook enqueues so sync errors do not abort admin saves", () => {
    expect(sync).toContain("safe_enqueue_callable");
    expect(sync).toContain("catch ( \\Throwable $e )");
    expect(sync).toContain("on_product_changed");
  });
});

describe("WordPress plugin production cron hints", () => {
  const cli = readFileSync(
    "wordpress-plugin/pos-accounting-connector/includes/class-pos-cli.php",
    "utf8",
  );

  it("shows system crontab examples when DISABLE_WP_CRON is true", () => {
    expect(main).toContain("pos_connector_uses_system_cron");
    expect(main).toContain("pos_connector_system_cron_examples");
    expect(cli).toContain("pos_connector_uses_system_cron()");
    expect(cli).toMatch(
      /if\s*\(\s*pos_connector_uses_system_cron\(\)\s*\)/,
    );
    expect(cli).not.toMatch(
      /if\s*\(\s*!\s*defined\(\s*'DISABLE_WP_CRON'\s*\)\s*\|\|\s*!\s*DISABLE_WP_CRON\s*\)/,
    );
  });
});

describe("WordPress plugin self-update logging", () => {
  const updater = readFileSync(
    "wordpress-plugin/pos-accounting-connector/includes/class-pos-updater.php",
    "utf8",
  );

  it("deduplicates manifest failure logs", () => {
    expect(updater).toContain("maybe_log_update_failure");
    expect(updater).toContain("CHECK_FAILURE_LOG_INTERVAL");
    expect(updater).not.toMatch(
      /if\s*\(\s*''\s*!==\s*\$result\['error'\]\s*\)\s*\{\s*POS_Connector_Log::error\(\s*'update'/,
    );
  });
});

describe("WordPress plugin taxonomy events (issue #939)", () => {
  it("registers term create/edit/delete hooks so store-side edits refresh the mirror", () => {
    expect(sync).toContain("add_action( 'created_term', array( __CLASS__, 'on_term_created' ), 20, 3 )");
    expect(sync).toContain("add_action( 'edited_term', array( __CLASS__, 'on_term_edited' ), 20, 3 )");
    expect(sync).toContain("add_action( 'deleted_term', array( __CLASS__, 'on_term_deleted' ), 20, 4 )");
    expect(sync).toContain("maybe_enqueue_taxonomy_snapshot");
  });

  it("absorbs WordPress's edited_term argument swap instead of misreading the taxonomy", () => {
    expect(sync).toContain("public static function on_term_edited( $term_id, $taxonomy, $tt_id )");
    expect(sync).toContain("public static function on_term_created( $term_id, $tt_id, $taxonomy )");
  });

  it("coalesces bulk term operations into one snapshot per request", () => {
    expect(sync).toContain("already_seen( 'taxonomy', $taxonomy )");
  });

  it("stamps every snapshot with a generated_at watermark so stale replays cannot resurrect rows", () => {
    expect(sync).toContain("current_time( 'c', true )");
    expect(sync).toContain("'generated_at' => $generated_at");
  });

  it("chunks oversized snapshots with a deterministic per-part queue id", () => {
    expect(sync).toContain("TAXONOMY_SNAPSHOT_CHUNK_TERMS = 400");
    expect(sync).toContain("array_chunk( $payload_terms, self::TAXONOMY_SNAPSHOT_CHUNK_TERMS )");
    expect(sync).toContain("'chunk_index'  => $chunk_index");
    expect(sync).toContain("'chunk_count'  => $chunk_count");
    expect(sync).toContain("$taxonomy . '#' . $snapshot_id . '#' . $chunk_index");
  });

  it("serves a taxonomy_export job without a full catalogue sweep", () => {
    expect(sync).toContain("case 'taxonomy_export':");
    expect(sync).toContain("'taxonomy_export',");
  });
});
