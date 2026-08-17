"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faPenToSquare } from "@fortawesome/free-solid-svg-icons";
import { Notice, cx } from "@/components/ui/DesignSystem";
import { RequestField, describedBy } from "@/components/orders/RequestControls";
import { RequestFiles, type PendingFile } from "@/components/orders/RequestFiles";
import { ProjectStep, DetailsStep, LogisticsStep, type ProductOption } from "@/components/orders/CustomRequestSteps";
import { useCheckoutContext } from "@/lib/hooks/useCart";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { GUEST_ACCESS_WINDOW_LABEL } from "@/lib/commerce/guestAccessWindow";
import {
  MAX_REQUEST_FILES,
  STEPS,
  STEP_IDS,
  deliveryLabel,
  describeBudget,
  describeDimensions,
  describeFinish,
  describeMaterial,
  describeTiming,
  emptyCustomRequest,
  normalizeReferenceUrl,
  requestTypeLabel,
  resolvedTitle,
  safeStorageName,
  storageContentType,
  validateAll,
  validateStep,
  type CustomRequestForm,
  type StepId,
} from "@/lib/orders/customRequest";

/**
 * The custom project intake.
 *
 * ## What this replaces, and what was wrong with it
 *
 * A four-step form that was really one long form with the fields hidden in
 * groups. Concretely, it:
 *
 * - opened by asking a customer to classify their own project against a list
 *   of shop-shaped labels, then asked every project the same questions anyway;
 * - required a full shipping address — name, street, city, state, ZIP — before
 *   it would show the review step, for an inquiry that charges nothing;
 * - offered 50 MB uploads into a bucket that refuses anything over 20;
 * - showed one error at a time, in a banner at the bottom, naming a field but
 *   never pointing at it;
 * - had a Save draft button and no autosave, so the work was safe only if you
 *   thought to press it;
 * - sent every signed-out visitor to the login page **on submit**, at the end,
 *   even though the route behind it accepts guest requests perfectly well; and
 * - said "Submit request — no charge" as the only word anywhere about what
 *   submitting actually committed you to.
 *
 * ## The shape now
 *
 * Five steps: what it is, what it should be like, references, the practical
 * questions, and a review. The first step's answer decides which questions the
 * second one asks — a woodworking board is never asked for a vehicle, and a
 * shift knob is never asked whether it lives indoors — because that is the
 * difference between a guided intake and a form with everything on it.
 *
 * ## Three things this deliberately does not do
 *
 * **It does not add a data model.** A request is an `orders` row with
 * `status = 'requested'`, exactly as before. Everything structured here lands
 * in `orders.specifications`, which staff already render. No table, no column,
 * no migration.
 *
 * **It does not trust its own validation.** Every rule comes from
 * `lib/orders/customRequest`, and `/api/orders/custom` runs the same rules
 * again on the server against its own reading of the body. What is here is for
 * telling a customer what is wrong while they can still fix it, not for
 * deciding what is allowed.
 *
 * **It does not upload until submit.** Files are held in memory, so removing
 * one is instant and abandoning the form leaves nothing in the bucket. The cost
 * is that a saved draft cannot carry its attachments, which the draft notice
 * says out loud rather than leaving to be discovered.
 */

type Draft = { id: string; title: string; request_data: Partial<CustomRequestForm>; updated_at: string };

/** Guest drafts live here. Contact details are deliberately not included. */
const GUEST_DRAFT_KEY = "km_custom_request_draft";
const AUTOSAVE_DELAY_MS = 2500;

