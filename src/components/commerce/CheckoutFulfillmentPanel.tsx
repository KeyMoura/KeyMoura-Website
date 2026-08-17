"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCents, useCart } from "@/lib/hooks/useCart";

/**
 * Choosing how an order arrives.
 *
 * Every number this produces came from the server. It sends a *method id* and
 * an address and reports back the totals the server computed from them; it
 * never adds a shipping charge to a subtotal itself, and it has no arithmetic
 * of its own to get wrong. The checkout route recomputes the same quote from
 * the same function, so a stale panel cannot become a wrong charge — it can
 * only become a refusal.
 *
 * ## Why it no longer draws a card
 *
 * It used to be a `ui-card` headed "Delivery", sitting under the order summary
 * as a section of its own. That put the choice that *sets the shipping charge*
 * below the box that *shows the total*, so a customer read a total, scrolled
 * past it to a settings panel, changed something, and had to scroll back up to
 * find out what it had done. The two were one decision presented as two
 * unrelated blocks.
 *
 * So this renders bare and the cart page places it inside the summary, above
 * the price ladder — options first, then Subtotal, Shipping, Tax, Total, which
 * is the order every checkout is read in. Nothing about the quoting changed;
 * what moved is where the control is drawn.
 *
 * ## What it reports
 *
 * `onChange` reports a `FulfillmentState`, not just a completed selection. The
 * summary has to label its delivery row "Shipping" or "Pickup" *while the
 * address is still being typed* — before there is anything to check out with —
 * and a callback that only fires `null` until the form is complete cannot say
 * which of the two is being filled in. `selection` is still the only thing the
 * checkout button is allowed to act on.
 */

type MethodAvailability = { method: "shipping" | "pickup" | "none"; available: boolean; reason: string };

type ShippingMethod = {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  deliveryEstimate: string;
  freeThresholdCents: number | null;
};

export type FulfillmentOptions = {
  methods: MethodAvailability[];
  shippingMethods: ShippingMethod[];
  destinationCountries: string[];
  destinationRegions: Record<string, string[]>;
  handlingNote: string;
  amountToFreeShippingCents: number | null;
  pickup: {
    enabled: boolean;
    locationName: string;
    instructions: string;
    hoursText: string;
    addressLines: string[] | null;
  };
  supportEmail: string;
  /** Who the server thinks this visitor is, and whether the shop takes guests. */
  signedIn: boolean;
  guestCheckout: boolean;
  guestRequests: boolean;
};

export type FulfillmentSelection = {
  fulfillmentMethod: "shipping" | "pickup" | "none";
  shippingMethodId?: string;
  shippingAddress?: Record<string, string>;
};

export type FulfillmentMethod = "shipping" | "pickup" | "none";

/**
 * What the customer has chosen so far, complete or not.
 *
 * `method` is what the summary's delivery row is named after. `selection` is
 * the only thing checkout may be started with, and it stays `null` until the
 * choice is complete — an address half typed is not a delivery.
 */
export type FulfillmentState = {
  method: FulfillmentMethod | "";
  selection: FulfillmentSelection | null;
};

export const EMPTY_FULFILLMENT_STATE: FulfillmentState = { method: "", selection: null };

export type QuotedTotals = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  taxCents: number;
  totalCents: number;
};

const EMPTY_ADDRESS = {
  name: "",
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "US",
  phone: "",
};

const METHOD_LABELS: Record<string, string> = {
  shipping: "Ship it to me",
  pickup: "Collect it locally",
  none: "Nothing to deliver",
};

