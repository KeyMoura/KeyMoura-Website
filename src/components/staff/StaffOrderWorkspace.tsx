"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Workspace = { priority:"low"|"normal"|"high"|"urgent"; assigned_to:string|null; started_at:string|null };
type ChecklistItem = { id:string; title:string; is_complete:boolean };
type CostItem = { id:string; description:string; category:string; quantity:number; unit_cost_cents:number; billable:boolean; notes:string|null };
type Staff = { id:string; display_name:string|null; username:string|null };

const input = "rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 outline-none focus:border-brand-primary";
const money = (cents:number) => `$${(cents / 100).toFixed(2)}`;

export function StaffOrderWorkspace({ orderId, canManage }: { orderId:string; canManage:boolean }) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [workspace, setWorkspace] = useState<Workspace>({ priority:"normal", assigned_to:null, started_at:null });
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [costs, setCosts] = useState<CostItem[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [task, setTask] = useState("");
  const [cost, setCost] = useState({ description:"", category:"material", quantity:"1", unitCost:"", billable:false, notes:"" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const headers = useCallback(async () => {
    const session = await supabase.auth.getSession();
    return { "Content-Type":"application/json", ...(session.data.session?.access_token ? { Authorization:`Bearer ${session.data.session.access_token}` } : {}) };
  }, [supabase]);
  const load = useCallback(async () => {
    const response = await fetch(`/api/staff/orders/${orderId}/workspace`, { headers:await headers() });
    const data = await response.json();
    if (!response.ok) return setError(data.error || "Could not load production workspace");
    setWorkspace(data.workspace ?? { priority:"normal", assigned_to:null, started_at:null });
    setChecklist(data.checklist ?? []); setCosts(data.costs ?? []); setStaff(data.staff ?? []); setError("");
  }, [headers, orderId]);
  useEffect(() => { const timer=window.setTimeout(()=>void load(),0); return ()=>window.clearTimeout(timer); }, [load]);

  async function action(payload:Record<string,unknown>) {
    setSaving(true);
    const response = await fetch(`/api/staff/orders/${orderId}/workspace`, { method:"PATCH", headers:await headers(), body:JSON.stringify(payload) });
    const data = await response.json(); setSaving(false);
    if (!response.ok) { setError(data.error || "Could not update workspace"); return false; }
    await load(); return true;
  }
  async function addTask(event:FormEvent) { event.preventDefault(); if (await action({ action:"add_checklist", title:task })) setTask(""); }
  async function addCost(event:FormEvent) {
    event.preventDefault();
    if (await action({ action:"add_cost", description:cost.description, category:cost.category, quantity:Number(cost.quantity), unit_cost_cents:Math.round(Number(cost.unitCost)*100), billable:cost.billable, notes:cost.notes })) setCost({ description:"", category:"material", quantity:"1", unitCost:"", billable:false, notes:"" });
  }
  const complete = checklist.filter(item=>item.is_complete).length;
  const totalCost = costs.reduce((sum,item)=>sum+Math.round(Number(item.quantity)*item.unit_cost_cents),0);
  const billableCost = costs.filter(item=>item.billable).reduce((sum,item)=>sum+Math.round(Number(item.quantity)*item.unit_cost_cents),0);

  return <section className="rounded-2xl border border-zinc-800 bg-black/30 p-5 print:border-0 print:bg-white print:p-0 print:text-black">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs uppercase tracking-[.18em] text-brand-accent">Workshop</p><h2 className="mt-1 text-xl font-semibold">Production workspace</h2><p className="mt-1 text-xs text-brand-textMuted print:text-zinc-600">Private job planning, tasks, materials, and costs.</p></div><button type="button" onClick={()=>window.print()} className="rounded-xl border border-brand-border px-3 py-2 text-xs font-medium hover:border-brand-accent print:hidden">Print job sheet</button></div>
    <div className="mt-5 grid gap-3 sm:grid-cols-3 print:grid-cols-3">
      <label className="text-sm">Priority<select disabled={!canManage} className={`${input} mt-1 w-full`} value={workspace.priority} onChange={event=>setWorkspace({...workspace,priority:event.target.value as Workspace["priority"]})}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option></select></label>
      <label className="text-sm">Assigned to<select disabled={!canManage} className={`${input} mt-1 w-full`} value={workspace.assigned_to ?? ""} onChange={event=>setWorkspace({...workspace,assigned_to:event.target.value || null})}><option value="">Unassigned</option>{staff.map(person=><option key={person.id} value={person.id}>{person.display_name || (person.username ? `@${person.username}` : person.id)}</option>)}</select></label>
      <label className="flex items-end gap-2 rounded-xl border border-zinc-800 px-3 py-2 text-sm"><input disabled={!canManage} type="checkbox" checked={Boolean(workspace.started_at)} onChange={event=>setWorkspace({...workspace,started_at:event.target.checked ? new Date().toISOString() : null})} /><span>Production started</span></label>
    </div>
    {canManage?<button disabled={saving} onClick={()=>void action({ action:"save_workspace", priority:workspace.priority, assigned_to:workspace.assigned_to, started:Boolean(workspace.started_at) })} className="mt-3 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 text-sm font-semibold text-brand-primary disabled:opacity-50 print:hidden">Save planning</button>:null}

    <div className="mt-6 grid gap-6 xl:grid-cols-2 print:grid-cols-2">
      <div><div className="flex items-center justify-between"><h3 className="font-semibold">Production checklist</h3><span className="text-xs text-brand-textMuted">{complete}/{checklist.length} done</span></div>{checklist.length?<div className="mt-3 space-y-2">{checklist.map(item=><div key={item.id} className="flex items-center gap-3 rounded-xl border border-zinc-800 p-3"><input disabled={!canManage} type="checkbox" checked={item.is_complete} onChange={event=>void action({action:"toggle_checklist",item_id:item.id,is_complete:event.target.checked})}/><span className={`min-w-0 flex-1 text-sm ${item.is_complete?"text-brand-textMuted line-through":""}`}>{item.title}</span>{canManage?<button onClick={()=>void action({action:"delete_checklist",item_id:item.id})} className="text-xs text-rose-300 print:hidden" aria-label={`Remove ${item.title}`}>Remove</button>:null}</div>)}</div>:<p className="mt-3 text-sm text-brand-textMuted">No production steps yet.</p>}{canManage?<form onSubmit={addTask} className="mt-3 flex gap-2 print:hidden"><input required maxLength={240} value={task} onChange={event=>setTask(event.target.value)} className={`${input} min-w-0 flex-1`} placeholder="Add a production step…"/><button disabled={saving} className="rounded-xl border border-brand-accent/70 px-4 text-sm font-semibold text-brand-accent">Add</button></form>:null}</div>
      <div><div className="flex items-center justify-between"><h3 className="font-semibold">Materials & costs</h3><div className="text-right text-xs"><div>{money(totalCost)} total</div>{billableCost?<div className="text-brand-textMuted">{money(billableCost)} billable</div>:null}</div></div>{costs.length?<div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">{costs.map(item=><div key={item.id} className="grid grid-cols-[1fr_auto] gap-2 border-b border-zinc-800 p-3 text-sm last:border-0"><div><div className="font-medium">{item.description}</div><div className="text-xs text-brand-textMuted">{item.category} · {Number(item.quantity)} × {money(item.unit_cost_cents)}{item.billable?" · billable":""}</div>{item.notes?<p className="mt-1 text-xs text-brand-textMuted">{item.notes}</p>:null}</div><div className="text-right"><div>{money(Math.round(Number(item.quantity)*item.unit_cost_cents))}</div>{canManage?<button onClick={()=>void action({action:"delete_cost",item_id:item.id})} className="mt-1 text-xs text-rose-300 print:hidden">Remove</button>:null}</div></div>)}</div>:<p className="mt-3 text-sm text-brand-textMuted">No materials or costs recorded.</p>}
      {canManage?<form onSubmit={addCost} className="mt-3 grid gap-2 sm:grid-cols-2 print:hidden"><input required maxLength={240} value={cost.description} onChange={event=>setCost({...cost,description:event.target.value})} className={`${input} sm:col-span-2`} placeholder="Material, labor, or service"/><select value={cost.category} onChange={event=>setCost({...cost,category:event.target.value})} className={input}><option value="material">Material</option><option value="labor">Labor</option><option value="shipping">Shipping</option><option value="service">Service</option><option value="other">Other</option></select><div className="grid grid-cols-2 gap-2"><input required min="0.001" step="0.001" type="number" value={cost.quantity} onChange={event=>setCost({...cost,quantity:event.target.value})} className={input} aria-label="Quantity"/><input required min="0" step=".01" type="number" value={cost.unitCost} onChange={event=>setCost({...cost,unitCost:event.target.value})} className={input} placeholder="$ each" aria-label="Unit cost"/></div><input maxLength={1000} value={cost.notes} onChange={event=>setCost({...cost,notes:event.target.value})} className={`${input} sm:col-span-2`} placeholder="Vendor, stock size, machine time…"/><label className="flex items-center gap-2 text-xs text-brand-textMuted"><input type="checkbox" checked={cost.billable} onChange={event=>setCost({...cost,billable:event.target.checked})}/> Include as billable cost</label><button disabled={saving} className="rounded-xl border border-brand-accent/70 px-4 py-2 text-sm font-semibold text-brand-accent">Add cost</button></form>:null}</div>
    </div>
    {error?<p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200 print:hidden">{error}</p>:null}
  </section>;
}
