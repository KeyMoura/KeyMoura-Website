"use client";

import { useCallback, useEffect, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import type { Address, CommerceSettings, ShippingMethod } from "@/lib/commerce/commerceSettings";
import type { CommercePolicy } from "@/lib/commerce/orderLifecycle";

/**
 * Shipping, local pickup, inventory and policy, in one place.
 *
 * Nothing here is consequential until Save is pressed. Selecting a value
 * changes local state and nothing else — the previous behaviour of these
 * settings living as constants scattered across route handlers is exactly what
 * made "what does this shop charge for delivery" unanswerable.
 *
 * Three addresses are edited separately and deliberately: the shipping origin,
 * the return address and the pickup location are frequently the same building
 * for a shop run from home, and publishing one because another was filled in is
 * how a private address ends up on a public page.
 */

type Payload = { settings: CommerceSettings; policy: CommercePolicy };

export default function CommerceSettingsPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canManage = permissions.has("commerce.settings.manage");

  const [settings, setSettings] = useState<CommerceSettings | null>(null);
  const [policy, setPolicy] = useState<CommercePolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (accessLoading || !permissions.has("commerce.settings.view")) return;
    void (async () => {
      try {
        const response = await fetch("/api/staff/commerce/settings", { credentials: "same-origin" });
        const payload = (await response.json()) as Payload & { error?: string };
        if (!response.ok) {
          setError(payload.error || "Could not load commerce settings.");
          return;
        }
        setSettings(payload.settings);
        setPolicy(payload.policy);
      } catch {
        setError("Could not load commerce settings.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessLoading, access?.permissions]);

  // A mid-edit tab close is guarded, because these values are typed by hand and
  // losing them silently is worse than an extra prompt.
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const patch = useCallback((next: Partial<CommerceSettings>) => {
    setDirty(true);
    setSaved("");
    setSettings((current) => (current ? { ...current, ...next } : current));
  }, []);

  async function save() {
    if (!settings || !policy) return;
    setSaving(true);
    setProblems([]);
    setError("");
    try {
      const response = await fetch("/api/staff/commerce/settings", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings, policy }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        setProblems(payload?.problems ?? [payload?.error ?? "Could not save."]);
        return;
      }
      setSettings(payload.settings);
      setPolicy(payload.policy);
      setDirty(false);
      setSaved(
        payload.changedSections?.length
          ? `Saved: ${payload.changedSections.join(", ")}.`
          : "Saved. Nothing had changed."
      );
    } catch {
      setError("Could not save. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  if (accessLoading || loading) return <div className="ui-card text-sm text-brand-textMuted">Loading settings…</div>;
  if (!permissions.has("commerce.settings.view")) {
    return <AccessDeniedCard message="You need the commerce.settings.view permission to see these settings." />;
  }
  if (error) return <p role="alert" className="ui-notice ui-notice-danger text-sm">{error}</p>;
  if (!settings || !policy) return null;

  const disabled = !canManage || saving;

  return (
    <main className="page-stack">
      <header>
        <p className="ui-eyebrow">Commerce</p>
        <h1 className="mt-1 text-3xl font-semibold">Shipping, pickup &amp; inventory</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">
          Nothing here takes effect until you press Save. Shipping and local pickup are off until you turn them on, so
          an unconfigured option refuses clearly rather than quoting a price it invented.
        </p>
        {!canManage ? (
          <p className="ui-notice ui-notice-warning mt-3 text-sm">
            You can read these settings but not change them. That needs the commerce.settings.manage permission.
          </p>
        ) : null}
      </header>

      {/* ---------------------------------------------------------------- */}
      <Section title="Business" hint="Used on customer-facing pages and in email.">
        <Field label="Public business name">
          <input className="ui-input w-full" disabled={disabled} value={settings.business.publicName}
            onChange={(e) => patch({ business: { ...settings.business, publicName: e.target.value } })} />
        </Field>
        <Field label="Support email" hint="Where customers are told to write.">
          <input className="ui-input w-full" type="email" disabled={disabled} value={settings.business.supportEmail}
            onChange={(e) => patch({ business: { ...settings.business, supportEmail: e.target.value } })} />
        </Field>
        <Field label="Timezone">
          <input className="ui-input w-full" disabled={disabled} value={settings.business.timezone}
            onChange={(e) => patch({ business: { ...settings.business, timezone: e.target.value } })} />
        </Field>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section
        title="Shipping"
        hint="The origin address is where parcels are posted from. It is never shown to a customer."
      >
        <Toggle
          label="Offer shipping"
          checked={settings.shipping.enabled}
          disabled={disabled}
          onChange={(enabled) => patch({ shipping: { ...settings.shipping, enabled } })}
        />

        {settings.shipping.enabled ? (
          <>
            <Field label="Origin name">
              <input className="ui-input w-full" disabled={disabled} value={settings.shipping.originName}
                onChange={(e) => patch({ shipping: { ...settings.shipping, originName: e.target.value } })} />
            </Field>
            <AddressFields
              legend="Origin address (private)"
              value={settings.shipping.originAddress}
              disabled={disabled}
              onChange={(originAddress) => patch({ shipping: { ...settings.shipping, originAddress } })}
            />

            <Field label="Destination countries" hint="Two-letter codes, comma separated. Anything else is refused at checkout.">
              <input className="ui-input w-full" disabled={disabled}
                value={settings.shipping.destinationCountries.join(", ")}
                onChange={(e) =>
                  patch({
                    shipping: {
                      ...settings.shipping,
                      destinationCountries: e.target.value.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean),
                    },
                  })
                } />
            </Field>

            <Field label="Free shipping over" hint="In cents. Leave blank for no free-shipping rule.">
              <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
                value={settings.shipping.freeShippingThresholdCents ?? ""}
                onChange={(e) =>
                  patch({
                    shipping: {
                      ...settings.shipping,
                      freeShippingThresholdCents: e.target.value.trim() === "" ? null : Number(e.target.value) || 0,
                    },
                  })
                } />
            </Field>

            <MethodsEditor
              methods={settings.shipping.methods}
              disabled={disabled}
              onChange={(methods) => patch({ shipping: { ...settings.shipping, methods } })}
            />

            <Field label="Handling note" hint="Shown to the customer at checkout. Optional.">
              <textarea className="ui-input w-full" rows={2} disabled={disabled} value={settings.shipping.handlingNote}
                onChange={(e) => patch({ shipping: { ...settings.shipping, handlingNote: e.target.value } })} />
            </Field>
          </>
        ) : null}
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Local pickup" hint="Customers collect in person. The address is withheld until an order is ready unless you say otherwise.">
        <Toggle
          label="Offer local pickup"
          checked={settings.pickup.enabled}
          disabled={disabled}
          onChange={(enabled) => patch({ pickup: { ...settings.pickup, enabled } })}
        />
        {settings.pickup.enabled ? (
          <>
            <Field label="Location name">
              <input className="ui-input w-full" disabled={disabled} value={settings.pickup.locationName}
                onChange={(e) => patch({ pickup: { ...settings.pickup, locationName: e.target.value } })} />
            </Field>
            <AddressFields
              legend="Pickup address"
              value={settings.pickup.address}
              disabled={disabled}
              onChange={(addr) => patch({ pickup: { ...settings.pickup, address: addr } })}
            />
            <Field label="Customer-visible instructions" hint="Exactly what the customer is told. Required when pickup is on.">
              <textarea className="ui-input w-full" rows={3} disabled={disabled} value={settings.pickup.instructions}
                onChange={(e) => patch({ pickup: { ...settings.pickup, instructions: e.target.value } })} />
            </Field>
            <Field label="Pickup hours" hint="Free text. Leave blank rather than promising hours you cannot keep.">
              <textarea className="ui-input w-full" rows={2} disabled={disabled} value={settings.pickup.hoursText}
                onChange={(e) => patch({ pickup: { ...settings.pickup, hoursText: e.target.value } })} />
            </Field>
            <Toggle label="Email the customer when an order is ready to collect" checked={settings.pickup.notifyWhenReady}
              disabled={disabled} onChange={(v) => patch({ pickup: { ...settings.pickup, notifyWhenReady: v } })} />
            <Toggle label="Show the pickup address before an order is ready" checked={settings.pickup.revealAddressBeforeReady}
              disabled={disabled} onChange={(v) => patch({ pickup: { ...settings.pickup, revealAddressBeforeReady: v } })} />
          </>
        ) : null}
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Inventory" hint="How stock is held during checkout, and when to warn about running low.">
        <Field label="Hold stock for (minutes)" hint="How long a checkout keeps stock. Stripe requires at least 30.">
          <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
            value={settings.inventory.reservationMinutes}
            onChange={(e) => patch({ inventory: { ...settings.inventory, reservationMinutes: Number(e.target.value) || 0 } })} />
        </Field>
        <Field label="Default low-stock threshold">
          <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
            value={settings.inventory.lowStockThresholdDefault}
            onChange={(e) => patch({ inventory: { ...settings.inventory, lowStockThresholdDefault: Number(e.target.value) || 0 } })} />
        </Field>
        <Toggle label="Release the hold when a payment fails" checked={settings.inventory.releaseOnPaymentFailure}
          disabled={disabled} onChange={(v) => patch({ inventory: { ...settings.inventory, releaseOnPaymentFailure: v } })} />
        <Field label="Low-stock alert recipients" hint="Comma separated. Staff notifications are sent regardless.">
          <input className="ui-input w-full" disabled={disabled} value={settings.inventory.lowStockRecipients.join(", ")}
            onChange={(e) =>
              patch({ inventory: { ...settings.inventory, lowStockRecipients: e.target.value.split(/[,\s;]+/).filter(Boolean) } })
            } />
        </Field>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Return address" hint="Snapshotted onto a return when it is approved, so a later change never redirects a parcel already in the post.">
        <AddressFields
          legend="Return address"
          value={settings.returnAddress}
          disabled={disabled}
          onChange={(returnAddress) => patch({ returnAddress })}
        />
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Cancellations and returns" hint="Read by the lifecycle rules that decide what a customer may do.">
        <Field label="Return window (days)" hint="0 means no time limit.">
          <input className="ui-input w-full" inputMode="numeric" disabled={disabled} value={policy.returns.windowDays}
            onChange={(e) => {
              setDirty(true);
              setPolicy({ ...policy, returns: { ...policy.returns, windowDays: Number(e.target.value) || 0 } });
            }} />
        </Field>
        <Toggle label="Returns are accepted" checked={policy.returns.enabled} disabled={disabled}
          onChange={(v) => { setDirty(true); setPolicy({ ...policy, returns: { ...policy.returns, enabled: v } }); }} />
        <Toggle label="Custom and personalized work is returnable" checked={policy.returns.allowCustomProducts} disabled={disabled}
          onChange={(v) => { setDirty(true); setPolicy({ ...policy, returns: { ...policy.returns, allowCustomProducts: v } }); }} />
        <Toggle label="Paid orders may be cancelled by request" checked={policy.cancellation.allowPaidRequests} disabled={disabled}
          onChange={(v) => { setDirty(true); setPolicy({ ...policy, cancellation: { ...policy.cancellation, allowPaidRequests: v } }); }} />
        <Toggle label="Block cancellation once materials are committed" checked={policy.cancellation.blockAfterMaterialsOrdered} disabled={disabled}
          onChange={(v) => { setDirty(true); setPolicy({ ...policy, cancellation: { ...policy.cancellation, blockAfterMaterialsOrdered: v } }); }} />
        <Field label="Return instructions" hint="Shown to a customer whose return is approved.">
          <textarea className="ui-input w-full" rows={3} disabled={disabled} value={policy.returns.instructions}
            onChange={(e) => { setDirty(true); setPolicy({ ...policy, returns: { ...policy.returns, instructions: e.target.value } }); }} />
        </Field>
      </Section>

      {/* ---------------------------------------------------------------- */}
      <Section title="Email" hint="Sender identity and which categories of message are sent.">
        <Field label="Reply-To address">
          <input className="ui-input w-full" type="email" disabled={disabled} value={settings.email.replyTo}
            onChange={(e) => patch({ email: { ...settings.email, replyTo: e.target.value } })} />
        </Field>
        <Field label="Staff alert recipients" hint="Comma separated.">
          <input className="ui-input w-full" disabled={disabled} value={settings.email.staffAlertRecipients.join(", ")}
            onChange={(e) => patch({ email: { ...settings.email, staffAlertRecipients: e.target.value.split(/[,\s;]+/).filter(Boolean) } })} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(settings.email.categories) as (keyof CommerceSettings["email"]["categories"])[]).map((key) => (
            <Toggle
              key={key}
              label={`Send ${key} email`}
              checked={settings.email.categories[key]}
              disabled={disabled}
              onChange={(v) => patch({ email: { ...settings.email, categories: { ...settings.email.categories, [key]: v } } })}
            />
          ))}
        </div>
      </Section>

      {problems.length ? (
        <div role="alert" className="ui-notice ui-notice-danger text-sm">
          <p className="font-medium">This could not be saved:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {saved ? (
        <p role="status" className="ui-notice ui-notice-success text-sm">
          {saved}
        </p>
      ) : null}

      <div className="sticky bottom-4 flex items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={disabled || !dirty}
          className="ui-btn ui-btn-primary disabled:opacity-50">
          {saving ? "Saving…" : "Save changes"}
        </button>
        {dirty ? <span className="text-xs text-brand-textMuted">Unsaved changes</span> : null}
      </div>
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="ui-card">
      <h2 className="text-lg font-semibold">{title}</h2>
      {hint ? <p className="mt-1 text-sm text-brand-textMuted">{hint}</p> : null}
      <div className="mt-4 grid gap-3">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="font-medium">{label}</span>
      {hint ? <span className="mt-0.5 block text-xs text-brand-textMuted">{hint}</span> : null}
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function AddressFields({ legend, value, disabled, onChange }: { legend: string; value: Address; disabled: boolean; onChange: (a: Address) => void }) {
  const set = (key: keyof Address) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: event.target.value });
  return (
    <fieldset className="rounded-lg border border-[var(--border)] p-3">
      <legend className="px-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Name"><input className="ui-input w-full" disabled={disabled} value={value.name} onChange={set("name")} /></Field>
        <Field label="Phone"><input className="ui-input w-full" disabled={disabled} value={value.phone} onChange={set("phone")} /></Field>
        <Field label="Address line 1"><input className="ui-input w-full" disabled={disabled} value={value.line1} onChange={set("line1")} /></Field>
        <Field label="Address line 2"><input className="ui-input w-full" disabled={disabled} value={value.line2} onChange={set("line2")} /></Field>
        <Field label="City"><input className="ui-input w-full" disabled={disabled} value={value.city} onChange={set("city")} /></Field>
        <Field label="State / region"><input className="ui-input w-full" disabled={disabled} value={value.region} onChange={set("region")} /></Field>
        <Field label="Postal code"><input className="ui-input w-full" disabled={disabled} value={value.postalCode} onChange={set("postalCode")} /></Field>
        <Field label="Country"><input className="ui-input w-full" maxLength={2} disabled={disabled} value={value.country} onChange={set("country")} /></Field>
      </div>
    </fieldset>
  );
}

function MethodsEditor({ methods, disabled, onChange }: { methods: ShippingMethod[]; disabled: boolean; onChange: (m: ShippingMethod[]) => void }) {
  const update = (index: number, next: Partial<ShippingMethod>) =>
    onChange(methods.map((method, i) => (i === index ? { ...method, ...next } : method)));

  return (
    <fieldset className="rounded-lg border border-[var(--border)] p-3">
      <legend className="px-1 text-sm font-medium">Delivery methods</legend>
      {!methods.length ? (
        <p className="text-sm text-brand-textMuted">No methods yet. Shipping cannot be turned on without one.</p>
      ) : null}
      <div className="grid gap-3">
        {methods.map((method, index) => (
          <div key={method.id || index} className="rounded-lg border border-[var(--border)] p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="Name"><input className="ui-input w-full" disabled={disabled} value={method.name}
                onChange={(e) => update(index, { name: e.target.value })} /></Field>
              <Field label="Price (cents)"><input className="ui-input w-full" inputMode="numeric" disabled={disabled} value={method.priceCents}
                onChange={(e) => update(index, { priceCents: Number(e.target.value) || 0 })} /></Field>
              <Field label="Delivery estimate"><input className="ui-input w-full" disabled={disabled} value={method.deliveryEstimate}
                onChange={(e) => update(index, { deliveryEstimate: e.target.value })} /></Field>
              <Field label="Free over (cents, blank for none)"><input className="ui-input w-full" inputMode="numeric" disabled={disabled}
                value={method.freeThresholdCents ?? ""}
                onChange={(e) => update(index, { freeThresholdCents: e.target.value.trim() === "" ? null : Number(e.target.value) || 0 })} /></Field>
            </div>
            <Field label="Description"><input className="ui-input w-full" disabled={disabled} value={method.description}
              onChange={(e) => update(index, { description: e.target.value })} /></Field>
            <div className="mt-2 flex items-center justify-between">
              <Toggle label="Offered at checkout" checked={method.enabled} disabled={disabled}
                onChange={(v) => update(index, { enabled: v })} />
              <button type="button" disabled={disabled} className="ui-btn ui-btn-secondary text-xs"
                onClick={() => {
                  // Removing a method never rewrites an order that used it: the
                  // order carries its own snapshot.
                  if (!window.confirm(`Remove "${method.name || "this method"}" from checkout?`)) return;
                  onChange(methods.filter((_, i) => i !== index));
                }}>
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      <button type="button" disabled={disabled} className="ui-btn ui-btn-secondary mt-3 text-xs"
        onClick={() =>
          onChange([
            ...methods,
            { id: `method-${methods.length + 1}`, name: "", description: "", priceCents: 0, freeThresholdCents: null, deliveryEstimate: "", enabled: true },
          ])
        }>
        Add a delivery method
      </button>
    </fieldset>
  );
}
