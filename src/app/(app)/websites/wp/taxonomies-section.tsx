"use client";

/**
 * «دسته‌بندی و ویژگی‌ها» — the store's taxonomy tree, as the WP Manager's own
 * screen rather than a 15-line panel borrowed from the connection tester.
 *
 * What it is: a read mirror. Categories, tags, global attribute terms and any
 * custom taxonomy a plugin registered, keyed by *remote* id, refreshed by the
 * catalogue sync (see woo-taxonomy-service.ts for why this is a mirror and
 * not a local category model). Nothing here writes to the store, so the
 * screen's whole job is letting an owner find a term and understand two
 * numbers about it: how many products the store says carry it, and how many
 * of those this app has actually mapped.
 *
 * Issue #939 changed what the screen must be honest about:
 *
 *  - **TAX-12 — the old «تازه‌سازی» was a lie by omission.** It re-requested
 *    the local mirror (GET) and could never show anything the store had
 *    changed. There are now two distinct actions: «تازه‌سازی نما» re-reads
 *    the cache, and «همگام‌سازی از وب‌سایت» goes to the store — pulling
 *    directly in REST mode, queueing a job (with a deep link to the queue
 *    screen) in plugin mode — and reports queued/complete/partial/failed
 *    with the per-taxonomy errors the API now returns.
 *  - **TAX-04/TAX-14 — every group carries its own status.** A truncated,
 *    failed or never-read taxonomy shows as itself, with the error, instead
 *    of vanishing (empty-but-valid groups included) behind one blended
 *    «آخرین همگام‌سازی» stamp.
 *  - **TAX-08 — the totals are labelled as what they are.** «محصول
 *    همگام‌شده» is now a count of UNIQUE mapped products; the additive
 *    membership number lives beside it as «عضویت», because a product in
 *    three categories is one product and three memberships.
 *  - **TAX-13 — the tree renders bounded.** Node-level expand/collapse and a
 *    per-group render cap keep a 5,000-term store from putting 5,000 rows in
 *    the DOM; search still finds every match server-normalised and shows the
 *    matched term's full path.
 *
 * Preserved from the previous iteration: per-group expansion (opening one
 * group never closes another), the tree-order sort, Persian/Arabic letter
 * normalisation in search, logical (RTL/LTR-agnostic) spacing, Jalali dates,
 * `toPersianDigits`, aria labels and the connection-switch guard that stops
 * a slow response landing on the wrong store.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  CloudDownloadIcon,
  FolderTreeIcon,
  RefreshCwIcon,
  SearchIcon,
  TagsIcon,
} from "lucide-react";
import { api, inputClass } from "@/app/dashboard/ui";
import { Button } from "@/components/ui/button";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge, cardClass } from "@/app/dashboard/page-chrome";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useFeatureLocked } from "@/components/feature-lock";

export interface TermRow {
  remoteId: string;
  parentRemoteId: string | null;
  name: string;
  slug: string;
  /** Tree level, computed server-side — 0 for a root. */
  depth: number;
  /** «پوشاک › تی‌شرت › یقه‌دار», for the search hit that is three levels deep. */
  path: string;
  remoteCount: number;
  mappedCount: number;
}

export type TaxonomyGroupStatus = "pending" | "synced" | "truncated" | "failed";

export interface TermGroup {
  taxonomy: string;
  label: string;
  isAttribute: boolean;
  termCount: number;
  /** Sum of the store's own per-term counts — memberships on the store's side. */
  remoteCount: number;
  /** UNIQUE mapped products carrying any term of this taxonomy (TAX-08). */
  mappedCount: number;
  /** Local assignment rows — memberships, not products (TAX-08). */
  assignmentCount: number;
  status: TaxonomyGroupStatus;
  lastError: string | null;
  lastSyncedAt: string | null;
  restBase: string | null;
  terms: TermRow[];
}

interface TaxonomyTotals {
  groups: number;
  terms: number;
  mappedProducts: number;
  assignments: number;
}

/** One taxonomy's outcome from a REST-mode remote sync (TAX-04/TAX-12). */
interface SyncResultRow {
  taxonomy: string;
  terms: number;
  status: "synced" | "truncated" | "failed";
  error?: string;
}

