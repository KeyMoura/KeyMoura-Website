"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faHeart as faHeartSolid } from "@fortawesome/free-solid-svg-icons";
import { faHeart as faHeartRegular } from "@fortawesome/free-regular-svg-icons";

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
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  // Optional because older selects/types might not include it everywhere.
  is_verified?: boolean | null;
  // Donation rank key stored on profiles (e.g. 'donor_5').
  donation_rank?: string | null;
  karma: number | null;
  last_seen_at?: string | null;
  role: string | null;
};

type LoadState = "idle" | "loading" | "loaded" | "error";

type Props = {
  params: Promise<{ id: string }>;
};

export default function GarageCarPage({ params }: Props) {
  const { id: garageId } = use(params);

  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [car, setCar] = useState<GarageCarRow | null>(null);
  const [owner, setOwner] = useState<OwnerProfile | null>(null);
  const [viewerId, setViewerId] = useState<string | null>(null);

  // NEW: maintenance mode flag
  const [maintenanceMode, setMaintenanceMode] = useState(false);

  // Likes (per build)
  const [likeCount, setLikeCount] = useState<number>(0);
  const [liked, setLiked] = useState(false);
  const [likeBusy, setLikeBusy] = useState(false);

  // Stable timestamp for "Active" badge logic (avoids Date.now during render)
  const [initialNow] = useState(() => Date.now());

  const rankLabel = (() => {
    const lower = (owner?.role ?? "member").toLowerCase();
    if (lower === "admin") return "Admin";
    if (lower === "moderator" || lower === "mod") return "Moderator";
    if (lower === "support") return "Support";
    return "Member";
  })();

  const rankChipClasses = (() => {
    const lower = (owner?.role ?? "member").toLowerCase();
    if (lower === "admin") return "border-rose-500 bg-rose-500/20 text-rose-300";
    if (lower === "moderator" || lower === "mod")
      return "border-emerald-500 bg-emerald-500/20 text-emerald-200";
    if (lower === "support") return "border-sky-400 bg-sky-500/20 text-sky-300";
    return "border-zinc-600 bg-black/40 text-brand-textMuted";
  })();

  const lastSeenDate = owner?.last_seen_at ? new Date(owner.last_seen_at) : null;
  const isOwnerActive =
    lastSeenDate != null && initialNow - lastSeenDate.getTime() <= 60 * 1000;

  async function getAccessToken(): Promise<string | null> {
    try {
      const supabase = supabaseBrowser();
      const { data } = await supabase.auth.getSession();
      return data.session?.access_token ?? null;
    } catch {
      return null;
    }
  }

  async function refreshLikes(carId: string) {
    try {
      const token = await getAccessToken();
      const res = await fetch(`/api/garage/${encodeURIComponent(carId)}/likes`, {
        headers: token ? { authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; count: number; liked: boolean }
        | { error: string };
      if (json && "ok" in json && json.ok) {
        setLikeCount(typeof json.count === "number" ? json.count : 0);
        setLiked(!!json.liked);
      }
    } catch {
      // ignore
    }
  }

  async function toggleLike(carId: string) {
    if (likeBusy) return;
    setLikeBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) {
        setErrorMessage("Please sign in to like builds.");
        setLikeBusy(false);
        return;
      }

      const res = await fetch(`/api/garage/${encodeURIComponent(carId)}/like`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true; liked: boolean; count: number }
        | { error: string };

      if (json && "ok" in json && json.ok) {
        setLiked(!!json.liked);
        setLikeCount(typeof json.count === "number" ? json.count : 0);
      } else if (json && "error" in json) {
        setErrorMessage(json.error || "Failed to toggle like.");
      }
    } catch {
      setErrorMessage("Failed to toggle like.");
    } finally {
      setLikeBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      if (!garageId) {
        if (!cancelled) {
          setErrorMessage("Missing garage id.");
          setState("error");
        }
        return;
      }

      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();

        // Best-effort viewer id (used for owner-only controls)
        try {
          const {
            data: { user },
          } = await supabase.auth.getUser();
          if (!cancelled) setViewerId(user?.id ?? null);
        } catch {
          if (!cancelled) setViewerId(null);
        }

        // NEW: load maintenance flag
        try {
          const { data: flagsData, error: flagsError } =
            await supabase.rpc("get_site_lockdown_flags");

          if (!flagsError && flagsData && flagsData.length > 0) {
            const row = flagsData[0] as { maintenance_mode: boolean };
            if (!cancelled) {
              setMaintenanceMode(!!row.maintenance_mode);
            }
          }
        } catch (e) {
          console.error("Failed to load maintenance flag", e);
        }

        const { data: carData, error: carError } = await supabase
          .from("garage_cars")
          .select(
            "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
          )
          .eq("id", garageId)
          .maybeSingle<GarageCarRow>();

        if (carError) {
          console.error("Failed to load garage car", carError);
          if (!cancelled) {
            setErrorMessage("Failed to load car.");
            setState("error");
          }
          return;
        }

        if (!carData) {
          if (!cancelled) {
            setErrorMessage("Car not found.");
            setState("error");
          }
          return;
        }

        if (cancelled) return;

        setCar(carData);
        void refreshLikes(carData.id);

        const { data: ownerData, error: ownerError } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url, karma, last_seen_at, is_verified, donation_rank")
          .eq("id", carData.owner_id)
          .maybeSingle<OwnerProfile>();

        if (ownerError) {
          console.error("Failed to load owner profile", ownerError);
        } else if (ownerData && !cancelled) {
          setOwner({ ...ownerData, role: null });
        }

        // Load owner role (best-effort; does not block page)
        try {
          const { data: roleRow } = await supabase
            .from("user_roles")
            .select("role")
            .eq("user_id", carData.owner_id)
            .maybeSingle<{ role: string | null }>();

          if (!cancelled) {
            setOwner((prev) =>
              prev ? { ...prev, role: roleRow?.role ?? null } : prev
            );
          }
        } catch (e) {
          console.error("Failed to load owner role", e);
        }

        if (!cancelled) {
          setState("loaded");
        }
      } catch (err) {
        console.error("Unexpected error loading garage car", err);
        if (!cancelled) {
          setErrorMessage("Unexpected error loading car.");
          setState("error");
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [garageId]);

  const missingId = !garageId;
  const isLoading = state === "loading";
  const isLoaded = state === "loaded" && car != null;

  const title =
    car?.name ||
    [
      car?.year,
      car?.make,
      car?.model,
      car?.chassis ? `(${car.chassis.toUpperCase()})` : null,
    ]
      .filter(Boolean)
      .join(" ");

  const subtitle = [car?.engine, car?.color, car?.trim]
    .filter(Boolean)
    .join(" • ");

  const createdLabel =
    car != null
      ? new Date(car.created_at).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "";

  const hpLabel =
    car && car.power_hp != null && car.power_hp > 0
      ? `${car.power_hp} hp`
      : null;
  const tqLabel =
    car && car.torque_ftlb != null && car.torque_ftlb > 0
      ? `${car.torque_ftlb} ft-lb`
      : null;

  const wtLabel =
    car && car.weight_lb != null && car.weight_lb > 0
      ? `${car.weight_lb} lb`
      : null;

  const useType = car?.use_type ?? "street";
  const visibility = car?.visibility ?? "public";

  const useLabel =
    useType.charAt(0).toUpperCase() + useType.slice(1).toLowerCase();
  const visLabel =
    visibility.charAt(0).toUpperCase() + visibility.slice(1).toLowerCase();

  const visClasses =
    visibility === "public"
      ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200"
      : visibility === "unlisted"
      ? "border-sky-400/70 bg-sky-500/15 text-sky-200"
      : "border-zinc-600/80 bg-black/50 text-brand-textMuted";

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-brand-text">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Garage
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {title || (missingId ? "Garage car" : "Loading car…")}
            </h1>
            {subtitle && (
              <p className="text-[12px] text-brand-textMuted sm:text-sm">
                {subtitle}
              </p>
            )}
            <div className="mt-1 text-[11px] text-brand-textMuted">
              <Link
                href="/garage"
                className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
              >
                ← Back to public garage
              </Link>
            </div>
          </div>
        </div>

        {(missingId || state === "error") && (
          <p className="mt-2 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {missingId
              ? "Missing garage id."
              : errorMessage ?? "Failed to load car."}
          </p>
        )}
      </section>
      {maintenanceMode && (
        <section>
          <p className="rounded-md border border-amber-400/70 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
            The site is currently in maintenance mode. Garage editing and new
            car creation are temporarily disabled, but you can still view this
            car.
          </p>
        </section>
      )}
      {/* Loading */}
      {isLoading && !missingId && (
        <section>
          <p className="text-[12px] text-brand-textMuted">Loading car…</p>
        </section>
      )}
      {/* Main car header */}
      {isLoaded && car && (
        <>
          <section className="rounded-2xl border border-zinc-800/80 bg-black/40 p-4 sm:p-6">
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">

              {/* LEFT: Large image */}
              <div className="relative overflow-hidden rounded-xl border border-zinc-700 bg-black/60 aspect-video">
                {car.cover_image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  (<img
                    src={car.cover_image_url}
                    alt={title || "Car image"}
                    className="h-full w-full origin-center object-cover transform-gpu scale-100 transition-transform duration-500 will-change-transform hover:scale-[1.03]"
                  />)
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-sm text-brand-textMuted">
                    No image provided
                  </div>
                )}
              </div>

              {/* RIGHT: Info */}
              <div className="flex flex-col justify-between gap-4">

                {/* Title + badges */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h2 className="text-2xl font-semibold tracking-tight">
                        {title || "Untitled car"}
                      </h2>

                      {subtitle && (
                        <p className="text-sm text-brand-textMuted">
                          {subtitle}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-2 self-start whitespace-nowrap">
                      {viewerId && car?.owner_id && viewerId === car.owner_id && !maintenanceMode && (
                        <Link
                          href={`/garage/${car.id}/edit`}
                          className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                        >
                          Edit
                        </Link>
                      )}

                      <button
                        type="button"
                        aria-label={liked ? "Unlike this build" : "Like this build"}
                        onClick={() => car?.id && void toggleLike(car.id)}
                        disabled={!car?.id || isLoading || likeBusy}
                        className="no-zoom-input inline-flex items-center gap-2 text-[12px] text-brand-textMuted hover:text-rose-200 disabled:opacity-50"
                      >
                        <FontAwesomeIcon
                          icon={liked ? faHeartSolid : faHeartRegular}
                          className={"h-3 w-3 " + (liked ? "text-rose-400" : "text-brand-textMuted")}
                        />
                        <span>{likeCount}</span>
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {car.is_primary && (
                      <span className="rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-amber-200">
                        ★ Primary
                      </span>
                    )}

                    <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
                      🏁 {useLabel}
                    </span>

                    <span
                      className={
                        "rounded-full border px-2 py-0.5 " + visClasses
                      }
                    >
                      {visLabel}
                    </span>
                  </div>
                </div>

                {/* Specs */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {hpLabel && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Power</p>
                      <p className="font-medium">{hpLabel}</p>
                    </div>
                  )}

                  {tqLabel && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Torque</p>
                      <p className="font-medium">{tqLabel}</p>
                    </div>
                  )}

                  {wtLabel && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Weight</p>
                      <p className="font-medium">{wtLabel}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[11px] uppercase text-brand-textMuted">Added</p>
                    <p className="font-medium">{createdLabel}</p>
                  </div>
                </div>

                {/* Basics */}
                <div className="grid grid-cols-2 gap-3 text-sm">
                  {car.year != null && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Year</p>
                      <p className="font-medium">{car.year}</p>
                    </div>
                  )}
                  {car.make && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Make</p>
                      <p className="font-medium">{car.make}</p>
                    </div>
                  )}
                  {car.model && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Model</p>
                      <p className="font-medium">{car.model}</p>
                    </div>
                  )}
                  {car.chassis && (
                    <div>
                      <p className="text-[11px] uppercase text-brand-textMuted">Chassis</p>
                      <p className="font-medium">{car.chassis.toUpperCase()}</p>
                    </div>
                  )}
                </div>

                {/* Owner */}
                {owner && (
                  <Link
                    href={`/user/${owner.id}`}
                    className="mt-2 inline-flex items-center gap-3 rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-sm hover:border-amber-400/80"
                  >
                    <span className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-zinc-700 bg-black/60">
                      {owner.avatar_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        (<img
                          src={owner.avatar_url}
                          alt={owner.display_name ?? owner.username ?? "User"}
                          className="h-full w-full object-cover"
                        />)
                      ) : (
                        <span className="text-xs">
                          {(owner.display_name || owner.username || "?")
                            .slice(0, 2)
                            .toUpperCase()}
                        </span>
                      )}
                    </span>

                    <div className="leading-tight">
                      <p className="text-[11px] text-brand-textMuted">Owner</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">
                          {owner.display_name
                            ? owner.display_name
                            : owner.username
                              ? `@${owner.username}`
                              : "Unknown"}
                        </p>
                        {owner.display_name && owner.username ? (
                          <span className="text-[11px] text-brand-textMuted">@{owner.username}</span>
                        ) : null}

                        {owner.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                        {owner.donation_rank ? (
                          <DonationBadge rank={owner.donation_rank} className="ml-0.5 h-3 w-3" />
                        ) : null}
                        <RolePill role={owner?.role} />

                        <span className="inline-flex min-h-[24px] items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-100">
                          <span className="leading-none">Karma</span>
                          <span className="leading-none">•</span>
                          <span className="leading-none">{owner.karma ?? 0}</span>
                        </span>

                        {isOwnerActive && (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/60 bg-emerald-500/15 px-2 py-0.5 text-[10px] text-emerald-200">
                            <span className="text-[9px]">●</span>
                            <span>Active</span>
                          </span>
                        )}
                      </div>
                    </div>
                  </Link>
                )}
              </div>
            </div>
          </section>

          {/* Summary section */}
          <section className="space-y-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.15em] text-brand-textMuted">
              Summary
            </h2>
            <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-[12px] text-brand-textMuted">
              {car.summary && car.summary.trim().length > 0 ? (
                <p className="whitespace-pre-line">{car.summary}</p>
              ) : (
                <p className="text-[11px] text-brand-textMuted">
                  The owner hasn&apos;t added a summary for this car yet.
                </p>
              )}
            </div>
          </section>

          {/* Mods section */}
          <section className="space-y-2">
            <h2 className="text-[12px] font-semibold uppercase tracking-[0.15em] text-brand-textMuted">
              Modifications
            </h2>
            <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-[12px] text-brand-textMuted">
              {car.mods && car.mods.trim().length > 0 ? (
                <p className="whitespace-pre-line">{car.mods}</p>
              ) : (
                <p className="text-[11px] text-brand-textMuted">
                  The owner hasn&apos;t added a mods list yet.
                </p>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
