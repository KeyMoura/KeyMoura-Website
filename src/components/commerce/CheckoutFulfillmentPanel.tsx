"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatCents } from "@/lib/hooks/useCart";

/**
 * Choosing how an order arrives, and seeing what that costs.
 *
 * Every number shown here came from the server. The panel sends a *method id*
 * and an address and renders the totals the server computed from them; it never
 * adds a shipping charge to a subtotal itself. The checkout route recomputes
 * the same quote from the same function, so a stale panel cannot become a
 * wrong charge — it can only become a refusal.
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
  onChange: (selection: FulfillmentSelection | null) => void;
  onTotals: (totals: QuotedTotals | null) => void;
}) {
  const [options, setOptions] = useState<FulfillmentOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [method, setMethod] = useState<"shipping" | "pickup" | "none" | "">("");
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

  useEffect(() => {
    onChange(selection);
    // Debounced so typing an address does not fire a request per keystroke.
    const timer = setTimeout(() => void requestQuote(selection), 400);
    return () => clearTimeout(timer);
  }, [selection, onChange, requestQuote]);

  if (loading) {
    return (
      <div className="ui-card">
        <p className="text-sm text-brand-textMuted">Loading delivery options…</p>
      </div>
    );
  }

  if (!options) {
    return (
      <div className="ui-card">
        <p role="alert" className="text-sm text-amber-200">
          Delivery options could not be loaded. Refresh and try again.
        </p>
      </div>
    );
  }

  const usable = options.methods.filter((entry) => entry.available);
  const unusable = options.methods.filter((entry) => !entry.available && entry.reason);

  if (!usable.length) {
    return (
      <div className="ui-card">
        <h2 className="text-lg font-semibold">Delivery</h2>
        <p role="alert" className="ui-notice ui-notice-danger mt-3 text-sm">
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
    <div className="ui-card">
      <h2 className="text-lg font-semibold">Delivery</h2>

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">How would you like to receive this?</legend>
        <div className="mt-2 space-y-2">
          {usable.map((entry) => (
            <label
              key={entry.method}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--border)] p-3 text-sm hover:border-brand-accent/60"
            >
              <input
                type="radio"
                name="fulfillment-method"
                value={entry.method}
                checked={method === entry.method}
                onChange={() => setMethod(entry.method)}
                className="mt-1"
              />
              <span>
                <span className="font-medium">{METHOD_LABELS[entry.method]}</span>
                {entry.method === "pickup" && options.pickup.locationName ? (
                  <span className="block text-xs text-brand-textMuted">{options.pickup.locationName}</span>
                ) : null}
              </span>
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
        <div className="mt-4 rounded-lg border border-[var(--border)] p-3 text-sm">
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
