/**
 * The audit log's action families — the vocabulary behind the console's
 * «اقدام» dropdown, and the one place that knows which action prefixes each
 * family actually covers.
 *
 * It lives in `lib` rather than next to the dropdown because two callers need
 * it and they must not disagree: the client component (`action-meta.tsx`)
 * renders the labels, and `queryAudit` in `platform-service.ts` turns the
 * chosen family into SQL. The SQL used to be a bare `action LIKE '<value>%'`,
 * which quietly assumed every family's value was a prefix of its actions — it
 * was not. «پشتیبان‌گیری» (`backup`) matched exactly one of the 28 backup rows,
 * because the routes write `platform_backup.*` and `tenant_backup.*`; «سایت‌ساز»
 * (`cms`) matched none, because they write `platform_cms.*`. An operator
 * filtering to backups saw one MCP event and concluded the log was empty.
 *
 * So a family now carries an explicit list of prefixes. `value` stays the URL
 * parameter (deep links, MCP's `actionFamily`, bookmarks), and `prefixes` is
 * what the filter expands to. Plain prefixes that are not a registered family
 * (`platform_mcp`, `business.suspended`) keep working exactly as before.
 */

export interface AuditActionFamily {
  /** The URL parameter and the dropdown's option value. */
  value: string;
  /** Persian label shown in the console. */
  label: string;
  /**
   * `action` prefixes this family covers. Every one must be a real prefix of
   * actions the console writes — the sweep test in `audit-families.test.ts`
   * fails otherwise, because a family that matches nothing is a dead filter.
   */
  prefixes: string[];
  /** How the list is rendered under the dropdown, for the comment-impaired. */
  hint?: string;
}

/**
 * The families offered by the filter, in a stable order. The first entry of
 * `prefixes` doubles as the family's "own" namespace, so `value` is redundant
 * where it equals that prefix — it is written out anyway, because the URL value
 * is a public contract (deep links, MCP callers) and must not be derived.
 */
export const AUDIT_ACTION_FAMILIES: AuditActionFamily[] = [
  { value: "business", label: "کسب‌وکار", prefixes: ["business"] },
  { value: "feature", label: "ویژگی‌ها", prefixes: ["feature"] },
  { value: "impersonation", label: "دسترسی پشتیبانی", prefixes: ["impersonation"] },
  { value: "support_session", label: "نشست‌های پشتیبانی", prefixes: ["support_session"] },
  { value: "billing", label: "مالی", prefixes: ["billing"] },
  // Issue #1296 follow-up: the backup console writes three namespaces
  // (`platform_backup.*` for the whole install, `tenant_backup.*` for one
  // business, and the MCP's `backup.run_now`). All three are "backup" to the
  // operator investigating an upload, so the family must cover all three.
  {
    value: "backup",
    label: "پشتیبان‌گیری",
    prefixes: ["platform_backup", "tenant_backup", "backup"],
    hint: "کل سیستم، یک کسب‌وکار، و اجرای MCP",
  },
  // The CMS control plane writes `platform_cms.*` (plus `platform_cms.sync.*`
  // built from a template, which the prefix still covers).
  { value: "cms", label: "سایت‌ساز", prefixes: ["platform_cms"] },
  // `ai_costing` (the gateway's spend ledger) already starts with `ai`, so the
  // one prefix covers it; it reads as AI spend to the operator, not as finance.
  { value: "ai", label: "هوش مصنوعی", prefixes: ["ai"] },
  // Issue #902 §6 — the managed-SMS actions, filterable on their own.
  { value: "sms", label: "پیامک مدیریت‌شده", prefixes: ["sms"] },
  // Console-plane events: the operators themselves, and the MCP connections
  // that act for them. Both are "who touched the console", which is the first
  // question of any investigation.
  { value: "platform_admin", label: "مدیران سامانه", prefixes: ["platform_admin"] },
  { value: "mcp", label: "اتصال‌های MCP", prefixes: ["platform_mcp"] },
];

const BY_VALUE = new Map(AUDIT_ACTION_FAMILIES.map((family) => [family.value, family]));

/** The family with this URL value, or undefined when it is not a registered one. */
export function auditFamily(value: string): AuditActionFamily | undefined {
  return BY_VALUE.get(value);
}

/**
 * The `action` prefixes a filter value expands to.
 *
 * A registered family expands to its own prefixes. Anything else is treated as
 * a literal prefix, which keeps `?actionFamily=platform_mcp` and the exact
 * `business.suspended` filter (used by the integration test and the SMS deep
 * links) behaving as they always have. Order is stable so the SQL is stable.
 */
export function expandAuditActionFamily(value: string): string[] {
  const family = BY_VALUE.get(value);
  if (!family) return [value];
  // A caller may have asked for a *specific* action inside a family whose value
  // happens to prefix it; keep the literal reading available by including it.
  return [...family.prefixes];
}
