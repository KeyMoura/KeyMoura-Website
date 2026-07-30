# Application inventory

Generated from the baseline on 2026-07-29. Dynamic queries and SQL hidden behind helpers may require additional database inspection.

## Pages

| URL | Source |
|---|---|
| `/account` | `src/app/account/page.tsx` |
| `/auth/exchange` | `src/app/auth/exchange/page.tsx` |
| `/auth/login` | `src/app/auth/login/page.tsx` |
| `/auth/logout` | `src/app/auth/logout/page.tsx` |
| `/banned` | `src/app/banned/page.tsx` |
| `/community/[slug]/[threadSlug]` | `src/app/community/[slug]/[threadSlug]/page.tsx` |
| `/community/[slug]/new` | `src/app/community/[slug]/new/page.tsx` |
| `/community/[slug]` | `src/app/community/[slug]/page.tsx` |
| `/community` | `src/app/community/page.tsx` |
| `/dev/menuselect` | `src/app/dev/menuselect/page.tsx` |
| `/garage/[id]/edit` | `src/app/garage/[id]/edit/page.tsx` |
| `/garage/[id]` | `src/app/garage/[id]/page.tsx` |
| `/garage/mine` | `src/app/garage/mine/page.tsx` |
| `/garage/new` | `src/app/garage/new/page.tsx` |
| `/garage` | `src/app/garage/page.tsx` |
| `/info/[slug]` | `src/app/info/[slug]/page.tsx` |
| `/info/[slug]/update` | `src/app/info/[slug]/update/page.tsx` |
| `/info/category/[slug]` | `src/app/info/category/[slug]/page.tsx` |
| `/info/mine` | `src/app/info/mine/page.tsx` |
| `/info` | `src/app/info/page.tsx` |
| `/info/submit` | `src/app/info/submit/page.tsx` |
| `/messages/[threadId]` | `src/app/messages/[threadId]/page.tsx` |
| `/messages` | `src/app/messages/page.tsx` |
| `/notifications` | `src/app/notifications/page.tsx` |
| `/` | `src/app/page.tsx` |
| `/privacy` | `src/app/privacy/page.tsx` |
| `/reports/[id]` | `src/app/reports/[id]/page.tsx` |
| `/shops/[slug]` | `src/app/shops/[slug]/page.tsx` |
| `/shops` | `src/app/shops/page.tsx` |
| `/staff/community` | `src/app/staff/community/page.tsx` |
| `/staff/info/analytics` | `src/app/staff/info/analytics/page.tsx` |
| `/staff/info/pending/[id]` | `src/app/staff/info/pending/[id]/page.tsx` |
| `/staff/info/pending` | `src/app/staff/info/pending/page.tsx` |
| `/staff/info/todo` | `src/app/staff/info/todo/page.tsx` |
| `/staff/info/updates/[id]` | `src/app/staff/info/updates/[id]/page.tsx` |
| `/staff/info/updates` | `src/app/staff/info/updates/page.tsx` |
| `/staff/info/users` | `src/app/staff/info/users/page.tsx` |
| `/staff/moderation` | `src/app/staff/moderation/page.tsx` |
| `/staff/moderation/reports` | `src/app/staff/moderation/reports/page.tsx` |
| `/staff` | `src/app/staff/page.tsx` |
| `/staff/security/audit` | `src/app/staff/security/audit/page.tsx` |
| `/staff/security` | `src/app/staff/security/page.tsx` |
| `/staff/security/recycle-bin` | `src/app/staff/security/recycle-bin/page.tsx` |
| `/staff/security/roles` | `src/app/staff/security/roles/page.tsx` |
| `/staff/security/users` | `src/app/staff/security/users/page.tsx` |
| `/staff/security/verified-perks` | `src/app/staff/security/verified-perks/page.tsx` |
| `/staff/shops` | `src/app/staff/shops/page.tsx` |
| `/terms` | `src/app/terms/page.tsx` |
| `/user/[id]` | `src/app/user/[id]/page.tsx` |
| `/user` | `src/app/user/page.tsx` |

## API and route handlers