export default function CustomRequestWizard({
  products,
  initialProduct,
}: {
  products: readonly ProductOption[];
  /** Set when the customer arrived from a product page. */
  initialProduct: ProductOption | null;
}) {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const { data: checkout } = useCheckoutContext();
  const signedIn = checkout?.signedIn ?? false;
  const guestRequestsAllowed = checkout?.guestRequests ?? false;
  /** Undefined until the context resolves, so we never flash the wrong path. */
  const identityKnown = checkout != null;

  const [form, setForm] = useState<CustomRequestForm>(() => {
    const base = emptyCustomRequest();
    if (initialProduct) {
      base.request_type = "existing-product";
      base.product_slug = initialProduct.slug;
      base.title = `Custom ${initialProduct.name}`;
    }
    return base;
  });
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [step, setStep] = useState<StepId>("project");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [accountEmail, setAccountEmail] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  /**
   * The furthest step this customer has actually reached.
   *
   * The progress chips unlock against *this*, not against the current step.
   * Unlocking against the current step is what made "Edit" on the review a trap:
   * jumping back to Details to fix one word re-locked Files, Quantity and
   * Review, so the only way back to the summary was to press Continue through
   * three screens that were already answered. Which is exactly the
   * back-clicking a review step exists to avoid.
   */
  const [furthest, setFurthest] = useState(0);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const stepChangedRef = useRef(false);
  const dirtyRef = useRef(false);
  /**
   * The door on a submission that is already on its way.
   *
   * A ref rather than `busy`, because `busy` is state: two clicks landing in the
   * same frame both read the same stale `false` out of the same closure and both
   * proceed. The disabled attribute has the same hole — it is only applied on the
   * render *after* the first click. `submitToken` means the second request cannot
   * become a second order, but it would still be a second POST, and the customer
   * would still watch one of them fail. This closes it in the browser.
   */
  const inFlight = useRef(false);
  /**
   * One id for the life of this wizard, sent as `checkout_token`.
   *
   * A double-click, an impatient second tap, or a retry after a timeout that
   * actually succeeded all arrive carrying the same token, and the unique index
   * on `(customer_id, checkout_token)` means the second one cannot become a
   * second order. It is generated once and deliberately *not* regenerated on a
   * failed submit — a retry is the same request, not a new one.
   */
  const submitToken = useRef<string>("");
  if (!submitToken.current) submitToken.current = crypto.randomUUID();

  const index = STEP_IDS.indexOf(step);
  const current = STEPS[index];
  const isLast = step === "review";

  const set = useCallback(<K extends keyof CustomRequestForm>(key: K, value: CustomRequestForm[K]) => {
    dirtyRef.current = true;
    setSavedNote("");
    setForm((previous) => ({ ...previous, [key]: value }));
    // Clearing the field's own error as it is edited, rather than waiting for
    // the next Continue, is what stops a corrected field staying red.
    setErrors((previous) => (previous[key as string] ? { ...previous, [key as string]: "" } : previous));
  }, []);

  /* ---------------------------------------------------------------- *
   * Who owns this request
   * ---------------------------------------------------------------- */

  useEffect(() => {
    void (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;
      setAccountEmail(user.email ?? "");
      const result = await supabase
        .from("order_request_drafts")
        .select("id,title,request_data,updated_at")
        .eq("customer_id", user.id)
        .order("updated_at", { ascending: false });
      setDrafts((result.data ?? []) as Draft[]);
    })();
  }, [supabase]);

  /* ---------------------------------------------------------------- *
   * Drafts
   * ---------------------------------------------------------------- */

  /** Enough typed to be worth keeping. Saving an empty form is noise. */
  const worthSaving = form.request_type !== "" || form.description.trim().length > 0;

  const saveDraft = useCallback(
    async (silent: boolean) => {
      if (!worthSaving) return;
      const {
        data: { user },
      } = await supabase.auth.getUser();

      /*
       * Signed out, the draft stays in this browser and never leaves it.
       *
       * Contact details are stripped before it is written: `sessionStorage` is
       * readable by anything running on this origin, and an email address a
       * customer typed into a form is not something to leave lying in it. The
       * rest — what they want made, how big, what material — is their own
       * description of their own project and is what makes coming back useful.
       */
      if (!user) {
        try {
          // Everything except the two contact fields. A copy with the two
          // deleted, rather than a hand-listed allowlist, so a field added to
          // the form is carried into the draft automatically while the two that
          // must never be written stay named right here.
          const safe: Partial<CustomRequestForm> = { ...form };
          delete safe.guest_email;
          delete safe.guest_name;
          window.sessionStorage.setItem(GUEST_DRAFT_KEY, JSON.stringify(safe));
          if (!silent) setSavedNote("Saved in this browser");
          else setSavedNote("Draft saved");
        } catch {
          // A full or disabled storage is not an error worth interrupting for.
        }
        return;
      }

      const payload = {
        customer_id: user.id,
        title: resolvedTitle(form).slice(0, 120),
        request_data: form,
        updated_at: new Date().toISOString(),
      };
      const result = draftId
        ? await supabase
            .from("order_request_drafts")
            .update(payload)
            .eq("id", draftId)
            .eq("customer_id", user.id)
            .select()
            .single()
        : await supabase.from("order_request_drafts").insert(payload).select().single();

      if (result.error) {
        if (!silent) setBanner(result.error.message);
        return;
      }
      setDraftId(result.data.id);
      setSavedNote("Draft saved");
      setDrafts((existing) => [
        result.data as Draft,
        ...existing.filter((entry) => entry.id !== (result.data as Draft).id),
      ]);
    },
    [draftId, form, supabase, worthSaving]
  );

  /** Restore a signed-out draft on arrival, before anything is typed. */
  useEffect(() => {
    if (!identityKnown || signedIn || initialProduct) return;
    try {
      const raw = window.sessionStorage.getItem(GUEST_DRAFT_KEY);
      if (!raw) return;
      const stored = JSON.parse(raw) as Partial<CustomRequestForm>;
      setForm((previous) => ({ ...previous, ...stored, guest_email: "", guest_name: "" }));
    } catch {
      window.sessionStorage.removeItem(GUEST_DRAFT_KEY);
    }
    // Runs once, when identity first resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identityKnown, signedIn]);

  /**
   * Autosave, debounced.
   *
   * Quiet on purpose: a line of text that changes to "Draft saved" and stays
   * there. The previous form had a button and no autosave, which meant the
   * long description a customer had just written survived only if they thought
   * to press it before their laptop slept.
   */
  useEffect(() => {
    if (!worthSaving || submitted || busy) return;
    const timer = window.setTimeout(() => void saveDraft(true), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `saveDraft` closes over `form`, so a change to any field reschedules it.
  }, [form, worthSaving, submitted, busy, saveDraft]);

  /**
   * Warn before leaving with unsaved work — and only then.
   *
   * Not registered once and left in place: a customer who has typed nothing, or
   * who has just submitted successfully, must be able to close the tab without
   * being asked to confirm it.
   */
  useEffect(() => {
    if (!worthSaving || submitted) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [worthSaving, submitted]);

  const loadDraft = (draft: Draft) => {
    setForm({ ...emptyCustomRequest(), ...draft.request_data });
    setDraftId(draft.id);
    setStep("project");
    setErrors({});
    setBanner("");
    setSavedNote("");
  };

  const deleteDraft = async (id: string) => {
    if (!window.confirm("Delete this draft? This cannot be undone.")) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    const result = await supabase
      .from("order_request_drafts")
      .delete()
      .eq("id", id)
      .eq("customer_id", user.id);
    if (result.error) return setBanner(result.error.message);
    setDrafts((existing) => existing.filter((entry) => entry.id !== id));
    if (draftId === id) setDraftId(null);
  };

  /* ---------------------------------------------------------------- *
   * Moving between steps
   * ---------------------------------------------------------------- */

  const showErrors = (found: { field: string; message: string }[]) => {
    const map: Record<string, string> = {};
    for (const problem of found) if (!map[problem.field]) map[problem.field] = problem.message;
    setErrors(map);
    return map;
  };

  const goTo = (target: StepId) => {
    setStep(target);
    setFurthest((reached) => Math.max(reached, STEP_IDS.indexOf(target)));
    setBanner("");
    stepChangedRef.current = true;
  };

  const next = () => {
    const found = validateStep(step, form);
    if (found.length) {
      showErrors(found);
      setBanner(
        found.length === 1 ? found[0].message : `${found.length} things need a moment before we continue.`
      );
      return;
    }
    setErrors({});
    goTo(STEP_IDS[Math.min(STEP_IDS.length - 1, index + 1)]);
  };

  const back = () => {
    // No validation on the way back. Going back to fix something must never be
    // blocked by the thing you went back to fix.
    setErrors({});
    goTo(STEP_IDS[Math.max(0, index - 1)]);
  };

  /**
   * Focus the new step's heading.
   *
   * Without this a keyboard or screen-reader user presses Continue and focus
   * stays on a button that has just been re-labelled, with a page of new
   * content above it they were never told about. The heading is `tabIndex={-1}`
   * so it can receive focus without joining the tab order.
   */
  useEffect(() => {
    if (!stepChangedRef.current) return;
    stepChangedRef.current = false;
    headingRef.current?.focus();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  /* ---------------------------------------------------------------- *
   * Submission
   * ---------------------------------------------------------------- */

  /**
   * Sending the request. Reachable only from the Submit button's own click.
   *
   * ## The bug this shape exists to make impossible
   *
   * The primary action used to be one JSX slot holding a ternary: a
   * `type="button"` Continue on steps 1–4, and a `type="submit"` Submit on the
   * review. Two `<button>`s in the same position with no `key` are the *same
   * element* to React, so it kept the live DOM node and patched the attribute —
   * `type="button"` became `type="submit"` on the node the customer had just
   * pressed.
   *
   * React flushes a click synchronously, so that patch landed *during* the
   * click's dispatch, and a button's activation behaviour is resolved from its
   * `type` **after** the listeners have run. By the time the browser asked "what
   * does this click do", it was looking at a submit button. So the press that
   * meant Continue was also the press that meant Submit: the review step painted
   * and the request left about two seconds later, before the customer had read a
   * word of it.
   *
   * Nothing about it was an effect, a timer, or a mount — which is why it
   * survived a read of every `useEffect` on the page.
   *
   * The three things that now hold it shut, in order of how much they are
   * trusted: the two buttons carry distinct `key`s, so there is no shared node
   * left to morph; the form's `onSubmit` refuses every submission outright, so a
   * stray Enter or a re-introduced `type="submit"` reaches nothing; and this is
   * a plain function called from `onClick`, so a submission has to be something
   * a person did to the Submit button.
   */
  async function submit() {
    const found = validateAll(form);
    if (found.length) {
      showErrors(found);
      // Land on the earliest step that has a problem, rather than reporting a
      // fault on a screen that cannot show the field it is about.
      const firstBad = STEP_IDS.find((id) => validateStep(id, form).length);
      if (firstBad) goTo(firstBad);
      setBanner("Some answers need a moment — they are marked below.");
      return;
    }

    if (!signedIn && !guestRequestsAllowed) {
      router.push(`/auth/login?next=${encodeURIComponent("/orders/new")}`);
      return;
    }
    if (!signedIn && !form.guest_email.trim()) {
      setErrors({ guest_email: "We need an email address to send your quote to." });
      setBanner("We need an email address to send your quote to.");
      return;
    }

    // Past every check that can refuse this locally, so from here a request can
    // genuinely leave. The door closes before the first `await`, which is the
    // only point early enough to beat a second click.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setBanner("");
    setErrors({});

    /** Nothing was sent, or what was sent failed. Let them try again. */
    const abandon = () => {
      inFlight.current = false;
      setBusy(false);
    };

    const {
      data: { user },
    } = await supabase.auth.getUser();

    /* -------- Uploads, for an account only -------- */
    const uploaded: { path: string; name: string; size: number; note: string }[] = [];
    if (user && files.length) {
      const batch = crypto.randomUUID();
      for (const entry of files) {
        const path = `${user.id}/${batch}/${crypto.randomUUID()}-${safeStorageName(entry.file.name)}`;
        const result = await supabase.storage
          .from("order-assets")
          .upload(path, entry.file, { contentType: storageContentType(entry.file), upsert: false });

        if (result.error) {
          // Everything already up comes back down, the offending file is marked
          // where the customer can see which one it was, and the form is left
          // exactly as it was. Nothing typed is lost to a failed upload.
          if (uploaded.length) {
            await supabase.storage.from("order-assets").remove(uploaded.map((item) => item.path));
          }
          setFiles((existing) =>
            existing.map((item) =>
              item.id === entry.id ? { ...item, error: `Upload failed: ${result.error.message}.` } : item
            )
          );
          setBanner(`We could not upload ${entry.file.name}. Nothing was sent — try again in a moment.`);
          abandon();
          return;
        }
        setFiles((existing) =>
          existing.map((item) => (item.id === entry.id ? { ...item, error: undefined } : item))
        );
        uploaded.push({ path, name: entry.file.name, size: entry.file.size, note: entry.note });
      }
    }

    const reference = normalizeReferenceUrl(form.reference_url);

    const {
      data: { session },
    } = await supabase.auth.getSession();

    let response: Response;
    try {
      response = await fetch("/api/orders/custom", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          ...form,
          reference_url: "error" in reference ? "" : reference.url,
          files: uploaded,
          checkout_token: submitToken.current,
          draft_id: draftId,
        }),
      });
    } catch {
      if (uploaded.length) {
        await supabase.storage.from("order-assets").remove(uploaded.map((item) => item.path));
      }
      setBanner("We could not reach KeyMoura just then. Your request is still here — try again.");
      abandon();
      return;
    }

    const result = (await response.json().catch(() => null)) as
      | { id?: string; href?: string; error?: string; field?: string }
      | null;

    if (!response.ok || !result?.id) {
      if (uploaded.length) {
        await supabase.storage.from("order-assets").remove(uploaded.map((item) => item.path));
      }
      if (result?.field) setErrors({ [result.field]: result.error ?? "Please check this." });
      setBanner(result?.error || "We could not send that request. Nothing was submitted — please try again.");
      abandon();
      return;
    }

    // Only now: the guard comes off and the local draft goes, because there is
    // a real request on the other side to go and look at.
    setSubmitted(true);
    try {
      window.sessionStorage.removeItem(GUEST_DRAFT_KEY);
    } catch {
      /* nothing to clean up */
    }
    // The server decides where this is readable from — an account page for a
    // session, the guest route for a token. Rebuilding that path here is how a
    // guest gets sent to a page that refuses them.
    router.push(result.href ?? `/orders/${result.id}/confirmed`);
  }

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const stepProps = { form, set, errors, products };

  return (
    <div className="request-layout">
      <aside className="request-aside-column">
        <p className="request-eyebrow">Custom project request</p>
        <h1 className="request-title">Tell us what you need made.</h1>
        <p className="request-lede">
          A sketch, a photo, or a plain description is enough to start. You will get a written quote to look
          at before anything is charged.
        </p>

        <div className="ui-card mt-7">
          <h2 className="text-sm font-semibold">What happens after you send this</h2>
          <ol className="request-timeline">
            <li>We read it and check we can actually make it.</li>
            <li>We ask questions if anything is unclear.</li>
            <li>You get a written price and payment schedule.</li>
            <li>Work starts only once you approve that quote.</li>
          </ol>
        </div>

        {drafts.length ? (
          <div className="ui-card mt-5">
            <h2 className="text-sm font-semibold">Your saved drafts</h2>
            <div className="mt-3 space-y-2">
              {drafts.map((draft) => (
                <div key={draft.id} className={cx("request-draft", draftId === draft.id && "is-current")}>
                  <button type="button" onClick={() => loadDraft(draft)} className="request-draft-open">
                    <span className="block truncate font-medium">{draft.title}</span>
                    <span className="request-draft-date">
                      Updated {new Date(draft.updated_at).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteDraft(draft.id)}
                    className="ui-btn ui-btn-ghost text-xs"
                    aria-label={`Delete draft ${draft.title}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <p className="mt-3 text-xs text-brand-textMuted">Drafts keep your answers, but not attachments.</p>
          </div>
        ) : null}
      </aside>

      {/*
        A `<form>` for its semantics — labels, autofill, one landmark for the
        answers — and for nothing else. It never submits.

        Every submission is refused here rather than routed anywhere: the only
        way to send this request is the Submit button's own `onClick`. That is
        what makes "reaching the review step submitted my request" unreachable
        by construction rather than by inspection — a stray Enter in the email
        field, a `type="submit"` added to some future control, and the exact
        button-morph that caused it the first time all arrive at this line and
        stop.
      */}
      <form onSubmit={(event: FormEvent) => event.preventDefault()} className="request-form" noValidate>
        {/* ---------------- Progress ---------------- */}
        <ol className="ui-stepper request-stepper" aria-label="Request progress">
          {STEPS.map((entry, position) => {
            const isCurrent = entry.id === step;
            const visited = position <= furthest;
            const done = visited && !isCurrent;
            return (
              <li key={entry.id} className="contents">
                <button
                  type="button"
                  data-step={position + 1}
                  disabled={!visited || isCurrent}
                  onClick={() => visited && goTo(entry.id)}
                  aria-current={isCurrent ? "step" : undefined}
                  className={cx("ui-step request-step-chip", isCurrent && "is-current", done && "is-complete")}
                >
                  {/*
                    Five equal columns and a marker leave about 110px for a
                    label, so "Quantity & delivery" ends as "Quantity & …".
                    Everyone not using a pointer already had the whole thing —
                    it is the button's accessible name, which `truncate` only
                    clips visually — and this is the half that was missing.
                    Same `title`-on-the-clipped-element pattern the attachment
                    list uses for a long filename, rather than a wider chip:
                    growing these is what breaks the row at 768px.
                  */}
                  <span className="truncate" title={entry.label}>
                    {entry.label}
                  </span>
                  <span className="sr-only">
                    {isCurrent ? " (current step)" : visited ? " (answered — go back to it)" : " (not yet reached)"}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <h2 ref={headingRef} tabIndex={-1} className="request-heading">
          {current.heading}
        </h2>
        <p className="request-step-lede">{current.lede}</p>

        {/* ---------------- Bodies ---------------- */}
        {step === "project" ? <ProjectStep {...stepProps} /> : null}
        {step === "details" ? <DetailsStep {...stepProps} /> : null}
        {step === "files" ? <FilesStep {...stepProps} files={files} setFiles={setFiles} signedIn={signedIn} /> : null}
        {step === "logistics" ? <LogisticsStep {...stepProps} /> : null}
        {step === "review" ? (
          <ReviewStep
            form={form}
            files={files}
            goTo={goTo}
            signedIn={signedIn}
            accountEmail={accountEmail}
            guestRequestsAllowed={guestRequestsAllowed}
            identityKnown={identityKnown}
            set={set}
            errors={errors}
            initialProductName={initialProduct?.name ?? null}
            productName={products.find((entry) => entry.slug === form.product_slug)?.name ?? null}
          />
        ) : null}

        {banner ? (
          <Notice tone="danger" role="alert" className="mt-6">
            {banner}
          </Notice>
        ) : null}

        {/* ---------------- Controls ---------------- */}
        <div className="request-actions">
          {index > 0 ? (
            <button type="button" onClick={back} className="ui-btn ui-btn-ghost" disabled={busy}>
              Back
            </button>
          ) : null}

          {/*
            Once the review has been seen, editing an earlier answer should not
            cost four presses of Continue to get back to it. The chip strip can
            do this too; this is the one that is where the customer's hand
            already is.
          */}
          {furthest === STEP_IDS.length - 1 && !isLast ? (
            <button type="button" onClick={() => goTo("review")} className="ui-btn ui-btn-secondary" disabled={busy}>
              Back to review
            </button>
          ) : null}

          <span className="request-saved" role="status" aria-live="polite">
            {savedNote}
          </span>

          {/*
            The two `key`s are load-bearing, not decoration.

            Without them these are one element to React — same tag, same slot —
            so it keeps the DOM node and patches the attribute, and the node the
            customer pressed as Continue finishes the click as a submit button.
            Distinct keys make it unmount one and mount the other, so there is
            no node in common for a `type` to change on.
          */}
          {isLast ? (
            <button
              key="submit"
              type="button"
              onClick={() => void submit()}
              disabled={busy || !identityKnown}
              className="ui-btn ui-btn-primary request-submit"
            >
              {busy ? "Sending…" : "Submit project request"}
            </button>
          ) : (
            <button key="continue" type="button" onClick={next} className="ui-btn ui-btn-primary request-submit">
              Continue
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step 3 — References
 * ------------------------------------------------------------------ */

function FilesStep({
  form,
  set,
  errors,
  files,
  setFiles,
  signedIn,
}: {
  form: CustomRequestForm;
  set: <K extends keyof CustomRequestForm>(key: K, value: CustomRequestForm[K]) => void;
  errors: Record<string, string>;
  files: PendingFile[];
  setFiles: (files: PendingFile[]) => void;
  signedIn: boolean;
}) {
  const linkId = "request-reference-url";

  return (
    <div className="request-step-body">
      <RequestFiles
        files={files}
        onChange={setFiles}
        disabled={!signedIn}
        disabledReason="Files upload into your own private folder, which needs an account. Send the request without them and we will ask for drawings by reply — or sign in first and attach them now."
      />

      <RequestField
        label={
          <>
            Reference link <span className="request-optional">optional</span>
          </>
        }
        htmlFor={linkId}
        error={errors.reference_url}
        help="Something that already exists and shows what you mean — a product page, a photo, a forum thread."
      >
        <input
          className="ui-input"
          type="url"
          inputMode="url"
          value={form.reference_url}
          onChange={(event) => set("reference_url", event.target.value.slice(0, 500))}
          placeholder="https://example.com/the-thing-i-mean"
          autoComplete="off"
          {...describedBy({ id: linkId, help: true, error: errors.reference_url })}
        />
      </RequestField>

      <p className="request-aside">
        Nothing here is required. A photo of the broken part with a tape measure next to it is often the most
        useful thing you can send.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Step 5 — Review
 * ------------------------------------------------------------------ */

function ReviewStep({
  form,
  files,
  goTo,
  signedIn,
  accountEmail,
  guestRequestsAllowed,
  identityKnown,
  set,
  errors,
  productName,
}: {
  form: CustomRequestForm;
  files: PendingFile[];
  goTo: (step: StepId) => void;
  signedIn: boolean;
  accountEmail: string;
  guestRequestsAllowed: boolean;
  identityKnown: boolean;
  set: <K extends keyof CustomRequestForm>(key: K, value: CustomRequestForm[K]) => void;
  errors: Record<string, string>;
  initialProductName: string | null;
  productName: string | null;
}) {
  const sections: { title: string; step: StepId; rows: [string, string][] }[] = [
    {
      title: "Project",
      step: "project",
      rows: [
        ["Name", resolvedTitle(form)],
        ["Kind of project", requestTypeLabel(form.request_type) || "—"],
        ...(form.product_slug ? ([["Based on", productName ?? form.product_slug]] as [string, string][]) : []),
      ],
    },
    {
      title: "Details",
      step: "details",
      rows: [
        ["What you want made", form.description.trim() || "—"],
        ...(form.context.trim() ? ([["Context", form.context.trim()]] as [string, string][]) : []),
        ["Size", describeDimensions(form) || "To be worked out together"],
        ["Material", describeMaterial(form)],
        ["Finish", describeFinish(form)],
      ],
    },
    {
      title: "References",
      step: "files",
      rows: [
        [
          "Files",
          files.length ? files.map((entry) => entry.file.name).join(", ") : "None attached",
        ],
        ...(form.reference_url.trim()
          ? ([["Link", form.reference_url.trim()]] as [string, string][])
          : []),
      ],
    },
    {
      title: "Quantity & delivery",
      step: "logistics",
      rows: [
        ["How many", `${form.quantity}${form.repeatability === "repeatable" ? " · may reorder" : " · one-off"}`],
        ["Budget", describeBudget(form)],
        ["Timing", describeTiming(form)],
        [
          "Delivery",
          form.delivery === "shipping" && form.postal_code.trim()
            ? `${deliveryLabel(form.delivery)} · ${form.postal_code.trim()}`
            : deliveryLabel(form.delivery),
        ],
      ],
    },
  ];

  return (
    <div className="request-step-body">
      {sections.map((section) => (
        <section key={section.title} className="request-summary">
          <div className="request-summary-head">
            <h3 className="request-summary-title">{section.title}</h3>
            <button type="button" onClick={() => goTo(section.step)} className="request-summary-edit">
              <FontAwesomeIcon icon={faPenToSquare} className="h-3 w-3" aria-hidden="true" />
              Edit
              <span className="sr-only"> {section.title}</span>
            </button>
          </div>
          <dl className="request-summary-rows">
            {section.rows.map(([label, value]) => (
              <div key={label} className="request-summary-row">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}

      {/* ---------------- Who this belongs to ---------------- */}
      <section className="request-summary">
        <div className="request-summary-head">
          <h3 className="request-summary-title">Contact</h3>
        </div>
        {!identityKnown ? (
          <p className="text-sm text-brand-textMuted">Checking who you are signed in as…</p>
        ) : signedIn ? (
          <p className="text-sm">
            This request will be saved to your account
            {accountEmail ? (
              <>
                {" "}
                (<span className="font-medium">{accountEmail}</span>)
              </>
            ) : null}
            , and you can follow it from your orders.
          </p>
        ) : guestRequestsAllowed ? (
          <div className="request-guest">
            <p className="text-sm text-brand-textMuted">
              You are not signed in, which is fine — we just need somewhere to send the quote.
            </p>
            <div className="request-pair mt-4">
              <RequestField label="Email" htmlFor="request-guest-email" required error={errors.guest_email}>
                <input
                  className="ui-input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={form.guest_email}
                  onChange={(event) => set("guest_email", event.target.value.slice(0, 200))}
                  placeholder="you@example.com"
                  {...describedBy({ id: "request-guest-email", error: errors.guest_email })}
                />
              </RequestField>
              <RequestField
                label={
                  <>
                    Name <span className="request-optional">optional</span>
                  </>
                }
                htmlFor="request-guest-name"
              >
                <input
                  className="ui-input"
                  type="text"
                  autoComplete="name"
                  value={form.guest_name}
                  onChange={(event) => set("guest_name", event.target.value.slice(0, 120))}
                  {...describedBy({ id: "request-guest-name" })}
                />
              </RequestField>
            </div>
            <p className="mt-3 text-xs text-brand-textMuted">
              You can read the quote, reply, and pay from this browser for {GUEST_ACCESS_WINDOW_LABEL}. After
              that we email a 6-digit code to open it — or{" "}
              <Link href={`/auth/login?next=${encodeURIComponent("/orders/new")}`} className="underline hover:no-underline">
                sign in
              </Link>{" "}
              to keep it in your account.
            </p>
          </div>
        ) : (
          <p className="text-sm">
            You will be asked to{" "}
            <Link href={`/auth/login?next=${encodeURIComponent("/orders/new")}`} className="underline hover:no-underline">
              sign in
            </Link>{" "}
            to send this request.
          </p>
        )}
      </section>

      {/*
        The commitment notice.
        ----------------------
        The single most important thing on this page, and the thing the previous
        form said in four words on a button. A custom project is the part of a
        shop where a customer is least sure what they have agreed to, and
        "Submit request — no charge" answers only the narrowest version of that
        worry. Both halves are stated: what this is not, and what it is.

        It is a notice and not a checkbox on purpose. Storefront 4.0 put the
        clickwrap at quote approval, which is where the contract actually forms;
        adding a second agreement here would ask a customer to accept terms for
        an inquiry, and would make the real one look like more of the same.
      */}
      <section className="request-commitment">
        <h3 className="request-commitment-title">Before you send this</h3>
        <div className="request-commitment-grid">
          <div>
            <p className="request-commitment-heading">Sending this does not</p>
            <ul className="request-commitment-list">
              <li>charge you anything</li>
              <li>start any work</li>
              <li>accept a price or a date</li>
            </ul>
          </div>
          <div>
            <p className="request-commitment-heading">It does</p>
            <ul className="request-commitment-list is-positive">
              <li>
                <FontAwesomeIcon icon={faCheck} className="h-3 w-3" aria-hidden="true" /> send your project to
                KeyMoura to review
              </li>
              <li>
                <FontAwesomeIcon icon={faCheck} className="h-3 w-3" aria-hidden="true" /> open a place to ask
                and answer questions
              </li>
              <li>
                <FontAwesomeIcon icon={faCheck} className="h-3 w-3" aria-hidden="true" /> lead to a written
                quote if we can make it
              </li>
            </ul>
          </div>
        </div>
        <p className="request-commitment-legal">
          We use what you send here only to review and quote your project — see our{" "}
          <Link href="/privacy" className="underline hover:no-underline">
            Privacy Notice
          </Link>
          . Nothing is agreed until you approve a quote, which is where our{" "}
          <Link href="/terms" className="underline hover:no-underline">
            Terms
          </Link>{" "}
          apply.
        </p>
      </section>

      {files.length > MAX_REQUEST_FILES ? (
        <Notice tone="warning">Only the first {MAX_REQUEST_FILES} files will be sent.</Notice>
      ) : null}
    </div>
  );
}
