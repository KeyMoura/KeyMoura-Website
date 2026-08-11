"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Field, Notice } from "@/components/ui/DesignSystem";
import {
  Card,
  CheckField,
  EmptyState,
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
import { useHashTab } from "@/lib/hooks/useHashTab";
import type { StaffTab } from "@/lib/staff/pageFramework";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import type { Address, CommerceSettings, ShippingMethod } from "@/lib/commerce/commerceSettings";
import type { CommercePolicy } from "@/lib/commerce/orderLifecycle";

/**
 * Commerce configuration.
 *
 * ## What this pass changed
 *
 * Seven `ui-card` sections stacked in one column — Business, Shipping, Local
 * pickup, Inventory, Return address, Cancellations and returns, Email — inside
 * a single `<form>`-less page with one Save at the bottom. Finding "how long
 * does a checkout hold stock" meant scrolling past two addresses and a delivery
 * method editor. Two of the seven cards contained `<fieldset>`s that contained
 * more bordered boxes, each holding four `Field`s: a panel inside a card inside
 * a card, three borders deep before the first input.
 *
 * Now: **seven tabs, one per decision a shop makes** — Checkout, Shipping,
 * Pickup, Inventory, Returns, Cancellations, Notifications — with fields filed
 * where somebody would look for them rather than where the type happens to nest
 * them. The return address moved from a section of its own onto Returns; the
 * reservation duration moved from Inventory onto Checkout, because it is a rule
 * about how long a customer may take to pay; sender and recipient addresses all
 * gathered onto Notifications.
 *
 * The `<fieldset>` borders are gone. An address is a labelled group of fields,
 * and a heading with whitespace under it says so without drawing a third box.
 *
 * Nothing here takes effect until Save is pressed, and there is still exactly
 * one Save — now in the shared save bar, so it looks and behaves like the one
 * on the product editor.
 *
 * Three addresses are edited separately and deliberately: the shipping origin,
 * the return address and the pickup location are frequently the same building
 * for a shop run from home, and publishing one because another was filled in is
 * how a private address ends up on a public page.
 */

type Payload = { settings: CommerceSettings; policy: CommercePolicy };

/** Written once, so the loading header and the loaded header cannot drift apart. */
const COMMERCE_DESCRIPTION =
  "How orders are paid for, delivered, returned and announced. Nothing takes effect until you press Save.";

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

  const tabs = useMemo<StaffTab[]>(
    () => [
      { id: "checkout", label: "Checkout" },
      { id: "shipping", label: "Shipping" },
      { id: "pickup", label: "Pickup" },
      { id: "inventory", label: "Inventory" },
      { id: "returns", label: "Returns" },
      { id: "cancellations", label: "Cancellations" },
      { id: "notifications", label: "Notifications" },
    ],
    []
  );
  const [tab, setTab] = useHashTab(tabs);

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

  const patchPolicy = useCallback((next: Partial<CommercePolicy>) => {
    setDirty(true);
    setSaved("");
    setPolicy((current) => (current ? { ...current, ...next } : current));
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

  /*
   * Access first, then the titled loading state.
   *
   * These were one `accessLoading || loading` early return of a bare
   * `LoadingState`, so the page had no title heading at all while it loaded —
   * measured on the running page, and the reason Email, Commerce and Automation
   * were the three staff pages whose name only appeared once their data
   * arrived. The split matters: the header may only be drawn *after* the
   * permission check, or a viewer who is about to be refused would be shown the
   * page's name.
   */
  if (accessLoading) return <LoadingState>Loading settings…</LoadingState>;
  if (!permissions.has("commerce.settings.view")) {
    return <AccessDeniedCard message="You need the commerce.settings.view permission to see these settings." />;
  }
  if (loading) {
    return (
      <StaffPage>
        <PageHeader title="Commerce" description={COMMERCE_DESCRIPTION} />
        <LoadingState>Loading settings…</LoadingState>
      </StaffPage>
    );
  }
  if (error) return <Notice tone="danger" role="alert">{error}</Notice>;
  if (!settings || !policy) return null;

  const disabled = !canManage || saving;

  return (
    <StaffPage>
      <PageHeader title="Commerce" description={COMMERCE_DESCRIPTION} />

      {!canManage ? (
        <Notice tone="warning">
          You can read these settings but not change them. That needs the commerce.settings.manage permission.
        </Notice>
      ) : null}

      <PageTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Commerce settings sections" />

      {/* ---------------- Checkout ---------------- */}
      <TabPanel id="checkout" value={tab}>
        <Section title="Business identity" description="Used on customer-facing pages and in every email.">
          <Card>
            <FormGrid>
              <Field label="Public business name">
                <input className="ui-input w-full" disabled={disabled} value={settings.business.publicName}
                  onChange={(e) => patch({ business: { ...settings.business, publicName: e.target.value } })} />
              </Field>
              <Field label="Timezone" help="Decides what “today” means for due dates and overdue work.">
                <input className="ui-input w-full" disabled={disabled} value={settings.business.timezone}
                  onChange={(e) => patch({ business: { ...settings.business, timezone: e.target.value } })} />
              </Field>
            </FormGrid>
          </Card>
        </Section>

        <Section
          title="Holding stock during checkout"
          description="How long a customer has to finish paying before the stock they are holding goes back on sale."
        >
          <Card>
            <FormGrid>
              <Field
                label="Hold stock for (minutes)"
                help="Stripe requires at least 30. A shorter value is clamped up to it."
              >
                <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
                  value={settings.inventory.reservationMinutes}
                  onChange={(e) => patch({ inventory: { ...settings.inventory, reservationMinutes: Number(e.target.value) || 0 } })} />
              </Field>
            </FormGrid>
            <div className="mt-4">
              <CheckField
                label="Release the hold when a payment fails"
                help="Off means the stock stays held until the timer above expires."
                checked={settings.inventory.releaseOnPaymentFailure}
                disabled={disabled}
                onChange={(v) => patch({ inventory: { ...settings.inventory, releaseOnPaymentFailure: v } })}
              />
            </div>
          </Card>
        </Section>

        <Section
          title="Which delivery options checkout may offer"
          description="A cart holding a physical product refuses at checkout unless at least one of these is on."
        >
          <Card>
            <div className="grid gap-3">
              <CheckField
                label="Offer shipping"
                help="Configured under the Shipping tab."
                checked={settings.shipping.enabled}
                disabled={disabled}
                onChange={(enabled) => patch({ shipping: { ...settings.shipping, enabled } })}
              />
              <CheckField
                label="Offer local pickup"
                help="Configured under the Pickup tab."
                checked={settings.pickup.enabled}
                disabled={disabled}
                onChange={(enabled) => patch({ pickup: { ...settings.pickup, enabled } })}
              />
            </div>
            {!settings.shipping.enabled && !settings.pickup.enabled ? (
              <Notice tone="warning" className="mt-4">
                Neither is enabled, so a cart holding a physical product cannot be checked out at all.
              </Notice>
            ) : null}
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Shipping ---------------- */}
      <TabPanel id="shipping" value={tab}>
        {!settings.shipping.enabled ? (
          <EmptyState>
            Shipping is off, so none of this is used. Turn it on under Checkout to configure it.
          </EmptyState>
        ) : null}

        <Section
          title="Where parcels are posted from"
          description="The origin address is never shown to a customer. It is used to price and label a parcel."
        >
          <Card>
            <FormGrid>
              <Field label="Origin name">
                <input className="ui-input w-full" disabled={disabled} value={settings.shipping.originName}
                  onChange={(e) => patch({ shipping: { ...settings.shipping, originName: e.target.value } })} />
              </Field>
            </FormGrid>
            <div className="mt-5">
              <AddressFields
                legend="Origin address (private)"
                value={settings.shipping.originAddress}
                disabled={disabled}
                onChange={(originAddress) => patch({ shipping: { ...settings.shipping, originAddress } })}
              />
            </div>
          </Card>
        </Section>

        <Section title="Where you ship to" description="Anything outside this list is refused at checkout.">
          <Card>
            <FormGrid>
              <Field label="Destination countries" help="Two-letter codes, comma separated.">
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
              <Field label="Free shipping over (cents)" help="Leave blank for no free-shipping rule.">
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
            </FormGrid>
          </Card>
        </Section>

        <Section
          title="Delivery methods"
          description="What a customer chooses between at checkout, and what each one costs."
          actions={
            <button type="button" disabled={disabled} className="ui-btn ui-btn-secondary text-sm"
              onClick={() =>
                patch({
                  shipping: {
                    ...settings.shipping,
                    methods: [
                      ...settings.shipping.methods,
                      { id: `method-${settings.shipping.methods.length + 1}`, name: "", description: "", priceCents: 0, freeThresholdCents: null, deliveryEstimate: "", enabled: true },
                    ],
                  },
                })
              }>
              Add a method
            </button>
          }
        >
          {!settings.shipping.methods.length ? (
            <EmptyState>No methods yet. Shipping cannot be turned on without one.</EmptyState>
          ) : (
            settings.shipping.methods.map((method, index) => (
              <Card key={method.id || index}>
                <FormGrid>
                  <Field label="Name">
                    <input className="ui-input w-full" disabled={disabled} value={method.name}
                      onChange={(e) => updateMethod(settings, patch, index, { name: e.target.value })} />
                  </Field>
                  <Field label="Price (cents)">
                    <input className="ui-input w-full" inputMode="numeric" disabled={disabled} value={method.priceCents}
                      onChange={(e) => updateMethod(settings, patch, index, { priceCents: Number(e.target.value) || 0 })} />
                  </Field>
                  <Field label="Delivery estimate" help="Shown to the customer, e.g. “3–5 business days”.">
                    <input className="ui-input w-full" disabled={disabled} value={method.deliveryEstimate}
                      onChange={(e) => updateMethod(settings, patch, index, { deliveryEstimate: e.target.value })} />
                  </Field>
                  <Field label="Free over (cents)" help="Blank for none. A lower threshold here wins over the shop-wide one.">
                    <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
                      value={method.freeThresholdCents ?? ""}
                      onChange={(e) => updateMethod(settings, patch, index, { freeThresholdCents: e.target.value.trim() === "" ? null : Number(e.target.value) || 0 })} />
                  </Field>
                  <FormWide>
                    <Field label="Description">
                      <input className="ui-input w-full" disabled={disabled} value={method.description}
                        onChange={(e) => updateMethod(settings, patch, index, { description: e.target.value })} />
                    </Field>
                  </FormWide>
                </FormGrid>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <CheckField
                    label="Offered at checkout"
                    checked={method.enabled}
                    disabled={disabled}
                    onChange={(v) => updateMethod(settings, patch, index, { enabled: v })}
                  />
                  <button type="button" disabled={disabled} className="ui-btn ui-btn-danger text-sm"
                    onClick={() => {
                      // Removing a method never rewrites an order that used it:
                      // the order carries its own snapshot.
                      if (!window.confirm(`Remove "${method.name || "this method"}" from checkout?`)) return;
                      patch({ shipping: { ...settings.shipping, methods: settings.shipping.methods.filter((_, i) => i !== index) } });
                    }}>
                    Remove
                  </button>
                </div>
              </Card>
            ))
          )}
        </Section>

        <Section title="Packing" description="What a customer is told about how long packing takes.">
          <Card>
            <Field label="Handling note" help="Shown to the customer at checkout. Optional.">
              <textarea className="ui-input w-full" rows={2} disabled={disabled} value={settings.shipping.handlingNote}
                onChange={(e) => patch({ shipping: { ...settings.shipping, handlingNote: e.target.value } })} />
            </Field>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Pickup ---------------- */}
      <TabPanel id="pickup" value={tab}>
        {!settings.pickup.enabled ? (
          <EmptyState>
            Local pickup is off, so none of this is used. Turn it on under Checkout to configure it.
          </EmptyState>
        ) : null}

        <Section
          title="Where customers collect"
          description="The address is withheld until an order is ready unless you say otherwise."
        >
          <Card>
            <FormGrid>
              <Field label="Location name">
                <input className="ui-input w-full" disabled={disabled} value={settings.pickup.locationName}
                  onChange={(e) => patch({ pickup: { ...settings.pickup, locationName: e.target.value } })} />
              </Field>
            </FormGrid>
            <div className="mt-5">
              <AddressFields
                legend="Pickup address"
                value={settings.pickup.address}
                disabled={disabled}
                onChange={(addr) => patch({ pickup: { ...settings.pickup, address: addr } })}
              />
            </div>
          </Card>
        </Section>

        <Section title="What customers are told" description="The exact wording a customer collecting an order sees.">
          <Card>
            <div className="staff-form">
              <Field label="Customer-visible instructions" help="Required when pickup is on.">
                <textarea className="ui-input w-full" rows={3} disabled={disabled} value={settings.pickup.instructions}
                  onChange={(e) => patch({ pickup: { ...settings.pickup, instructions: e.target.value } })} />
              </Field>
              <Field label="Pickup hours" help="Free text. Leave blank rather than promising hours you cannot keep.">
                <textarea className="ui-input w-full" rows={2} disabled={disabled} value={settings.pickup.hoursText}
                  onChange={(e) => patch({ pickup: { ...settings.pickup, hoursText: e.target.value } })} />
              </Field>
              <CheckField
                label="Email the customer when an order is ready to collect"
                checked={settings.pickup.notifyWhenReady}
                disabled={disabled}
                onChange={(v) => patch({ pickup: { ...settings.pickup, notifyWhenReady: v } })}
              />
              <CheckField
                label="Show the pickup address before an order is ready"
                help="Off by default: until an order is ready, a customer has no reason to be given the address of the building the stock is in."
                checked={settings.pickup.revealAddressBeforeReady}
                disabled={disabled}
                onChange={(v) => patch({ pickup: { ...settings.pickup, revealAddressBeforeReady: v } })}
              />
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Inventory ---------------- */}
      <TabPanel id="inventory" value={tab}>
        <Section
          title="Defaults for new products"
          description="Each product can override these. Changing them here does not rewrite products that already exist."
        >
          <Card>
            <FormGrid>
              <Field label="Default low-stock threshold" help="The level at which the dashboard raises a warning.">
                <input className="ui-input w-full" inputMode="numeric" disabled={disabled}
                  value={settings.inventory.lowStockThresholdDefault}
                  onChange={(e) => patch({ inventory: { ...settings.inventory, lowStockThresholdDefault: Number(e.target.value) || 0 } })} />
              </Field>
            </FormGrid>
            <p className="mt-4 text-xs text-brand-textMuted">
              How long a checkout holds stock is a checkout rule, and lives under Checkout.
            </p>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Returns ---------------- */}
      <TabPanel id="returns" value={tab}>
        <Section title="Return policy" description="Read by the lifecycle rules that decide what a customer may do.">
          <Card>
            <div className="staff-form">
              <CheckField
                label="Returns are accepted"
                checked={policy.returns.enabled}
                disabled={disabled}
                onChange={(v) => patchPolicy({ returns: { ...policy.returns, enabled: v } })}
              />
              <CheckField
                label="Custom and personalized work is returnable"
                checked={policy.returns.allowCustomProducts}
                disabled={disabled}
                onChange={(v) => patchPolicy({ returns: { ...policy.returns, allowCustomProducts: v } })}
              />
              <FormGrid>
                <Field label="Return window (days)" help="0 means no time limit.">
                  <input className="ui-input w-full" inputMode="numeric" disabled={disabled} value={policy.returns.windowDays}
                    onChange={(e) => patchPolicy({ returns: { ...policy.returns, windowDays: Number(e.target.value) || 0 } })} />
                </Field>
              </FormGrid>
              <Field label="Return instructions" help="Shown to a customer whose return is approved.">
                <textarea className="ui-input w-full" rows={3} disabled={disabled} value={policy.returns.instructions}
                  onChange={(e) => patchPolicy({ returns: { ...policy.returns, instructions: e.target.value } })} />
              </Field>
            </div>
          </Card>
        </Section>

        <Section
          title="Return address"
          description="Snapshotted onto a return when it is approved, so a later change never redirects a parcel already in the post."
        >
          <Card>
            <AddressFields
              legend="Where returned parcels are sent"
              value={settings.returnAddress}
              disabled={disabled}
              onChange={(returnAddress) => patch({ returnAddress })}
            />
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Cancellations ---------------- */}
      <TabPanel id="cancellations" value={tab}>
        <Section
          title="Cancellation rules"
          description="When a customer may ask to cancel, and when the shop stops allowing it."
        >
          <Card>
            <div className="staff-form">
              <CheckField
                label="Paid orders may be cancelled by request"
                help="A request still needs a staff decision; this only controls whether the customer can raise one."
                checked={policy.cancellation.allowPaidRequests}
                disabled={disabled}
                onChange={(v) => patchPolicy({ cancellation: { ...policy.cancellation, allowPaidRequests: v } })}
              />
              <CheckField
                label="Block cancellation once materials are committed"
                checked={policy.cancellation.blockAfterMaterialsOrdered}
                disabled={disabled}
                onChange={(v) => patchPolicy({ cancellation: { ...policy.cancellation, blockAfterMaterialsOrdered: v } })}
              />
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/* ---------------- Notifications ---------------- */}
      <TabPanel id="notifications" value={tab}>
        <Section
          title="Addresses"
          description="Who customers write to, and who the shop tells when something needs a person."
        >
          <Card>
            <FormGrid>
              <Field label="Support email" help="Where customers are told to write.">
                <input className="ui-input w-full" type="email" disabled={disabled} value={settings.business.supportEmail}
                  onChange={(e) => patch({ business: { ...settings.business, supportEmail: e.target.value } })} />
              </Field>
              <Field label="Reply-To address" help="Where a reply to an automated email goes.">
                <input className="ui-input w-full" type="email" disabled={disabled} value={settings.email.replyTo}
                  onChange={(e) => patch({ email: { ...settings.email, replyTo: e.target.value } })} />
              </Field>
              <Field label="Staff alert recipients" help="Comma separated. Gets operational alerts.">
                <input className="ui-input w-full" disabled={disabled} value={settings.email.staffAlertRecipients.join(", ")}
                  onChange={(e) => patch({ email: { ...settings.email, staffAlertRecipients: e.target.value.split(/[,\s;]+/).filter(Boolean) } })} />
              </Field>
              <Field label="Low-stock alert recipients" help="Comma separated. On-site staff notifications are sent regardless.">
                <input className="ui-input w-full" disabled={disabled} value={settings.inventory.lowStockRecipients.join(", ")}
                  onChange={(e) => patch({ inventory: { ...settings.inventory, lowStockRecipients: e.target.value.split(/[,\s;]+/).filter(Boolean) } })} />
              </Field>
            </FormGrid>
          </Card>
        </Section>

        <Section
          title="Which emails are sent"
          description="Turning a category off stops every message in it. The templates themselves live under Business → Email."
        >
          <Card>
            <div className="grid gap-3 sm:grid-cols-2">
              {(Object.keys(settings.email.categories) as (keyof CommerceSettings["email"]["categories"])[]).map((key) => (
                <CheckField
                  key={key}
                  label={`${key.charAt(0).toUpperCase()}${key.slice(1)} email`}
                  checked={settings.email.categories[key]}
                  disabled={disabled}
                  onChange={(v) => patch({ email: { ...settings.email, categories: { ...settings.email.categories, [key]: v } } })}
                />
              ))}
            </div>
          </Card>
        </Section>
      </TabPanel>

      {/*
        Problems and the save bar sit outside the tabs on purpose.

        A validation problem raised by the Shipping fields must be visible from
        whichever tab the reader is on when they press Save; putting it inside a
        panel would hide the reason the save failed behind a tab they have no
        reason to open.
      */}
      {problems.length ? (
        <Notice tone="danger" role="alert">
          <p className="font-medium">This could not be saved:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {canManage ? (
        <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} message={saved} />
      ) : null}
    </StaffPage>
  );
}

