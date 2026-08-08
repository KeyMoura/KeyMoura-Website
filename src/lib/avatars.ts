/**
 * Where an avatar is stored, and what may be stored as one.
 *
 * ## The defect this repairs
 *
 * `/account` uploaded to `` `${user.id}.jpg` `` — a key with **no folder**. The
 * bucket's insert policy is:
 *
 *     bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
 *
 * `storage.foldername('<uuid>.jpg')` returns an empty array, so `[1]` is `NULL`,
 * and `NULL = '<uuid>'` is `NULL` — which is not `TRUE`. A row-level security
 * policy admits a row only when its check is `TRUE`, so the upload was refused
 * for every user, every time, since the bucket was created. Production bears
 * this out exactly: the `avatars` bucket holds **zero objects**, and the only
 * non-null `profiles.avatar_url` in the database is a Google OAuth URL that
 * never passed through storage at all.
 *
 * The path did not merely need a folder; it needed the folder to *be* the
 * uploader's user id, because that is the only thing the policy compares. That
 * also gives the property the policy is there to provide: a signed-in user can
 * write inside their own prefix and nowhere else.
 *
 * ## One object per user, forever
 *
 * The key is stable rather than timestamped. A timestamped key would leave a new
 * object behind on every change, and cleaning those up needs a `DELETE` policy
 * the bucket does not have — so the orphans would simply accumulate. Overwriting
 * one key means replacement needs no delete permission at all, which is why this
 * repair requires no storage policy change.
 *
 * The cost is caching: the URL no longer changes when the image does. Callers
 * append a version query to the value they store in `profiles.avatar_url`, which
 * changes the URL a browser caches under without changing the object.
 */

/** What the `avatars` bucket accepts, mirrored from its own configuration. */
export const AVATAR_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** The bucket's own limit is 5 MB and rejects anything larger server-side. */
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

export const AVATAR_BUCKET = "avatars";

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function isAllowedAvatarType(contentType: unknown): contentType is (typeof AVATAR_MIME_TYPES)[number] {
  return typeof contentType === "string" && (AVATAR_MIME_TYPES as readonly string[]).includes(contentType);
}

/**
 * The storage key for a user's avatar.
 *
 * The first segment **must** be the user id — that is the whole of the policy
 * check. The id is validated as a UUID rather than interpolated blind: it
 * reaches this function from a route parameter on the staff path, and a value
 * containing `/` or `..` would otherwise choose its own folder and place the
 * object outside the prefix the policy is meant to confine it to.
 */
export function avatarObjectKey(userId: string, contentType: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("An avatar key needs a user id.");
  }
  const extension = EXTENSIONS[contentType];
  if (!extension) throw new Error("Unsupported avatar type.");
  return `${userId}/avatar.${extension}`;
}

/** Every key this user's avatar could occupy — used to clear a stale format. */
export function avatarObjectKeysFor(userId: string): string[] {
  return AVATAR_MIME_TYPES.map((type) => avatarObjectKey(userId, type));
}

/**
 * A stored `avatar_url` with a cache-busting version.
 *
 * The object key is stable, so without this the browser and the CDN keep serving
 * the previous image under `Cache-Control: max-age`. The version is applied to
 * the value written to `profiles.avatar_url`, so what changes is the URL rows
 * point at rather than anything about the object.
 */
export function versionedAvatarUrl(publicUrl: string, at: number = Date.now()): string {
  const separator = publicUrl.includes("?") ? "&" : "?";
  return `${publicUrl}${separator}v=${at}`;
}

/** The human sentence for a refused file. `null` when the file is acceptable. */
export function avatarRejectionReason(file: { type: string; size: number }): string | null {
  if (!isAllowedAvatarType(file.type)) return "Please upload a JPEG, PNG, or WebP image.";
  if (file.size > AVATAR_MAX_BYTES) return "Image is too large. Please use something under 5 MB.";
  return null;
}