| URL | Methods | Observed boundary | Source |
|---|---|---|---|
| `/api/account/delete` | POST | authenticated + inline role; service role | `src/app/api/account/delete/route.ts` |
| `/api/account/profile/update` | POST | authenticated; service role | `src/app/api/account/profile/update/route.ts` |
| `/api/account/username/change` | POST | authenticated + inline role; service role | `src/app/api/account/username/change/route.ts` |
| `/api/admin/approvals/approve` | POST | service role | `src/app/api/admin/approvals/approve/route.ts` |
| `/api/admin/approvals/override-approve` | POST | service role | `src/app/api/admin/approvals/override-approve/route.ts` |
| `/api/admin/approvals/pending` | GET | authenticated + inline role | `src/app/api/admin/approvals/pending/route.ts` |
| `/api/admin/approvals/reject` | POST | audit required / public | `src/app/api/admin/approvals/reject/route.ts` |
| `/api/admin/audit-info-action` | POST | inline auth; service role | `src/app/api/admin/audit-info-action/route.ts` |
| `/api/admin/ban-user` | POST | service role | `src/app/api/admin/ban-user/route.ts` |
| `/api/admin/community/categories` | GET, POST | service role | `src/app/api/admin/community/categories/route.ts` |
| `/api/admin/create-user` | POST | service role | `src/app/api/admin/create-user/route.ts` |
| `/api/admin/info/action` | POST | authenticated + inline role; inline auth; service role | `src/app/api/admin/info/action/route.ts` |
| `/api/admin/info/updates/action` | POST | service role | `src/app/api/admin/info/updates/action/route.ts` |
| `/api/admin/moderation/delete-post` | POST | service role | `src/app/api/admin/moderation/delete-post/route.ts` |
| `/api/admin/moderation/delete-thread` | POST | service role | `src/app/api/admin/moderation/delete-thread/route.ts` |
| `/api/admin/moderation/dm-delete-message` | POST | authenticated + inline role; service role | `src/app/api/admin/moderation/dm-delete-message/route.ts` |
| `/api/admin/notifications/broadcast` | POST | authenticated + inline role | `src/app/api/admin/notifications/broadcast/route.ts` |
| `/api/admin/reports/[reportId]/update` | POST | authenticated + inline role; service role | `src/app/api/admin/reports/[reportId]/update/route.ts` |
| `/api/admin/reports/bulk-update` | POST | authenticated + inline role; service role | `src/app/api/admin/reports/bulk-update/route.ts` |
| `/api/admin/reports/list` | GET | service role | `src/app/api/admin/reports/list/route.ts` |
| `/api/admin/restrictions/set` | POST | service role | `src/app/api/admin/restrictions/set/route.ts` |
| `/api/admin/roles/set` | POST | service role | `src/app/api/admin/roles/set/route.ts` |
| `/api/admin/security/broadcast` | POST | authenticated + inline role | `src/app/api/admin/security/broadcast/route.ts` |
| `/api/admin/security/force-logout` | POST | authenticated + inline role | `src/app/api/admin/security/force-logout/route.ts` |
| `/api/admin/security/settings` | POST | authenticated + inline role; service role | `src/app/api/admin/security/settings/route.ts` |
| `/api/admin/users/[userId]/ban-status` | GET | authenticated + inline role; service role | `src/app/api/admin/users/[userId]/ban-status/route.ts` |
| `/api/admin/users/donation-rank` | POST | service role | `src/app/api/admin/users/donation-rank/route.ts` |
| `/api/admin/users/verify` | POST | service role | `src/app/api/admin/users/verify/route.ts` |
| `/api/avatar` | GET | audit required / public | `src/app/api/avatar/route.ts` |
| `/api/forum/category-threads` | POST | authenticated + inline role; service role | `src/app/api/forum/category-threads/route.ts` |
| `/api/forum/community-feed` | GET | authenticated + inline role; service role | `src/app/api/forum/community-feed/route.ts` |
| `/api/forum/flags` | POST | authenticated + inline role; service role | `src/app/api/forum/flags/route.ts` |
| `/api/forum/posts/[postId]/delete` | POST | authenticated + inline role; service role | `src/app/api/forum/posts/[postId]/delete/route.ts` |
| `/api/forum/posts/[postId]/restore` | POST | inline auth; service role | `src/app/api/forum/posts/[postId]/restore/route.ts` |
| `/api/forum/posts/[postId]` | PATCH | authenticated + inline role; service role | `src/app/api/forum/posts/[postId]/route.ts` |
| `/api/forum/posts/[postId]/vote` | POST | inline auth; service role | `src/app/api/forum/posts/[postId]/vote/route.ts` |
| `/api/forum/posts/reply` | POST | inline auth; service role | `src/app/api/forum/posts/reply/route.ts` |
| `/api/forum/thread-meta` | POST | authenticated + inline role; service role | `src/app/api/forum/thread-meta/route.ts` |
| `/api/forum/thread-posts` | POST | authenticated + inline role; service role | `src/app/api/forum/thread-posts/route.ts` |
| `/api/forum/threads/[threadId]/accept-answer` | POST | authenticated + inline role; service role | `src/app/api/forum/threads/[threadId]/accept-answer/route.ts` |
| `/api/forum/threads/[threadId]/lock` | POST | authenticated + inline role; service role | `src/app/api/forum/threads/[threadId]/lock/route.ts` |
| `/api/forum/threads/[threadId]/pin` | POST | authenticated + inline role; service role | `src/app/api/forum/threads/[threadId]/pin/route.ts` |
| `/api/forum/threads/create` | POST | inline auth; service role | `src/app/api/forum/threads/create/route.ts` |
| `/api/forum/threads/lock` | POST | authenticated + inline role; service role | `src/app/api/forum/threads/lock/route.ts` |
| `/api/forum/threads/mark-answer` | POST | authenticated + inline role; service role | `src/app/api/forum/threads/mark-answer/route.ts` |
| `/api/forum/users/[targetUserId]/block` | POST | inline auth; service role | `src/app/api/forum/users/[targetUserId]/block/route.ts` |
| `/api/garage/[id]/like` | POST | inline auth; service role | `src/app/api/garage/[id]/like/route.ts` |
| `/api/garage/[id]/likes` | GET | inline auth; service role | `src/app/api/garage/[id]/likes/route.ts` |
| `/api/garage/new` | POST | service role | `src/app/api/garage/new/route.ts` |
| `/api/garage/update` | POST | inline auth; service role | `src/app/api/garage/update/route.ts` |
| `/api/info/pdf/[slug]` | GET | service role | `src/app/api/info/pdf/[slug]/route.ts` |
| `/api/info/submit` | POST | inline auth; service role | `src/app/api/info/submit/route.ts` |
| `/api/info/updates/submit` | POST | service role | `src/app/api/info/updates/submit/route.ts` |
| `/api/me/access` | GET | service role | `src/app/api/me/access/route.ts` |
| `/api/me/role` | GET | inline auth; service role | `src/app/api/me/role/route.ts` |
| `/api/messages/send` | POST | inline auth; service role | `src/app/api/messages/send/route.ts` |
| `/api/public/roles` | GET | service role | `src/app/api/public/roles/route.ts` |
| `/api/reports/[reportId]/message` | POST | authenticated + inline role; service role | `src/app/api/reports/[reportId]/message/route.ts` |
| `/api/reports/[reportId]` | GET | authenticated + inline role; service role | `src/app/api/reports/[reportId]/route.ts` |
| `/api/reports/create` | POST | authenticated + inline role; service role | `src/app/api/reports/create/route.ts` |
| `/api/security/ip-check` | GET | audit required / public | `src/app/api/security/ip-check/route.ts` |
| `/api/security/lockdown-status` | GET | audit required / public | `src/app/api/security/lockdown-status/route.ts` |
| `/api/security/log-session` | POST | authenticated; service role | `src/app/api/security/log-session/route.ts` |
| `/api/security/verify-lockdown-password` | POST | audit required / public | `src/app/api/security/verify-lockdown-password/route.ts` |
| `/api/staff/analytics/info` | GET | permission; service role | `src/app/api/staff/analytics/info/route.ts` |
| `/api/staff/ban-user` | POST | authenticated + inline role; service role | `src/app/api/staff/ban-user/route.ts` |
| `/api/staff/info/pending` | GET | any permission; service role | `src/app/api/staff/info/pending/route.ts` |
| `/api/staff/info/todo` | GET, POST, PATCH | permission; any permission; service role | `src/app/api/staff/info/todo/route.ts` |
| `/api/staff/info/updates` | GET | any permission; service role | `src/app/api/staff/info/updates/route.ts` |
| `/api/staff/moderation/delete-post` | POST | authenticated + inline role; service role | `src/app/api/staff/moderation/delete-post/route.ts` |
| `/api/staff/moderation/delete-thread` | POST | authenticated + inline role; service role | `src/app/api/staff/moderation/delete-thread/route.ts` |
| `/api/staff/moderation/dm-delete-message` | POST | authenticated + inline role; service role | `src/app/api/staff/moderation/dm-delete-message/route.ts` |
| `/api/staff/moderation/recycle-bin/purge` | POST | authenticated + inline role | `src/app/api/staff/moderation/recycle-bin/purge/route.ts` |
| `/api/staff/moderation/recycle-bin/restore` | POST | permission; service role | `src/app/api/staff/moderation/recycle-bin/restore/route.ts` |
| `/api/staff/moderation/reports/resolve-dm-targets` | POST | authenticated + inline role; service role | `src/app/api/staff/moderation/reports/resolve-dm-targets/route.ts` |
| `/api/staff/reports/[reportId]/descalate` | POST | authenticated + inline role; service role | `src/app/api/staff/reports/[reportId]/descalate/route.ts` |
| `/api/staff/reports/[reportId]/escalate` | POST | authenticated + inline role; service role | `src/app/api/staff/reports/[reportId]/escalate/route.ts` |
| `/api/staff/reports/[reportId]/update` | POST | authenticated + inline role; service role | `src/app/api/staff/reports/[reportId]/update/route.ts` |
| `/api/staff/restrictions/set` | POST | service role | `src/app/api/staff/restrictions/set/route.ts` |
| `/api/staff/security/permissions/[key]` | DELETE | permission; service role | `src/app/api/staff/security/permissions/[key]/route.ts` |
| `/api/staff/security/permissions` | GET, POST | any permission; service role | `src/app/api/staff/security/permissions/route.ts` |
| `/api/staff/security/roles/[key]/permissions/list` | GET | permission; service role | `src/app/api/staff/security/roles/[key]/permissions/list/route.ts` |
| `/api/staff/security/roles/[key]/permissions` | PUT | permission; service role | `src/app/api/staff/security/roles/[key]/permissions/route.ts` |
| `/api/staff/security/roles/[key]` | PATCH, DELETE | permission; service role | `src/app/api/staff/security/roles/[key]/route.ts` |
| `/api/staff/security/roles` | GET, POST | any permission; service role | `src/app/api/staff/security/roles/route.ts` |
| `/api/staff/security/users/[id]/avatar` | POST | permission; service role | `src/app/api/staff/security/users/[id]/avatar/route.ts` |
| `/api/staff/security/users/[id]/donation-rank` | PATCH | permission; service role | `src/app/api/staff/security/users/[id]/donation-rank/route.ts` |
| `/api/staff/security/users/[id]/permissions` | GET, PUT | permission; service role | `src/app/api/staff/security/users/[id]/permissions/route.ts` |
| `/api/staff/security/users/[id]/profile` | PATCH | permission; service role | `src/app/api/staff/security/users/[id]/profile/route.ts` |
| `/api/staff/security/users/[id]/role` | PATCH | permission; service role | `src/app/api/staff/security/users/[id]/role/route.ts` |
| `/api/staff/security/users/[id]/status` | GET | any permission; service role | `src/app/api/staff/security/users/[id]/status/route.ts` |
| `/api/staff/security/users/[id]/verify` | PATCH | permission; service role | `src/app/api/staff/security/users/[id]/verify/route.ts` |
| `/api/staff/security/users/login-events` | GET | permission; service role | `src/app/api/staff/security/users/login-events/route.ts` |
| `/api/staff/security/users/search` | GET | any permission; service role | `src/app/api/staff/security/users/search/route.ts` |
| `/api/staff/security/verified-perks` | GET, POST | service role | `src/app/api/staff/security/verified-perks/route.ts` |
| `/api/user/bundle` | POST | authenticated + inline role; service role | `src/app/api/user/bundle/route.ts` |
| `/auth/callback` | GET | audit required / public | `src/app/auth/callback/route.ts` |

