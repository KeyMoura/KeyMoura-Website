"use client";

import { useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { supabaseBrowser } from "@/lib/supabaseClient";

type MentionSuggestion = {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: number | null;
};

type MarkdownEditorProps = {
  label?: string;
  helperText?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  id?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** Enable @username autocomplete suggestions (defaults true). */
  enableMentions?: boolean;
  /** Current viewer id (used to avoid suggesting yourself). */
  currentUserId?: string | null;
  /** Blocked user ids (used to filter suggestions). */
  blockedUserIds?: Set<string>;
};

export function MarkdownEditor({
  label,
  helperText,
  value,
  onChange,
  rows = 12,
  id = "markdown-editor",
  placeholder = "Write in Markdown…",
  disabled = false,
  className,
  onKeyDown,
  textareaRef,
  enableMentions = true,
  currentUserId = null,
  blockedUserIds,
}: MarkdownEditorProps) {
  const [mode, setMode] = useState<"write" | "preview">("write");
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const taRef = useMemo(() => textareaRef ?? innerRef, [textareaRef]);

  // --- @mention autocomplete ---
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionItems, setMentionItems] = useState<MentionSuggestion[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const [mentionStartIndex, setMentionStartIndex] = useState<number | null>(null);
  const mentionReqSeq = useRef(0);

  const closeMentions = () => {
    setMentionOpen(false);
    setMentionQuery("");
    setMentionItems([]);
    setMentionActiveIndex(0);
    setMentionStartIndex(null);
  };

  const fetchMentionUsers = async (q: string) => {
    const trimmed = (q ?? "").trim().toLowerCase();
    const reqId = ++mentionReqSeq.current;

    if (trimmed.length < 3) {
      if (reqId !== mentionReqSeq.current) return;
      setMentionItems([]);
      setMentionOpen(false);
      return;
    }

    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase
        .from("profiles")
        .select("id, username, display_name, avatar_url, is_verified, donation_rank")
        .ilike("username", `${trimmed}%`)
        .order("username", { ascending: true })
        .limit(5);

      if (error) {
        if (reqId !== mentionReqSeq.current) return;
        setMentionItems([]);
        setMentionOpen(false);
        return;
      }

      let rows = (data ?? []) as MentionSuggestion[];
      rows = rows.filter((r) => !!r?.id && !!r?.username);

      let filtered = rows.filter((r) => {
        if (currentUserId && r.id === currentUserId) return false;
        if (blockedUserIds && blockedUserIds.has(r.id)) return false;
        return true;
      });

      // Also hide users who have blocked you.
      if (currentUserId && filtered.length > 0) {
        const ids = filtered.map((x) => x.id);
        const { data: reverseBlocks, error: rbErr } = await supabase
          .from("user_blocks")
          .select("blocker_user_id")
          .eq("blocked_user_id", currentUserId)
          .in("blocker_user_id", ids);

        if (!rbErr && reverseBlocks?.length) {
          type ReverseBlockRow = { blocker_user_id: string | null };
          const blockers = new Set<string>(
            (reverseBlocks as ReverseBlockRow[]).map((x) => String(x.blocker_user_id ?? ""))
          );
          filtered = filtered.filter((u) => !blockers.has(u.id));
        }
      }

      if (reqId !== mentionReqSeq.current) return;
      setMentionItems(filtered);
      setMentionActiveIndex(0);
      setMentionOpen(filtered.length > 0);
    } catch {
      if (reqId !== mentionReqSeq.current) return;
      setMentionItems([]);
      setMentionOpen(false);
    }
  };

  const replaceActiveMention = (username: string) => {
    const el = taRef.current;
    if (!el) return;

    const cursor = el.selectionStart ?? value.length;
    const start = mentionStartIndex ?? cursor;

    const before = value.slice(0, start);
    const after = value.slice(cursor);
    const insert = `@${username} `;
    const next = before + insert + after;
    onChange(next);

    requestAnimationFrame(() => {
      const pos = (before + insert).length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });

    closeMentions();
  };

  const applyWrap = (before: string, after: string, placeholder: string) => {
    const textarea = taRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const current = value || "";

    const selected = current.slice(start, end) || placeholder;
    const newValue =
      current.slice(0, start) + before + selected + after + current.slice(end);

    onChange(newValue);

    // restore selection after update (best-effort)
    setTimeout(() => {
      const pos = start + before.length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos + selected.length);
    }, 0);
  };

  const insertAtCursor = (text: string) => {
    const textarea = taRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart ?? 0;
    const end = textarea.selectionEnd ?? 0;
    const current = value || "";

    const newValue = current.slice(0, start) + text + current.slice(end);

    onChange(newValue);

    setTimeout(() => {
      const pos = start + text.length;
      textarea.focus();
      textarea.setSelectionRange(pos, pos);
    }, 0);
  };

  const handleCommand = (cmd: string) => {
    switch (cmd) {
      case "bold":
        applyWrap("**", "**", "bold text");
        break;
      case "italic":
        applyWrap("_", "_", "italic text");
        break;
      case "underline":
        // Markdown doesn't really have underline – this uses __ like bold.
        applyWrap("__", "__", "underlined text");
        break;
      case "highlight":
        // Common custom pattern; only renders if you support == in parsing.
        applyWrap("==", "==", "highlighted text");
        break;
      case "h1":
        insertAtCursor("\n# Heading 1\n");
        break;
      case "h2":
        insertAtCursor("\n## Heading 2\n");
        break;
      case "h3":
        insertAtCursor("\n### Heading 3\n");
        break;
      case "blockquote":
        insertAtCursor("\n> Quoted text\n");
        break;
      case "list":
        insertAtCursor("\n- Item 1\n- Item 2\n- Item 3\n");
        break;
      case "olist":
        insertAtCursor("\n1. First item\n2. Second item\n3. Third item\n");
        break;
      case "checklist":
        insertAtCursor("\n- [ ] Item 1\n- [ ] Item 2\n- [x] Done item\n");
        break;
      case "code":
        applyWrap("`", "`", "code");
        break;
      case "codeblock":
        insertAtCursor("\n```bash\n# code here\n```\n");
        break;
      case "link":
        insertAtCursor("[link text](https://example.com)");
        break;
      case "image":
        insertAtCursor("![alt text](https://example.com/image.png)");
        break;
      case "hr":
        insertAtCursor("\n---\n");
        break;
    }
  };

  return (
    <div className="space-y-2">
      {label && (
        <label
          htmlFor={id}
          className="block text-xs font-medium text-brand-textMuted"
        >
          {label}
        </label>
      )}
      {/* toolbar + mode toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Left: toolbar buttons */}
        <div className="flex flex-wrap gap-1">
          {/* basic formatting */}
          <ToolbarButton onClick={() => handleCommand("bold")} title="Bold">
            <span className="font-semibold">B</span>
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("italic")} title="Italic">
            <span className="italic">I</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleCommand("underline")}
            title="Underline (styled as bold)"
          >
            <span className="underline decoration-dotted">U</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleCommand("highlight")}
            title="Highlight"
          >
            <span className="rounded px-1 bg-amber-500/30 text-[10px]">
              HL
            </span>
          </ToolbarButton>

          {/* headings */}
          <ToolbarButton onClick={() => handleCommand("h1")} title="Heading 1">
            H1
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("h2")} title="Heading 2">
            H2
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("h3")} title="Heading 3">
            H3
          </ToolbarButton>

          {/* structure */}
          <ToolbarButton
            onClick={() => handleCommand("blockquote")}
            title="Blockquote"
          >
            ❝
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("list")} title="Bullet list">
            • List
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleCommand("olist")}
            title="Numbered list"
          >
            1.
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleCommand("checklist")}
            title="Checklist"
          >
            ☑
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("hr")} title="Divider">
            ─
          </ToolbarButton>

          {/* code / links / media */}
          <ToolbarButton onClick={() => handleCommand("code")} title="Inline code">
            {"</>"}
          </ToolbarButton>
          <ToolbarButton
            onClick={() => handleCommand("codeblock")}
            title="Code block"
          >
            {"{ }"}
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("link")} title="Link">
            🔗
          </ToolbarButton>
          <ToolbarButton onClick={() => handleCommand("image")} title="Image">
            🖼️
          </ToolbarButton>
        </div>

        {/* Right: mode toggle, styled like the rest of the UI */}
        <div className="flex items-center rounded-full border border-zinc-700 bg-black/40 p-0.5 text-[11px]">
          <ModeButton active={mode === "write"} onClick={() => setMode("write")}>
            Write
          </ModeButton>
          <ModeButton
            active={mode === "preview"}
            onClick={() => setMode("preview")}
          >
            Preview
          </ModeButton>
        </div>
      </div>
      {/* editor / preview area */}
      <div className="rounded-lg border border-zinc-700 bg-black/40">
        {mode === "write" ? (
          <div className="relative">
            <textarea
              id={id}
              ref={taRef}
              value={value}
              onChange={(e) => {
                const next = e.target.value;
                onChange(next);

                if (!enableMentions) return;

                const el = taRef.current;
                const cursor = el?.selectionStart ?? next.length;
                const before = next.slice(0, cursor);
                const at = before.lastIndexOf("@");
                if (at === -1) {
                  closeMentions();
                  return;
                }

                const prev = at === 0 ? "" : before[at - 1];
                const boundaryOk = at === 0 || !/[a-zA-Z0-9_\.]/.test(prev);
                if (!boundaryOk) {
                  closeMentions();
                  return;
                }

                const fragment = before.slice(at + 1);
                if (/\s/.test(fragment)) {
                  closeMentions();
                  return;
                }

                setMentionStartIndex(at);
                setMentionQuery(fragment);
                void fetchMentionUsers(fragment);
              }}
              onKeyDown={(e) => {
                if (enableMentions && mentionOpen) {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    closeMentions();
                    return;
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionActiveIndex((i) => Math.min(i + 1, mentionItems.length - 1));
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionActiveIndex((i) => Math.max(i - 1, 0));
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    const pick = mentionItems[mentionActiveIndex];
                    if (pick?.username) {
                      e.preventDefault();
                      replaceActiveMention(pick.username);
                      return;
                    }
                  }
                }

                onKeyDown?.(e);
              }}
              rows={rows}
              disabled={disabled}
              className={[
                "no-zoom-input w-full rounded-lg bg-transparent px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500",
                className ?? "",
              ].join(" ")}
              spellCheck={false}
              placeholder={placeholder}
            />

            {enableMentions && mentionOpen && mentionItems.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-[9999] mt-1 w-full overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950/95 shadow-xl backdrop-blur">
                <div className="max-h-56 overflow-auto p-1">
                  {mentionItems.map((u, idx) => {
                    const active = idx === mentionActiveIndex;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        onMouseDown={(ev) => {
                          ev.preventDefault();
                          ev.stopPropagation();
                          replaceActiveMention(u.username);
                        }}
                        onMouseEnter={() => setMentionActiveIndex(idx)}
                        className={[
                          "flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12px]",
                          active
                            ? "bg-amber-500/15 text-brand-text"
                            : "text-brand-textMuted hover:bg-white/5 hover:text-brand-text",
                        ].join(" ")}
                      >
                        <div className="h-7 w-7 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                          {u.avatar_url ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={u.avatar_url} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">@</div>
                          )}
                        </div>

                        <div className="min-w-0">
                          <div className="truncate font-medium text-brand-text">@{u.username}</div>
                          <div className="truncate text-[11px] text-brand-textMuted">{u.display_name ?? ""}</div>
                        </div>

                        <div className="ml-auto shrink-0 text-[10px] text-zinc-500">↵</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="max-h-[400px] overflow-auto px-3 py-2 text-sm text-brand-text">
            {value.trim() === "" ? (
              <p className="text-xs text-brand-textMuted">
                Nothing to preview yet.
              </p>
            ) : (
              <div className="space-y-2 [&_a]:text-brand-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic [&_code]:rounded [&_code]:bg-black/40 [&_code]:px-1 [&_code]:py-0.5">
                <ReactMarkdown>{value}</ReactMarkdown>
              </div>
            )}
          </div>
        )}
      </div>
      {helperText && (
        <p className="text-[11px] text-brand-textMuted">{helperText}</p>
      )}
    </div>
  );
}

type ButtonProps = {
  children: React.ReactNode;
  onClick: () => void;
  title?: string;
};

function ToolbarButton({ children, onClick, title }: ButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-md border border-zinc-700 bg-black/40 px-2 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
    >
      {children}
    </button>
  );
}

function ModeButton({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full px-3 py-0.5 text-[11px] transition " +
        (active
          ? "bg-amber-500/20 text-amber-300 border border-amber-400 shadow-sm shadow-black/40"
          : "text-brand-textMuted hover:text-brand-text")
      }
    >
      {children}
    </button>
  );
}
