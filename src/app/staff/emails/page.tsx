"use client";

import { FormEvent, useEffect, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { useMeAccess } from "@/lib/hooks/useMeAccess";

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
};

const input = "ui-input w-full";

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

  useEffect(() => {
    if (!allowed) return;
    void fetch("/api/staff/emails")
      .then((response) => response.json())
      .then((result) => {
        if (result.error) setMessage(result.error);
        else {
          setConfig(result.config);
          setTemplates(result.templates);
          setProvider(result.providerConfigured);
        }
      });
  }, [allowed]);

  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!allowed) return <AccessDeniedCard message="You do not have access to email settings." />;
  if (!config) return <div className="ui-card">{message || "Loading email settings…"}</div>;

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

  return (
    <main>
      <p className="text-xs uppercase tracking-[.2em] text-brand-accent">Commerce</p>
      <h1 className="mt-1 text-3xl font-semibold">Email center</h1>
      <p className="mt-2 max-w-3xl text-sm leading-6 text-brand-textMuted">
        Choose what KeyMoura sends to customers and which alerts come back to your staff inbox.
        Nothing here changes the email address used to sign in to Resend.
      </p>

      {!provider ? (
        <div className="mt-5 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
          RESEND_API_KEY is not configured in Vercel. Settings can be saved, but no mail will send.
        </div>
      ) : null}

      <form onSubmit={save} className="mt-6 space-y-6">
        <section className="ui-card">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold">Master email switch</h2>
              <p className="mt-1 text-sm text-brand-textMuted">
                Turning this off stops every automatic customer and staff email below.
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
              <input
                type="checkbox"
                className="h-4 w-4 accent-brand-accent"
                checked={config.enabled}
                onChange={(event) => setConfig({ ...config, enabled: event.target.checked })}
              />
              {config.enabled ? "Email is on" : "Email is off"}
            </label>
          </div>
        </section>

        <section className="ui-card">
          <h2 className="text-xl font-semibold">Addresses</h2>
          <p className="mt-1 text-sm text-brand-textMuted">Who the email appears to come from, where replies go, and where staff alerts are delivered.</p>
          <div className="mt-5 grid gap-5 md:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block font-medium">From name</span>
              <input className={input} value={config.fromName} onChange={(event) => setConfig({ ...config, fromName: event.target.value })} />
              <span className="mt-1.5 block text-xs leading-5 text-brand-textMuted">Customers see this name in their inbox, such as “KeyMoura Orders.”</span>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">From email</span>
              <input className={input} type="email" value={config.fromEmail} onChange={(event) => setConfig({ ...config, fromEmail: event.target.value })} />
              <span className="mt-1.5 block text-xs leading-5 text-brand-textMuted">Customers see this in the From line. It must use your verified Resend domain.</span>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Replies go to</span>
              <input className={input} type="email" value={config.replyTo} onChange={(event) => setConfig({ ...config, replyTo: event.target.value })} />
              <span className="mt-1.5 block text-xs leading-5 text-brand-textMuted">If a customer presses Reply in their email app, their message goes here.</span>
            </label>
            <label className="text-sm">
              <span className="mb-1 block font-medium">Send staff alerts to</span>
              <input className={input} type="email" value={config.staffNotificationEmail} onChange={(event) => setConfig({ ...config, staffNotificationEmail: event.target.value })} placeholder="staff@keymoura.com" />
              <span className="mt-1.5 block text-xs leading-5 text-brand-textMuted">Receives alerts for new requests and customer order messages. This is not shown to customers.</span>
            </label>
          </div>
        </section>

        <section className="ui-card">
          <h2 className="text-xl font-semibold">Notification groups</h2>
          <p className="mt-1 text-sm text-brand-textMuted">
            These switches control groups of automatic emails. New-request emails have their own template switches below.
          </p>
          <div className="mt-5 grid gap-3 lg:grid-cols-3">
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
        </section>

        <section className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold">Individual emails</h2>
            <p className="mt-1 text-sm text-brand-textMuted">
              Use these switches to disable one specific email. Both its switch and the relevant group above must be on.
            </p>
          </div>
          {templates.map((template, index) => {
            const explanation = templateExplanations[template.key];
            return (
              <details key={template.key} className="ui-card" open={index === 0}>
                <summary className="cursor-pointer list-none">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <span className="font-semibold">{template.name}</span>
                      <span className="mt-1 block text-xs text-brand-textMuted">
                        To: {explanation?.recipient || "Configured recipient"} · {explanation?.group || "Individual email"}
                      </span>
                    </div>
                    <span className={`w-fit rounded-full px-2.5 py-1 text-xs font-semibold ${template.is_enabled ? "bg-brand-accent/15 text-brand-accent" : "bg-brand-surface2 text-brand-textMuted"}`}>
                      {template.is_enabled ? "Enabled" : "Disabled"}
                    </span>
                  </div>
                </summary>
                <div className="mt-5 space-y-4 border-t border-brand-border pt-5">
                  <div className="grid gap-3 rounded-xl bg-brand-surface2 p-4 text-sm md:grid-cols-2">
                    <div><span className="block text-xs font-semibold uppercase tracking-wide text-brand-textMuted">When it sends</span><span className="mt-1 block leading-5">{explanation?.trigger}</span></div>
                    <div><span className="block text-xs font-semibold uppercase tracking-wide text-brand-textMuted">Who receives it</span><span className="mt-1 block leading-5">{explanation?.recipient}</span></div>
                  </div>
                  <Toggle
                    checked={template.is_enabled}
                    onChange={(checked) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, is_enabled: checked } : item))}
                    title={`Send “${template.name}” email`}
                    description="Turn this off to stop only this specific email."
                  />
                  {(["subject", "heading", "button_label"] as const).map((key) => (
                    <label key={key} className="block text-sm">
                      <span className="mb-1 block font-medium">{{ subject: "Inbox subject", heading: "Email heading", button_label: "Button text" }[key]}</span>
                      <input className={input} value={template[key]} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, [key]: event.target.value } : item))} />
                    </label>
                  ))}
                  <label className="block text-sm">
                    <span className="mb-1 block font-medium">Email message</span>
                    <textarea className={`${input} min-h-28`} value={template.body} onChange={(event) => setTemplates((current) => current.map((item) => item.key === template.key ? { ...item, body: event.target.value } : item))} />
                  </label>
                  <p className="text-xs leading-5 text-brand-textMuted">
                    Variables you can use: {"{{customer_name}}, {{product_name}}, {{order_label}}, {{status}}, {{price}}"}
                  </p>
                </div>
              </details>
            );
          })}
        </section>

        <section className="ui-card">
          <h2 className="text-xl font-semibold">Save and test</h2>
          <p className="mt-1 text-sm text-brand-textMuted">
            Save first, then send a test. The test uses the saved From name, From email, Reply-to address, colors, and status-update template.
          </p>
          <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end">
            <button className="ui-btn ui-btn-primary" type="submit">Save all email settings</button>
            <label className="w-full text-sm sm:max-w-sm">
              <span className="mb-1 block font-medium">Send test email to</span>
              <input className={input} type="email" value={testTo} onChange={(event) => setTestTo(event.target.value)} placeholder="you@example.com" />
            </label>
            <button className="ui-btn ui-btn-secondary" type="button" onClick={test}>Send test</button>
          </div>
          {message ? <p className="mt-4 text-sm text-brand-textMuted" aria-live="polite">{message}</p> : null}
        </section>
      </form>
    </main>
  );
}