## Database relations and storage buckets

The following names occur in `.from(...)`; `garage-covers` is a storage bucket rather than a relation.

| Name | Referencing files |
|---|---|
| `audit_logs` | 3 |
| `auth_login_events` | 2 |
| `avatars` | 2 |
| `dm_messages` | 8 |
| `dm_thread_members` | 1 |
| `forum_categories` | 14 |
| `forum_flags` | 2 |
| `forum_moderators` | 4 |
| `forum_post_votes` | 1 |
| `forum_posts` | 22 |
| `forum_thread_lead_scores` | 2 |
| `forum_threads` | 27 |
| `garage-covers` | 2 |
| `garage_car_likes` | 3 |
| `garage_cars` | 9 |
| `info_page_contributors` | 5 |
| `info_page_drafts` | 2 |
| `info_page_review_events` | 7 |
| `info_page_updates` | 5 |
| `info_pages` | 18 |
| `info_search_click_events` | 4 |
| `info_search_events` | 3 |
| `ip_bans` | 1 |
| `moderation_recycle_bin` | 3 |
| `notifications` | 10 |
| `permissions` | 2 |
| `profiles` | 50 |
| `report_messages` | 7 |
| `reports` | 12 |
| `role_permissions` | 5 |
| `roles` | 4 |
| `shops` | 3 |
| `site_security_settings` | 8 |
| `site_verified_perks` | 1 |
| `user_bans` | 11 |
| `user_blocks` | 12 |
| `user_permissions` | 4 |
| `user_restrictions` | 7 |
| `user_roles` | 43 |

## RPC dependencies

| RPC | Referencing files |
|---|---|
| `award_accepted_answer_karma` | 1 |
| `check_lockdown_password` | 1 |
| `contains_profanity` | 1 |
| `dm_get_or_create_thread` | 3 |
| `dm_get_thread` | 1 |
| `dm_leave_thread` | 1 |
| `dm_list_threads` | 2 |
| `dm_mark_all_read` | 2 |
| `dm_mark_thread_read` | 1 |
| `dm_send_message` | 1 |
| `dm_unread_thread_count` | 1 |
| `get_ip_ban_detail` | 1 |
| `get_site_lockdown_flags` | 7 |
| `increment_thread_view` | 1 |
| `revoke_accepted_answer_karma` | 1 |
| `search_info_pages` | 1 |
