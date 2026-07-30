# Pre-merge manual checks

Automated checks cannot reproduce production Supabase data, row-level security, or every role. Run this checklist against a seeded preview before merging.

## Accounts and states

- Logged out: home, knowledge base, community, garage, shops, login, legal pages, and a missing route.
- Member: account/profile updates, notifications, messages, content creation/editing, reporting, and empty/error states.
- Moderator or support: staff landing, report list/detail, moderation actions, denied security routes, and action feedback.
- Administrator: user/role/permission management, security settings, audit, recycle bin, broadcasts, and shop/community management.
- Banned/restricted user: global block, feature restriction messaging, expired restriction, and logout behavior.

## Viewports and input

- Test widths of 320 px, 375 px, 768 px, 1024 px, and 1440 px; check dense tables at narrow desktop widths.
- Test browser zoom at 100%, 200%, and 400% on representative public and staff pages.
- Navigate the header, command palette, forms, menus, and dialogs using only Tab, Shift+Tab, Enter, Space, Escape, and arrow keys.
- Confirm the first Tab reveals “Skip to main content” and moves focus to the main region.
- Enable reduced motion and confirm transitions do not impede navigation.
- Confirm dialogs trap focus, restore focus to their trigger, have an accessible name, and close with Escape.

## Outcomes

- Trigger loading, success, validation error, server failure, empty, and permission-denied states for visible actions.
- Confirm destructive actions require clear confirmation and never report success after a failed request.
- Check long names, unbroken URLs, large badges, empty table cells, and long translated-like labels for clipping or overflow.
- Verify no authentication tokens, raw server errors, stack traces, debug panels, or service-role data appear in the browser.
