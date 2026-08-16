"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowRight, faXmark } from "@fortawesome/free-solid-svg-icons";

import {
  ANNOUNCEMENT_STORAGE_KEY,
  announcementVersion,
  hasAnnouncementCta,
  isExternalAnnouncementHref,
  type AnnouncementConfig,
} from "@/theme/announcement";

/**
 * The storefront announcement bar.
 *
 * ## What it replaced
 *
 * A severity pill reading `INFO`, a centred sentence, and a circled `×` —
 * the shape of an operations alert, because that is literally what it was: the
 * security broadcast banner, pressed into service to say "Launching 9/01/2026"
 * because it was the only site-wide message the site had. `theme/announcement.ts`
 * records why merchandising and incident notices were separated rather than
 * sharing one control.
 *
 * ## The layout
 *
 * One row, left-aligned, reading as a sentence: an optional short label, the
 * message, then an optional call to action. Centring the text was part of what
 * made the old one look like a system dialog — nothing else on this storefront
 * is centred, and a centred line with a pill floating to its left and a button
 * to its right has three competing focal points and no reading order.
 *
 * The close control sits at the end of the row rather than at the edge of the
 * viewport, so on a wide screen it stays with the message instead of stranding
 * itself a few hundred pixels away from the thing it closes.
 *
 * ## Why the message renders on the server and hides on the client
 *
 * Whether the announcement is *enabled and in its scheduled window* is decided
 * during server render, so no clock is shipped to the browser and there is no
 * hydration mismatch. Whether **this reader** has dismissed it can only be known
 * in the browser, and reading storage during render would produce markup that
 * disagrees with the server's.
 *
 * So it renders, and then hides itself if it has been dismissed. A reader who
 * dismissed the current announcement sees it for one frame on a cold load. The
 * alternative — render nothing, then reveal — puts that same flash in front of
 * *everyone who has not dismissed it*, which is almost all traffic, and moves
 * the layout shift onto the common path. Reading a cookie on the server would
 * remove both, at the cost of opting the whole storefront out of static
 * rendering; that is not a trade worth making for a promo bar.
 */
/**
 * Which announcement version this browser has dismissed, as an external store.
 *
 * `useSyncExternalStore` rather than a `useState` seeded from an effect. Local
 * storage genuinely *is* an external store — it changes without React's
 * knowledge, including from another tab — and this is the API for reading one:
 * it gives a server snapshot for SSR, re-reads after hydration, and re-renders
 * when the store changes. Reading it in an effect and calling `setState` would
 * be a cascading render, and would also miss the cross-tab case.
 *
 * `getServerSnapshot` returns null — "nothing dismissed" — which is the only
 * honest answer on the server, and is why the bar renders and then hides rather
 * than the other way round. The component's own comment covers that trade.
 */
const dismissalListeners = new Set<() => void>();

function subscribeToDismissal(onChange: () => void) {
  dismissalListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    dismissalListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Tell subscribers the store changed.
 *
 * Necessary because the `storage` event deliberately does **not** fire in the
 * tab that performed the write — it exists to notify *other* tabs. Without this,
 * pressing dismiss would update local storage and leave the bar on screen until
 * something else happened to re-render it.
 */
function setDismissalTick() {
  for (const listener of dismissalListeners) listener();
}

function readDismissal(): string | null {
  try {
    return window.localStorage.getItem(ANNOUNCEMENT_STORAGE_KEY);
  } catch {
    // Storage throws in some private modes and under strict cookie policies.
    // The announcement showing is a far better failure than the page erroring.
    return null;
  }
}

const serverDismissal = () => null;

export default function AnnouncementBar({ config }: { config: AnnouncementConfig }) {
  const version = announcementVersion(config);
  const storedVersion = useSyncExternalStore(subscribeToDismissal, readDismissal, serverDismissal);

  /*
   * A non-dismissible announcement clears any stored key.
   *
   * Otherwise an owner who turns dismissal *off* leaves everybody who already
   * dismissed the message unable to see it, with no control on screen that
   * could bring it back — the one state where "dismissed forever" is invisible
   * to both the reader and the owner. This writes to the external store and
   * lets the subscription above deliver the change back, rather than setting
   * component state.
   */
  useEffect(() => {
    if (config.dismissible || storedVersion === null) return;
    try {
      window.localStorage.removeItem(ANNOUNCEMENT_STORAGE_KEY);
    } catch {
      /* see readDismissal */
    }
    setDismissalTick();
  }, [config.dismissible, storedVersion]);

  if (config.dismissible && storedVersion === version) return null;

  const dismiss = () => {
    try {
      // One key holding one short hash. The key is derived from the words on
      // screen, so editing the message brings it back for everyone without the
      // owner having to remember a version field.
      window.localStorage.setItem(ANNOUNCEMENT_STORAGE_KEY, version);
    } catch {
      /* dismissal simply does not persist */
    }
    setDismissalTick();
  };

  const showCta = hasAnnouncementCta(config);
  const external = showCta && isExternalAnnouncementHref(config.ctaHref);

  return (
    /*
     * A labelled region, not an alert. `role="alert"` interrupts a screen
     * reader mid-sentence and is right for "the site is in maintenance mode" —
     * which is the *other* banner. A sale is something to find when you get
     * there, so this is a landmark that can be skipped and returned to.
     */
    <aside
      className="announcement-bar"
      data-tone={config.tone}
      aria-label="Site announcement"
      data-testid="announcement-bar"
    >
      <div className="announcement-bar-inner">
        {config.label ? <span className="announcement-bar-label">{config.label}</span> : null}

        <p className="announcement-bar-message">{config.message}</p>

        {showCta ? (
          <Link
            href={config.ctaHref}
            className="announcement-bar-cta"
            /*
             * External links get `rel` and nothing else. No `target="_blank"`:
             * deciding on a reader's behalf to open a tab takes the back button
             * away from everyone who did not want one, and there is nothing
             * about a promo link that needs the current page kept alive.
             */
            {...(external ? { rel: "noopener noreferrer" } : {})}
          >
            {config.ctaText}
            <FontAwesomeIcon icon={faArrowRight} className="h-2.5 w-2.5" aria-hidden="true" />
          </Link>
        ) : null}

        {/* No close control when dismissal is off — a × that does nothing, or
            that reappears on the next page, is worse than no × at all. */}
        {config.dismissible ? (
          <button
            type="button"
            onClick={dismiss}
            className="announcement-bar-close"
            aria-label="Dismiss announcement"
          >
            <FontAwesomeIcon icon={faXmark} className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </aside>
  );
}
