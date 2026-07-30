"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MakeUserHref = (username: string) => string;
type GetHeadingId = (headingText: string) => string;

type Props = {
  markdown: string;
  makeUserHref?: MakeUserHref;
  onUserClick?: (username: string) => void;
  getHeadingId?: GetHeadingId;
  className?: string;
};

function defaultMakeUserHref(username: string): string {
  return `/user/@${encodeURIComponent(username)}`;
}

function extractText(node: React.ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (React.isValidElement(node)) {
    const child = (node.props as { children?: React.ReactNode }).children;
    return extractText(child);
  }
  return "";
}

function transformInline(
  node: React.ReactNode,
  makeUserHref: MakeUserHref,
  onUserClick?: (username: string) => void
): React.ReactNode {
  if (node == null) return node;

  if (typeof node === "string") {
    // Apply ==highlight== first, then @mentions.
    // Note: == == is NOT GFM, but we support it because you asked.
    const out: React.ReactNode[] = [];
    const s = node;

    // Convert ==text== to <mark>
    // Keep it simple; avoid catastrophic regex by iterating.
    const markRe = /==([^=\n]{1,200})==/g;
    let last = 0;
    for (;;) {
      const m = markRe.exec(s);
      if (!m) break;

      const start = m.index;
      const full = m[0];
      const inner = m[1];

      if (start > last) out.push(s.slice(last, start));
      out.push(
        <mark
          key={`mark-${start}`}
          className="rounded bg-amber-400/20 px-1 py-0.5 text-amber-100"
        >
          {inner}
        </mark>
      );
      last = start + full.length;
    }
    if (last < s.length) out.push(s.slice(last));

    const marked = out.length ? out : [s];

    // Now linkify @mentions across the resulting nodes
    const final: React.ReactNode[] = [];
    const mentionRe = /(^|[\s(])@([a-zA-Z0-9_]{3,32})\b/g;

    const processText = (text: string) => {
      let idx = 0;
      for (;;) {
        const match = mentionRe.exec(text);
        if (!match) break;

        const [_, prefix, uname] = match;
        const start = match.index;
        const atIndex = start + prefix.length;

        if (atIndex > idx) final.push(text.slice(idx, atIndex));
        if (prefix) final.push(prefix);

        final.push(
          <a
            key={`m-${atIndex}-${uname}`}
            href={makeUserHref(uname)}
            onClick={(e) => {
              if (!onUserClick) return;
              e.preventDefault();
              onUserClick(uname);
            }}
            className="font-medium underline underline-offset-2 hover:opacity-80"
          >
            @{uname}
          </a>
        );

        idx = atIndex + 1 + uname.length;
      }
      if (idx < text.length) final.push(text.slice(idx));
    };

    for (let i = 0; i < marked.length; i++) {
      const chunk = marked[i];
      if (typeof chunk === "string") processText(chunk);
      else final.push(chunk);
    }

    return final.length ? final : node;
  }

  if (Array.isArray(node)) {
    return node.map((child, i) => (
      <React.Fragment key={i}>{transformInline(child, makeUserHref, onUserClick)}</React.Fragment>
    ));
  }

  if (React.isValidElement(node)) {
    const t = node.type;
    if (t === "code" || t === "pre") return node;

    const child = (node.props as { children?: React.ReactNode }).children;
    if (child === undefined) return node;

    const rewritten = transformInline(child, makeUserHref, onUserClick);
    return React.cloneElement(node, undefined, rewritten);
  }

  return node;
}

export function MarkdownContent({ markdown, makeUserHref, onUserClick, getHeadingId, className }: Props) {
  const hrefFn = makeUserHref ?? defaultMakeUserHref;

  return (
    <div className={className ?? "prose prose-invert max-w-none"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children }) {
            const safeHref = typeof href === "string" ? href : "";
            const isExternal =
              safeHref.startsWith("http://") || safeHref.startsWith("https://");

            return (
              <a
                href={safeHref}
                target={isExternal ? "_blank" : undefined}
                rel={isExternal ? "noreferrer noopener" : undefined}
                className="underline underline-offset-2 hover:opacity-80"
              >
                {transformInline(children, hrefFn, onUserClick)}
              </a>
            );
          },
          p({ children }) {
            return <p>{transformInline(children, hrefFn, onUserClick)}</p>;
          },
          li({ children }) {
            return <li>{transformInline(children, hrefFn, onUserClick)}</li>;
          },
          blockquote({ children }) {
            return <blockquote>{transformInline(children, hrefFn, onUserClick)}</blockquote>;
          },
          h1({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h1 id={id}>{transformInline(children, hrefFn, onUserClick)}</h1>;
          },
          h2({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h2 id={id}>{transformInline(children, hrefFn, onUserClick)}</h2>;
          },
          h3({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h3 id={id}>{transformInline(children, hrefFn, onUserClick)}</h3>;
          },
          h4({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h4 id={id}>{transformInline(children, hrefFn, onUserClick)}</h4>;
          },
          h5({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h5 id={id}>{transformInline(children, hrefFn, onUserClick)}</h5>;
          },
          img({ src, alt }) {
            const safeSrc = typeof src === "string" ? src : "";
            const safeAlt = typeof alt === "string" ? alt : "";
            return (
              <img
                src={safeSrc}
                alt={safeAlt}
                className="max-w-full rounded-xl border border-zinc-800 bg-zinc-950/20"
                loading="lazy"
              />
            );
          },
          h6({ children }) {
            const text = extractText(children).trim();
            const id = getHeadingId ? getHeadingId(text) : undefined;
            return <h6 id={id}>{transformInline(children, hrefFn, onUserClick)}</h6>;
          },
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}
