"use client";

import { useEffect, useMemo, useState } from "react";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { defaultSiteTheme, type SiteTheme } from "@/theme/runtime";

type Identity = {
  name: string; shortName: string; tagline: string; description: string; publicUrl: string;
  logoUrl: string; wordmarkUrl: string; footerLogoUrl: string; faviconUrl: string; appleIconUrl: string;
  supportEmail: string; copyrightText: string; forumLabel: string; knowledgeBaseLabel: string; trustedVendorLabel: string;
};
type Appearance = { primaryColor: string; accentColor: string; theme: SiteTheme; identity: Identity };
type Section = "brand" | "assets" | "wording" | "theme";

const defaultIdentity: Identity = { name:"KeyMoura",shortName:"KeyMoura",tagline:"Built around your idea.",description:"Custom parts, products, and made-to-order projects.",publicUrl:"https://keymoura.com",logoUrl:"/brand/keymoura-colored.png",wordmarkUrl:"",footerLogoUrl:"/brand/keymoura-colored.png",faviconUrl:"/favicon.ico",appleIconUrl:"/apple-icon.png",supportEmail:"support@keymoura.com",copyrightText:"All rights reserved.",forumLabel:"Community",knowledgeBaseLabel:"Knowledge Base",trustedVendorLabel:"Trusted Shop" };
const defaults: Appearance = { primaryColor:"#fbbf24",accentColor:"#f59e0b",theme:defaultSiteTheme,identity:defaultIdentity };
const presets: Record<string, Pick<Appearance,"primaryColor"|"accentColor"|"theme">> = {
  KeyMoura: defaults,
  Ember:{primaryColor:"#fb923c",accentColor:"#facc15",theme:{...defaultSiteTheme,background:"#110c08",backgroundEnd:"#070504",surface:"#21140d",surfaceStrong:"#2b1a10"}},
  Graphite:{primaryColor:"#e4e4e7",accentColor:"#fbbf24",theme:{...defaultSiteTheme,background:"#09090b",backgroundEnd:"#030303",surface:"#18181b",surfaceStrong:"#27272a"}},
};
const sectionCopy: Record<Section, { label: string; description: string }> = {
  brand: { label: "Brand & business", description: "Business name, public details, metadata, and support information." },
  assets: { label: "Logos & icons", description: "Header, footer, browser, and mobile brand artwork." },
  wording: { label: "Labels & wording", description: "Names customers see for the major areas of the site." },
  theme: { label: "Colors & controls", description: "The shared visual system used by public, account, and staff pages." },
};

function luminance(hex:string){const values=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*values[0]+.7152*values[1]+.0722*values[2];}
function contrast(a:string,b:string){const[hi,lo]=[luminance(a),luminance(b)].sort((x,y)=>y-x);return(hi+.05)/(lo+.05);}

