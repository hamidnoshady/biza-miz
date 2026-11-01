/**
 * Issue #908 — the one renderer for a contract document.
 *
 * The editor's A4 preview, the signed receipt and the public signer's page all
 * draw the document from the SAME block tree with the SAME component, so what a
 * manager reviews cannot differ from what a signer is asked to sign. It is a
 * plain server-safe component (no hooks, no state) because the signer page has
 * no session and the editor only needs to pass different props.
 *
 * Deliberate choices:
 *
 *  - **No HTML strings.** Every visible character is a React text node produced
 *    from `tokenizeTemplate`, so the public signing page cannot be made to
 *    execute anything a sender typed (the epic's XSS requirement).
 *  - **An unresolved variable is visible, not fatal.** In the editor a
 *    `{{token}}` with no value renders as a warm chip («تعریف نشده») so the
 *    sender can see what is missing; a frozen version has every value resolved
 *    by construction, so the signer never sees the chip.
 *  - **Paper is a preview, not a paginator.** The sheet is styled to A4
 *    proportions and the print rules put real page breaks where the document
 *    has `page_break` blocks; a browser that paginates differently is printing
 *    the same content, and pretending otherwise with a manual paginator would
 *    be the "second printing framework" the epic forbids.
 */
import { cardClass } from "@/app/dashboard/page-chrome";
import {
  renderTemplate,
  tokenizeTemplate,
  type ContractBlock,
  type ContractDocumentContent,
} from "@/lib/contracts/blocks";

export interface SignedSlot {
  fullName: string;
  signedAt: string;
  drawnImage: string | null;
}

function RichText({
  value,
  values,
  markUnresolved,
}: {
  value: string;
  values: Record<string, string>;
  markUnresolved: boolean;
}) {
  const segments = tokenizeTemplate(value, values);
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.text}</span>;
        if (segment.value !== null && segment.value !== "") {
          return (
            <span key={index} className="font-medium text-foreground">
              {segment.value}
            </span>
          );
        }
        if (!markUnresolved) return <span key={index} />;
        return (
          <span
            key={index}
            className="mx-0.5 rounded-md bg-amber-100 px-1 text-[11px] font-medium text-amber-900 dark:bg-amber-500/20 dark:text-amber-200"
            title={segment.key}
          >
            تعریف نشده
          </span>
        );
      })}
    </>
  );
}

