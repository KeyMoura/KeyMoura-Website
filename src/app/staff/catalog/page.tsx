"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { useHashTab } from "@/lib/hooks/useHashTab";
import { classifySupabaseError } from "@/lib/staff/loadState";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { CatalogProduct, optionKey, ProductMedia, ProductOptionGroup } from "@/lib/commerceTypes";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { Badge, Field, Notice } from "@/components/ui/DesignSystem";
import {
  Card,
  CheckField,
  EmptyState,
  Fact,
  Facts,
  FormGrid,
  FormWide,
  LoadingState,
  PageHeader,
  PageTabs,
  SaveBar,
  Section,
  StaffPage,
  TabPanel,
} from "@/components/staff/StaffPage";
import type { StaffTab } from "@/lib/staff/pageFramework";
import { CategorySelect } from "@/components/staff/CategorySelect";
import { type CategoryRow } from "@/lib/commerce/categories";
import { allowsDirectPurchase, PURCHASE_MODE_COPY, PURCHASE_MODES, type PurchaseMode } from "@/lib/commerce/purchaseModes";
import ProductContentEditor from "@/components/staff/ProductContentEditor";
import { ProductOptionValueRow } from "@/components/staff/ProductOptionValueRow";
import { ProductOptionPreview } from "@/components/staff/ProductOptionPreview";
import { choicePresentation, presentationPatch, type ChoicePresentation } from "@/lib/commerce/optionPresentation";
import { ProductShippingEditor } from "@/components/staff/ProductShippingEditor";
import { EMPTY_DETAIL_CONTENT, parseDetailContent, serializeDetailContent, type ProductDetailContent } from "@/lib/commerce/productContent";
import {
  filterAndSortStaffProducts,
  staffProductStatus,
  staffStockState,
  type StaffProductSort,
  type StaffProductStatus,
  type StaffStockFilter,
} from "@/lib/commerce/staffCatalog";

