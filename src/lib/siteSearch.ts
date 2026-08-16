/**
 * Ranking for the global site search.
 *
 * Kept free of React and of any Supabase client so the scoring rules can be
 * tested directly, and so the palette component stays a rendering concern.
 *
 * Everything indexed here is either publicly readable (published projects,
 * public threads, published catalog products) or a plain navigation
 * destination. No order, message, or account record is ever placed in the
 * index; signed-in visitors get links to those areas, and the pages behind
 * them do their own authorization.
 */

export type SearchKind = "project" | "thread" | "product" | "destination";

export type ProjectItem = {
  kind: "project";
  id: string;
  title: string;
  slug: string;
  category: string | null;
  platform: string | null;
  tags: string[];
  body: string | null;
  updatedAt: string | null;
};

export type ThreadItem = {
  kind: "thread";
  id: string;
  title: string;
  slug: string;
  categorySlug: string;
  categoryName: string;
  replyCount: number;
  isPinned: boolean;
  isLocked: boolean;
  updatedAt: string | null;
};

export type ProductItem = {
  kind: "product";
  id: string;
  title: string;
  slug: string;
  category: string | null;
  summary: string | null;
  updatedAt: string | null;
};

export type DestinationItem = {
  kind: "destination";
  id: string;
  title: string;
  href: string;
  description: string;
  keywords: string[];
  /** Only offered to a signed-in visitor. */
  requiresAuth?: boolean;
};

export type SearchItem = ProjectItem | ThreadItem | ProductItem | DestinationItem;

export const KIND_LABELS: Record<SearchKind, string> = {
  product: "Catalog",
  project: "Projects",
  thread: "Community",
  destination: "Go to",
};

/** Rendering order of the result groups. */
export const KIND_ORDER: SearchKind[] = ["product", "project", "thread", "destination"];

export function itemHref(item: SearchItem): string {
  switch (item.kind) {
    case "product":
      return `/catalog/${item.slug}`;
    case "project":
      return `/projects/${item.slug}`;
    case "thread":
      return `/community/${item.categorySlug}/${item.slug}`;
    case "destination":
      return item.href;
  }
}

/**
 * Destinations make the palette a navigation tool as well as a content search.
 * Account entries link to pages that authorize their own requests; nothing
 * about a specific order or message is indexed.
 */
export const DESTINATIONS: DestinationItem[] = [
  { kind: "destination", id: "catalog", title: "Catalog", href: "/catalog", description: "Browse every published product", keywords: ["shop", "products", "buy", "store"] },
  { kind: "destination", id: "custom", title: "Request custom work", href: "/orders/new", description: "Start a custom order request", keywords: ["quote", "custom", "commission", "request", "order"] },
  { kind: "destination", id: "projects", title: "Projects", href: "/projects", description: "Build write-ups and reference pages", keywords: ["guides", "builds", "knowledge", "info", "articles"] },
  // Community is dormant (pass 14) and deliberately absent from this palette:
  // offering it here would be the one customer-facing entry point left after it
  // was taken out of the navigation and the footer. The routes still work for
  // anyone holding a link, and no content was removed.
  { kind: "destination", id: "capabilities", title: "Capabilities & materials", href: "/capabilities", description: "What this shop can make", keywords: ["materials", "aluminum", "wood", "plastic", "limits"] },
  { kind: "destination", id: "design-guide", title: "Design & tolerance guide", href: "/design-guide", description: "How to prepare a part for production", keywords: ["tolerance", "cad", "drawing", "design"] },
  // `id` stays `contact` — it is a stable identifier, and renaming it would
  // change nothing a person sees while breaking anything that stored it. The
  // href points at the real page rather than at the redirect.
  { kind: "destination", id: "contact", title: "Support", href: "/support", description: "Ask a question, or follow up on an order", keywords: ["support", "contact", "email", "help", "question", "refund", "return"] },
  { kind: "destination", id: "my-support", title: "My support requests", href: "/account/support", description: "Your questions and our replies", keywords: ["support", "ticket", "request", "conversation", "reply"], requiresAuth: true },
  { kind: "destination", id: "shipping", title: "Shipping", href: "/shipping", description: "Delivery and pickup information", keywords: ["delivery", "pickup", "post"] },
  { kind: "destination", id: "refunds", title: "Cancellations & refunds", href: "/refunds", description: "Order cancellation and refund policy", keywords: ["refund", "cancel", "return"] },
  { kind: "destination", id: "orders", title: "My orders", href: "/account/orders", description: "Your requests, quotes, and order status", keywords: ["orders", "quotes", "purchases", "status", "invoice"], requiresAuth: true },
  { kind: "destination", id: "account", title: "Account", href: "/account", description: "Profile, security, and preferences", keywords: ["profile", "settings", "password", "email"], requiresAuth: true },
  { kind: "destination", id: "messages", title: "Messages", href: "/messages", description: "Your direct message threads", keywords: ["dm", "inbox", "chat"], requiresAuth: true },
  { kind: "destination", id: "notifications", title: "Notifications", href: "/account/notifications", description: "Replies, mentions, and announcements", keywords: ["alerts", "mentions", "replies"], requiresAuth: true },
];

