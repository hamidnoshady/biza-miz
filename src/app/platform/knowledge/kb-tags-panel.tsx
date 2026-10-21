"use client";

/**
 * «برچسب‌ها» tab — tagging for the knowledge base.
 *
 * Tags cut across the category tree: «آفلاین»، «چاپ»، «صندوق» … so a member
 * reading about the printer sees every guide that touches printing. The
 * member centre renders them as #chips that filter the article list.
 */
import { useCallback, useEffect, useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { suggestKbSlug } from "@/lib/knowledge";
import {
  api,
  Button,
  EmptyState,
  ErrorBox,
  Field,
  InfoBox,
  SkeletonRows,
  errorMessage,
  inputClass,
  useCan,
} from "../ui";
import type { ConsoleTag } from "./kb-types";

export function TagsPanel() {
  const can = useCan();
  const canManage = can("knowledge.manage");
  const [rows, setRows] = useState<ConsoleTag[] | null>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");

  const [editing, setEditing] = useState<ConsoleTag | "new" | null>(null);
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ tags: ConsoleTag[]; error?: string }>(
      "/api/platform/knowledge/tags",
    );
    if (ok) {
      setRows(data.tags);
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openEditor(row: ConsoleTag | "new") {
    setEditing(row);
    setLabel(row === "new" ? "" : row.label);
    setSlug(row === "new" ? "" : row.slug);
    setDescription(row === "new" ? "" : row.description);
    setFormError("");
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setFormError("");
    const payload = {
      label,
      slug: slug.trim() || suggestKbSlug(label),
      description,
    };
    const { ok, data } = await api<{ error?: string }>(
      editing === "new" ? "/api/platform/knowledge/tags" : `/api/platform/knowledge/tags/${editing?.id}`,
      { method: editing === "new" ? "POST" : "PUT", body: JSON.stringify(payload) },
    );
    setBusy(false);
    if (!ok) {
      setFormError(errorMessage(data.error));
      return;
    }
    setEditing(null);
    void load();
  }

  async function remove(row: ConsoleTag) {
    if (busyId) return;
    if (!window.confirm(`برچسب «${row.label}» حذف شود؟ از همهٔ راهنماها جدا می‌شود.`)) return;
    setBusyId(row.id);
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/knowledge/tags/${row.id}`,
      { method: "DELETE" },
    );
    setBusyId("");
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    void load();
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <InfoBox>
        برچسب‌ها موضوع‌های فراگیرند (مثل «چاپ فاکتور» یا «تیم‌کاری»)؛ یک راهنما می‌تواند چند
        برچسب داشته باشد و اعضا با هر برچسب راهنماها را فیلتر می‌کنند.
      </InfoBox>

      {rows === null ? null : <ErrorBox>{error}</ErrorBox>}

      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          {rows ? `${rows.length} برچسب` : "برچسب‌ها"}
        </h2>
        {canManage ? (
          <Button onClick={() => openEditor("new")}>
            <span className="inline-flex items-center gap-1.5">
              <PlusIcon className="size-4" aria-hidden="true" />
              برچسب جدید
            </span>
          </Button>
        ) : null}
      </div>

      {rows === null ? (
        error ? (
          <div
            role="alert"
            className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-5"
          >
            <p className="text-sm font-semibold text-foreground">فهرست برچسب‌ها بارگذاری نشد</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{error}</p>
            <Button className="mt-3" variant="ghost" onClick={() => void load()}>
              تلاش دوباره
            </Button>
          </div>
        ) : (
          <SkeletonRows rows={4} />
        )
      ) : rows.length === 0 ? (
        <EmptyState title="هنوز برچسبی نیست" hint="اولین برچسب را بسازید؛ مثلاً «چاپ» یا «آفلاین»." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="min-w-[520px] w-full text-sm">
            <thead className="bg-card text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-start font-medium">برچسب</th>
                <th className="px-4 py-3 text-start font-medium">نامک</th>
                <th className="px-4 py-3 text-start font-medium">راهنماها</th>
                {canManage ? <th className="px-4 py-3 text-start font-medium">عملیات</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-border align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium text-foreground">#{row.label}</p>
                    {row.description ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">{row.description}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground" dir="ltr">
                    {row.slug}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{row.articleCount}</td>
                  {canManage ? (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="ghost"
                          className="h-8 px-3 text-xs"
                          onClick={() => openEditor(row)}
                        >
                          <span className="inline-flex items-center gap-1">
                            <PencilIcon className="size-3.5" aria-hidden="true" />
                            ویرایش
                          </span>
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-8 px-2 text-xs text-red-700 dark:text-red-300 hover:bg-red-500/10"
                          disabled={Boolean(busyId)}
                          onClick={() => void remove(row)}
                        >
                          <Trash2Icon className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4"
          role="dialog"
          aria-modal="true"
          aria-label={editing === "new" ? "برچسب جدید" : "ویرایش برچسب"}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setEditing(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-popover p-5">
            <h3 className="text-base font-bold text-foreground">
              {editing === "new" ? "برچسب جدید" : "ویرایش برچسب"}
            </h3>
            <div className="mt-5">
              <Field label="نام برچسب" hint="همانی است که اعضا کنار # می‌بینند.">
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  className={inputClass}
                  autoFocus
                />
              </Field>
              <Field label="نامک (slug)" hint="حروف کوچک انگلیسی و خط تیره.">
                <input
                  type="text"
                  dir="ltr"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={suggestKbSlug(label) || "printing"}
                  className={inputClass}
                />
              </Field>
              <Field label="توضیح (اختیاری)">
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className={inputClass}
                  maxLength={500}
                />
              </Field>

              {formError ? <ErrorBox>{formError}</ErrorBox> : null}

              <div className="flex items-center justify-end gap-2">
                <Button variant="ghost" onClick={() => setEditing(null)}>
                  انصراف
                </Button>
                <Button onClick={() => void save()} disabled={busy || !label.trim()}>
                  {busy ? "در حال ذخیره…" : "ذخیره"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
