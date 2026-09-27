"use client";

/**
 * «کتابخانهٔ رسانه» — the library screen (migration 0149).
 *
 * One grid over `/api/media` with the organizing tools around it: the visual
 * folder tree (a path strip + folder chips, not a filesystem widget), the
 * kind/category/tag/source filters, sorting, real pagination, upload, and the
 * per-asset drawer where the operator renames, files, tags — and decides the
 * fate of an AI proposal. Auto-tagging never applies itself: a proposal
 * renders as an amber "pending" strip with تأیید/رد, and only تأیید copies it
 * into the real columns.
 *
 * Search follows the same debounce + AbortController + stale-response guard
 * as the WordPress media mirror (`websites/wp/media-section.tsx`) rather than
 * a second implementation of the same three rules.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { toPersianDigits } from "@/lib/digits";
import {
  MEDIA_KIND_LABELS,
  MEDIA_SORTS,
  MEDIA_SORT_LABELS,
  MEDIA_VARIATIONS_COUNT,
  type MediaAssetVariant,
  type MediaKind,
  type MediaSort,
} from "@/lib/media";
import { summarizeUploadResults, uploadFiles, type UploadProgressEvent } from "@/lib/media-uploader";
import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge, cardClass } from "../page-chrome";
import { FilterChip } from "../filters";
import { api, ErrorBox, Field, InfoBox, inputClass } from "../ui";

const PAGE_SIZE = 60;

interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  assetCount: number;
}

export interface AssetRow {
  id: string;
  folderId: string | null;
  kind: MediaKind;
  fileName: string;
  mimeType: string;
  byteSize: number;
  category: string | null;
  tags: string[];
  aiStatus: "none" | "pending_review" | "confirmed" | "rejected";
  aiLabels: { category?: string | null; tags?: string[]; description?: string };
  variant: MediaAssetVariant;
  sourceAssetId: string | null;
  source: "upload" | "ai_attachment" | "ai_generated" | "ocr_receipt" | "ocr_invoice";
  createdByAi: boolean;
  createdAt: string;
}

interface MediaAssetUsageRef {
  id: string;
  name: string;
}
interface MediaAssetUsage {
  menuItems: MediaAssetUsageRef[];
  inventoryItems: MediaAssetUsageRef[];
  /** Migration 0177 — expenses recorded from this asset's receipt photo. */
  expenses: MediaAssetUsageRef[];
  /** Migration 0179 — draft purchases scanned from this asset's invoice photo. */
  purchases: MediaAssetUsageRef[];
  /** Migration 0181 — parties whose avatar this asset is. */
  parties: MediaAssetUsageRef[];
}

/** A version-history entry — an ancestor or a direct descendant of the open asset. */
interface MediaAssetLineageEntry {
  id: string;
  fileName: string;
  variant: MediaAssetVariant;
}

/** `getMediaAssetLineage`'s shape — the drawer's "سابقهٔ نسخه‌ها" panel. */
interface MediaAssetLineage {
  ancestors: MediaAssetLineageEntry[];
  descendants: MediaAssetLineageEntry[];
}

interface CollectionRow {
  id: string;
  name: string;
  description: string | null;
  assetCount: number;
}

interface WpMappingRow {
  status: "pending" | "synced" | "failed";
  wpUrl: string | null;
  lastError: string | null;
}
interface WpPushConnection {
  id: string;
  name: string;
  canPush: boolean;
  mapping: WpMappingRow | null;
}

interface LibraryPayload {
  assets: AssetRow[];
  total: number;
  folders: FolderRow[];
  facets: { categories: string[]; tags: string[] };
  usage: { totalBytes: number; assetCount: number };
  storage: {
    ready: boolean;
    billingEnabled: boolean;
    dailyFlatRial: number;
    dailyPerGbRial: number;
    freeQuotaMb: number;
    enhancePriceRial: number;
  };
}

const UPLOAD_STATUS_LABELS: Record<UploadProgressEvent["status"], string> = {
  queued: "در صف",
  uploading: "در حال بارگذاری",
  retrying: "تلاش دوباره…",
  success: "موفق",
  error: "ناموفق",
  canceled: "لغو شد",
};

/** Persian label for a lineage entry's variant — same wording the grid's own badges use. */
function lineageVariantLabel(variant: MediaAssetVariant): string {
  switch (variant) {
    case "enhanced":
      return "استاندارد";
    case "bg_removed":
      return "بدون پس‌زمینه";
    case "upscaled":
      return "بزرگ‌نمایی‌شده";
    case "variation":
      return "تنوع";
    case "transformed":
      return "ویرایش‌شده";
    default:
      return "اصلی";
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${toPersianDigits((bytes / (1024 * 1024 * 1024)).toFixed(2))} گیگابایت`;
  if (bytes >= 1024 * 1024) return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1))} مگابایت`;
  if (bytes >= 1024) return `${toPersianDigits(Math.round(bytes / 1024))} کیلوبایت`;
  return `${toPersianDigits(bytes)} بایت`;
}

const KIND_FILTERS: { key: "all" | MediaKind; label: string }[] = [
  { key: "all", label: "همه" },
  { key: "image", label: "تصاویر" },
  { key: "video", label: "ویدیوها" },
  { key: "document", label: "اسناد" },
];

const SOURCE_FILTERS: { key: "all" | AssetRow["source"]; label: string }[] = [
  { key: "all", label: "همهٔ منابع" },
  { key: "upload", label: "بارگذاری‌شده" },
  { key: "ai_generated", label: "ساختهٔ هوش مصنوعی" },
  { key: "ai_attachment", label: "از گفت‌وگو" },
  { key: "ocr_receipt", label: "رسید هزینه" },
  { key: "ocr_invoice", label: "فاکتور خرید" },
];

interface FolderTreeActions {
  activeFolderId: string | "root" | null;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string | "root" | null) => void;
  onRename: (folder: FolderRow) => void;
  onStartMove: (folder: FolderRow) => void;
  onDelete: (folder: FolderRow) => void;
  onCreateChild: (parentId: string | null) => void;
}

/**
 * One tree node: expand/collapse toggle (only when it has children),
 * select-into, and the same rename/move/delete/new-subfolder actions the
 * flat chip row already offered — kept always visible (not hover-only), so
 * the tree works the same on a touchscreen as with a mouse.
 */
