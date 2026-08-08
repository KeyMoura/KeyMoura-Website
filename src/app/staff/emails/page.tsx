"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { EmailDeliveryCenter } from "@/components/staff/EmailDeliveryCenter";
import {
  Card,
  CheckField,
  EmptyState,
  ErrorState,
  Fact,
  Facts,
  FormGrid,
  FormWide,
  LoadingState,
  PageHeader,
  PageTabs,
  Section,
  StaffPage,
  TabPanel,
} from "@/components/staff/StaffPage";
import { Badge, Field, Notice } from "@/components/ui/DesignSystem";
import { useHashTab } from "@/lib/hooks/useHashTab";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import type { StaffTab } from "@/lib/staff/pageFramework";
import {
  CUSTOMER_SAFE_VARIABLES,
  findPlaceholderProblems,
  templateWiring,
} from "@/lib/comms/emailEvents";

/**
 * Email: what the shop sends, whether it arrived, and who it comes from.
 *
 * ## What this replaced
 *
 * One page called "Email center" with five stacked sections — a master switch,
 * four address fields, three notification-group toggles, ten expandable
 * templates, and a save-and-test block — and a **separate route**,
 * `/staff/emails/deliveries`, holding the delivery log. So the two halves of
 * one question lived a menu click apart: you edited the wording of the shipping
 * email here, and found out whether it had reached anybody there.
 *
 * ## The shape now
 *
 * Three tabs, which are the three things staff actually come here to do:
 *
 * - **Templates** — what each message says, what triggers it, who gets it, the
 *   variables it may use, and a live preview of the rendered subject.
 * - **Delivery history** — the log, embedded rather than linked. The old route
 *   redirects to `#deliveries`, so every existing bookmark still works.
 * - **Settings** — the master switch, sender identity, recipients, and the test
 *   send. Configuration, kept away from the wording.
 *
 * ## One save
 *
 * All three tabs are inside one `<form>` with a single submit in the shared
 * save bar. A wording change on Templates and an address change on Settings are
 * saved by the same button, and the confirmation is visible from whichever tab
 * the reader is standing on. `TabPanel` unmounts the tabs that are not
 * selected, so no hidden input is ever submitted carrying a value nobody could
 * see — the edits themselves live in React state, which is what the submit
 * reads, so switching tabs never loses an unsaved change.
 */

type Config = {
  enabled: boolean;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  staffNotificationEmail: string;
  sendCustomerMessages: boolean;
  sendStatusUpdates: boolean;
  sendPaymentUpdates: boolean;
};

type Template = {
  key: string;
  name: string;
  subject: string;
  heading: string;
  body: string;
  button_label: string;
  is_enabled: boolean;
};

const templateExplanations: Record<string, { trigger: string; recipient: string; group: string }> = {
  request_received: {
    trigger: "A customer submits a new order or customization request.",
    recipient: "The customer who submitted it",
    group: "Always available when email is on",
  },
  staff_new_request: {
    trigger: "A customer submits a new order or customization request.",
    recipient: "Your staff notification email",
    group: "Always available when email is on",
  },
  needs_information: {
    trigger: "Staff changes an order to Needs information.",
    recipient: "The customer for that order",
    group: "Status updates",
  },
  quote_ready: {
    trigger: "Staff makes a quote payable or changes an order to Awaiting payment.",
    recipient: "The customer for that order",
    group: "Payment updates",
  },
  status_update: {
    trigger: "Staff changes an order to another customer-facing status.",
    recipient: "The customer for that order",
    group: "Status updates",
  },
  customer_message: {
    trigger: "A staff member posts a customer-visible message on an order.",
    recipient: "The customer for that order",
    group: "Order messages",
  },
  staff_message: {
    trigger: "A customer posts a message on an order.",
    recipient: "Your staff notification email",
    group: "Order messages",
  },
  payment_received: {
    trigger: "Stripe confirms that an order payment succeeded.",
    recipient: "The customer who paid",
    group: "Payment updates",
  },
  order_shipped: {
    trigger: "Staff marks a shipped order as shipped and supplies its tracking details.",
    recipient: "The customer for that order",
    group: "Status updates",
  },
  order_delivered: {
    trigger: "Staff marks an order delivered or a pickup complete.",
    recipient: "The customer for that order",
    group: "Status updates",
  },
};

const input = "ui-input w-full";

