# Production Workflow 2.0 audit

Baseline inspected: `d0128cfddcb29821d6a260cd787f50e182df283f` (the clean local
checkout supplied for this pass). The environment could not reach GitHub, so origin/main
and the hosted migration ledger could not be independently verified. Repository schema
fixtures and migration contract tests remain the safe local parity check.

## Workflow ownership and state

`production_jobs` remains the only manufacturing state machine. The order workspace is
compatibility/triage data, while `order_cost_items` remains the sole production-cost
ledger. No legacy production editor was restored.

The existing database states cover planning, waits, scheduled work, active work, QC,
rework, holds, completion and cancellation. Existing `ready_for_pickup` and
`ready_to_ship` values are retained for compatibility, but new workflow work treats
`completed` as **manufacturing complete and ready for Fulfillment**. It never changes a
shipment, pickup or delivery state. Status writes remain permission checked, compare the
expected status, update with a status predicate, and write timeline and audit records.

Completion now refuses any unfinished manufacturing, completion, or quality task. Jobs
without a checklist remain valid for simple work. Missing labour time remains an explicit
acknowledgeable warning; skipped QC does not.

## UX audit and decisions

- **Queue/board:** the existing grouped queue already provides a safe non-drag board.
  Cards show job/order, item, quantity, status, priority, due date, assignee, blocker,
  customer, task progress and QC waiting. Explicit job-workspace actions avoid unsafe
  drag/drop transitions.
- **List:** the same server-filtered, bounded result can be viewed as a dense table with
  job, order, item, status, priority, assignee, machine, due, progress and updated columns.
  The layout choice lives in the URL. Existing status, priority, assignee, overdue and
  text filters remain server-side. More relational search/filter dimensions remain
  deferred rather than pretending that client filtering is complete.
- **Workspace:** the existing canonical job page already separates manufacturing,
  tasks, quality, files, notes and history, and exposes source-order links and guarded
  actions. It has assignment, priority and due-date editing with optimistic concurrency.
- **Tasks/QC:** one sequenced task table continues to represent steps, completion checks
  and QC checks. Add, tick/reopen and remove are supported and audited. The schema has no
  task assignee or task due date; these were not faked.
- **Files:** `production_job_files` remains a reference/link workflow. Secure direct
  upload is deferred until a private bucket, upload authorization and expiring download
  URLs exist.
- **Costing:** the order Production tab continues to show `order_cost_items`; it does not
  expose customer sale price as manufacturing cost or create a second cost table.
- **Order context/linking:** the order tab summarizes linked canonical jobs and supports
  multiple rows, create, link and guarded relink. Full order editing stays in Orders.
- **Fulfillment:** completing manufacturing raises the existing fulfillment operational
  alert; Fulfillment alone owns shipped, picked-up and delivered state.
- **Dashboard/automation:** existing production summary cards and scheduled
  due/overdue/block discovery are reused. No scheduler or reminder table was added.
- **Permissions:** `production.view` remains read-only and `production.manage` guards all
  job, status, assignment, task and QC writes.

## Machine/work-center decision

The production schema has no work-center or machine relationship. A real implementation
needs an additive table/FK migration (active flag, name, type, optional identifier,
grants, RLS and indexes). Per the migration approval rule, this pass does not encode a
machine in notes or create an application-only list. The list shows “Not assigned” so the
absence is honest. A future approved migration can add work centers without creating a
second workflow or CMMS.

## Deferred manufacturing features and legacy debt

- Approved work-center schema and assignment UI, including NymoLabs 6040.
- Server-side relational search across customer/order/product, machine filtering, and
  cursor pagination beyond the current bounded offset page.
- Task reorder, per-task assignee/due date, and richer inspection measurements require
  explicit schema support.
- Private production-file storage and signed upload/download flow.
- `order_workspaces` remains required by `staff_order_queue` compatibility/triage;
  `order_checklist_items` remains legacy debt. Neither is a production state owner.
- The inherited fulfillment-named production statuses should be retired only through a
  separately approved compatibility migration after live-row analysis.

No migration was created or applied in this pass.
