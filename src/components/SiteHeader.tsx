"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { useNavUnread } from "@/lib/hooks/useNavUnread";
import { useSiteSettings } from "@/components/SiteSettingsProvider";
import CartIndicator from "@/components/commerce/CartIndicator";
import WishlistIndicator from "@/components/commerce/WishlistIndicator";
import NavMenu from "@/components/nav/NavMenu";
import AccountMenu from "@/components/nav/AccountMenu";
import NotificationBell from "@/components/nav/NotificationBell";
import MobileNavDrawer from "@/components/nav/MobileNavDrawer";
import ProductsMenu from "@/components/nav/ProductsMenu";
import StorefrontSearch from "@/components/nav/StorefrontSearch";
import { isNavItemActive, primaryNav, secondaryNav } from "@/lib/navigation";
import { resolveNavLogo } from "@/theme/brand";
import { EMPTY_STOREFRONT_NAV, type StorefrontNav } from "@/lib/commerce/storefrontNavModel";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faChevronDown } from "@fortawesome/free-solid-svg-icons";

type SimpleUser = { id: string; email: string | null };

type SimpleProfile = {
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

/**
 * The storefront header.
 *
 * ## What changed, and why the composition is what it is
 *
 * The previous bar was a three-column grid with the logo *centred* between two
 * halves of the navigation — About / Capabilities / Projects · KM · Catalog /
 * Contact / Community — plus a utility cluster carrying search, wishlist, cart,
 * a message bell, a notification bell, an account pill and a role-coloured
 * staff pill. That is a forum masthead. It reads as a community with a shop
 * attached, which is the opposite of the business.
 *
 * Three structural decisions:
 *
 * 1. **Logo left, not centred.** A centred logo forces the navigation to be
 *    split around it, which is what made the header symmetric and fragile — the
 *    pass-4 overlap came from two side columns being forced to equal widths.
 *    Logo-left gives one flexible column (the navigation) between two
 *    content-sized ones, so the thing that gives when space runs short is the
 *    part with a More menu to give into.
 *
 * 2. **Four customer links, in shopping order.** Products, Custom Projects,
 *    Gallery, About — all four on the bar, at every width. Capabilities, the
 *    design guide, Contact and Community moved into More; they are pages a
 *    customer reads once, not places they shop. Community keeps every route it
 *    had; it is reachable from More, the account menu's neighbourhood in the
 *    mobile drawer, and the footer.
 *
 *    Pass 4.0 additionally removed the duplicate rendering that put Gallery and
 *    About in *both* places — see `deskLinks` for what was actually happening.
 *
 * 3. **Utilities are Search, Notifications, Account, Wishlist, Cart.** Messages
 *    and staff access moved inside the account menu. Both are still one click
 *    away and the account trigger carries an unread dot, so nothing became
 *    undiscoverable — but neither competes with the cart for a customer's
 *    attention any more.
 *
 *    The order within that cluster was revised in 4.1: the commerce pair moved
 *    to the end so the bar terminates on the cart, which is the action the shop
 *    exists for. See the comment on the cluster itself.
 *
 * Every destination is read from `@/lib/navigation`, which the mobile drawer
 * reads too. The old header hard-coded the mobile list separately and the two
 * had already drifted apart.
 *
 * The desktop/More split is still pure CSS at a breakpoint rather than measured,
 * for the reason recorded in pass 4: a measured overflow has to guess a width
 * during server rendering and correct it after mount, which is a hydration
 * mismatch and a visible reflow on every page load.
 */
export default function SiteHeader({ productsNav = EMPTY_STOREFRONT_NAV }: { productsNav?: StorefrontNav }) {
  const pathname = usePathname();
  const siteSettings = useSiteSettings();

  const [user, setUser] = useState<SimpleUser | null>(null);
  const [displayName, setDisplayName] = useState<string>("");
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [myIsVerified, setMyIsVerified] = useState(false);
  const [myDonationRank, setMyDonationRank] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const mobileTriggerRef = useRef<HTMLButtonElement | null>(null);

  const { data: meAccess } = useMeAccess();
  const { data: unread } = useNavUnread(user?.id ?? null);

  const unreadMessages = unread?.messages ?? 0;
  const unreadNotifications = unread?.notifications ?? 0;

  useEffect(() => {
    const supabase = supabaseBrowser();

    const loadUserState = async (nextUser: { id: string; email?: string | null } | null) => {
      if (!nextUser) {
        setUser(null);
        setDisplayName("");
        setAvatarUrl(null);
        setMyIsVerified(false);
        setMyDonationRank(null);
        return;
      }

      setUser({ id: nextUser.id, email: nextUser.email ?? null });

      const { data } = await supabase
        .from("profiles")
        .select("username,display_name,avatar_url,is_verified,donation_rank")
        .eq("id", nextUser.id)
        .maybeSingle();

      const profile = (data ?? null) as SimpleProfile | null;
      setDisplayName(profile?.display_name || profile?.username || "");
      setAvatarUrl(profile?.avatar_url ?? null);
      setMyIsVerified(Boolean(profile?.is_verified));
      setMyDonationRank(profile?.donation_rank ?? null);
    };

    supabase.auth.getUser().then(({ data: { user: current } }) => {
      void loadUserState(current);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void loadUserState(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Auto-hide on scroll, when the operator has chosen it.
  useEffect(() => {
    if (siteSettings.theme.navigationBehavior === "sticky") return;
    let lastY = typeof window !== "undefined" ? window.scrollY : 0;

    const onScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastY;
      if (Math.abs(delta) < 8) {
        lastY = currentY;
        return;
      }
      if (currentY > 80 && delta > 0) setHidden(true);
      else if (delta < 0) setHidden(false);
      lastY = currentY;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [siteSettings.theme.navigationBehavior]);

  /**
   * Opening the drawer un-hides the bar.
   *
   * The render already refuses to translate the header while the drawer is
   * open, so this is not about the open state — it is about the moment it
   * closes. Without it, a customer who scrolls down (bar hides), opens the
   * menu, and dismisses it gets the header sliding away underneath them,
   * taking the button they just pressed with it.
   */
  const toggleMobile = () =>
    setIsMobileOpen((value) => {
      if (!value) setHidden(false);
      return !value;
    });

  // Route changes close the drawer. Next's client navigation keeps this
  // component mounted, so without it the panel survives the navigation — which
  // matters most for a back-button press, where no link inside the drawer was
  // clicked to close it.
  //
  // Adjusted during render rather than in an effect. React re-runs the render
  // immediately with the new state and never commits the stale open panel, so
  // there is no flash of the drawer over the new page; an effect would paint it
  // once first. This is React's documented pattern for deriving state from a
  // changed prop.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    if (isMobileOpen) setIsMobileOpen(false);
  }

  const staffRole = String(meAccess?.role ?? "").toLowerCase();
  const isStaff = meAccess?.isStaff ?? ["admin", "moderator", "mod", "support"].includes(staffRole);

  const isHome = pathname === "/";
  const isStaffRoute = pathname.startsWith("/staff");

  const openSearch = () => {
    if (typeof window !== "undefined") window.dispatchEvent(new Event("open-command-palette"));
  };

  const navLinkClass = (href: string) =>
    `site-nav-link site-nav-primary-link${isNavItemActive({ href }, pathname) ? " is-active" : ""}`;

  const utilityClass = "site-nav-utility site-nav-control";

  /*
   * Which primary links get a slot on the bar.
   *
   * `primaryNav` is still the one source; this only decides where each entry is
   * *rendered*. Products is handled separately by `ProductsMenu` because it is
   * a link with a menu attached, so it is filtered out here.
   *
   * ## Gallery and About are no longer rendered twice
   *
   * Pass 4.1 put them on the bar from `xl` and into More below it, rendered in
   * both places with CSS hiding whichever copy did not apply. Its comment said
   * "exactly one visible at a time". That is not what shipped: the More copy
   * carries `.nav-menu-item { display: flex }`, declared ~450 lines *after*
   * `@media (min-width: 1280px) { .site-more-item-narrow { display: none } }`.
   * Both selectors are one class, so the later one wins, and the hidden copy
   * was never hidden — a desktop customer got Gallery and About on the bar and
   * again inside More, which is the duplication the owner reported.
   *
   * Rather than repair the override and keep a mechanism whose correctness rests
   * on the source order of two unrelated rules, the duplicate is gone: these are
   * primary destinations and they live on the bar at every width. More holds
   * `secondaryNav` and nothing else, so a destination is in exactly one place
   * and no rule has to hide anything.
   *
   * The width this buys back at 1024–1279 comes from the link treatment: with
   * the pill removed, the links no longer carry a border and a lozenge's worth
   * of horizontal padding.
   */
  const deskLinks = useMemo(() => primaryNav.filter((item) => item.href !== "/catalog"), []);

  const moreContainsCurrent = useMemo(
    () => secondaryNav.some((item) => isNavItemActive(item, pathname)),
    [pathname]
  );

  /*
   * One decision about which mark the bar draws, and whether the name sits
   * beside it. Both header rows read this — the alternative was two components
   * each testing the pathname, which is how two surfaces start disagreeing about
   * what counts as the homepage.
   */
  const navLogo = resolveNavLogo(siteSettings.brand, { isHome, siteName: siteSettings.name });

  const headerStyle = { borderColor: "var(--km-nav-border)" };

  return (
    <header
      className={`site-header-shell sticky top-0 z-60 border-b backdrop-blur-md transition-transform duration-200 ${
        siteSettings.theme.navigationBehavior === "auto-hide" && hidden && !isMobileOpen
          ? "-translate-y-full"
          : "translate-y-0"
      }`}
      style={headerStyle}
      data-staff-route={isStaffRoute ? "true" : undefined}
    >
      <div className="site-header-inner">
        {/* DESKTOP
            `auto minmax(0,1fr) auto` — the brand and the utilities size to
            their own content and the navigation is the flexible column. The
            utility cluster is additionally `shrink-0`, because a compressed
            cart button is a cart button someone cannot press. */}
        <div
          className="site-header-desktop hidden min-w-0 items-center gap-4 lg:grid"
          data-testid="desktop-header"
        >
          {/*
            `aria-label` on the link, `alt=""` on the image.

            The mark is decorative *because the link is named* — with the name
            beside it, an `alt` would have a screen reader say "KeyMoura
            KeyMoura, link". With the name turned off there is nothing beside it,
            and the label is the only thing standing between a customer and a
            link announced as "image". So the accessible name never comes from
            what is drawn; it is always on the link, and turning the wordmark off
            is a purely visual choice. `resolveNavLogo` supplies it.
          */}
          <Link
            href="/"
            aria-label={navLogo.label}
            className={`site-header-brand ${isHome ? "" : "hover:opacity-90"}`}
          >
            {navLogo.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={navLogo.src}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 object-contain"
              />
            ) : null}
            {navLogo.showName ? (
              siteSettings.wordmarkUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={siteSettings.wordmarkUrl}
                  alt=""
                  className="hidden h-6 max-w-32 object-contain xl:block"
                />
              ) : (
                <span className="site-header-wordmark hidden xl:inline">{siteSettings.name}</span>
              )
            ) : null}
          </Link>

          <nav className="site-header-nav" aria-label="Primary" data-testid="primary-navigation-group">
            <ProductsMenu
              nav={productsNav}
              isActive={isNavItemActive({ href: "/catalog" }, pathname)}
              controlClassName={navLinkClass("/catalog")}
            />

            {/*
              Custom Projects always; Gallery and About from `xl`.

              This is the intentional handoff for the 1024–1279 band. Search now
              wants real width on the bar, and at 1024 the four links plus the
              utilities left it about 260px — a field the size of the button it
              replaced. Rather than shrink search back down, the two links a
              customer reads once move into More below `xl`, where More already
              is. They are rendered twice with exactly one visible at a time:
              `display: none` removes the hidden copy from the accessibility
              tree and the tab order, so nobody meets a duplicate.
            */}
            {deskLinks.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={navLinkClass(item.href)}
                aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}

            <NavMenu
              triggerClassName={`site-nav-link site-nav-primary-link inline-flex items-center gap-1.5${
                moreContainsCurrent ? " is-active" : ""
              }`}
              menuLabel="More destinations"
              align="left"
              panelClassName="w-60 overflow-hidden rounded-2xl border p-1.5 shadow-2xl"
              trigger={
                <>
                  More
                  <FontAwesomeIcon icon={faChevronDown} className="h-2.5 w-2.5 shrink-0" aria-hidden="true" />
                </>
              }
            >
              {secondaryNav.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  tabIndex={-1}
                  aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
                  className="nav-menu-item nav-menu-item-stacked"
                >
                  <span className="font-medium">{item.label}</span>
                  {item.description ? (
                    <span className="nav-menu-item-description">{item.description}</span>
                  ) : null}
                </Link>
              ))}
            </NavMenu>
          </nav>

          {/* The storefront's search, on the bar rather than behind an icon. */}
          <StorefrontSearch className="site-header-search" />

          {/*
            Search → Notifications → Account → Wishlist → Cart.

            The order was Wishlist, Cart, Notifications, Account, which put the
            two things a customer is *carrying* in the middle of the cluster and
            ended the bar on a profile avatar. A storefront header should read
            left to right as find it → who am I → what have I saved → what am I
            buying, and it should end on the buying.

            So the personal controls come first and the commerce pair is the
            terminus, with Cart last. Wishlist sits immediately before it because
            the two are the same gesture at different levels of commitment — a
            customer moving items between them should not have to cross the
            account menu to do it.

            Notifications keep their slot rather than being folded away for
            symmetry: they are the only control here that can be *new*, and
            burying an unread badge is how it stops being read.
          */}
          <div className="flex shrink-0 items-center justify-end gap-2" data-testid="header-utilities">
            {/* The magnifier used to live here and is gone on purpose: the bar
                now carries a real search field, and a second control opening a
                modal search beside it is two answers to one question. Ctrl+K
                still opens the site-wide palette for anyone who knows it. */}

            {user ? (
              <>
                <NotificationBell userId={user.id} desktopPillBase="site-nav-control" />
                <AccountMenu
                  triggerClassName={`${utilityClass} site-nav-account`}
                  pathname={pathname}
                  displayName={displayName}
                  email={user.email}
                  avatarUrl={avatarUrl}
                  isVerified={myIsVerified}
                  donationRank={myDonationRank}
                  isStaff={isStaff}
                  unreadMessages={unreadMessages}
                  unreadNotifications={unreadNotifications}
                />
              </>
            ) : (
              <Link href="/auth/login" className="site-nav-signin">
                Log in
              </Link>
            )}

            {/* Guests build carts and wishlists too; hiding these from them
                loses what they just filled. Which is also why they stay *after*
                the account slot rather than inside it — a guest has no account
                menu, and these two must not move when they sign in. */}
            <WishlistIndicator />
            <CartIndicator />
          </div>
        </div>

        {/* MOBILE — logo, search, cart, menu. Wishlist, account, orders and
            everything else live in the drawer, because eight controls on a
            320px bar is how the badges started clipping each other. */}
        <div className="site-header-mobile lg:hidden">
          <div className="site-header-mobile-row">
          {/* Same logo decision as the desktop bar, and the same accessible
              name. The phone bar has never drawn the wordmark — there is no room
              — so `showName` is not consulted here; the label carries identity
              either way. */}
          <Link href="/" aria-label={navLogo.label} className="site-header-brand">
            {navLogo.src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={navLogo.src}
                alt=""
                width={36}
                height={36}
                className="h-9 w-9 shrink-0 object-contain"
              />
            ) : null}
          </Link>

          <div className="flex shrink-0 items-center gap-1.5">
            <CartIndicator />

            <button
              ref={mobileTriggerRef}
              type="button"
              onClick={toggleMobile}
              className={`${utilityClass} site-nav-count-host`}
              aria-label={isMobileOpen ? "Close menu" : "Open menu"}
              aria-expanded={isMobileOpen}
              aria-haspopup="dialog"
            >
              <FontAwesomeIcon icon={faBars} className="h-4 w-4" aria-hidden="true" />
              {user && unreadMessages + unreadNotifications > 0 ? (
                <span className="site-nav-dot" aria-hidden="true" />
              ) : null}
            </button>
          </div>
          </div>

          {/*
            Row two: search, at the full width of the bar.

            Squeezing it into row one alongside the logo, the cart and the menu
            gave it about 120px at 375px, which is a field you cannot read your
            own query in. A second row costs 52px of vertical space on a phone
            and makes the shop's primary action a full-width tap target.
          */}
          <StorefrontSearch className="site-header-mobile-search" />
        </div>
      </div>

      <MobileNavDrawer
        open={isMobileOpen}
        onClose={() => setIsMobileOpen(false)}
        triggerRef={mobileTriggerRef}
        pathname={pathname}
        isStaff={isStaff}
        signedIn={Boolean(user)}
        onOpenSearch={openSearch}
        unreadMessages={unreadMessages}
        unreadNotifications={unreadNotifications}
        productsNav={productsNav}
      />
    </header>
  );
}
