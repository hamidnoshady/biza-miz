"use client";

/**
 * «چاپ و فاکتور» — the whole printing section, in three tabs with cleanly
 * separated concerns:
 *
 *   چاپگرها     — hardware connection: which printer, on which port, with
 *                 which paper. Hardware only — the panel's add/edit dialog
 *                 never asks about templates.
 *   قالب‌ها      — appearance: the built-in presets and this branch's saved
 *                 templates. Business identity/logo are managed centrally in
 *                 Settings → Business Identity and flow into every preview.
 *   قوانین چاپ  — routing: which template and which printer each document
 *                 type uses, and what would actually print right now.
 *
 * The three concerns never mix: appearance lives in templates, hardware in
 * printers, and only a rule joins them.
 */
import { useCallback, useMemo, useState } from "react";
import { FileTextIcon, PrinterIcon, RouteIcon, HistoryIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { printTemplateSample } from "@/lib/printing/client";
import { starterTemplate, type PrintTemplate } from "@/lib/print-template";
import { samplePrintDocument } from "@/lib/print-sample";
import { availableDocumentTypes } from "@/lib/printing/template-catalog";
import { LoadingSkeleton, TabBar, cardClass } from "@/app/dashboard/page-chrome";
import { ErrorBox, InfoBox, api, errorMessage } from "@/app/dashboard/ui";
import { printerErrorMessage } from "@/lib/printing/errors";
import { PrintersPanel } from "./printers-panel";
import { RulesPanel } from "./rules-panel";
import { PrintHistoryPanel } from "./history-panel";
import { TemplateDesigner } from "./template-designer";
import { TemplateGallery } from "./template-gallery";
import { usePrintIdentity, useSavedTemplates, type SavedTemplateRow } from "./use-printing";

type Tab = "printers" | "templates" | "rules" | "history";

const TABS = [
  { key: "printers" as const, label: "چاپگرها" },
  { key: "templates" as const, label: "قالب‌ها" },
  { key: "rules" as const, label: "قوانین چاپ" },
  { key: "history" as const, label: "تاریخچه و عیب‌یابی" },
];

interface Editing {
  template: PrintTemplate;
  /** The row being edited; absent for a brand-new or duplicated template. */
  id?: string;
}

export function PrintingManager() {
  const [tab, setTab] = useState<Tab>("printers");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const saved = useSavedTemplates();
  const identity = usePrintIdentity();
  const money = useMoney();
  const editorDocumentTypes = useMemo(
    () => availableDocumentTypes([...saved.builtIns, ...saved.templates]),
    [saved.builtIns, saved.templates],
  );

  // The preview document: the sample sale, wearing this business's identity
  // and logo, so what the gallery shows is what this shop will print.
  const sample = useMemo(
    () => samplePrintDocument(identity.business, { footer: identity.footer || "با تشکر از خرید شما", unit: money.unit }),
    [identity.business, identity.footer, money.unit],
  );

  /**
   * «چاپ نمونه» — the chosen template, printed through the OPERATIONAL
   * pipeline: the same route the till calls, the same branding resolver, the
   * same renderer, pinned to this exact template. Whatever the server would
   * have printed for a real sale of this document type is what comes out —
   * which is the point: the test print is evidence about production, not a
   * separate preview mechanism.
   */
  const printSample = useCallback(async (template: PrintTemplate) => {
    setError("");
    setNotice("");
    const result = await printTemplateSample(template);
    if (result.ok) {
      setNotice("نمونه از همان مسیر چاپ واقعی ارسال شد.");
      return;
    }
    setError(
      result.error === "connector_not_installed" || result.error === "connector_outdated"
        ? "چاپ از مرورگر به سرویس چاپ بیزامیز نیاز دارد؛ از تب «چاپگرها» آن را نصب کنید."
        : printerErrorMessage(result.error),
    );
  }, []);

  async function selectTemplate(template: PrintTemplate) {
    setSaving(true);
    setError("");
    setNotice("");
    const savedId = "id" in template && typeof template.id === "string" ? template.id : null;
    const { ok, data } = await api<{ error?: string }>("/api/settings/print-rules", {
      method: "PUT",
      body: JSON.stringify({
        documentType: template.docType,
        ...(savedId ? { templateId: savedId } : { templateKey: template.key }),
      }),
    });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("قالب برای چاپ این نوع سند انتخاب شد؛ تنظیمات سفارشی قالب‌های دیگر تغییر نکرد.");
  }

  async function saveTemplate(isDefault: boolean) {
    if (!editing) return;
    setSaving(true);
    setError("");
    const body = JSON.stringify({ template: editing.template, isDefault });
    const { ok, data } = editing.id
      ? await api<{ error?: string }>(`/api/settings/print-templates/${editing.id}`, { method: "PUT", body })
      : await api<{ error?: string }>("/api/settings/print-templates", { method: "POST", body });
    setSaving(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setEditing(null);
    setNotice("قالب ذخیره شد.");
    await saved.reload();
  }

  async function deleteTemplate(template: SavedTemplateRow) {
    if (!window.confirm(`قالب «${template.name}» حذف شود؟`)) return;
    const { ok, data } = await api<{ error?: string }>(`/api/settings/print-templates/${template.id}`, { method: "DELETE" });
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("قالب حذف شد.");
    await saved.reload();
  }

  if (identity.loading) return <LoadingSkeleton rows={5} />;

  if (editing) {
    return (
      <div className="space-y-4">
        <ErrorBox>{error}</ErrorBox>
        <div className={`${cardClass} flex flex-wrap items-center justify-between gap-3 px-4 py-3`}>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">طراحی قالب</p>
            <h2 className="mt-0.5 truncate font-semibold text-foreground">{editing.template.name || "قالب بدون نام"}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void printSample(editing.template)}>
              <PrinterIcon aria-hidden="true" />
              چاپ نمونه
            </Button>
          </div>
        </div>
        <TemplateDesigner
          value={editing.template}
          onChange={(template) => setEditing({ ...editing, template })}
          data={sample}
          onSave={(isDefault) => void saveTemplate(isDefault)}
          onCancel={() => setEditing(null)}
          saving={saving}
          savedLabel={editing.id ? "ذخیرهٔ تغییرات" : "ساخت قالب"}
          availableDocumentTypes={editorDocumentTypes}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error || (saved.error ? "فهرست قالب‌های مجاز خوانده نشد؛ پس از بررسی دسترسی دوباره تلاش کنید." : "")}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <TabBar idPrefix="printing" label="بخش‌های چاپ" tabs={TABS} active={tab} onChange={setTab} />

      {tab === "templates" ? (
        saved.loading ? (
          <LoadingSkeleton rows={4} />
        ) : (
          <TemplateGallery
            saved={saved.templates}
            builtIns={saved.builtIns}
            unavailableTemplates={saved.unavailableTemplates}
            industry={saved.industry}
            data={sample}
            busy={saving}
            onNew={() => setEditing({ template: starterTemplate("thermal80", "receipt") })}
            onDuplicate={(template) =>
              setEditing({
                template: {
                  ...template,
                  key: "",
                  sourceKey: template.sourceKey ?? template.key,
                  name: `${template.name} — کپی`,
                  blocks: template.blocks.map((b) => ({ ...b })),
                  options: { ...template.options },
                },
              })
            }
            onEdit={(template) => setEditing({ id: template.id, template })}
            onDelete={(template) => void deleteTemplate(template)}
            onPrint={(template) => void printSample(template)}
            onSelect={(template) => selectTemplate(template)}
          />
        )
      ) : null}

      {tab === "printers" ? <PrintersPanel /> : null}

      {tab === "rules" ? <RulesPanel /> : null}
      {tab === "history" ? <PrintHistoryPanel /> : null}
    </div>
  );
}

/** Icons the settings nav uses for this section's tabs. Exported for the nav. */
export const PRINTING_TAB_ICONS = { templates: FileTextIcon, printers: PrinterIcon, rules: RouteIcon, history: HistoryIcon };
