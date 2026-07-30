"use client";

import { useEffect, useState, ChangeEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { ImageCropper } from "@/components/ImageCropper";
import { MenuSelect } from "@/components/ui/MenuSelect";
import {
  DEFAULT_CROP,
  getImageMetaFromUrl,
  renderCroppedJpeg,
  type CropState,
  type ImgMeta,
} from "@/lib/imageCrop";

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

const COVER_ASPECT = 16 / 9;
const COVER_MAX_SIZE_PX = 1600;


export default function EditGarageCarPage() {
  const params = useParams();
  const router = useRouter();

  const garageIdParam = (params as { id?: string }).id;
  const garageId =
    typeof garageIdParam === "string"
      ? garageIdParam
      : Array.isArray(garageIdParam)
      ? garageIdParam[0]
      : undefined;

  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [car, setCar] = useState<GarageCarRow | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [maintenanceMode, setMaintenanceMode] = useState(false);

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverMeta, setCoverMeta] = useState<ImgMeta | null>(null);
  const [coverCrop, setCoverCrop] = useState<CropState>(DEFAULT_CROP);

  const [coverFrame, setCoverFrame] = useState({
    w: 640,
    h: Math.round(640 / COVER_ASPECT),
  });

  // form fields
  const [name, setName] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState<string>("");
  const [chassis, setChassis] = useState("");
  const [trim, setTrim] = useState("");
  const [color, setColor] = useState("");
  const [engine, setEngine] = useState("");
  const [powerHp, setPowerHp] = useState<string>("");
  const [torqueftlb, setTorqueftlb] = useState<string>("");
  const [weightlb, setWeightlb] = useState<string>("");
  const [useType, setUseType] = useState("street");
  const [visibility, setVisibility] = useState("public");
  const [summary, setSummary] = useState("");
  const [mods, setMods] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);



  useEffect(() => {
    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setUserId(null);
          setState("error");
          setErrorMessage("You must be logged in to edit this car.");
          return;
        }

        setUserId(user.id);

        const { data: flagsData, error: flagsError } = await supabase.rpc(
          "get_site_lockdown_flags"
        );

        if (!flagsError && flagsData && flagsData.length > 0) {
          const row = flagsData[0] as { maintenance_mode: boolean };
          setMaintenanceMode(!!row.maintenance_mode);
        }

        const { data, error } = await supabase
          .from("garage_cars")
          .select(
            "id, owner_id, name, make, model, year, chassis, trim, color, engine, power_hp, torque_ftlb, weight_lb, use_type, visibility, is_primary, summary, mods, cover_image_url, created_at, updated_at"
          )
          .eq("id", garageId)
          .maybeSingle<GarageCarRow>();

        if (error) {
          console.error("Failed to load garage car for edit", error);
          setErrorMessage("Failed to load car.");
          setState("error");
          return;
        }

        if (!data) {
          setErrorMessage("Car not found.");
          setState("error");
          return;
        }

        if (data.owner_id !== user.id) {
          setErrorMessage("You don’t have permission to edit this car.");
          setState("error");
          return;
        }

        setCar(data);

        setName(data.name ?? "");
        setMake(data.make ?? "");
        setModel(data.model ?? "");
        setYear(data.year != null ? String(data.year) : "");
        setChassis(data.chassis ?? "");
        setTrim(data.trim ?? "");
        setColor(data.color ?? "");
        setEngine(data.engine ?? "");
        setPowerHp(data.power_hp != null ? String(data.power_hp) : "");
        setTorqueftlb(data.torque_ftlb != null ? String(data.torque_ftlb) : "");
        setWeightlb(data.weight_lb != null ? String(data.weight_lb) : "");
        setUseType(data.use_type ?? "street");
        setVisibility(data.visibility ?? "public");
        setSummary(data.summary ?? "");
        setMods(data.mods ?? "");

        if (data.cover_image_url) {
          setCoverPreviewUrl(data.cover_image_url);
        }

        setState("loaded");
      } catch (e) {
        console.error("Unexpected error loading car for edit", e);
        setErrorMessage("Unexpected error loading car.");
        setState("error");
      }
    };

    void load();
  }, [garageId]);

  useEffect(() => {
    return () => {
      if (coverPreviewUrl && coverPreviewUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(coverPreviewUrl);
        } catch {}
      }
    };
  }, [coverPreviewUrl]);

  if (!garageId) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
        <h1 className="mb-2 text-xl font-semibold">Edit car</h1>
        <p className="text-sm text-brand-textMuted">Missing garage id in the URL.</p>
      </div>
    );
  }

  const handleCoverChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) {
      setCoverFile(null);
      setCoverMeta(null);
      if (!car?.cover_image_url) setCoverPreviewUrl(null);
      setCoverCrop(DEFAULT_CROP);
      return;
    }

    setCoverFile(file);
    setCoverCrop(DEFAULT_CROP);
    setCoverMeta(null);

    if (coverPreviewUrl && coverPreviewUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(coverPreviewUrl);
      } catch {}
    }

    const url = URL.createObjectURL(file);
    setCoverPreviewUrl(url);

    getImageMetaFromUrl(url)
      .then((m) => setCoverMeta(m))
      .catch(() => setCoverMeta(null));
  };

  const handleSave = async () => {
    if (!userId || !car) return;

    setSaveMessage(null);

    if (maintenanceMode) {
      setSaveMessage("Garage is temporarily read-only while the site is in maintenance mode.");
      return;
    }

    setSaving(true);

    try {
      const supabase = supabaseBrowser();

      const yearNumber = year.trim().length > 0 ? Number.parseInt(year.trim(), 10) : null;
      const hpNumber = powerHp.trim().length > 0 ? Number.parseInt(powerHp.trim(), 10) : null;
      const tqNumber =
        torqueftlb.trim().length > 0 ? Number.parseInt(torqueftlb.trim(), 10) : null;
      const wtNumber =
        weightlb.trim().length > 0 ? Number.parseInt(weightlb.trim(), 10) : null;

      let coverUrl: string | null = car.cover_image_url ?? null;

      if (coverFile) {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedTypes.includes(coverFile.type)) {
          setSaveMessage("Please upload a JPEG, PNG, or WebP image.");
          setSaving(false);
          return;
        }

        const maxOriginalSize = 8 * 1024 * 1024;
        if (coverFile.size > maxOriginalSize) {
          setSaveMessage("Image is too large. Please use something under 8 MB.");
          setSaving(false);
          return;
        }

        if (!coverMeta) {
          setSaveMessage("Cover image failed to load. Try uploading again.");
          setSaving(false);
          return;
        }

        const croppedBlob = await renderCroppedJpeg({
          file: coverFile,
          meta: coverMeta,
          frameW: coverFrame.w,
          frameH: coverFrame.h,
          crop: coverCrop,
          maxSize: COVER_MAX_SIZE_PX,
          aspect: COVER_ASPECT,
        });

        const fileName = `${car.id}-${Date.now()}.jpg`;
        const filePath = `${car.owner_id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("garage-covers")
          .upload(filePath, croppedBlob, {
            cacheControl: "3600",
            upsert: true,
            contentType: "image/jpeg",
          });

        if (uploadError) {
          console.error("Error uploading cover image", uploadError);
          setSaveMessage("Failed to upload cover image.");
          setSaving(false);
          return;
        }

        const { data: publicData } = supabase.storage.from("garage-covers").getPublicUrl(filePath);
        coverUrl = `${publicData.publicUrl}?t=${Date.now()}`;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;

      if (!accessToken) {
        setSaveMessage("You must be logged in to save changes.");
        setSaving(false);
        return;
      }

      const res = await fetch("/api/garage/update", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          id: car.id,
          name: name.trim() || null,
          make: make.trim() || null,
          model: model.trim() || null,
          year: yearNumber,
          chassis: chassis.trim() || null,
          trim: trim.trim() || null,
          color: color.trim() || null,
          engine: engine.trim() || null,
          power_hp: hpNumber,
          torque_ftlb: tqNumber,
          weight_lb: wtNumber,
          use_type: useType,
          visibility,
          summary: summary.trim() || null,
          mods: mods.trim() || null,
          cover_image_url: coverUrl,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaveMessage(data?.error ?? "Failed to save changes.");
        setSaving(false);
        return;
      }

      setSaveMessage("Changes saved.");
      setTimeout(() => router.push(`/garage/${car.id}`), 400);
    } catch (e) {
      console.error("Unexpected error saving car", e);
      setSaveMessage("Unexpected error saving changes.");
      setSaving(false);
    }
  };

  const inputsDisabled = maintenanceMode || saving;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
      <section className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Garage</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Edit car</h1>
          <p className="text-[12px] text-brand-textMuted sm:text-sm">
            Update details for this build.
          </p>
          <div className="mt-1 text-[11px] text-brand-textMuted">
            <Link
              href="/garage/mine"
              className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
            >
              ← Back to garage
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-brand-textMuted">
          {garageId && (
            <Link
              href={`/garage/${garageId}`}
              className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text"
            >
              View car
            </Link>
          )}
        </div>
      </section>

      {maintenanceMode && (
        <section className="mb-4">
          <p className="rounded-md border border-amber-400/70 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
            The site is currently in maintenance mode. Editing garage cars is temporarily disabled.
          </p>
        </section>
      )}

      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load car."}
          </p>
        </section>
      )}

      {state === "loading" && (
        <section>
          <p className="text-[12px] text-brand-textMuted">Loading car details…</p>
        </section>
      )}

      {state === "loaded" && car && (
        <section className="mt-3 space-y-4 rounded-xl border border-zinc-800/80 bg-black/40 p-5 text-[12px]">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Name (optional)
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="My S14 time attack build"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Year
              </label>
              <input
                type="number"
                value={year}
                onChange={(e) => setYear(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="1995"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Make
              </label>
              <input
                type="text"
                value={make}
                onChange={(e) => setMake(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="Nissan"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Model
              </label>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="240SX"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Chassis (optional)
              </label>
              <input
                type="text"
                value={chassis}
                onChange={(e) => setChassis(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="s14, s13, r33…"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Trim (optional)
              </label>
              <input
                type="text"
                value={trim}
                onChange={(e) => setTrim(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="SE, Type X, etc."
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Color (optional)
              </label>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="Black, KH3, etc."
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Engine (optional)
              </label>
              <input
                type="text"
                value={engine}
                onChange={(e) => setEngine(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="SR20DET, 2JZ-GTE…"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Power (hp)
              </label>
              <input
                type="number"
                value={powerHp}
                onChange={(e) => setPowerHp(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="300"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Torque (ft lb)
              </label>
              <input
                type="number"
                value={torqueftlb}
                onChange={(e) => setTorqueftlb(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="400"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Weight (lb)
              </label>
              <input
                type="number"
                value={weightlb}
                onChange={(e) => setWeightlb(e.target.value)}
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
                placeholder="1200"
                disabled={inputsDisabled}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Primary use
              </label>
              <MenuSelect
                ariaLabel="Primary use"
                value={useType as string}
                onChange={(next) => setUseType(next)}
                disabled={inputsDisabled}
                className="flex h-10 w-full items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-3 text-sm text-brand-text outline-none transition hover:border-brand-primary/70 disabled:opacity-60"
                options={[
                  { value: "street", label: "Street" },
                  { value: "track", label: "Track" },
                  { value: "drift", label: "Drift" },
                  { value: "drag", label: "Drag" },
                  { value: "show", label: "Show" },
                  { value: "offroad", label: "Off-road" },
                  { value: "other", label: "Other" },
                ]}
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Visibility
              </label>
              <MenuSelect
                ariaLabel="Visibility"
                value={visibility as string}
                onChange={(next) => setVisibility(next)}
                disabled={inputsDisabled}
                className="flex h-10 w-full items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-3 text-sm text-brand-text outline-none transition hover:border-brand-primary/70 disabled:opacity-60"
                options={[
                  { value: "public", label: "Public" },
                  { value: "unlisted", label: "Unlisted (link only)" },
                  { value: "private", label: "Private (only you)" },
                ]}
              />
            </div>
          </div>

          {/* Cover image (crop before upload) */}
          <div className="space-y-2">
            <label className="block text-[11px] font-medium text-brand-textMuted">Cover image</label>

            <label className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-black/40 px-3 py-6 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text">
              <div className="flex flex-col items-center gap-1">
                <span>Click to upload a new cover image</span>
                <span className="text-[10px] text-zinc-500">JPEG/PNG/WebP • crop + resize before upload</span>
              </div>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden no-zoom-input"
                onChange={handleCoverChange}
                disabled={inputsDisabled}
              />
            </label>

            {/* Cropper only appears for NEW upload (so you can actually crop) */}
            {coverPreviewUrl && coverPreviewUrl.startsWith("blob:") && coverMeta && (
              <ImageCropper
                srcUrl={coverPreviewUrl}
                meta={coverMeta}
                aspect={COVER_ASPECT}
                crop={coverCrop}
                onCropChange={setCoverCrop}
                onFrameChange={setCoverFrame}
                disabled={inputsDisabled}
              />
            )}

            {/* Existing cover preview (no crop unless re-upload) */}
            {car.cover_image_url && (!coverPreviewUrl || !coverPreviewUrl.startsWith("blob:")) && (
              <div className="space-y-2">
                <div className="relative w-full overflow-hidden rounded-lg border border-zinc-700 bg-black/60 aspect-video">
                  <img
                    src={car.cover_image_url}
                    alt="Current cover"
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                </div>
                <p className="text-[10px] text-brand-textMuted">
                  Upload a new image to change crop.
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
              Summary
            </label>
            <textarea
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              rows={3}
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
              placeholder="Short description of the build, what it’s for, etc."
              disabled={inputsDisabled}
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
              Mods / notes
            </label>
            <textarea
              value={mods}
              onChange={(e) => setMods(e.target.value)}
              rows={5}
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none placeholder:text-zinc-500 focus:border-brand-primary/70 disabled:opacity-60"
              placeholder="Engine, suspension, aero, interior, etc."
              disabled={inputsDisabled}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || maintenanceMode}
              className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-4 py-2 text-[12px] font-medium text-amber-300 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? "Saving…" : maintenanceMode ? "Disabled in maintenance" : "Save changes"}
            </button>
            {saveMessage && <span className="text-[11px] text-brand-textMuted">{saveMessage}</span>}
          </div>
        </section>
      )}
    </div>
  );
}