export default function CheckoutFulfillmentPanel({
  onChange,
  onTotals,
}: {
  onChange: (state: FulfillmentState) => void;
  onTotals: (totals: QuotedTotals | null) => void;
}) {
  const [options, setOptions] = useState<FulfillmentOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<FulfillmentMethod | "">("");
  const [shippingMethodId, setShippingMethodId] = useState("");
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [quoteError, setQuoteError] = useState("");
  const [quoting, setQuoting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/cart/fulfillment", { credentials: "same-origin" });
        const payload = (await response.json()) as FulfillmentOptions;
        if (cancelled) return;
        setOptions(payload);
        // Preselect only when there is exactly one real choice. Choosing on the
        // customer's behalf between two is how somebody pays for delivery of
        // something they meant to collect.
        const usable = payload.methods.filter((entry) => entry.available);
        if (usable.length === 1) setMethod(usable[0].method);
        if (payload.shippingMethods.length === 1) setShippingMethodId(payload.shippingMethods[0].id);
      } catch {
        if (!cancelled) setQuoteError("Delivery options could not be loaded. Refresh and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const regionsForCountry = options?.destinationRegions?.[address.country] ?? [];

  const selection = useMemo<FulfillmentSelection | null>(() => {
    if (!method) return null;
    if (method === "shipping") {
      if (!shippingMethodId) return null;
      if (!address.name.trim() || !address.line1.trim() || !address.city.trim() || !address.postalCode.trim()) return null;
      return { fulfillmentMethod: "shipping", shippingMethodId, shippingAddress: address };
    }
    return { fulfillmentMethod: method };
  }, [method, shippingMethodId, address]);

  const requestQuote = useCallback(async (current: FulfillmentSelection | null) => {
    if (!current) {
      onTotals(null);
      setQuoteError("");
      return;
    }
    setQuoting(true);
    try {
      const response = await fetch("/api/cart/fulfillment", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(current),
      });
      const payload = (await response.json().catch(() => null)) as
        | { totals?: QuotedTotals; error?: string }
        | null;
      if (!response.ok || !payload?.totals) {
        setQuoteError(payload?.error || "That delivery option could not be priced.");
        onTotals(null);
        return;
      }
      setQuoteError("");
      onTotals(payload.totals);
    } catch {
      setQuoteError("That delivery option could not be priced. Check your connection.");
      onTotals(null);
    } finally {
      setQuoting(false);
    }
  }, [onTotals]);

  /**
   * The cart state a quote is priced *against*.
   *
   * Read here rather than passed down, because a quote depends on the cart's
   * subtotal and discount just as much as on the delivery method — and until
   * this dependency existed, applying a discount code left the previous quote,
   * and therefore the summary's Total, describing the pre-discount cart.
   */
  const { data: cart } = useCart();
  const pricingBasis = `${cart?.subtotalCents ?? 0}:${cart?.discountCents ?? 0}:${cart?.itemCount ?? 0}`;

  useEffect(() => {
    onChange({ method, selection });
    // Debounced so typing an address does not fire a request per keystroke.
    const timer = setTimeout(() => void requestQuote(selection), 400);
    return () => clearTimeout(timer);
  }, [method, selection, onChange, requestQuote, pricingBasis]);

  if (loading) {
    return <p className="cart-delivery text-sm text-brand-textMuted">Loading delivery options…</p>;
  }

  if (!options) {
    return (
      <p role="alert" className="cart-delivery text-sm text-amber-200">
        Delivery options could not be loaded. Refresh and try again.
      </p>
    );
  }

  const usable = options.methods.filter((entry) => entry.available);
  const unusable = options.methods.filter((entry) => !entry.available && entry.reason);

  if (!usable.length) {
    return (
      <div className="cart-delivery">
        <p role="alert" className="ui-notice ui-notice-danger text-sm">
          This order cannot be delivered right now.{" "}
          {options.supportEmail ? `Contact ${options.supportEmail} and we will help.` : "Send a message and we will help."}
        </p>
        <ul className="mt-3 space-y-1 text-xs text-brand-textMuted">
          {unusable.map((entry) => (
            <li key={entry.method}>{entry.reason}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className="cart-delivery" data-testid="cart-delivery">
      {/*
        A segmented pair rather than a stack of bordered rows.

        Two full-width cards with radio dots, each three lines tall, was a
        settings panel — and in the summary column it is now in, it would be
        taller than the entire price ladder beneath it. The choice is between
        two things and it belongs on one line, with the selected one visibly
        selected. They are still real radios: the input is the control, the
        label is its hit area, and arrow keys still move between them.
      */}
      <fieldset className="cart-delivery-methods">
        <legend className="cart-delivery-legend">How would you like to receive this?</legend>
        <div className="cart-delivery-choices">
          {usable.map((entry) => (
            <label
              key={entry.method}
              className={`cart-delivery-choice${method === entry.method ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name="fulfillment-method"
                value={entry.method}
                checked={method === entry.method}
                onChange={() => setMethod(entry.method)}
                className="sr-only"
              />
              <span className="cart-delivery-choice-label">{METHOD_LABELS[entry.method]}</span>
              {entry.method === "pickup" && options.pickup.locationName ? (
                <span className="cart-delivery-choice-meta">{options.pickup.locationName}</span>
              ) : null}
            </label>
          ))}
        </div>
        {/* Unavailable options are explained rather than hidden, so a customer
            expecting local pickup learns why it is not offered. */}
        {unusable.length ? (
          <ul className="mt-2 space-y-1 text-xs text-brand-textMuted">
            {unusable.map((entry) => (
              <li key={entry.method}>{entry.reason}</li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      {method === "pickup" ? (
        <div className="mt-3 rounded-[var(--control-radius)] border border-[var(--border)] p-3 text-sm">
          <p className="font-medium">{options.pickup.locationName || "Local pickup"}</p>
          {options.pickup.instructions ? (
            <p className="mt-1 whitespace-pre-line text-xs text-brand-textMuted">{options.pickup.instructions}</p>
          ) : null}
          {options.pickup.hoursText ? (
            <p className="mt-1 whitespace-pre-line text-xs text-brand-textMuted">{options.pickup.hoursText}</p>
          ) : null}
          {/* The address appears here only when the shop has chosen to publish
              it before an order is ready; otherwise it arrives with the
              ready-for-pickup message. */}
          {options.pickup.addressLines?.length ? (
            <address className="mt-2 not-italic text-xs text-brand-textMuted">
              {options.pickup.addressLines.map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </address>
          ) : (
            <p className="mt-2 text-xs text-brand-textMuted">
              We will send the collection address when your order is ready.
            </p>
          )}
        </div>
      ) : null}

      {method === "shipping" ? (
        <>
          <fieldset className="mt-5">
            <legend className="text-sm font-medium">Delivery address</legend>
            <div className="mt-2 grid gap-2">
              <AddressField id="ship-name" label="Full name" value={address.name} onChange={(v) => setAddress({ ...address, name: v })} autoComplete="name" required />
              <AddressField id="ship-line1" label="Address" value={address.line1} onChange={(v) => setAddress({ ...address, line1: v })} autoComplete="address-line1" required />
              <AddressField id="ship-line2" label="Apartment, suite (optional)" value={address.line2} onChange={(v) => setAddress({ ...address, line2: v })} autoComplete="address-line2" />
              <div className="grid gap-2 sm:grid-cols-2">
                <AddressField id="ship-city" label="City" value={address.city} onChange={(v) => setAddress({ ...address, city: v })} autoComplete="address-level2" required />
                {regionsForCountry.length ? (
                  <div>
                    <label className="text-xs text-brand-textMuted" htmlFor="ship-region">
                      State / region
                    </label>
                    <select
                      id="ship-region"
                      className="ui-input mt-1 w-full"
                      value={address.region}
                      onChange={(event) => setAddress({ ...address, region: event.target.value })}
                    >
                      <option value="">Choose…</option>
                      {regionsForCountry.map((region) => (
                        <option key={region} value={region}>
                          {region}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <AddressField id="ship-region" label="State / region" value={address.region} onChange={(v) => setAddress({ ...address, region: v })} autoComplete="address-level1" />
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <AddressField id="ship-postal" label="Postal code" value={address.postalCode} onChange={(v) => setAddress({ ...address, postalCode: v })} autoComplete="postal-code" required />
                <div>
                  <label className="text-xs text-brand-textMuted" htmlFor="ship-country">
                    Country
                  </label>
                  <select
                    id="ship-country"
                    className="ui-input mt-1 w-full"
                    value={address.country}
                    onChange={(event) => setAddress({ ...address, country: event.target.value, region: "" })}
                  >
                    {options.destinationCountries.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </fieldset>

          <fieldset className="mt-5">
            <legend className="text-sm font-medium">Delivery speed</legend>
            <div className="mt-2 space-y-2">
              {options.shippingMethods.map((entry) => (
                <label
                  key={entry.id}
                  className="flex cursor-pointer items-start justify-between gap-3 rounded-lg border border-[var(--border)] p-3 text-sm hover:border-brand-accent/60"
                >
                  <span className="flex items-start gap-3">
                    <input
                      type="radio"
                      name="shipping-method"
                      value={entry.id}
                      checked={shippingMethodId === entry.id}
                      onChange={() => setShippingMethodId(entry.id)}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">{entry.name}</span>
                      {entry.deliveryEstimate ? (
                        <span className="block text-xs text-brand-textMuted">{entry.deliveryEstimate}</span>
                      ) : null}
                      {entry.description ? (
                        <span className="block text-xs text-brand-textMuted">{entry.description}</span>
                      ) : null}
                    </span>
                  </span>
                  <span className="whitespace-nowrap font-medium">{formatCents(entry.priceCents)}</span>
                </label>
              ))}
            </div>
            {options.amountToFreeShippingCents && options.amountToFreeShippingCents > 0 ? (
              <p className="mt-2 text-xs text-brand-textMuted">
                Spend {formatCents(options.amountToFreeShippingCents)} more for free delivery.
              </p>
            ) : null}
          </fieldset>
        </>
      ) : null}

      {options.handlingNote && method === "shipping" ? (
        <p className="mt-3 whitespace-pre-line text-xs text-brand-textMuted">{options.handlingNote}</p>
      ) : null}

      <p role="status" aria-live="polite" className="sr-only">
        {quoting ? "Pricing delivery" : ""}
      </p>
      {quoteError ? (
        <p role="alert" className="ui-notice ui-notice-danger mt-3 text-sm">
          {quoteError}
        </p>
      ) : null}
    </div>
  );
}

function AddressField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-brand-textMuted" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="ui-input mt-1 w-full"
        value={value}
        autoComplete={autoComplete}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
