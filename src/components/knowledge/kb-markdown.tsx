"use client";

/**
 * The knowledge base article renderer — the «متن، تصویر، ویدیو و کد» half of
 * the design system, shared by the three places an article body appears:
 *
 *   - «مرکز آموزش» (/knowledge)            — tone="auto" (tenant theme)
 *   - the console editor's live preview              — tone="dark" (always dark)
 *   - anywhere a guide is embedded later
 *
 * Two rules make it a system rather than a one-off:
 *
 *  - Every heading carries the anchor id from `kbHeadings` (matched by source
 *    line, so the two never drift) plus a chain-link button that copies a
 *    deep link — «لینک به این عنوان» is the feature the whole thing exists
 *    for. The «فهرست این راهنما» (`KbToc`) links to those same ids.
 *  - Code blocks are LTR islands with a copy button and a language badge;
 *    images get the card treatment; videos (KbVideo) play inline (a file) or
 *    embed (a video host) depending on what the URL points at.
 *
 * Colours come from the two tone maps below only — the tenant theme tokens
 * flip with dark mode, and the console's dark map keeps this file inside the
 * shared-components design lint (paired dark: classes).
 */
import { useCallback, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CheckIcon,
  ClipboardIcon,
  LinkIcon,
  MonitorPlayIcon,
} from "lucide-react";
import {
  decodeKbHeadingHash,
  kbHeadings,
  kbVideoSource,
  parseHttpUrl,
  scrollToKbHeading,
  type KbHeading,
} from "@/lib/knowledge";

export type KbTone = "auto" | "dark";

const TONE = {
  auto: {
    body: "text-foreground/85",
    strong: "text-foreground",
    muted: "text-muted-foreground",
    heading: "text-foreground",
    headingAnchor:
      "text-muted-foreground/50 hover:text-foreground focus-visible:text-foreground",
    link: "text-teal-700 underline decoration-teal-700/40 underline-offset-4 hover:text-teal-800 dark:text-teal-300 dark:decoration-teal-300/40 dark:hover:text-teal-200",
    inlineCode: "rounded bg-muted px-1.5 py-0.5 text-[0.85em] text-foreground",
    codeBlock:
      "border border-border bg-stone-900 text-stone-100 dark:bg-stone-950 ",
    codeHeader: "border-b border-white/10 text-muted-foreground dark:text-muted-foreground",
    codeButton: "text-stone-300 hover:bg-white/10  dark:hover:bg-white/15",
    quote: "border-e-2 border-amber-400/50 dark:border-amber-400/50 text-muted-foreground",
    tableWrap: "border border-border",
    thead: "bg-muted/60",
    tr: "border-border/70",
    img: "border border-border",
    hr: "border-border",
    videoFrame: "border border-border bg-muted",
    tocItem: "text-muted-foreground hover:text-foreground",
    tocItemActive: "text-amber-800 font-semibold dark:text-amber-300",
  },
  dark: {
    body: "text-white/80",
    strong: "text-white",
    muted: "text-white/50",
    heading: "text-white",
    headingAnchor: "text-white/40 hover:text-white focus-visible:text-white",
    link: "text-sky-300 underline decoration-sky-300/40 underline-offset-4 hover:text-sky-200 dark:text-sky-300 dark:hover:text-sky-200",
    inlineCode: "rounded bg-white/10 px-1.5 py-0.5 text-[0.85em] text-white/90",
    codeBlock: "border border-white/10 bg-black/50 text-white/90",
    codeHeader: "border-b border-white/10 text-white/40 dark:text-white/40",
    codeButton: "text-white/60 hover:bg-white/10 dark:text-white/60",
    quote: "border-e-2 border-sky-400/40 text-white/60 dark:border-sky-400/40",
    tableWrap: "border border-white/10",
    thead: "bg-white/5",
    tr: "border-white/10",
    img: "border border-white/10",
    hr: "border-white/10",
    videoFrame: "border border-white/10 bg-black/40",
    tocItem: "text-white/50 hover:text-white/90",
    tocItemActive: "text-sky-300 font-semibold dark:text-sky-300",
  },
} as const;

type HeadingNode = { position?: { start?: { line?: number } } };

