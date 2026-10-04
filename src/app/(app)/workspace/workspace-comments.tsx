"use client";

/**
 * A Workspace record's comment thread — shared by the entity drawer and the
 * task drawer.
 */

import { useState } from "react";
import { api, ErrorBox, inputClass, PrimaryButton } from "@/app/dashboard/ui";
import { formatJalali } from "@/lib/jalali";
import type { WorkspaceApprovalSubject } from "@/lib/workspace-shared";
import { workspaceError } from "./workspace-ui";

export interface WorkspaceComment {
  id: string;
  body: string;
  authorName: string;
  createdAt: string;
}

/**
 * The record's comment thread. Posting goes through `/api/workspace/comments`,
 * which re-checks `contribute` on the subject — a viewer who tries gets the
 * server's Persian refusal, not a silent failure.
 */
export function WorkspaceComments({
  subjectType,
  subjectId,
  initial,
}: {
  subjectType: WorkspaceApprovalSubject;
  subjectId: string;
  initial: WorkspaceComment[];
}) {
  const [comments, setComments] = useState(initial);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (!body.trim() || saving) return;
    setSaving(true);
    const { ok, data } = await api<{ comments: WorkspaceComment[]; error?: string }>("/api/workspace/comments", {
      method: "POST",
      body: JSON.stringify({ subjectType, subjectId, body }),
    });
    setSaving(false);
    if (ok) {
      setComments(data.comments);
      setBody("");
      setError("");
    } else setError(workspaceError(data.error));
  }

  return (
    <section aria-label="یادداشت‌ها" className="flex flex-col gap-2 border-t border-border/80 pt-4">
      <h3 className="text-sm font-semibold">یادداشت‌ها</h3>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">هنوز یادداشتی نیست.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {comments.map((comment) => (
            <li key={comment.id} className="rounded-lg bg-muted/40 p-2 text-sm">
              <div className="text-xs text-muted-foreground">
                {comment.authorName} · {formatJalali(comment.createdAt)}
              </div>
              <p className="whitespace-pre-line">{comment.body}</p>
            </li>
          ))}
        </ul>
      )}
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      <label className="sr-only" htmlFor={`comment-${subjectId}`}>یادداشت تازه</label>
      <textarea
        id={`comment-${subjectId}`}
        className={`${inputClass} min-h-20`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="یادداشتی بنویسید…"
      />
      <div>
        <PrimaryButton type="button" onClick={submit} disabled={!body.trim() || saving}>
          {saving ? "در حال ثبت…" : "ثبت یادداشت"}
        </PrimaryButton>
      </div>
    </section>
  );
}
