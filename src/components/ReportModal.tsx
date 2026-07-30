"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

import { MarkdownEditor } from "@/components/MarkdownEditor";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { supabaseBrowser } from "@/lib/supabaseClient";

export type ReportTargetType = "user" | "forum_post" | "forum_thread" | "dm_thread";

type Props = {
  open: boolean;
  title: string;
  description?: string;
  targetType: ReportTargetType;
  targetId: string;
  onClose: () => void;
};

export default function ReportModal({
  open,
  title,
  description,
  targetType,
  targetId,
  onClose,
}: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("other");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const canSubmit = useMemo(
    () => reason.trim().length > 0 && message.trim().length > 0 && !busy,
    [reason, message, busy]
  );

  if (!open || !mounted) return null;

  const modal = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center px-4" aria-modal="true" role="dialog">
      {/* dim background + outside click closes */}
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/70" />

      <div
        className="relative w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-brand-text"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-brand-textMuted">
              {description ?? "This creates a private conversation with staff."}
            </p>
          </div>
        </div>

        {feedback ? <p className="mt-3 text-sm text-rose-300">{feedback}</p> : null}

        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-brand-textMuted">Category</span>
            <MenuSelect
              ariaLabel="Category"
              value={category as string}
              onChange={(next) => setCategory(next)}
              className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-black px-3 text-sm text-brand-text outline-none transition hover:border-zinc-500"
              options={[
                { value: "spam", label: "Spam" },
                { value: "harassment", label: "Harassment" },
                { value: "hate", label: "Hate" },
                { value: "nudity", label: "Nudity / sexual content" },
                { value: "violence", label: "Violence / threats" },
                { value: "copyright", label: "Copyright" },
                { value: "impersonation", label: "Impersonation" },
                { value: "privacy", label: "Privacy / doxxing" },
                { value: "other", label: "Other" },
              ]}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-brand-textMuted">Reason</span>
            <input
              className="no-zoom-input rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm text-brand-text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Harassment, spam, impersonation…"
              maxLength={120}
            />
          </label>

          <div>
            <span className="text-xs text-brand-textMuted">Details</span>
            <div className="mt-1">
              <MarkdownEditor
                value={message}
                onChange={(v) => setMessage(v)}
                rows={8}
                className="no-zoom-input"
                placeholder="Explain what happened. Links and screenshots are ok."
              />
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-brand-textMuted hover:border-zinc-500"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={async () => {
              setBusy(true);
              setFeedback(null);

              try {
                const supabase = supabaseBrowser();
                const {
                  data: { session },
                } = await supabase.auth.getSession();

                const token = session?.access_token;
                if (!token) {
                  setFeedback("You must be logged in.");
                  return;
                }

                const res = await fetch("/api/reports/create", {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({
                    target_type: targetType,
                    target_id: targetId,
                    category,
                    reason,
                    message,
                  }),
                });

                const j = (await res.json().catch(() => null)) as
                  | { error?: string; report_id?: string }
                  | null;

                if (!res.ok || !j?.report_id) {
                  setFeedback(j?.error ?? "Failed to submit report.");
                  return;
                }

                onClose();
                router.push(`/reports/${j.report_id}`);
              } catch (e: unknown) {
                console.error("Report submit failed", e);
                setFeedback("Unexpected error submitting report.");
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg border border-rose-400/70 bg-rose-500/20 px-3 py-2 text-xs font-medium text-rose-100 hover:bg-rose-500/25 disabled:opacity-50"
          >
            {busy ? "Submitting…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );

  // Render in a portal so it never gets clipped by transformed/overflow containers (mobile thread view).
  return createPortal(modal, document.body);
}