function FolderTreeNode({ folder, depth, childrenByParent, actions }: {
  folder: FolderRow;
  depth: number;
  childrenByParent: Map<string | null, FolderRow[]>;
  actions: FolderTreeActions;
}) {
  const children = childrenByParent.get(folder.id) ?? [];
  const isOpen = actions.expanded.has(folder.id);
  const isActive = actions.activeFolderId === folder.id;
  return (
    <li>
      <div className="flex items-center gap-0.5 py-0.5" style={{ paddingInlineStart: depth * 14 }}>
        {children.length > 0 ? (
          <button
            type="button"
            aria-label={isOpen ? `بستن پوشهٔ ${folder.name}` : `بازکردن پوشهٔ ${folder.name}`}
            aria-expanded={isOpen}
            onClick={() => actions.onToggle(folder.id)}
            className="grid size-5 shrink-0 place-items-center rounded text-xs text-muted-foreground hover:bg-muted"
          >
            {isOpen ? "▾" : "◂"}
          </button>
        ) : (
          <span className="inline-block size-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => actions.onSelect(folder.id)}
          className={`flex min-w-0 flex-1 items-center gap-1.5 truncate rounded-lg px-2 py-1 text-start text-sm transition-colors ${isActive ? "bg-amber-100 font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
        >
          <span aria-hidden="true">📁</span>
          <span className="truncate">{folder.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{toPersianDigits(folder.assetCount)}</span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            aria-label={`پوشهٔ جدید داخل ${folder.name}`}
            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => actions.onCreateChild(folder.id)}
          >
            +
          </button>
          <button
            type="button"
            aria-label={`ویرایش نام پوشهٔ ${folder.name}`}
            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => actions.onRename(folder)}
          >
            ✎
          </button>
          <button
            type="button"
            aria-label={`جابه‌جایی پوشهٔ ${folder.name}`}
            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => actions.onStartMove(folder)}
          >
            ⇄
          </button>
          <button
            type="button"
            aria-label={`حذف پوشهٔ ${folder.name}`}
            className="rounded px-1 text-xs text-destructive hover:bg-muted"
            onClick={() => actions.onDelete(folder)}
          >
            ✕
          </button>
        </span>
      </div>
      {isOpen && children.length > 0 ? (
        <ul>
          {children.map((child) => (
            <FolderTreeNode key={child.id} folder={child} depth={depth + 1} childrenByParent={childrenByParent} actions={actions} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The visual folder explorer: the whole hierarchy at once (not just the
 * current level, unlike the breadcrumb + child-chip row above it), with
 * "همهٔ فایل‌ها" (every asset, no folder filter) and "ریشه" (assets with no
 * folder) as its two permanent top entries. Reused verbatim inline on
 * desktop and inside a `Sheet` drawer on mobile — one component, one set of
 * behaviors, two mount points.
 */
function FolderTreeExplorer({ folders, childrenByParent, actions }: {
  folders: FolderRow[];
  childrenByParent: Map<string | null, FolderRow[]>;
  actions: FolderTreeActions;
}) {
  const roots = childrenByParent.get(null) ?? [];
  return (
    <ul className="max-h-72 space-y-0.5 overflow-y-auto overscroll-contain pe-1 text-sm" aria-label="درخت پوشه‌ها">
      <li>
        <button
          type="button"
          onClick={() => actions.onSelect(null)}
          className={`w-full rounded-lg px-2 py-1 text-start transition-colors ${actions.activeFolderId === null ? "bg-amber-100 font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
        >
          🗂️ همهٔ فایل‌ها <span className="text-xs text-muted-foreground">({toPersianDigits(folders.reduce((n, f) => n + f.assetCount, 0))})</span>
        </button>
      </li>
      <li>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => actions.onSelect("root")}
            className={`flex-1 rounded-lg px-2 py-1 text-start transition-colors ${actions.activeFolderId === "root" ? "bg-amber-100 font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            📁 ریشه (بدون پوشه)
          </button>
          <button
            type="button"
            aria-label="پوشهٔ جدید در ریشه"
            className="rounded px-1 text-xs text-muted-foreground hover:bg-muted"
            onClick={() => actions.onCreateChild(null)}
          >
            +
          </button>
        </div>
        {roots.length > 0 ? (
          <ul>
            {roots.map((folder) => (
              <FolderTreeNode key={folder.id} folder={folder} depth={1} childrenByParent={childrenByParent} actions={actions} />
            ))}
          </ul>
        ) : null}
      </li>
    </ul>
  );
}

export function MediaManager() {
  const [payload, setPayload] = useState<Omit<LibraryPayload, "assets" | "total"> | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // Filters
  const [folderId, setFolderId] = useState<string | "root" | null>(null); // null = everywhere
  const [kind, setKind] = useState<"all" | MediaKind>("all");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const [source, setSource] = useState<"all" | AssetRow["source"]>("all");
  const [sort, setSort] = useState<MediaSort>("newest");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [pendingOnly, setPendingOnly] = useState(false);

  const [selected, setSelected] = useState<AssetRow | null>(null);
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [movingFolderId, setMovingFolderId] = useState<string | null>(null);
  // Visual folder explorer: which nodes of the *whole* tree (not just the
  // current level) are expanded. New folders default to expanded so a
  // freshly-created subfolder is visible immediately; the operator's own
  // collapses on other branches are preserved across reloads.
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set());
  const [folderExplorerOpen, setFolderExplorerOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // The central uploader (src/lib/media-uploader.ts) drives every batch: this
  // is only the progress list the operator watches and the cancel switch, in
  // the same "one implementation, a view on top of it" spirit as the search
  // debounce shared with the WordPress mirror.
  const [uploadEvents, setUploadEvents] = useState<UploadProgressEvent[]>([]);
  const uploadCancelRef = useRef<(() => void) | null>(null);
  const seenFolderIds = useRef<Set<string>>(new Set());

  // Trash — a second view over the same grid, not a second screen: the
  // library's own filters (folder/kind/category/tag) do not apply to a view
  // whose only questions are "what did I recently delete" and "restore or
  // purge it".
  const [viewMode, setViewMode] = useState<"library" | "trash">("library");

  // Collections — an ad hoc set an asset can belong to any number of,
  // distinct from the (single-parent) folder tree above.
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [collectionId, setCollectionId] = useState<string | null>(null);

  // Multi-select bulk actions.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const requestRef = useRef(0);

  // Debounce the free-text search 300ms — same window the WordPress media
  // mirror uses — before it becomes part of the query.
  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchInput]);

  const load = useCallback(
    (offset: number, append: boolean) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const requestId = ++requestRef.current;

      if (append) setLoadingMore(true);
      else setLoading(true);

      const params = new URLSearchParams();
      if (viewMode === "trash") {
        params.set("trashed", "1");
      } else {
        if (folderId) params.set("folderId", folderId);
        if (kind !== "all") params.set("kind", kind);
        if (category) params.set("category", category);
        if (tag) params.set("tag", tag);
        if (source !== "all") params.set("source", source);
        if (collectionId) params.set("collectionId", collectionId);
        if (pendingOnly) params.set("aiStatus", "pending_review");
      }
      if (search) params.set("search", search);
      if (sort !== "newest") params.set("sort", sort);
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(offset));

      api<LibraryPayload>(`/api/media?${params.toString()}`, { signal: controller.signal }).then(
        ({ ok, data, aborted }) => {
          if (aborted || requestId !== requestRef.current) return;
          setLoading(false);
          setLoadingMore(false);
          if (!ok) {
            setError("خواندن کتابخانه ناموفق بود.");
            return;
          }
          setError("");
          setPayload({ folders: data.folders, facets: data.facets, usage: data.usage, storage: data.storage });
          setTotal(data.total);
          setAssets((current) => (append ? [...current, ...data.assets] : data.assets));
        },
      );
    },
    [viewMode, folderId, kind, category, tag, source, collectionId, search, pendingOnly, sort],
  );

  // Any filter/sort/search/view change resets to the first page; the effect
  // itself is the single place a fresh (non-append) load happens.
  useEffect(() => {
    load(0, false);
    return () => abortRef.current?.abort();
  }, [load]);

  const loadCollections = useCallback(() => {
    api<{ collections: CollectionRow[] }>("/api/media/collections").then(({ ok, data }) => {
      if (ok) setCollections(data.collections);
    });
  }, []);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  function reload() {
    load(0, false);
    loadCollections();
  }

  // Leaving select mode, switching views, or changing the filters that
  // reshuffle the grid all invalidate whatever was checked.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [viewMode, folderId, kind, category, tag, source, collectionId, search, sort]);

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    setNotice("");
    const list = Array.from(files);
    setUploadEvents(list.map((file, index) => ({ id: `${index}:${file.name}:${file.size}:${file.lastModified}`, file, status: "queued", attempt: 0 })));
    const { done, cancel } = uploadFiles(list, {
      folderId: folderId && folderId !== "root" ? folderId : null,
      onProgress: (event) => {
        setUploadEvents((current) => {
          const next = current.filter((e) => e.id !== event.id);
          next.push(event);
          return next;
        });
      },
    });
    uploadCancelRef.current = cancel;
    const results = await done;
    uploadCancelRef.current = null;
    const { stored, reused, failed, canceled } = summarizeUploadResults(results);
    const parts: string[] = [];
    if (stored > 0) parts.push(`${toPersianDigits(stored)} فایل ذخیره شد`);
    if (reused > 0) parts.push(`${toPersianDigits(reused)} فایل از قبل در کتابخانه بود و دوباره اضافه نشد`);
    if (canceled > 0) parts.push(`${toPersianDigits(canceled)} فایل لغو شد`);
    if (failed > 0) {
      const firstFailure = results.find((r) => r.status === "error");
      parts.push(`${toPersianDigits(failed)} فایل بارگذاری نشد${firstFailure?.message ? ` (${firstFailure.message})` : ""}`);
    }
    // Every other mutating action in this screen calls `reload()` only on
    // its own success path, so it and a freshly-set `error` never collide.
    // An upload batch is the one action that must `reload()` even after a
    // *partial* failure (the files that did succeed still belong in the
    // grid) — so its summary, including the failed count, goes into
    // `notice`, not the shared `error` state `load()`'s own success handler
    // unconditionally clears. The per-file "ناموفق" row above already
    // carries the visual weight of a failure; this line is just the count.
    if (parts.length > 0) setNotice(`${parts.join("؛ ")}.`);
    setBusy(false);
    // The per-file panel itself is cleared on the *next* click of
    // "بارگذاری فایل", not immediately — the operator should still see the
    // finished list (what succeeded, what failed) until they choose to
    // upload again, not have it vanish under them the instant the batch
    // settles.
    reload();
  }

  function cancelUpload() {
    uploadCancelRef.current?.();
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setBusy(true);
    const { ok, data: body } = await api<{ message?: string }>("/api/media/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId: folderId && folderId !== "root" ? folderId : null }),
    });
    setBusy(false);
    if (!ok) {
      setError(body.message ?? "ساخت پوشه ناموفق بود.");
      return;
    }
    setNewFolderName("");
    setCreatingFolder(false);
    reload();
  }

  async function renameFolder(folder: FolderRow) {
    const name = window.prompt("نام جدید پوشه", folder.name)?.trim();
    if (!name || name === folder.name) return;
    const { ok, data } = await api<{ message?: string }>(`/api/media/folders/${folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    });
    if (!ok) {
      setError(data.message ?? "تغییر نام پوشه ناموفق بود.");
      return;
    }
    reload();
  }

  async function moveFolder(folder: FolderRow, newParentId: string | null) {
    const { ok, data } = await api<{ message?: string }>(`/api/media/folders/${folder.id}`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: newParentId }),
    });
    setMovingFolderId(null);
    if (!ok) {
      setError(data.message ?? "جابه‌جایی پوشه ناموفق بود.");
      return;
    }
    reload();
  }

  async function deleteFolder(folder: FolderRow) {
    if (!window.confirm(`پوشهٔ «${folder.name}» حذف شود؟ زیرپوشه‌ها هم حذف می‌شوند و فایل‌های داخل آن‌ها به ریشه منتقل می‌شوند.`)) return;
    const { ok, data } = await api<{ message?: string }>(`/api/media/folders/${folder.id}`, { method: "DELETE" });
    if (!ok) {
      setError(data.message ?? "حذف پوشه ناموفق بود.");
      return;
    }
    if (folderId === folder.id) setFolderId(null);
    reload();
  }

  async function restoreAsset(assetId: string) {
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(`/api/media/${assetId}/restore`, { method: "POST" });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "بازیابی فایل ناموفق بود.");
      return;
    }
    setNotice("فایل از سطل زباله بازیابی شد.");
    reload();
  }

  async function purgeAsset(assetId: string) {
    if (!window.confirm("این فایل برای همیشه حذف شود؟ این کار قابل بازگشت نیست.")) return;
    setBusy(true);
    const { ok, data } = await api<{ message?: string }>(`/api/media/${assetId}?purge=1`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "حذف همیشگی ناموفق بود.");
      return;
    }
    setNotice("فایل برای همیشه حذف شد.");
    reload();
  }

  async function createCollection() {
    const name = window.prompt("نام مجموعهٔ جدید")?.trim();
    if (!name) return;
    const { ok, data } = await api<{ message?: string }>("/api/media/collections", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!ok) {
      setError(data.message ?? "ساخت مجموعه ناموفق بود.");
      return;
    }
    loadCollections();
  }

  async function deleteCollection(collection: CollectionRow) {
    if (!window.confirm(`مجموعهٔ «${collection.name}» حذف شود؟ فایل‌های داخل آن حذف نمی‌شوند، فقط از این مجموعه خارج می‌شوند.`)) return;
    const { ok, data } = await api<{ message?: string }>(`/api/media/collections/${collection.id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setError(data.message ?? "حذف مجموعه ناموفق بود.");
      return;
    }
    if (collectionId === collection.id) setCollectionId(null);
    loadCollections();
  }

  // Bulk actions — every one iterates the selection sequentially and reports
  // how many succeeded, the same "N ذخیره شد / M ..." shape as multi-file upload.
  async function bulkDelete() {
    if (selectedIds.size === 0) return;
    if (!window.confirm(`${toPersianDigits(selectedIds.size)} مورد به سطل زباله منتقل شود؟`)) return;
    setBulkBusy(true);
    let done = 0;
    for (const id of selectedIds) {
      const { ok } = await api(`/api/media/${id}`, { method: "DELETE" });
      if (ok) done += 1;
    }
    setBulkBusy(false);
    setSelectedIds(new Set());
    setNotice(`${toPersianDigits(done)} مورد به سطل زباله منتقل شد.`);
    reload();
  }

  async function bulkMoveToFolder(targetFolderId: string | null) {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    let done = 0;
    for (const id of selectedIds) {
      const { ok } = await api(`/api/media/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ folderId: targetFolderId }),
      });
      if (ok) done += 1;
    }
    setBulkBusy(false);
    setSelectedIds(new Set());
    setNotice(`${toPersianDigits(done)} مورد جابه‌جا شد.`);
    reload();
  }

  async function bulkAddToCollection(targetCollectionId: string) {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    let done = 0;
    for (const id of selectedIds) {
      const { ok } = await api(`/api/media/collections/${targetCollectionId}/items`, {
        method: "POST",
        body: JSON.stringify({ assetId: id }),
      });
      if (ok) done += 1;
    }
    setBulkBusy(false);
    setSelectedIds(new Set());
    setNotice(`${toPersianDigits(done)} مورد به مجموعه اضافه شد.`);
    loadCollections();
  }

  const folders = useMemo(() => payload?.folders ?? [], [payload]);
  const currentFolder = folderId && folderId !== "root" ? folders.find((f) => f.id === folderId) : null;
  const visibleFolders = folders.filter((f) =>
    folderId === null || folderId === "root" ? f.parentId === null : f.parentId === folderId,
  );

  // Every folder's children, for the tree explorer below.
  const childrenByParent = new Map<string | null, FolderRow[]>();
  for (const f of folders) {
    const key = f.parentId;
    const list = childrenByParent.get(key);
    if (list) list.push(f);
    else childrenByParent.set(key, [f]);
  }

  // Newly-seen folders (freshly created, or the very first load) start
  // expanded; a folder the operator explicitly collapsed stays collapsed
  // across reloads instead of snapping back open under them.
  useEffect(() => {
    setTreeExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const f of folders) {
        if (!seenFolderIds.current.has(f.id)) {
          next.add(f.id);
          changed = true;
        }
        seenFolderIds.current.add(f.id);
      }
      return changed ? next : prev;
    });
  }, [folders]);

  /** Every folder except `folder` itself and its own descendants — the legal move targets. */
  function eligibleMoveTargets(folder: FolderRow): FolderRow[] {
    const descendants = new Set<string>([folder.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of folders) {
        if (f.parentId && descendants.has(f.parentId) && !descendants.has(f.id)) {
          descendants.add(f.id);
          grew = true;
        }
      }
    }
    return folders.filter((f) => !descendants.has(f.id));
  }

  /** The path strip above the grid: ریشه / تصاویر منو / نوشیدنی‌ها. */
  function folderPath(): FolderRow[] {
    const path: FolderRow[] = [];
    let cursor: FolderRow | undefined = currentFolder ?? undefined;
    while (cursor && path.length <= 8) {
      path.unshift(cursor);
      const parentId: string | null = cursor.parentId;
      cursor = parentId ? folders.find((f) => f.id === parentId) : undefined;
    }
    return path;
  }

  function toggleTreeNode(id: string) {
    setTreeExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectFolderFromExplorer(id: string | "root" | null) {
    setFolderId(id);
    setFolderExplorerOpen(false); // no-op on desktop, closes the mobile drawer
  }

  function startCreateChildFolder(parentId: string | null) {
    setFolderId(parentId ?? "root");
    setCreatingFolder(true);
    setFolderExplorerOpen(false);
  }

  const treeActions: FolderTreeActions = {
    activeFolderId: folderId,
    expanded: treeExpanded,
    onToggle: toggleTreeNode,
    onSelect: selectFolderFromExplorer,
    onRename: renameFolder,
    onStartMove: (folder) => {
      setMovingFolderId(folder.id);
      setFolderExplorerOpen(false);
    },
    onDelete: deleteFolder,
    onCreateChild: startCreateChildFolder,
  };

  // Every filter currently narrowing the grid, as one removable chip each —
  // so "why am I seeing this subset" is answered at a glance instead of by
  // re-reading five separate dropdowns, and clearing one doesn't require
  // hunting down which control set it.
  const activeFilterChips: { key: string; label: string; onClear: () => void }[] = [];
  if (kind !== "all") {
    activeFilterChips.push({ key: "kind", label: `نوع: ${MEDIA_KIND_LABELS[kind]}`, onClear: () => setKind("all") });
  }
  if (category) {
    activeFilterChips.push({ key: "category", label: `دسته: ${category}`, onClear: () => setCategory("") });
  }
  if (tag) {
    activeFilterChips.push({ key: "tag", label: `برچسب: ${tag}`, onClear: () => setTag("") });
  }
  if (source !== "all") {
    const sourceLabel = SOURCE_FILTERS.find((s) => s.key === source)?.label ?? source;
    activeFilterChips.push({ key: "source", label: `منبع: ${sourceLabel}`, onClear: () => setSource("all") });
  }
  if (pendingOnly) {
    activeFilterChips.push({ key: "pending", label: "در انتظار تأیید برچسب هوشمند", onClear: () => setPendingOnly(false) });
  }
  if (search) {
    activeFilterChips.push({
      key: "search",
      label: `جست‌وجو: «${search}»`,
      onClear: () => {
        setSearchInput("");
        setSearch("");
      },
    });
  }
  if (collectionId) {
    const activeCollection = collections.find((c) => c.id === collectionId);
    if (activeCollection) {
      activeFilterChips.push({ key: "collection", label: `مجموعه: ${activeCollection.name}`, onClear: () => setCollectionId(null) });
    }
  }

  if (loading && !payload) {
    return (
      <div className="space-y-4">
        <SectionCardSkeleton rows={2} />
        <SectionCardSkeleton rows={4} />
      </div>
    );
  }
  if (!payload) return null;

  return (
    <div className="space-y-4">
      {!payload.storage.ready ? (
        <InfoBox>
          فضای ذخیره‌سازی رسانه هنوز توسط مدیر پلتفرم پیکربندی نشده است؛ تا آن زمان بارگذاری فایل ممکن نیست.
        </InfoBox>
      ) : null}

      {/* Upload progress — one row per file in the current batch, driven by
          src/lib/media-uploader.ts's bounded-concurrency pool. Stays visible
          after the batch settles so the operator can see what failed, and is
          replaced (not merged) the next time a batch starts. */}
      {uploadEvents.length > 0 ? (
        <SectionCard title="وضعیت بارگذاری">
          <div className="space-y-1.5">
            {uploadEvents.map((event) => (
              <div key={event.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate">{event.file.name}</span>
                <span
                  className={
                    event.status === "error"
                      ? "text-destructive"
                      : event.status === "success"
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-muted-foreground"
                  }
                >
                  {UPLOAD_STATUS_LABELS[event.status]}
                  {event.status === "error" && event.message ? ` — ${event.message}` : ""}
                </span>
              </div>
            ))}
          </div>
          {busy && uploadEvents.some((e) => e.status === "queued" || e.status === "uploading" || e.status === "retrying") ? (
            <Button size="sm" variant="outline" className="mt-3" onClick={cancelUpload}>
              لغو بارگذاری
            </Button>
          ) : null}
        </SectionCard>
      ) : null}

      {/* Usage strip */}
      <SectionCard title="فضای مصرفی">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span>
            <span className="text-muted-foreground">فایل‌ها: </span>
            <span className="font-medium">{toPersianDigits(payload.usage.assetCount)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">حجم کل: </span>
            <span className="font-medium">{formatBytes(payload.usage.totalBytes)}</span>
          </span>
          {payload.storage.billingEnabled ? (
            <span className="text-xs text-muted-foreground">
              هزینهٔ نگهداری روزانه از کیف پول کسب‌وکار کسر می‌شود
              {payload.storage.freeQuotaMb > 0
                ? ` (تا ${toPersianDigits(payload.storage.freeQuotaMb)} مگابایت اول مشمول نرخ حجمی نیست)`
                : ""}
              .
            </span>
          ) : null}
        </div>
      </SectionCard>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {/* View switch: the library, or the trash — and, inside the library,
          the multi-select bulk-action bar. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-xl border border-border p-1">
          <button
            type="button"
            onClick={() => setViewMode("library")}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${viewMode === "library" ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            کتابخانه
          </button>
          <button
            type="button"
            onClick={() => setViewMode("trash")}
            className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${viewMode === "trash" ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            سطل زباله
          </button>
        </div>
        {viewMode === "library" ? (
          <Button
            size="sm"
            variant={selectMode ? "default" : "outline"}
            onClick={() => {
              setSelectMode((v) => !v);
              setSelectedIds(new Set());
            }}
          >
            {selectMode ? "پایان انتخاب چندتایی" : "انتخاب چندتایی"}
          </Button>
        ) : null}
      </div>

      {selectMode && selectedIds.size > 0 ? (
        <SectionCard title={`${toPersianDigits(selectedIds.size)} مورد انتخاب‌شده`}>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={inputClass}
              disabled={bulkBusy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) bulkMoveToFolder(e.target.value === "root" ? null : e.target.value);
                e.target.value = "";
              }}
            >
              <option value="" disabled>
                انتقال به پوشه…
              </option>
              <option value="root">ریشه (بدون پوشه)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            {collections.length > 0 ? (
              <select
                className={inputClass}
                disabled={bulkBusy}
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) bulkAddToCollection(e.target.value);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>
                  افزودن به مجموعه…
                </option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : null}
            <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
              {bulkBusy ? "در حال انجام…" : "حذف موارد انتخاب‌شده"}
            </Button>
          </div>
        </SectionCard>
      ) : null}

      {/* Folders + filters */}
      {viewMode === "library" ? (
      <SectionCard
        title="پوشه‌ها و فیلترها"
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setCreatingFolder((v) => !v)}>
              پوشهٔ جدید
            </Button>
            <Button
              size="sm"
              disabled={busy || !payload.storage.ready}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "در حال بارگذاری…" : "بارگذاری فایل"}
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              className="hidden"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,video/mp4,video/webm,video/quicktime,application/pdf,.docx,.xlsx,.csv,.txt"
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        }
      >
        {creatingFolder ? (
          <div className="mb-4 flex items-end gap-2">
            <div className="flex-1">
              <Field label={currentFolder ? `پوشهٔ جدید داخل «${currentFolder.name}»` : "پوشهٔ جدید در ریشه"}>
                <input
                  className={inputClass}
                  value={newFolderName}
                  onChange={(e) => setNewFolderName(e.target.value)}
                  placeholder="مثلاً «تصاویر منو»"
                />
              </Field>
            </div>
            <Button className="mb-4" size="sm" disabled={busy || !newFolderName.trim()} onClick={createFolder}>
              ساخت
            </Button>
          </div>
        ) : null}

        {/* Path strip */}
        <div className="mb-3 flex flex-wrap items-center gap-1 text-sm">
          <button
            type="button"
            onClick={() => setFolderId(null)}
            className={`rounded-lg px-2 py-1 transition-colors ${folderId === null ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            همهٔ فایل‌ها
          </button>
          <button
            type="button"
            onClick={() => setFolderId("root")}
            className={`rounded-lg px-2 py-1 transition-colors ${folderId === "root" ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            ریشه
          </button>
          {folderPath().map((folder) => (
            <span key={folder.id} className="flex items-center gap-1">
              <span className="text-muted-foreground">/</span>
              <button
                type="button"
                onClick={() => setFolderId(folder.id)}
                className={`rounded-lg px-2 py-1 transition-colors ${folderId === folder.id ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
              >
                {folder.name}
              </button>
            </span>
          ))}
          {currentFolder ? (
            <span className="mr-1 flex items-center gap-1">
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={() => renameFolder(currentFolder)}
              >
                ویرایش نام
              </button>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={() => setMovingFolderId(currentFolder.id)}
              >
                جابه‌جایی
              </button>
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs text-destructive hover:bg-destructive/10"
                onClick={() => deleteFolder(currentFolder)}
              >
                حذف پوشه
              </button>
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => setFolderExplorerOpen(true)}
            className="ms-auto rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted md:hidden"
          >
            🗂️ کاوشگر پوشه‌ها
          </button>
        </div>

        {/* Visual folder explorer — the whole tree at once, not just the
            current level. Inline and collapsible on a wide screen; a slide-in
            drawer (the same `Sheet` primitive every other mobile panel in the
            product uses) on a narrow one, opened by the button above. */}
        <details className="mb-3 hidden rounded-xl border border-border md:block" open>
          <summary className="cursor-pointer select-none rounded-xl px-3 py-2 text-sm font-medium text-foreground">
            کاوشگر پوشه‌ها (نمای درختی)
          </summary>
          <div className="border-t border-border px-3 py-2">
            <FolderTreeExplorer folders={folders} childrenByParent={childrenByParent} actions={treeActions} />
          </div>
        </details>

        <Sheet open={folderExplorerOpen} onOpenChange={setFolderExplorerOpen}>
          <SheetContent side="left" aria-label="کاوشگر پوشه‌ها" className="w-full max-w-xs">
            <SheetHeader className="border-b border-border/80 px-4 py-3">
              <SheetTitle>کاوشگر پوشه‌ها</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <FolderTreeExplorer folders={folders} childrenByParent={childrenByParent} actions={treeActions} />
            </div>
          </SheetContent>
        </Sheet>

        {movingFolderId ? (
          (() => {
            const folder = folders.find((f) => f.id === movingFolderId);
            if (!folder) return null;
            const targets = eligibleMoveTargets(folder);
            return (
              <div className="mb-4 flex items-end gap-2 rounded-xl border border-border p-3">
                <div className="flex-1">
                  <Field label={`انتقال «${folder.name}» به`}>
                    <select
                      className={inputClass}
                      defaultValue={folder.parentId ?? ""}
                      onChange={(e) => moveFolder(folder, e.target.value || null)}
                    >
                      <option value="">ریشه (بدون پوشهٔ والد)</option>
                      {targets.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setMovingFolderId(null)}>
                  انصراف
                </Button>
              </div>
            );
          })()
        ) : null}

        {/* Child folders of the current place */}
        {visibleFolders.length > 0 ? (
          <div className="mb-4 flex flex-wrap gap-2">
            {visibleFolders.map((folder) => (
              <div
                key={folder.id}
                className="flex items-center gap-1 rounded-xl border border-border px-1 py-1 text-sm transition-colors hover:bg-muted"
              >
                <button
                  type="button"
                  onClick={() => setFolderId(folder.id)}
                  className="flex items-center gap-2 px-2 py-1"
                >
                  <span aria-hidden>📁</span>
                  <span className="font-medium">{folder.name}</span>
                  <span className="text-xs text-muted-foreground">{toPersianDigits(folder.assetCount)}</span>
                </button>
                <button
                  type="button"
                  aria-label={`ویرایش نام پوشهٔ ${folder.name}`}
                  className="rounded-lg px-1.5 py-1 text-xs text-muted-foreground hover:bg-background"
                  onClick={() => renameFolder(folder)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  aria-label={`جابه‌جایی پوشهٔ ${folder.name}`}
                  className="rounded-lg px-1.5 py-1 text-xs text-muted-foreground hover:bg-background"
                  onClick={() => setMovingFolderId(folder.id)}
                >
                  ⇄
                </button>
                <button
                  type="button"
                  aria-label={`حذف پوشهٔ ${folder.name}`}
                  className="rounded-lg px-1.5 py-1 text-xs text-destructive hover:bg-background"
                  onClick={() => deleteFolder(folder)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Search */}
        <div className="mb-3">
          <input
            className={inputClass}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="جست‌وجو در نام، دسته، برچسب و توضیح…"
          />
        </div>

        {/* Filters */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="flex flex-wrap gap-1">
            {KIND_FILTERS.map((f) => (
              <FilterChip key={f.key} selected={kind === f.key} onClick={() => setKind(f.key)}>
                {f.label}
              </FilterChip>
            ))}
          </div>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">همهٔ دسته‌بندی‌ها</option>
            {payload.facets.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className={inputClass} value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">همهٔ برچسب‌ها</option>
            {payload.facets.tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select className={inputClass} value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
            {SOURCE_FILTERS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <select className={inputClass} value={sort} onChange={(e) => setSort(e.target.value as MediaSort)}>
            {MEDIA_SORTS.map((s) => (
              <option key={s} value={s}>
                {MEDIA_SORT_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="size-4 accent-amber-600"
          />
          فقط موارد در انتظار تأیید برچسب هوشمند
        </label>

        {/* Active-filter chips — every narrowing control above, summarized
            and individually removable, so the operator never has to hunt
            through five dropdowns to see (or undo) why the grid is short. */}
        {activeFilterChips.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">فیلترهای فعال:</span>
            {activeFilterChips.map((chip) => (
              <span
                key={chip.key}
                className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200"
              >
                {chip.label}
                <button
                  type="button"
                  aria-label={`حذف فیلتر: ${chip.label}`}
                  className="rounded-full px-1 hover:bg-amber-200/70 dark:hover:bg-amber-500/30"
                  onClick={chip.onClear}
                >
                  ✕
                </button>
              </span>
            ))}
            {activeFilterChips.length > 1 ? (
              <button
                type="button"
                className="rounded-full px-2 py-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => {
                  for (const chip of activeFilterChips) chip.onClear();
                }}
              >
                پاک کردن همهٔ فیلترها
              </button>
            ) : null}
          </div>
        ) : null}

        {/* Collections — an ad hoc set, not a tree slot: any asset can be in
            any number of these, unlike the single-parent folders above. */}
        <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border pt-3 text-sm">
          <span className="text-muted-foreground">مجموعه‌ها:</span>
          <button
            type="button"
            onClick={() => setCollectionId(null)}
            className={`rounded-lg px-2 py-1 transition-colors ${collectionId === null ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
          >
            همه
          </button>
          {collections.map((c) => (
            <span key={c.id} className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setCollectionId(c.id)}
                className={`rounded-lg px-2 py-1 transition-colors ${collectionId === c.id ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-200" : "text-muted-foreground hover:bg-muted"}`}
              >
                {c.name} <span className="text-xs text-muted-foreground">({toPersianDigits(c.assetCount)})</span>
              </button>
              <button
                type="button"
                aria-label={`حذف مجموعهٔ ${c.name}`}
                className="rounded-lg px-1 text-xs text-destructive hover:bg-muted"
                onClick={() => deleteCollection(c)}
              >
                ✕
              </button>
            </span>
          ))}
          <button
            type="button"
            className="rounded-lg px-2 py-1 text-xs text-primary hover:bg-muted"
            onClick={createCollection}
          >
            + مجموعهٔ جدید
          </button>
        </div>
      </SectionCard>
      ) : null}

      {/* Grid */}
      <SectionCard title={viewMode === "trash" ? `سطل زباله (${toPersianDigits(total)})` : `فایل‌ها (${toPersianDigits(total)})`}>
        {loading ? (
          <SectionCardSkeleton rows={3} />
        ) : assets.length === 0 ? (
          viewMode === "trash" ? (
            <EmptyState>سطل زباله خالی است.</EmptyState>
          ) : search || category || tag || source !== "all" || pendingOnly || collectionId ? (
            <EmptyState>موردی با این فیلترها پیدا نشد. فیلترها را پاک کنید یا عبارت جست‌وجو را تغییر دهید.</EmptyState>
          ) : currentFolder ? (
            <EmptyState>این پوشه خالی است.</EmptyState>
          ) : (
            <EmptyState>
              هنوز رسانه‌ای اضافه نشده است. با دکمهٔ «بارگذاری فایل» تصاویر منو، عکس محصولات، ویدیوها و اسناد کسب‌وکار را اضافه کنید.
            </EmptyState>
          )
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {assets.map((asset) => (
                <div
                  key={asset.id}
                  className="group relative flex flex-col overflow-hidden rounded-xl border border-border text-start transition-colors hover:bg-muted"
                >
                  {selectMode && viewMode === "library" ? (
                    <label className="absolute start-1 top-1 z-10 grid size-6 place-items-center rounded-md bg-background/90 shadow">
                      <input
                        type="checkbox"
                        className="size-4 accent-amber-600"
                        checked={selectedIds.has(asset.id)}
                        onChange={() => toggleSelected(asset.id)}
                        aria-label={`انتخاب ${asset.fileName}`}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      if (viewMode === "trash") return; // trashed items are edited by restoring, not in the drawer
                      if (selectMode) toggleSelected(asset.id);
                      else setSelected(asset);
                    }}
                    className="flex flex-col text-start"
                  >
                    <span className="relative block aspect-square w-full overflow-hidden bg-muted">
                      {/* A trashed asset's file is not servable (readMediaObject
                          excludes it, same as a hard delete would) — show the
                          kind icon rather than a request that can only 404. */}
                      {viewMode === "library" && asset.kind === "image" && asset.mimeType !== "image/svg+xml" ? (
                        <img
                          src={`/api/media/${asset.id}/file`}
                          alt={asset.fileName}
                          loading="lazy"
                          className="size-full object-cover"
                        />
                      ) : (
                        <span className="flex size-full items-center justify-center text-3xl" aria-hidden>
                          {asset.kind === "video" ? "🎬" : asset.kind === "image" ? "🖼️" : "📄"}
                        </span>
                      )}
                      {asset.aiStatus === "pending_review" ? (
                        <span className="absolute start-1 top-1">
                          <StatusBadge tone="active">در انتظار تأیید</StatusBadge>
                        </span>
                      ) : null}
                      {asset.variant === "enhanced" ? (
                        <span className="absolute end-1 top-1">
                          <StatusBadge tone="positive">استاندارد</StatusBadge>
                        </span>
                      ) : asset.variant === "bg_removed" ? (
                        <span className="absolute end-1 top-1">
                          <StatusBadge tone="positive">بدون پس‌زمینه</StatusBadge>
                        </span>
                      ) : asset.variant === "upscaled" ? (
                        <span className="absolute end-1 top-1">
                          <StatusBadge tone="positive">بزرگ‌نمایی‌شده</StatusBadge>
                        </span>
                      ) : asset.variant === "variation" ? (
                        <span className="absolute end-1 top-1">
                          <StatusBadge tone="positive">تنوع</StatusBadge>
                        </span>
                      ) : asset.variant === "transformed" ? (
                        <span className="absolute end-1 top-1">
                          <StatusBadge tone="positive">ویرایش‌شده</StatusBadge>
                        </span>
                      ) : null}
                      {/* Phase G — where this asset came from. A generated image is
                          AI-authored; an attachment came from a chat. */}
                      {asset.createdByAi ? (
                        <span className="absolute bottom-1 start-1">
                          <StatusBadge tone="active">ساختهٔ دستیار</StatusBadge>
                        </span>
                      ) : asset.source === "ai_attachment" ? (
                        <span className="absolute bottom-1 start-1">
                          <StatusBadge tone="neutral">از گفت‌وگو</StatusBadge>
                        </span>
                      ) : asset.source === "ocr_receipt" ? (
                        <span className="absolute bottom-1 start-1">
                          <StatusBadge tone="neutral">رسید هزینه</StatusBadge>
                        </span>
                      ) : asset.source === "ocr_invoice" ? (
                        <span className="absolute bottom-1 start-1">
                          <StatusBadge tone="neutral">فاکتور خرید</StatusBadge>
                        </span>
                      ) : null}
                    </span>
                    <span className="block truncate px-2 pt-2 text-xs font-medium">{asset.fileName}</span>
                    <span className="block px-2 pb-2 text-[11px] text-muted-foreground">
                      {MEDIA_KIND_LABELS[asset.kind]} · {formatBytes(asset.byteSize)}
                      {asset.category ? ` · ${asset.category}` : ""}
                    </span>
                  </button>
                  {viewMode === "trash" ? (
                    <div className="flex gap-1 border-t border-border p-1.5">
                      <Button size="sm" variant="outline" className="flex-1" disabled={busy} onClick={() => restoreAsset(asset.id)}>
                        بازیابی
                      </Button>
                      <Button size="sm" variant="destructive" className="flex-1" disabled={busy} onClick={() => purgeAsset(asset.id)}>
                        حذف همیشگی
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
            {assets.length < total ? (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => load(assets.length, true)}>
                  {loadingMore ? "در حال بارگذاری…" : `نمایش بیشتر (${toPersianDigits(total - assets.length)} مورد دیگر)`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </SectionCard>

      {selected ? (
        <AssetDrawer
          asset={selected}
          folders={folders}
          collections={collections}
          enhancePriceRial={payload.storage.enhancePriceRial}
          onClose={() => setSelected(null)}
          onUpdated={(updated) => {
            setSelected(updated);
            reload();
          }}
          onDeleted={() => {
            setSelected(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** Exported only for the crop-interaction test (media-manager.test.tsx) — not part of the page's public surface otherwise. */
export function AssetDrawer({
  asset,
  folders,
  collections,
  enhancePriceRial,
  onClose,
  onUpdated,
  onDeleted,
}: {
  asset: AssetRow;
  folders: FolderRow[];
  collections: CollectionRow[];
  enhancePriceRial: number;
  onClose: () => void;
  onUpdated: (asset: AssetRow) => void;
  onDeleted: () => void;
}) {
  const [fileName, setFileName] = useState(asset.fileName);
  const [folderId, setFolderId] = useState(asset.folderId ?? "");
  const [category, setCategory] = useState(asset.category ?? "");
  const [tags, setTags] = useState(asset.tags.join("، "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [usage, setUsage] = useState<MediaAssetUsage | null>(null);
  const [lineage, setLineage] = useState<MediaAssetLineage | null>(null);
  const [assetCollections, setAssetCollections] = useState<{ id: string; name: string }[] | null>(null);
  const [wpConnections, setWpConnections] = useState<WpPushConnection[] | null>(null);
  const [wpBusyId, setWpBusyId] = useState<string | null>(null);

  const loadAssetCollections = useCallback(() => {
    api<{ collections: { id: string; name: string }[] }>(`/api/media/${asset.id}/collections`).then(
      ({ ok, data }) => {
        if (ok) setAssetCollections(data.collections);
      },
    );
  }, [asset.id]);

  useEffect(() => {
    setAssetCollections(null);
    loadAssetCollections();
  }, [loadAssetCollections]);

  async function addToCollection(collectionId: string) {
    if (!collectionId) return;
    const { ok, data } = await api<{ message?: string }>(`/api/media/collections/${collectionId}/items`, {
      method: "POST",
      body: JSON.stringify({ assetId: asset.id }),
    });
    if (!ok) {
      setError(data.message ?? "افزودن به مجموعه ناموفق بود.");
      return;
    }
    loadAssetCollections();
  }

  async function removeFromCollection(collectionId: string) {
    const { ok, data } = await api<{ message?: string }>(`/api/media/collections/${collectionId}/items/${asset.id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setError(data.message ?? "حذف از مجموعه ناموفق بود.");
      return;
    }
    loadAssetCollections();
  }

  // Local fields track the asset prop when a fresh row lands (e.g. after
  // save/confirm/reject) so the form always reflects what is actually saved.
  useEffect(() => {
    setFileName(asset.fileName);
    setFolderId(asset.folderId ?? "");
    setCategory(asset.category ?? "");
    setTags(asset.tags.join("، "));
  }, [asset]);

  // Usage ("where is this used?") is fetched lazily once the drawer opens —
  // never bundled into the grid payload every card would otherwise pay for.
  useEffect(() => {
    setUsage(null);
    api<{ usage: MediaAssetUsage }>(`/api/media/${asset.id}/usage`).then(({ ok, data }) => {
      if (ok) setUsage(data.usage);
    });
  }, [asset.id]);

  // Version history ("what was this made from, and what was made from it?"),
  // lazily loaded the same way — most assets have none of either, so this is
  // never worth bundling into the grid payload every card would pay for.
  useEffect(() => {
    setLineage(null);
    api<{ lineage: MediaAssetLineage }>(`/api/media/${asset.id}/lineage`).then(({ ok, data }) => {
      if (ok) setLineage(data.lineage);
    });
  }, [asset.id]);

  // WordPress is a *view* over this same asset (wordpress_media_mapping),
  // not a second library — this list is only which connections could
  // receive it and where each one currently stands, loaded lazily like
  // usage/collections above.
  const isPushableToWordPress = asset.kind === "image" || asset.kind === "video";
  const loadWpConnections = useCallback(() => {
    if (!isPushableToWordPress) return;
    api<{ connections: WpPushConnection[] }>(`/api/media/${asset.id}/wordpress`).then(({ ok, data }) => {
      if (ok) setWpConnections(data.connections);
    });
  }, [asset.id, isPushableToWordPress]);
  useEffect(() => {
    setWpConnections(null);
    loadWpConnections();
  }, [loadWpConnections]);

  async function pushToWordPress(connectionId: string) {
    setWpBusyId(connectionId);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string }>(`/api/media/${asset.id}/wordpress`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    setWpBusyId(null);
    if (!ok) {
      setError(data.message ?? "ارسال به وردپرس صف نشد.");
      return;
    }
    setNotice("به صف ارسال به وردپرس اضافه شد؛ وضعیت پس از دریافت پاسخ افزونه به‌روزرسانی می‌شود.");
    loadWpConnections();
  }

  const isTaggableImage = asset.kind === "image" && asset.mimeType !== "image/svg+xml";
  const pending = asset.aiStatus === "pending_review" ? asset.aiLabels : null;
  const usageCount = usage
    ? usage.menuItems.length +
      usage.inventoryItems.length +
      (usage.expenses?.length ?? 0) +
      (usage.purchases?.length ?? 0) +
      (usage.parties?.length ?? 0)
    : 0;

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string; asset?: AssetRow }>(`/api/media/${asset.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fileName: fileName.trim(),
        folderId: folderId || null,
        category: category.trim() || null,
        tags: tags
          .split(/[،,]/)
          .map((t) => t.trim())
          .filter(Boolean),
      }),
    });
    setBusy(false);
    if (!ok || !data.asset) {
      setError(data.message ?? "ذخیره ناموفق بود.");
      return;
    }
    setNotice("تغییرات ذخیره شد.");
    onUpdated(data.asset);
  }

  async function decide(decision: "confirm" | "reject") {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string; asset?: AssetRow }>(`/api/media/${asset.id}`, {
      method: "PATCH",
      body: JSON.stringify({ aiDecision: decision }),
    });
    setBusy(false);
    if (!ok || !data.asset) {
      setError(data.message ?? "ثبت تصمیم ناموفق بود.");
      return;
    }
    setNotice(decision === "confirm" ? "پیشنهاد هوش مصنوعی اعمال شد." : "پیشنهاد رد شد.");
    onUpdated(data.asset);
  }

  async function detect() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string; asset?: AssetRow }>(`/api/media/${asset.id}/detect`, {
      method: "POST",
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "تشخیص هوشمند ناموفق بود.");
      return;
    }
    setNotice("برچسب‌های پیشنهادی آماده شد؛ آن‌ها را تأیید یا رد کنید.");
    if (data.asset) onUpdated(data.asset);
  }

  async function enhance() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string }>(`/api/media/${asset.id}/enhance`, { method: "POST" });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "بهینه‌سازی تصویر ناموفق بود.");
      return;
    }
    setNotice("تصویر استاندارد محصول ساخته و به کتابخانه اضافه شد. آن را در فهرست ببینید.");
    // The original asset is untouched (non-destructive processing); only the
    // grid needs to learn about the new derived version. Keep the drawer open
    // on the original so the success message stays visible.
    onUpdated(asset);
  }

  /** Same non-destructive shape as `enhance()` — new derived asset, source
   * untouched — for the two other AI edit operations built on the same
   * provider endpoint family (migration 0176). */
  async function runAiEdit(op: "bg-remove" | "upscale", successMessage: string, failMessage: string) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string }>(`/api/media/${asset.id}/${op}`, { method: "POST" });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? failMessage);
      return;
    }
    setNotice(successMessage);
    onUpdated(asset);
  }

  const removeBackground = () =>
    runAiEdit(
      "bg-remove",
      "تصویر بدون پس‌زمینه ساخته و به کتابخانه اضافه شد. آن را در فهرست ببینید.",
      "حذف پس‌زمینه ناموفق بود.",
    );

  const upscale = () =>
    runAiEdit(
      "upscale",
      "نسخهٔ بزرگ‌نمایی‌شده ساخته و به کتابخانه اضافه شد. آن را در فهرست ببینید.",
      "بزرگ‌نمایی تصویر ناموفق بود.",
    );

  async function makeVariations() {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string; assets?: unknown[] }>(`/api/media/${asset.id}/variations`, {
      method: "POST",
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "ساخت تنوع‌های تصویر ناموفق بود.");
      return;
    }
    const count = Array.isArray(data.assets) ? data.assets.length : 0;
    setNotice(`${toPersianDigits(count)} تنوع از تصویر ساخته و به کتابخانه اضافه شد. آن‌ها را در فهرست ببینید.`);
    onUpdated(asset);
  }

  // The lightweight, free (no AI, no wallet) crop/rotate/resize tier —
  // migration 0175. Every call produces a NEW 'transformed' asset; the
  // original this drawer is showing is never modified.
  const [resizeWidth, setResizeWidth] = useState("");

  async function transform(operation: "crop" | "rotate" | "resize", params: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ message?: string }>(`/api/media/${asset.id}/transform`, {
      method: "POST",
      body: JSON.stringify({ operation, params }),
    });
    setBusy(false);
    if (!ok) {
      setError(data.message ?? "پردازش تصویر ناموفق بود.");
      return;
    }
    setNotice("نسخهٔ جدید ساخته و به کتابخانه اضافه شد. آن را در فهرست ببینید.");
    onUpdated(asset);
  }

  // Crop: a drag-to-select rectangle over the preview image, in the same
  // "لایه‌سبک" spirit as the rotate/resize buttons — no canvas, no external
  // library, just pointer events mapped from the displayed (CSS-pixel) image
  // onto its real (natural-pixel) dimensions, which is all `/transform`'s
  // crop operation needs. Coordinates are read from the SAME `<img>` the
  // operator is looking at, which browsers already auto-orient from EXIF —
  // the same auto-orientation `applyMediaTransform` (sharp `.rotate()`)
  // applies server-side — so what is dragged is what gets cut.
  const cropImgRef = useRef<HTMLImageElement>(null);
  const [cropMode, setCropMode] = useState(false);
  const [cropBox, setCropBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const cropDragRef = useRef<{ startX: number; startY: number } | null>(null);
  const MIN_CROP_DISPLAY_PX = 12;

  function clampToImage(value: number, max: number): number {
    return Math.max(0, Math.min(max, value));
  }

  function pointFromEvent(event: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const img = cropImgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    return {
      x: clampToImage(event.clientX - rect.left, rect.width),
      y: clampToImage(event.clientY - rect.top, rect.height),
    };
  }

  function onCropPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!cropMode) return;
    const point = pointFromEvent(event);
    if (!point) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    cropDragRef.current = { startX: point.x, startY: point.y };
    setCropBox({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function onCropPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = cropDragRef.current;
    if (!start) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const x = Math.min(start.startX, point.x);
    const y = Math.min(start.startY, point.y);
    const width = Math.abs(point.x - start.startX);
    const height = Math.abs(point.y - start.startY);
    setCropBox({ x, y, width, height });
  }

  function onCropPointerUp() {
    cropDragRef.current = null;
  }

  const cropReady =
    cropBox !== null && cropBox.width >= MIN_CROP_DISPLAY_PX && cropBox.height >= MIN_CROP_DISPLAY_PX;

  async function applyCrop() {
    const img = cropImgRef.current;
    if (!img || !cropBox || !cropReady) return;
    // The natural size is the exact thing `applyMediaTransform` measures
    // server-side (post auto-orient), so this ratio is exact, not a guess.
    const scaleX = img.naturalWidth / img.clientWidth;
    const scaleY = img.naturalHeight / img.clientHeight;
    const x = Math.round(cropBox.x * scaleX);
    const y = Math.round(cropBox.y * scaleY);
    const width = Math.max(1, Math.min(img.naturalWidth - x, Math.round(cropBox.width * scaleX)));
    const height = Math.max(1, Math.min(img.naturalHeight - y, Math.round(cropBox.height * scaleY)));
    await transform("crop", { x, y, width, height });
    setCropMode(false);
    setCropBox(null);
  }

  // Leaving crop mode on when the drawer switches to a different asset would
  // draw the previous asset's rectangle over a new image — reset on asset change.
  useEffect(() => {
    setCropMode(false);
    setCropBox(null);
  }, [asset.id]);


  async function remove(force = false) {
    // A delete moves the asset to the trash (recoverable) rather than
    // removing it outright — permanent removal is a separate "حذف همیشگی"
    // action inside the trash view itself.
    if (!force && !window.confirm("این فایل به سطل زباله منتقل شود؟")) return;
    setBusy(true);
    setError("");
    const { ok, status, data } = await api<{ message?: string; usage?: MediaAssetUsage }>(
      `/api/media/${asset.id}${force ? "?force=1" : ""}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      if (status === 409 && data.usage) {
        const names = [
          ...data.usage.menuItems,
          ...data.usage.inventoryItems,
          ...(data.usage.expenses ?? []),
          ...(data.usage.purchases ?? []),
          ...(data.usage.parties ?? []),
        ]
          .map((r) => r.name)
          .join("، ");
        if (window.confirm(`این فایل هم‌اکنون استفاده می‌شود: ${names}. به سطل زباله منتقل شود؟`)) {
          await remove(true);
        }
        return;
      }
      setError(data.message ?? "حذف ناموفق بود.");
      return;
    }
    onDeleted();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className={`${cardClass} max-h-[92vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">{asset.fileName}</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            بستن
          </Button>
        </div>

        {asset.kind === "image" && asset.mimeType !== "image/svg+xml" ? (
          <div className="mb-4 overflow-hidden rounded-xl border border-border bg-muted">
            <div
              className={`relative mx-auto w-fit ${cropMode ? "touch-none select-none" : ""}`}
              onPointerDown={cropMode ? onCropPointerDown : undefined}
              onPointerMove={cropMode ? onCropPointerMove : undefined}
              onPointerUp={cropMode ? onCropPointerUp : undefined}
              onPointerCancel={cropMode ? onCropPointerUp : undefined}
            >
              <img
                ref={cropImgRef}
                src={`/api/media/${asset.id}/file`}
                alt={asset.fileName}
                draggable={false}
                className="mx-auto max-h-72 object-contain"
              />
              {cropMode && cropBox ? (
                <div
                  className="pointer-events-none absolute border-2 border-primary bg-primary/20"
                  style={{ left: cropBox.x, top: cropBox.y, width: cropBox.width, height: cropBox.height }}
                />
              ) : null}
            </div>
          </div>
        ) : (
          <div className="mb-4 rounded-xl border border-border bg-muted p-6 text-center text-sm text-muted-foreground">
            {MEDIA_KIND_LABELS[asset.kind]} · {formatBytes(asset.byteSize)} —{" "}
            <a className="text-primary underline-offset-4 hover:underline" href={`/api/media/${asset.id}/file`}>
              دانلود فایل
            </a>
          </div>
        )}

        {error ? <ErrorBox>{error}</ErrorBox> : null}
        {notice ? <InfoBox>{notice}</InfoBox> : null}

        {usageCount > 0 ? (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            استفاده در: {[
              ...usage!.menuItems,
              ...usage!.inventoryItems,
              ...(usage!.expenses ?? []),
              ...(usage!.purchases ?? []),
              ...(usage!.parties ?? []),
            ]
              .map((r) => r.name)
              .join("، ")}
          </p>
        ) : null}

        {lineage && (lineage.ancestors.length > 0 || lineage.descendants.length > 0) ? (
          <div className="mb-4 rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
            {lineage.ancestors.length > 0 ? (
              <p className="mb-1">
                سابقهٔ نسخه:{" "}
                {[...lineage.ancestors, { id: asset.id, fileName: asset.fileName, variant: asset.variant }]
                  .map((entry, index, all) => (
                    <span key={entry.id}>
                      {entry.id === asset.id ? (
                        <span className="font-medium text-foreground">
                          {entry.fileName} ({lineageVariantLabel(entry.variant)})
                        </span>
                      ) : (
                        <a
                          href={`/api/media/${entry.id}/file`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {entry.fileName} ({lineageVariantLabel(entry.variant)})
                        </a>
                      )}
                      {index < all.length - 1 ? " ← " : ""}
                    </span>
                  ))}
              </p>
            ) : null}
            {lineage.descendants.length > 0 ? (
              <p>
                نسخه‌های ساخته‌شده از این فایل:{" "}
                {lineage.descendants.map((entry, index) => (
                  <span key={entry.id}>
                    <a
                      href={`/api/media/${entry.id}/file`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {entry.fileName} ({lineageVariantLabel(entry.variant)})
                    </a>
                    {index < lineage.descendants.length - 1 ? "، " : ""}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* The AI proposal, awaiting the operator */}
        {pending ? (
          <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-500/10">
            <p className="mb-2 text-sm font-medium text-amber-950 dark:text-amber-200">پیشنهاد هوش مصنوعی (در انتظار تأیید شما)</p>
            {pending.description ? (
              <p className="mb-2 text-xs text-amber-900/80 dark:text-amber-200/80">{pending.description}</p>
            ) : null}
            <p className="mb-3 text-sm text-amber-950 dark:text-amber-100">
              {pending.category ? `دسته: «${pending.category}»` : ""}
              {pending.tags && pending.tags.length > 0 ? ` — برچسب‌ها: ${pending.tags.join("، ")}` : ""}
            </p>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => decide("confirm")}>
                تأیید و اعمال
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => decide("reject")}>
                رد پیشنهاد
              </Button>
            </div>
          </div>
        ) : null}

        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="نام فایل">
            <input className={inputClass} value={fileName} onChange={(e) => setFileName(e.target.value)} />
          </Field>
          <Field label="پوشه">
            <select className={inputClass} value={folderId} onChange={(e) => setFolderId(e.target.value)}>
              <option value="">ریشه (بدون پوشه)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="دسته‌بندی">
            <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="مثلاً «غذا و نوشیدنی»" />
          </Field>
          <Field label="برچسب‌ها" hint="با ویرگول جدا کنید">
            <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="قهوه، منو، تابستان" />
          </Field>
        </div>

        {/* Collections — distinct from the tags above: a first-class, listable
            object with its own membership, not a free-text label. */}
        <div className="mb-4">
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">مجموعه‌ها</p>
          <div className="flex flex-wrap items-center gap-1.5">
            {(assetCollections ?? []).map((c) => (
              <span key={c.id} className="flex items-center gap-1 rounded-lg bg-muted px-2 py-1 text-xs">
                {c.name}
                <button
                  type="button"
                  aria-label={`حذف از مجموعهٔ ${c.name}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => removeFromCollection(c.id)}
                >
                  ✕
                </button>
              </span>
            ))}
            {collections.length > 0 ? (
              <select
                className="rounded-lg border border-border bg-background px-2 py-1 text-xs"
                defaultValue=""
                onChange={(e) => {
                  if (e.target.value) addToCollection(e.target.value);
                  e.target.value = "";
                }}
              >
                <option value="" disabled>
                  افزودن به مجموعه…
                </option>
                {collections
                  .filter((c) => !(assetCollections ?? []).some((ac) => ac.id === c.id))
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>
            ) : null}
          </div>
        </div>

        {isTaggableImage ? (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-border p-2">
            <span className="text-xs text-muted-foreground">ابزارهای سبک (رایگان، بدون هوش مصنوعی):</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => transform("rotate", { degrees: 90 })}>
              چرخش ۹۰° راست
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => transform("rotate", { degrees: -90 })}>
              چرخش ۹۰° چپ
            </Button>
            <PersianNumberInput
              className="w-24 rounded-lg border border-border bg-background px-2 py-1 text-xs"
              placeholder="عرض (پیکسل)"
              value={resizeWidth}
              onChange={(e) => setResizeWidth(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !resizeWidth || Number(resizeWidth) < 1}
              onClick={() => transform("resize", { width: Number(resizeWidth), fit: "inside" })}
            >
              تغییر اندازه به این عرض
            </Button>
            {!cropMode ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setCropBox(null);
                  setCropMode(true);
                }}
              >
                برش تصویر
              </Button>
            ) : (
              <>
                <span className="text-xs text-muted-foreground">
                  روی تصویر بکشید تا ناحیهٔ برش را انتخاب کنید.
                </span>
                <Button size="sm" disabled={busy || !cropReady} onClick={() => applyCrop()}>
                  اعمال برش
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setCropMode(false);
                    setCropBox(null);
                  }}
                >
                  انصراف
                </Button>
              </>
            )}
          </div>
        ) : null}

        {isPushableToWordPress && wpConnections && wpConnections.length > 0 ? (
          <div className="mb-4 rounded-xl border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">ارسال به وردپرس</p>
            <ul className="flex flex-col gap-2">
              {wpConnections.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  {c.mapping?.status === "synced" ? (
                    <>
                      <StatusBadge tone="positive">همگام‌شده</StatusBadge>
                      {c.mapping.wpUrl ? (
                        <a
                          href={c.mapping.wpUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary underline underline-offset-2"
                        >
                          مشاهده در سایت
                        </a>
                      ) : null}
                    </>
                  ) : c.mapping?.status === "pending" ? (
                    <StatusBadge tone="active">در حال ارسال</StatusBadge>
                  ) : c.mapping?.status === "failed" ? (
                    <StatusBadge tone="danger">ناموفق</StatusBadge>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!c.canPush || wpBusyId === c.id}
                    onClick={() => pushToWordPress(c.id)}
                    title={c.canPush ? undefined : "این اتصال از ارسال رسانه پشتیبانی نمی‌کند."}
                  >
                    {wpBusyId === c.id
                      ? "در حال ارسال…"
                      : c.mapping?.status === "synced"
                        ? "ارسال دوباره"
                        : c.mapping?.status === "failed"
                          ? "تلاش دوباره"
                          : "ارسال"}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={busy} onClick={() => save()}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
          {isTaggableImage ? (
            <>
              <Button variant="outline" disabled={busy} onClick={detect}>
                تشخیص و برچسب هوشمند
              </Button>
              {asset.variant === "original" ? (
                <>
                  <Button variant="outline" disabled={busy} onClick={enhance}>
                    تصویر استاندارد محصول
                    {enhancePriceRial > 0 ? ` (${(enhancePriceRial / 10).toLocaleString("fa-IR")} تومان)` : ""}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={removeBackground}>
                    حذف پس‌زمینه
                    {enhancePriceRial > 0 ? ` (${(enhancePriceRial / 10).toLocaleString("fa-IR")} تومان)` : ""}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={upscale}>
                    بزرگ‌نمایی
                    {enhancePriceRial > 0 ? ` (${(enhancePriceRial / 10).toLocaleString("fa-IR")} تومان)` : ""}
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={makeVariations}>
                    {`ساخت ${toPersianDigits(MEDIA_VARIATIONS_COUNT)} تنوع از تصویر`}
                    {enhancePriceRial > 0
                      ? ` (${((enhancePriceRial * MEDIA_VARIATIONS_COUNT) / 10).toLocaleString("fa-IR")} تومان)`
                      : ""}
                  </Button>
                </>
              ) : null}
            </>
          ) : null}
          <span className="flex-1" />
          <Button variant="destructive" disabled={busy} onClick={() => remove(false)}>
            انتقال به سطل زباله
          </Button>
        </div>
      </div>
    </div>
  );
}