interface SyncResponse {
  ok?: boolean;
  queued?: boolean;
  jobType?: string;
  status?: "complete" | "partial" | "failed";
  results?: SyncResultRow[];
  discoveryErrors?: { stage: string; error: string }[];
  terms?: number;
  failed?: string[];
  error?: string;
}

type KindFilter = "" | "cat" | "tag" | "attr" | "custom";
type StatusFilter = "" | TaxonomyGroupStatus;

/** Indentation per tree level, capped so a deep store cannot squeeze the name off the row. */
const INDENT_REM = 1.15;
const MAX_INDENT_LEVEL = 4;

/**
 * Rows one group puts in the DOM before «نمایش بیشتر» (TAX-13). A flat
 * taxonomy — tags have no hierarchy, so every tag is a root — is the worst
 * case the render cap exists for; collapsed subtrees are the other half.
 */
const RENDER_PAGE = 200;

function indentStyle(depth: number) {
  return { marginInlineStart: `${Math.min(depth, MAX_INDENT_LEVEL) * INDENT_REM}rem` } as const;
}

function normalise(value: string): string {
  // Arabic ye/kaf and the zero-width non-joiner are what a Persian search box
  // actually receives; without folding them «برچسب‌ها» never matches a typed
  // «برچسبها» and the owner concludes the search is broken.
  return value
    .toLowerCase()
    .replace(/\u200c/g, "")
    .replace(/[\u064a\u0649]/g, "ی")
    .replace(/\u0643/g, "ک")
    .trim();
}

function groupKind(group: TermGroup): Exclude<KindFilter, ""> {
  if (group.taxonomy === "product_cat") return "cat";
  if (group.taxonomy === "product_tag") return "tag";
  if (group.isAttribute) return "attr";
  return "custom";
}

const KIND_LABELS: Record<Exclude<KindFilter, "">, string> = {
  cat: "دسته‌بندی",
  tag: "برچسب",
  attr: "ویژگی",
  custom: "سفارشی",
};

const STATUS_META: Record<TaxonomyGroupStatus, { label: string; tone: "positive" | "active" | "danger" | "neutral" }> = {
  synced: { label: "همگام", tone: "positive" },
  truncated: { label: "ناقص", tone: "active" },
  failed: { label: "ناموفق", tone: "danger" },
  pending: { label: "در انتظار", tone: "neutral" },
};

/**
 * The rows of one open group, bounded (TAX-13).
 *
 * The server's tree order is walked with a collapse horizon: a node whose
 * children are not expanded hides its whole subtree, so only what the owner
 * can see exists in the DOM. Search mode bypasses this — every match renders
 * flat with its path.
 */
function visibleTerms(
  group: TermGroup,
  expanded: Record<string, boolean>,
  renderLimit: number,
): { rows: TermRow[]; hidden: number } {
  const out: TermRow[] = [];
  let collapseDepth: number | null = null;
  // `hidden` counts only rows the render cap is holding back — rows a
  // collapsed parent hides are the owner's choice, not something «نمایش
  // بیشتر» would reveal, so they are not counted toward it.
  let hidden = 0;
  for (let index = 0; index < group.terms.length; index += 1) {
    const term = group.terms[index];
    if (collapseDepth !== null) {
      if (term.depth > collapseDepth) continue;
      collapseDepth = null;
    }
    if (out.length >= renderLimit) {
      hidden += 1;
      continue;
    }
    out.push(term);
    const hasChildren = index + 1 < group.terms.length && group.terms[index + 1].depth > term.depth;
    if (hasChildren && !expanded[`${group.taxonomy}:${term.remoteId}`]) {
      collapseDepth = term.depth;
    }
  }
  return { rows: out, hidden };
}

/** How many nodes of one group have children — the «باز کردن همه» targets. */
function collapsibleKeys(group: TermGroup): string[] {
  const keys: string[] = [];
  for (let index = 0; index < group.terms.length; index += 1) {
    if (index + 1 < group.terms.length && group.terms[index + 1].depth > group.terms[index].depth) {
      keys.push(`${group.taxonomy}:${group.terms[index].remoteId}`);
    }
  }
  return keys;
}

