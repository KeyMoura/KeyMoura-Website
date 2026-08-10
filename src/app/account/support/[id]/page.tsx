"use client";

import { FormEvent, use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  MAX_SUPPORT_MESSAGE_LENGTH,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_STATUS_CUSTOMER_LABELS,
  formatSupportAge,
  type SupportCategory,
  type SupportStatus,
} from "@/lib/support/domain";

/**
 * One of the customer's own conversations, and the reply box.
 *
 * Every message rendered here came back from an endpoint that filtered on
 * `visibility = 'customer'` in Postgres. There is no client-side "is this
 * internal?" check, because there is nothing internal in the payload to check —
 * a staff note is never loaded, never serialized, and cannot be revealed by a
 * rendering bug.
 *
 * Bodies are rendered as **text**, into a `<p>` with `whitespace-pre-wrap`.
 * Never `dangerouslySetInnerHTML`, and no markdown renderer: this is the one
 * surface where a staff member's words and a customer's words appear on the same
 * page, and neither should be able to introduce markup into the other's view.
 */

type Message = {
  id: string;
  authorType: "customer" | "staff" | "system";
  authorLabel: string;
  body: string;
  createdAt: string;
};

type Conversation = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  createdAt: string;
  lastMessageAt: string;
  relatedOrder: { id: string; orderNumber: string | null } | null;
  canReply: boolean;
};

function newToken(): string {
  return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function CustomerConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [state, setState] = useState<"loading" | "ready" | "missing" | "error" | "signed-out">("loading");
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState(newToken);

  const authHeader = useCallback(async () => {
    const { data } = await supabaseBrowser().auth.getSession();
    const accessToken = data.session?.access_token;
    return accessToken ? { Authorization: `Bearer ${accessToken}` } : null;
  }, []);

  const load = useCallback(async () => {
    const headers = await authHeader();
    if (!headers) {
      setState("signed-out");
      return;
    }
    try {
      const response = await fetch(`/api/support/conversations/${id}`, { headers });
      // 404 covers both "no such conversation" and "not yours", deliberately —
      // the API refuses to tell the two apart, and neither should this page.
      if (response.status === 404) {
        setState("missing");
        return;
      }
      if (!response.ok) throw new Error("failed");
      const body = (await response.json()) as { conversation: Conversation; messages: Message[] };
      setConversation(body.conversation);
      setMessages(body.messages ?? []);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [authHeader, id]);

  useEffect(() => {
    void load();
  }, [load]);

  const reply = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setSending(true);
      setError("");
      const form = event.currentTarget;
      const value = String(new FormData(form).get("body") ?? "");
      try {
        const headers = await authHeader();
        if (!headers) throw new Error("Sign in again to reply.");
        const response = await fetch(`/api/support/conversations/${id}/messages`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ body: value, clientToken: token }),
        });
        const body = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(body.error || "Could not send your reply.");
        form.reset();
        setToken(newToken());
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "Could not send your reply.");
      } finally {
        setSending(false);
      }
    },
    [authHeader, id, load, token]
  );

  if (state === "loading") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p role="status" className="text-brand-textMuted">
          Loading…
        </p>
      </main>
    );
  }

  if (state === "signed-out" || state === "missing") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <h1 className="text-2xl font-semibold">
          {state === "signed-out" ? "Sign in to see this request" : "We could not find that request"}
        </h1>
        <p className="mt-3 text-brand-textMuted">
          {state === "signed-out"
            ? "Support requests live on the account that opened them."
            : "It may have been opened on a different account, or with no account at all."}
        </p>
        <Link href="/account/support" className="ui-btn ui-btn-primary mt-6 inline-flex">
          My support requests
        </Link>
      </main>
    );
  }

  if (state === "error" || !conversation) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div role="alert" className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-6">
          <p>We could not load this conversation just now.</p>
          <button type="button" onClick={() => void load()} className="ui-btn ui-btn-secondary mt-4">
            Try again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:py-16">
      <Link href="/account/support" className="text-sm text-brand-textMuted hover:text-brand-primary">
        ← All requests
      </Link>

      <header className="mt-4">
        <p className="font-mono text-sm text-brand-primary">{conversation.reference}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{conversation.subject}</h1>
        <p className="mt-2 text-sm text-brand-textMuted">
          {SUPPORT_CATEGORY_LABELS[conversation.category]} ·{" "}
          {SUPPORT_STATUS_CUSTOMER_LABELS[conversation.status]} · opened{" "}
          {formatSupportAge(conversation.createdAt)}
        </p>
        {conversation.relatedOrder ? (
          <Link
            href={`/orders/${conversation.relatedOrder.id}`}
            className="mt-3 inline-flex text-sm font-semibold text-brand-primary hover:underline"
          >
            {conversation.relatedOrder.orderNumber ?? "Related order"} →
          </Link>
        ) : null}
      </header>

      <ol className="mt-8 space-y-4">
        {messages.map((message) => {
          const mine = message.authorType === "customer";
          return (
            <li
              key={message.id}
              className={`rounded-2xl border p-4 ${
                message.authorType === "system"
                  ? "border-zinc-800 bg-black/20 text-brand-textMuted"
                  : mine
                    ? "border-zinc-800 bg-black/20"
                    : "border-brand-primary/30 bg-brand-primary/5"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-semibold">{mine ? "You" : message.authorLabel}</span>
                <span className="text-xs text-brand-textMuted">{formatSupportAge(message.createdAt)}</span>
              </div>
              {/* Text, always. See the file header. */}
              <p className="mt-2 whitespace-pre-wrap leading-7">{message.body}</p>
            </li>
          );
        })}
      </ol>

      {conversation.canReply ? (
        <form onSubmit={reply} className="mt-8 rounded-2xl border border-zinc-800 bg-black/30 p-5">
          <label className="block text-sm">
            Reply
            <textarea
              name="body"
              required
              maxLength={MAX_SUPPORT_MESSAGE_LENGTH}
              className="mt-1 min-h-32 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none focus:border-brand-primary"
              placeholder="Add anything that would help."
            />
          </label>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-rose-200">
              {error}
            </p>
          ) : null}
          <button disabled={sending} className="ui-btn ui-btn-primary mt-4 disabled:opacity-60">
            {sending ? "Sending…" : "Send reply"}
          </button>
        </form>
      ) : (
        <p className="mt-8 rounded-2xl border border-zinc-800 bg-black/20 p-5 text-brand-textMuted">
          This request is closed.{" "}
          <Link href="/support" className="text-brand-primary hover:underline">
            Start a new one
          </Link>{" "}
          if something else comes up.
        </p>
      )}
    </main>
  );
}
