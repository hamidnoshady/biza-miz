"use client";

/**
 * Issue #908 — the contract document editor.
 *
 * Three panels, because that is how a long legal document is actually written:
 *
 *   right (RTL-leading)  the block and variable LIBRARY — what you may insert;
 *   centre               the A4 CANVAS — the document as it will be printed,
 *                        which is the only preview that is not a lie;
 *   left (RTL-trailing)  the INSPECTOR — the outline plus the selected block's
 *                        or field's exact properties.
 *
 * Below `lg` the three panels stack (library, canvas, inspector) and the canvas
 * keeps its paper proportions, so a phone gets a focused form rather than a
 * squeezed three-column layout.
 *
 * Editing rules that matter more than the layout:
 *
 *  - **Autosave with an explicit revision.** Every save sends the revision it
 *    was based on; a save that lost a race is refused with 409 and the editor
 *    says so instead of overwriting. The banner offers «بارگذاری دوباره».
 *  - **Undo/redo is local history**, not a server feature: it walks the same
 *    content objects the autosave sent, and a conflict clears it (the past no
 *    longer describes the document the server holds).
 *  - **Validation is visible where it applies.** A structural issue names its
 *    block; a field issue names its key; both are rendered beside the thing.
 *  - **Sending is impossible from here.** The freeze/send steps live on the
 *    signing panel, and both refuse an incomplete document server-side, so a
 *    user cannot reach a signer with an unresolved variable by another path.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CoinsIcon,
  CopyIcon,
  EyeIcon,
  FileSignatureIcon,
  PlusIcon,
  RedoIcon,
  TrashIcon,
  UndoIcon,
} from "lucide-react";
import { LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, inputClass } from "@/app/dashboard/ui";
import { ContractDocumentSheet } from "@/components/contracts/contract-document-sheet";
import {
  CONTRACT_BLOCK_HINTS,
  CONTRACT_BLOCK_LABELS,
  CONTRACT_BLOCK_TYPES,
  CONTRACT_FIELD_TYPE_LABELS,
  CONTRACT_LIMITS,
  validateContractContent,
  type ContractBlock,
  type ContractBlockType,
  type ContractDocumentContent,
  type ContractField,
  type ContractFieldType,
} from "@/lib/contracts/blocks";
import {
  bindingGroups,
  bindingLabel,
  CONTRACT_BINDING_CATALOGUE,
  type ContractBindingEntry,
} from "@/lib/contracts/bindings";
import type { ContractDocumentView, ContractTemplateChoice } from "@/lib/contracts/view";
import { toPersianDigits } from "@/lib/digits";
import { contractError } from "./contract-workspace";

const BLOCK_ICONS: Record<ContractBlockType, typeof PlusIcon> = {
  heading: PlusIcon,
  paragraph: PlusIcon,
  article: PlusIcon,
  bullets: PlusIcon,
  numbered: PlusIcon,
  table: PlusIcon,
  divider: PlusIcon,
  page_break: PlusIcon,
  signature: FileSignatureIcon,
};

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function blockLabel(block: ContractBlock): string {
  const base = CONTRACT_BLOCK_LABELS[block.type];
  switch (block.type) {
    case "heading":
    case "paragraph":
      return `${base}: ${block.text.slice(0, 40) || "—"}`;
    case "article":
      return `${base}: ${block.title.slice(0, 40) || "—"}`;
    case "signature":
      return `${base}: ${block.label || block.slotId}`;
    case "table":
      return `${base}: ${block.caption || `${toPersianDigits(block.rows.length)} سطر`}`;
    default:
      return base;
  }
}

function makeBlock(type: ContractBlockType, index: number): ContractBlock {
  const id = newId("b");
  switch (type) {
    case "heading":
      return { id, type, text: "عنوان بخش" };
    case "paragraph":
      return { id, type, text: "" };
    case "article":
      return { id, type, title: `مادهٔ ${toPersianDigits(index + 1)} — `, text: "" };
    case "bullets":
      return { id, type, items: [""] };
    case "numbered":
      return { id, type, items: [""] };
    case "table":
      return {
        id,
        type,
        caption: "جدول",
        columns: ["ردیف", "شرح", "مبلغ"],
        rows: [["۱", "", ""]],
      };
    case "divider":
      return { id, type };
    case "page_break":
      return { id, type };
    case "signature":
      return {
        id,
        type,
        slotId: newId("sig"),
        label: "امضای طرف قرارداد",
        caption: "نام و نام خانوادگی، تاریخ",
      };
  }
}

interface HistoryState {
  past: ContractDocumentContent[];
  future: ContractDocumentContent[];
}

export function ContractDocumentEditor({
  view,
  canEdit,
  onSaved,
  onGoToSigning,
}: {
  view: ContractDocumentView;
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
  onGoToSigning: () => void;
}) {
  const [content, setContent] = useState<ContractDocumentContent>(view.document.content);
  const [revision, setRevision] = useState(view.document.revision);
  const [selection, setSelection] = useState<
    { kind: "block"; id: string } | { kind: "field"; key: string } | { kind: "document" } | null
  >(null);
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [templates, setTemplates] = useState<ContractTemplateChoice[] | null>(null);
  const [templateName, setTemplateName] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The template library: starters plus this business's own documents. Loaded
  // once, because it changes only when the sender saves a template from a
  // different contract — and a reload of that contract would show it then.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { ok, data } = await api<{ templates?: ContractTemplateChoice[] }>(
        "/api/workspace/contract-templates",
      );
      if (alive) setTemplates(ok ? data.templates ?? [] : []);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Adopt the server's document whenever a save (or a reload) lands: the
  // revision is authoritative, and the local copy must not drift from it. A
  // pending local edit (`dirty`) is never overwritten by a background refresh —
  // that is the difference between syncing and losing typing.
  useEffect(() => {
    if (dirty) return;
    setContent(view.document.content);
    setRevision(view.document.revision);
  }, [view.document.content, view.document.revision, dirty]);

  const apply = (next: ContractDocumentContent, options: { history?: boolean } = {}) => {
    if (options.history !== false) {
      setHistory((state) => ({ past: [...state.past.slice(-49), content], future: [] }));
    }
    setContent(next);
    setDirty(true);
    setNotice("");
  };

  const save = useCallback(
    async (next: ContractDocumentContent) => {
      if (!canEdit) return;
      setSaving(true);
      const { ok, data } = await api<{ document?: { revision: number }; error?: string }>(
        `/api/workspace/contracts/${view.contract.id}/document`,
        { method: "PUT", body: JSON.stringify({ content: next, revision }) },
      );
      setSaving(false);
      if (!ok) {
        setError(contractError(data?.error));
        setConflict(data?.error === "document_conflict");
        return;
      }
      setError("");
      setConflict(false);
      setDirty(false);
      setNotice("ذخیره شد");
      if (data?.document) setRevision(data.document.revision);
      await onSaved();
    },
    [canEdit, onSaved, revision, view.contract.id],
  );

  // Debounced autosave: the epic's "autosave with conflict indication" without
  // a write on every keystroke.
  useEffect(() => {
    if (!dirty || !canEdit) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void save(content);
    }, 1200);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [content, dirty, canEdit, save]);

  const undo = () => {
    const previous = history.past[history.past.length - 1];
    if (!previous) return;
    setHistory({
      past: history.past.slice(0, -1),
      future: [content, ...history.future].slice(0, 50),
    });
    setContent(previous);
    setDirty(true);
  };

  const redo = () => {
    const next = history.future[0];
    if (!next) return;
    setHistory({ past: [...history.past, content].slice(-50), future: history.future.slice(1) });
    setContent(next);
    setDirty(true);
  };

  const mutateBlocks = (mutator: (blocks: ContractBlock[]) => ContractBlock[]) => {
    apply({ ...content, blocks: mutator([...content.blocks]) });
  };

  const addBlock = (type: ContractBlockType) => {
    const block = makeBlock(type, content.blocks.length);
    mutateBlocks((blocks) => {
      const at = selection?.kind === "block" ? blocks.findIndex((item) => item.id === selection.id) : -1;
      if (at >= 0) blocks.splice(at + 1, 0, block);
      else blocks.push(block);
      return blocks;
    });
    setSelection({ kind: "block", id: block.id });
  };

  const moveBlock = (id: string, direction: -1 | 1) => {
    mutateBlocks((blocks) => {
      const index = blocks.findIndex((block) => block.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= blocks.length) return blocks;
      const [moved] = blocks.splice(index, 1);
      blocks.splice(target, 0, moved);
      return blocks;
    });
  };

  const removeBlock = (id: string) => {
    mutateBlocks((blocks) => blocks.filter((block) => block.id !== id));
    setSelection(null);
  };

  const duplicateBlock = (id: string) => {
    mutateBlocks((blocks) => {
      const index = blocks.findIndex((block) => block.id === id);
      if (index < 0) return blocks;
      const copy = { ...blocks[index], id: newId("b") } as ContractBlock;
      if (copy.type === "signature") copy.slotId = newId("sig");
      blocks.splice(index + 1, 0, copy);
      return blocks;
    });
  };

  const updateBlock = (id: string, patch: Partial<ContractBlock>) => {
    mutateBlocks((blocks) =>
      blocks.map((block) => (block.id === id ? ({ ...block, ...patch } as ContractBlock) : block)),
    );
  };

  const addField = (binding?: ContractBindingEntry) => {
    if (content.fields.length >= CONTRACT_LIMITS.fieldsMax) {
      setError("تعداد متغیرها به حد مجاز رسیده است.");
      return;
    }
    const base = binding ? binding.path : `field_${content.fields.length + 1}`;
    let key = base.replace(/[^a-z0-9_]/g, "_").slice(0, CONTRACT_LIMITS.fieldKeyMax);
    if (!/^[a-z]/.test(key)) key = `f_${key}`;
    let suffix = 2;
    const taken = new Set(content.fields.map((field) => field.key));
    while (taken.has(key)) key = `${base}_${suffix++}`.slice(0, CONTRACT_LIMITS.fieldKeyMax);
    const field: ContractField = {
      key,
      label: binding ? binding.label : `متغیر ${toPersianDigits(content.fields.length + 1)}`,
      type: binding ? binding.type : "text",
      required: false,
      binding: binding ? { source: binding.source, path: binding.path } : null,
      options: [],
      value: "",
    };
    apply({ ...content, fields: [...content.fields, field] });
    setSelection({ kind: "field", key });
  };

  const updateField = (key: string, patch: Partial<ContractField>) => {
    apply({
      ...content,
      fields: content.fields.map((field) => (field.key === key ? { ...field, ...patch } : field)),
    });
  };

  const removeField = (key: string) => {
    apply({ ...content, fields: content.fields.filter((field) => field.key !== key) });
    setSelection(null);
  };

  /** Insert `{{key}}` at the end of the selected text block. */
  const insertToken = (key: string) => {
    const token = `{{${key}}}`;
    const target =
      selection?.kind === "block"
        ? content.blocks.find((block) => block.id === selection.id)
        : content.blocks.find(
            (block) => block.type === "paragraph" || block.type === "article" || block.type === "heading",
          );
    if (!target || !(target.type === "paragraph" || target.type === "article" || target.type === "heading")) {
      setError("برای درج متغیر، یک بلوک متنی انتخاب کنید.");
      return;
    }
    updateBlock(target.id, { text: `${target.text}${target.text ? " " : ""}${token}` } as Partial<ContractBlock>);
    setSelection({ kind: "block", id: target.id });
  };

  /**
   * What the A4 canvas prints while the sender types.
   *
   * The server's `view.values` are the bound values; a value typed in the
   * inspector wins over them exactly as it will when the document is frozen
   * (`resolveBindings` gives `manual` precedence), so the preview and the
   * eventual PDF cannot disagree about a number or a date.
   */
  const previewValues = useMemo(() => {
    const out: Record<string, string> = { ...view.values };
    for (const field of content.fields) {
      const manual = field.value.trim();
      if (manual) out[field.key] = manual;
      else if (!field.binding) out[field.key] = field.type === "checkbox" ? "false" : "";
    }
    return out;
  }, [content.fields, view.values]);

  const structuralIssues = useMemo(() => validateContractContent(content), [content]);
  const fieldIssues = view.issues.filter((issue) => issue.code.startsWith("field_"));
  const selectedBlock =
    selection?.kind === "block" ? content.blocks.find((block) => block.id === selection.id) ?? null : null;
  const selectedField =
    selection?.kind === "field" ? content.fields.find((field) => field.key === selection.key) ?? null : null;

  /**
   * Replace this draft's body with a template.
   *
   * Confirmed explicitly because it discards the current text — the epic's
   * "starting point" is a deliberate act, not a hover action. Frozen versions
   * and any live signing round are unaffected: they keep the copy they hold.
   */
  const applyTemplate = async (reference: string, name: string) => {
    if (dirty && !window.confirm(`متن فعلی جایگزین قالب «${name}» می‌شود. ادامه می‌دهید؟`)) return;
    setTemplateBusy(true);
    const { ok, data } = await api<{ error?: string }>(
      `/api/workspace/contracts/${view.contract.id}/document/template`,
      { method: "POST", body: JSON.stringify({ templateRef: reference }) },
    );
    setTemplateBusy(false);
    if (!ok) {
      setError(contractError(data?.error));
      return;
    }
    setError("");
    setDirty(false);
    setNotice(`سند از قالب «${name}» ساخته شد.`);
    await onSaved();
  };

  const saveAsTemplate = async () => {
    const name = templateName.trim();
    if (!name) return;
    setTemplateBusy(true);
    const { ok, data } = await api<{ template?: ContractTemplateChoice; error?: string }>(
      "/api/workspace/contract-templates",
      {
        method: "POST",
        body: JSON.stringify({
          contractId: view.contract.id,
          name,
          contractType: view.contract.contractType,
        }),
      },
    );
    setTemplateBusy(false);
    if (!ok) {
      setError(contractError(data?.error));
      return;
    }
    setError("");
    setTemplateName("");
    setNotice(`قالب «${name}» ذخیره شد.`);
    if (data?.template) {
      setTemplates((current) => [...(current ?? []), data.template as ContractTemplateChoice]);
    }
  };

  const freezeVersion = async () => {
    setSaving(true);
    const { ok, data } = await api<{ version?: { version: number }; error?: string }>(
      `/api/workspace/contracts/${view.contract.id}/document/versions`,
      { method: "POST" },
    );
    setSaving(false);
    if (!ok) {
      setError(contractError(data?.error));
      return;
    }
    setError("");
    setNotice(`نسخهٔ ثابت v${toPersianDigits(data?.version?.version ?? 1)} ساخته شد.`);
    await onSaved();
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {conflict ? (
        <InfoBox>
          نسخهٔ سند در جای دیگری تغییر کرده است. برای جلوگیری از بازنویسی، ابتدا نسخهٔ سرور را
          بارگذاری کنید.
          <button
            type="button"
            className="ms-2 font-medium text-primary hover:underline"
            onClick={() => {
              setConflict(false);
              void onSaved();
            }}
          >
            بارگذاری دوباره
          </button>
        </InfoBox>
      ) : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="سند قرارداد"
        description="متغیرها با {{نام}} در متن نوشته می‌شوند و هنگام ثابت‌کردن نسخه، از پروژه، طرف حساب و خود قرارداد پر می‌شوند."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton onClick={undo} disabled={history.past.length === 0}>
              <UndoIcon className="me-1 inline size-3.5" aria-hidden /> واگرد
            </SecondaryButton>
            <SecondaryButton onClick={redo} disabled={history.future.length === 0}>
              <RedoIcon className="me-1 inline size-3.5" aria-hidden /> ازنو
            </SecondaryButton>
            <a
              href={`/workspace/contracts/${view.contract.id}/print`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <EyeIcon className="me-1 size-3.5" aria-hidden /> چاپ / PDF
            </a>
            <SecondaryButton onClick={freezeVersion} disabled={!canEdit || saving || structuralIssues.length > 0}>
              ثابت‌کردن نسخه
            </SecondaryButton>
            <PrimaryButton onClick={() => void save(content)} disabled={!canEdit || saving}>
              {saving ? "در حال ذخیره…" : dirty ? "ذخیرهٔ تغییرات" : "ذخیره شد"}
            </PrimaryButton>
          </div>
        }
        footer={
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {canEdit
                ? dirty
                  ? "تغییرهای ذخیره‌نشده — ذخیرهٔ خودکار تا لحظاتی دیگر انجام می‌شود."
                  : "همهٔ تغییرها ذخیره شده است."
                : "شما فقط اجازهٔ مشاهدهٔ این سند را دارید."}
            </span>
            <div className="flex items-center gap-2">
              <SecondaryButton onClick={onGoToSigning}>امضا و ارسال</SecondaryButton>
            </div>
          </div>
        }
      >
        <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)_320px]">
          {/* Library ------------------------------------------------------ */}
          <div className="space-y-4 lg:order-1">
            <div>
              <p className="mb-2 text-xs font-semibold text-foreground">بلوک‌ها</p>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
                {CONTRACT_BLOCK_TYPES.map((type) => {
                  const Icon = BLOCK_ICONS[type];
                  return (
                    <button
                      key={type}
                      type="button"
                      disabled={!canEdit}
                      onClick={() => addBlock(type)}
                      title={CONTRACT_BLOCK_HINTS[type]}
                      className="flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-start text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      <span className="truncate">{CONTRACT_BLOCK_LABELS[type]}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-semibold text-foreground">کتابخانهٔ متغیرها</p>
              <div className="space-y-3">
                {bindingGroups().map((group) => (
                  <div key={group.group}>
                    <p className="mb-1 text-[11px] text-muted-foreground">{group.group}</p>
                    <div className="space-y-1">
                      {group.entries.map((entry) => (
                        <button
                          key={`${entry.source}.${entry.path}`}
                          type="button"
                          disabled={!canEdit}
                          onClick={() => addField(entry)}
                          className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-start text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                        >
                          <CoinsIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate">{entry.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Canvas ------------------------------------------------------- */}
          <div className="min-w-0 lg:order-2">
            <div className="rounded-2xl bg-muted/40 p-2 sm:p-4">
              <ContractDocumentSheet
                content={content}
                values={previewValues}
                markUnresolved
                businessName={view.contract.projectName ?? undefined}
              />
            </div>
          </div>

          {/* Inspector ---------------------------------------------------- */}
          <div className="space-y-4 lg:order-3">
            <div>
              <p className="mb-2 text-xs font-semibold text-foreground">قالب‌ها</p>
              {templates === null ? (
                <LoadingSkeleton rows={3} label="در حال بارگذاری قالب‌ها" compact />
              ) : (
                <div className="space-y-1">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      disabled={!canEdit || templateBusy}
                      onClick={() => void applyTemplate(template.id, template.name)}
                      title={template.description}
                      className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-start text-[11px] text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                    >
                      <span className="truncate">{template.name}</span>
                      {template.builtin ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">پیش‌فرض</span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-1">
                <input
                  className={`${inputClass} h-8 text-[11px]`}
                  placeholder="نام قالب تازه"
                  value={templateName}
                  disabled={!canEdit || templateBusy}
                  onChange={(event) => setTemplateName(event.target.value)}
                />
                <SecondaryButton onClick={() => void saveAsTemplate()} disabled={!canEdit || templateBusy || !templateName.trim()}>
                  ذخیره
                </SecondaryButton>
              </div>
              <p className="mt-1 text-[10px] text-muted-foreground">
                متن فعلی به‌عنوان قالبی برای قراردادهای بعدی ذخیره می‌شود.
              </p>
            </div>

            <div className="border-t border-border pt-3">
              <p className="mb-2 text-xs font-semibold text-foreground">
                ساختار سند ({toPersianDigits(content.blocks.length)} بلوک)
              </p>
              <ul className="max-h-64 space-y-1 overflow-y-auto pe-1">
                <li>
                  <button
                    type="button"
                    onClick={() => setSelection({ kind: "document" })}
                    className={`w-full truncate rounded-md px-2 py-1 text-start text-[11px] ${
                      selection?.kind === "document" ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100" : "hover:bg-muted"
                    }`}
                  >
                    تنظیمات سند
                  </button>
                </li>
                {content.blocks.map((block, index) => (
                  <li key={block.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setSelection({ kind: "block", id: block.id })}
                      className={`min-w-0 flex-1 truncate rounded-md px-2 py-1 text-start text-[11px] ${
                        selection?.kind === "block" && selection.id === block.id
                          ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100"
                          : "hover:bg-muted"
                      }`}
                    >
                      {toPersianDigits(index + 1)}. {blockLabel(block)}
                    </button>
                    <button
                      type="button"
                      aria-label="بالا"
                      disabled={!canEdit || index === 0}
                      onClick={() => moveBlock(block.id, -1)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    >
                      <ArrowUpIcon className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      aria-label="پایین"
                      disabled={!canEdit || index === content.blocks.length - 1}
                      onClick={() => moveBlock(block.id, 1)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                    >
                      <ArrowDownIcon className="size-3" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="border-t border-border pt-3">
              {selectedBlock ? (
                <BlockInspector
                  block={selectedBlock}
                  canEdit={canEdit}
                  onChange={(patch) => updateBlock(selectedBlock.id, patch)}
                  onRemove={() => removeBlock(selectedBlock.id)}
                  onDuplicate={() => duplicateBlock(selectedBlock.id)}
                />
              ) : selectedField ? (
                <FieldInspector
                  field={selectedField}
                  canEdit={canEdit}
                  onChange={(patch) => updateField(selectedField.key, patch)}
                  onRemove={() => removeField(selectedField.key)}
                  onInsert={() => insertToken(selectedField.key)}
                />
              ) : (
                <DocumentInspector content={content} canEdit={canEdit} onChange={(patch) => apply({ ...content, ...patch })} />
              )}
            </div>

            <div className="border-t border-border pt-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-xs font-semibold text-foreground">
                  متغیرها ({toPersianDigits(content.fields.length)})
                </p>
                <button
                  type="button"
                  disabled={!canEdit}
                  onClick={() => addField()}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline disabled:opacity-50"
                >
                  <PlusIcon className="size-3" aria-hidden /> متغیر جدید
                </button>
              </div>
              <ul className="space-y-1">
                {content.fields.map((field) => {
                  const resolved = view.resolved.find((item) => item.key === field.key);
                  return (
                    <li key={field.key}>
                      <button
                        type="button"
                        onClick={() => setSelection({ kind: "field", key: field.key })}
                        className={`w-full rounded-md px-2 py-1 text-start text-[11px] ${
                          selection?.kind === "field" && selection.key === field.key
                            ? "bg-amber-100 text-amber-950 dark:bg-amber-500/20 dark:text-amber-100"
                            : "hover:bg-muted"
                        }`}
                      >
                        <span className="block truncate">{field.label}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {`{{${field.key}}}`}
                          {resolved?.provenance === "binding"
                            ? ` · ${bindingLabel(field.binding) ?? "منبع"}`
                            : resolved?.provenance === "override"
                              ? " · بازنویسی دستی"
                              : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {content.fields.length === 0 ? (
                  <li className="px-2 py-1 text-[11px] text-muted-foreground">
                    هنوز متغیری تعریف نشده است.
                  </li>
                ) : null}
              </ul>
            </div>

            {structuralIssues.length > 0 || fieldIssues.length > 0 ? (
              <div className="rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-[11px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                <p className="mb-1 font-semibold">پیش از ارسال باید رفع شود</p>
                <ul className="list-disc space-y-0.5 ps-4">
                  {[...structuralIssues, ...fieldIssues].slice(0, 6).map((issue, index) => (
                    <li key={`${issue.code}-${index}`}>
                      {issue.message}
                      {issue.fieldKey ? ` (${issue.fieldKey})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="rounded-xl border border-emerald-300/60 bg-emerald-50 p-3 text-[11px] text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
                ساختار سند بی‌ایراد است. با «ثابت‌کردن نسخه» می‌توانید برای امضا بفرستید.
              </p>
            )}
          </div>
        </div>
      </SectionCard>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Inspectors
 * ------------------------------------------------------------------------- */

function DocumentInspector({
  content,
  canEdit,
  onChange,
}: {
  content: ContractDocumentContent;
  canEdit: boolean;
  onChange: (patch: Partial<ContractDocumentContent>) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-foreground">تنظیمات سند</p>
      <Field label="عنوان سند">
        <input
          className={inputClass}
          value={content.title}
          disabled={!canEdit}
          onChange={(event) => onChange({ title: event.target.value })}
        />
      </Field>
      <Field label="سرصفحه" hint="بالای هر صفحه چاپ می‌شود.">
        <input
          className={inputClass}
          value={content.headerText}
          disabled={!canEdit}
          onChange={(event) => onChange({ headerText: event.target.value })}
        />
      </Field>
      <Field label="پانویس">
        <input
          className={inputClass}
          value={content.footerText}
          disabled={!canEdit}
          onChange={(event) => onChange({ footerText: event.target.value })}
        />
      </Field>
    </div>
  );
}

function BlockInspector({
  block,
  canEdit,
  onChange,
  onRemove,
  onDuplicate,
}: {
  block: ContractBlock;
  canEdit: boolean;
  onChange: (patch: Partial<ContractBlock>) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  const actions = (
    <div className="flex items-center gap-2">
      <SecondaryButton onClick={onDuplicate} disabled={!canEdit}>
        <CopyIcon className="me-1 inline size-3.5" aria-hidden /> تکثیر
      </SecondaryButton>
      <SecondaryButton onClick={onRemove} disabled={!canEdit}>
        <TrashIcon className="me-1 inline size-3.5" aria-hidden /> حذف
      </SecondaryButton>
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-foreground">
        {CONTRACT_BLOCK_LABELS[block.type]}
      </p>
      {block.type === "heading" || block.type === "paragraph" ? (
        <Field label="متن">
          <textarea
            className={`${inputClass} min-h-24 py-2`}
            value={block.text}
            disabled={!canEdit}
            onChange={(event) => onChange({ text: event.target.value })}
          />
        </Field>
      ) : null}
      {block.type === "article" ? (
        <>
          <Field label="عنوان ماده">
            <input
              className={inputClass}
              value={block.title}
              disabled={!canEdit}
              onChange={(event) => onChange({ title: event.target.value })}
            />
          </Field>
          <Field label="متن ماده">
            <textarea
              className={`${inputClass} min-h-32 py-2`}
              value={block.text}
              disabled={!canEdit}
              onChange={(event) => onChange({ text: event.target.value })}
            />
          </Field>
        </>
      ) : null}
      {block.type === "bullets" || block.type === "numbered" ? (
        <div className="space-y-2">
          {block.items.map((item, index) => (
            <Field key={index} label={`مورد ${toPersianDigits(index + 1)}`}>
              <div className="flex items-center gap-1">
                <input
                  className={inputClass}
                  value={item}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const items = [...block.items];
                    items[index] = event.target.value;
                    onChange({ items });
                  }}
                />
                <button
                  type="button"
                  aria-label="حذف مورد"
                  disabled={!canEdit}
                  onClick={() => onChange({ items: block.items.filter((_, i) => i !== index) })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <TrashIcon className="size-3.5" aria-hidden />
                </button>
              </div>
            </Field>
          ))}
          <SecondaryButton
            onClick={() => onChange({ items: [...block.items, ""] })}
            disabled={!canEdit || block.items.length >= CONTRACT_LIMITS.listItemsMax}
          >
            <PlusIcon className="me-1 inline size-3.5" aria-hidden /> مورد جدید
          </SecondaryButton>
        </div>
      ) : null}
      {block.type === "table" ? (
        <div className="space-y-2">
          <Field label="عنوان جدول">
            <input
              className={inputClass}
              value={block.caption}
              disabled={!canEdit}
              onChange={(event) => onChange({ caption: event.target.value })}
            />
          </Field>
          <p className="text-[11px] text-muted-foreground">ستون‌ها</p>
          {block.columns.map((column, index) => (
            <div key={index} className="flex items-center gap-1">
              <input
                className={inputClass}
                value={column}
                disabled={!canEdit}
                onChange={(event) => {
                  const columns = [...block.columns];
                  columns[index] = event.target.value;
                  onChange({ columns });
                }}
              />
              <button
                type="button"
                aria-label="حذف ستون"
                disabled={!canEdit || block.columns.length <= 1}
                onClick={() =>
                  onChange({
                    columns: block.columns.filter((_, i) => i !== index),
                    rows: block.rows.map((row) => row.filter((_, i) => i !== index)),
                  })
                }
                className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
              >
                <TrashIcon className="size-3.5" aria-hidden />
              </button>
            </div>
          ))}
          <SecondaryButton
            onClick={() =>
              onChange({
                columns: [...block.columns, `ستون ${toPersianDigits(block.columns.length + 1)}`],
                rows: block.rows.map((row) => [...row, ""]),
              })
            }
            disabled={!canEdit || block.columns.length >= CONTRACT_LIMITS.tableColumnsMax}
          >
            <PlusIcon className="me-1 inline size-3.5" aria-hidden /> ستون جدید
          </SecondaryButton>
          <p className="text-[11px] text-muted-foreground">سطرها</p>
          {block.rows.map((row, rowIndex) => (
            <div key={rowIndex} className="rounded-lg border border-border p-2">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  سطر {toPersianDigits(rowIndex + 1)}
                </span>
                <button
                  type="button"
                  aria-label="حذف سطر"
                  disabled={!canEdit}
                  onClick={() => onChange({ rows: block.rows.filter((_, i) => i !== rowIndex) })}
                  className="rounded p-1 text-muted-foreground hover:bg-muted disabled:opacity-30"
                >
                  <TrashIcon className="size-3.5" aria-hidden />
                </button>
              </div>
              <div className="space-y-1">
                {row.map((cell, cellIndex) => (
                  <input
                    key={cellIndex}
                    className={`${inputClass} h-8 text-xs`}
                    value={cell}
                    aria-label={`${block.columns[cellIndex] ?? "ستون"} — سطر ${rowIndex + 1}`}
                    disabled={!canEdit}
                    onChange={(event) => {
                      const rows = block.rows.map((current, i) =>
                        i === rowIndex
                          ? current.map((value, ci) => (ci === cellIndex ? event.target.value : value))
                          : current,
                      );
                      onChange({ rows });
                    }}
                  />
                ))}
              </div>
            </div>
          ))}
          <SecondaryButton
            onClick={() => onChange({ rows: [...block.rows, block.columns.map(() => "")] })}
            disabled={!canEdit || block.rows.length >= CONTRACT_LIMITS.tableRowsMax}
          >
            <PlusIcon className="me-1 inline size-3.5" aria-hidden /> سطر جدید
          </SecondaryButton>
        </div>
      ) : null}
      {block.type === "signature" ? (
        <>
          <Field label="برچسب جای امضا">
            <input
              className={inputClass}
              value={block.label}
              disabled={!canEdit}
              onChange={(event) => onChange({ label: event.target.value })}
            />
          </Field>
          <Field label="زیرنویس" hint="زیر خط امضا چاپ می‌شود.">
            <input
              className={inputClass}
              value={block.caption}
              disabled={!canEdit}
              onChange={(event) => onChange({ caption: event.target.value })}
            />
          </Field>
          <p className="rounded-lg bg-muted/60 p-2 text-[11px] text-muted-foreground">
            شناسهٔ این جای امضا: <span className="font-mono">{block.slotId}</span> — در بخش «امضا و
            ارسال» به یک امضاکننده تخصیص می‌یابد.
          </p>
        </>
      ) : null}
      {block.type === "divider" || block.type === "page_break" ? (
        <p className="text-[11px] text-muted-foreground">
          {block.type === "divider" ? "خط جداکننده." : "شروع صفحهٔ بعد در چاپ و PDF."}
        </p>
      ) : null}
      {actions}
    </div>
  );
}

function FieldInspector({
  field,
  canEdit,
  onChange,
  onRemove,
  onInsert,
}: {
  field: ContractField;
  canEdit: boolean;
  onChange: (patch: Partial<ContractField>) => void;
  onRemove: () => void;
  onInsert: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-foreground">متغیر</p>
      <Field label="کلید" hint="در متن با {{کلید}} نوشته می‌شود.">
        <input className={inputClass} value={`{{${field.key}}}`} readOnly />
      </Field>
      <Field label="برچسب">
        <input
          className={inputClass}
          value={field.label}
          disabled={!canEdit}
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </Field>
      <Field label="نوع">
        <select
          className={inputClass}
          value={field.type}
          disabled={!canEdit}
          onChange={(event) => onChange({ type: event.target.value as ContractFieldType })}
        >
          {(Object.keys(CONTRACT_FIELD_TYPE_LABELS) as ContractFieldType[]).map((type) => (
            <option key={type} value={type}>
              {CONTRACT_FIELD_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="منبع" hint="با انتخاب منبع، مقدار از همان رکورد خوانده می‌شود.">
        <select
          className={inputClass}
          value={field.binding ? `${field.binding.source}.${field.binding.path}` : ""}
          disabled={!canEdit}
          onChange={(event) => {
            const value = event.target.value;
            if (!value) {
              onChange({ binding: null });
              return;
            }
            const entry = CONTRACT_BINDING_CATALOGUE.find(
              (candidate) => `${candidate.source}.${candidate.path}` === value,
            );
            if (!entry) return;
            onChange({ binding: { source: entry.source, path: entry.path } });
          }}
        >
          <option value="">بدون منبع (مقدار دستی)</option>
          {bindingGroups().map((group) => (
            <optgroup key={group.group} label={group.group}>
              {group.entries.map((entry) => (
                <option key={`${entry.source}.${entry.path}`} value={`${entry.source}.${entry.path}`}>
                  {entry.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {field.type === "select" ? (
        <Field label="گزینه‌ها" hint="هر گزینه در یک سطر.">
          <textarea
            className={`${inputClass} min-h-20 py-2`}
            value={field.options.join("\n")}
            disabled={!canEdit}
            onChange={(event) =>
              onChange({ options: event.target.value.split("\n").map((value) => value.trim()).filter(Boolean) })
            }
          />
        </Field>
      ) : null}
      <Field
        label={field.binding ? "بازنویسی دستی" : "مقدار"}
        hint={
          field.binding
            ? "خالی بگذارید تا مقدار از منبع خوانده شود؛ هر مقداری اینجا، منبع را بازنویسی می‌کند."
            : "مقداری که در سند چاپ می‌شود."
        }
      >
        <input
          className={inputClass}
          value={field.value}
          disabled={!canEdit}
          onChange={(event) => onChange({ value: event.target.value })}
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={field.required}
          disabled={!canEdit}
          onChange={(event) => onChange({ required: event.target.checked })}
        />
        پرکردن این متغیر الزامی است
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SecondaryButton onClick={onInsert} disabled={!canEdit}>
          درج در بلوک انتخابی
        </SecondaryButton>
        <SecondaryButton onClick={onRemove} disabled={!canEdit}>
          <TrashIcon className="me-1 inline size-3.5" aria-hidden /> حذف متغیر
        </SecondaryButton>
      </div>
    </div>
  );
}