export function availableDestinations(signedIn: boolean): DestinationItem[] {
  return DESTINATIONS.filter((item) => !item.requiresAuth || signedIn);
}

// --- text matching -------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let previous = Array.from({ length: n + 1 }, (_, index) => index);
  let current = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    [previous, current] = [current, previous];
  }

  return previous[n];
}

export function normalizedSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return 1 - levenshtein(a, b) / longest;
}

/** Substring match, with a near-miss allowance for single-character typos. */
export function fieldMatchesToken(field: string, token: string): boolean {
  const haystack = field.toLowerCase();
  const needle = token.toLowerCase();
  if (!haystack || !needle) return false;
  if (haystack.includes(needle)) return true;

  for (const part of haystack.split(/\s+/)) {
    if (!part || Math.abs(part.length - needle.length) > 1) continue;
    if (normalizedSimilarity(part, needle) >= 0.7) return true;
  }
  return false;
}

export function tokenize(text: string): string[] {
  return text
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** The searchable fields of an item, heaviest first. */
function weightedFields(item: SearchItem): Array<[string, number]> {
  switch (item.kind) {
    case "product":
      return [
        [item.title, 14],
        [item.slug, 8],
        [item.category ?? "", 7],
        [item.summary ?? "", 5],
      ];
    case "project":
      return [
        [item.title, 12],
        [item.slug, 8],
        [item.tags.join(" "), 10],
        [item.platform ?? "", 7],
        [item.category ?? "", 6],
        [item.body ?? "", 4],
      ];
    case "thread":
      return [
        [item.title, 12],
        [item.slug, 7],
        [item.categoryName, 6],
        [item.categorySlug, 6],
      ];
    case "destination":
      return [
        [item.title, 15],
        [item.keywords.join(" "), 11],
        [item.description, 6],
        [item.href, 5],
      ];
  }
}

export type RankedItem = { item: SearchItem; score: number; matchedTokens: number };

/**
 * Scores every item against the typed fragment and the committed chips.
 *
 * With no query, results are ordered by kind and then recency so the palette
 * opens on something useful rather than an arbitrary list.
 */
export function rankSearchItems(items: readonly SearchItem[], fragment: string, chips: readonly string[]): RankedItem[] {
  const textTokens = tokenize(fragment);
  const chipTokens = chips.flatMap((chip) => tokenize(chip));
  const hasQuery = textTokens.length > 0 || chipTokens.length > 0;

  if (!hasQuery) {
    return items
      .map((item) => ({ item, score: 0, matchedTokens: 0 }))
      .sort((left, right) => {
        const byKind = KIND_ORDER.indexOf(left.item.kind) - KIND_ORDER.indexOf(right.item.kind);
        if (byKind !== 0) return byKind;
        return recency(right.item) - recency(left.item);
      });
  }

  const ranked = items.map((item) => {
    const fields = weightedFields(item);
    let score = 0;
    let matchedTokens = 0;

    for (const token of [...textTokens, ...chipTokens]) {
      let tokenScore = 0;
      let matched = false;
      for (const [value, weight] of fields) {
        if (value && fieldMatchesToken(value, token)) {
          tokenScore += weight;
          matched = true;
        }
      }
      if (matched) {
        matchedTokens += 1;
        score += Math.min(tokenScore, 24);
      }
    }

    if (matchedTokens > 0) {
      score += matchedTokens * 20;
      if (item.kind === "thread") score += Math.min(item.replyCount, 50) * 0.15 + (item.isPinned ? 2 : 0);
      // A tiny recency nudge, small enough that it only breaks ties.
      score += recency(item) / 1e15;
    }

    return { item, score, matchedTokens };
  });

  return ranked.filter((entry) => entry.matchedTokens > 0).sort((left, right) => right.score - left.score);
}

function recency(item: SearchItem): number {
  if (item.kind === "destination") return 0;
  const value = item.updatedAt ? new Date(item.updatedAt).getTime() : 0;
  return Number.isFinite(value) ? value : 0;
}

/** "Did you mean" for the last typed token, or null when it already matches. */
export function suggestTerm(items: readonly SearchItem[], lastToken: string): string | null {
  const needle = lastToken.trim().toLowerCase();
  if (needle.length < 3) return null;

  const candidates = new Set<string>();
  for (const item of items) {
    candidates.add(item.title);
    if (item.kind === "project") {
      if (item.category) candidates.add(item.category);
      if (item.platform) candidates.add(item.platform);
      for (const tag of item.tags) candidates.add(tag);
    }
    if (item.kind === "thread") candidates.add(item.categoryName);
    if (item.kind === "product" && item.category) candidates.add(item.category);
  }

  let best: string | null = null;
  let bestScore = 0;
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (lower.includes(needle)) return null;
    const score = normalizedSimilarity(needle, lower);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  // Only offer a correction that is genuinely close to what was typed.
  return best && bestScore >= 0.6 ? best : null;
}
