# Mini-profile activity

Mini-profiles read the existing `profiles.bio` value as plain React text and the dedicated
`profiles.last_seen_at` activity value. A null timestamp is intentionally shown as no status.
Neither `profiles.updated_at` nor `auth.users.last_sign_in_at` is used.

Migration `20260729010000_secure_profile_activity_tracking.sql` adds the nullable timestamp,
its partial index, and the authenticated `touch_last_seen()` RPC. The `SECURITY DEFINER` RPC
derives the row exclusively from `auth.uid()`, is unavailable to anonymous callers, and also
enforces a five-minute database throttle. No service-role credential or auth schema data is
sent to the browser.

`LastSeenUpdater` calls the RPC when an authenticated page session starts and when a visible
page regains focus, with a five-minute `localStorage` throttle shared between browser tabs and
a five-minute active-session interval. The database guard remains authoritative if client
storage is cleared or RPC calls are made directly.