/**
 * The product editor.
 *
 * ## What this replaced
 *
 * A create-product form pinned above everything, then a product list, then the
 * editor as **seven stacked cards** — a sticky save bar, a publish checklist, a
 * "Product details" card holding fourteen unrelated fields, a product-content
 * card, an inventory card, a delivery card, a media card and an options card.
 * Editing a SKU and editing package dimensions were the same scroll. The
 * checklist that told you what was missing was at the top; six of the seven
 * things it named were somewhere below it.
 *
 * ## The shape now
 *
 * Nine tabs, each holding one kind of decision: **Basic, Media, Pricing,
 * Purchase, Inventory, Shipping, Content, SEO, Advanced**. The publish
 * checklist moved into the record header, where it belongs — it is a statement
 * about the product, not a section of it — and each unfinished item names the
 * tab that fixes it.
 *
 * ## One save
 *
 * There is exactly one Save, in the standard save bar, and it writes the
 * product row and every option in one act. Two things still write immediately
 * and say so: uploading a file, and adding or removing an option *group*, both
 * of which create or destroy a row in another table and cannot be staged
 * meaningfully in a draft.
 */

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const input = "ui-input";
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
  const [statusFilter, setStatusFilter] = useState<StaffProductStatus>("all");
  const [stockFilter, setStockFilter] = useState<StaffStockFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [customizableOnly, setCustomizableOnly] = useState(false);
  const [productSort, setProductSort] = useState<StaffProductSort>("newest");
  const [savedSnapshot, setSavedSnapshot] = useState("");
  /** True when this product's media or options could not be read. Gates option editing. */
  const [editorLoadFailed, setEditorLoadFailed] = useState(false);
  /** True when the product list itself could not be read. Distinguishes empty from failed. */
  const [productsFailed, setProductsFailed] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [categories, setCategories] = useState<CategoryRow[]>([]);
  const [content, setContent] = useState<ProductDetailContent>(EMPTY_DETAIL_CONTENT);
  /** The create form is an action, not a permanent fixture at the top of the page. */
  const [creating, setCreating] = useState(false);
  /**
   * The new product's category.
   *
   * Held in state rather than read from `FormData` on submit, because the
   * picker is a listbox — there is no form control carrying the value, and a
   * hidden input mirroring it would be a second source of truth for the one
   * field this pass exists to stop being guessable.
   */
  const [newCategoryId, setNewCategoryId] = useState<string | null>(null);

  const tabs = useMemo<StaffTab[]>(
    () => [
      { id: "basic", label: "Basic" },
      { id: "media", label: "Media", count: media.length || null },
      { id: "pricing", label: "Pricing" },
      { id: "purchase", label: "Purchase" },
      { id: "inventory", label: "Inventory" },
      { id: "shipping", label: "Shipping" },
      { id: "content", label: "Content" },
      { id: "seo", label: "SEO" },
      { id: "advanced", label: "Advanced" },
    ],
    [media.length]
  );
  const [tab, setTab] = useHashTab(tabs);

  const filteredProducts = useMemo(() => filterAndSortStaffProducts(products, categories, {
    query: search, status: statusFilter, stock: stockFilter, categoryId: categoryFilter, customizableOnly, sort: productSort,
  }), [products, categories, search, statusFilter, stockFilter, categoryFilter, customizableOnly, productSort]);
  const imageCount = media.filter(item => item.kind === "image").length;
  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const product of products) {
      if (!product.category_id || product.archived_at) continue;
      counts.set(product.category_id, (counts.get(product.category_id) ?? 0) + 1);
    }
    return counts;
  }, [products]);
  /*
   * The publish checklist, each item naming the tab that fixes it.
   *
   * It was a five-across grid of pills at the top of a seven-card page: it told
   * you "Product image" was missing and left you to find where images are set.
   */
  const publishChecks: { label: string; complete: boolean; tab: string; unknown?: boolean }[] = [
    { label: "Product name", complete: Boolean(draft.name?.trim()), tab: "basic" },
    { label: "Short description", complete: Boolean(draft.short_description?.trim()), tab: "basic" },
    { label: "Starting price", complete: draft.starting_price_cents != null, tab: "pricing" },
    { label: "Product image", complete: imageCount > 0 || Boolean(draft.image_url), tab: "media" },
    // `unknown` when the option list could not be read: reporting a custom
    // product as missing its choices, when the truth is that nobody could tell,
    // is a false blocker on publishing.
    {
      label: "Customization choices",
      complete: !draft.is_custom || groups.length > 0,
      unknown: editorLoadFailed && draft.is_custom,
      tab: "purchase",
    },
    // A directly purchasable product with no fixed price silently falls back to
    // the request path, which is not what the staff member chose.
    {
      label: "Purchase mode",
      complete: !allowsDirectPurchase(draft.purchase_mode ?? "request_only") || draft.starting_price_cents != null,
      tab: "purchase",
    },
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
    /*
     * Every category row, archived ones included.
     *
     * This used to store `visibleCategories(...)`, and two things read it: the
     * picker, and the line that derives the legacy `category` text column from
     * the chosen id. For a product filed under a category that was archived
     * later, both went wrong quietly — the picker showed "Uncategorized", and
     * the next save of any unrelated field wrote `category: null` because the
     * lookup missed. `CategorySelect` now does its own filtering and only
     * *offers* the usable ones, so the full list is what belongs here.
     */
    setCategories((categoryRows ?? []) as CategoryRow[]);
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
      name, slug: slugify(name),
      /*
       * Both columns, from one choice.
       *
       * `category_id` is the real relationship — a foreign key the database
       * refuses to break, which is what makes an arbitrary category string
       * impossible now rather than merely discouraged. `category` is the legacy
       * free-text column that some readers still use; it is *derived* from the
       * selected row's name, exactly as the editor's save does, so the two can
       * never disagree while the text column is being retired.
       */
      category_id: newCategoryId,
      category: categories.find(row => row.id === newCategoryId)?.name ?? null,
      short_description: String(form.get("description") ?? "").trim() || null,
      description: String(form.get("description") ?? "").trim() || null,
      starting_price_cents: form.get("price") ? Math.round(Number(form.get("price")) * 100) : null,
      is_published: false, inventory_policy: "unlimited", inventory_quantity: 0, low_stock_threshold: 2,
    }).select("*").single();
    setBusy(false);
    if (insertError) return setError(insertError.message);
    e.currentTarget.reset();
    setNewCategoryId(null);
    setCreating(false);
    await loadProducts();
    setSelectedId(data.id);
    setTab("basic");
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
        display_style: group.display_style === "swatches" ? "swatches" : "buttons",
      }).eq("id", group.id),
      ...(group.product_option_values ?? []).map((value, valueIndex) => supabase.from("product_option_values").update({
        label: value.label.trim(), value: optionKey(value.value || value.label),
        /*
         * `Math.trunc`, and a floor of "a real number".
         *
         * The field is dollars and the column is integer cents; an empty box
         * gives `Number("") === 0`, but a half-typed "1.2e" gives NaN, and
         * PostgREST would send that as `null` into a NOT NULL column. Coercing
         * here means a mistyped keystroke cannot fail the whole save.
         */
        price_adjustment_cents: Number.isFinite(value.price_adjustment_cents)
          ? Math.trunc(value.price_adjustment_cents)
          : 0,
        is_default: value.is_default,
        is_active: value.is_active,
        // Both new this pass, and both previously uneditable anywhere.
        requires_request: Boolean(value.requires_request),
        media_id: value.media_id ?? null,
        sort_order: valueIndex,
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
    const usedBy = groups.flatMap(group =>
      (group.product_option_values ?? []).filter(value => value.media_id === item.id)
    );
    // Named, before the deletion, because afterwards the link is gone and there
    // is nothing left to say which choices used to show this photograph.
    const warning = usedBy.length
      ? `\n\nIt is the associated image for ${usedBy.length} option choice${usedBy.length === 1 ? "" : "s"} (${usedBy
          .map(value => value.label)
          .join(", ")}). ${usedBy.length === 1 ? "That choice" : "Those choices"} will stay on sale but stop switching the gallery.`
      : "";
    if (!confirm(`Remove this asset from the product?${warning}`)) return;
    const { error: deleteError } = await supabase.from("product_media").delete().eq("id", item.id);
    if (deleteError) return setError(deleteError.message);
    /*
     * Mirror the foreign key's `ON DELETE SET NULL` into local state.
     *
     * The database has already nulled these. Leaving the editor holding the old
     * id would make the next Save write it straight back — into a column whose
     * target no longer exists, which the FK would refuse and which would fail
     * the whole save with an error about a row nobody had touched.
     */
    if (usedBy.length) {
      setGroups(current => current.map(group => ({
        ...group,
        product_option_values: group.product_option_values?.map(value =>
          value.media_id === item.id ? { ...value, media_id: null } : value
        ),
      })));
    }
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
    /*
     * Media is copied as new rows, so the copy's images have their own ids.
     *
     * Those ids are captured here because the option values below have to point
     * at *the copy's* photograph, not the original's. Keeping the source id
     * would attach one product's image to another product's colour — which the
     * database now refuses outright, so a duplicate carrying swatches would have
     * failed the insert and silently lost its choices.
     */
    const copiedMediaId = new Map<string, string>();
    if (media.length) {
      const { data: copiedMedia } = await supabase
        .from("product_media")
        .insert(media.map(item => ({ product_id: copy.id, kind: item.kind, url: item.url, alt_text: item.alt_text, sort_order: item.sort_order })))
        .select("id,url,sort_order,kind");
      // Matched on the pair that is unique within a product's gallery. The rows
      // come back in insertion order in practice, but relying on that would be
      // relying on something PostgREST does not promise.
      for (const source of media) {
        const match = (copiedMedia ?? []).find(
          item => item.url === source.url && item.sort_order === source.sort_order && item.kind === source.kind
        );
        if (match) copiedMediaId.set(source.id, match.id);
      }
    }
    for (const group of groups) {
      const { data: newGroup, error: groupError } = await supabase.from("product_option_groups").insert({
        product_id: copy.id, name: group.name, option_key: group.option_key, input_type: group.input_type,
        description: group.description, placeholder: group.placeholder, is_required: group.is_required, sort_order: group.sort_order,
        display_style: group.display_style === "swatches" ? "swatches" : "buttons",
      }).select("id").single();
      if (groupError || !newGroup) continue;
      if (group.product_option_values?.length) await supabase.from("product_option_values").insert(group.product_option_values.map(value => ({
        option_group_id: newGroup.id, label: value.label, value: value.value, price_adjustment_cents: value.price_adjustment_cents,
        is_default: value.is_default, is_active: value.is_active, requires_request: Boolean(value.requires_request),
        // Re-pointed at the copy's own image, or dropped if that image could not
        // be matched. A wrong link is worse than no link.
        media_id: value.media_id ? copiedMediaId.get(value.media_id) ?? null : null,
        sort_order: value.sort_order,
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

  function moveValue(groupId: string, valueIndex: number, direction: -1 | 1) {
    setGroups(current => current.map(group => {
      if (group.id !== groupId) return group;
      const values = [...(group.product_option_values ?? [])];
      const destination = valueIndex + direction;
      if (destination < 0 || destination >= values.length) return group;
      [values[valueIndex], values[destination]] = [values[destination], values[valueIndex]];
      return { ...group, product_option_values: values };
    }));
  }

  if (isLoading) return <LoadingState>Loading products…</LoadingState>;
  if (!canView) return <AccessDeniedCard message="You do not have access to catalog management." />;

  const hasUnsavedChanges = selectedId ? editorSnapshot(draft, groups, content) !== savedSnapshot : false;
  const patch = (next: Partial<CatalogProduct>) => setDraft(current => ({ ...current, ...next }));
  /*
   * The purchase mode, narrowed to one this build knows.
   *
   * `PURCHASE_MODE_COPY[mode].help` throws on anything else, which white-screens
   * the whole editor rather than one field. A CHECK constraint means the column
   * cannot hold a surprise *today* — but this is precisely the page a row
   * written by an older build would be opened on, and the failure mode is
   * losing the editor rather than losing one label. Found by driving the
   * rebuilt editor in a browser.
   */
  const purchaseMode: PurchaseMode = PURCHASE_MODES.includes(draft.purchase_mode as PurchaseMode)
    ? (draft.purchase_mode as PurchaseMode)
    : "request_only";

  return (
    <StaffPage>
      <PageHeader
        title="Catalog"
        description="Manage products, category structure, merchandising order, and inventory health from one workspace."
        actions={
          canManage ? (
            <button
              type="button"
              onClick={() => setCreating(open => !open)}
              aria-expanded={creating}
              className="ui-btn ui-btn-primary text-sm"
            >
              New product
            </button>
          ) : null
        }
      />

      <nav aria-label="Catalog workspace" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Link href="/staff/catalog" aria-current="page" className="ui-card p-4 transition hover:border-brand-primary">
          <strong className="block">Products</strong>
          <span className="mt-1 block text-sm text-[var(--muted)]">{products.length} catalog records</span>
        </Link>
        <Link href="/staff/catalog/categories" className="ui-card p-4 transition hover:border-brand-primary">
          <strong className="block">Categories</strong>
          <span className="mt-1 block text-sm text-[var(--muted)]">{categories.filter(category => !category.archived_at).length} active records and hierarchy</span>
        </Link>
        <Link href="/staff/inventory" className="ui-card p-4 transition hover:border-brand-primary">
          <strong className="block">Inventory</strong>
          <span className="mt-1 block text-sm text-[var(--muted)]">Stock, reservations, and adjustments</span>
        </Link>
        <Link href="/staff/catalog/discounts" className="ui-card p-4 transition hover:border-brand-primary">
          <strong className="block">Merchandising</strong>
          <span className="mt-1 block text-sm text-[var(--muted)]">Manual order and discount controls</span>
        </Link>
      </nav>

      {/* The create form is behind the page action rather than pinned above the
          catalog. It was the first thing on the page every time, so opening
          Products to check a price began with four empty fields. */}
      {creating && canManage ? (
        <Section title="New product" description="Creates a draft. Everything else is set in the editor.">
          <Card>
            <form onSubmit={createProduct}>
              <FormGrid>
                <Field label="Product name" required>
                  <input required name="name" className={`${input} w-full`} />
                </Field>
                {/* The same picker the editor uses, over the same rows.
                    This was a free-text box writing the legacy `category`
                    string, so a new product could be filed under "Interor" and
                    then belong to no real category at all — the structured
                    `category_id` stayed null until somebody opened the editor
                    and set it again. */}
                <CategorySelect
                  value={newCategoryId}
                  onChange={setNewCategoryId}
                  categories={categories}
                  productCounts={categoryCounts}
                  help={<Link href="/staff/catalog/categories" className="underline hover:no-underline">Manage categories →</Link>}
                />
                <Field label="Starting price ($)">
                  <input name="price" className={`${input} w-full`} type="number" min="0" step=".01" />
                </Field>
                <Field label="Short description">
                  <input name="description" className={`${input} w-full`} />
                </Field>
              </FormGrid>
              <div className="ui-action-row mt-4">
                <button disabled={busy} className="ui-btn ui-btn-primary text-sm disabled:opacity-50">
                  Create draft product
                </button>
                <button type="button" onClick={() => setCreating(false)} className={subtle}>
                  Cancel
                </button>
              </div>
            </form>
          </Card>
        </Section>
      ) : null}

      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        {/* ---------------- Product list ---------------- */}
        <aside className="min-w-0 space-y-3">
          <Card>
            <div className="space-y-3">
              <input
                className={`${input} w-full`}
                value={search}
                onChange={event => setSearch(event.target.value)}
                placeholder="Search products or SKU"
                aria-label="Search products"
              />
              <div className="grid grid-cols-2 gap-2">
                <MenuSelect ariaLabel="Product status" className="ui-select-trigger w-full" value={statusFilter} onChange={value => setStatusFilter(value as StaffProductStatus)} options={[
                  { value: "all", label: "All statuses" }, { value: "active", label: "Active" },
                  { value: "draft", label: "Draft" }, { value: "hidden", label: "Hidden / archived" },
                ]} />
                <MenuSelect ariaLabel="Stock status" className="ui-select-trigger w-full" value={stockFilter} onChange={value => setStockFilter(value as StaffStockFilter)} options={[
                  { value: "all", label: "All stock" }, { value: "in_stock", label: "In stock" },
                  { value: "low_stock", label: "Low stock" }, { value: "out_of_stock", label: "Out of stock" },
                ]} />
                <MenuSelect ariaLabel="Product category" className="ui-select-trigger w-full" value={categoryFilter ?? ""} onChange={value => setCategoryFilter(value || null)} options={[
                  { value: "", label: "All categories" },
                  ...categories.filter(category => !category.archived_at).map(category => ({
                    value: category.id,
                    label: `${category.parent_id ? "↳ " : ""}${category.name}`,
                  })),
                ]} />
                <MenuSelect ariaLabel="Sort products" className="ui-select-trigger w-full" value={productSort} onChange={value => setProductSort(value as StaffProductSort)} options={[
                  { value: "newest", label: "Newest" }, { value: "oldest", label: "Oldest" }, { value: "name", label: "Name" },
                  { value: "price_asc", label: "Price: low first" }, { value: "price_desc", label: "Price: high first" },
                  { value: "inventory", label: "Inventory: low first" }, { value: "manual", label: "Manual order" },
                ]} />
              </div>
              <CheckField label="Customizable only" checked={customizableOnly} onChange={setCustomizableOnly} />
              <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                <span>{filteredProducts.length} of {products.length} products</span>
                <button type="button" className="underline" onClick={() => { setSearch(""); setStatusFilter("all"); setStockFilter("all"); setCategoryFilter(null); setCustomizableOnly(false); setProductSort("newest"); }}>Clear</button>
              </div>
            </div>
          </Card>
          {filteredProducts.length ? (
            <div className="staff-rows">
              {filteredProducts.map(product => (
                <button
                  key={product.id}
                  type="button"
                  onClick={() => { setSelectedId(product.id); void loadEditor(product); }}
                  aria-current={selectedId === product.id ? "true" : undefined}
                  className="staff-row"
                >
                  <span className="staff-row-media">
                    {product.image_url ? <Image src={product.image_url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
                  </span>
                  <span className="staff-row-main">
                    <span className="staff-row-title block">{product.name}</span>
                    <span className="staff-row-detail block">
                      {product.sku ? `${product.sku} · ` : ""}{categories.find(category => category.id === product.category_id)?.name ?? "Uncategorized"}
                    </span>
                  </span>
                  {/* Price is a number people compare down the column, so it
                      gets an aligned track of its own rather than a third line
                      of muted detail text. */}
                  <span className="staff-row-figure">
                    {product.starting_price_cents == null ? "Quote only" : `$${(product.starting_price_cents / 100).toFixed(2)}`}
                  </span>
                  <span className="staff-row-aside">
                    {staffStockState(product) === "low_stock" ? <Badge tone="warning">{product.inventory_quantity} left</Badge> : null}
                    {staffStockState(product) === "out_of_stock" ? <Badge tone="danger">Out of stock</Badge> : null}
                    <Badge tone={staffProductStatus(product) === "active" ? "success" : "neutral"}>
                      {staffProductStatus(product) === "active" ? "Active" : staffProductStatus(product) === "hidden" ? "Hidden" : "Draft"}
                    </Badge>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
          {/* "None match" is a claim about a successful query. A failed one gets
              its own sentence, because an empty catalog and an unreadable one
              look identical otherwise. */}
          {productsFailed ? (
            <EmptyState>
              Products are not shown because the catalog could not be loaded. This is not the same as the catalog
              being empty.
            </EmptyState>
          ) : filteredProducts.length === 0 ? (
            <EmptyState>No products match this view.</EmptyState>
          ) : null}
        </aside>

        {/* ---------------- Editor ---------------- */}
        {selectedId ? (
          <div className="staff-page min-w-0">
            {/* The record header: what is being edited, whether it is live, and
                what is still missing before it can be. */}
            <header className="staff-record-header">
              <div className="staff-record-top">
                <div className="min-w-0">
                  <p className="staff-record-eyebrow">
                    {draft.archived_at ? "Archived" : draft.is_published ? "Published" : "Draft"}
                  </p>
                  <h2 className="staff-record-title">{draft.name || "Untitled product"}</h2>
                  <p className="staff-row-meta mt-1">/{draft.slug || "no-slug"}</p>
                </div>
                {draft.slug ? (
                  <Link href={`/catalog/${draft.slug}`} target="_blank" className={subtle}>
                    {draft.is_published ? "View live" : "Preview URL"} ↗
                  </Link>
                ) : null}
              </div>

              <div className="staff-record-next">
                <div className="min-w-0">
                  <p className="staff-record-next-label">
                    {readyToPublish ? "Ready to publish" : "Before this can be published"}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {publishChecks.map(check => (
                      <button
                        key={check.label}
                        type="button"
                        onClick={() => setTab(check.tab)}
                        className="staff-view"
                        aria-pressed={false}
                      >
                        <span aria-hidden="true">{check.unknown ? "?" : check.complete ? "✓" : "○"}</span>
                        {check.label}
                        {check.unknown ? " — could not be checked" : ""}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </header>

            <PageTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Product sections" />

            {/* ---- Basic ---- */}
            <TabPanel id="basic" value={tab}>
              <Section title="Identity" description="What this product is called and where it sits in the store.">
                <Card>
                  <FormGrid>
                    <Field label="Name" required>
                      <input className={`${input} w-full`} value={draft.name ?? ""} onChange={e => patch({ name: e.target.value })} />
                    </Field>
                    <Field label="SKU" help="Your own stock code. Optional.">
                      <input className={`${input} w-full`} value={draft.sku ?? ""} onChange={e => patch({ sku: e.target.value })} placeholder="Example: KM-SHIFT-001" />
                    </Field>
                    {/* Not wrapped in `Field`: the picker owns its own label and
                        help, because `Field` is a `<label>` and a listbox
                        trigger inside one is activated by clicking the caption. */}
                    <CategorySelect
                      value={draft.category_id ?? null}
                      onChange={categoryId => patch({ category_id: categoryId })}
                      categories={categories}
                      productCounts={categoryCounts}
                      disabled={!canManage}
                      help={<Link href="/staff/catalog/categories" className="underline hover:no-underline">Manage categories →</Link>}
                    />
                    <Field label="Availability">
                      <MenuSelect
                        className="ui-select-trigger"
                        ariaLabel="Availability"
                        value={draft.availability_status ?? "made_to_order"}
                        onChange={value => patch({ availability_status: value as CatalogProduct["availability_status"] })}
                        options={[
                          { value: "available", label: "Available" },
                          { value: "limited", label: "Limited availability" },
                          { value: "made_to_order", label: "Made to order" },
                          { value: "unavailable", label: "Currently unavailable" },
                        ]}
                      />
                    </Field>
                    <Field label="Lead time" help="Shown to customers as an expectation, not a promise.">
                      <input className={`${input} w-full`} value={draft.lead_time_text ?? ""} onChange={e => patch({ lead_time_text: e.target.value })} placeholder="Example: Usually 1–2 weeks" />
                    </Field>
                    <FormWide>
                      <Field label="Short description" help="One line. Used on cards, in search results and as the page's meta description.">
                        <input className={`${input} w-full`} value={draft.short_description ?? ""} onChange={e => patch({ short_description: e.target.value })} />
                      </Field>
                    </FormWide>
                  </FormGrid>
                </Card>
              </Section>

              <Section title="Status" description="Whether customers can see this product at all.">
                <Card>
                  <div className="grid gap-3">
                    <CheckField
                      label="Published in the store"
                      help={
                        !readyToPublish && !draft.is_published
                          ? "Finish the checklist above first. You can save a draft at any time."
                          : "Visible to customers and included in browse and search."
                      }
                      checked={Boolean(draft.is_published)}
                      disabled={Boolean(draft.archived_at) || (!draft.is_published && !readyToPublish)}
                      onChange={value => patch({ is_published: value })}
                    />
                  </div>
                </Card>
              </Section>
            </TabPanel>

            {/* ---- Media ---- */}
            <TabPanel id="media" value={tab}>
              <Section
                title="Images and 3D model"
                description="The first image is the cover customers see on cards. Uploads save immediately — they are files, not draft fields."
                actions={
                  canManage ? (
                    <div className="ui-action-row">
                      <label className={`${subtle} cursor-pointer`}>
                        Upload images
                        <input type="file" multiple accept="image/jpeg,image/png,image/webp,image/avif" className="hidden" onChange={e => { for (const file of Array.from(e.target.files ?? [])) void uploadAsset(file, "image"); e.target.value = ""; }} />
                      </label>
                      <label className={`${subtle} cursor-pointer`}>
                        Upload 3D model
                        <input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" className="hidden" onChange={e => { const file = e.target.files?.[0]; if (file) void uploadAsset(file, "model"); e.target.value = ""; }} />
                      </label>
                    </div>
                  ) : null
                }
              >
                {media.length ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {media.map(item => (
                      <div key={item.id} className={`overflow-hidden rounded-xl border ${item.kind === "image" && draft.image_url === item.url ? "border-brand-primary" : "border-[var(--border)]"}`}>
                        {item.kind === "image" ? (
                          <Image src={item.url} alt={item.alt_text || ""} width={500} height={320} className="h-32 w-full object-cover" unoptimized />
                        ) : (
                          <div className="flex h-32 items-center justify-center bg-black/40 text-sm text-brand-primary">3D MODEL</div>
                        )}
                        <div className="flex items-center justify-between gap-2 p-2 text-xs">
                          <span>{item.kind === "image" && draft.image_url === item.url ? "Cover image" : item.kind === "image" ? "Gallery image" : "Interactive model"}</span>
                          <span className="flex gap-2">
                            {item.kind === "image" && draft.image_url !== item.url ? (
                              <button type="button" onClick={() => void setCoverImage(item)} className="text-brand-primary">Set cover</button>
                            ) : null}
                            <button type="button" onClick={() => void moveMedia(media.indexOf(item), -1)} aria-label="Move asset earlier">↑</button>
                            <button type="button" onClick={() => void moveMedia(media.indexOf(item), 1)} aria-label="Move asset later">↓</button>
                            <button type="button" onClick={() => void deleteMedia(item)} className="text-rose-300">Remove</button>
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState>No images yet. A product with no cover image cannot be published.</EmptyState>
                )}
              </Section>
            </TabPanel>

            {/* ---- Pricing ---- */}
            <TabPanel id="pricing" value={tab}>
              <Section
                title="Price"
                description="What this product costs before options. Discount codes are configured under Store → Discounts and apply on top."
              >
                <Card>
                  <FormGrid>
                    <Field label="Starting price ($)" help="Leave blank for a quote-only product.">
                      <input
                        className={`${input} w-full`}
                        type="number"
                        min="0"
                        step=".01"
                        value={draft.starting_price_cents == null ? "" : draft.starting_price_cents / 100}
                        onChange={e => patch({ starting_price_cents: e.target.value ? Math.round(Number(e.target.value) * 100) : null })}
                      />
                    </Field>
                    <Field label="Tax code" help="Passed to Stripe when this product is bought. Optional.">
                      <input className={`${input} w-full`} value={draft.tax_code ?? ""} onChange={e => patch({ tax_code: e.target.value })} />
                    </Field>
                  </FormGrid>
                  {allowsDirectPurchase(purchaseMode) && draft.starting_price_cents == null ? (
                    <Notice tone="warning" className="mt-4">
                      This product can be bought directly but has no price, so customers are sent to a request form
                      instead. Set a price, or change how it is bought under Purchase.
                    </Notice>
                  ) : null}
                </Card>
              </Section>
            </TabPanel>

            {/* ---- Purchase ---- */}
            <TabPanel id="purchase" value={tab}>
              <Section title="How customers buy this" description="Whether it goes in a cart, becomes a request, or both.">
                <Card>
                  <FormGrid>
                    <FormWide>
                      <Field label="Purchase mode" help={PURCHASE_MODE_COPY[purchaseMode].help}>
                        <MenuSelect
                          className="ui-select-trigger"
                          ariaLabel="Purchase mode"
                          value={purchaseMode}
                          onChange={value => patch({ purchase_mode: value as PurchaseMode })}
                          options={PURCHASE_MODES.map(mode => ({ value: mode, label: PURCHASE_MODE_COPY[mode].staffLabel }))}
                        />
                      </Field>
                    </FormWide>
                  </FormGrid>
                  <div className="mt-4 grid gap-3">
                    <CheckField
                      label="Customers can customize this product"
                      help="Shows the option list below on the product's request form."
                      checked={Boolean(draft.is_custom)}
                      onChange={value => patch({ is_custom: value })}
                    />
                    <CheckField
                      label="Made to order"
                      help="Never reserved at checkout, and never raises a low-stock alert."
                      checked={Boolean(draft.made_to_order)}
                      onChange={value => patch({ made_to_order: value })}
                    />
                  </div>
                </Card>
              </Section>

              <Section
                title="Customization options"
                description="The fields that appear on this product's request form. Adding or deleting an option writes immediately; the labels and prices inside it save with the rest."
                actions={
                  /* Disabled after a failed read: `addGroup` derives the new
                     sort_order from `groups.length`, so adding one to a list
                     that failed to load would collide with the options the
                     product actually has. */
                  <button
                    type="button"
                    disabled={!canManage || !draft.is_custom || editorLoadFailed}
                    title={editorLoadFailed ? "The existing options could not be loaded, so a new one cannot be positioned safely." : undefined}
                    onClick={() => void addGroup()}
                    className={subtle}
                  >
                    Add option
                  </button>
                }
              >
                {!draft.is_custom ? (
                  <EmptyState>Customization is off. Turn it on above to configure the choices customers get.</EmptyState>
                ) : groups.length === 0 ? (
                  <EmptyState>No options yet. Add one to give customers something to choose.</EmptyState>
                ) : (
                  <div className="space-y-4">
                    {groups.map((group, groupIndex) => (
                      <Card key={group.id}>
                        <FormGrid>
                          <Field label="Option name">
                            <input className={`${input} w-full`} value={group.name} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, name: e.target.value, option_key: optionKey(e.target.value) } : item))} />
                          </Field>
                          <Field label="Saved key" help="How the choice is stored on an order.">
                            <input className={`${input} w-full`} value={group.option_key} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, option_key: optionKey(e.target.value) } : item))} />
                          </Field>
                          <Field label="Field type" help="Choose a customer presentation below for options with fixed values.">
                            <MenuSelect
                              className="ui-select-trigger"
                              ariaLabel="Control type"
                              value={group.input_type}
                              onChange={value => setGroups(current => current.map(item => item.id === group.id ? { ...item, input_type: value as ProductOptionGroup["input_type"] } : item))}
                              options={[
                                { value: "select", label: "Dropdown" },
                                { value: "radio", label: "Fixed choices" },
                                { value: "text", label: "Short text" },
                                { value: "textarea", label: "Long text" },
                                { value: "number", label: "Number" },
                                { value: "checkbox", label: "Checkbox" },
                                { value: "file", label: "Reference file" },
                              ]}
                            />
                          </Field>
                          <Field label="Help text">
                            <input className={`${input} w-full`} value={group.description ?? ""} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, description: e.target.value } : item))} />
                          </Field>
                          <Field label="Placeholder">
                            <input className={`${input} w-full`} value={group.placeholder ?? ""} onChange={e => setGroups(current => current.map(item => item.id === group.id ? { ...item, placeholder: e.target.value } : item))} />
                          </Field>
                          <div className="self-end">
                            <CheckField
                              label="Required"
                              checked={group.is_required}
                              onChange={value => setGroups(current => current.map(item => item.id === group.id ? { ...item, is_required: value } : item))}
                            />
                          </div>
                        </FormGrid>

                        {["select", "radio"].includes(group.input_type) ? (
                          <>
                            {/* Presentation, chosen explicitly. Never inferred
                                from the option's name: a group called "Colour"
                                with no photographs should keep its buttons. */}
                            <div className="mt-4 max-w-sm">
                              <Field
                                label="Presentation"
                                help="How these values appear on the storefront. This uses the existing field type and display style settings."
                              >
                                <MenuSelect
                                  className="ui-select-trigger"
                                  ariaLabel={`${group.name} presentation`}
                                  value={choicePresentation(group)}
                                  onChange={value => setGroups(current => current.map(item => item.id === group.id ? { ...item, ...presentationPatch(value as ChoicePresentation) } : item))}
                                  options={[
                                    { value: "dropdown", label: "Dropdown" },
                                    { value: "buttons", label: "Buttons" },
                                    { value: "swatches", label: "Image swatches" },
                                  ]}
                                />
                              </Field>
                            </div>

                            <div className="mt-4 space-y-2">
                              {(group.product_option_values ?? []).map((value, valueIndex) => (
                                <div key={value.id} className="option-value-editor">
                                <div className="option-value-order" aria-label={`${value.label || "Value"} ordering`}>
                                  <span>Value {valueIndex + 1}</span>
                                  <button type="button" className="ui-btn ui-btn-ghost text-xs" disabled={!canManage || valueIndex === 0} onClick={() => moveValue(group.id, valueIndex, -1)}>Move up</button>
                                  <button type="button" className="ui-btn ui-btn-ghost text-xs" disabled={!canManage || valueIndex === (group.product_option_values?.length ?? 0) - 1} onClick={() => moveValue(group.id, valueIndex, 1)}>Move down</button>
                                </div>
                                <ProductOptionValueRow
                                  key={value.id}
                                  value={value}
                                  media={media}
                                  disabled={!canManage}
                                  onChange={patch => setGroups(current => current.map(item => item.id !== group.id ? item : {
                                    ...item,
                                    product_option_values: item.product_option_values?.map(choice => {
                                      if (choice.id !== value.id) {
                                        return patch.is_default ? { ...choice, is_default: false } : choice;
                                      }
                                      const next = { ...choice, ...patch };
                                      // The saved value follows the label while
                                      // it is being typed, exactly as before —
                                      // but only when the label is what changed,
                                      // so editing the key by hand still sticks.
                                      if (patch.label !== undefined && patch.value === undefined) {
                                        next.value = optionKey(patch.label);
                                      }
                                      if (patch.value !== undefined) next.value = optionKey(patch.value);
                                      return next;
                                    }),
                                  }))}
                                  onRemove={() => void removeValue(group.id, value.id)}
                                />
                                </div>
                              ))}
                            </div>
                            <ProductOptionPreview group={group} media={media} />
                          </>
                        ) : null}

                        <div className="ui-action-row mt-4">
                          {["select", "radio"].includes(group.input_type) ? (
                            <button type="button" onClick={() => void addValue(group)} className={subtle}>Add choice</button>
                          ) : null}
                          <button type="button" onClick={() => void moveGroup(groupIndex, -1)} className={subtle}>Move up</button>
                          <button type="button" onClick={() => void moveGroup(groupIndex, 1)} className={subtle}>Move down</button>
                          <button type="button" onClick={() => void removeGroup(group.id)} className={`${subtle} text-rose-300`}>Delete option</button>
                        </div>
                      </Card>
                    ))}
                  </div>
                )}
              </Section>
            </TabPanel>

            {/* ---- Inventory ---- */}
            <TabPanel id="inventory" value={tab}>
              <Section
                title="Stock"
                description="Whether this product has a countable quantity, and when to warn about it."
                actions={
                  /* Setting a quantity here is a *definition*; moving stock is
                     an event with a reason and a ledger entry. They are
                     different actions, so the editor points at the surface that
                     records the second rather than pretending this field is it. */
                  permissions.has("inventory.view") ? (
                    <Link href={`/staff/inventory/${selectedId}`} className={subtle}>
                      Stock, holds &amp; history →
                    </Link>
                  ) : null
                }
              >
                <Card>
                  <FormGrid>
                    <Field label="Inventory mode">
                      <MenuSelect
                        className="ui-select-trigger"
                        ariaLabel="Inventory mode"
                        value={draft.inventory_policy ?? "unlimited"}
                        onChange={value => patch({ inventory_policy: value as CatalogProduct["inventory_policy"] })}
                        options={[
                          { value: "unlimited", label: "Made to order / unlimited" },
                          { value: "track", label: "Track quantity" },
                        ]}
                      />
                    </Field>
                    <Field label="Quantity on hand">
                      <input disabled={draft.inventory_policy !== "track"} className={`${input} w-full disabled:opacity-50`} type="number" min="0" value={draft.inventory_quantity ?? 0} onChange={e => patch({ inventory_quantity: Number(e.target.value) })} />
                    </Field>
                    <Field label="Low-stock threshold" help="The dashboard raises a warning at or below this number.">
                      <input disabled={draft.inventory_policy !== "track"} className={`${input} w-full disabled:opacity-50`} type="number" min="0" value={draft.low_stock_threshold ?? 2} onChange={e => patch({ low_stock_threshold: Number(e.target.value) })} />
                    </Field>
                  </FormGrid>
                  {draft.inventory_policy === "track" ? (
                    <div className="mt-4">
                      <CheckField
                        label="Keep accepting orders at zero (backorders)"
                        help="Customers can still buy when the count reaches zero."
                        checked={Boolean(draft.continue_selling_when_out_of_stock)}
                        onChange={value => patch({ continue_selling_when_out_of_stock: value })}
                      />
                    </div>
                  ) : null}
                </Card>
              </Section>
            </TabPanel>

            {/* ---- Shipping ---- */}
            <TabPanel id="shipping" value={tab}>
              <Section
                title="Delivery, packaging and returns"
                description="These decide which delivery methods a cart may offer and what a parcel is priced as."
              >
                <Card>
                  <ProductShippingEditor draft={draft} onChange={patch} disabled={!canManage} />
                </Card>
              </Section>
            </TabPanel>

            {/* ---- Content ---- */}
            <TabPanel id="content" value={tab}>
              <Section title="Full description" description="The main body of the product page.">
                <Card>
                  <Field label="Description">
                    <textarea className={`${input} min-h-40 w-full`} value={draft.description ?? ""} onChange={e => patch({ description: e.target.value })} />
                  </Field>
                </Card>
              </Section>
              <Section
                title="Structured sections"
                description="Specifications, benefits and FAQs. All optional — a section with nothing in it is hidden rather than shown empty, so a sparse product simply gets a shorter page."
              >
                <Card>
                  <ProductContentEditor
                    draft={draft}
                    onChange={patch}
                    content={content}
                    onContentChange={setContent}
                    disabled={!canManage}
                  />
                </Card>
              </Section>
            </TabPanel>

            {/* ---- SEO ---- */}
            <TabPanel id="seo" value={tab}>
              <Section
                title="Address and search listing"
                description="What this product's URL is, and what a search engine shows for it."
              >
                <Card>
                  <FormGrid>
                    <FormWide>
                      <Field label="Slug" required help="The address customers and search engines use. Changing it breaks existing links.">
                        <input className={`${input} w-full`} value={draft.slug ?? ""} onChange={e => patch({ slug: e.target.value })} />
                      </Field>
                    </FormWide>
                  </FormGrid>
                  {/*
                    Stated rather than editable, because these are derived. The
                    product page's `generateMetadata` uses the name as the title
                    and the short description as the description; offering
                    separate fields here would be inventing columns that do not
                    exist and cannot be saved.
                  */}
                  <Facts className="mt-5">
                    <Fact label="Address">/catalog/{draft.slug || "…"}</Fact>
                    <Fact label="Search title">{draft.name || "—"}</Fact>
                    <Fact label="Search description">
                      {draft.short_description?.trim() || draft.description?.trim().slice(0, 200) || "Falls back to the product name."}
                    </Fact>
                  </Facts>
                  <p className="mt-4 text-xs text-brand-textMuted">
                    The title and description come from Basic and Content. There are no separate meta fields to set.
                  </p>
                </Card>
              </Section>
            </TabPanel>

            {/* ---- Advanced ---- */}
            <TabPanel id="advanced" value={tab}>
              <Section title="Ordering" description="Where this product sits when the store lists several together.">
                <Card>
                  <FormGrid>
                    <Field label="Sort order" help="Lower numbers come first.">
                      <input className={`${input} w-full`} type="number" value={draft.sort_order ?? 0} onChange={e => patch({ sort_order: Number(e.target.value) })} />
                    </Field>
                    <Field label="3D model poster URL" help="The still image shown before the model loads.">
                      <input className={`${input} w-full`} value={draft.model_poster_url ?? ""} onChange={e => patch({ model_poster_url: e.target.value })} />
                    </Field>
                  </FormGrid>
                </Card>
              </Section>

              <Section
                title="Product lifecycle"
                description="Archiving hides a product from customers and keeps every order that referenced it. Deleting does not."
              >
                <Card>
                  <div className="ui-action-row">
                    <button type="button" disabled={!canManage || busy} onClick={() => void duplicateProduct()} className={subtle}>
                      Duplicate
                    </button>
                    <button type="button" disabled={!canManage || busy} onClick={() => void toggleArchive()} className={subtle}>
                      {draft.archived_at ? "Restore" : "Archive"}
                    </button>
                    <button type="button" disabled={!canManage || busy} onClick={() => void deleteProduct()} className="ui-btn ui-btn-danger text-sm">
                      Delete permanently
                    </button>
                  </div>
                </Card>
              </Section>
            </TabPanel>

            {/* One save, for every tab. */}
            {canManage ? (
              <SaveBar
                dirty={hasUnsavedChanges}
                saving={busy}
                onSave={() => void saveAllChanges()}
                message={saveMessage}
              />
            ) : null}
          </div>
        ) : (
          <EmptyState>Select a product to edit everything customers see.</EmptyState>
        )}
      </div>
    </StaffPage>
  );
}
