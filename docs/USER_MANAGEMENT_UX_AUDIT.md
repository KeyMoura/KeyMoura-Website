# User management — UX audit

Driven in a browser at `f81ad7c`, before any edit, through a temporary local
harness that mounted the **real** `/staff/users` and `/staff/users/[id]`
components inside the real `StaffShell` with fixtures served through a
`window.fetch` interceptor. Every number below was measured, not estimated.

## The headline measurements

| Surface | Measured | Why it matters |
|---|---|---|
| Access tab, total height | **6,367px** at a 900px viewport | Seven screens of scrolling to change one thing |
| Access tab, permission checkboxes | **115**, ungrouped, one flat column | The wall the brief describes |
| Permission labels | Raw keys: `catalog.categories.manage` | Staff must know RBAC internals to read it |
| Directory filter bar | **8 always-visible controls**, 78px tall at 1280, **147px at 375** | Filters outweigh the people |
| Directory filter bar, expanded | **12 controls** across two bars | "More filters" adds a whole second row |
| Directory row height | 110px at 1280, **150px at 375** | ~1.5 people per phone screen |
| Detail tab strip at 375px | 681px of tabs in a 342px box | **Half the tabs are off-screen**, no affordance |
| Detail tabs | 7 | Above the brief's stated ceiling |

## Findings, by kind

### 1. The Access tab is the worst surface in the product

- 115 checkboxes in a single ungrouped column, labelled with **raw permission
  keys**. Nothing says which of them the person's role already gives, so the
  screen cannot answer the only question a reader has: *what can this person
  actually do?*
- The category filter is a dropdown that shows one category at a time, so
  comparing two areas means two selections and no overview.
- "Direct permission grants" never states the rule that makes it safe — that
  overrides can only **add**. A reader reasonably assumes unticking a box that
  the role grants will take it away. It will not.
- Role, account status, permissions and sign-in methods are four unrelated
  panels stacked under one tab called "Roles & access".

### 2. Role changes say nothing about what changes

Choosing a new role and pressing **Change role** shows one sentence — "This
grants staff access to the whole staff area" — and only for a staff-boundary
crossing. Moving Administrator → Support states nothing at all about the
catalog, user management and commerce settings the person is about to lose.

### 3. Account status is three vocabularies in one panel

The panel mixes **suspend / unsuspend / restrict / unrestrict** (four verbs) with
**site / community / dm** (three areas), in two dropdowns, above a bare text
input labelled only by placeholder. Nothing states what a restriction withholds
or what survives it. Notably:

- **The route accepts `durationHours` and the UI never sends it.** Every
  restriction applied from this screen is permanent, and the "Expires" line the
  Overview renders can therefore only ever say "no expiry".
- The reason field is `<input>` with a placeholder and an `sr-only` label; the
  requirement ("at least 8 characters") appears only as a hint after the fact.

### 4. Overview is not a summary

It is: an eight-row fact table, a ten-row metrics table, **and a full profile
editor with its own Save button**. The metrics table gives `Cancelled` and
`Open production` the same visual weight as `Lifetime spend`.

### 5. Staff accounts are shown as if they were customers

An administrator with no orders still gets the full **Customer value** panel —
ten fields reading `$0.00`, `0`, `—`. Nothing on their Overview mentions their
role's access or their recent staff activity; that is a tab away.

### 6. Forum-era fields sit beside commerce ones

`Verified` (with a note about "Verified perks") and `Donation rank` sit in the
profile editor at the same level as Display name, on a shop's customer record.
`Bio` and `Location` are there too. `Karma` is loaded by the API and rendered
nowhere.

### 7. Duplicated information across tabs

| Fact | Appears on |
|---|---|
| Sign-in methods | Overview **and** Access |
| Account status + meaning | Header chip, Overview facts, Overview "Why this account is limited", Access panel |
| Order count / spend | Directory row, Overview metrics, Orders tab heading |
| Email address | Header description, Overview facts, profile editor |

### 8. Labels and terminology

- **"People & accounts"** in the sidebar; **"People & accounts"** as the page
  title; "Back to people" and "All people" as two different buttons for the same
  destination.
- **"Roles & access"** as a tab, **"Direct permission grants"** as its section,
  **"Account status"** for bans — three registers in one panel.
- **"Customer value"** as a heading on a staff member's record.
- Guest orders are labelled correctly ("Possible guest orders", "Unclaimed guest
  order") — this is the one piece of terminology that is already exactly right
  and is preserved unchanged.

### 9. Actions are scattered

The header carries "Open KM-0142" and "All people". Everything else — add a
note, change a role, restrict an account, re-send an email — is inside whichever
tab happens to own it, with no indication from the header that it exists.

### 10. Things staff should not have to care about

- `Account ID` (a raw UUID) is the **first** row of Overview.
- `Last seen` and `Last sign-in` are separate rows, two minutes apart, with no
  explanation of the difference.
- `Level 10` (the numeric role rank) is a fact on the Access tab.

### 11. What is already right and must not be lost

- Server-side search, filter, sort and paging; the browser never holds more than
  one page.
- Every panel treats a 403 as an error, never as an empty list.
- Guest orders are excluded from every metric and labelled as unowned.
- Email is read-only, providers are read-only, no token or auth internal is sent.
- Role rank rules, self-edit refusal, last-admin protection, stale-state checks
  and audit-on-write.
