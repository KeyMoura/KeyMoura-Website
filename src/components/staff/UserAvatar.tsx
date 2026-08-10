"use client";

import { useState } from "react";

/**
 * A user's avatar, with a letter when there is no image.
 *
 * ## Why this is not `next/image`
 *
 * Avatar URLs come from two unrelated places: Supabase storage, and whatever
 * host an OAuth provider returns — `lh3.googleusercontent.com` for Google,
 * `platform-lookaside.fbsbx.com` for Facebook. `next/image` refuses any host not
 * listed in `next.config`, and the failure is a **blank space**, not a fallback.
 * A directory where a third of the avatars are missing is worse than one where
 * none are optimized, so this renders a plain `<img>` and handles the error.
 *
 * ## Why the fallback is stateful
 *
 * `onError` is the only signal that a stored URL has gone stale — a provider
 * rotating a CDN path, or an avatar deleted from storage while the profile row
 * still names it. Without swapping to the initial on error, those render as a
 * broken-image glyph, which reads as a bug in the page rather than as a missing
 * picture.
 */
export function UserAvatar({
  src,
  label,
  size = 32,
  className,
}: {
  src: string | null | undefined;
  /** The display name. Its first letter is the fallback. */
  label: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (label.trim()[0] ?? "U").toUpperCase();
  const showImage = Boolean(src) && !failed;

  const shared = {
    width: size,
    height: size,
    borderRadius: "50%",
    flexShrink: 0,
  } as const;

  if (showImage) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- see the note above
      <img
        src={src as string}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className={className}
        style={{ ...shared, objectFit: "cover", border: "1px solid var(--border)" }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        ...shared,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--panel-strong)",
        border: "1px solid var(--border)",
        color: "var(--muted)",
        fontSize: Math.max(11, Math.round(size * 0.4)),
        fontWeight: 600,
        lineHeight: 1,
      }}
    >
      {initial}
    </span>
  );
}
