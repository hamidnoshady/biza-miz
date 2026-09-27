"use client";

/**
 * «اسناد» — the unified document register.
 *
 * A row here is a *document*: a title, the things it belongs to (project,
 * task, contract, customer, accounting entry), a review state and a version
 * chain. The bytes are the Media Library's — uploaded through «رسانه» and
 * referenced by id — so this screen never re-implements storage, quota or
 * preview.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLinkIcon, FilesIcon, PlusIcon, XIcon } from "lucide-react";
import { mediaFileUrl } from "@/app/dashboard/media/media-picker";
import {
  EmptyState,
  KpiCard,
  KpiRow,
  LoadingSkeleton,
  SectionCard,
  overlayPanelClass,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import { FilterChip, FilterChipRow, SearchField } from "@/app/dashboard/filters";
import {
  api,
  ErrorBox,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import {
  DOCUMENT_STATUSES,
  DOCUMENT_STATUS_LABELS,
  type WorkspaceDocumentStatus,
} from "@/lib/workspace-shared";
import {
  DateCell,
  DocumentStatusBadge,
  PickerField,
  SelectField,
  TagList,
  workspaceError,
} from "./workspace-ui";
import type { WorkspaceLookups } from "./use-workspace-lookups";

export interface DocumentRow {
  id: string;
  title: string;
  description: string;
  mediaAssetId: string | null;
  fileName: string | null;
  projectId: string | null;
  projectName: string | null;
  contractId: string | null;
  contractTitle: string | null;
  partyId: string | null;
  partyName: string | null;
  status: WorkspaceDocumentStatus;
  version: number;
  tags: string[];
  commentCount: number;
  createdAt: string;
}

export function DocumentsSection({
  lookups,
  canManage,
  canRequestApproval,
  projectId,
}: {
  lookups: WorkspaceLookups;
  canManage: boolean;
  canRequestApproval: boolean;
  projectId?: string;
}) {
  const [documents, setDocuments] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<WorkspaceDocumentStatus | "">("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<DocumentRow | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (projectId) params.set("projectId", projectId);
    if (status) params.set("status", status);
    if (search.trim()) params.set("q", search.trim());
    const qs = params.toString();
    api<{ documents: DocumentRow[] }>(`/api/workspace/documents${qs ? `?${qs}` : ""}`).then(
      ({ ok, data }) => {
        if (ok) setDocuments(data.documents);
        else setError(workspaceError((data as unknown as { error?: string }).error));
      },
    );
  }, [projectId, status, search]);

  useEffect(load, [load]);

  const totals = useMemo(() => {
    const list = documents ?? [];
    return {
      count: list.length,
      approved: list.filter((d) => d.status === "approved").length,
      review: list.filter((d) => d.status === "in_review").length,
      draft: list.filter((d) => d.status === "draft").length,
    };
  }, [documents]);

  async function requestApproval(document: DocumentRow) {
    const { ok, data } = await api("/api/workspace/approvals", {
      method: "POST",
      body: JSON.stringify({
        subjectType: "document",
        subjectId: document.id,
        projectId: document.projectId,
        title: document.title,
      }),
    });
    if (ok) load();
    else setError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="flex flex-col gap-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <KpiRow>
        <KpiCard label="اسناد" value={toPersianDigits(String(totals.count))} icon={FilesIcon} />
        <KpiCard label="تأییدشده" value={toPersianDigits(String(totals.approved))} />
        <KpiCard label="در حال بررسی" value={toPersianDigits(String(totals.review))} />
        <KpiCard label="پیش‌نویس" value={toPersianDigits(String(totals.draft))} />
      </KpiRow>

      <SectionCard
        title="اسناد"
        description="سند می‌تواند به پروژه، وظیفه، قرارداد، مشتری یا سند حسابداری تعلق داشته باشد. فایل‌ها در «رسانه» نگهداری می‌شوند و اینجا فقط به آن‌ها ارجاع داده می‌شود."
        actions={
          canManage ? (
            <PrimaryButton type="button" onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" aria-hidden />
              ثبت سند
            </PrimaryButton>
          ) : null
        }
        flush
      >
        <div className="flex flex-col gap-3 border-b border-border/80 p-4">
          <SearchField
            label="جست‌وجوی سند"
            value={search}
            onChange={setSearch}
            placeholder="عنوان سند…"
            onClear={() => setSearch("")}
          />
          <FilterChipRow label="فیلتر وضعیت سند">
            <FilterChip selected={status === ""} onClick={() => setStatus("")}>
              همه
            </FilterChip>
            {DOCUMENT_STATUSES.map((value) => (
              <FilterChip key={value} selected={status === value} onClick={() => setStatus(value)}>
                {DOCUMENT_STATUS_LABELS[value]}
              </FilterChip>
            ))}
          </FilterChipRow>
        </div>

        {documents === null ? (
          <LoadingSkeleton rows={5} label="در حال بارگذاری اسناد" />
        ) : documents.length === 0 ? (
          <EmptyState icon={FilesIcon} title="سندی ثبت نشده است">
            نقشه، صورت‌جلسه یا پیوست قرارداد را ثبت کنید تا نسخه و وضعیت تأیید آن پیگیری شود.
          </EmptyState>
        ) : (
          <DataTable caption="فهرست اسناد میز کار" frame={false}>
            <DataTableHead>
              <Th>عنوان</Th>
              <Th>تعلق به</Th>
              <Th>نسخه</Th>
              <Th>وضعیت</Th>
              <Th>ثبت</Th>
              <Th>تأیید</Th>
            </DataTableHead>
            <DataTableBody>
              {documents.map((document) => (
                <DataTableRow key={document.id} onClick={() => setEditing(document)}>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <span className="font-medium">{document.title}</span>
                      {document.fileName ? (
                        document.mediaAssetId ? (
                          // The row's own onClick opens the metadata dialog; this link
                          // must stop that propagation or the file could never be
                          // opened directly — the whole point of listing it here.
                          <a
                            href={mediaFileUrl(document.mediaAssetId)}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(event) => event.stopPropagation()}
                            className="inline-flex w-fit items-center gap-1 text-xs text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                          >
                            <ExternalLinkIcon className="size-3" aria-hidden />
                            {document.fileName}
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">{document.fileName}</span>
                        )
                      ) : null}
                      <TagList tags={document.tags} />
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col text-xs text-muted-foreground">
                      {document.projectName ? <span>پروژه: {document.projectName}</span> : null}
                      {document.contractTitle ? <span>قرارداد: {document.contractTitle}</span> : null}
                      {document.partyName ? <span>مشتری: {document.partyName}</span> : null}
                      {!document.projectName && !document.contractTitle && !document.partyName ? (
                        <span>—</span>
                      ) : null}
                    </div>
                  </Td>
                  <Td className="tabular-nums">
                    نسخهٔ {toPersianDigits(String(document.version))}
                  </Td>
                  <Td>
                    <DocumentStatusBadge status={document.status} />
                  </Td>
                  <Td>
                    <DateCell date={document.createdAt.slice(0, 10)} relative={false} />
                  </Td>
                  <Td>
                    {canRequestApproval && document.status === "draft" ? (
                      <SecondaryButton onClick={() => requestApproval(document)}>
                        درخواست تأیید
                      </SecondaryButton>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>

      {creating || editing ? (
        <DocumentDialog
          lookups={lookups}
          document={editing ?? undefined}
          canManage={canManage}
          defaultProjectId={projectId}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
          onError={setError}
        />
      ) : null}
    </div>
  );
}

function DocumentDialog({
  lookups,
  document,
  canManage,
  defaultProjectId,
  onClose,
  onSaved,
  onError,
}: {
  lookups: WorkspaceLookups;
  document?: DocumentRow;
  canManage: boolean;
  defaultProjectId?: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState(document?.title ?? "");
  const [description, setDescription] = useState(document?.description ?? "");
  const [status, setStatus] = useState<WorkspaceDocumentStatus | "">(document?.status ?? "draft");
  const [projectId, setProjectId] = useState(document?.projectId ?? defaultProjectId ?? "");
  const [partyId, setPartyId] = useState(document?.partyId ?? "");
  const [contractId, setContractId] = useState(document?.contractId ?? "");
  const [mediaAssetId, setMediaAssetId] = useState(document?.mediaAssetId ?? "");
  const [tags, setTags] = useState(document?.tags.join("، ") ?? "");
  const [contracts, setContracts] = useState<Array<{ id: string; title: string }>>([]);
  const [saving, setSaving] = useState(false);

  // The Media Library is the file store; this dialog only references what is
  // already uploaded (the id/name list comes with the shared lookups) rather
  // than adding a second upload path beside «رسانه».
  const media = lookups.media;

  useEffect(() => {
    api<{ contracts: Array<{ id: string; title: string }> }>("/api/workspace/contracts").then(
      ({ ok, data }) => {
        if (ok) setContracts(data.contracts);
      },
    );
  }, []);

  async function submit() {
    if (!title.trim() || saving) return;
    setSaving(true);
    const payload = {
      title,
      description,
      status: status || "draft",
      projectId: projectId || null,
      partyId: partyId || null,
      contractId: contractId || null,
      mediaAssetId: mediaAssetId || null,
      tags: tags.split("،").map((t) => t.trim()).filter(Boolean),
    };
    const { ok, data } = document
      ? await api(`/api/workspace/documents/${document.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      : await api("/api/workspace/documents", { method: "POST", body: JSON.stringify(payload) });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  /**
   * A new version is a NEW row that supersedes this one, never an edit of it —
   * that is what keeps every past revision readable at its own id, which is the
   * whole point of versioning a drawing.
   */
  async function saveAsNewVersion() {
    if (!document || saving) return;
    setSaving(true);
    const { ok, data } = await api("/api/workspace/documents", {
      method: "POST",
      body: JSON.stringify({
        title,
        description,
        status: "draft",
        projectId: projectId || null,
        partyId: partyId || null,
        contractId: contractId || null,
        mediaAssetId: mediaAssetId || null,
        tags: tags.split("،").map((t) => t.trim()).filter(Boolean),
        supersedesId: document.id,
      }),
    });
    setSaving(false);
    if (ok) onSaved();
    else onError(workspaceError((data as unknown as { error?: string }).error));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-foreground/30 p-4 backdrop-blur-sm">
      <div className={`${overlayPanelClass} w-full max-w-2xl`}>
        <div className="flex items-center justify-between border-b border-border/80 p-4">
          <h2 className="text-base font-semibold">{document ? "ویرایش سند" : "ثبت سند"}</h2>
          <SecondaryButton onClick={onClose}>
            <XIcon className="size-4" aria-hidden />
            <span className="sr-only">بستن</span>
          </SecondaryButton>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="عنوان سند">
              <input
                className={inputClass}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </Field>
          </div>
          <div>
            <PickerField
              label="فایل از کتابخانهٔ رسانه"
              value={mediaAssetId}
              onChange={setMediaAssetId}
              options={media.map((m) => ({ id: m.id, label: m.fileName }))}
              placeholder="— بدون فایل —"
              hint="بارگذاری فایل در بخش «رسانه» انجام می‌شود."
            />
            {mediaAssetId ? (
              <a
                href={mediaFileUrl(mediaAssetId)}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
              >
                <ExternalLinkIcon className="size-3" aria-hidden />
                مشاهدهٔ فایل فعلی
              </a>
            ) : null}
          </div>
          <SelectField
            label="وضعیت"
            value={status}
            onChange={setStatus}
            options={DOCUMENT_STATUSES}
            labels={DOCUMENT_STATUS_LABELS}
          />
          <PickerField
            label="پروژه"
            value={projectId}
            onChange={setProjectId}
            options={lookups.projects.map((p) => ({ id: p.id, label: p.name }))}
            placeholder="— بدون پروژه —"
          />
          <PickerField
            label="قرارداد"
            value={contractId}
            onChange={setContractId}
            options={contracts.map((c) => ({ id: c.id, label: c.title }))}
            placeholder="— بدون قرارداد —"
          />
          <PickerField
            label="مشتری / طرف حساب"
            value={partyId}
            onChange={setPartyId}
            options={lookups.parties.map((p) => ({ id: p.id, label: p.name }))}
          />
          <Field label="برچسب‌ها" hint="با «،» جدا کنید">
            <input className={inputClass} value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="توضیح">
              <textarea
                className={`${inputClass} min-h-20`}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/80 p-4">
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {document && canManage ? (
            <SecondaryButton onClick={saveAsNewVersion} disabled={saving}>
              ثبت نسخهٔ تازه
            </SecondaryButton>
          ) : null}
          {canManage ? (
            <PrimaryButton type="button" onClick={submit} disabled={!title.trim() || saving}>
              {saving ? "در حال ذخیره" : "ذخیره"}
            </PrimaryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
