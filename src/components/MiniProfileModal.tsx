"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSquarePollHorizontal } from "@fortawesome/free-solid-svg-icons";
import { faCircleXmark, faPaperPlane } from "@fortawesome/free-regular-svg-icons";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { formatLastOnline } from "@/lib/lastOnline";

export type MiniProfileUser = {
  id: string;
  username: string | null;
  displayName: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean | null;
  donationRank?: string | null;
  karma?: number | null;
  role?: string | null;
  bio?: string | null;
  lastSeenAt?: string | null;
};

type Props = {
  open: boolean;
  user: MiniProfileUser | null;
  onClose: () => void;
  /** Optional: render a Block action and wire it to your site blocking logic */
  isBlocked?: boolean;
  onToggleBlockUser?: (targetUserId: string, shouldBlock: boolean) => void | Promise<void>;
  /** Optional: open your existing report flow for user profiles */
  onReportUser?: (targetUserId: string) => void;
};

function useEscapeToClose(open: boolean, onClose: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
}

export default function MiniProfileModal({ open, user, onClose, isBlocked, onToggleBlockUser, onReportUser }: Props) {
  const [mounted, setMounted] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const menuBtnRef = React.useRef<HTMLButtonElement | null>(null);
  const menuRef = React.useRef<HTMLDivElement | null>(null);
  const router = useRouter();
  useEscapeToClose(open, onClose);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    setMenuOpen(false);
  }, [open]);

  React.useEffect(() => {
    if (!open || !menuOpen) return;

    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (menuRef.current && menuRef.current.contains(t)) return;
      if (menuBtnRef.current && menuBtnRef.current.contains(t)) return;
      setMenuOpen(false);
    };

    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [open, menuOpen]);

  if (!mounted || !open) return null;

  const username = user?.username ? String(user.username) : null;
  const profileHref = username ? `/user/@${encodeURIComponent(username)}` : user ? `/user/${user.id}` : "#";
  const bio = user?.bio?.trim() || null;
  const lastOnline = formatLastOnline(user?.lastSeenAt);

  const handleMessage = async () => {
    if (!user?.id) return;
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("dm_get_or_create_thread", {
        p_other_user_id: user.id,
      });

      if (error) {
        console.error("dm_get_or_create_thread failed", error);
        router.push("/messages");
        onClose();
        return;
      }

      const threadId = typeof data === "string" ? data : null;
      if (!threadId) {
        router.push("/messages");
        onClose();
        return;
      }

      router.push(`/messages/${encodeURIComponent(threadId)}`);
      onClose();
    } catch (e) {
      console.error("dm start unexpected", e);
      router.push("/messages");
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center" aria-modal="true" role="dialog">
      {/* dim background + outside click to close */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />

      <div className="relative z-[10000] w-[92vw] max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl">
        {/* top-right close */}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute right-3 top-3 inline-flex h-9 w-9 items-center justify-center rounded-full text-zinc-400 hover:text-white"
        >
          <FontAwesomeIcon icon={faCircleXmark} className="h-5 w-5" />
        </button>
        {!user ? (
          <div className="text-sm text-brand-textMuted">Loading…</div>
        ) : (
          <div className="flex gap-4">
            <Link
              href={profileHref}
              onClick={onClose}
              className="h-14 w-14 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900 cursor-pointer"
              aria-label={username ? `View @${username}` : "View profile"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-zinc-400">@</div>
              )}
            </Link>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <Link
                  href={profileHref}
                  onClick={onClose}
                  className="min-w-0 truncate text-base font-semibold text-brand-text no-underline hover:no-underline"
                >
                  {user.displayName || username || "User"}
                </Link>
                {user.isVerified ? <VerifiedBadge /> : null}
                <DonationBadge rank={user.donationRank ?? null} />
                {user.role ? <RolePill role={user.role} /> : null}
              </div>

              <div className="mt-0.5 flex items-center gap-2 text-sm text-brand-textMuted">
                {username ? (
                  <Link
                    href={profileHref}
                    onClick={onClose}
                    className="truncate cursor-pointer no-underline hover:no-underline"
                  >
                    @{username}
                  </Link>
                ) : null}
              </div>

              {typeof user.karma === "number" ? (
                <div className="mt-3 text-xs text-brand-textMuted">
                  Karma • <span className="text-brand-text">{user.karma}</span>
                </div>
              ) : null}

              {bio ? (
                <p className="mt-3 line-clamp-3 whitespace-pre-line break-words text-sm leading-5 text-brand-textMuted">
                  {bio}
                </p>
              ) : null}

              {lastOnline ? (
                <div className="mt-2 truncate text-xs text-brand-textMuted" title={lastOnline}>
                  {lastOnline}
                </div>
              ) : null}

              <div className="mt-4 flex items-center justify-end gap-4 md:gap-3">
                <button
                  type="button"
                  aria-label="Message"
                  onClick={() => void handleMessage()}
                  className="inline-flex items-center justify-center rounded-md p-3 md:p-2 text-zinc-300 hover:text-white cursor-pointer"
                >
                  <FontAwesomeIcon icon={faPaperPlane} className="h-5 w-5" />
                </button>

                {(typeof onToggleBlockUser === "function" || typeof onReportUser === "function") && (
                  <div className="relative" ref={menuRef}>
                    <button
                      ref={menuBtnRef}
                      type="button"
                      aria-label="More actions"
                      onClick={() => setMenuOpen((v) => !v)}
                      className="inline-flex items-center justify-center rounded-md p-3 md:p-2 text-zinc-300 hover:text-white cursor-pointer"
                    >
                      <FontAwesomeIcon icon={faSquarePollHorizontal} className="h-5 w-5" />
                    </button>

                    {menuOpen ? (
                      <div className="absolute right-0 top-10 z-[10001] w-44 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-lg">
                        <div className="flex flex-col py-1 text-sm">
                          {typeof onToggleBlockUser === "function" && user?.id ? (
                            <button
                              type="button"
                              onClick={() => {
                                void onToggleBlockUser(user.id, !(isBlocked ?? false));
                                setMenuOpen(false);
                              }}
                              className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                            >
                              {(isBlocked ?? false) ? "Unblock" : "Block"}
                            </button>
                          ) : null}

                          {typeof onReportUser === "function" && user?.id ? (
                            <button
                              type="button"
                              onClick={() => {
                                onReportUser(user.id);
                                setMenuOpen(false);
                              }}
                              className="w-full px-3 py-2 text-left text-zinc-100 hover:bg-zinc-900"
                            >
                              Report
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                <Link
                  href={profileHref}
                  onClick={onClose}
                  className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-4 py-2 text-sm font-medium text-brand-text hover:bg-zinc-900"
                >
                  View profile
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