function Block({
  block,
  values,
  signed,
  markUnresolved,
}: {
  block: ContractBlock;
  values: Record<string, string>;
  signed: Record<string, SignedSlot>;
  markUnresolved: boolean;
}) {
  switch (block.type) {
    case "heading":
      return (
        <h2 className="mt-6 mb-2 text-[15px] font-semibold text-foreground first:mt-0">
          <RichText value={block.text} values={values} markUnresolved={markUnresolved} />
        </h2>
      );
    case "paragraph":
      return (
        <p className="mb-3 text-[13px] leading-7 text-foreground/90">
          <RichText value={block.text} values={values} markUnresolved={markUnresolved} />
        </p>
      );
    case "article":
      return (
        <section className="mb-3">
          <h3 className="mb-1 text-[13px] font-semibold text-foreground">
            <RichText value={block.title} values={values} markUnresolved={markUnresolved} />
          </h3>
          {block.text ? (
            <p className="text-[13px] leading-7 text-foreground/90">
              <RichText value={block.text} values={values} markUnresolved={markUnresolved} />
            </p>
          ) : null}
        </section>
      );
    case "bullets":
    case "numbered": {
      const List = block.type === "bullets" ? "ul" : "ol";
      return (
        <List
          className={`mb-3 space-y-1 ps-5 text-[13px] leading-7 text-foreground/90 ${
            block.type === "bullets" ? "list-disc" : "list-decimal"
          }`}
        >
          {block.items.map((item, index) => (
            <li key={index}>
              <RichText value={item} values={values} markUnresolved={markUnresolved} />
            </li>
          ))}
        </List>
      );
    }
    case "table":
      return (
        <figure className="mb-4 overflow-x-auto">
          {block.caption ? (
            <figcaption className="mb-1 text-[12px] font-medium text-muted-foreground">
              <RichText value={block.caption} values={values} markUnresolved={markUnresolved} />
            </figcaption>
          ) : null}
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr>
                {block.columns.map((column, index) => (
                  <th
                    key={index}
                    className="border border-border bg-muted/60 px-2 py-1.5 text-start font-medium text-foreground"
                  >
                    <RichText value={column} values={values} markUnresolved={markUnresolved} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="border border-border px-2 py-1.5 text-start text-foreground/90"
                    >
                      <RichText value={cell} values={values} markUnresolved={markUnresolved} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      );
    case "divider":
      return <hr className="my-5 border-border" />;
    case "page_break":
      return (
        <div
          className="my-6 border-t border-dashed border-border print:break-after-page"
          aria-hidden
        />
      );
    case "signature": {
      const signature = signed[block.slotId];
      return (
        <div className="mt-6 mb-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-card p-3">
            <p className="mb-2 text-[12px] font-medium text-foreground">
              <RichText value={block.label} values={values} markUnresolved={markUnresolved} />
            </p>
            {signature ? (
              <div className="space-y-1">
                {signature.drawnImage ? (
                  <img
                    src={signature.drawnImage}
                    alt={`امضای ${signature.fullName}`}
                    className="h-16 w-auto"
                  />
                ) : null}
                <p className="text-[12px] font-semibold text-foreground">{signature.fullName}</p>
                <p className="text-[11px] text-muted-foreground">{signature.signedAt}</p>
              </div>
            ) : (
              <div className="h-16 rounded-lg border-b border-dashed border-border" />
            )}
            <p className="mt-2 text-[11px] text-muted-foreground">
              <RichText value={block.caption} values={values} markUnresolved={markUnresolved} />
            </p>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

export function ContractDocumentSheet({
  content,
  values,
  signed = {},
  markUnresolved = false,
  businessName,
  className = "",
}: {
  content: ContractDocumentContent;
  /** Resolved values; defaults to the frozen snapshot stored on the version. */
  values?: Record<string, string>;
  signed?: Record<string, SignedSlot>;
  /** Editor only: show a chip where a `{{token}}` has no value. */
  markUnresolved?: boolean;
  businessName?: string;
  className?: string;
}) {
  const resolved = values ?? content.values ?? {};
  return (
    <article
      dir="rtl"
      className={`${cardClass} mx-auto w-full max-w-[210mm] px-6 py-8 text-foreground sm:px-10 ${className}`}
      aria-label={content.title}
    >
      {content.headerText ? (
        <p className="mb-6 border-b border-border pb-3 text-[12px] text-muted-foreground">
          <RichText value={content.headerText} values={resolved} markUnresolved={markUnresolved} />
        </p>
      ) : null}
      <header className="mb-6 text-center">
        {businessName ? (
          <p className="text-[11px] tracking-wide text-muted-foreground">{businessName}</p>
        ) : null}
        <h1 className="mt-1 text-lg font-semibold text-foreground">
          <RichText value={content.title || "—"} values={resolved} markUnresolved={markUnresolved} />
        </h1>
      </header>
      {content.blocks.map((block) => (
        <Block
          key={block.id}
          block={block}
          values={resolved}
          signed={signed}
          markUnresolved={markUnresolved}
        />
      ))}
      {content.footerText ? (
        <footer className="mt-8 border-t border-border pt-3 text-[11px] text-muted-foreground">
          <RichText value={content.footerText} values={resolved} markUnresolved={markUnresolved} />
        </footer>
      ) : null}
    </article>
  );
}

/** The plain text of a document, for `<title>` and search snippets. */
export function documentPlainTitle(content: ContractDocumentContent): string {
  return renderTemplate(content.title || "قرارداد", content.values ?? {});
}
