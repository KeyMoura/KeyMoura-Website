"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { CatalogProduct, optionKey, ProductMedia, ProductOptionGroup } from "@/lib/commerceTypes";
import { MenuSelect } from "@/components/ui/MenuSelect";

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const input = "w-full rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 outline-none focus:border-brand-primary";
const primary = "rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50";
const subtle = "rounded-xl border border-zinc-700 px-3 py-2 text-sm transition hover:border-brand-primary disabled:opacity-50";

export default function StaffCatalogPage() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("catalog.view") || permissions.has("catalog.manage");
  const canManage = permissions.has("catalog.manage");
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [media, setMedia] = useState<ProductMedia[]>([]);
  const [groups, setGroups] = useState<ProductOptionGroup[]>([]);
  const [draft, setDraft] = useState<Partial<CatalogProduct>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadProducts = useCallback(async () => {
    const { data, error: queryError } = await supabase.from("products").select("*").order("sort_order").order("created_at", { ascending: false });
    setProducts((data ?? []) as CatalogProduct[]);
    setError(queryError?.message ?? "");
  }, [supabase]);

  const loadEditor = useCallback(async (product: CatalogProduct) => {
    setDraft(product);
    const [mediaResult, optionResult] = await Promise.all([
      supabase.from("product_media").select("*").eq("product_id", product.id).order("sort_order"),
      supabase.from("product_option_groups").select("*,product_option_values(*)").eq("product_id", product.id).order("sort_order"),
    ]);
    setMedia((mediaResult.data ?? []) as ProductMedia[]);
    setGroups(((optionResult.data ?? []) as ProductOptionGroup[]).map(group => ({
      ...group,
      product_option_values: [...(group.product_option_values ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    })));
    setError(mediaResult.error?.message ?? optionResult.error?.message ?? "");
  }, [supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void loadProducts(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, loadProducts]);

  async function createProduct(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    setBusy(true); setError("");
    const { data, error: insertError } = await supabase.from("products").insert({
      name, slug: slugify(name), category: String(form.get("category") ?? "").trim() || null,
      short_description: String(form.get("description") ?? "").trim() || null,
      description: String(form.get("description") ?? "").trim() || null,
      starting_price_cents: form.get("price") ? Math.round(Number(form.get("price")) * 100) : null,
      is_published: false,
    }).select("*").single();
    setBusy(false);
    if (insertError) return setError(insertError.message);
    e.currentTarget.reset();
    await loadProducts();
    setSelectedId(data.id);
    await loadEditor(data as CatalogProduct);
  }

  async function saveProduct() {
    if (!selectedId) return;
    setBusy(true); setError("");
    const payload = {
      name: draft.name?.trim(), slug: slugify(draft.slug || draft.name || ""),
      category: draft.category?.trim() || null, short_description: draft.short_description?.trim() || null,
      description: draft.description?.trim() || null,
      starting_price_cents: draft.starting_price_cents ?? null, is_custom: Boolean(draft.is_custom),
      is_published: Boolean(draft.is_published), sort_order: Number(draft.sort_order || 0),
      availability_status: draft.availability_status || "made_to_order", lead_time_text: draft.lead_time_text?.trim() || null,
      image_url: draft.image_url || null, model_url: draft.model_url || null, model_poster_url: draft.model_poster_url || null,
    };
    const { data, error: updateError } = await supabase.from("products").update(payload).eq("id", selectedId).select("*").single();
    setBusy(false);
    if (updateError) return setError(updateError.message);
    await loadProducts();
    setDraft(data as CatalogProduct);
  }

  async function uploadAsset(file: File, kind: "image" | "model") {
    if (!selectedId) return;
    setBusy(true); setError("");
    const extension = file.name.split(".").pop()?.toLowerCase() || (kind === "model" ? "glb" : "jpg");
    const path = `${selectedId}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from("product-assets").upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (uploadError) { setBusy(false); return setError(uploadError.message); }
    const { data: publicUrl } = supabase.storage.from("product-assets").getPublicUrl(path);
    const url = publicUrl.publicUrl;
    const { error: insertError } = await supabase.from("product_media").insert({
      product_id: selectedId, kind, url, alt_text: kind === "image" ? draft.name || "Product image" : null,
      sort_order: media.length,
    });
    if (!insertError && kind === "image" && !draft.image_url) {
      await supabase.from("products").update({ image_url: url }).eq("id", selectedId);
      setDraft(current => ({ ...current, image_url: url }));
    }
    if (!insertError && kind === "model") {
      await supabase.from("products").update({ model_url: url }).eq("id", selectedId);
      setDraft(current => ({ ...current, model_url: url }));
    }
    setBusy(false);
    if (insertError) return setError(insertError.message);
    await loadEditor({ ...draft, id: selectedId } as CatalogProduct);
  }

  async function deleteMedia(item: ProductMedia) {
    if (!confirm("Remove this asset from the product?")) return;
    const { error: deleteError } = await supabase.from("product_media").delete().eq("id", item.id);
    if (deleteError) return setError(deleteError.message);
    const next = media.filter(value => value.id !== item.id);
    const patch: Record<string, string | null> = {};
    if (draft.image_url === item.url) patch.image_url = next.find(value => value.kind === "image")?.url ?? null;
    if (draft.model_url === item.url) patch.model_url = null;
    if (Object.keys(patch).length) {
      await supabase.from("products").update(patch).eq("id", selectedId);
      setDraft(current => ({ ...current, ...patch }));
    }
    setMedia(next);
  }

  async function moveMedia(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= media.length) return;
    const next = [...media];
    [next[index], next[target]] = [next[target], next[index]];
    setMedia(next);
    await Promise.all(next.map((item, sort_order) => supabase.from("product_media").update({ sort_order }).eq("id", item.id)));
    const firstImage = next.find(item => item.kind === "image")?.url ?? null;
    await supabase.from("products").update({ image_url: firstImage }).eq("id", selectedId);
    setDraft(current => ({ ...current, image_url: firstImage }));
  }

  async function addGroup() {
    if (!selectedId) return;
    const position = groups.length;
    const { data, error: insertError } = await supabase.from("product_option_groups").insert({
      product_id: selectedId, name: `Option ${position + 1}`, option_key: `option_${position + 1}`,
      input_type: "select", sort_order: position,
    }).select("*,product_option_values(*)").single();
    if (insertError) return setError(insertError.message);
    setGroups(current => [...current, data as ProductOptionGroup]);
  }

  async function saveGroup(group: ProductOptionGroup) {
    const { error: updateError } = await supabase.from("product_option_groups").update({
      name: group.name.trim(), option_key: optionKey(group.option_key || group.name), input_type: group.input_type,
      description: group.description?.trim() || null, placeholder: group.placeholder?.trim() || null,
      is_required: group.is_required, sort_order: group.sort_order,
    }).eq("id", group.id);
    if (updateError) setError(updateError.message);
  }

  async function removeGroup(id: string) {
    if (!confirm("Delete this option and all of its choices?")) return;
    const { error: deleteError } = await supabase.from("product_option_groups").delete().eq("id", id);
    if (deleteError) return setError(deleteError.message);
    setGroups(current => current.filter(group => group.id !== id));
  }

  async function moveGroup(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= groups.length) return;
    const next = [...groups];
    [next[index], next[target]] = [next[target], next[index]];
    const ordered = next.map((group, sort_order) => ({ ...group, sort_order }));
    setGroups(ordered);
    await Promise.all(ordered.map(group => supabase.from("product_option_groups").update({ sort_order: group.sort_order }).eq("id", group.id)));
  }

  async function deleteProduct() {
    if (!selectedId || !confirm(`Permanently delete ${draft.name} and its configured options? Existing orders keep their saved request details.`)) return;
    const { error: deleteError } = await supabase.from("products").delete().eq("id", selectedId);
    if (deleteError) return setError(deleteError.message);
    setSelectedId(null); setDraft({}); setMedia([]); setGroups([]);
    await loadProducts();
  }

  async function addValue(group: ProductOptionGroup) {
    const position = group.product_option_values?.length ?? 0;
    const label = `Choice ${position + 1}`;
    const { data, error: insertError } = await supabase.from("product_option_values").insert({
      option_group_id: group.id, label, value: optionKey(label), sort_order: position,
    }).select().single();
    if (insertError) return setError(insertError.message);
    setGroups(current => current.map(item => item.id === group.id ? { ...item, product_option_values: [...(item.product_option_values ?? []), data] } : item));
  }

  async function saveValue(groupId: string, valueId: string) {
    const value = groups.find(group => group.id === groupId)?.product_option_values?.find(item => item.id === valueId);
    if (!value) return;
    const { error: updateError } = await supabase.from("product_option_values").update({
      label: value.label.trim(), value: optionKey(value.value || value.label), price_adjustment_cents: value.price_adjustment_cents,
      is_default: value.is_default, is_active: value.is_active, sort_order: value.sort_order,
    }).eq("id", value.id);
    if (updateError) setError(updateError.message);
  }

  async function removeValue(groupId: string, valueId: string) {
    const { error: deleteError } = await supabase.from("product_option_values").delete().eq("id", valueId);
    if (deleteError) return setError(deleteError.message);
    setGroups(current => current.map(group => group.id === groupId ? {
      ...group, product_option_values: group.product_option_values?.filter(value => value.id !== valueId),
    } : group));
  }

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to catalog management." />;

  return (
    <main>
      <p className="text-xs uppercase tracking-[.2em] text-brand-primary">Commerce</p>
      <h1 className="mt-1 text-3xl font-semibold">Product catalog</h1>
      <p className="mt-2 text-sm text-brand-textMuted">Build products, galleries, 3D previews, and the exact choices customers can request.</p>

      {canManage ? <form onSubmit={createProduct} className="mt-6 grid gap-3 rounded-2xl border border-zinc-800 bg-black/30 p-5 sm:grid-cols-2">
        <input required name="name" className={input} placeholder="Product name" />
        <input name="category" className={input} placeholder="Category" />
        <input name="price" className={input} type="number" min="0" step=".01" placeholder="Starting price (optional)" />
        <input name="description" className={input} placeholder="Short description" />
        <button disabled={busy} className={`${primary} sm:col-span-2`}>Create draft product</button>
      </form> : null}

      {error ? <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">{error}</p> : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[320px_1fr]">
        <aside className="space-y-2">
          {products.map(product => <button key={product.id} onClick={() => { setSelectedId(product.id); void loadEditor(product); }}
            className={`w-full rounded-xl border p-4 text-left ${selectedId === product.id ? "border-brand-primary bg-brand-primary/10" : "border-zinc-800 bg-black/30 hover:border-zinc-600"}`}>
            <span className="font-semibold">{product.name}</span>
            <span className="mt-1 block text-xs text-brand-textMuted">/{product.slug} · {product.is_published ? "Published" : "Draft"}</span>
          </button>)}
        </aside>

        {selectedId ? <section className="space-y-6">
          <div className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
            <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">Product details</h2><span className={draft.is_published ? "text-sm text-emerald-300" : "text-sm text-brand-textMuted"}>{draft.is_published ? "Published" : "Draft"}</span></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Name<input className={`${input} mt-1`} value={draft.name ?? ""} onChange={e => setDraft(current => ({ ...current, name: e.target.value }))} /></label>
              <label className="text-sm">Slug<input className={`${input} mt-1`} value={draft.slug ?? ""} onChange={e => setDraft(current => ({ ...current, slug: e.target.value }))} /></label>
              <label className="text-sm">Category<input className={`${input} mt-1`} value={draft.category ?? ""} onChange={e => setDraft(current => ({ ...current, category: e.target.value }))} /></label>
              <label className="text-sm">Starting price ($)<input className={`${input} mt-1`} type="number" min="0" step=".01" value={draft.starting_price_cents == null ? "" : draft.starting_price_cents / 100} onChange={e => setDraft(current => ({ ...current, starting_price_cents: e.target.value ? Math.round(Number(e.target.value) * 100) : null }))} /></label>
              <label className="text-sm">Availability<MenuSelect className="ui-select-trigger mt-1" value={draft.availability_status ?? "made_to_order"} onChange={value => setDraft(current => ({ ...current, availability_status: value as CatalogProduct["availability_status"] }))} options={[{value:"available",label:"Available"},{value:"limited",label:"Limited availability"},{value:"made_to_order",label:"Made to order"},{value:"unavailable",label:"Currently unavailable"}]} /></label>
              <label className="text-sm">Lead time<input className={`${input} mt-1`} value={draft.lead_time_text ?? ""} onChange={e => setDraft(current => ({ ...current, lead_time_text: e.target.value }))} placeholder="Example: Usually 1–2 weeks" /></label>
              <label className="text-sm sm:col-span-2">Short description<input className={`${input} mt-1`} value={draft.short_description ?? ""} onChange={e => setDraft(current => ({ ...current, short_description: e.target.value }))} /></label>
              <label className="text-sm sm:col-span-2">Full description<textarea className={`${input} mt-1 min-h-32`} value={draft.description ?? ""} onChange={e => setDraft(current => ({ ...current, description: e.target.value }))} /></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(draft.is_custom)} onChange={e => setDraft(current => ({ ...current, is_custom: e.target.checked }))} /> Customer can customize this product</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(draft.is_published)} onChange={e => setDraft(current => ({ ...current, is_published: e.target.checked }))} /> Published in catalog</label>
            </div>
            <div className="mt-4 flex gap-3"><button disabled={!canManage || busy} onClick={() => void saveProduct()} className={primary}>Save product</button><button disabled={!canManage || busy} onClick={() => void deleteProduct()} className={`${subtle} text-rose-300`}>Delete product</button></div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
            <h2 className="text-xl font-semibold">Images & 3D model</h2>
            <p className="mt-1 text-sm text-brand-textMuted">Upload multiple images and one GLB/GLTF model. The first image becomes the catalog cover.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <label className={`${subtle} cursor-pointer`}>Upload images<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/avif" className="hidden" onChange={e => { for (const file of Array.from(e.target.files ?? [])) void uploadAsset(file, "image"); e.target.value = ""; }} /></label>
              <label className={`${subtle} cursor-pointer`}>Upload 3D model<input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void uploadAsset(file, "model"); e.target.value = ""; }} /></label>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {media.map(item => <div key={item.id} className="overflow-hidden rounded-xl border border-zinc-800">
                {item.kind === "image" ? <Image src={item.url} alt={item.alt_text || ""} width={500} height={320} className="h-32 w-full object-cover" unoptimized /> : <div className="flex h-32 items-center justify-center bg-zinc-950 text-sm text-brand-primary">3D MODEL</div>}
                <div className="flex items-center justify-between gap-2 p-2 text-xs"><span>{item.kind === "image" ? "Image" : "Interactive model"}</span><span className="flex gap-2"><button onClick={() => void moveMedia(media.indexOf(item), -1)} aria-label="Move asset earlier">↑</button><button onClick={() => void moveMedia(media.indexOf(item), 1)} aria-label="Move asset later">↓</button><button onClick={() => void deleteMedia(item)} className="text-rose-300">Remove</button></span></div>
              </div>)}
            </div>
          </div>

          <div className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Customization options</h2><p className="mt-1 text-sm text-brand-textMuted">These fields appear on this product’s request form.</p></div><button disabled={!canManage || !draft.is_custom} onClick={() => void addGroup()} className={subtle}>Add option</button></div>
            {!draft.is_custom ? <p className="mt-4 rounded-xl border border-zinc-800 p-4 text-sm text-brand-textMuted">Customization is disabled. Enable it in Product details to show configured options.</p> : null}
            <div className="mt-4 space-y-4">
              {groups.map((group, groupIndex) => <div key={group.id} className="rounded-xl border border-zinc-800 p-4">
                <div className="grid gap-3 md:grid-cols-4">
                  <input className={input} value={group.name} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, name: e.target.value, option_key: optionKey(e.target.value) } : item))} placeholder="Option name" />
                  <input className={input} value={group.option_key} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, option_key: optionKey(e.target.value) } : item))} placeholder="Saved key" />
                  <MenuSelect className="ui-select-trigger" value={group.input_type} onChange={value => setGroups(current => current.map(item => item.id === group.id ? { ...item, input_type: value as ProductOptionGroup["input_type"] } : item))} options={[{value:"select",label:"Dropdown"},{value:"radio",label:"Choice cards"},{value:"text",label:"Short text"},{value:"textarea",label:"Long text"},{value:"number",label:"Number"},{value:"checkbox",label:"Checkbox"},{value:"file",label:"Reference file"}]} />
                  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={group.is_required} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, is_required: e.target.checked } : item))} /> Required</label>
                  <input className={`${input} md:col-span-2`} value={group.description ?? ""} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, description: e.target.value } : item))} placeholder="Help text (optional)" />
                  <input className={`${input} md:col-span-2`} value={group.placeholder ?? ""} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, placeholder: e.target.value } : item))} placeholder="Placeholder (optional)" />
                </div>
                <div className="mt-3 flex flex-wrap gap-2"><button onClick={() => void saveGroup({ ...group, sort_order: groupIndex })} className={subtle}>Save option</button><button onClick={() => void moveGroup(groupIndex, -1)} className={subtle} aria-label="Move option up">Move up</button><button onClick={() => void moveGroup(groupIndex, 1)} className={subtle} aria-label="Move option down">Move down</button><button onClick={() => void removeGroup(group.id)} className={`${subtle} text-rose-300`}>Delete option</button>{["select", "radio"].includes(group.input_type) ? <button onClick={() => void addValue(group)} className={subtle}>Add choice</button> : null}</div>
                {["select", "radio"].includes(group.input_type) ? <div className="mt-4 space-y-2">
                  {(group.product_option_values ?? []).map((value, valueIndex) => <div key={value.id} className="grid gap-2 rounded-xl bg-zinc-950/70 p-3 sm:grid-cols-[1fr_1fr_130px_auto]">
                    <input className={input} value={value.label} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, label: e.target.value, value: optionKey(e.target.value) } : choice) }))} placeholder="Choice label" />
                    <input className={input} value={value.value} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, value: optionKey(e.target.value) } : choice) }))} placeholder="Saved value" />
                    <label className="text-xs text-brand-textMuted">Price change ($)<input className={`${input} mt-1`} type="number" step=".01" value={value.price_adjustment_cents / 100} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, price_adjustment_cents: Math.round(Number(e.target.value) * 100), sort_order: valueIndex } : choice) }))} /></label>
                    <div className="flex items-center gap-2"><button onClick={() => void saveValue(group.id, value.id)} className={subtle}>Save</button><button onClick={() => void removeValue(group.id, value.id)} className="text-sm text-rose-300">×</button></div>
                  </div>)}
                </div> : null}
              </div>)}
            </div>
          </div>
        </section> : <div className="rounded-2xl border border-dashed border-zinc-700 p-10 text-center text-brand-textMuted">Select a product to edit everything customers see.</div>}
      </div>
    </main>
  );
}
