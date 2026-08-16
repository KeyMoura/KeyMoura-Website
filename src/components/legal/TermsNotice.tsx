import Link from "next/link";

/**
 * The Terms notice that sits beside an action, not in the footer.
 *
 * ## Why there are three of these and not one
 *
 * Agreement UX is not one thing. The strength has to match what the customer is
 * actually committing to, and using the strongest form everywhere trains people
 * to tick boxes without reading them:
 *
 *   - `browse` — nothing. Reading the shop requires no agreement, and this pass
 *     deliberately adds no gate to public browsing. The Terms and Privacy links
 *     stay in the footer, which is where a customer looks for them.
 *   - `signup` — an **action-adjacent notice**. Creating an account is a real
 *     relationship but not a purchase, so the conventional and proportionate
 *     form is a conspicuous sentence next to the button, with both documents
 *     linked. No checkbox: an unnecessary one is friction that buys nothing.
 *   - `checkout` — the same, next to the button that takes money.
 *   - `custom_order` — a **checkbox**, and the only one, because approving a
 *     quote authorises KeyMoura to start making a one-off object against the
 *     customer's own specification. That is the point in this business where
 *     cancellation stops being free and material starts being cut.
 *
 * The checkbox variant is rendered by the surface that owns the action, because
 * it has to be wired to that action's disabled state and its payload. This
 * component provides the *wording* for all four so the sentence cannot drift
 * between surfaces.
 */

export function TermsInlineNotice({
  variant,
  className = "",
}: {
  variant: "signup" | "checkout";
  className?: string;
}) {
  return (
    <p className={`terms-notice ${className}`.trim()}>
      {variant === "signup" ? (
        <>
          By creating an account you agree to the{" "}
          <Link href="/terms" className="terms-notice-link">
            Terms of Service
          </Link>{" "}
          and acknowledge the{" "}
          <Link href="/privacy" className="terms-notice-link">
            Privacy Policy
          </Link>
          .
        </>
      ) : (
        <>
          By placing your order you agree to the{" "}
          <Link href="/terms" className="terms-notice-link">
            Terms of Service
          </Link>
          , including the{" "}
          <Link href="/refunds" className="terms-notice-link">
            cancellation and refund policy
          </Link>
          .
        </>
      )}
    </p>
  );
}

/**
 * The custom-order clickwrap.
 *
 * Controlled by the caller, because the *server* is what enforces this — the
 * checkbox is how a customer expresses the agreement, not how it is checked.
 * `POST /api/orders/[id]/quote` refuses the approval outright when the
 * agreement or the Terms version is missing or stale, so a direct API call, a
 * stale tab, or a manipulated client cannot approve a quote without it.
 */
export function CustomOrderAgreement({
  checked,
  onChange,
  disabled = false,
  id = "custom-order-agreement",
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <div className="terms-agreement">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="terms-agreement-box"
      />
      <label htmlFor={id} className="terms-agreement-label">
        I agree to the{" "}
        <Link href="/terms" className="terms-notice-link">
          Terms of Service
        </Link>{" "}
        and understand this quote authorises custom work to begin — once
        production starts, the{" "}
        <Link href="/refunds" className="terms-notice-link">
          cancellation and refund policy
        </Link>{" "}
        applies to a made-to-order item.
      </label>
    </div>
  );
}
