import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Issue #1215, P2-5 — the plugin half of the featured-image field.
 *
 * WordPress has no post field for the thumbnail: it is `_thumbnail_id` meta,
 * applied through `set_post_thumbnail()`. PHPUnit cannot run in this sandbox, so
 * these source assertions pin the three ways a wrong implementation would look
 * right to the app and wrong on the site:
 *   1. the capability is advertised only if the field is really applied;
 *   2. an attachment id is checked to BE an attachment before it is used;
 *   3. `0` deletes the thumbnail instead of being ignored.
 */

const sync = readFileSync("wordpress-plugin/pos-accounting-connector/includes/class-pos-sync.php", "utf8");
const upsert = sync.slice(
  sync.indexOf("private static function apply_post_upsert"),
  sync.indexOf("private static function apply_media_create"),
);

describe("#1215 plugin featured image", () => {
  it("advertises the capability the app gates the field on", () => {
    expect(sync).toContain("'featuredMedia'     => true");
  });

  it("applies a positive id through set_post_thumbnail and clears on 0", () => {
    expect(upsert).toContain("set_post_thumbnail( (int) $result, $featured_media )");
    expect(upsert).toContain("delete_post_thumbnail( (int) $result )");
    expect(upsert).toContain("'featured_media_apply_failed'");
  });

  it("refuses an id that is not an attachment instead of saving a post without an image", () => {
    expect(upsert).toContain("'featured_media_not_attachment'");
    const guard = upsert.indexOf("featured_media_not_attachment");
    const write = upsert.indexOf("wp_insert_post( $data, true )");
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
  });

  it("lets an image-only save through, but still refuses a truly empty one", () => {
    expect(upsert).toContain("if ( empty( $data ) && null === $featured_media )");
    expect(upsert).toContain("'empty_post_update'");
  });

  it("applies the image after the write, on the id WordPress returned", () => {
    const write = upsert.indexOf("$result              = wp_update_post( $data, true );");
    const apply = upsert.indexOf("set_post_thumbnail( (int) $result, $featured_media )");
    expect(write).toBeGreaterThan(-1);
    expect(apply).toBeGreaterThan(write);
  });
});
