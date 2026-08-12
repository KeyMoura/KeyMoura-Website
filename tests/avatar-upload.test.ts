import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AVATAR_BUCKET,
  AVATAR_MAX_BYTES,
  AVATAR_MIME_TYPES,
  avatarObjectKey,
  avatarObjectKeysFor,
  avatarRejectionReason,
  isAllowedAvatarType,
  versionedAvatarUrl,
} from "../src/lib/avatars.ts";

/**
 * Avatar upload had never worked — not "worked and regressed", never.
 *
 * Proven against production before anything was changed: the `avatars` bucket
 * holds **zero objects**, and the only non-null `profiles.avatar_url` in the
 * database is a Google OAuth URL that never passed through storage.
 *
 * The cause is one missing slash. The bucket's insert policy is
 *
 *     bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
 *
 * and the uploader wrote a flat key, `` `${user.id}.jpg` ``. Postgres was asked
 * live and answered plainly:
 *
 *     storage.foldername('<uuid>.jpg')            -> {}      (empty array)
 *     (storage.foldername('<uuid>.jpg'))[1]       -> NULL
 *     NULL = '<uuid>'                             -> NULL
 *     (storage.foldername('<uuid>/avatar.jpg'))[1] = '<uuid>' -> TRUE
 *
 * RLS admits a row only on `TRUE`. `NULL` is a refusal, so the policy could
 * never pass for any user — which is exactly the behaviour reported, and
 * exactly what an empty bucket looks like.
 *
 * These tests pin the shape of the key, because the shape *is* the fix.
 */

const read = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), "utf8");

const UID = "7c9e1b2a-1111-4222-8333-444455556666";

test("the object key's first segment is the user id, which is the whole policy check", () => {
  const key = avatarObjectKey(UID, "image/jpeg");
  assert.equal(key, `${UID}/avatar.jpg`);

  const [first, ...rest] = key.split("/");
  assert.equal(first, UID, "the first path segment is what the policy compares to auth.uid()");
  assert.ok(rest.length >= 1, "a flat key has no first folder at all — that was the bug");
});

test("the old flat key could not satisfy the policy, and the new one does", () => {
  // `storage.foldername` splits on "/" and drops the final segment.
  const foldername = (name: string) => name.split("/").slice(0, -1);

  const oldKey = `${UID}.jpg`;
  assert.deepEqual(foldername(oldKey), [], "no folders, so [1] is NULL in Postgres");
  assert.equal(foldername(oldKey)[0], undefined, "the comparison had nothing on the left");

  const newKey = avatarObjectKey(UID, "image/jpeg");
  assert.equal(foldername(newKey)[0], UID, "the comparison is now uid = uid");
});

test("each accepted type has exactly one key, and they are all distinct", () => {
  const keys = avatarObjectKeysFor(UID);
  assert.equal(keys.length, AVATAR_MIME_TYPES.length);
  assert.equal(new Set(keys).size, keys.length, "one key per format");
  for (const key of keys) assert.ok(key.startsWith(`${UID}/`), "every key stays inside the user's prefix");
});

test("the key is stable, so a replacement overwrites instead of orphaning", () => {
  // A timestamped key would need a DELETE policy to clean up after itself, and
  // the bucket has none — the orphans would simply accumulate forever.
  assert.equal(avatarObjectKey(UID, "image/png"), avatarObjectKey(UID, "image/png"));
  // Check the filename, not the whole key — a UUID is full of digits and an
  // earlier version of this assertion matched the user id instead.
  const filename = avatarObjectKey(UID, "image/png").split("/").pop() ?? "";
  assert.equal(filename, "avatar.png");
  assert.doesNotMatch(filename, /\d{10,}/, "no timestamp in the key");
});

test("a user id that is not a UUID cannot choose its own folder", () => {
  // The staff route takes this from a URL parameter. A value containing a slash
  // or a traversal would place the object outside the prefix the policy governs.
  for (const bogus of ["../../etc", `${UID}/../other`, "not-a-uuid", "", "a/b"]) {
    assert.throws(() => avatarObjectKey(bogus, "image/jpeg"), /user id/i, `${bogus} must be refused`);
  }
});

test("only image types the bucket accepts are allowed", () => {
  for (const type of AVATAR_MIME_TYPES) assert.ok(isAllowedAvatarType(type));
  for (const type of ["image/svg+xml", "text/html", "application/octet-stream", "image/gif", "", null]) {
    assert.ok(!isAllowedAvatarType(type), `${String(type)} must be refused`);
  }
  // SVG in particular: it is an image to a user and a script host to a browser,
  // and this bucket is public.
  assert.ok(!isAllowedAvatarType("image/svg+xml"));
  assert.throws(() => avatarObjectKey(UID, "image/svg+xml"), /Unsupported/);
});

test("size and type are refused with a sentence, before any upload is attempted", () => {
  assert.equal(avatarRejectionReason({ type: "image/jpeg", size: 1024 }), null);
  assert.match(avatarRejectionReason({ type: "image/gif", size: 10 }) ?? "", /JPEG, PNG, or WebP/);
  assert.match(avatarRejectionReason({ type: "image/png", size: AVATAR_MAX_BYTES + 1 }) ?? "", /too large/);
  assert.equal(avatarRejectionReason({ type: "image/png", size: AVATAR_MAX_BYTES }), null, "the limit itself is allowed");
});

test("a stable key still produces a changing URL", () => {
  const base = "https://example.supabase.co/storage/v1/object/public/avatars/x/avatar.jpg";
  assert.equal(versionedAvatarUrl(base, 5), `${base}?v=5`);
  assert.equal(versionedAvatarUrl(`${base}?a=1`, 5), `${base}?a=1&v=5`, "an existing query is preserved");
  assert.notEqual(versionedAvatarUrl(base, 1), versionedAvatarUrl(base, 2));
});

test("both upload surfaces use the shared key builder rather than their own", () => {
  const account = read("src/app/account/profile/page.tsx");
  const staff = read("src/app/api/staff/security/users/[id]/avatar/route.ts");

  for (const [name, source] of [["account", account], ["staff", staff]] as const) {
    assert.match(source, /avatarObjectKey\(/, `${name} must build its key from the shared module`);
    assert.match(source, /avatarRejectionReason\(/, `${name} must apply the shared validation`);
    // The two defects, stated as regressions.
    assert.doesNotMatch(source, /\$\{user\.id\}\.jpg|\$\{id\}\.jpg/, `${name} must not use a flat key`);
    assert.doesNotMatch(source, /["'`]avatars\/\$\{/, `${name} must not repeat the bucket name inside the key`);
  }

  assert.equal(AVATAR_BUCKET, "avatars");
  // The version lives in `versionedAvatarUrl`, which is where `Date.now()` now
  // is — the point is that the *key* carries no timestamp and the *URL* does.
  for (const [name, source] of [["account", account], ["staff", staff]] as const) {
    assert.match(source, /versionedAvatarUrl\(/, `${name} must version the stored URL`);
    assert.doesNotMatch(source, /\$\{Date\.now\(\)\}\.\$\{ext\}/, `${name} key must not be timestamped`);
  }
});

test("the staff route validates and does not echo the provider's message", () => {
  const staff = read("src/app/api/staff/security/users/[id]/avatar/route.ts");
  assert.doesNotMatch(staff, /error: upload\.error\.message/, "provider text can quote the bucket configuration");
  assert.match(staff, /Could not store that image\./);
  assert.match(staff, /requirePermission\(req, "users\.profile\.edit"\)/, "still permission-gated");
});
