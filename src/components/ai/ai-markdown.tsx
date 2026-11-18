"use client";

/**
 * The assistant's replies are Markdown, and until now they were rendered with
 * `whitespace-pre-wrap` — so a reply came out with literal `**bold**` markers
 * and a table arrived as a wall of `|---|---|` pipes. This renders it properly.
 *
 * Three constraints shape every override below, all of them from the phone:
 *
 *  - **Nothing may widen the page.** A café owner reads this on a 360px screen.
 *    Any element that can be intrinsically wide — a table, a code block, a long
 *    unbroken token like a URL or a UUID — is either wrapped in its own
 *    horizontally scrolling box or forced to break. The page itself must never
 *    scroll sideways, which is what `min-w-0` + `break-words` buy here.
 *  - **RTL is the default, not a variant.** Lists indent on the right, tables
 *    align right; the document direction comes from the app shell, so nothing
 *    here sets `dir` and fights it.
 *  - **It is a chat bubble, not a document.** Headings are small, margins are
 *    tight, and the first/last child loses its outer margin so the bubble does
 *    not grow a band of empty space.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => <p className="my-1.5 break-words first:mt-0 last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,

  ul: ({ children }) => (
    <ul className="my-1.5 list-disc space-y-1 pe-5 first:mt-0 last:mb-0">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1.5 list-decimal space-y-1 pe-5 first:mt-0 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="break-words">{children}</li>,

  h1: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="mb-1 mt-2.5 text-[13px] font-semibold first:mt-0">{children}</h4>
  ),

  // The table is the whole reason this file exists. It gets its own scroll
  // container so a five-column report can be read by swiping the table itself,
  // while the conversation around it stays put.
  table: ({ children }) => (
    <div className="my-2 -mx-1 overflow-x-auto px-1">
      <table className="w-max min-w-full border-collapse text-right text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/70">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-border/80 last:border-0">{children}</tr>,
  th: ({ children }) => (
    <th className="whitespace-nowrap px-2 py-1.5 text-right font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="whitespace-nowrap px-2 py-1.5 text-right">{children}</td>,

  code: ({ className, children }) => {
    // react-markdown gives a fenced block a language class and an inline span
    // none, which is the only reliable way to tell them apart here.
    const isBlock = Boolean(className);
    if (isBlock) {
      return (
        <code className="block overflow-x-auto whitespace-pre px-3 py-2 text-[12px] leading-5">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded bg-muted/70 px-1 py-0.5 text-[12px] break-all">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-hidden rounded-lg bg-muted text-start" dir="ltr">
      {children}
    </pre>
  ),

  a: ({ href, children }) => (
    <a href={href} className="break-all font-medium text-primary underline">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-e-2 border-border pe-2 text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
};

export function AiMarkdown({ content, className, plainLinks = false }: { content: string; className?: string; plainLinks?: boolean }) {
  return (
    <div className={cn("min-w-0 text-sm leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml
        disallowedElements={plainLinks ? ["a", "img"] : undefined} unwrapDisallowed={plainLinks}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
