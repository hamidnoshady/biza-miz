import { query } from "./db";
import {
  REPORT_VIEWS,
  type ReportFilterControl,
  type ReportFilterOption,
} from "./reports";

interface ReportFilterOptionRow extends Record<string, unknown> {
  value: string;
  label: string;
}

/**
 * Dynamic values for a source's declared filters. The source/key mapping comes
 * only from REPORT_VIEWS; the browser never supplies a table or column name.
 * Location-bound entities use the same authorized branch the report query uses
 * and also carry an explicit business predicate (RLS is defense in depth).
 */
export async function reportFilterOptions(
  businessId: string,
  locationId: string,
  viewKey: string,
): Promise<Record<string, ReportFilterOption[]>> {
  if (!Object.hasOwn(REPORT_VIEWS, viewKey)) return {};
  const filters = REPORT_VIEWS[viewKey].filters ?? [];
  const results = await Promise.all(
    filters.map(async (filter) => [
      filter.key,
      await optionsForControl(businessId, locationId, filter.control),
    ] as const),
  );
  return Object.fromEntries(results);
}

async function optionsForControl(
  businessId: string,
  locationId: string,
  control: ReportFilterControl,
): Promise<ReportFilterOption[]> {
  if (control.kind === "enum") return control.options.map((option) => ({ ...option }));
  if (control.kind === "text") return [];

  switch (control.source) {
    case "menu-category": {
      const { rows } = await query<ReportFilterOptionRow>(
        `SELECT mc.id::text AS value, mc.name AS label
           FROM menu_categories mc
           JOIN locations l ON l.id = mc.location_id
          WHERE l.business_id = $1 AND l.id = $2
          ORDER BY mc.sort_order, mc.name, mc.id`,
        [businessId, locationId],
      );
      return rows;
    }
    case "modifier-group": {
      const { rows } = await query<ReportFilterOptionRow>(
        `SELECT mg.id::text AS value, mg.name AS label
           FROM modifier_groups mg
           JOIN locations l ON l.id = mg.location_id
          WHERE l.business_id = $1 AND l.id = $2
          ORDER BY mg.name, mg.id`,
        [businessId, locationId],
      );
      return rows;
    }
    case "supplier": {
      const { rows } = await query<ReportFilterOptionRow>(
        `SELECT s.id::text AS value, s.name AS label
           FROM suppliers s
           JOIN locations l ON l.id = s.location_id
          WHERE l.business_id = $1 AND l.id = $2
          ORDER BY s.name, s.id`,
        [businessId, locationId],
      );
      return rows;
    }
    case "account": {
      const { rows } = await query<ReportFilterOptionRow>(
        `SELECT a.code AS value, a.code || ' — ' || a.name AS label
           FROM accounts a
          WHERE a.business_id = $1
            AND ($2::account_type IS NULL OR a.type = $2::account_type)
          ORDER BY a.code, a.id`,
        [businessId, control.accountType ?? null],
      );
      return rows;
    }
  }
}
