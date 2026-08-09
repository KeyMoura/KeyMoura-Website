"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import QuantityField from "@/components/commerce/QuantityField";
import { GUEST_ACCESS_WINDOW_LABEL } from "@/lib/commerce/guestAccessWindow";
import { useCheckoutContext } from "@/lib/hooks/useCart";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { money, type CatalogProduct, type ProductOptionGroup } from "@/lib/commerceTypes";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { emptyShippingAddress, type FulfillmentMethod, type ShippingAddress, validateUpload } from "@/lib/checkout";

type Selection = string | number | boolean | null;

/**
 * The custom-request wizard.
 *
 * Lifted out of the product page unchanged in behaviour — same three steps,
 * same validation, same uploads to `order-assets`, same `POST /api/orders`,
 * same cleanup of uploaded files when the request is refused. Every product
 * that could be requested before can still be requested, and the order rows it
 * creates are identical.
 *
 * What changed is where its data comes from. The page used to be one client
 * component that fetched the product, its media and its options in a
 * `useEffect` and then rendered both the marketing page and this form from that
 * state. Now the page is a server component and hands this form the product and
 * options it already loaded, so the wizard costs nothing until a customer
 * scrolls to it and the page's first paint is real content rather than
 * "Loading…".
 *
 * It is rendered only for products whose purchase mode actually allows a
 * request; the caller decides that.
 */
