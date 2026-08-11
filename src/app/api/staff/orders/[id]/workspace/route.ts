import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

const priorities = new Set(["low", "normal", "high", "urgent"]);
const categories = new Set(["material", "labor", "shipping", "service", "other"]);
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

async function getOrder(id: string) {
  return routeServiceClient.from("orders").select("id").eq("id", id).maybeSingle();
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "orders.view") || await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const order = await getOrder(id);
  if (!order.data) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const [workspace, checklist, costs, roles] = await Promise.all([
    routeServiceClient.from("order_workspaces").select("*").eq("order_id", id).maybeSingle(),
    routeServiceClient.from("order_checklist_items").select("*").eq("order_id", id).order("sort_order").order("created_at"),
    routeServiceClient.from("order_cost_items").select("*").eq("order_id", id).order("sort_order").order("created_at"),
    routeServiceClient.from("user_roles").select("user_id,role").neq("role", "member"),
  ]);
  const staffIds = [...new Set((roles.data ?? []).map(row => row.user_id))];
  const profiles = staffIds.length
    ? await routeServiceClient.from("profiles").select("id,display_name,username").in("id", staffIds)
    : { data: [], error: null };
  const error = workspace.error || checklist.error || costs.error || roles.error || profiles.error;
  if (error) return NextResponse.json({ error: "Could not load workspace" }, { status: 500 });
  return NextResponse.json({ workspace: workspace.data, checklist: checklist.data ?? [], costs: costs.data ?? [], staff: profiles.data ?? [] });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !(await getOrder(id)).data) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const action = body.action;

  if (action === "save_workspace") {
    const priority = text(body.priority, 10);
    if (!priorities.has(priority)) return NextResponse.json({ error: "Invalid priority" }, { status: 400 });
    const assignedTo = typeof body.assigned_to === "string" && /^[0-9a-f-]{36}$/i.test(body.assigned_to) ? body.assigned_to : null;
    if (assignedTo) {
      const { data: assignedRole } = await routeServiceClient.from("user_roles").select("role").eq("user_id", assignedTo).neq("role", "member").maybeSingle();
      if (!assignedRole) return NextResponse.json({ error: "Assignee must be a staff member" }, { status: 400 });
    }
    const { data: currentWorkspace } = await routeServiceClient.from("order_workspaces").select("started_at").eq("order_id", id).maybeSingle();
    /*
     * `started` is optional, and omitting it preserves what is already there.
     *
     * The order page used to carry a "Production started" checkbox beside
     * priority and assignee, so every save sent the flag and `null` genuinely
     * meant "not started". That checkbox is gone: whether a thing is being made
     * is `production_jobs.started_at`, and two columns answering that question
     * is exactly the split this pass closed. The triage panel that replaced it
     * saves priority and assignee only — so a *missing* key must leave
     * `started_at` alone rather than silently clearing a timestamp nobody asked
     * about. A caller that still sends `started` keeps the old behaviour.
     */
    const startedAt = Object.prototype.hasOwnProperty.call(body, "started")
      ? (body.started ? currentWorkspace?.started_at || new Date().toISOString() : null)
      : (currentWorkspace?.started_at ?? null);
    const { error } = await routeServiceClient.from("order_workspaces").upsert({ order_id:id, priority, assigned_to:assignedTo, started_at:startedAt, updated_by:actor.userId, updated_at:new Date().toISOString() });
    if (error) return NextResponse.json({ error: "Could not save workspace" }, { status: 500 });
  } else if (action === "add_checklist") {
    const title = text(body.title, 240);
    if (!title) return NextResponse.json({ error: "Checklist item is required" }, { status: 400 });
    const { error } = await routeServiceClient.from("order_checklist_items").insert({ order_id:id, title, created_by:actor.userId });
    if (error) return NextResponse.json({ error: "Could not add checklist item" }, { status: 500 });
  } else if (action === "toggle_checklist") {
    const itemId = text(body.item_id, 50);
    const complete = body.is_complete === true;
    const { error } = await routeServiceClient.from("order_checklist_items").update({ is_complete:complete, completed_at:complete ? new Date().toISOString() : null, completed_by:complete ? actor.userId : null, updated_at:new Date().toISOString() }).eq("id", itemId).eq("order_id", id);
    if (error) return NextResponse.json({ error: "Could not update checklist" }, { status: 500 });
  } else if (action === "delete_checklist") {
    const { error } = await routeServiceClient.from("order_checklist_items").delete().eq("id", text(body.item_id, 50)).eq("order_id", id);
    if (error) return NextResponse.json({ error: "Could not remove checklist item" }, { status: 500 });
  } else if (action === "add_cost") {
    const description = text(body.description, 240);
    const category = text(body.category, 20);
    const quantity = Number(body.quantity);
    const unitCostCents = Math.round(Number(body.unit_cost_cents));
    if (!description || !categories.has(category) || !Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(unitCostCents) || unitCostCents < 0) return NextResponse.json({ error: "Enter a valid cost item" }, { status: 400 });
    const { error } = await routeServiceClient.from("order_cost_items").insert({ order_id:id, description, category, quantity, unit_cost_cents:unitCostCents, billable:body.billable === true, notes:text(body.notes,1000) || null, created_by:actor.userId });
    if (error) return NextResponse.json({ error: "Could not add cost item" }, { status: 500 });
  } else if (action === "delete_cost") {
    const { error } = await routeServiceClient.from("order_cost_items").delete().eq("id", text(body.item_id, 50)).eq("order_id", id);
    if (error) return NextResponse.json({ error: "Could not remove cost item" }, { status: 500 });
  } else {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