/**
 * Placeholder problems across every editable field of one template.
 *
 * All four fields are checked, not just the message: a mistyped variable in the
 * subject line is the most visible place it can possibly appear.
 */
function malformedPlaceholders(template: Template): string[] {
  const problems = new Set<string>();
  for (const field of [template.subject, template.heading, template.body, template.button_label]) {
    const found = findPlaceholderProblems(field ?? "");
    for (const token of found.malformed) problems.add(token);
    for (const token of found.unknown) problems.add(token);
  }
  return [...problems];
}

/**
 * Sample values for the preview, and the reason the preview is honest.
 *
 * A preview that silently dropped an unsupplied variable would show a tidier
 * message than the customer receives. These are obviously-fake stand-ins, so a
 * staff member reading the preview can see exactly where each value lands and
 * how the sentence reads around it.
 */
const PREVIEW_VALUES: Record<string, string> = {
  customer_name: "Alex Moura",
  order_number: "KM-0007",
  product_name: "Premade Shift Knob",
  order_status: "In production",
  order_total: "$240.00",
  amount_paid: "$120.00",
  balance_due: "$120.00",
  tracking_number: "1Z999AA10123456784",
  tracking_url: "https://example.com/track",
  carrier: "UPS",
  message_body: "Your knob is on the bench today.",
  target_date: "12 August 2026",
  shop_name: "KeyMoura",
  order_url: "https://keymoura.com/orders/KM-0007",
};

/**
 * Render `{{name}}` the way the sender does, for the preview only.
 *
 * Deliberately *not* the real `interpolate`: this one marks an unsupplied
 * variable rather than replacing it with nothing, because "renders as empty
 * text" is precisely the surprise the preview exists to remove.
 */
function previewText(value: string): string {
  return String(value ?? "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, name: string) =>
    PREVIEW_VALUES[name] ?? `[no ${name}]`
  );
}

function Toggle({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer gap-3 rounded-xl border border-brand-border bg-brand-surface2 p-4">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4 shrink-0 accent-brand-accent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-brand-textMuted">{description}</span>
      </span>
    </label>
  );
}

