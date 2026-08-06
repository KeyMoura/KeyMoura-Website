/**
 * What a consequential staff action can come back as, and how an HTTP response
 * becomes one.
 *
 * Kept out of the component so it can be tested directly — the mapping is the
 * part with rules in it, and the rules matter: which server messages reach a
 * screen, and which failures are allowed to be retried.
 */

export type ConflictState = {
  /** The sentence to show. Never a raw database error. */
  message: string;
  /** What the server says the state is now, when it says. */
  currentState?: string | null;
};

export type ActionResult =
  | { ok: true; message?: string }
  /**
   * A stale-page conflict. The caller shows it and **withholds the button**:
   * re-submitting a consequential action against state that has moved is
   * exactly what the guards exist to prevent.
   */
  | { ok: false; conflict: ConflictState }
  /** Anything else. Safe to try again. */
  | { ok: false; error: string };

/**
 * Turn a response into an `ActionResult`.
 *
 * Every caller needs the same three-way split, and the same rule about what a
 * server message may be shown. Keeping it in one place means a route that
 * starts returning a raw Postgres error cannot leak it through one panel that
 * forgot to sanitise.
 *
 * 409 is the conflict signal across the whole staff API — chosen in pass 8 and
 * kept. Guarded updates that match zero rows, transition graphs that refuse, and
 * over-refunds all answer 409, and all of them mean the same thing to an
 * operator: what you were looking at is out of date.
 */
export async function resultFromResponse(
  response: Response,
  fallback = "That action could not be completed."
): Promise<ActionResult> {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: unknown;
    status?: unknown;
    currentStatus?: unknown;
  };
  const message = typeof payload.error === "string" && payload.error.trim() ? payload.error.trim() : "";

  if (response.ok) return { ok: true };

  if (response.status === 409) {
    const current =
      typeof payload.currentStatus === "string"
        ? payload.currentStatus
        : typeof payload.status === "string"
          ? payload.status
          : null;
    return {
      ok: false,
      conflict: {
        message: message || "Somebody else acted on this order first.",
        currentState: current ? current.replaceAll("_", " ") : null,
      },
    };
  }

  if (response.status === 403) {
    return { ok: false, error: message || "Your account does not have permission to do this." };
  }

  /*
   * A 500 is stated generically on purpose.
   *
   * It carries nothing an operator can act on, and it is the status a route
   * returns when something unplanned happened — which is exactly when a message
   * is most likely to contain a schema name, a constraint, or a row value. The
   * server's text is dropped rather than shown.
   */
  if (response.status >= 500) {
    return { ok: false, error: "Something went wrong on our side. Nothing was changed. Try again in a moment." };
  }

  return { ok: false, error: message || fallback };
}
