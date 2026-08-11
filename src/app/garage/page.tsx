"use client";

import type { ReactNode, KeyboardEvent, ChangeEvent } from "react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faHeart as faHeartSolid } from "@fortawesome/free-solid-svg-icons";
import { faHeart as faHeartRegular } from "@fortawesome/free-regular-svg-icons";
import { DonationBadge } from "@/components/DonationBadge";
import { VerifiedBadge } from "@/components/VerifiedBadge";

type GarageCarRow = {
  id: string;
  owner_id: string;
  name: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  chassis: string | null;
  trim: string | null;
  color: string | null;
  engine: string | null;
  power_hp: number | null;
  torque_ftlb: number | null;
  weight_lb: number | null;
  use_type: string | null;
  visibility: string | null;
  is_primary: boolean | null;
  summary: string | null;
  mods: string | null;
  cover_image_url: string | null;
  created_at: string;
  updated_at: string;
};

type OwnerProfile = {
  id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

type GarageCarWithOwner = GarageCarRow & {
  owner_display_name: string | null;
  owner_username: string | null;
  owner_avatar_url: string | null;
  owner_is_verified?: boolean | null;
  owner_donation_rank?: string | null;
};

type LoadState = "idle" | "loading" | "loaded" | "error";

// ---------- highlight helpers ----------

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightText(text: string, tokens: string[]): ReactNode {
  if (!text || tokens.length === 0) return text;

  const cleanedTokens = Array.from(
    new Set(
      tokens
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0)
    )
  );
  if (cleanedTokens.length === 0) return text;

  const pattern = cleanedTokens.map(escapeRegExp).join("|");
  if (!pattern) return text;

  const regex = new RegExp(`(${pattern})`, "gi");
  const parts = text.split(regex);

  return parts.map((part, idx) => {
    const lower = part.toLowerCase();
    const isMatch = cleanedTokens.some((t) => t === lower);

    if (isMatch) {
      return (
        <span
          key={idx}
          className="rounded-[3px] bg-amber-500/20 px-0.5 text-amber-300"
        >
          {part}
        </span>
      );
    }

    return <span key={idx}>{part}</span>;
  });
}

