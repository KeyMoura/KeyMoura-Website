"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { emptyShippingAddress, type FulfillmentMethod, type ShippingAddress } from "@/lib/checkout";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Draft = { id:string; title:string; request_data:FormData; updated_at:string };
type FormData = {
  title:string; project_type:string; description:string; material:string; dimensions:string; tolerance:string; finish:string;
  quantity:number; budget:string; target_date:string; fulfillment_method:FulfillmentMethod; shipping_address:ShippingAddress;
};
const initial = (): FormData => ({ title:"", project_type:"", description:"", material:"", dimensions:"", tolerance:"", finish:"", quantity:1, budget:"", target_date:"", fulfillment_method:"shipping", shipping_address:emptyShippingAddress() });
const input = "mt-1 w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2.5 outline-none transition focus:border-brand-primary";
const projectTypes = ["Automotive part", "Replacement part", "Sign or display", "Furniture / woodworking", "Fixture or jig", "Prototype", "Other custom project"];
const materials = ["Open to recommendation", "Aluminum", "Delrin / acetal", "Acrylic", "Hardwood", "Plywood / MDF", "Brass", "Other"];

function fileError(file: File) {
  const allowed = /\.(stl|step|stp|iges|igs|dxf|dwg|svg|pdf|png|jpe?g|webp|zip)$/i;
  if (!allowed.test(file.name)) return `${file.name}: use CAD, drawing, image, PDF, or ZIP files.`;
  if (file.size > 50 * 1024 * 1024) return `${file.name}: each file must be 50 MB or smaller.`;
  return "";
}

