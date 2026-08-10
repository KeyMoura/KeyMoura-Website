import "server-only";

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { isEmptyChangeSet, isSensitiveField, summarizeChanges, type ChangeSet } from "./diff.ts";
import { describeAction } from "./actions.ts";

/**
 * The canonical audit writer.
 *
 * Everything that records a meaningful mutation goes through here. The older
 * `logAuditEvent` still exists for the 100-odd legacy call sites and now
 * delegates to this function, so there is one table, one shape and one place
 * that decides what is safe to store.
 *
 * ## On transactional integrity
 *
 * The ideal is that the audit row and the mutation commit together. Where that
 * is achievable it is done: catalog changes are written by a database trigger
 * inside the same transaction as the `products` write, which is also why the
 * browser-direct catalog editor is audited at all.
 *
 * For the rest, KeyMoura's mutations go through the Supabase REST client, which
 * has no cross-statement transaction. Rather than pretend otherwise, this
 * module does three things:
 *
 * 1. The audit row is written only **after** the mutation is confirmed — every
 *    caller checks the affected-row count first — so a failed mutation cannot
 *    produce a success event.
 * 2. A failed audit write is never swallowed. It is logged with its SQLSTATE
 *    and returned to the caller, which surfaces it rather than reporting a
 *    clean success for an unlogged change.
 * 3. Security-sensitive actions use {@link recordAuditEventStrict}, which makes
 *    the failure the caller's problem to report to the operator.
 *
 * The residual gap — mutation committed, process died before the audit insert —
 * is recorded in `docs/COMMERCE_LEDGER.md` rather than hidden.
 */

export type AuditActorKind = "staff" | "system" | "provider" | "scheduled" | "customer";

export type AuditSource = "staff_ui" | "api" | "webhook" | "trigger" | "job";

export type AuditActor =
  | { kind: "staff"; userId: string; role?: string | null; label?: string | null }
  | { kind: "customer"; userId: string | null; label?: string | null }
  | { kind: "system"; label?: string | null }
  /** Stripe, Resend — a provider is never given a person's name. */
  | { kind: "provider"; provider: string; label?: string | null }
  | { kind: "scheduled"; job: string };

export type AuditEntityRef = {
  type: string;
  id: string | null;
  /** KM-0012, PJ-0008, "Shift Knob" — what the row shows instead of a uuid. */
  label?: string | null;
};

export type AuditRelations = {
  orderId?: string | null;
  productionJobId?: string | null;
  productId?: string | null;
};

export type RecordAuditEventInput = {
  action: string;
  actor: AuditActor;
  entity?: AuditEntityRef;
  related?: AuditRelations;
  changes?: ChangeSet | null;
  /** Overrides the summary derived from `changes`. */
  summary?: string | null;
  metadata?: Record<string, unknown> | null;
  correlationId?: string | null;
  /** When the change happened, if that is not now. */
  occurredAt?: string | null;
  source?: AuditSource;
  actorIp?: string | null;
};

export type RecordAuditEventResult = { ok: true; id: string | null } | { ok: false; error: string };

const MAX_METADATA_KEYS = 40;
const MAX_METADATA_STRING = 500;

/**
 * Metadata is caller-supplied, so it is filtered rather than trusted.
 *
 * Sensitive keys are dropped, strings are capped, and nested objects are kept
 * only one level deep. An audit event is a description of a change, not a place
 * to park a request body.
 */
function sanitizeMetadata(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  const output: Record<string, unknown> = {};
  let kept = 0;

  for (const [key, value] of Object.entries(metadata)) {
    if (kept >= MAX_METADATA_KEYS) break;
    if (isSensitiveField(key)) continue;
    if (value === undefined) continue;

    if (value === null || typeof value === "number" || typeof value === "boolean") {
      output[key] = value;
      kept += 1;
      continue;
    }

    if (typeof value === "string") {
      output[key] = value.length > MAX_METADATA_STRING ? `${value.slice(0, MAX_METADATA_STRING)}…` : value;
      kept += 1;
      continue;
    }

    if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 20)
        .filter((item) => ["string", "number", "boolean"].includes(typeof item))
        .map((item) => (typeof item === "string" && item.length > MAX_METADATA_STRING ? `${item.slice(0, MAX_METADATA_STRING)}…` : item));
      kept += 1;
      continue;
    }

    if (typeof value === "object") {
      const nested: Record<string, unknown> = {};
      for (const [nestedKey, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (isSensitiveField(nestedKey)) continue;
        if (nestedValue === null || ["string", "number", "boolean"].includes(typeof nestedValue)) {
          nested[nestedKey] =
            typeof nestedValue === "string" && nestedValue.length > MAX_METADATA_STRING
              ? `${nestedValue.slice(0, MAX_METADATA_STRING)}…`
              : nestedValue;
        }
      }
      output[key] = nested;
      kept += 1;
    }
  }

  return output;
}

/** Drops any sensitive field that reached a change set by another route. */
function sanitizeChanges(changes: ChangeSet | null | undefined): ChangeSet {
  if (!changes) return {};
  const output: ChangeSet = {};
  for (const [field, change] of Object.entries(changes)) {
    if (isSensitiveField(field)) continue;
    output[field] = change;
  }
  return output;
}

