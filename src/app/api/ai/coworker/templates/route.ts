import { NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { requireManager, resolveActiveLocation } from "@/lib/setup-state";
import { PERMISSIONS } from "@/lib/permissions";
import { isModuleEnabled } from "@/lib/industry-guard";
import type { ModuleKey } from "@/lib/industry-profile";
import { COWORKER_TEMPLATE_LIST, WASTE_REASON_OPTIONS } from "@/lib/ai-coworker-templates";
import {
  COWORKER_APPROVAL_LABELS,
  COWORKER_EVENT_LABELS,
  COWORKER_TRIGGER_LABELS,
} from "@/lib/ai-coworker";

/**
 * Phase 32 — the ready-made job catalogue, narrowed to the templates this
 * trade's modules actually admit. Filtered here rather than in the browser for
 * the usual reason: hiding a card is decoration if the create route accepts it
 * anyway — which it does not, `createCoworkerJob` runs the same check.
 */
export const GET = withTenantScope(async () => {
  const guard = await requireManager(PERMISSIONS.aiAutomationsManage);
  if (guard.error) return guard.error;

  const templates = [];
  for (const template of COWORKER_TEMPLATE_LIST) {
    if (!(await isModuleEnabled(guard.session.businessId, template.module as ModuleKey))) continue;
    templates.push(template);
  }

  // The pickers a job form needs, served from here rather than from
  // `/api/inventory` and `/api/branches`: those sit behind the `inventory` and
  // `multi_location` entitlements, and a business can hold `ai_assistant`
  // without either. One call, one entitlement, no cross-feature dependency.
  const location = await resolveActiveLocation(guard.session);
  const [items, formulas, branches, messageTemplates, projects] = await Promise.all([
    location
      ? query<{ id: string; name: string; unit: string; quantity: string }>(
          `SELECT i.id, i.name, i.unit, trim_scale(COALESCE(sm.total, 0))::text AS quantity
             FROM inventory_items i
             LEFT JOIN LATERAL (
               SELECT sum(quantity) AS total FROM stock_movements WHERE inventory_item_id = i.id
             ) sm ON true
            WHERE i.location_id = $1 AND i.is_active
            ORDER BY i.name`,
          [location.id],
        )
      : Promise.resolve({ rows: [] }),
    location
      ? query<{ id: string; name: string; output_name: string }>(
          `SELECT f.id, f.name, oi.name AS output_name
             FROM production_formulas f
             JOIN inventory_items oi ON oi.id = f.output_inventory_item_id
            WHERE f.location_id = $1 AND f.is_active
            ORDER BY f.name`,
          [location.id],
        )
      : Promise.resolve({ rows: [] }),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM locations WHERE business_id = $1 AND is_active ORDER BY created_at`,
      [guard.session.businessId],
    ),
    query<{ id: string; name: string; channel: "sms" | "email" }>(
      `SELECT id, name, channel FROM message_templates WHERE business_id = $1 ORDER BY created_at DESC`,
      [guard.session.businessId],
    ),
    query<{ id: string; name: string }>(
      `SELECT id, name FROM ai_projects WHERE business_id = $1 AND archived_at IS NULL AND status = 'active' ORDER BY name`,
      [guard.session.businessId],
    ),
  ]);

  return NextResponse.json({
    templates,
    options: {
      activeLocationId: location?.id ?? null,
      inventoryItems: items.rows,
      formulas: formulas.rows.map((row) => ({ id: row.id, name: row.name, outputName: row.output_name })),
      branches: branches.rows,
      messageTemplates: messageTemplates.rows,
      projects: projects.rows,
    },
    labels: {
      triggers: COWORKER_TRIGGER_LABELS,
      events: COWORKER_EVENT_LABELS,
      approval: COWORKER_APPROVAL_LABELS,
      wasteReasons: WASTE_REASON_OPTIONS,
    },
  });
});
