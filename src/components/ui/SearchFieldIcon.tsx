import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass } from "@fortawesome/free-solid-svg-icons";

/**
 * The magnifier that sits inside a search field.
 *
 * ## Why this is a component and not four lines of JSX
 *
 * `/projects` was corrected a pass ago: its chip-search drew the 🔍 emoji, which
 * is not an icon at all — it renders as whatever glyph the operating system
 * ships, full colour on macOS and Windows, a different angle on Android, at a
 * size and baseline the surrounding text controls rather than the design does.
 * Beside a navbar whose search is a monochrome Font Awesome glyph, the two never
 * matched on any platform.
 *
 * That correction was made in one file. The same emoji stayed in the *nested*
 * route — `/projects/category/cnc-machining` — and in `/garage` and the two
 * community pages, all of which are copies of the same chip-search control. So
 * a customer who clicked into a category from the page that had been fixed
 * watched the icon change under them, which is the bug as reported.
 *
 * The fix is not a fifth copy of the corrected markup. Every surface that draws
 * a magnifier inside a field now imports this, so there is one definition to
 * change and nothing to keep in sync. The navbar (`.storefront-search-icon`) and
 * the catalog (`.commerce-search-icon`) draw the same `faMagnifyingGlass` from
 * the same package, positioned by their own stylesheets; this component is for
 * the inline case, where the icon is a flex child of the field rather than
 * absolutely positioned inside it.
 *
 * Always `aria-hidden`. Every field it sits in has a real label, and an
 * announced icon beside a labelled input is a second name for one control.
 */
export default function SearchFieldIcon({ className = "" }: { className?: string }) {
  return (
    <FontAwesomeIcon
      icon={faMagnifyingGlass}
      className={`mr-1.5 h-3.5 w-3.5 shrink-0 text-brand-textMuted ${className}`.trim()}
      aria-hidden="true"
    />
  );
}
