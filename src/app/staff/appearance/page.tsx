"use client";

import { useEffect, useMemo, useState } from "react";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { defaultSiteTheme, type SiteTheme } from "@/theme/runtime";

type Appearance = { primaryColor: string; accentColor: string; theme: SiteTheme };
const defaults: Appearance = { primaryColor: "#fbbf24", accentColor: "#f59e0b", theme: defaultSiteTheme };
const presets: Record<string, Appearance> = {
  KeyMoura: defaults,
  Ember: { primaryColor: "#fb923c", accentColor: "#facc15", theme: { ...defaultSiteTheme, background: "#110c08", backgroundEnd: "#070504", surface: "#21140d", surfaceStrong: "#2b1a10" } },
  Graphite: { primaryColor: "#e4e4e7", accentColor: "#fbbf24", theme: { ...defaultSiteTheme, background: "#09090b", backgroundEnd: "#030303", surface: "#18181b", surfaceStrong: "#27272a" } },
};

function luminance(hex: string) {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
}
function contrast(a: string, b: string) { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + .05) / (lo + .05); }

export default function AppearancePage() {
  const [form, setForm] = useState<Appearance>(defaults);
  const [state, setState] = useState("Loading appearance…");
  useEffect(() => { fetch("/api/staff/appearance").then(async r => ({ ok: r.ok, body: await r.json() })).then(({ok, body}) => { if (!ok) throw new Error(body.error); setForm(body); setState(""); }).catch(e => setState(e.message || "Could not load appearance.")); }, []);
  const warning = useMemo(() => contrast(form.theme.text, form.theme.background) < 4.5 ? "Body text needs more contrast against the background." : contrast(form.primaryColor, form.theme.background) < 3 ? "Primary actions may be hard to see against the background." : "", [form]);
  const vars = { "--brand-primary": form.primaryColor, "--brand-accent": form.accentColor, "--km-bg": form.theme.background, "--km-bg-end": form.theme.backgroundEnd, "--km-surface": form.theme.surface, "--km-surface-strong": form.theme.surfaceStrong, "--km-text": form.theme.text, "--km-muted": form.theme.mutedText, "--km-border": form.theme.border } as React.CSSProperties;
  const setTheme = <K extends keyof SiteTheme>(key: K, value: SiteTheme[K]) => setForm(v => ({ ...v, theme: { ...v.theme, [key]: value } }));
  async function save() { setState("Saving…"); const r = await fetch("/api/staff/appearance", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(form) }); const body = await r.json(); setState(r.ok ? "Saved. Refreshing the site theme…" : body.error || "Could not save."); if (r.ok) setTimeout(() => location.reload(), 500); }
  return <main className="page-stack" style={vars} data-radius={form.theme.radius} data-density={form.theme.density} data-font={form.theme.font} data-button-style={form.theme.buttonStyle}>
    <header><p className="text-xs uppercase tracking-[.2em] text-brand-primary">Site design</p><h1 className="mt-1 text-3xl font-semibold">Appearance</h1><p className="mt-2 text-sm text-brand-textMuted">Customize the shared KeyMoura look without editing code.</p></header>
    {state ? <div className="ui-card text-sm">{state}</div> : null}{warning ? <div className="rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm text-amber-200">{warning}</div> : null}
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,.8fr)]"><section className="ui-card space-y-5">
      <div><label className="ui-label">Preset</label><MenuSelect value="custom" onChange={v => { if (v !== "custom") setForm(presets[v]); }} options={[{value:"custom",label:"Custom"}, ...Object.keys(presets).map(value => ({value,label:value}))]} className="ui-select-trigger" /></div>
      <div className="grid gap-4 sm:grid-cols-2">{([['primaryColor','Primary'],['accentColor','Accent']] as const).map(([key,label]) => <ColorField key={key} label={label} value={form[key]} onChange={value => setForm(v => ({...v,[key]:value}))} />)}{([['background','Background'],['backgroundEnd','Background end'],['surface','Card surface'],['surfaceStrong','Raised surface'],['text','Main text'],['mutedText','Muted text'],['border','Borders']] as const).map(([key,label]) => <ColorField key={key} label={label} value={form.theme[key]} onChange={value => setTheme(key,value)} />)}</div>
      <div className="grid gap-4 sm:grid-cols-2"><Choice label="Corner shape" value={form.theme.radius} values={['soft','rounded','pill']} onChange={v=>setTheme('radius',v as SiteTheme['radius'])}/><Choice label="Spacing" value={form.theme.density} values={['compact','comfortable']} onChange={v=>setTheme('density',v as SiteTheme['density'])}/><Choice label="Typography" value={form.theme.font} values={['system','modern','technical']} onChange={v=>setTheme('font',v as SiteTheme['font'])}/><Choice label="Primary buttons" value={form.theme.buttonStyle} values={['solid','soft','outline']} onChange={v=>setTheme('buttonStyle',v as SiteTheme['buttonStyle'])}/></div>
      <div className="flex flex-wrap gap-3"><button onClick={save} disabled={Boolean(warning)} className="ui-btn ui-btn-primary">Save appearance</button><button onClick={()=>setForm(defaults)} className="ui-btn ui-btn-ghost">Reset to KeyMoura</button></div>
    </section><section className="ui-preview ui-card h-fit space-y-4"><p className="ui-eyebrow">Live preview</p><h2 className="text-2xl font-semibold">Made by KeyMoura</h2><p className="text-sm text-brand-textMuted">Buttons, fields, cards, badges, and dropdowns share these settings across public and staff pages.</p><input className="ui-input" placeholder="Customer notes"/><MenuSelect value="walnut" onChange={()=>{}} options={[{value:'walnut',label:'Walnut'},{value:'maple',label:'Maple'}]} className="ui-select-trigger"/><div className="flex flex-wrap gap-2"><span className="ui-chip-static">Customizable</span><button className="ui-btn ui-btn-primary">Request item</button><button className="ui-btn ui-btn-ghost">Learn more</button></div></section></div>
  </main>;
}
function ColorField({label,value,onChange}:{label:string;value:string;onChange:(v:string)=>void}) { return <label className="block"><span className="ui-label">{label}</span><span className="flex gap-2"><input type="color" value={value} onChange={e=>onChange(e.target.value)} className="h-11 w-14 rounded-lg border border-zinc-700 bg-transparent p-1"/><input value={value} onChange={e=>onChange(e.target.value)} className="ui-input font-mono uppercase" maxLength={7}/></span></label>; }
function Choice({label,value,values,onChange}:{label:string;value:string;values:string[];onChange:(v:string)=>void}) { return <div><label className="ui-label">{label}</label><MenuSelect value={value} onChange={onChange} options={values.map(v=>({value:v,label:v[0].toUpperCase()+v.slice(1)}))} className="ui-select-trigger"/></div>; }