export function TaxonomiesSection({ connectionId }: { connectionId: string }) {
  const locked = useFeatureLocked();
  const [groups, setGroups] = useState<TermGroup[] | null>(null);
  const [totals, setTotals] = useState<TaxonomyTotals | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [lastTaxonomySyncAt, setLastTaxonomySyncAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<KindFilter>("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("");
  const [onlyMapped, setOnlyMapped] = useState(false);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renderLimits, setRenderLimits] = useState<Record<string, number>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<{ tone: "info" | "positive" | "warn" | "error"; text: string; queueLink?: boolean } | null>(null);
  // A connection switched mid-flight must not have the previous store's tree
  // land on top of it; every load carries the id it was started for.
  const requestFor = useRef("");

  const load = useCallback(
    async (mode: "initial" | "refresh" = "initial") => {
      if (!connectionId || locked) return;
      requestFor.current = connectionId;
      if (mode === "refresh") setRefreshing(true);
      else setGroups(null);
      setError("");
      const { ok, data, status } = await api<{
        groups?: TermGroup[];
        totals?: TaxonomyTotals;
        syncedAt?: string | null;
        lastTaxonomySyncAt?: string | null;
        error?: string;
      }>(`/api/integrations/connections/${connectionId}/taxonomies`);
      if (requestFor.current !== connectionId) return;
      setRefreshing(false);
      if (!ok) {
        // The old panel showed the "not synced yet" copy for this, which sent
        // owners to press a sync button over a problem sync cannot fix.
        setGroups([]);
        setTotals(null);
        setError(
          status === 403
            ? "دسترسی به دسته‌بندی‌های این فروشگاه مجاز نیست."
            : status === 404
              ? "این فروشگاه دیگر در دسترس نیست؛ فهرست فروشگاه‌ها را تازه کنید."
              : "خواندن دسته‌بندی‌ها ناموفق بود. دوباره تلاش کنید.",
        );
        return;
      }
      setGroups(data.groups ?? []);
      setTotals(data.totals ?? null);
      setSyncedAt(data.syncedAt ?? null);
      setLastTaxonomySyncAt(data.lastTaxonomySyncAt ?? null);
    },
    [connectionId, locked],
  );

  useEffect(() => {
    void load("initial");
  }, [load]);

  // A new store starts with its own disclosure state and its own search.
  useEffect(() => {
    setClosed({});
    setExpanded({});
    setRenderLimits({});
    setQuery("");
    setKindFilter("");
    setStatusFilter("");
    setOnlyMapped(false);
    setNotice(null);
  }, [connectionId]);

  /**
   * TAX-12 — the remote action, distinct from the cached-view reload above.
   * REST mode pulls now and answers with per-taxonomy outcomes; plugin mode
   * queues and the honest word for that is «در صف», with the queue screen one
   * link away.
   */
  const remoteSync = useCallback(async () => {
    if (!connectionId || locked || syncing) return;
    requestFor.current = connectionId;
    setSyncing(true);
    setNotice(null);
    const { ok, data, status } = await api<SyncResponse>(`/api/integrations/connections/${connectionId}/taxonomies`, {
      method: "POST",
    });
    if (requestFor.current !== connectionId) return;
    setSyncing(false);

    if (!ok && status === 403) {
      setNotice({ tone: "error", text: "اجرای همگام‌سازی با دسترسی فعلی مجاز نیست." });
      return;
    }
    if (!ok && status === 409) {
      setNotice({
        tone: "warn",
        text:
          data?.error === "connection_paused"
            ? "اتصال این فروشگاه متوقف شده است؛ ابتدا آن را از «اتصال‌های فنی» فعال کنید."
            : "همگام‌سازی محصولات این اتصال غیرفعال است؛ دسته‌بندی‌ها بخشی از همان همگام‌سازی‌اند.",
      });
      return;
    }
    if (!ok) {
      setNotice({
        tone: "error",
        text: data?.error
          ? `همگام‌سازی از وب‌سایت ناموفق بود: ${data.error}`
          : "همگام‌سازی از وب‌سایت ناموفق بود. دوباره تلاش کنید.",
      });
      return;
    }

    if (data?.queued) {
      setNotice({
        tone: "info",
        queueLink: true,
        text: "درخواست همگام‌سازی در صف قرار گرفت؛ فروشگاه در اجرای بعدی افزونه، درخت را می‌فرستد.",
      });
      return;
    }

    const results = data?.results ?? [];
    const failedRows = results.filter((row) => row.status === "failed");
    const truncatedRows = results.filter((row) => row.status === "truncated");
    const discovery = data?.discoveryErrors ?? [];
    if (data?.status === "complete") {
      setNotice({
        tone: "positive",
        text: `همگام‌سازی کامل انجام شد — ${toPersianDigits(data?.terms ?? 0)} مورد در ${toPersianDigits(results.length)} گروه.`,
      });
    } else {
      const parts: string[] = [];
      if (failedRows.length) {
        parts.push(
          `خواندن ${failedRows
            .slice(0, 3)
            .map((row) => row.taxonomy)
            .join("، ")} ناموفق بود${failedRows.length > 3 ? ` و ${toPersianDigits(failedRows.length - 3)} گروه دیگر` : ""}`,
        );
      }
      if (truncatedRows.length) {
        parts.push(`${truncatedRows.map((row) => row.taxonomy).join("، ")} بیش از حد مجاز مورد دارد و ناقص ذخیره شد`);
      }
      if (discovery.length) {
        parts.push("کشف ویژگی‌ها یا طبقه‌بندی‌های سفارشی ناموفق بود");
      }
      setNotice({
        tone: data?.status === "failed" ? "error" : "warn",
        text: `همگام‌سازی ناقص بود: ${parts.join("؛ ") || "جزئیات در وضعیت گروه‌ها دیده می‌شود"}.`,
      });
    }
    // The mirror changed (or partially changed) either way — show the new truth.
    await load("refresh");
  }, [connectionId, load, locked, syncing]);

  const needle = normalise(query);
  const searching = needle.length > 0;

  const filtered = useMemo(() => {
    if (!groups) return [];
    return groups.filter((group) => {
      if (kindFilter && groupKind(group) !== kindFilter) return false;
      if (statusFilter && group.status !== statusFilter) return false;
      if (onlyMapped && group.mappedCount === 0) return false;
      return true;
    });
  }, [groups, kindFilter, statusFilter, onlyMapped]);

  const visible = useMemo(() => {
    if (!needle) return filtered;
    return filtered
      .map((group) => {
        // A group whose *name* matches keeps all of its terms: searching
        // «ویژگی» should show the attribute groups whole, not empty shells.
        if (normalise(group.label).includes(needle) || normalise(group.taxonomy).includes(needle)) return group;
        const terms = group.terms.filter(
          (term) =>
            normalise(term.name).includes(needle) ||
            normalise(term.slug).includes(needle) ||
            normalise(term.path).includes(needle),
        );
        return terms.length ? { ...group, terms } : null;
      })
      .filter((group): group is TermGroup => group !== null);
  }, [filtered, needle]);

  const all = useMemo(() => groups ?? [], [groups]);
  const chipTotals = useMemo(() => {
    return {
      groups: totals?.groups ?? all.length,
      terms: totals?.terms ?? all.reduce((sum, g) => sum + g.termCount, 0),
      attributes: all.filter((g) => g.isAttribute).length,
      // TAX-08: unique products, not summed memberships. The additive number
      // rides along beside it, labelled as what it is.
      mapped: totals?.mappedProducts ?? all.reduce((sum, g) => sum + g.mappedCount, 0),
      assignments: totals?.assignments ?? all.reduce((sum, g) => sum + g.assignmentCount, 0),
    };
  }, [all, totals]);

  if (groups === null) return <SectionCardSkeleton rows={6} label="در حال خواندن دسته‌بندی‌ها" />;

  const hits = visible.reduce((sum, g) => sum + g.terms.length, 0);
  const anyTruncated = all.some((group) => group.status === "truncated");
  const anyFailed = all.some((group) => group.status === "failed");

  return (
    <div className="space-y-4">
      <div className={`${cardClass} space-y-3 p-4`}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-56">
            {/* Positioned with logical properties so the icon stays on the
                reading-start edge in both directions, rather than pinned left. */}
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              style={{ insetInlineStart: "0.75rem" }}
            />
            <input
              type="search"
              className="h-10 w-full min-w-0 rounded-lg border border-input bg-transparent py-1 pe-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50"
              style={{ paddingInlineStart: "2.25rem" }}
              placeholder="جست‌وجو در دسته، برچسب یا ویژگی…"
              aria-label="جست‌وجو در دسته‌بندی‌ها و ویژگی‌ها"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {/* TAX-12: two actions, two meanings. The reload re-reads the local
              mirror; the sync goes to the website (or the queue, in plugin
              mode) — and each says which one it is. */}
          <div className="ms-auto flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={refreshing || syncing}
              onClick={() => void load("refresh")}
              title="خواندن دوبارهٔ نمای ذخیره‌شده، بدون مراجعه به فروشگاه"
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
              {refreshing ? "در حال خواندن…" : "تازه‌سازی نما"}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={refreshing || syncing}
              onClick={() => void remoteSync()}
              title="دریافت درخت دسته‌بندی از خود وب‌سایت (در حالت افزونه، صف‌بندی می‌شود)"
            >
              <CloudDownloadIcon className="size-4" aria-hidden="true" />
              {syncing ? "در حال همگام‌سازی…" : "همگام‌سازی از وب‌سایت"}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${inputClass} h-9 w-auto min-w-32 text-xs`}
            aria-label="فیلتر نوع گروه"
            value={kindFilter}
            onChange={(event) => setKindFilter(event.target.value as KindFilter)}
          >
            <option value="">همهٔ انواع</option>
            {(Object.keys(KIND_LABELS) as Exclude<KindFilter, "">[]).map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          <select
            className={`${inputClass} h-9 w-auto min-w-32 text-xs`}
            aria-label="فیلتر وضعیت همگام‌سازی"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="">همهٔ وضعیت‌ها</option>
            {(Object.keys(STATUS_META) as TaxonomyGroupStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_META[status].label}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={onlyMapped}
              onChange={(event) => setOnlyMapped(event.target.checked)}
            />
            فقط دارای محصول همگام‌شده
          </label>
        </div>
      </div>

      {notice ? (
        <p
          role="status"
          aria-live="polite"
          className={`flex flex-wrap items-center gap-2 rounded-xl border px-4 py-3 text-xs leading-5 ${
            notice.tone === "error"
              ? "border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
              : notice.tone === "warn"
                ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
                : notice.tone === "positive"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                  : "border-sky-200 bg-sky-50 text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200"
          }`}
        >
          {notice.tone === "warn" || notice.tone === "error" ? (
            <AlertTriangleIcon aria-hidden="true" className="size-4 shrink-0" />
          ) : null}
          <span>{notice.text}</span>
          {notice.queueLink ? (
            <Link href={`/websites/wp/queue?store=${connectionId}`} className="font-medium underline underline-offset-2">
              پیگیری در صف و رویدادها
            </Link>
          ) : null}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-xs leading-5 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      ) : null}

      {anyTruncated || anyFailed ? (
        <p className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>
            {anyFailed ? "خواندن دست‌کم یک گروه از وب‌سایت ناموفق بود؛ داده‌های قبلی آن گروه حفظ شده است. " : ""}
            {anyTruncated
              ? "دست‌کم یک گروه بیش از ۵٬۰۰۰ مورد دارد و تنها بخشی از آن ذخیره شده است (نشان «ناقص» روی گروه)."
              : ""}
          </span>
        </p>
      ) : null}

      {all.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {[
            { label: "گروه", value: chipTotals.groups },
            { label: "مورد", value: chipTotals.terms },
            { label: "ویژگی", value: chipTotals.attributes },
            // TAX-08: unique mapped products, with the membership total beside
            // it under its own honest name.
            { label: "محصول همگام‌شده", value: chipTotals.mapped },
            { label: "عضویت", value: chipTotals.assignments },
          ].map((chip) => (
            <span
              key={chip.label}
              className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
            >
              {chip.label}: <span className="font-medium text-foreground">{toPersianDigits(chip.value)}</span>
            </span>
          ))}
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            آخرین همگام‌سازی کاتالوگ: {syncedAt ? formatJalali(syncedAt, { withTime: true }) : "—"}
          </span>
          <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
            آخرین درخت موفق: {lastTaxonomySyncAt ? formatJalali(lastTaxonomySyncAt, { withTime: true }) : "—"}
          </span>
        </div>
      ) : null}

      {all.length === 0 && !error ? (
        <EmptyState
          title="هنوز درخت دسته‌بندی دریافت نشده است"
          icon={FolderTreeIcon}
          action={
            <Button type="button" size="sm" variant="outline" disabled={syncing} onClick={() => void remoteSync()}>
              <CloudDownloadIcon className="size-4" aria-hidden="true" />
              همگام‌سازی از وب‌سایت
            </Button>
          }
        >
          با «همگام‌سازی از وب‌سایت» در همین بخش — یا «همگام‌سازی محصولات» در میز کار فروشگاه — دسته‌ها، برچسب‌ها و
          ویژگی‌های فروشگاه اینجا دیده می‌شوند. در حالت افزونه، درخواست در صف قرار می‌گیرد و با اجرای بعدی افزونه
          می‌رسد.
        </EmptyState>
      ) : null}

      {all.length > 0 && visible.length === 0 ? (
        <EmptyState>
          {searching
            ? `موردی با «${query}» پیدا نشد.`
            : "گروهی با این فیلترها پیدا نشد؛ فیلترها را تغییر دهید."}
        </EmptyState>
      ) : null}

      {searching && visible.length > 0 ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {toPersianDigits(hits)} مورد در {toPersianDigits(visible.length)} گروه پیدا شد.
        </p>
      ) : null}

      {visible.map((group) => {
        // Searching opens what it found; the disclosure state is only the
        // owner's collapse of a group they can see.
        const open = searching ? true : !closed[group.taxonomy];
        const status = STATUS_META[group.status];
        const renderLimit = renderLimits[group.taxonomy] ?? RENDER_PAGE;
        const matched = searching
          ? { rows: group.terms.slice(0, renderLimit), hidden: Math.max(0, group.terms.length - renderLimit) }
          : visibleTerms(group, expanded, renderLimit);
        const collapsible = collapsibleKeys(group);
        const allExpanded = collapsible.length > 0 && collapsible.every((key) => expanded[key]);
        return (
          <SectionCard
            key={group.taxonomy}
            flush
            title={
              <span className="flex flex-wrap items-center gap-2">
                {group.isAttribute ? (
                  <TagsIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                ) : (
                  <FolderTreeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
                )}
                <span className="font-semibold text-foreground">{group.label}</span>
                <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                  {group.taxonomy}
                </span>
              </span>
            }
            description={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>
                  {toPersianDigits(group.termCount)} مورد • {toPersianDigits(group.mappedCount)} محصول همگام‌شده •{" "}
                  {toPersianDigits(group.assignmentCount)} عضویت
                </span>
                {group.lastSyncedAt ? (
                  <span>آخرین موفق: {formatJalali(group.lastSyncedAt, { withTime: true })}</span>
                ) : null}
              </span>
            }
            actions={
              searching ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={open}
                  aria-controls={`taxonomy-${group.taxonomy}`}
                  onClick={() =>
                    setClosed((current) => ({ ...current, [group.taxonomy]: !current[group.taxonomy] }))
                  }
                >
                  {open ? "بستن" : "باز کردن"}
                  <ChevronDownIcon
                    aria-hidden="true"
                    className={`size-4 transition-transform duration-200 ease-out ${open ? "" : "-rotate-90"}`}
                  />
                </Button>
              )
            }
          >
            <div id={`taxonomy-${group.taxonomy}`} hidden={!open}>
              {group.status === "failed" ? (
                <p className="flex items-start gap-2 border-b border-border/80 bg-red-50/60 px-4 py-2.5 text-xs leading-5 text-red-800 sm:px-5 dark:bg-red-500/10 dark:text-red-200">
                  <AlertTriangleIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
                  <span>
                    آخرین خواندن این گروه از وب‌سایت ناموفق بود
                    {group.lastError ? `: ${group.lastError}` : ""}. داده‌های نمایشی از آخرین همگام‌سازی موفق است.
                  </span>
                </p>
              ) : null}
              {group.status === "truncated" ? (
                <p className="border-b border-border/80 bg-amber-50/60 px-4 py-2.5 text-xs leading-5 text-amber-900 sm:px-5 dark:bg-amber-500/10 dark:text-amber-200">
                  این گروه در فروشگاه بیش از ۵٬۰۰۰ مورد دارد؛ تنها ۵٬۰۰۰ مورد اول ذخیره شده است.
                </p>
              ) : null}
              {group.terms.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground sm:px-5">
                  {group.status === "failed"
                    ? "داده‌ای از این گروه در دست نیست."
                    : group.status === "pending"
                      ? "این گروه هنوز از وب‌سایت خوانده نشده است."
                      : "این گروه در فروشگاه موردی ندارد."}
                </p>
              ) : (
                <>
                  {!searching && collapsible.length > 0 ? (
                    <div className="flex items-center justify-between border-b border-border/80 px-4 py-1.5 sm:px-5">
                      <span className="text-[11px] text-muted-foreground">
                        {toPersianDigits(group.termCount)} مورد — زیرگروه‌ها با کلیک باز می‌شوند
                      </span>
                      <button
                        type="button"
                        className="text-[11px] font-medium text-primary hover:underline"
                        onClick={() =>
                          setExpanded((current) => {
                            const next = { ...current };
                            for (const key of collapsible) {
                              if (allExpanded) delete next[key];
                              else next[key] = true;
                            }
                            return next;
                          })
                        }
                      >
                        {allExpanded ? "بستن همهٔ زیرگروه‌ها" : "باز کردن همهٔ زیرگروه‌ها"}
                      </button>
                    </div>
                  ) : null}
                  <ul className="divide-y divide-border/80">
                    {matched.rows.map((term) => {
                      const key = `${group.taxonomy}:${term.remoteId}`;
                      const hasChildren = !searching && collapsible.includes(key);
                      const isOpen = Boolean(expanded[key]);
                      return (
                        <li
                          key={term.remoteId}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2.5 sm:px-5"
                        >
                          <span className="flex min-w-0 items-center gap-1.5" style={indentStyle(term.depth)}>
                            {hasChildren ? (
                              <button
                                type="button"
                                aria-expanded={isOpen}
                                aria-label={isOpen ? `بستن زیرگروه‌های ${term.name || term.slug}` : `باز کردن زیرگروه‌های ${term.name || term.slug}`}
                                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                onClick={() =>
                                  setExpanded((current) => ({ ...current, [key]: !current[key] }))
                                }
                              >
                                <ChevronDownIcon
                                  aria-hidden="true"
                                  className={`size-3.5 transition-transform duration-200 ease-out ${isOpen ? "" : "-rotate-90"}`}
                                />
                              </button>
                            ) : term.depth > 0 ? (
                              <span aria-hidden="true" className="text-muted-foreground">
                                └
                              </span>
                            ) : null}
                            <span className="min-w-0 truncate text-sm text-foreground" title={term.path || term.name}>
                              {term.name || "—"}
                            </span>
                            {term.slug ? (
                              <span dir="ltr" className="hidden shrink-0 font-mono text-[10px] text-muted-foreground sm:inline">
                                {term.slug}
                              </span>
                            ) : null}
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            در فروشگاه: {toPersianDigits(term.remoteCount)} • همگام‌شده:{" "}
                            {toPersianDigits(term.mappedCount)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {matched.hidden > 0 ? (
                    <div className="border-t border-border/80 px-4 py-2 text-center sm:px-5">
                      <button
                        type="button"
                        className="text-xs font-medium text-primary hover:underline"
                        onClick={() =>
                          setRenderLimits((current) => ({
                            ...current,
                            [group.taxonomy]: (current[group.taxonomy] ?? RENDER_PAGE) + RENDER_PAGE,
                          }))
                        }
                      >
                        نمایش {toPersianDigits(Math.min(matched.hidden, RENDER_PAGE))} مورد دیگر (از{" "}
                        {toPersianDigits(matched.hidden)} مورد پنهان)
                      </button>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </SectionCard>
        );
      })}
    </div>
  );
}