function actorColumns(actor: AuditActor): {
  actor_user_id: string | null;
  actor_role: string | null;
  actor_kind: AuditActorKind;
  actor_label: string;
} {
  switch (actor.kind) {
    case "staff":
      return {
        actor_user_id: actor.userId,
        actor_role: actor.role ?? "staff",
        actor_kind: "staff",
        actor_label: actor.label?.trim() || "Staff",
      };
    case "customer":
      return {
        actor_user_id: actor.userId,
        actor_role: "customer",
        actor_kind: "customer",
        actor_label: actor.label?.trim() || "Customer",
      };
    case "provider":
      // Never given a user id. A Stripe-driven change is not a person's action,
      // and attributing it to whoever happened to be signed in would be a lie
      // told by an audit log, which is the worst kind.
      return {
        actor_user_id: null,
        actor_role: "provider",
        actor_kind: "provider",
        actor_label: actor.label?.trim() || actor.provider,
      };
    case "scheduled":
      return {
        actor_user_id: null,
        actor_role: "system",
        actor_kind: "scheduled",
        actor_label: actor.job || "Scheduled job",
      };
    case "system":
    default:
      return {
        actor_user_id: null,
        actor_role: "system",
        actor_kind: "system",
        actor_label: actor.label?.trim() || "System",
      };
  }
}

/**
 * Writes one audit event.
 *
 * Never throws. Callers get `{ ok: false, error }` and decide how loud to be —
 * see {@link recordAuditEventStrict} for the security-sensitive path.
 */
export async function recordAuditEvent(input: RecordAuditEventInput): Promise<RecordAuditEventResult> {
  try {
    const changes = sanitizeChanges(input.changes);
    const definition = describeAction(input.action);
    const actor = actorColumns(input.actor);

    const row = {
      ...actor,
      actor_ip: input.actorIp ?? null,
      event_type: input.action,
      source: input.source ?? "api",
      occurred_at: input.occurredAt ?? new Date().toISOString(),

      // `target_table`/`target_id` are the legacy columns. They are still
      // written so the 46 historical rows and the new ones can be read by the
      // same query, and so nothing that already reads them breaks.
      target_table:
        input.entity?.type === "order"
          ? "orders"
          : input.entity?.type === "product"
            ? "products"
            : input.entity?.type === "support_conversation"
              ? "support_conversations"
              : input.entity?.type ?? null,
      target_id: input.entity?.id ?? null,

      entity_type: input.entity?.type ?? definition.entityType,
      entity_id: input.entity?.id ?? null,
      entity_label: input.entity?.label ?? null,

      related_order_id: input.related?.orderId ?? null,
      related_production_job_id: input.related?.productionJobId ?? null,
      related_product_id: input.related?.productId ?? null,

      changes,
      // Entity-aware, so a production job's `in_progress` is summarized as
      // "In progress" and an order's as "In production".
      summary: input.summary ?? summarizeChanges(changes, input.entity?.type ?? definition.entityType),
      correlation_id: input.correlationId ?? null,
      metadata: sanitizeMetadata(input.metadata),
    };

    const { data, error } = await supabaseAdmin.from("audit_logs").insert(row).select("id").maybeSingle();

    if (error) {
      // SQLSTATE, message and hint only — `details` echoes row values back.
      console.error("[audit] insert failed", {
        action: input.action,
        code: (error as { code?: string }).code ?? null,
        message: (error as { message?: string }).message?.slice(0, 300) ?? null,
        hint: (error as { hint?: string }).hint?.slice(0, 200) ?? null,
      });
      return { ok: false, error: "Could not record the audit event." };
    }

    return { ok: true, id: (data as { id?: string } | null)?.id ?? null };
  } catch (error) {
    console.error("[audit] insert threw", {
      action: input.action,
      message: (error as { message?: string })?.message?.slice(0, 300) ?? null,
    });
    return { ok: false, error: "Could not record the audit event." };
  }
}

/**
 * The same write, for actions where an unlogged change is itself the incident.
 *
 * Role assignments and permission changes are the cases: "somebody became an
 * admin and there is no record of who did it" is exactly the question this log
 * exists to answer, so the caller is expected to fail the request rather than
 * report success.
 */
export async function recordAuditEventStrict(input: RecordAuditEventInput): Promise<void> {
  const result = await recordAuditEvent(input);
  if (!result.ok) {
    throw new Error(`Audit write failed for ${input.action}; the change was not recorded.`);
  }
}

/**
 * Records an event only when something actually changed.
 *
 * This is the guard behind "one successful save = one meaningful event": a
 * staff member pressing Save on an untouched form produces no row.
 */
export async function recordAuditChange(
  input: RecordAuditEventInput & { changes: ChangeSet }
): Promise<RecordAuditEventResult | null> {
  if (isEmptyChangeSet(sanitizeChanges(input.changes))) return null;
  return recordAuditEvent(input);
}

/**
 * A readable actor label for a staff user, captured at write time.
 *
 * Falls back to the id's prefix rather than "Unknown" when the profile lookup
 * fails, because a partial identifier is still traceable and "Unknown" is not.
 */
export async function resolveActorLabel(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabaseAdmin
      .from("profiles")
      .select("display_name,username")
      .eq("id", userId)
      .maybeSingle();
    const profile = data as { display_name?: string | null; username?: string | null } | null;
    return profile?.display_name?.trim() || profile?.username?.trim() || `User ${userId.slice(0, 8)}`;
  } catch {
    return `User ${userId.slice(0, 8)}`;
  }
}
