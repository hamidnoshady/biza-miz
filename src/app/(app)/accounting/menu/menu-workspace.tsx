"use client";

/**
 * The `/accounting/menu` workspace shell — issue #844.
 *
 * One page, one permission-aware tab strip: «آیتم‌ها» / «دسته‌ها» /
 * «افزودنی‌ها» / «تاریخچه قیمت». It loads the canonical menu tree (the same
 * `/api/menu` the POS sells from, through `toRestaurantMenu`) plus the
 * items-tab «آخرین تغییر قیمت» column, owns the create/edit item Sheet and
 * the dedicated price-change dialog, and hands each tab its slice of the data
 * with one shared mutation runner — every panel mutates through the same
 * `run`, so busy state, error copy and the post-mutation reload are
 * identical everywhere.
 *
 * No import/export, no Settings rail: bulk file movement lives only in
 * «ورود و خروج داده» (Data Transfer).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { MoreHorizontalIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  LoadingSkeleton,
  PageHeader,
  PageShell,
  TabBar,
  TabPanel,
  type Tab,
} from "@/app/dashboard/page-chrome";
import { ErrorBox, api, errorMessage } from "@/app/dashboard/ui";
import {
  toRestaurantMenu,
  type MenuTreePayload,
  type RestaurantMenuData,
  type RestaurantMenuItem,
} from "@/lib/restaurant-menu";
import type { PriceChangeSource } from "@/lib/menu-price-sources";
import { ItemsPanel } from "./items-panel";
import { CategoriesPanel } from "./categories-panel";
import { ModifiersPanel } from "./modifiers-panel";
import { PriceHistoryPanel } from "./price-history-panel";
import { ItemSheet } from "./item-sheet";
import { PriceChangeDialog } from "./price-change-dialog";

type TabKey = "items" | "categories" | "modifiers" | "history";

const TABS: readonly Tab<TabKey>[] = [
  { key: "items", label: "آیتم‌ها" },
  { key: "categories", label: "دسته‌ها" },
  { key: "modifiers", label: "افزودنی‌ها" },
  { key: "history", label: "تاریخچه قیمت" },
];

/** What `GET /api/menu/price-history?latest=1` answers for the items column. */
export type LatestChange = {
  changedAt: string;
  oldPriceRial: number;
  newPriceRial: number;
  source: PriceChangeSource;
};
export type LatestChanges = Record<string, LatestChange>;

/**
 * One mutation: busy → call → surface the Persian error (both on the page and
 * back to the caller, so a dialog can keep itself open with the reason) →
 * reload on success. The response body is passed through so callers can read
 * server facts (a created id, a `deactivated` flag).
 */
export type Runner = <T extends Record<string, unknown>>(
  fn: () => Promise<{ ok: boolean; data: T }>,
) => Promise<{ ok: boolean; error?: string; data: T }>;

