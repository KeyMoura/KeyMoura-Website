# Public profile compatibility boundary

## Classification

`public.public_profiles` is the only anonymous/community profile relation. Its
reviewed columns are `id` (stable profile link), `username`, `display_name`,
`avatar_url`, `karma`, `is_verified`, and `donation_rank`. The last three are
already rendered as public reputation/badges; they are not authorization data.

Everything else remains private on `public.profiles`, including email (which is
not a profile column), bio, location, timestamps/activity, IP and user-agent,
internal status, `role`, staff notes, permission overrides, and provider/auth
metadata. Adding a column to `profiles` never adds it to the projection.

## Read audit and replacements

The direct community reads were the community category and thread pages, garage
index/detail, workshop comments, and project author/contributor cards. The forum
category-thread, community-feed, and thread-meta server routes performed the
same public identity enrichment with service-role access. All now query
`public_profiles` with explicit column lists.

Account settings and account mutation routes intentionally continue to use the
base table for the signed-in customer's own full record. Staff pages and staff
APIs intentionally continue to use the base table behind staff authorization.
Messaging, notifications, and report workflows are authenticated/private
collaboration surfaces rather than public profile pages and retain their
existing authorization-specific reads.

Public role presentation is served by `/api/public/roles`, which returns only
the badge schema selected by `ROLE_PUBLIC_SELECT`; permission definitions are
not returned. Staff authorization continues to resolve roles and permissions on
trusted server paths.

## Deployment and rollback

Do not apply either migration as part of this compatibility pass. When staged,
apply `20260811025000_public_profile_projection.sql` first, deploy the compatible
application, and only then apply
`20260811030000_security_boundary_hardening.sql`. Each migration contains its
rollback SQL. Reversing the hardening is an emergency measure; dropping the
projection requires first rolling back all application consumers.