/** One method's fields, written back into the settings object. */
function updateMethod(
  settings: CommerceSettings,
  patch: (next: Partial<CommerceSettings>) => void,
  index: number,
  next: Partial<ShippingMethod>
) {
  patch({
    shipping: {
      ...settings.shipping,
      methods: settings.shipping.methods.map((method, i) => (i === index ? { ...method, ...next } : method)),
    },
  });
}

/**
 * An address, as a labelled group of fields.
 *
 * Was a `<fieldset>` with a visible border, inside a `ui-card`, inside the page
 * — three nested boxes before the first input, for a group of eight text
 * fields. A heading and whitespace group them just as clearly, and the
 * `<fieldset>` is kept without its border so the grouping is still announced.
 */
function AddressFields({
  legend,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  value: Address;
  disabled: boolean;
  onChange: (a: Address) => void;
}) {
  const set = (key: keyof Address) => (event: React.ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: event.target.value });
  return (
    <fieldset className="min-w-0">
      <legend className="staff-section-title mb-4">{legend}</legend>
      <FormGrid>
        <Field label="Name"><input className="ui-input w-full" disabled={disabled} value={value.name} onChange={set("name")} /></Field>
        <Field label="Phone"><input className="ui-input w-full" disabled={disabled} value={value.phone} onChange={set("phone")} /></Field>
        <Field label="Address line 1"><input className="ui-input w-full" disabled={disabled} value={value.line1} onChange={set("line1")} /></Field>
        <Field label="Address line 2"><input className="ui-input w-full" disabled={disabled} value={value.line2} onChange={set("line2")} /></Field>
        <Field label="City"><input className="ui-input w-full" disabled={disabled} value={value.city} onChange={set("city")} /></Field>
        <Field label="State / region"><input className="ui-input w-full" disabled={disabled} value={value.region} onChange={set("region")} /></Field>
        <Field label="Postal code"><input className="ui-input w-full" disabled={disabled} value={value.postalCode} onChange={set("postalCode")} /></Field>
        <Field label="Country" help="Two-letter code."><input className="ui-input w-full" maxLength={2} disabled={disabled} value={value.country} onChange={set("country")} /></Field>
      </FormGrid>
    </fieldset>
  );
}
