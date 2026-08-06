"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { classifySupabaseError } from "@/lib/staff/loadState";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { CatalogProduct, optionKey, ProductMedia, ProductOptionGroup } from "@/lib/commerceTypes";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { EmptyState, Notice } from "@/components/ui/DesignSystem";
import { CategorySelect } from "@/components/staff/CategorySelect";
import { visibleCategories, type CategoryRow } from "@/lib/commerce/categories";
import { allowsDirectPurchase, PURCHASE_MODE_COPY, PURCHASE_MODES, type PurchaseMode } from "@/lib/commerce/purchaseModes";
import ProductContentEditor from "@/components/staff/ProductContentEditor";
import { ProductShippingEditor } from "@/components/staff/ProductShippingEditor";
import { EMPTY_DETAIL_CONTENT, parseDetailContent, serializeDetailContent, type ProductDetailContent } from "@/lib/commerce/productContent";

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const input = "ui-input";
const primary = "ui-btn ui-btn-primary disabled:opacity-50";
const subtle = "ui-btn ui-btn-ghost text-sm disabled:opacity-50";
// The structured content is part of "has this been edited": without it the
// Save button stays disabled after adding a benefit, and the beforeunload
// guard lets the tab close on unsaved work.
const editorSnapshot = (draft: Partial<CatalogProduct>, groups: ProductOptionGroup[], content?: ProductDetailContent) => JSON.stringify({ draft, groups, content });

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
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "draft" | "published" | "archived" | "all">("active");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  /** True when this product's media or options could not be read. Gates option editing. */
  const [editorLoadFailed, setEditorLoadFailed] = useState(false);
  /** True when the product list itself could not be read. Distinguishes empty from failed. */
  const [productsFailed, setProductsFailed] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [content, setContent] = useState<ProductDetailContent>(EMPTY_DETAIL_CONTENT);

  const filteredProducts = useMemo(() => products.filter(product => {
    const term = search.trim().toLowerCase();
    const matchesSearch = !term || [product.name, product.slug, product.sku, product.category].some(value => value?.toLowerCase().includes(term));
    const matchesStatus = statusFilter === "all" ||
      (statusFilter === "active" && !product.archived_at) ||
      (statusFilter === "archived" && Boolean(product.archived_at)) ||
      (statusFilter === "published" && product.is_published && !product.archived_at) ||
      (statusFilter === "draft" && !product.is_published && !product.archived_at);
    return matchesSearch && matchesStatus;
  }), [products, search, statusFilter]);
  const imageCount = media.filter(item => item.kind === "image").length;
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      if (!product.category_id || product.archived_at) continue;
      counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
    }
    return counts;
  }, [products]);
  const publishChecks = [
    { label: "Product name", complete: Boolean(draft.name?.trim()) },
    { label: "Short description", complete: Boolean(draft.short_description?.trim()) },
    { label: "Starting price", complete: draft.starting_price_cents != null },
    { label: "Product image", complete: imageCount > 0 || Boolean(draft.image_url) },
    // `unknown` when the option list could not be read: reporting a custom
    // product as missing its choices, when the truth is that nobody could tell,
    // is a false blocker on publishing.
    { label: "Customization choices", complete: !draft.is_custom || groups.length > 0, unknown: editorLoadFailed && draft.is_custom },
    // A directly purchasable product with no fixed price silently falls back to
    // the request path, which is not what the staff member chose.
    { label: "Purchase mode", complete: !allowsDirectPurchase(draft.purchase_mode ?? "request_only") || draft.starting_price_cents != null },
  ];
  const readyToPublish = publishChecks.every(check => check.complete);

  const loadProducts = useCallback(async () => {
    const [{ data, error: queryError }, { data: categoryRows }] = await Promise.all([
      supabase.from("products").select("*").order("sort_order").order("created_at", { ascending: false }),
      supabase.from("product_categories").select("id,name,slug,description,parent_id,image_url,display_order,is_active,archived_at").order("display_order"),
    ]);
    // A refused product query clears the list rather than leaving a previous
    // load on screen as though it were current.
    setProducts((queryError ? [] : (data ?? [])) as CatalogProduct[]);
    setCategories(visibleCategories((categoryRows ?? []) as CategoryRow[]));
    setProductsFailed(Boolean(queryError));
    setError(queryError ? "The product catalog could not be loaded. No products are shown; none have been changed." : "");
  }, [supabase]);

  const loadEditor = useCallback(async (product: CatalogProduct) => {
    setDraft(product);
    const loadedContent = parseDetailContent(product.detail_content);
    setContent(loadedContent);
    const [mediaResult, optionResult] = await Promise.all([
      supabase.from("product_media").select("*").eq("product_id", product.id).order("sort_order"),
      supabase.from("product_option_groups").select("*,product_option_values(*)").eq("product_id", product.id).order("sort_order"),
    ]);
    setMedia((mediaResult.error ? [] : (mediaResult.data ?? [])) as ProductMedia[]);
    const loadedGroups = ((optionResult.error ? [] : (optionResult.data ?? [])) as ProductOptionGroup[]).map(group => ({
      ...group,
      product_option_values: [...(group.product_option_values ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    }));
    setGroups(loadedGroups);
    setSavedSnapshot(editorSnapshot(product, loadedGroups, loadedContent));
    setSaveMessage("");
    /*
     * A failed option read is reported as a failure, not as "this product has
     * no options".
     *
     * Three things went wrong when it was silently an empty list: the readiness
     * checklist marked a custom product's "Customization choices" incomplete
     * when it was not; the editor showed no option groups, inviting a staff
     * member to re-create ones that already exist; and `addGroup` takes its new
     * `sort_order` from `groups.length`, so the next group added would have
     * collided with the existing ones at position 0.
     */
    setEditorLoadFailed(Boolean(mediaResult.error || optionResult.error));
    setError(
      optionResult.error
        ? "This product's options could not be loaded. They are not shown, and adding options is disabled until the list loads — the product still has whatever options it had."
        : mediaResult.error
          ? "This product's images could not be loaded. They are not shown here, and are unchanged."
          : ""
    );
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
      is_published: false, inventory_policy: "unlimited", inventory_quantity: 0, low_stock_threshold: 2,
    }).select("*").single();
    setBusy(false);
    if (insertError) return setError(insertError.message);
    e.currentTarget.reset();
    await loadProducts();
    setSelectedId(data.id);
    await loadEditor(data as CatalogProduct);
  }

  async function saveAllChanges() {
    if (!selectedId) return;
    if (!draft.name?.trim()) return setError("Product name is required.");
    if (!slugify(draft.slug || draft.name)) return setError("Enter a valid product slug.");
    if (draft.is_published && !draft.short_description?.trim()) return setError("Add a short description before publishing.");
    setBusy(true); setError("");
    const payload = {
      name: draft.name?.trim(), slug: slugify(draft.slug || draft.name || ""),
      short_description: draft.short_description?.trim() || null,
      description: draft.description?.trim() || null,
      starting_price_cents: draft.starting_price_cents ?? null, is_custom: Boolean(draft.is_custom),
      category_id: draft.category_id ?? null,
      // The legacy free-text column is written from the structured category so
      // anything still reading `category` stays correct while it is retired.
      category: categories.find(row => row.id === draft.category_id)?.name ?? null,
      purchase_mode: draft.purchase_mode ?? "request_only",
      is_published: Boolean(draft.is_published), sort_order: Number(draft.sort_order || 0),
      availability_status: draft.availability_status || "made_to_order", lead_time_text: draft.lead_time_text?.trim() || null,
      image_url: draft.image_url || null, model_url: draft.model_url || null, model_poster_url: draft.model_poster_url || null,
      sku: draft.sku?.trim() || null, inventory_policy: draft.inventory_policy || "unlimited",
      inventory_quantity: Math.max(0, Number(draft.inventory_quantity || 0)), low_stock_threshold: Math.max(0, Number(draft.low_stock_threshold || 0)),
      continue_selling_when_out_of_stock: Boolean(draft.continue_selling_when_out_of_stock),
      // Structured product content. Additive: `description` and
      // `short_description` above are untouched by any of it.
      material: draft.material?.trim() || null,
      finish: draft.finish?.trim() || null,
      made_to_order: Boolean(draft.made_to_order),
      installation_difficulty: draft.installation_difficulty || null,
      installation_notes: draft.installation_notes?.trim() || null,
      care_instructions: draft.care_instructions?.trim() || null,
      warranty_text: draft.warranty_text?.trim() || null,
      shipping_notes: draft.shipping_notes?.trim() || null,
      return_notes: draft.return_notes?.trim() || null,
      cancellation_notes: draft.cancellation_notes?.trim() || null,
      dimensions_text: draft.dimensions_text?.trim() || null,
      package_dimensions_text: draft.package_dimensions_text?.trim() || null,
      weight_grams: draft.weight_grams == null ? null : Math.max(0, Number(draft.weight_grams)),
      /*
       * Delivery, packaging and tax, added by `20260805020000`.
       *
       * The booleans are written with `?? true` rather than `Boolean(...)`:
       * `Boolean(undefined)` is `false`, so a product loaded before these
       * columns were selected — or simply never touched — would have been
       * silently marked unshippable and uncollectable by the first save of any
       * unrelated field. Their database defaults are all true, and this
       * matches them.
       *
       * The measurements are written as null when blank. `Number("")` is 0, and
       * a 0-gram package is a real value the shipping calculator would price as
       * weightless instead of falling back to the configured default.
       */
      requires_shipping: draft.requires_shipping ?? true,
      pickup_eligible: draft.pickup_eligible ?? true,
      fulfillment_required: draft.fulfillment_required ?? true,
      is_returnable: draft.is_returnable ?? true,
      package_weight_grams: draft.package_weight_grams ?? null,
      package_length_mm: draft.package_length_mm ?? null,
      package_width_mm: draft.package_width_mm ?? null,
      package_height_mm: draft.package_height_mm ?? null,
      length_mm: draft.length_mm ?? null,
      width_mm: draft.width_mm ?? null,
      height_mm: draft.height_mm ?? null,
      tax_code: draft.tax_code?.trim() || null,
      // Serialized through the same parser the product page reads with, so the
      // editor cannot save a shape the page would then discard.
      detail_content: serializeDetailContent(content),
    };
    const productResult = await supabase.from("products").update(payload).eq("id", selectedId).select("*").single();
    if (productResult.error) { setBusy(false); return setError(productResult.error.message); }
    const optionResults = await Promise.all(groups.flatMap((group, groupIndex) => [
      supabase.from("product_option_groups").update({
        name: group.name.trim(), option_key: optionKey(group.option_key || group.name), input_type: group.input_type,
        description: group.description?.trim() || null, placeholder: group.placeholder?.trim() || null,
        is_required: group.is_required, sort_order: groupIndex,
      }).eq("id", group.id),
      ...(group.product_option_values ?? []).map((value, valueIndex) => supabase.from("product_option_values").update({
        label: value.label.trim(), value: optionKey(value.value || value.label),
        price_adjustment_cents: value.price_adjustment_cents, is_default: value.is_default,
        is_active: value.is_active, sort_order: valueIndex,
      }).eq("id", value.id)),
    ]));
    const optionError = optionResults.find(result => result.error)?.error;
    setBusy(false);
    if (optionError) return setError(optionError.message);
    await loadProducts();
    const savedProduct = productResult.data as CatalogProduct;
    const savedGroups = groups.map((group, groupIndex) => ({
      ...group,
      sort_order: groupIndex,
      product_option_values: group.product_option_values?.map((value, valueIndex) => ({ ...value, sort_order: valueIndex })),
    }));
    setDraft(savedProduct);
    setGroups(savedGroups);
    // Re-parsed from the saved row rather than from local state: a row that
    // came back with a dropped incomplete entry must leave the editor showing
    // what was actually stored, or Save stays enabled forever.
    const savedContent = parseDetailContent(savedProduct.detail_content);
    setContent(savedContent);
    setSavedSnapshot(editorSnapshot(savedProduct, savedGroups, savedContent));
    setSaveMessage("All catalog changes saved.");
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

  async function setCoverImage(item: ProductMedia) {
    if (!selectedId || item.kind !== "image") return;
    setBusy(true); setError("");
    const images = media.filter(value => value.kind === "image");
    const otherMedia = media.filter(value => value.kind !== "image");
    const ordered = [item, ...images.filter(value => value.id !== item.id), ...otherMedia];
    const results = await Promise.all(ordered.map((value, sort_order) => supabase.from("product_media").update({ sort_order }).eq("id", value.id)));
    const update = await supabase.from("products").update({ image_url: item.url }).eq("id", selectedId);
    setBusy(false);
    const failure = results.find(result => result.error)?.error ?? update.error;
    if (failure) return setError(failure.message);
    setMedia(ordered.map((value, sort_order) => ({ ...value, sort_order })));
    setDraft(current => ({ ...current, image_url: item.url }));
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
    setSelectedId(null); setDraft({}); setMedia([]); setGroups([]); setContent(EMPTY_DETAIL_CONTENT);
    await loadProducts();
  }

  async function toggleArchive() {
    if (!selectedId) return;
    const archived_at = draft.archived_at ? null : new Date().toISOString();
    const { data, error: updateError } = await supabase.from("products").update({ archived_at, ...(archived_at ? { is_published: false } : {}) }).eq("id", selectedId).select("*").single();
    if (updateError) return setError(updateError.message);
    setDraft(data as CatalogProduct);
    await loadProducts();
  }

  async function duplicateProduct() {
    if (!selectedId) return;
    setBusy(true); setError("");
    const name = `${draft.name || "Product"} copy`;
    const { data: copy, error: copyError } = await supabase.from("products").insert({
      name, slug: `${slugify(name)}-${crypto.randomUUID().slice(0, 6)}`, sku: null,
      category: draft.category || null, category_id: draft.category_id ?? null, purchase_mode: draft.purchase_mode ?? "request_only",
      short_description: draft.short_description || null, description: draft.description || null,
      starting_price_cents: draft.starting_price_cents ?? null, is_custom: Boolean(draft.is_custom), is_published: false,
      sort_order: draft.sort_order || 0, availability_status: draft.availability_status || "made_to_order", lead_time_text: draft.lead_time_text || null,
      image_url: draft.image_url || null, model_url: draft.model_url || null, model_poster_url: draft.model_poster_url || null,
      inventory_policy: draft.inventory_policy || "unlimited", inventory_quantity: draft.inventory_quantity || 0,
      low_stock_threshold: draft.low_stock_threshold || 0, continue_selling_when_out_of_stock: Boolean(draft.continue_selling_when_out_of_stock), archived_at: null,
      // Delivery and packaging travel with the copy. A duplicate that quietly
      // reverted to the shop defaults would be priced and routed differently
      // from the product it was copied from, which is the opposite of what
      // "Duplicate" means.
      made_to_order: Boolean(draft.made_to_order),
      requires_shipping: draft.requires_shipping ?? true, pickup_eligible: draft.pickup_eligible ?? true,
      fulfillment_required: draft.fulfillment_required ?? true, is_returnable: draft.is_returnable ?? true,
      package_weight_grams: draft.package_weight_grams ?? null, package_length_mm: draft.package_length_mm ?? null,
      package_width_mm: draft.package_width_mm ?? null, package_height_mm: draft.package_height_mm ?? null,
      length_mm: draft.length_mm ?? null, width_mm: draft.width_mm ?? null, height_mm: draft.height_mm ?? null,
      weight_grams: draft.weight_grams ?? null, tax_code: draft.tax_code ?? null,
      shipping_notes: draft.shipping_notes || null, return_notes: draft.return_notes || null,
      cancellation_notes: draft.cancellation_notes || null, dimensions_text: draft.dimensions_text || null,
      package_dimensions_text: draft.package_dimensions_text || null,
    }).select("*").single();
    if (copyError || !copy) { setBusy(false); return setError(copyError ? classifySupabaseError(copyError).message : "Could not duplicate product"); }
    if (media.length) await supabase.from("product_media").insert(media.map(item => ({ product_id: copy.id, kind: item.kind, url: item.url, alt_text: item.alt_text, sort_order: item.sort_order })));
    for (const group of groups) {
      const { data: newGroup, error: groupError } = await supabase.from("product_option_groups").insert({
        product_id: copy.id, name: group.name, option_key: group.option_key, input_type: group.input_type,
        description: group.description, placeholder: group.placeholder, is_required: group.is_required, sort_order: group.sort_order,
      }).select("id").single();
      if (groupError || !newGroup) continue;
      if (group.product_option_values?.length) await supabase.from("product_option_values").insert(group.product_option_values.map(value => ({
        option_group_id: newGroup.id, label: value.label, value: value.value, price_adjustment_cents: value.price_adjustment_cents,
        is_default: value.is_default, is_active: value.is_active, sort_order: value.sort_order,
      })));
    }
    setBusy(false); await loadProducts(); setSelectedId(copy.id); await loadEditor(copy as CatalogProduct);
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

  async function removeValue(groupId: string, valueId: string) {
    const { error: deleteError } = await supabase.from("product_option_values").delete().eq("id", valueId);
    if (deleteError) return setError(deleteError.message);
    setGroups(current => current.map(group => group.id === groupId ? {
      ...group, product_option_values: group.product_option_values?.filter(value => value.id !== valueId),
    } : group));
  }

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView) return <AccessDeniedCard message="You do not have access to catalog management." />;

  const hasUnsavedChanges = selectedId ? editorSnapshot(draft, groups, content) !== savedSnapshot : false;

  return (
    <main className="page-stack">
      <div><p className="ui-eyebrow">Commerce</p>
      <h1 className="mt-1 text-3xl font-semibold">Product catalog</h1>
      <p className="mt-2 text-sm text-brand-textMuted">Build products, galleries, 3D previews, and the exact choices customers can request.</p></div>

      {canManage ? <form onSubmit={createProduct} className="ui-card grid gap-3 sm:grid-cols-2">
        <input required name="name" className={input} placeholder="Product name" />
        <input name="category" className={input} placeholder="Category" />
        <input name="price" className={input} type="number" min="0" step=".01" placeholder="Starting price (optional)" />
        <input name="description" className={input} placeholder="Short description" />
        <button disabled={busy} className={`${primary} sm:col-span-2`}>Create draft product</button>
      </form> : null}

      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

      <div className="grid gap-6 xl:grid-cols-[320px_1fr]">
        <aside className="space-y-3">
          <input className={input} value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products or SKU" aria-label="Search catalog" />
          <MenuSelect ariaLabel="Filter catalog products" className="ui-select-trigger" value={statusFilter} onChange={value => setStatusFilter(value as typeof statusFilter)} options={[{value:"active",label:"Active products"},{value:"published",label:"Published"},{value:"draft",label:"Drafts"},{value:"archived",label:"Archived"},{value:"all",label:"All products"}]} />
          <div className="space-y-2">
          {filteredProducts.map(product => <button key={product.id} onClick={() => { setSelectedId(product.id); void loadEditor(product); }}
            className={`ui-card ui-card-hover w-full text-left ${selectedId === product.id ? "!border-brand-primary !bg-brand-primary/10" : ""}`}>
            <span className="flex items-center justify-between gap-2"><span className="font-semibold">{product.name}</span>{product.inventory_policy === "track" && product.inventory_quantity <= product.low_stock_threshold ? <span className="text-xs text-amber-300">{product.inventory_quantity} left</span> : null}</span>
            <span className="mt-1 block text-xs text-brand-textMuted">{product.sku ? `${product.sku} · ` : ""}/{product.slug} · {product.archived_at ? "Archived" : product.is_published ? "Published" : "Draft"}</span>
          </button>)}
          {/* "None match" is a claim about a successful query. A failed one gets
              its own sentence, because an empty catalog and an unreadable one
              look identical otherwise. */}
          {productsFailed
            ? <EmptyState>Products are not shown because the catalog could not be loaded. This is not the same as the catalog being empty.</EmptyState>
            : filteredProducts.length === 0 ? <EmptyState>No products match this view.</EmptyState> : null}
          </div>
        </aside>

        {selectedId ? <section className="space-y-6">
          <div className="ui-card sticky top-2 z-20 !border-brand-primary/30 !bg-zinc-950/95 shadow-xl backdrop-blur sm:top-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-xs uppercase tracking-[.16em] text-brand-primary">Editing</p><p className="font-semibold">{draft.name || "Untitled product"}</p></div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <span className={`text-xs ${hasUnsavedChanges ? "text-amber-200" : "text-brand-textMuted"}`} aria-live="polite">{busy ? "Saving all changes…" : hasUnsavedChanges ? "Unsaved changes" : saveMessage || "Everything saved"}</span>
                {draft.slug ? <Link href={`/catalog/${draft.slug}`} target="_blank" className={subtle}>{draft.is_published ? "View live" : "Preview URL"} ↗</Link> : null}
                <button disabled={!canManage || busy || !hasUnsavedChanges} onClick={() => void saveAllChanges()} className={`${primary} ml-auto sm:ml-0`}>{busy ? "Saving…" : "Save changes"}</button>
              </div>
            </div>
          </div>

          <div className="ui-card">
            <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-xl font-semibold">Publish checklist</h2><p className="mt-1 text-sm text-brand-textMuted">Finish these essentials before making the product visible to customers.</p></div><span className={`rounded-full px-3 py-1 text-xs font-medium ${readyToPublish ? "bg-emerald-500/15 text-emerald-200" : "bg-amber-400/10 text-amber-200"}`}>{publishChecks.filter(check => check.complete).length}/{publishChecks.length} ready</span></div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{publishChecks.map(check => <div key={check.label} className={`rounded-xl border px-3 py-2 text-sm ${check.unknown ? "border-amber-500/40 text-amber-200" : check.complete ? "border-emerald-500/30 text-emerald-200" : "border-zinc-700 text-brand-textMuted"}`}><span aria-hidden="true">{check.unknown ? "?" : check.complete ? "✓" : "○"}</span> {check.label}{check.unknown ? " — could not be checked" : ""}</div>)}</div>
          </div>
          <div className="ui-card">
            <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">Product details</h2><div className="flex items-center gap-3"><span className={draft.archived_at ? "text-sm text-amber-300" : draft.is_published ? "text-sm text-emerald-300" : "text-sm text-brand-textMuted"}>{draft.archived_at ? "Archived" : draft.is_published ? "Published" : "Draft"}</span>{draft.slug && draft.is_published && !draft.archived_at ? <Link href={`/catalog/${draft.slug}`} target="_blank" className={subtle}>View live ↗</Link> : null}</div></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Name<input className={`${input} mt-1`} value={draft.name ?? ""} onChange={e => setDraft(current => ({ ...current, name: e.target.value }))} /></label>
              <label className="text-sm">Slug<input className={`${input} mt-1`} value={draft.slug ?? ""} onChange={e => setDraft(current => ({ ...current, slug: e.target.value }))} /></label>
              <CategorySelect value={draft.category_id ?? null} onChange={categoryId => setDraft(current => ({ ...current, category_id: categoryId }))} categories={categories} productCounts={categoryCounts} disabled={!canManage} />
              <label className="text-sm">SKU<input className={`${input} mt-1`} value={draft.sku ?? ""} onChange={e => setDraft(current => ({ ...current, sku: e.target.value }))} placeholder="Example: KM-SHIFT-001" /></label>
              <label className="text-sm">Starting price ($)<input className={`${input} mt-1`} type="number" min="0" step=".01" value={draft.starting_price_cents == null ? "" : draft.starting_price_cents / 100} onChange={e => setDraft(current => ({ ...current, starting_price_cents: e.target.value ? Math.round(Number(e.target.value) * 100) : null }))} /></label>
              <label className="text-sm">Availability<MenuSelect className="ui-select-trigger mt-1" value={draft.availability_status ?? "made_to_order"} onChange={value => setDraft(current => ({ ...current, availability_status: value as CatalogProduct["availability_status"] }))} options={[{value:"available",label:"Available"},{value:"limited",label:"Limited availability"},{value:"made_to_order",label:"Made to order"},{value:"unavailable",label:"Currently unavailable"}]} /></label>
              <label className="text-sm">Lead time<input className={`${input} mt-1`} value={draft.lead_time_text ?? ""} onChange={e => setDraft(current => ({ ...current, lead_time_text: e.target.value }))} placeholder="Example: Usually 1–2 weeks" /></label>
              <label className="text-sm sm:col-span-2">Short description<input className={`${input} mt-1`} value={draft.short_description ?? ""} onChange={e => setDraft(current => ({ ...current, short_description: e.target.value }))} /></label>
              <label className="text-sm sm:col-span-2">Full description<textarea className={`${input} mt-1 min-h-32`} value={draft.description ?? ""} onChange={e => setDraft(current => ({ ...current, description: e.target.value }))} /></label>
              <label className="text-sm sm:col-span-2">How customers buy this
                <MenuSelect className="ui-select-trigger mt-1" value={draft.purchase_mode ?? "request_only"} onChange={value => setDraft(current => ({ ...current, purchase_mode: value as PurchaseMode }))} options={PURCHASE_MODES.map(mode => ({ value: mode, label: PURCHASE_MODE_COPY[mode].staffLabel }))} />
                <span className="mt-1 block text-xs text-brand-textMuted">{PURCHASE_MODE_COPY[draft.purchase_mode ?? "request_only"].help}</span>
                {allowsDirectPurchase(draft.purchase_mode ?? "request_only") && draft.starting_price_cents == null ? <span className="mt-1 block text-xs text-amber-200">A directly purchasable product needs a starting price, or customers will be sent to a request instead.</span> : null}
              </label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={Boolean(draft.is_custom)} onChange={e => setDraft(current => ({ ...current, is_custom: e.target.checked }))} /> Customer can customize this product</label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={Boolean(draft.archived_at) || (!draft.is_published && !readyToPublish)} checked={Boolean(draft.is_published)} onChange={e => setDraft(current => ({ ...current, is_published: e.target.checked }))} /> Published in catalog</label>
            </div>
            {!readyToPublish && !draft.is_published ? <p className="mt-3 text-xs text-amber-200">Complete the publish checklist to enable publishing. You can save the draft at any time.</p> : null}
            <div className="ui-action-row mt-4"><button disabled={!canManage || busy} onClick={() => void duplicateProduct()} className={subtle}>Duplicate</button><button disabled={!canManage || busy} onClick={() => void toggleArchive()} className={subtle}>{draft.archived_at ? "Restore" : "Archive"}</button><button disabled={!canManage || busy} onClick={() => void deleteProduct()} className="ui-btn ui-btn-danger">Delete permanently</button></div>
          </div>

          <div className="ui-card">
            <h2 className="text-xl font-semibold">Product page content</h2>
            <p className="mt-1 text-sm text-brand-textMuted">
              The structured sections on the customer-facing product page. All optional — a section
              with nothing in it is hidden rather than shown empty, so a sparse product simply gets a
              shorter page.
            </p>
            <div className="mt-5">
              <ProductContentEditor
                draft={draft}
                onChange={patch => setDraft(current => ({ ...current, ...patch }))}
                content={content}
                onContentChange={setContent}
                disabled={!canManage}
              />
            </div>
          </div>

          <div className="ui-card">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-semibold">Inventory</h2>
                <p className="mt-1 text-sm text-brand-textMuted">Use made-to-order for custom work, or track a real quantity for ready-to-ship items.</p>
              </div>
              {/* Setting a quantity here is a *definition*; moving stock is an
                  event with a reason and a ledger entry. They are different
                  actions, so the editor points at the surface that records the
                  second rather than pretending this field is it. */}
              {selectedId && permissions.has("inventory.view") ? <Link href={`/staff/inventory/${selectedId}`} className={subtle}>Stock, holds & history →</Link> : null}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <label className="text-sm">Inventory mode<MenuSelect className="ui-select-trigger mt-1" value={draft.inventory_policy ?? "unlimited"} onChange={value => setDraft(current => ({ ...current, inventory_policy: value as CatalogProduct["inventory_policy"] }))} options={[{value:"unlimited",label:"Made to order / unlimited"},{value:"track",label:"Track quantity"}]} /></label>
              <label className="text-sm">Quantity<input disabled={draft.inventory_policy !== "track"} className={`${input} mt-1 disabled:opacity-50`} type="number" min="0" value={draft.inventory_quantity ?? 0} onChange={e => setDraft(current => ({ ...current, inventory_quantity: Number(e.target.value) }))} /></label>
              <label className="text-sm">Low-stock warning<input disabled={draft.inventory_policy !== "track"} className={`${input} mt-1 disabled:opacity-50`} type="number" min="0" value={draft.low_stock_threshold ?? 2} onChange={e => setDraft(current => ({ ...current, low_stock_threshold: Number(e.target.value) }))} /></label>
              {draft.inventory_policy === "track" ? <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={Boolean(draft.continue_selling_when_out_of_stock)} onChange={e => setDraft(current => ({ ...current, continue_selling_when_out_of_stock: e.target.checked }))} /> Keep accepting requests when quantity reaches zero</label> : null}
              <label className="flex items-center gap-2 text-sm sm:col-span-3"><input type="checkbox" checked={Boolean(draft.made_to_order)} onChange={e => setDraft(current => ({ ...current, made_to_order: e.target.checked }))} /> Made to order — never reserved at checkout, and never raises a low-stock alert</label>
            </div>
          </div>

          <div className="ui-card">
            <h2 className="text-xl font-semibold">Delivery, packaging &amp; returns</h2>
            <p className="mt-1 text-sm text-brand-textMuted">
              These decide which delivery methods a cart may offer and what a parcel is priced as. They have been
              live since the shipping system shipped; this is the first surface that lets you set them.
            </p>
            <div className="mt-5">
              <ProductShippingEditor
                draft={draft}
                onChange={patch => setDraft(current => ({ ...current, ...patch }))}
                disabled={!canManage}
              />
            </div>
          </div>

          <div className="ui-card">
            <h2 className="text-xl font-semibold">Images & 3D model</h2>
            <p className="mt-1 text-sm text-brand-textMuted">Upload multiple images and one GLB/GLTF model. The first image becomes the catalog cover.</p>
            <div className="mt-4 flex flex-wrap gap-3">
              <label className={`${subtle} cursor-pointer`}>Upload images<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/avif" className="hidden" onChange={e => { for (const file of Array.from(e.target.files ?? [])) void uploadAsset(file, "image"); e.target.value = ""; }} /></label>
              <label className={`${subtle} cursor-pointer`}>Upload 3D model<input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void uploadAsset(file, "model"); e.target.value = ""; }} /></label>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              {media.map(item => <div key={item.id} className={`overflow-hidden rounded-xl border ${item.kind === "image" && draft.image_url === item.url ? "border-brand-primary" : "border-zinc-800"}`}>
                {item.kind === "image" ? <Image src={item.url} alt={item.alt_text || ""} width={500} height={320} className="h-32 w-full object-cover" unoptimized /> : <div className="flex h-32 items-center justify-center bg-zinc-950 text-sm text-brand-primary">3D MODEL</div>}
                <div className="flex items-center justify-between gap-2 p-2 text-xs"><span>{item.kind === "image" && draft.image_url === item.url ? "Cover image" : item.kind === "image" ? "Gallery image" : "Interactive model"}</span><span className="flex gap-2">{item.kind === "image" && draft.image_url !== item.url ? <button onClick={() => void setCoverImage(item)} className="text-brand-primary">Set cover</button> : null}<button onClick={() => void moveMedia(media.indexOf(item), -1)} aria-label="Move asset earlier">↑</button><button onClick={() => void moveMedia(media.indexOf(item), 1)} aria-label="Move asset later">↓</button><button onClick={() => void deleteMedia(item)} className="text-rose-300">Remove</button></span></div>
              </div>)}
            </div>
          </div>

          <div className="ui-card">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-xl font-semibold">Customization options</h2><p className="mt-1 text-sm text-brand-textMuted">These fields appear on this product’s request form.</p></div>{/* Disabled after a failed read: `addGroup` derives the new sort_order from
                `groups.length`, so adding one to a list that failed to load would
                collide with the options the product actually has. */}
              <button disabled={!canManage || !draft.is_custom || editorLoadFailed} title={editorLoadFailed ? "The existing options could not be loaded, so a new one cannot be positioned safely." : undefined} onClick={() => void addGroup()} className={subtle}>Add option</button></div>
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
                <div className="mt-3 flex flex-wrap gap-2"><button onClick={() => void moveGroup(groupIndex, -1)} className={subtle} aria-label="Move option up">Move up</button><button onClick={() => void moveGroup(groupIndex, 1)} className={subtle} aria-label="Move option down">Move down</button><button onClick={() => void removeGroup(group.id)} className={`${subtle} text-rose-300`}>Delete option</button>{["select", "radio"].includes(group.input_type) ? <button onClick={() => void addValue(group)} className={subtle}>Add choice</button> : null}</div>
                {["select", "radio"].includes(group.input_type) ? <div className="mt-4 space-y-2">
                  {(group.product_option_values ?? []).map((value, valueIndex) => <div key={value.id} className="grid gap-2 rounded-xl bg-zinc-950/70 p-3 sm:grid-cols-[1fr_1fr_130px_auto]">
                    <input className={input} value={value.label} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, label: e.target.value, value: optionKey(e.target.value) } : choice) }))} placeholder="Choice label" />
                    <input className={input} value={value.value} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, value: optionKey(e.target.value) } : choice) }))} placeholder="Saved value" />
                    <label className="text-xs text-brand-textMuted">Price change ($)<input className={`${input} mt-1`} type="number" step=".01" value={value.price_adjustment_cents / 100} onChange={e => setGroups(current => current.map(item => item.id !== group.id ? item : { ...item, product_option_values: item.product_option_values?.map(choice => choice.id === value.id ? { ...choice, price_adjustment_cents: Math.round(Number(e.target.value) * 100), sort_order: valueIndex } : choice) }))} /></label>
                    <div className="flex items-center justify-end gap-2"><button onClick={() => void removeValue(group.id, value.id)} className={`${subtle} text-rose-300`} aria-label={`Remove ${value.label || "choice"}`}>Remove</button></div>
                  </div>)}
                </div> : null}
              </div>)}
            </div>
          </div>
        </section> : <EmptyState>Select a product to edit everything customers see.</EmptyState>}
      </div>
    </main>
  );
}
