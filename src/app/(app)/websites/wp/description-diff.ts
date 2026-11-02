/**
 * A line diff small enough to read, for the storefront text editor (#1215, P1-2).
 *
 * The editor shows what an Apply will change *before* it is sent, because the
 * change leaves for a live shopfront and the confirmation only says "queued".
 * Comparing the two versions line by line is the honest form of that preview:
 * a long description is Gutenberg HTML with one block per line or two, so the
 * line is a meaningful unit, and a reader can see exactly which blocks move.
 *
 * Plain LCS over lines. A description is bounded at 20 000 characters, but
 * could still be thousands of blocks in pathological HTML; `maxLines` keeps
 * the table (and the render) bounded — past it the diff degrades to a truthful
 * "too long to compare" rather than a silent truncation of the *content*.
 */
export interface DiffLine {
  kind: "same" | "added" | "removed";
  text: string;
}

export const DIFF_DEFAULT_MAX_LINES = 400;

function toLines(text: string): string[] {
  // A trailing newline is a formatting artefact, not a line the store will show.
  const normalized = text.replace(/\r\n/g, "\n");
  return normalized === "" ? [] : normalized.replace(/\n$/, "").split("\n");
}

/**
 * Line-level diff of `before` → `after`.
 *
 * Returns `null` when either side exceeds `maxLines`: a comparison nobody can
 * trust is worse than telling the reader it was not attempted.
 */
export function diffLines(
  before: string,
  after: string,
  options: { maxLines?: number } = {},
): DiffLine[] | null {
  const maxLines = options.maxLines ?? DIFF_DEFAULT_MAX_LINES;
  const a = toLines(before ?? "");
  const b = toLines(after ?? "");
  if (a.length > maxLines || b.length > maxLines) return null;

  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "same", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ kind: "removed", text: a[i] });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ kind: "removed", text: a[i] });
    i += 1;
  }
  while (j < b.length) {
    out.push({ kind: "added", text: b[j] });
    j += 1;
  }
  return out;
}

/** Whether a diff carries any change at all — what gates the Apply button. */
export function diffHasChanges(lines: DiffLine[] | null): boolean {
  return lines !== null && lines.some((line) => line.kind !== "same");
}