export default function StaffEmailPage() {
  const { data: access, isLoading } = useMeAccess();
  const allowed = (access?.permissions ?? []).includes("emails.manage");
  const [config, setConfig] = useState<Config | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [provider, setProvider] = useState(false);
  const [message, setMessage] = useState("");
  const [testTo, setTestTo] = useState("");

  /*
   * A rejected fetch used to leave this page saying "Loading email settings…"
   * for ever: the promise had a `.then` and no `.catch`, so a network failure
   * or a 500 with a non-JSON body never resolved into any visible state. A
   * permanent loading spinner is the quietest form of the same lie the rest of
   * this pass is about — it reports "working on it" for something that already
   * failed, and unlike a zero it never even invites a second look.
   */
  const [loadFailed, setLoadFailed] = useState(false);

  /*
   * The tab strip, declared before the early returns so hook order is stable
   * across the loading, refused and loaded renders.
   *
   * The template count is worth carrying: it is the answer to "how many
   * messages can this shop send", which the old page could only give by
   * counting ten collapsed `<details>` elements by eye.
   */
  const tabs = useMemo<StaffTab[]>(
    () => [
      { id: "templates", label: "Templates", count: templates.length || null },
      { id: "deliveries", label: "Delivery history" },
      { id: "settings", label: "Settings" },
    ],
    [templates.length]
  );
  const [tab, setTab] = useHashTab(tabs);

  useEffect(() => {
    if (!allowed) return;
    void (async () => {
      try {
        const response = await fetch("/api/staff/emails");
        const result = await response.json();
        if (!response.ok || result.error) {
          setMessage(result?.error || "Email settings could not be loaded.");
          setLoadFailed(true);
          return;
        }
        setConfig(result.config);
        setTemplates(result.templates);
        setProvider(result.providerConfigured);
        setLoadFailed(false);
      } catch {
        setMessage("Email settings could not be reached. Check your connection and reload.");
        setLoadFailed(true);
      }
    })();
  }, [allowed]);

  if (isLoading) return <LoadingState>Loading…</LoadingState>;
  if (!allowed) return <AccessDeniedCard message="You do not have access to email settings." />;
  if (loadFailed) {
    return (
      <ErrorState>
        <p className="font-semibold">Email settings could not be loaded.</p>
        <p className="mt-1 text-sm opacity-90">
          {message} Nothing is shown below, because the current configuration is unknown — it has not been changed.
        </p>
      </ErrorState>
    );
  }
  if (!config) return <LoadingState>Loading email settings…</LoadingState>;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("Saving…");
    const response = await fetch("/api/staff/emails", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config, templates }),
    });
    const result = await response.json();
    setMessage(result.error || "Email settings saved.");
  };

  const test = async () => {
    setMessage("Sending test…");
    const response = await fetch("/api/staff/emails/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: testTo }),
    });
    const result = await response.json();
    setMessage(result.error || (result.sent ? "Test email sent." : "Test email was not sent."));
  };

  /** Templates nothing in the application can send yet. Stated, never hidden. */
  const unwiredCount = templates.filter((template) => !templateWiring(template.key).wired).length;

  return (
    <StaffPage>
      <PageHeader
        title="Email"
        description="What KeyMoura sends to customers, whether it arrived, and who it comes from. Nothing here changes the email address used to sign in to Resend."
      />

      {!provider ? (
        <Notice tone="warning" role="status">
          RESEND_API_KEY is not configured in Vercel. Settings can be saved, but no mail will send.
        </Notice>
      ) : null}

      {!config.enabled ? (
        <Notice tone="warning" role="status">
          The master switch under Settings is off, so <strong>no automatic email is being sent at all</strong> —
          whatever the individual templates below say.
        </Notice>
      ) : null}

      <PageTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Email sections" />

      <form onSubmit={save} className="staff-page">
        {/* ================= Templates ================= */}
        <TabPanel id="templates" value={tab}>
          <Section
            title="Templates"
            description="Every message the shop can send. A template only reaches anybody when its own switch and its group under Settings are both on."
            actions={
              unwiredCount ? (
                <Badge tone="warning">{unwiredCount} not sent by anything yet</Badge>
              ) : null
            }
          >
            {!templates.length ? (
              <EmptyState>No templates are configured.</EmptyState>
            ) : null}

            {templates.map((template, index) => {
              const explanation = templateExplanations[template.key];
              // Derived from the catalogue that `tests/transactional-emails.test.ts`
              // asserts against the send calls themselves — so "what sends this"
              // cannot drift from what actually sends it.
              const wiring = templateWiring(template.key);
              const problems = malformedPlaceholders(template);
              const patchTemplate = (next: Partial<Template>) =>
                setTemplates((current) =>
                  current.map((item) => (item.key === template.key ? { ...item, ...next } : item))
                );

              return (
                <details key={template.key} className="ui-card" open={index === 0}>
                  <summary className="cursor-pointer list-none">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <span className="staff-row-title">{template.name}</span>
                        <span className="staff-row-detail block">
                          To: {explanation?.recipient || "Configured recipient"} ·{" "}
                          {explanation?.group || "Individual email"}
                        </span>
                      </div>
                      <div className="flex w-fit flex-wrap gap-2">
                        {/* A template nothing can send yet is marked here rather
                            than hidden: it is a real, specified email that is
                            waiting on something, and staff editing its wording
                            deserve to know it will not reach anyone today. */}
                        {!wiring.wired ? <Badge tone="warning">Not sent yet</Badge> : null}
                        {problems.length ? <Badge tone="danger">Check variables</Badge> : null}
                        <Badge tone={template.is_enabled ? "accent" : "neutral"}>
                          {template.is_enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                    </div>
                  </summary>

                  <div className="mt-5 space-y-5 border-t border-brand-border pt-5">
                    {/* What this message is, before how it is worded. */}
                    <Facts>
                      <Fact label="When it sends">{explanation?.trigger ?? "Not documented."}</Fact>
                      <Fact label="Who receives it">{explanation?.recipient ?? "Configured recipient."}</Fact>
                      <Fact label="Group">{explanation?.group ?? "Individual email"}</Fact>
                    </Facts>

                    {/* Used by — the exact triggers, from the catalogue. */}
                    <div>
                      <p className="staff-fact-label">Used by</p>
                      {wiring.events.length ? (
                        <ul className="mt-2 space-y-1.5 text-sm">
                          {wiring.events.map((event) => (
                            <li key={event.id} className="leading-5">
                              <span className="font-mono text-xs text-brand-textMuted">{event.id}</span>
                              <span className="mx-1.5 text-brand-textMuted">·</span>
                              <span>{event.trigger}</span>
                              {!event.wired ? (
                                <span className="ml-1.5 text-xs text-amber-200">(not built yet)</span>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm leading-5 text-amber-200">
                          Nothing in the application sends this template. Editing it changes no email.
                        </p>
                      )}
                      {!wiring.wired && wiring.pendingReason ? (
                        <p className="mt-3 text-sm leading-5 text-brand-textMuted">
                          <span className="font-medium text-amber-200">Why it does not send: </span>
                          {wiring.pendingReason}
                        </p>
                      ) : null}
                    </div>

                    <CheckField
                      label={`Send the “${template.name}” email`}
                      help="Turn this off to stop only this specific email. Its group under Settings must also be on."
                      checked={template.is_enabled}
                      onChange={(checked) => patchTemplate({ is_enabled: checked })}
                    />

                    <FormGrid>
                      <FormWide>
                        <Field label="Inbox subject">
                          <input
                            className={input}
                            value={template.subject}
                            onChange={(event) => patchTemplate({ subject: event.target.value })}
                          />
                        </Field>
                      </FormWide>
                      <Field label="Email heading">
                        <input
                          className={input}
                          value={template.heading}
                          onChange={(event) => patchTemplate({ heading: event.target.value })}
                        />
                      </Field>
                      <Field label="Button text">
                        <input
                          className={input}
                          value={template.button_label}
                          onChange={(event) => patchTemplate({ button_label: event.target.value })}
                        />
                      </Field>
                      <FormWide>
                        <Field label="Email message">
                          <textarea
                            className={`${input} min-h-32`}
                            value={template.body}
                            onChange={(event) => patchTemplate({ body: event.target.value })}
                          />
                        </Field>
                      </FormWide>
                    </FormGrid>

                    {/*
                      The preview.

                      The page had none: a staff member editing `{{order_total}}`
                      into a sentence could not see the sentence. Sample values
                      are obviously fake, and a variable this shop does not
                      supply renders as `[no name]` rather than vanishing —
                      "renders as empty text" is exactly the surprise a preview
                      is for.
                    */}
                    <div className="rounded-xl border border-brand-border bg-brand-surface2 p-4">
                      <p className="staff-fact-label">Preview with sample values</p>
                      <p className="mt-2 text-sm font-semibold">{previewText(template.subject)}</p>
                      <p className="mt-3 text-sm font-medium">{previewText(template.heading)}</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-brand-textMuted">
                        {previewText(template.body)}
                      </p>
                      {template.button_label ? (
                        <span className="ui-btn ui-btn-primary mt-4 inline-flex text-sm">
                          {previewText(template.button_label)}
                        </span>
                      ) : null}
                      <p className="mt-4 text-xs leading-5 text-brand-textMuted">
                        Sample values only. A variable this email does not supply is shown as{" "}
                        <span className="font-mono">[no name]</span> here and sends as nothing.
                      </p>
                    </div>

                    {/* Derived from `CUSTOMER_SAFE_VARIABLES` rather than typed
                        out again. The hard-coded list this replaces named seven
                        of the fourteen, so half the usable variables were
                        undiscoverable and the list could not follow the allow-list
                        it was describing. A name outside that allow-list is
                        dropped by `filterCustomerVariables` before sending, so an
                        invented one renders as empty text. */}
                    <details className="rounded-xl border border-brand-border p-4">
                      <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
                        Variables you can use ({CUSTOMER_SAFE_VARIABLES.length})
                      </summary>
                      <ul className="mt-3 flex flex-wrap gap-1.5">
                        {CUSTOMER_SAFE_VARIABLES.map((name) => (
                          <li
                            key={name}
                            className="rounded-md bg-brand-surface2 px-2 py-1 font-mono text-xs text-brand-textMuted"
                          >
                            {`{{${name}}}`}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-3 text-xs leading-5 text-brand-textMuted">
                        Not every email supplies every variable. One that is not supplied renders as nothing,
                        so prefer wording that still reads correctly when a value is absent.
                      </p>
                    </details>

                    {/* Malformed placeholder warning. `interpolate` only replaces
                        `{{name}}`; a single brace or a stray space is left in the
                        message exactly as typed and goes out to a customer. */}
                    {problems.length ? (
                      <Notice tone="warning" role="status">
                        This looks like a mistyped variable and will be sent to the customer as written:{" "}
                        <span className="font-mono">{problems.join(", ")}</span>. A variable looks like{" "}
                        <span className="font-mono">{"{{customer_name}}"}</span>.
                      </Notice>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </Section>
        </TabPanel>

        {/* ================= Delivery history ================= */}
        <TabPanel id="deliveries" value={tab}>
          <EmailDeliveryCenter />
        </TabPanel>

        {/* ================= Settings ================= */}
        <TabPanel id="settings" value={tab}>
          <Section
            title="Master switch"
            description="Turning this off stops every automatic customer and staff email, whatever the individual templates say."
          >
            <Card>
              <CheckField
                label={config.enabled ? "Email is on" : "Email is off"}
                help="Applies to every message the shop sends, including staff alerts."
                checked={config.enabled}
                onChange={(checked) => setConfig({ ...config, enabled: checked })}
              />
            </Card>
          </Section>

          <Section
            title="Sender and recipients"
            description="Who the email appears to come from, where replies go, and where staff alerts are delivered."
          >
            <Card>
              <FormGrid>
                <Field label="From name" help="Customers see this name in their inbox, such as “KeyMoura Orders”.">
                  <input
                    className={input}
                    value={config.fromName}
                    onChange={(event) => setConfig({ ...config, fromName: event.target.value })}
                  />
                </Field>
                <Field
                  label="From email"
                  help="Customers see this in the From line. It must use your verified Resend domain."
                >
                  <input
                    className={input}
                    type="email"
                    value={config.fromEmail}
                    onChange={(event) => setConfig({ ...config, fromEmail: event.target.value })}
                  />
                </Field>
                <Field
                  label="Replies go to"
                  help="If a customer presses Reply in their email app, their message goes here."
                >
                  <input
                    className={input}
                    type="email"
                    value={config.replyTo}
                    onChange={(event) => setConfig({ ...config, replyTo: event.target.value })}
                  />
                </Field>
                <Field
                  label="Send staff alerts to"
                  help="Receives alerts for new requests and customer order messages. Never shown to customers."
                >
                  <input
                    className={input}
                    type="email"
                    value={config.staffNotificationEmail}
                    onChange={(event) => setConfig({ ...config, staffNotificationEmail: event.target.value })}
                    placeholder="staff@keymoura.com"
                  />
                </Field>
              </FormGrid>
            </Card>
          </Section>

          <Section
            title="Notification groups"
            description="These control groups of automatic emails. A template also has its own switch under Templates; both must be on for it to send."
          >
            <div className="grid gap-3 lg:grid-cols-3">
              <Toggle
                checked={config.sendCustomerMessages}
                onChange={(checked) => setConfig({ ...config, sendCustomerMessages: checked })}
                title="Order message alerts"
                description="Staff message → customer, and customer message → staff inbox. Internal staff notes never send email."
              />
              <Toggle
                checked={config.sendStatusUpdates}
                onChange={(checked) => setConfig({ ...config, sendStatusUpdates: checked })}
                title="Order status updates"
                description="Emails customers when staff changes an order status, including requests for more information."
              />
              <Toggle
                checked={config.sendPaymentUpdates}
                onChange={(checked) => setConfig({ ...config, sendPaymentUpdates: checked })}
                title="Quote and payment updates"
                description="Emails customers when a quote is ready and after Stripe confirms payment."
              />
            </div>
          </Section>

          <Section
            title="Send a test"
            description="Save first, then test. The test uses the saved From name, From email, Reply-to address, colours and status-update template."
          >
            <Card>
              <FormGrid>
                <Field label="Send test email to">
                  <input
                    className={input}
                    type="email"
                    value={testTo}
                    onChange={(event) => setTestTo(event.target.value)}
                    placeholder="you@example.com"
                  />
                </Field>
              </FormGrid>
              {/* `type="button"`: this is the one control on the page that is
                  not the form's submit, and letting it default to submit would
                  have made "Send test" save every template as a side effect. */}
              <button className="ui-btn ui-btn-secondary mt-4 text-sm" type="button" onClick={test}>
                Send test
              </button>
            </Card>
          </Section>
        </TabPanel>

        {/* One save, outside the tabs: a template edited on one tab and an
            address edited on another are saved by the same button, and the
            confirmation is visible from wherever the reader is standing. */}
        <div className="staff-save-bar">
          <button className="ui-btn ui-btn-primary" type="submit">
            Save all email settings
          </button>
          {message ? (
            <span className="staff-save-status" aria-live="polite">
              {message}
            </span>
          ) : null}
        </div>
      </form>
    </StaffPage>
  );
}
