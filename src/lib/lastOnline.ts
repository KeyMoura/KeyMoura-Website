const ONLINE_WINDOW_MS = 5 * 60 * 1000;

/** Formats a dedicated activity timestamp for compact profile surfaces. */
export function formatLastOnline(value: string | null | undefined, now = new Date()): string | null {
  if (!value) return null;

  const activity = new Date(value);
  const activityMs = activity.getTime();
  if (!Number.isFinite(activityMs)) return null;

  const elapsedMs = Math.max(0, now.getTime() - activityMs);
  if (elapsedMs <= ONLINE_WINDOW_MS) return "Online now";

  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `Last online ${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    activity.getFullYear() === yesterday.getFullYear() &&
    activity.getMonth() === yesterday.getMonth() &&
    activity.getDate() === yesterday.getDate()
  ) {
    return "Last online yesterday";
  }

  const hours = Math.floor(elapsedMs / 3_600_000);
  if (hours < 24) return `Last online ${hours} hour${hours === 1 ? "" : "s"} ago`;

  return `Last online ${activity.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: activity.getFullYear() === now.getFullYear() ? undefined : "numeric",
  })}`;
}