export default function AppearancePage(){
  const [form,setForm]=useState<Appearance>(defaults);
  const [saved,setSaved]=useState<Appearance>(defaults);
  const [section,setSection]=useState<Section>("brand");
  const [state,setState]=useState("Loading appearance…");
  useEffect(()=>{fetch("/api/staff/appearance").then(async r=>({ok:r.ok,body:await r.json()})).then(({ok,body})=>{if(!ok)throw new Error(body.error);const loaded={...defaults,...body,identity:{...defaultIdentity,...body.identity}};setForm(loaded);setSaved(loaded);setState("");}).catch(e=>setState(e.message||"Could not load appearance."));},[]);
  const dirty=JSON.stringify(form)!==JSON.stringify(saved);
  const warning=useMemo(()=>{
    if(contrast(form.theme.text,form.theme.background)<4.5)return "Body text needs more contrast against the background.";
    if(contrast(form.theme.headingText,form.theme.background)<4.5)return "Heading text needs more contrast against the background.";
    if(contrast(form.theme.mutedText,form.theme.background)<3)return "Muted text needs more contrast against the background.";
    if(form.theme.primaryButtonStyle==="solid"&&contrast(form.theme.primaryButtonText,form.primaryColor)<4.5)return "Primary button text needs more contrast against the primary color.";
    if(form.theme.secondaryButtonStyle==="solid"&&contrast(form.theme.secondaryButtonText,form.accentColor)<4.5)return "Secondary button text needs more contrast against the accent color.";
    return "";
  },[form]);
  const vars={"--brand-primary":form.primaryColor,"--brand-accent":form.accentColor,"--km-bg":form.theme.background,"--km-bg-end":form.theme.backgroundEnd,"--km-surface":form.theme.surface,"--km-surface-strong":form.theme.surfaceStrong,"--km-text":form.theme.text,"--km-muted":form.theme.mutedText,"--km-heading":form.theme.headingText,"--km-link":form.theme.linkText,"--km-border":form.theme.border,"--km-primary-button-text":form.theme.primaryButtonText,"--km-secondary-button-text":form.theme.secondaryButtonText} as React.CSSProperties;
  const setTheme=<K extends keyof SiteTheme>(key:K,value:SiteTheme[K])=>setForm(v=>({...v,theme:{...v.theme,[key]:value}}));
  const setIdentity=(key:keyof Identity,value:string)=>setForm(v=>({...v,identity:{...v.identity,[key]:value}}));
  const resetSection=()=>setForm(current=>section==="theme"?{...current,primaryColor:saved.primaryColor,accentColor:saved.accentColor,theme:saved.theme}:{...current,identity:{...current.identity,...Object.fromEntries(section==="brand"?["name","shortName","tagline","description","publicUrl","supportEmail","copyrightText"].map(key=>[key,saved.identity[key as keyof Identity]]):section==="assets"?["logoUrl","wordmarkUrl","footerLogoUrl","faviconUrl","appleIconUrl"].map(key=>[key,saved.identity[key as keyof Identity]]):["forumLabel","knowledgeBaseLabel","trustedVendorLabel"].map(key=>[key,saved.identity[key as keyof Identity]]))}});
  async function save(){setState("Publishing appearance…");const r=await fetch("/api/staff/appearance",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify(form)});const body=await r.json();if(r.ok){setSaved(form);setState("Appearance published.");}else setState(body.error||"Could not save.");}
  return <main className="page-stack pb-24" style={vars} data-theme-scope="true" data-radius={form.theme.radius} data-density={form.theme.density} data-font={form.theme.font} data-primary-button-style={form.theme.primaryButtonStyle} data-secondary-button-style={form.theme.secondaryButtonStyle}>
    <header><p className="ui-eyebrow">Site design & identity</p><h1 className="mt-1 text-3xl font-semibold">Appearance</h1><p className="mt-2 max-w-3xl text-sm text-brand-textMuted">All shared customer-facing brand settings live here. Work through one section at a time, preview it, then publish everything together.</p></header>
    {state?<div className="ui-card text-sm" role="status">{state}</div>:null}{warning?<div className="ui-notice ui-notice-warning">{warning}</div>:null}
    <div className="grid gap-5 xl:grid-cols-[230px_minmax(0,1fr)_minmax(300px,.62fr)]">
      <nav className="ui-card h-fit space-y-2" aria-label="Appearance sections">{(Object.keys(sectionCopy) as Section[]).map(key=><button key={key} type="button" onClick={()=>setSection(key)} className={`w-full rounded-xl border px-3 py-3 text-left transition ${section===key?"border-brand-accent bg-brand-accent/10":"border-transparent hover:border-brand-border hover:bg-black/20"}`}><span className={section===key?"font-semibold text-brand-accent":"font-medium"}>{sectionCopy[key].label}</span><span className="mt-1 block text-xs leading-5 text-brand-textMuted">{sectionCopy[key].description}</span></button>)}</nav>
      <div className="space-y-5">
        <section className="ui-card space-y-5"><SectionTitle title={sectionCopy[section].label} text={sectionCopy[section].description}/>
          {section==="brand"?<div className="grid gap-4 sm:grid-cols-2"><TextField label="Site name" value={form.identity.name} onChange={v=>setIdentity("name",v)}/><TextField label="Short name" value={form.identity.shortName} onChange={v=>setIdentity("shortName",v)}/><TextField label="Tagline" value={form.identity.tagline} onChange={v=>setIdentity("tagline",v)} wide/><TextField label="SEO / site description" value={form.identity.description} onChange={v=>setIdentity("description",v)} wide/><TextField label="Public site URL" value={form.identity.publicUrl} onChange={v=>setIdentity("publicUrl",v)}/><TextField label="Support email" value={form.identity.supportEmail} onChange={v=>setIdentity("supportEmail",v)}/><TextField label="Copyright text" value={form.identity.copyrightText} onChange={v=>setIdentity("copyrightText",v)} wide/></div>:null}
          {section==="assets"?<div className="grid gap-4 sm:grid-cols-2"><TextField label="Header logo" value={form.identity.logoUrl} onChange={v=>setIdentity("logoUrl",v)}/><TextField label="Wordmark (optional)" value={form.identity.wordmarkUrl} onChange={v=>setIdentity("wordmarkUrl",v)}/><TextField label="Footer logo" value={form.identity.footerLogoUrl} onChange={v=>setIdentity("footerLogoUrl",v)}/><TextField label="Browser favicon" value={form.identity.faviconUrl} onChange={v=>setIdentity("faviconUrl",v)}/><TextField label="Apple / mobile icon" value={form.identity.appleIconUrl} onChange={v=>setIdentity("appleIconUrl",v)}/></div>:null}
          {section==="wording"?<div className="grid gap-4 sm:grid-cols-2"><TextField label="Community label" value={form.identity.forumLabel} onChange={v=>setIdentity("forumLabel",v)}/><TextField label="Knowledge base label" value={form.identity.knowledgeBaseLabel} onChange={v=>setIdentity("knowledgeBaseLabel",v)}/><TextField label="Trusted vendor label" value={form.identity.trustedVendorLabel} onChange={v=>setIdentity("trustedVendorLabel",v)}/></div>:null}
          {section==="theme"?<><div><label className="ui-label">Starting preset</label><MenuSelect value="custom" onChange={v=>{if(v!=="custom")setForm(current=>({...current,...presets[v]}));}} options={[{value:"custom",label:"Custom"},...Object.keys(presets).map(value=>({value,label:value}))]} className="ui-select-trigger"/></div><div className="grid gap-4 sm:grid-cols-2">{([["primaryColor","Primary actions"],["accentColor","Accent / selected states"]] as const).map(([key,label])=><ColorField key={key} label={label} value={form[key]} onChange={value=>setForm(v=>({...v,[key]:value}))}/>)}{([["background","Page background"],["backgroundEnd","Background gradient end"],["surface","Cards and panels"],["surfaceStrong","Inputs and raised panels"],["text","Body text"],["headingText","Headings"],["mutedText","Muted text"],["linkText","Links"],["border","Borders"],["primaryButtonText","Primary button text"],["secondaryButtonText","Secondary button text"]] as const).map(([key,label])=><ColorField key={key} label={label} value={form.theme[key]} onChange={value=>setTheme(key,value)}/>)}</div><div className="grid gap-4 sm:grid-cols-2"><Choice label="Corner shape" value={form.theme.radius} values={["soft","rounded","pill"]} onChange={v=>setTheme("radius",v as SiteTheme["radius"])}/><Choice label="Spacing" value={form.theme.density} values={["compact","comfortable"]} onChange={v=>setTheme("density",v as SiteTheme["density"])}/><Choice label="Typography" value={form.theme.font} values={["system","modern","technical"]} onChange={v=>setTheme("font",v as SiteTheme["font"])}/><Choice label="Primary buttons" value={form.theme.primaryButtonStyle} values={["solid","soft","outline"]} onChange={v=>setTheme("primaryButtonStyle",v as SiteTheme["primaryButtonStyle"])}/><Choice label="Secondary buttons" value={form.theme.secondaryButtonStyle} values={["solid","soft","outline","ghost"]} onChange={v=>setTheme("secondaryButtonStyle",v as SiteTheme["secondaryButtonStyle"])}/></div></>:null}
        </section>
        <button type="button" onClick={resetSection} className="ui-btn ui-btn-ghost">Reset this section</button>
      </div>
      <section className="ui-preview ui-card sticky top-5 h-fit space-y-4"><p className="ui-eyebrow">Live preview</p><div className="flex items-center gap-3">{form.identity.logoUrl?<img src={form.identity.logoUrl} alt="" className="h-12 w-12 object-contain"/>:null}<div><h2 className="text-2xl font-semibold">{form.identity.shortName||form.identity.name}</h2><p className="text-sm text-brand-textMuted">{form.identity.tagline}</p></div></div><p className="text-sm text-brand-textMuted">{form.identity.description} <a href="#" onClick={event=>event.preventDefault()}>Preview link</a></p><div className="rounded-xl border border-brand-border bg-black/20 p-4"><p className="font-semibold">Example product</p><p className="mt-1 text-xs text-brand-textMuted">Shared cards, labels, borders, and actions update here immediately.</p></div><input className="ui-input" placeholder="Customer notes"/><div className="flex flex-wrap gap-2"><span className="ui-chip-static">Customizable</span><button className="ui-btn ui-btn-primary">Primary action</button><button className="ui-btn ui-btn-secondary">Secondary action</button></div></section>
    </div>
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-border bg-black/90 px-4 py-3 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between gap-4"><p className="text-sm text-brand-textMuted">{dirty?"You have unpublished appearance changes.":"Appearance is up to date."}</p><div className="flex gap-2"><button type="button" onClick={()=>setForm(saved)} disabled={!dirty} className="ui-btn ui-btn-ghost">Discard changes</button><button type="button" onClick={()=>void save()} disabled={!dirty||Boolean(warning)} className="ui-btn ui-btn-primary">Publish appearance</button></div></div></div>
  </main>;
}
function SectionTitle({title,text}:{title:string;text:string}){return <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-brand-textMuted">{text}</p></div>}
function TextField({label,value,onChange,wide=false}:{label:string;value:string;onChange:(v:string)=>void;wide?:boolean}){return <label className={wide?"block sm:col-span-2":"block"}><span className="ui-label">{label}</span><input value={value} onChange={e=>onChange(e.target.value)} className="ui-input"/></label>}
function ColorField({label,value,onChange}:{label:string;value:string;onChange:(v:string)=>void}){return <label className="block"><span className="ui-label">{label}</span><span className="flex gap-2"><input type="color" value={value} onChange={e=>onChange(e.target.value)} className="ui-color-input"/><input value={value} onChange={e=>onChange(e.target.value)} className="ui-input font-mono uppercase" maxLength={7}/></span></label>}
function Choice({label,value,values,onChange}:{label:string;value:string;values:string[];onChange:(v:string)=>void}){return <div><label className="ui-label">{label}</label><MenuSelect value={value} onChange={onChange} options={values.map(v=>({value:v,label:v[0].toUpperCase()+v.slice(1)}))} className="ui-select-trigger"/></div>}