function headingIdByLine(headings: KbHeading[]): Map<number, KbHeading> {
  return new Map(headings.map((h) => [h.line, h]));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The chain-link shown beside each heading; copies the deep link and sets the hash. */
function AnchorButton({
  id,
  className,
}: {
  id: string;
  className: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onClick = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}#${encodeURIComponent(id)}`;
    history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    if (await copyText(url)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }
  }, [id]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="کپی پیوند این عنوان"
      title="کپی پیوند این عنوان"
      className={`inline-flex size-7 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity focus-visible:opacity-100 group-hover/heading:opacity-100 ${className}`}
    >
      {copied ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : (
        <LinkIcon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

function headingRenderer(
  Tag: "h2" | "h3" | "h4",
  byLine: Map<number, KbHeading>,
  tone: KbTone,
) {
  const t = TONE[tone];
  const sizes = { h2: "text-xl", h3: "text-base", h4: "text-sm" } as const;
  return function Heading({ children, node }: { children?: React.ReactNode; node?: unknown }) {
    const line = (node as HeadingNode | undefined)?.position?.start?.line;
    const heading = typeof line === "number" ? byLine.get(line) : undefined;
    const cls = `group/heading mt-8 mb-3 flex scroll-mt-24 items-start gap-2 font-bold first:mt-0 ${sizes[Tag]} ${t.heading}`;
    if (!heading) return <Tag className={cls}>{children}</Tag>;
    return (
      <Tag id={heading.id} className={cls}>
        <span className="min-w-0">{children}</span>
        <AnchorButton id={heading.id} className={t.headingAnchor} />
      </Tag>
    );
  };
}

/** The fenced code block: LTR body, language badge, «کپی» button. */
function CodeBlock({
  language,
  code,
  tone,
}: {
  language: string;
  code: string;
  tone: KbTone;
}) {
  const t = TONE[tone];
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  async function onCopy() {
    if (await copyText(code)) {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <div dir="ltr" className={`my-4 overflow-hidden rounded-xl text-start ${t.codeBlock}`}>
      <div className={`flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] ${t.codeHeader}`}>
        <span className="font-mono tracking-wide">{language || "code"}</span>
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label="کپی کد"
          title="کپی کد"
          className={`inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors ${t.codeButton}`}
        >
          {copied ? (
            <CheckIcon className="size-3.5" aria-hidden="true" />
          ) : (
            <ClipboardIcon className="size-3.5" aria-hidden="true" />
          )}
          <span dir="rtl">{copied ? "کپی شد" : "کپی"}</span>
        </button>
      </div>
      {/* tabIndex makes the horizontally scrolling code readable by keyboard
          users who cannot drag the overflow area. */}
      <pre tabIndex={0} aria-label="نمونه‌کد" className="overflow-x-auto p-3 text-[12.5px] leading-6">
        <code className="font-mono">{code}</code>
      </pre>
    </div>
  );
}

function buildComponents(tone: KbTone, byLine: Map<number, KbHeading>): Components {
  const t = TONE[tone];
  return {
    h1: ({ children }) => (
      // The article title lives in the page header; a `#` line in the body is
      // a section title, rendered at h2 scale.
      <p className={`mt-8 mb-3 text-xl font-bold first:mt-0 ${t.heading}`}>{children}</p>
    ),
    h2: headingRenderer("h2", byLine, tone),
    h3: headingRenderer("h3", byLine, tone),
    h4: headingRenderer("h4", byLine, tone),
    p: ({ children }) => <p className="my-3 break-words leading-7 first:mt-0 last:mb-0">{children}</p>,
    strong: ({ children }) => <strong className={`font-bold ${t.strong}`}>{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    ul: ({ children }) => (
      <ul className="my-3 list-disc space-y-1.5 pe-6 leading-7 marker:text-current/50">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-3 list-decimal space-y-1.5 pe-6 leading-7 marker:text-current/50">{children}</ol>
    ),
    li: ({ children }) => <li className="break-words ps-1">{children}</li>,
    a: ({ href, children }) => {
      if (href?.startsWith("#")) {
        return (
          <a
            href={href}
            className={`break-words font-medium ${t.link}`}
            onClick={(e) => {
              e.preventDefault();
              const id = decodeKbHeadingHash(href);
              // Sticky-header offset and reduced-motion handling live in one
              // helper, shared with the TOC and the post-load deep link.
              scrollToKbHeading(id, { smooth: true });
            }}
          >
            {children}
          </a>
        );
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className={`break-words font-medium ${t.link}`}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => (
      <img
        src={typeof src === "string" ? src : ""}
        // An empty alt marks a decorative image; a missing one would otherwise
        // make a screen reader read the file name.
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        className={`mx-auto my-4 max-h-[420px] max-w-full rounded-xl object-contain ${t.img}`}
      />
    ),
    code: ({ className, children, node }) => {
      const isBlock = Boolean(className) || false;
      const text = String(children ?? "").replace(/\n$/, "");
      if (!isBlock) {
        return <code dir="ltr" className={`${t.inlineCode} break-all font-mono`}>{text}</code>;
      }
      const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "";
      void node;
      return <CodeBlock language={language} code={text} tone={tone} />;
    },
    pre: ({ children }) => <>{children}</>,
    blockquote: ({ children }) => (
      <blockquote className={`my-3 rounded-lg px-3 py-1.5 ${t.quote}`}>{children}</blockquote>
    ),
    table: ({ children }) => (
      <div
        role="region"
        aria-label="جدول"
        tabIndex={0}
        className={`my-4 overflow-x-auto rounded-xl ${t.tableWrap}`}
      >
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className={t.thead}>{children}</thead>,
    tr: ({ children }) => <tr className={`border-b last:border-0 ${t.tr}`}>{children}</tr>,
    th: ({ children }) => (
      <th className="whitespace-nowrap px-3 py-2 text-start font-semibold">{children}</th>
    ),
    td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
    hr: () => <hr className={`my-6 ${t.hr}`} />,
  };
}

export function KbMarkdown({
  content,
  tone = "auto",
  className,
}: {
  content: string;
  tone?: KbTone;
  className?: string;
}) {
  const headings = useMemo(() => kbHeadings(content), [content]);
  const byLine = useMemo(() => headingIdByLine(headings), [headings]);
  const components = useMemo(() => buildComponents(tone, byLine), [tone, byLine]);
  const t = TONE[tone];
  return (
    <div dir="rtl" className={`min-w-0 text-sm leading-7 ${t.body} ${className ?? ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

/**
 * 《در این صفحه》 — the article's headings as anchor links. Clicking smooth-
 * scrolls (headings carry scroll-mt) and writes the hash so the link is
 * shareable; used by the article page and available to the console preview.
 */
export function KbToc({
  headings,
  tone = "auto",
  title = "فهرست این راهنما",
}: {
  headings: KbHeading[];
  tone?: KbTone;
  title?: string;
}) {
  const t = TONE[tone];
  if (!headings.length) return null;
  return (
    <nav aria-label={title}>
      <p className={`mb-2 text-xs font-semibold ${t.muted}`}>{title}</p>
      <ol className="space-y-1">
        {headings.map((h) => (
          <li
            key={h.id}
            style={{ paddingInlineStart: `${(Math.min(h.depth, 4) - 2) * 14}px` }}
          >
            <a
              href={`#${encodeURIComponent(h.id)}`}
              onClick={(e) => {
                e.preventDefault();
                scrollToKbHeading(h.id, { smooth: true });
              }}
              className={`block rounded-md px-2 py-1 text-[13px] leading-5 transition-colors ${t.tocItem}`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * An article's video.
 *
 *  - a direct file plays in the native player;
 *  - YouTube/Aparat/Vimeo pages are converted to their embed URL and rendered
 *    in a sandboxed 16:9 frame with a strict referrer policy;
 *  - any other http(s) URL is **not** framed (it has no embed contract and may
 *    send `X-Frame-Options: DENY`), but is still offered as an explicit link,
 *    so content written before this hardening keeps working;
 *  - a non-http value renders nothing (the editor already refuses it).
 *
 * The external link is always visible below the player: a host that refuses
 * framing leaves an empty rectangle, and the reader still has a way through.
 */
export function KbVideo({ url, tone = "auto" }: { url: string; tone?: KbTone }) {
  const source = kbVideoSource(url);
  const t = TONE[tone];
  const external = parseHttpUrl(url);
  if (!source && !external) return null;
  if (!source && external) {
    return (
      <figure className="not-prose my-5 rounded-xl border border-dashed border-border px-4 py-5">
        <div className={`flex items-center gap-2 text-xs ${t.muted}`}>
          <MonitorPlayIcon className="size-4" aria-hidden="true" />
          <span>ویدیوی آموزشی</span>
        </div>
        <p className={`mt-2 text-xs leading-5 ${t.muted}`}>
          این سرویس قاب تعبیه‌شده ندارد؛ ویدیو را در تب جدید باز کنید.
        </p>
        <a
          href={external.toString()}
          target="_blank"
          rel="noopener noreferrer"
          className={`mt-3 inline-flex items-center gap-1.5 text-sm font-medium ${t.link}`}
        >
          باز کردن ویدیو در تب جدید
        </a>
      </figure>
    );
  }
  const resolved = source!;
  return (
    <figure className="not-prose my-5">
      <div className={`flex items-center gap-2 pb-2 text-xs ${t.muted}`}>
        <MonitorPlayIcon className="size-4" aria-hidden="true" />
        <span>
          {resolved.kind === "file" ? "ویدیوی آموزشی" : "ویدیوی آموزشی (پخش از سرویس میزبان)"}
        </span>
      </div>
      {resolved.kind === "file" ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={resolved.src}
          aria-label="ویدیوی آموزشی"
          className={`aspect-video w-full rounded-xl ${t.videoFrame}`}
        >
          مرورگر شما از پخش ویدیو پشتیبانی نمی‌کند؛ فایل را از پیوند زیر باز کنید.
        </video>
      ) : (
        <iframe
          src={resolved.src}
          title="ویدیوی آموزشی"
          loading="lazy"
          allowFullScreen
          // The frame gets only what a video player needs. `allow-same-origin`
          // is required by YouTube's player; scripts cannot reach the parent.
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen"
          referrerPolicy="strict-origin-when-cross-origin"
          className={`aspect-video w-full rounded-xl ${t.videoFrame}`}
        />
      )}
      <figcaption className={`mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] ${t.muted}`}>
        <span>برای دیدن زیرنویس، در پخش‌کننده دکمهٔ CC را فعال کنید.</span>
        <a
          href={resolved.kind === "file" ? resolved.src : resolved.externalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={`font-medium underline underline-offset-4 ${t.link}`}
        >
          باز کردن ویدیو در تب جدید
        </a>
      </figcaption>
    </figure>
  );
}

export { kbHeadings };
