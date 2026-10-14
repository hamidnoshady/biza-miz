/**
 * The one column list every printer read uses.
 *
 * Purpose, paper, drawer, cut, defaultness and activity are relational
 * columns (migration 0173, consolidated in 0211) — NOT keys inside the
 * `connection` jsonb. Every route that loads a printer loads exactly these
 * columns, so the settings screen, the routing resolver and the render
 * pipeline can never disagree about what a printer is.
 */
export const PRINTER_COLUMNS =
  "id, name, kind, connection, is_active, printer_class, paper, paper_width_mm, supports_drawer, supports_cut, is_default, last_seen_at, last_tested_at, last_test_result";
