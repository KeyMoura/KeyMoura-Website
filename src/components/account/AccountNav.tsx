"use client";

import { SectionNav } from "@/components/ui/SectionNav";
import { accountSectionNav } from "@/lib/navigation";

/**
 * The account area's section tabs.
 *
 * Two things changed here, and they are the same change seen from either end.
 *
 * The destinations now come from `accountSectionNav` instead of a list private
 * to this file, so the account menu in the header and the tabs inside the
 * account agree about what an account section is — and every entry is genuinely
 * under `/account`, which was not true while order history and notifications
 * lived at the site root.
 *
 * The treatment now comes from `SectionNav`, so this reads as navigation rather
 * than as a row of filters. It previously drew the current tab as a filled
 * brand-coloured pill: the loudest control on the page, competing with the
 * primary buttons under it, and identical in shape to the *filter* tabs on the
 * order list directly below — two different jobs wearing the same clothes.
 */
export function AccountNav() {
  return <SectionNav items={accountSectionNav} ariaLabel="Customer account" />;
}
