"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";

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

type LoadState = "idle" | "loading" | "loaded" | "error";

export default function MyGaragePage() {
  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [cars, setCars] = useState<GarageCarRow[]>([]);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      const supabase = supabaseBrowser();

      // 1) Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setUserId(null);
        setState("error");
        setErrorMessage("You must be logged in to view your garage.");
        return;
      }

      setUserId(user.id);

      // 2) Load this user's cars
      const { data, error } = await supabase
        .from("garage_cars")
        .select(
          "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
        )
        .eq("owner_id", user.id)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: false });

      if (error) {
        console.error("Failed to load garage cars", error);
        setErrorMessage("Failed to load your garage.");
        setState("error");
        return;
      }

      setCars((data ?? []) as GarageCarRow[]);
      setState("loaded");
    };

    void load();
  }, []);

  const hasCars = cars.length > 0;

  const primaryCar = useMemo(
    () => cars.find((c) => c.is_primary),
    [cars]
  );

  const otherCars = useMemo(
    () => cars.filter((c) => !c.is_primary),
    [cars]
  );

  const handleDeleteCar = async (carId: string) => {
    if (!userId) return;

    const confirmed = window.confirm(
      "Delete this car from your garage? This cannot be undone."
    );
    if (!confirmed) return;

    try {
      const supabase = supabaseBrowser();
      const { error } = await supabase
        .from("garage_cars")
        .delete()
        .eq("id", carId)
        .eq("owner_id", userId);

      if (error) {
        console.error("Failed to delete car", error);
        alert("Failed to delete car.");
        return;
      }

      setCars((prev) => prev.filter((c) => c.id !== carId));
    } catch (e) {
      console.error("Unexpected error deleting car", e);
      alert("Unexpected error deleting car.");
    }
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
              My projects
            </h1>
            <p className="text-[12px] text-brand-textMuted sm:text-sm">
              Manage the cars attached to your profile. Set a primary build and
              showcase key specs.
            </p>
            <div className="mt-1 text-[11px] text-brand-textMuted">
              <Link
                href="/workshop"
                className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
              >
                ← Back to public garage
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/workshop/new"
              className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-3 py-1.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/30"
            >
              + Post project
            </Link>
          </div>
        </div>

        {state === "error" && (
          <p className="mt-2 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load your garage."}
          </p>
        )}
      </section>

      {/* Not logged in / no user */}
      {state === "error" && !userId && (
        <section>
          <p className="text-[12px] text-brand-textMuted">
            You need to log in to manage your garage.
          </p>
        </section>
      )}

      {/* Loading */}
      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">
            Loading your cars…
          </p>
        </section>
      )}

      {/* Empty state */}
      {state === "loaded" && !hasCars && (
        <section className="rounded-xl border border-dashed border-zinc-800/80 bg-black/30 p-6 text-[13px] text-brand-textMuted">
          <p className="font-medium text-brand-text">
            You haven&apos;t added any cars yet.
          </p>
          <p className="mt-1">
            Click <span className="font-medium text-amber-300">“+ Add car”</span>{" "}
            to create your first garage entry.
          </p>
        </section>
      )}

      {/* Primary car highlight */}
      {state === "loaded" && primaryCar && (
        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.15em] text-brand-textMuted">
            Primary car
          </h2>
          <GarageCarCard
            car={primaryCar}
            highlightPrimary
            onDelete={handleDeleteCar}
          />
        </section>
      )}

      {/* Other cars */}
      {state === "loaded" && otherCars.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.15em] text-brand-textMuted">
            Other cars
          </h2>
          <div className="space-y-2">
            {otherCars.map((car) => (
              <GarageCarCard
                key={car.id}
                car={car}
                onDelete={handleDeleteCar}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function GarageCarCard({
  car,
  highlightPrimary,
  onDelete,
}: {
  car: GarageCarRow;
  highlightPrimary?: boolean;
  onDelete?: (id: string) => void;
}) {
  const router = useRouter();

  const title =
    car.name ||
    [
      car.year,
      car.make,
      car.model,
      car.chassis ? `(${car.chassis.toUpperCase()})` : null,
    ]
      .filter(Boolean)
      .join(" ");

  const subtitle = [car.engine, car.color, car.trim]
    .filter(Boolean)
    .join(" • ");

  const createdLabel = new Date(car.created_at).toLocaleDateString(
    undefined,
    {
      month: "short",
      day: "numeric",
      year: "numeric",
    }
  );

  const hpLabel =
    car.power_hp != null && car.power_hp > 0 ? `${car.power_hp} hp` : null;

  const tqLabel =
    car.torque_ftlb != null && car.torque_ftlb > 0 ? `${car.torque_ftlb} ft lb` : null;

  const wtLabel =
    car.weight_lb != null && car.weight_lb > 0 ? `${car.weight_lb} lb` : null;

  const useType = car.use_type ?? "street";
  const visibility = car.visibility ?? "public";

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

  const handleCardClick = () => {
    router.push(`/workshop/${car.id}`);
  };

  const handleDeleteClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onDelete?.(car.id);
  };

  const handleEditClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    router.push(`/workshop/${car.id}/edit`);
  };

  return (
    <div
      className={
        "rounded-xl border bg-black/40 p-4 text-xs transition hover:border-amber-400/70 hover:bg-black/60 cursor-pointer " +
        (highlightPrimary
          ? "border-amber-400/80 shadow-[0_0_30px_rgba(255,193,7,0.25)]"
          : "border-zinc-800/80")
      }
      onClick={handleCardClick}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-brand-text">
              {title || "Untitled project"}
            </h3>
            {highlightPrimary && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/80 bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-200">
                <span>★</span>
                <span>Primary</span>
              </span>
            )}
          </div>

          {subtitle && (
            <p className="text-[11px] text-brand-textMuted">{subtitle}</p>
          )}

          {car.summary && (
            <p className="mt-1 line-clamp-2 text-[11px] text-brand-textMuted">
              {car.summary}
            </p>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-brand-textMuted">
            <span>
              Added{" "}
              <span className="text-brand-text font-medium">
                {createdLabel}
              </span>
            </span>
            {hpLabel && (
              <span className="text-brand-textMuted">
                • <span className="text-brand-text">{hpLabel}</span>
              </span>
            )}
            {tqLabel && (
              <span className="text-brand-textMuted">
                • <span className="text-brand-text">{tqLabel}</span>
              </span>
            )}
            {wtLabel && (
              <span className="text-brand-textMuted">
                • <span className="text-brand-text">{wtLabel}</span>
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-col items-end gap-2 text-[10px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-1 rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
              <span className="text-[9px]">🏁</span>
              <span>{useLabel}</span>
            </span>
            <span
              className={
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 " +
                visClasses
              }
            >
              <span className="text-[9px]">
                {visibility === "public"
                  ? "🌐"
                  : visibility === "unlisted"
                  ? "🔗"
                  : "🔒"}
              </span>
              <span>{visLabel}</span>
            </span>
          </div>

          {/* Actions */}
          <div className="mt-1 flex flex-wrap justify-end gap-2">
            <button
              type="button"
              onClick={handleEditClick}
              className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[10px] text-brand-text hover:border-amber-400/80"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={handleDeleteClick}
              className="inline-flex items-center justify-center rounded-full border border-rose-500/70 bg-rose-500/15 px-3 py-1 text-[10px] text-rose-200 hover:bg-rose-500/25"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