export function MenuWorkspace({ canEdit }: { canEdit: boolean }) {
  const [data, setData] = useState<RestaurantMenuData | null>(null);
  const [latest, setLatest] = useState<LatestChanges>({});
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<TabKey>("items");

  // The item Sheet and the price dialog are workspace-level because more than
  // one surface opens them (header CTA, row menu, detail card).
  const [sheet, setSheet] = useState<
    | null
    | { mode: "create" }
    | { mode: "edit"; itemId: string; focusAddons?: boolean }
  >(null);
  const [priceItemId, setPriceItemId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoadFailed(false);
    try {
      const [tree, latestResult] = await Promise.all([
        api<MenuTreePayload>("/api/menu"),
        api<{ latest?: LatestChanges }>("/api/menu/price-history?latest=1"),
      ]);
      if (!tree.ok) {
        setLoadFailed(true);
        return;
      }
      setData(toRestaurantMenu(tree.data));
      setLatest(latestResult.ok ? (latestResult.data.latest ?? {}) : {});
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const run = useCallback<Runner>(
    // The generic signature is the exported `Runner`; fn's body type flows
    // straight through to the resolved value.
    async <T extends Record<string, unknown>>(
      fn: () => Promise<{ ok: boolean; data: T }>,
    ) => {
      setBusy(true);
      setError("");
      setNotice("");
      let result: { ok: boolean; data: T };
      try {
        result = await fn();
      } catch {
        setBusy(false);
        const message = "ارتباط با سرور برقرار نشد. دوباره تلاش کنید.";
        setError(message);
        return { ok: false as const, error: message, data: {} as T };
      }
      setBusy(false);
      if (!result.ok) {
        const code =
          typeof result.data.error === "string" ? (result.data.error as string) : undefined;
        const message = errorMessage(code);
        setError(message);
        return { ok: false as const, error: message, data: result.data };
      }
      await reload();
      return { ok: true as const, data: result.data };
    },
    [reload],
  );

  const itemsById = useMemo(
    () => new Map((data?.items ?? []).map((item) => [item.id, item])),
    [data],
  );
  const priceItem = priceItemId ? (itemsById.get(priceItemId) ?? null) : null;
  const sheetItemId = sheet?.mode === "edit" ? sheet.itemId : null;
  const sheetItem = sheetItemId ? (itemsById.get(sheetItemId) ?? null) : null;

  const headerActions = (
    <>
      {canEdit ? (
        <Button onClick={() => setSheet({ mode: "create" })}>
          <PlusIcon className="size-4" data-icon="inline-start" />
          افزودن آیتم
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="icon" aria-label="گزینه‌های بیشتر">
            <MoreHorizontalIcon className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem
            onSelect={() => {
              setError("");
              setNotice("");
              void reload();
            }}
          >
            <RefreshCwIcon className="size-4" />
            تازه‌سازی فهرست
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <PageShell>
      <PageHeader
        title="مدیریت منو"
        description="آیتم‌ها، دسته‌ها، افزودنی‌ها و تاریخچهٔ قیمت منوی این شعبه. تغییر قیمت از مسیر اختصاصی و ثبت‌شده انجام می‌شود."
        actions={headerActions}
      />
      <ErrorBox>{error}</ErrorBox>
      {notice ? (
        <p className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
          {notice}
        </p>
      ) : null}

      <TabBar
        idPrefix="menu-workspace"
        label="بخش‌های مدیریت منو"
        tabs={TABS}
        active={tab}
        onChange={setTab}
        className="mb-4 overflow-x-auto"
      />

      {loadFailed ? (
        <div className="space-y-4">
          <ErrorBox>بارگذاری منو ممکن نشد. اتصال را بررسی و دوباره تلاش کنید.</ErrorBox>
          <Button variant="outline" onClick={() => void reload()}>
            تلاش دوباره
          </Button>
        </div>
      ) : !data ? (
        <LoadingSkeleton rows={4} />
      ) : (
        <TabPanel idPrefix="menu-workspace" active={tab}>
          {tab === "items" ? (
            <ItemsPanel
              data={data}
              latest={latest}
              canEdit={canEdit}
              busy={busy}
              run={run}
              onOpenItem={(item, focusAddons) =>
                setSheet(
                  item === null
                    ? { mode: "create" }
                    : { mode: "edit", itemId: item.id, focusAddons },
                )
              }
              onChangePrice={(item) => setPriceItemId(item.id)}
            />
          ) : null}
          {tab === "categories" ? (
            <CategoriesPanel
              data={data}
              canEdit={canEdit}
              busy={busy}
              run={run}
              onNotice={setNotice}
            />
          ) : null}
          {tab === "modifiers" ? <ModifiersPanel
              data={data}
              canEdit={canEdit}
              run={run}
              onNotice={setNotice}
            /> : null}
          {tab === "history" ? <PriceHistoryPanel data={data} /> : null}
        </TabPanel>
      )}

      {sheet && (sheet.mode === "create" || sheetItem) ? (
        <ItemSheet
          mode={sheet.mode}
          item={sheet.mode === "edit" ? sheetItem : null}
          initialFocusAddons={sheet.mode === "edit" ? (sheet.focusAddons ?? false) : false}
          data={
            data ?? { categories: [], items: [], modifierGroups: [], modifiers: [], itemModifierGroups: [] }
          }
          run={run}
          onClose={() => setSheet(null)}
          onCreated={(id) => {
            setNotice("");
            setSheet({ mode: "edit", itemId: id });
          }}
          onChangePrice={(item) => setPriceItemId(item.id)}
        />
      ) : null}

      {priceItem ? (
        <PriceChangeDialog
          item={priceItem}
          run={run}
          onClose={() => setPriceItemId(null)}
          onNotice={setNotice}
        />
      ) : null}
    </PageShell>
  );
}
