import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Design & Tolerance Guide", description: "Prepare dimensions, tolerances, and design files for a KeyMoura CNC quote." };

export default function DesignGuidePage() {
  return <main className="mx-auto max-w-5xl px-4 py-12 sm:py-16"><p className="text-xs font-semibold uppercase tracking-[.22em] text-brand-primary">Project guide</p><h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">Send the details that actually affect the part.</h1><p className="mt-6 max-w-3xl text-lg leading-8 text-brand-textMuted">Good quoting starts with intended use and critical dimensions. Do not add tight tolerances everywhere “just in case”—they can increase setup, inspection time, and cost without improving the result.</p>
    <div className="mt-12 space-y-5">{[
      ["Dimensions and tolerances", "Identify the dimensions that must fit another part and give a usable range when possible. General dimensions will be quoted to a realistic process tolerance; any exact tolerance is confirmed in writing before payment."],
      ["Measurement references", "Show where each measurement begins and ends. Include hole centers, material thickness, mating-part dimensions, and a known scale in reference photos."],
      ["File preparation", "STEP or other solid CAD is best for 3D geometry; DXF or SVG works well for clean 2D profiles; dimensioned PDF drawings are useful for intent and inspection. ZIP related files together when helpful."],
      ["Corners, pockets, and undercuts", "Inside corners made with round tools retain a radius. Deep narrow pockets, hidden features, and undercuts may need a design change or special setup."],
      ["Finish and appearance", "Describe which faces are visible and whether tool marks are acceptable. Sanding, edge finishing, coating, engraving, and cosmetic expectations should be included in the request."],
    ].map(([title, body]) => <section key={title} className="rounded-2xl border border-zinc-800 bg-black/30 p-6"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-3 leading-7 text-brand-textMuted">{body}</p></section>)}</div>
    <section className="mt-8 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-6"><h2 className="text-lg font-semibold text-amber-200">Important</h2><p className="mt-2 text-sm leading-6 text-brand-textMuted">KeyMoura does not infer suitability for medical, life-safety, structural, pressure-containing, or regulated use. Tell us about any safety-critical application before requesting work.</p></section>
    <div className="mt-8 flex flex-wrap gap-3"><Link href="/orders/new" className="catalog-action-primary rounded-full px-5 py-2.5 font-semibold">Start a request</Link><Link href="/support" className="catalog-action-secondary rounded-full px-5 py-2.5 font-medium">Ask a question</Link></div>
  </main>;
}