export default function ProductRequestForm({
  product,
  groups,
  canRequest,
}: {
  product: CatalogProduct;
  groups: ProductOptionGroup[];
  canRequest: boolean;
}) {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const [selections, setSelections] = useState<Record<string, Selection>>(() => {
    const defaults: Record<string, Selection> = {};
    for (const group of groups) {
      const choice = group.product_option_values?.find((value) => value.is_default) ?? group.product_option_values?.[0];
      defaults[group.option_key] = group.input_type === "checkbox" ? false : choice?.value ?? "";
    }
    return defaults;
  });
  const [files, setFiles] = useState<Record<string, File | null>>({});
  const [quantity, setQuantity] = useState(1);
  const [targetDate, setTargetDate] = useState("");
  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [fulfillmentMethod, setFulfillmentMethod] = useState<FulfillmentMethod>("shipping");
  const [shippingAddress, setShippingAddress] = useState<ShippingAddress>(emptyShippingAddress);
  const [checkoutToken] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [guestEmail, setGuestEmail] = useState("");
  const [guestName, setGuestName] = useState("");

  /**
   * Whether this visitor is signed in, and whether the shop takes guest
   * requests — both from the server, so the browser's own idea of its session
   * is not a second source of truth. The route re-checks both.
   */
  const { data: checkout } = useCheckoutContext();
  const signedIn = checkout?.signedIn ?? false;
  const guestRequestsAllowed = checkout?.guestRequests ?? false;

  const choicePrice = useMemo(
    () =>
      groups.reduce((total, group) => {
        const chosen = group.product_option_values?.find((value) => value.value === selections[group.option_key]);
        return total + (chosen?.price_adjustment_cents ?? 0);
      }, 0),
    [groups, selections]
  );
  const estimated =
    product.starting_price_cents == null ? null : (product.starting_price_cents + choicePrice) * quantity;

  const input = "ui-input";

  function validateStep(target: 1 | 2) {
    if (target === 1) {
      for (const group of groups) {
        const value = group.input_type === "file" ? files[group.option_key] : selections[group.option_key];
        if (group.is_required && (value === null || value === undefined || value === "" || value === false))
          return `${group.name} is required.`;
        if (group.input_type === "file" && value instanceof File) {
          const message = validateUpload(value);
          if (message) return `${group.name}: ${message}`;
        }
      }
    }
    if (target === 2 && fulfillmentMethod === "shipping") {
      if (
        !shippingAddress.name.trim() ||
        !shippingAddress.line1.trim() ||
        !shippingAddress.city.trim() ||
        !shippingAddress.state.trim() ||
        !shippingAddress.postal_code.trim()
      )
        return "Enter a complete shipping address.";
    }
    return "";
  }

  function advance(target: 2 | 3) {
    const message = validateStep(target === 2 ? 1 : 2);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setStep(target);
    document.getElementById("request-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");

    const { data: auth } = await supabase.auth.getUser();

    /**
     * A guest asking for a custom version of this product.
     *
     * Posted to `/api/orders/custom`, which is the route that already accepts
     * a guest identity, a product reference and an option snapshot — rather
     * than widening `/api/orders`, whose ownership rules are the account
     * path's and should stay that way.
     *
     * File-upload option groups are the one thing a guest cannot send: the
     * storage prefix is keyed on an authenticated user. Said here rather than
     * discovered after a long form.
     */
    if (!auth.user) {
      if (!guestRequestsAllowed) {
        router.push(`/auth/login?next=${encodeURIComponent(`/catalog/${product.slug}`)}`);
        return;
      }
      if (groups.some((group) => group.input_type === "file")) {
        setBusy(false);
        return setError("This product needs a file with the request, so please sign in or create an account first.");
      }
      if (notes.trim().length < 20) {
        setBusy(false);
        return setError("Tell us a little more about what you need — at least 20 characters.");
      }

      const chosen: Record<string, string> = {};
      for (const group of groups) {
        const selected = selections[group.option_key];
        if (selected === null || selected === undefined || selected === "" || selected === false) continue;
        const choice = group.product_option_values?.find((value) => value.value === selected);
        chosen[group.name] = choice?.label ?? String(selected);
      }

      const guestResponse = await fetch("/api/orders/custom", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guest_email: guestEmail,
          guest_name: guestName,
          product_slug: product.slug,
          selected_options: chosen,
          title: `Custom ${product.name}`,
          project_type: "Custom version of a catalog product",
          description: notes.trim(),
          quantity,
          budget: budget.trim(),
          target_date: targetDate || null,
          fulfillment_method: fulfillmentMethod,
          shipping_address: fulfillmentMethod === "shipping" ? shippingAddress : null,
        }),
      });
      const guestData = (await guestResponse.json().catch(() => null)) as { id?: string; href?: string; error?: string } | null;
      if (!guestResponse.ok || !guestData?.id) {
        setError(guestData?.error || "Could not send that request.");
        setBusy(false);
        return;
      }
      router.push(guestData.href ?? `/orders/guest/${guestData.id}`);
      return;
    }

    const requestToken = crypto.randomUUID();
    const uploadedPaths: string[] = [];
    const cleanupUploads = async () => {
      if (uploadedPaths.length) await supabase.storage.from("order-assets").remove(uploadedPaths);
    };

    const snapshot: Record<string, unknown> = {};
    for (const group of groups) {
      const selected = selections[group.option_key];
      const choice = group.product_option_values?.find((value) => value.value === selected);
      snapshot[group.option_key] = {
        label: group.name,
        value: selected,
        display_value: choice?.label ?? selected,
        price_adjustment_cents: choice?.price_adjustment_cents ?? 0,
      };

      const file = files[group.option_key];
      if (group.input_type === "file" && file) {
        const fileError = validateUpload(file);
        if (fileError) {
          await cleanupUploads();
          setBusy(false);
          return setError(`${group.name}: ${fileError}`);
        }
        const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${auth.user.id}/${requestToken}/${group.option_key}-${safeName}`;
        const { error: uploadError } = await supabase.storage
          .from("order-assets")
          .upload(path, file, { upsert: false, contentType: file.type || undefined });
        if (uploadError) {
          await cleanupUploads();
          setBusy(false);
          return setError(`Could not upload ${group.name}: ${uploadError.message}`);
        }
        uploadedPaths.push(path);
        snapshot[group.option_key] = { label: group.name, value: path, display_value: file.name, kind: "file" };
      }
    }
    snapshot.budget = budget.trim() || null;
    snapshot.estimated_total_cents = estimated;

    const { data: sessionData } = await supabase.auth.getSession();
    const response = await fetch("/api/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(sessionData.session?.access_token
          ? { Authorization: `Bearer ${sessionData.session.access_token}` }
          : {}),
      },
      body: JSON.stringify({
        product_id: product.id,
        quantity,
        specifications: snapshot,
        checkout_token: checkoutToken,
        customer_notes: notes.trim() || null,
        target_date: targetDate || null,
        fulfillment_method: fulfillmentMethod,
        shipping_address: fulfillmentMethod === "shipping" ? shippingAddress : null,
      }),
    });

    const data = (await response.json()) as { id?: string; error?: string };
    if (!response.ok || !data.id) {
      await cleanupUploads();
      setError(data.error || "Could not create order request");
      setBusy(false);
      return;
    }
    router.push(`/orders/${data.id}/confirmed`);
  }

  return (
    <section id="request-form" className="product-request" aria-labelledby="request-heading">
      <form onSubmit={submit} className="product-request-form">
        <div className="product-request-steps" aria-label="Request progress">
          {["Customize", "Delivery", "Review"].map((label, index) => (
            <div
              key={label}
              className={`product-request-step${
                step === index + 1 ? " is-current" : step > index + 1 ? " is-done" : ""
              }`}
              aria-current={step === index + 1 ? "step" : undefined}
            >
              {index + 1}. {label}
            </div>
          ))}
        </div>

        <h2 id="request-heading" className="product-request-title">
          {step === 1 ? "Customize your item" : step === 2 ? "Delivery details" : "Review your request"}
        </h2>
        <p className="product-request-lede">
          {step === 1
            ? "Choose your options and see the estimated price update as you go."
            : step === 2
              ? "Tell us where this should go and when you need it."
              : "Confirm everything below. You will not be charged yet."}
        </p>

        {step === 1 ? (
          <>
            {/* `absoluteMax` is 1000 because that is what
                `/api/orders/custom` enforces — a request is not a cart line and
                is not bound by the 99-unit line cap. Stating the server's own
                number is what stops the field accepting more than the route
                will keep. */}
            <QuantityField
              label="Quantity"
              value={quantity}
              max={
                product.inventory_policy === "track" && !product.continue_selling_when_out_of_stock
                  ? product.inventory_quantity
                  : null
              }
              absoluteMax={1000}
              showMax={false}
              onCommit={setQuantity}
            />

            {groups.length ? (
              <div className="mt-5 space-y-4">
                {groups.map((group) => (
                  <fieldset key={group.id}>
                    <legend className="text-sm font-medium">
                      {group.name}
                      {group.is_required ? <span className="text-brand-primary"> *</span> : null}
                    </legend>
                    {group.description ? (
                      <p className="mt-1 text-xs text-brand-textMuted">{group.description}</p>
                    ) : null}

                    {group.input_type === "select" ? (
                      <div className="mt-1">
                        <MenuSelect
                          value={String(selections[group.option_key] ?? "")}
                          onChange={(value) => setSelections((c) => ({ ...c, [group.option_key]: value }))}
                          ariaLabel={group.name}
                          align="left"
                          className="ui-select-trigger w-full"
                          options={[
                            ...(!group.is_required ? [{ value: "", label: "No preference" }] : []),
                            ...(group.product_option_values ?? []).map((value) => ({
                              value: value.value,
                              label: `${value.label}${
                                value.price_adjustment_cents ? ` (${money(value.price_adjustment_cents)})` : ""
                              }`,
                            })),
                          ]}
                        />
                      </div>
                    ) : null}

                    {group.input_type === "radio" ? (
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {(group.product_option_values ?? []).map((value) => (
                          <label
                            key={value.id}
                            className={`product-option-choice${
                              selections[group.option_key] === value.value ? " is-selected" : ""
                            }`}
                          >
                            <input
                              className="sr-only"
                              type="radio"
                              required={group.is_required}
                              name={group.option_key}
                              checked={selections[group.option_key] === value.value}
                              onChange={() => setSelections((c) => ({ ...c, [group.option_key]: value.value }))}
                            />
                            <span className="product-option-choice-label">{value.label}</span>
                            {value.price_adjustment_cents ? (
                              <span className="product-option-choice-price">
                                {money(value.price_adjustment_cents)}
                              </span>
                            ) : null}
                          </label>
                        ))}
                      </div>
                    ) : null}

                    {group.input_type === "text" ? (
                      <input
                        required={group.is_required}
                        className={`${input} mt-1`}
                        placeholder={group.placeholder || ""}
                        value={String(selections[group.option_key] ?? "")}
                        onChange={(e) => setSelections((c) => ({ ...c, [group.option_key]: e.target.value }))}
                      />
                    ) : null}

                    {group.input_type === "textarea" ? (
                      <textarea
                        required={group.is_required}
                        className={`${input} mt-1 min-h-24`}
                        placeholder={group.placeholder || ""}
                        value={String(selections[group.option_key] ?? "")}
                        onChange={(e) => setSelections((c) => ({ ...c, [group.option_key]: e.target.value }))}
                      />
                    ) : null}

                    {group.input_type === "number" ? (
                      <input
                        required={group.is_required}
                        type="number"
                        className={`${input} mt-1`}
                        placeholder={group.placeholder || ""}
                        value={String(selections[group.option_key] ?? "")}
                        onChange={(e) =>
                          setSelections((c) => ({
                            ...c,
                            [group.option_key]: e.target.value ? Number(e.target.value) : null,
                          }))
                        }
                      />
                    ) : null}

                    {group.input_type === "checkbox" ? (
                      <label className="mt-2 flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
                        <input
                          type="checkbox"
                          checked={Boolean(selections[group.option_key])}
                          onChange={(e) => setSelections((c) => ({ ...c, [group.option_key]: e.target.checked }))}
                        />
                        {group.placeholder || `Yes, include ${group.name.toLowerCase()}`}
                      </label>
                    ) : null}

                    {group.input_type === "file" ? (
                      <>
                        <input
                          required={group.is_required}
                          type="file"
                          accept="image/jpeg,image/png,image/webp,application/pdf"
                          className={`${input} mt-1`}
                          onChange={(e) =>
                            setFiles((c) => ({ ...c, [group.option_key]: e.target.files?.[0] ?? null }))
                          }
                        />
                        <p className="mt-1 text-xs text-brand-textMuted">JPEG, PNG, WebP, or PDF · 20 MB max</p>
                      </>
                    ) : null}
                  </fieldset>
                ))}
              </div>
            ) : null}

            <label className="product-request-field mt-4">
              Notes
              <textarea
                className={`${input} mt-1 min-h-28`}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Describe anything else we should know (optional)."
                maxLength={5000}
              />
            </label>
          </>
        ) : null}

        {step === 2 ? (
          <>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setFulfillmentMethod("shipping")}
                className={`product-option-choice${fulfillmentMethod === "shipping" ? " is-selected" : ""}`}
              >
                <span className="product-option-choice-label">Ship to me</span>
                <span className="product-option-choice-note">Cost confirmed with your quote</span>
              </button>
              <button
                type="button"
                onClick={() => setFulfillmentMethod("pickup")}
                className={`product-option-choice${fulfillmentMethod === "pickup" ? " is-selected" : ""}`}
              >
                <span className="product-option-choice-label">Local pickup</span>
                <span className="product-option-choice-note">Arrange pickup after completion</span>
              </button>
            </div>

            {fulfillmentMethod === "shipping" ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="product-request-field sm:col-span-2">
                  Full name
                  <input
                    className={`${input} mt-1`}
                    autoComplete="name"
                    value={shippingAddress.name}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, name: e.target.value })}
                  />
                </label>
                <label className="product-request-field sm:col-span-2">
                  Street address
                  <input
                    className={`${input} mt-1`}
                    autoComplete="street-address"
                    value={shippingAddress.line1}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, line1: e.target.value })}
                  />
                </label>
                <label className="product-request-field sm:col-span-2">
                  Apartment, suite, etc.
                  <input
                    className={`${input} mt-1`}
                    value={shippingAddress.line2}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, line2: e.target.value })}
                  />
                </label>
                <label className="product-request-field">
                  City
                  <input
                    className={`${input} mt-1`}
                    autoComplete="address-level2"
                    value={shippingAddress.city}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, city: e.target.value })}
                  />
                </label>
                <label className="product-request-field">
                  State / region
                  <input
                    className={`${input} mt-1`}
                    autoComplete="address-level1"
                    value={shippingAddress.state}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, state: e.target.value })}
                  />
                </label>
                <label className="product-request-field">
                  Postal code
                  <input
                    className={`${input} mt-1`}
                    autoComplete="postal-code"
                    value={shippingAddress.postal_code}
                    onChange={(e) => setShippingAddress({ ...shippingAddress, postal_code: e.target.value })}
                  />
                </label>
                <label className="product-request-field">
                  Country
                  <input
                    className={`${input} mt-1`}
                    value={shippingAddress.country}
                    maxLength={2}
                    onChange={(e) =>
                      setShippingAddress({ ...shippingAddress, country: e.target.value.toUpperCase() })
                    }
                  />
                </label>
              </div>
            ) : (
              <p className="ui-notice ui-notice-info mt-4">
                We&rsquo;ll send pickup instructions when your order is ready.
              </p>
            )}

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="product-request-field">
                Target date
                <input
                  className={`${input} mt-1`}
                  type="date"
                  value={targetDate}
                  onChange={(e) => setTargetDate(e.target.value)}
                />
              </label>
              <label className="product-request-field">
                Budget
                <input
                  className={`${input} mt-1`}
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="Optional"
                />
              </label>
            </div>
          </>
        ) : null}

        {step === 3 ? (
          <div className="mt-5 space-y-4 text-sm">
            <div className="product-request-summary">
              <div className="flex justify-between">
                <span className="text-brand-textMuted">Item</span>
                <span>
                  {product.name} × {quantity}
                </span>
              </div>
              {groups.map((group) => {
                const selected = selections[group.option_key];
                const choice = group.product_option_values?.find((value) => value.value === selected);
                const file = files[group.option_key];
                return selected || file ? (
                  <div key={group.id} className="mt-2 flex justify-between gap-4">
                    <span className="text-brand-textMuted">{group.name}</span>
                    <span className="text-right">{file?.name || choice?.label || String(selected)}</span>
                  </div>
                ) : null;
              })}
            </div>

            <div className="product-request-summary">
              <div className="font-medium">{fulfillmentMethod === "shipping" ? "Shipping" : "Local pickup"}</div>
              {fulfillmentMethod === "shipping" ? (
                <p className="mt-2 text-brand-textMuted">
                  {shippingAddress.name}
                  <br />
                  {shippingAddress.line1}
                  {shippingAddress.line2 ? (
                    <>
                      <br />
                      {shippingAddress.line2}
                    </>
                  ) : null}
                  <br />
                  {shippingAddress.city}, {shippingAddress.state} {shippingAddress.postal_code}
                  <br />
                  {shippingAddress.country}
                </p>
              ) : (
                <p className="mt-2 text-brand-textMuted">Pickup instructions will be sent when ready.</p>
              )}
            </div>

            {notes ? (
              <div className="product-request-summary">
                <div className="font-medium">Notes</div>
                <p className="mt-2 whitespace-pre-wrap text-brand-textMuted">{notes}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="product-request-total">
          <div>
            <div className="text-xs text-brand-textMuted">Estimated starting total</div>
            <div className="text-xl font-semibold text-brand-primary">
              {estimated == null ? "Quoted after review" : `$${(estimated / 100).toFixed(2)}`}
            </div>
          </div>
          <span className="text-xs text-brand-textMuted">No charge now</span>
        </div>

        {/* Only on the last step, only when signed out, and only when the shop
            takes guest requests. Asked for at the end rather than the start:
            a form that opens by demanding an address is a form fewer people
            finish, and nothing before this point needs to know who they are. */}
        {step === 3 && !signedIn && guestRequestsAllowed ? (
          <div className="mt-5 grid gap-3 border-t border-brand-border pt-5 sm:grid-cols-2">
            <p className="text-sm font-semibold sm:col-span-2">Where should we send the quote?</p>
            <label className="text-sm">
              Email
              <input
                type="email"
                inputMode="email"
                autoComplete="email"
                required
                className={`${input} mt-1 w-full`}
                value={guestEmail}
                onChange={(event) => setGuestEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </label>
            <label className="text-sm">
              Name <span className="text-brand-textMuted">(optional)</span>
              <input
                type="text"
                autoComplete="name"
                className={`${input} mt-1 w-full`}
                value={guestName}
                onChange={(event) => setGuestName(event.target.value)}
              />
            </label>
            <p className="text-xs text-brand-textMuted sm:col-span-2">
              Nothing is charged. You can read the quote, reply and pay from this browser for{" "}
              {GUEST_ACCESS_WINDOW_LABEL}, and we email you a 6-digit code to open it after that — or{" "}
              <a href={`/auth/login?next=${encodeURIComponent(`/catalog/${product.slug}`)}`} className="underline hover:no-underline">
                sign in
              </a>{" "}
              to keep it in your account.
            </p>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="ui-notice ui-notice-danger mt-3">
            {error}
          </p>
        ) : null}

        {!canRequest ? (
          <p className="ui-notice ui-notice-danger mt-5">
            This item is not accepting requests right now. Check back soon.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-3">
          {step > 1 ? (
            <button type="button" onClick={() => setStep(step === 3 ? 2 : 1)} className="ui-btn ui-btn-ghost">
              Back
            </button>
          ) : null}
          {step === 1 ? (
            <button
              type="button"
              disabled={!canRequest}
              onClick={() => advance(2)}
              className="ui-btn ui-btn-primary flex-1 disabled:opacity-50"
            >
              Continue to delivery
            </button>
          ) : step === 2 ? (
            <button type="button" onClick={() => advance(3)} className="ui-btn ui-btn-primary flex-1">
              Review request
            </button>
          ) : (
            <button disabled={busy || !canRequest} className="ui-btn ui-btn-primary flex-1 disabled:opacity-50">
              {busy ? "Reserving…" : canRequest ? "Submit request — no charge" : "Requests paused"}
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