export default function PublicGaragePage() {
  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cars, setCars] = useState<GarageCarWithOwner[]>([]);
  const [likeCounts, setLikeCounts] = useState<Record<string, number>>({});
  const [myLiked, setMyLiked] = useState<Record<string, boolean>>({});
  const [visibleCount, setVisibleCount] = useState(20);

  // ✅ auth state (used to show/hide "My garage")
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  // search state
  const [fragment, setFragment] = useState("");
  const [committedTerms, setCommittedTerms] = useState<string[]>([]);

  useEffect(() => {
    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();

        // ✅ determine if user is logged in
        try {
          const {
            data: { session },
          } = await supabase.auth.getSession();
          setIsLoggedIn(!!session);

          // If logged in, fetch which of the loaded cars the viewer has liked.
          // (Used only for the outlined/filled heart on the list page.)
          // This is best-effort; if RLS blocks select we simply show the outlined icon.
          if (session) {
            // We'll fill this after we load car IDs below.
          }
        } catch (e) {
          // If auth session fails for any reason, treat as logged out.
          console.error("Failed to check session", e);
          setIsLoggedIn(false);
        }

        // 1) Load public cars
        const { data: carData, error: carError } = await supabase
          .from("garage_cars")
          .select(
            "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
          )
          .eq("visibility", "public")
          .order("is_primary", { ascending: false })
          .order("created_at", { ascending: false })
          .limit(500);

        if (carError) {
          console.error("Failed to load public garage cars", carError);
          setErrorMessage("Failed to load the workshop.");
          setState("error");
          return;
        }

        const rawCars = (carData ?? []) as GarageCarRow[];
        if (rawCars.length === 0) {
          setCars([]);
          setState("loaded");
          return;
        }

        const {
          data: { session },
        } = await supabase.auth.getSession();

        // 2) Load like counts (per build)
        try {
          const carIds = rawCars.map((c) => c.id).filter(Boolean);
          if (carIds.length > 0) {
            const { data: likeRows, error: likeErr } = await supabase
              .from("garage_car_likes")
              .select("car_id")
              .in("car_id", carIds)
              .limit(50000);

            if (likeErr) {
              console.error("Failed to load garage like counts", likeErr);
            } else {
              const counts: Record<string, number> = {};
              (likeRows ?? []).forEach((r) => {
                const id = (r as { car_id: string }).car_id;
                if (!id) return;
                counts[id] = (counts[id] ?? 0) + 1;
              });
              setLikeCounts(counts);
            }

            // Also load the viewer's own likes for these cars (so we can show filled vs outline).
            if (session) {
              const { data: mineRows, error: mineErr } = await supabase
                .from("garage_car_likes")
                .select("car_id")
                // most schemas use user_id; if yours differs, this will just no-op and fall back.
                .eq("user_id", session.user.id)
                .in("car_id", carIds)
                .limit(50000);

              if (mineErr) {
                // Best-effort; do not block page.
                console.warn("Failed to load viewer garage likes", mineErr);
              } else {
                const likedMap: Record<string, boolean> = {};
                (mineRows ?? []).forEach((r) => {
                  const id = (r as { car_id: string }).car_id;
                  if (id) likedMap[id] = true;
                });
                setMyLiked(likedMap);
              }
            }
          }
        } catch (e) {
          console.error("Unexpected error loading like counts", e);
        }

        // 3) Load owner profiles for display name / username / avatar
        const ownerIds = Array.from(
          new Set(rawCars.map((c) => c.owner_id).filter(Boolean))
        );

        const ownersById = new Map<string, OwnerProfile>();
        if (ownerIds.length > 0) {
          const { data: ownerData, error: ownerError } = await supabase
            .from("public_profiles")
            .select("id, display_name, username, avatar_url, is_verified, donation_rank")
            .in("id", ownerIds);

          if (ownerError) {
            console.error("Failed to load garage owners", ownerError);
          } else if (ownerData) {
            for (const row of ownerData as OwnerProfile[]) {
              ownersById.set(row.id, row);
            }
          }
        }

        const combined: GarageCarWithOwner[] = rawCars.map((car) => {
          const owner = ownersById.get(car.owner_id);
          return {
            ...car,
            owner_display_name: owner?.display_name ?? null,
            owner_username: owner?.username ?? null,
            owner_avatar_url: owner?.avatar_url ?? null,
            owner_is_verified: owner?.is_verified ?? null,
            owner_donation_rank: owner?.donation_rank ?? null,
          };
        });

        setCars(combined);
        setState("loaded");
      } catch (e) {
        console.error("Unexpected error loading public garage", e);
        setErrorMessage("Unexpected error loading public garage.");
        setState("error");
      }
    };

    void load();
  }, []);

  const hasCars = cars.length > 0;

  // --- search tokens (chips are for everything here) ---

  const textTokens = useMemo(() => {
    const raw = fragment.trim().toLowerCase();
    if (!raw) return [] as string[];
    return raw
      .split(/\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  }, [fragment]);

  const chipTokens = useMemo(
    () =>
      committedTerms
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    [committedTerms]
  );

  const allTokens = useMemo(
    () => Array.from(new Set([...textTokens, ...chipTokens])),
    [textTokens, chipTokens]
  );

  // --- scoring & re-ranking ---

  const scoredCars = useMemo(() => {
    if (cars.length === 0)
      return [] as { car: GarageCarWithOwner; score: number }[];

    const hasTokens = allTokens.length > 0;
    if (!hasTokens) {
      // keep original order (primary first, then newest)
      return cars.map((car, index) => ({
        car,
        score: cars.length - index,
      }));
    }

    return cars
      .map((car, index) => {
        const titlePieces = [
          car.name,
          car.year?.toString() ?? "",
          car.make,
          car.model,
          car.chassis,
        ].filter(Boolean) as string[];

        const titleBlob = titlePieces.join(" ").toLowerCase();

        const specBlob = [
          car.trim,
          car.color,
          car.engine,
          car.use_type,
          car.summary,
          car.mods,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        const ownerBlob = [car.owner_display_name, car.owner_username]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        let score = 0;

        for (const token of allTokens) {
          let tokenScore = 0;

          if (titleBlob.includes(token)) tokenScore += 14;
          if (specBlob.includes(token)) tokenScore += 10;
          if (ownerBlob.includes(token)) tokenScore += 7;

          if (tokenScore > 20) tokenScore = 20;
          score += tokenScore;
        }

        // token count bonus
        score += allTokens.length * 4;

        // primary cars get a little bump
        if (car.is_primary) score += 8;

        // recency tiebreak
        const createdTime = new Date(car.created_at).getTime();
        if (Number.isFinite(createdTime)) {
          score += createdTime / 1_000_000_000_000;
        }

        // keep original order as tiny tie-breaker
        score += (cars.length - index) * 0.01;

        return { car, score };
      })
      .sort((a, b) => b.score - a.score);
  }, [cars, allTokens]);

  const visibleCars = useMemo(
    () => scoredCars.slice(0, visibleCount),
    [scoredCars, visibleCount]
  );

  // --- chip behavior ---

  const commitFragment = () => {
    const raw = fragment.trim().toLowerCase();
    if (!raw) return;

    // Split ONLY on commas, so "Time Attack" stays one chip
    const parts = raw
      .split(",") // <-- no whitespace splitting
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length === 0) return;

    setCommittedTerms((prev) => {
      const existing = new Set(prev);
      for (const p of parts) {
        if (!existing.has(p)) {
          existing.add(p);
        }
      }
      return Array.from(existing);
    });

    setFragment("");
    setVisibleCount(20);
  };

  const handleFragmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    setFragment(e.target.value);
    setVisibleCount(20);
  };

  const handleFragmentKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "Tab" || e.key === ",") {
      e.preventDefault();
      commitFragment();
      return;
    }

    if (e.key === "Backspace" && fragment.trim() === "" && committedTerms.length) {
      e.preventDefault();
      setCommittedTerms((prev) => prev.slice(0, -1));
      setVisibleCount(20);
    }
  };

  const handleRemoveChip = (term: string) => {
    setCommittedTerms((prev) => prev.filter((t) => t !== term));
    setVisibleCount(20);
  };

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-brand-text">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Workshop
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              Community workshop
            </h1>
            <p className="text-[12px] text-brand-textMuted sm:text-sm">
              Browse projects people have made and share your own work.
            </p>
          </div>

          {/* ✅ Only show if logged in */}
          {isLoggedIn && (
            <div className="flex items-center gap-2">
              <Link
                href="/workshop/mine"
                className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30"
              >
                My projects
              </Link>
            </div>
          )}
        </div>

        {state === "error" && (
          <p className="mt-2 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load public garage."}
          </p>
        )}
      </section>
      {/* Filters / search */}
      {state === "loaded" && hasCars && (
        <section className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="text-[11px] text-brand-textMuted">
            Showing {visibleCars.length} of {scoredCars.length} matching car
            {scoredCars.length === 1 ? "" : "s"} (total {cars.length} public)
          </div>

          <div className="w-full md:w-80">
            <div className="flex max-h-24 cursor-text flex-wrap items-center gap-1 overflow-y-auto rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs text-brand-text focus-within:border-amber-400">
              <span className="mr-1 text-[13px] text-brand-textMuted">🔍</span>
              {committedTerms.map((term) => (
                <button
                  key={term}
                  type="button"
                  onClick={() => handleRemoveChip(term)}
                  className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-200 transition-transform hover:-translate-y-px hover:bg-amber-500/20"
                >
                  <span>{term}</span>
                  <span className="text-[10px]">×</span>
                </button>
              ))}
              <input
                type="text"
                value={fragment}
                onChange={handleFragmentChange}
                onKeyDown={handleFragmentKeyDown}
                placeholder={
                  committedTerms.length ? "Add more filters…" : "Search make, model, engine, owner…"
                }
                className="no-zoom-input flex-1 bg-transparent text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted"
              />
            </div>
            {allTokens.length > 0 && (
              <p className="mt-1 text-[10px] text-brand-textMuted">
                Filtering by: <span className="text-brand-text">{allTokens.join(", ")}</span>
              </p>
            )}
          </div>
        </section>
      )}
      {/* Loading */}
      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">Loading projects…</p>
        </section>
      )}
      {/* Empty */}
      {state === "loaded" && !hasCars && (
        <section className="rounded-xl border border-dashed border-zinc-800/80 bg-black/30 p-6 text-[13px] text-brand-textMuted">
          <p className="font-medium text-brand-text">No projects have been posted yet.</p>
          <p className="mt-1">
            Add a car in <span className="font-medium text-amber-300">“My garage”</span> and set
            its visibility to <span className="font-medium">Public</span> to show it here.
          </p>
        </section>
      )}
      {/* List */}
      {state === "loaded" && hasCars && (
        <section className="space-y-3">
          <div className="space-y-2">
	            {visibleCars.map(({ car }) => (
	              <GarageCarCard
	                key={car.id}
	                car={car}
	                highlightTokens={allTokens}
	                likeCount={likeCounts[car.id] ?? 0}
		        isLiked={!!myLiked[car.id]}
	              />
	            ))}
          </div>

          {scoredCars.length > visibleCount && (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((prev) => prev + 20)}
                className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-4 py-1.5 text-[12px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
              >
                Show more ({Math.min(scoredCars.length - visibleCount, 20)} more)
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function GarageCarCard({
  car,
  highlightTokens,
  likeCount,
  isLiked,
}: {
  car: GarageCarWithOwner;
  highlightTokens: string[];
  likeCount: number;
  isLiked: boolean;
}) {
  const title =
    car.name ||
    [car.year, car.make, car.model, car.chassis ? `(${car.chassis.toUpperCase()})` : null]
      .filter(Boolean)
      .join(" ");

  const subtitle = [car.engine, car.color, car.trim].filter(Boolean).join(" • ");

  const createdLabel = new Date(car.created_at).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  const hpLabel = car.power_hp != null && car.power_hp > 0 ? `${car.power_hp} hp` : null;
  const tqLabel =
    car.torque_ftlb != null && car.torque_ftlb > 0 ? `${car.torque_ftlb} ft lb` : null;
  const wtLabel = car.weight_lb != null && car.weight_lb > 0 ? `${car.weight_lb} lb` : null;

  const useType = car.use_type ?? "street";
  const visibility = car.visibility ?? "public";

  const useLabel = useType.charAt(0).toUpperCase() + useType.slice(1).toLowerCase();
  const visLabel = visibility.charAt(0).toUpperCase() + visibility.slice(1).toLowerCase();

  const visClasses =
    visibility === "public"
      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
      : visibility === "unlisted"
      ? "border-sky-400/70 bg-sky-500/15 text-sky-200"
      : "border-zinc-600/80 bg-black/50 text-brand-textMuted";

  const ownerName = car.owner_display_name || car.owner_username || "Unknown user";

  return (
    <Link
      href={`/workshop/${car.id}`}
      className="block rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-xs transition hover:border-amber-400/70 hover:bg-black/60"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-brand-text">
              {highlightText(title || "Untitled project", highlightTokens)}
            </h3>
            {car.is_primary && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-200">
                <span>★</span>
                <span>Primary</span>
              </span>
            )}
          </div>

          {subtitle && (
            <p className="text-[11px] text-brand-textMuted">
              {highlightText(subtitle, highlightTokens)}
            </p>
          )}

          {car.summary && (
            <p className="mt-1 line-clamp-2 text-[11px] text-brand-textMuted">
              {highlightText(car.summary, highlightTokens)}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
            <span>
              Owner:{" "}
              <span className="text-brand-text font-medium">
                {highlightText(ownerName, highlightTokens)}
                {car.owner_is_verified ? (
                  <VerifiedBadge className="ml-0.5 h-3 w-3" />
                ) : null}
                {car.owner_donation_rank ? (
                  <DonationBadge rank={car.owner_donation_rank} className="ml-0.5 h-3 w-3" />
                ) : null}
              </span>
            </span>
            <span>•</span>
            <span>
              Added <span className="text-brand-text font-medium">{createdLabel}</span>
            </span>
            {hpLabel && (
              <span>
                • <span className="text-brand-text">{highlightText(hpLabel, highlightTokens)}</span>
              </span>
            )}
            {tqLabel && (
              <span>
                • <span className="text-brand-text">{highlightText(tqLabel, highlightTokens)}</span>
              </span>
            )}
            {wtLabel && (
              <span>
                • <span className="text-brand-text">{highlightText(wtLabel, highlightTokens)}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 text-[10px]">
          <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
            <span className="text-[9px]">🏁</span>
            <span>{highlightText(useLabel, highlightTokens)}</span>
          </span>
          <span
            className={
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 " + visClasses
            }
          >
            <span className="text-[9px]">
              {visibility === "public" ? "🌐" : visibility === "unlisted" ? "🔗" : "🔒"}
            </span>
            <span>{highlightText(visLabel, highlightTokens)}</span>
          </span>

          {/* likes (toggle lives on /garage/[id]) */}
          <div className="mt-1 inline-flex items-center gap-1 text-[11px] text-brand-textMuted">
            <FontAwesomeIcon
              icon={isLiked ? faHeartSolid : faHeartRegular}
              className={
                "h-3 w-3 align-middle " +
                (isLiked ? "text-rose-500" : "text-brand-textMuted")
              }
              title={isLiked ? "Liked" : "Not liked"}
            />
            <span className="text-brand-text">{likeCount ?? 0}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}