export default function NewCustomRequestPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [form,setForm] = useState<FormData>(initial);
  const [step,setStep] = useState<1|2|3|4>(1);
  const [files,setFiles] = useState<File[]>([]);
  const [drafts,setDrafts] = useState<Draft[]>([]);
  const [draftId,setDraftId] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [saved,setSaved] = useState("");

  useEffect(() => { void (async()=>{
    const { data:{ user } } = await supabase.auth.getUser();
    if (!user) return;
    const result = await supabase.from("order_request_drafts").select("id,title,request_data,updated_at").eq("customer_id",user.id).order("updated_at",{ascending:false});
    setDrafts((result.data ?? []) as Draft[]);
  })(); },[supabase]);

  function validate(current:number) {
    if (current === 1 && (!form.project_type || form.description.trim().length < 20)) return "Choose a project type and describe what you need in at least 20 characters.";
    if (current === 2) { for (const file of files) { const message=fileError(file); if(message) return message; } }
    if (current === 3 && form.fulfillment_method === "shipping") { const a=form.shipping_address; if(!a.name.trim()||!a.line1.trim()||!a.city.trim()||!a.state.trim()||!a.postal_code.trim()) return "Enter a complete shipping address."; }
    return "";
  }
  function next() { const message=validate(step); if(message) return setError(message); setError(""); setStep(Math.min(4,step+1) as 1|2|3|4); window.scrollTo({top:0,behavior:"smooth"}); }
  async function headers() { const { data }=await supabase.auth.getSession(); return { "Content-Type":"application/json", ...(data.session?.access_token?{Authorization:`Bearer ${data.session.access_token}`}:{}) }; }
  async function saveDraft() {
    setBusy(true); setError(""); setSaved("");
    const { data:{ user } }=await supabase.auth.getUser();
    if(!user){ router.push(`/auth/login?next=${encodeURIComponent("/orders/new")}`); return; }
    const payload={customer_id:user.id,title:form.title.trim()||form.project_type||"Untitled custom request",request_data:form,updated_at:new Date().toISOString()};
    const result=draftId?await supabase.from("order_request_drafts").update(payload).eq("id",draftId).eq("customer_id",user.id).select().single():await supabase.from("order_request_drafts").insert(payload).select().single();
    if(result.error) setError(result.error.message); else { setDraftId(result.data.id); setSaved("Draft saved. Files are added when you submit."); setDrafts(current=>[result.data as Draft,...current.filter(item=>item.id!==result.data.id)]); }
    setBusy(false);
  }
  async function submit(e:FormEvent) {
    e.preventDefault(); const message=[1,2,3].map(validate).find(Boolean); if(message) return setError(message);
    setBusy(true); setError("");
    const { data:{ user } }=await supabase.auth.getUser();
    if(!user){ router.push(`/auth/login?next=${encodeURIComponent("/orders/new")}`); return; }
    const batch=crypto.randomUUID(); const uploaded:{path:string;name:string;size:number}[]=[];
    for(const file of files){ const safe=file.name.replace(/[^a-zA-Z0-9._-]/g,"_"); const path=`${user.id}/${batch}/${crypto.randomUUID()}-${safe}`; const result=await supabase.storage.from("order-assets").upload(path,file,{contentType:file.type||undefined}); if(result.error){ if(uploaded.length) await supabase.storage.from("order-assets").remove(uploaded.map(item=>item.path)); setBusy(false); return setError(`Could not upload ${file.name}: ${result.error.message}`); } uploaded.push({path,name:file.name,size:file.size}); }
    const response=await fetch("/api/orders/custom",{method:"POST",headers:await headers(),body:JSON.stringify({...form,files:uploaded,draft_id:draftId})});
    const result=await response.json() as {id?:string;error?:string};
    if(!response.ok||!result.id){ if(uploaded.length) await supabase.storage.from("order-assets").remove(uploaded.map(item=>item.path)); setError(result.error||"Could not submit request."); setBusy(false); return; }
    router.push(`/orders/${result.id}/confirmed`);
  }
  const set=<K extends keyof FormData>(key:K,value:FormData[K])=>setForm(current=>({...current,[key]:value}));
  const labels=["Project","Specs & files","Delivery","Review"];
  return <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
    <div className="grid gap-8 lg:grid-cols-[.7fr_1.3fr]">
      <aside><p className="text-xs font-semibold uppercase tracking-[.2em] text-brand-primary">Custom CNC request</p><h1 className="mt-2 text-4xl font-semibold">Tell us what you need made.</h1><p className="mt-4 leading-7 text-brand-textMuted">A sketch or plain-language idea is enough to start. No payment is taken until you review and approve a quote.</p>
        <div className="mt-7 rounded-2xl border border-zinc-800 bg-black/30 p-5"><h2 className="font-semibold">Before production</h2><ul className="mt-3 space-y-2 text-sm text-brand-textMuted"><li>• We review manufacturability and ask questions.</li><li>• You receive a written price and payment schedule.</li><li>• Production starts only after quote approval and required payment.</li></ul></div>
        {drafts.length?<div className="mt-5 rounded-2xl border border-zinc-800 p-4"><h2 className="text-sm font-semibold">Saved drafts</h2><div className="mt-3 space-y-2">{drafts.map(d=><button type="button" key={d.id} onClick={()=>{setForm({...initial(),...d.request_data});setDraftId(d.id);setStep(1);}} className="block w-full rounded-xl border border-zinc-800 p-3 text-left text-sm hover:border-brand-primary"><span className="block font-medium">{d.title}</span><span className="mt-1 block text-xs text-brand-textMuted">Updated {new Date(d.updated_at).toLocaleDateString()}</span></button>)}</div></div>:null}
      </aside>
      <form onSubmit={submit} className="rounded-3xl border border-zinc-700 bg-zinc-950/70 p-5 sm:p-7">
        <div className="grid grid-cols-4 gap-2">{labels.map((label,index)=><button type="button" key={label} onClick={()=>index+1<step&&setStep((index+1) as 1|2|3|4)} className={`rounded-lg border px-2 py-2 text-xs ${step===index+1?"border-brand-primary bg-brand-primary/10 text-brand-primary":step>index+1?"border-emerald-500/40 text-emerald-200":"border-zinc-800 text-brand-textMuted"}`}>{index+1}. {label}</button>)}</div>
        {step===1?<section className="mt-7"><h2 className="text-2xl font-semibold">What are we making?</h2><div className="mt-5 grid gap-4"><label className="text-sm">Project type *<MenuSelect value={form.project_type} onChange={v=>set("project_type",v)} options={[{value:"",label:"Choose a project type"},...projectTypes.map(v=>({value:v,label:v}))]} className={`${input} flex items-center justify-between text-left`} /></label><label className="text-sm">Project name<input className={input} value={form.title} onChange={e=>set("title",e.target.value)} placeholder="Example: Delrin shift knob" maxLength={120}/></label><label className="text-sm">Describe the part and how it will be used *<textarea className={`${input} min-h-36`} value={form.description} onChange={e=>set("description",e.target.value)} placeholder="What should it do? What does it attach to? Include anything that cannot change." maxLength={5000}/></label><label className="text-sm">Quantity<input className={input} type="number" min="1" max="1000" value={form.quantity} onChange={e=>set("quantity",Math.max(1,Number(e.target.value)))}/></label></div></section>:null}
        {step===2?<section className="mt-7"><h2 className="text-2xl font-semibold">Specifications and files</h2><p className="mt-2 text-sm text-brand-textMuted">Unknown is okay—choose “open to recommendation” and we’ll help.</p><div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="text-sm">Material<MenuSelect value={form.material} onChange={v=>set("material",v)} options={materials.map(v=>({value:v,label:v}))} className={`${input} flex items-center justify-between text-left`} /></label><label className="text-sm">Overall dimensions<input className={input} value={form.dimensions} onChange={e=>set("dimensions",e.target.value)} placeholder='Example: 3.0" × 3.0" × 2.5"'/></label><label className="text-sm">Required tolerance<input className={input} value={form.tolerance} onChange={e=>set("tolerance",e.target.value)} placeholder="Example: ±0.1 mm, or advise me"/></label><label className="text-sm">Finish / appearance<input className={input} value={form.finish} onChange={e=>set("finish",e.target.value)} placeholder="Sanded, polished, anodized…"/></label><label className="text-sm">Budget range<input className={input} value={form.budget} onChange={e=>set("budget",e.target.value)} placeholder="Optional"/></label><label className="text-sm">Needed by<input className={input} type="date" value={form.target_date} onChange={e=>set("target_date",e.target.value)}/></label><label className="text-sm sm:col-span-2">CAD, drawings, photos, or references<input className={input} type="file" multiple accept=".stl,.step,.stp,.iges,.igs,.dxf,.dwg,.svg,.pdf,.png,.jpg,.jpeg,.webp,.zip" onChange={e=>setFiles(Array.from(e.target.files??[]).slice(0,10))}/><span className="mt-1 block text-xs text-brand-textMuted">Up to 10 files · 50 MB each · CAD, drawings, images, PDF, or ZIP</span>{files.length?<span className="mt-2 block text-sm text-brand-primary">{files.map(f=>f.name).join(", ")}</span>:null}</label></div></section>:null}
        {step===3?<section className="mt-7"><h2 className="text-2xl font-semibold">Delivery</h2><div className="mt-5 grid grid-cols-2 gap-3"><button type="button" onClick={()=>set("fulfillment_method","shipping")} className={`rounded-xl border p-4 text-left ${form.fulfillment_method==="shipping"?"border-brand-primary bg-brand-primary/10":"border-zinc-700"}`}><b>Ship to me</b><span className="mt-1 block text-xs text-brand-textMuted">Quoted after review</span></button><button type="button" onClick={()=>set("fulfillment_method","pickup")} className={`rounded-xl border p-4 text-left ${form.fulfillment_method==="pickup"?"border-brand-primary bg-brand-primary/10":"border-zinc-700"}`}><b>Local pickup</b><span className="mt-1 block text-xs text-brand-textMuted">Arrange after completion</span></button></div>{form.fulfillment_method==="shipping"?<div className="mt-5 grid gap-3 sm:grid-cols-2">{([['name','Recipient'],['line1','Street address'],['line2','Apartment / suite'],['city','City'],['state','State'],['postal_code','ZIP code']] as [keyof ShippingAddress,string][]).map(([key,label])=><label key={key} className={`text-sm ${key==='line1'||key==='line2'?'sm:col-span-2':''}`}>{label}<input className={input} value={form.shipping_address[key]} onChange={e=>set("shipping_address",{...form.shipping_address,[key]:e.target.value})}/></label>)}</div>:null}</section>:null}
        {step===4?<section className="mt-7"><h2 className="text-2xl font-semibold">Review your request</h2><p className="mt-2 text-sm text-brand-textMuted">Submitting is free. KeyMoura will review it and send a quote for your approval.</p><dl className="mt-5 grid gap-3 sm:grid-cols-2">{[["Project",form.title||form.project_type],["Type",form.project_type],["Quantity",String(form.quantity)],["Material",form.material||"Recommendation requested"],["Dimensions",form.dimensions||"To discuss"],["Tolerance",form.tolerance||"Standard / advise me"],["Finish",form.finish||"To discuss"],["Files",files.length?`${files.length} attached`:"None"],["Delivery",form.fulfillment_method==="shipping"?"Shipping":"Local pickup"],["Needed by",form.target_date||"Flexible"]].map(([label,value])=><div key={label} className="rounded-xl border border-zinc-800 p-3"><dt className="text-xs text-brand-textMuted">{label}</dt><dd className="mt-1 text-sm">{value}</dd></div>)}</dl><div className="mt-4 rounded-xl border border-zinc-800 p-4"><p className="text-xs text-brand-textMuted">Description</p><p className="mt-2 whitespace-pre-wrap text-sm">{form.description}</p></div></section>:null}
        {error?<p className="mt-5 rounded-xl border border-rose-400/30 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</p>:null}{saved?<p className="mt-5 text-sm text-emerald-300">{saved}</p>:null}
        <div className="mt-7 flex flex-wrap gap-3">{step>1?<button type="button" onClick={()=>setStep((step-1) as 1|2|3)} className="rounded-xl border border-zinc-700 px-5 py-2.5">Back</button>:null}<button type="button" disabled={busy} onClick={()=>void saveDraft()} className="rounded-xl border border-zinc-700 px-5 py-2.5 disabled:opacity-50">Save draft</button>{step<4?<button type="button" onClick={next} className="catalog-action-primary ml-auto rounded-xl px-6 py-2.5 font-semibold">Continue</button>:<button disabled={busy} className="catalog-action-primary ml-auto rounded-xl px-6 py-2.5 font-semibold disabled:opacity-50">{busy?"Submitting…":"Submit request — no charge"}</button>}</div>
      </form>
    </div>
  </main>;
}
