"use client";

import { useEffect, useState, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { ImageCropper } from "@/components/ImageCropper";
import {
  DEFAULT_CROP,
  getImageMetaFromUrl,
  renderCroppedJpeg,
  type CropState,
  type ImgMeta,
} from "@/lib/imageCrop";

type LoadState = "idle" | "loading" | "loaded" | "error";

type CurrentUser = {
  id: string;
  email: string | null;
};

type GarageNewResponse =
  | {
      id?: string;
      error?: string;
    }
  | null;

const COVER_ASPECT = 16 / 9;
const COVER_MAX_SIZE_PX = 1600;

export default function GarageNewPage() {
  const router = useRouter();

  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [maintenanceMode, setMaintenanceMode] = useState(false);

  // Form fields
  const [year, setYear] = useState<string>("");
  const [make, setMake] = useState<string>("");
  const [model, setModel] = useState<string>("");
  const [chassis, setChassis] = useState<string>("");
  const [trim, setTrim] = useState<string>("");
  const [color, setColor] = useState<string>("");
  const [engine, setEngine] = useState<string>("");

  const [powerHp, setPowerHp] = useState<string>("");
  const [torqueftlb, setTorqueftlb] = useState<string>("");
  const [weightlb, setWeightlb] = useState<string>("");

  const [summary, setSummary] = useState<string>("");
  const [mods, setMods] = useState<string>("");

  const [useType, setUseType] = useState<
    "street" | "track" | "drift" | "drag" | "show" | "daily"
  >("street");

  const [visibility, setVisibility] = useState<"public" | "unlisted" | "private">("public");

  const [setAsPrimary, setSetAsPrimary] = useState<boolean>(true);

  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [coverPreviewUrl, setCoverPreviewUrl] = useState<string | null>(null);
  const [coverMeta, setCoverMeta] = useState<ImgMeta | null>(null);
  const [coverCrop, setCoverCrop] = useState<CropState>(DEFAULT_CROP);

  const [coverFrame, setCoverFrame] = useState({
    w: 640,
    h: Math.round(640 / COVER_ASPECT),
  });

  const [saving, setSaving] = useState(false);



  useEffect(() => {
    const loadUser = async () => {
      setLoadState("loading");
      setErrorMessage(null);

      try {
        const supabase = supabaseBrowser();
        const {
          data: { user },
          error,
        } = await supabase.auth.getUser();

        if (error || !user) {
          setCurrentUser(null);
          setLoadState("error");
          setErrorMessage("You must be logged in to add a car to your garage.");
          return;
        }

        setCurrentUser({ id: user.id, email: user.email ?? null });

        const { data: flagsData, error: flagsError } = await supabase.rpc("get_site_lockdown_flags");
        if (!flagsError && flagsData && flagsData.length > 0) {
          const row = flagsData[0] as { maintenance_mode: boolean };
          setMaintenanceMode(!!row.maintenance_mode);
        }

        setLoadState("loaded");
      } catch (err) {
        console.error("Failed to load current user", err);
        setErrorMessage("Unexpected error while loading user.");
        setLoadState("error");
      }
    };

    void loadUser();
  }, []);

  useEffect(() => {
    return () => {
      if (coverPreviewUrl && coverPreviewUrl.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(coverPreviewUrl);
        } catch {}
      }
    };
  }, [coverPreviewUrl]);

  const handleCoverChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!file) {
      setCoverFile(null);
      setCoverPreviewUrl(null);
      setCoverMeta(null);
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

  const handleSubmit = async () => {
    if (!currentUser) {
      setErrorMessage("You must be logged in to add a car.");
      return;
    }

    if (maintenanceMode) {
      setErrorMessage("Garage is temporarily read-only while the site is in maintenance mode.");
      return;
    }

    const yearNum = year.trim().length > 0 ? Number.parseInt(year.trim(), 10) : null;

    if (!make.trim() || !model.trim()) {
      setErrorMessage("Please enter at least make and model.");
      return;
    }

    if (yearNum && (yearNum < 1900 || yearNum > 2100)) {
      setErrorMessage("Please enter a valid year.");
      return;
    }

    const powerHpNum = powerHp.trim().length > 0 ? Number.parseInt(powerHp.trim(), 10) : null;
    const torqueftlbNum =
      torqueftlb.trim().length > 0 ? Number.parseInt(torqueftlb.trim(), 10) : null;
    const weightlbNum =
      weightlb.trim().length > 0 ? Number.parseInt(weightlb.trim(), 10) : null;

    if (
      (powerHp.trim() && Number.isNaN(powerHpNum)) ||
      (torqueftlb.trim() && Number.isNaN(torqueftlbNum)) ||
      (weightlb.trim() && Number.isNaN(weightlbNum))
    ) {
      setErrorMessage("Power, torque, and weight must be numbers.");
      return;
    }

    setSaving(true);
    setErrorMessage(null);

    try {
      const supabase = supabaseBrowser();
      let coverUrl: string | null = null;

      if (coverFile) {
        const allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedTypes.includes(coverFile.type)) {
          setErrorMessage("Please upload a JPEG, PNG, or WebP image.");
          setSaving(false);
          return;
        }

        const maxOriginalSize = 8 * 1024 * 1024;
        if (coverFile.size > maxOriginalSize) {
          setErrorMessage("Image is too large. Please use something under 8 MB.");
          setSaving(false);
          return;
        }

        if (!coverMeta) {
          setErrorMessage("Cover image failed to load. Try uploading again.");
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

        const fileName = `${currentUser.id}-${Date.now()}.jpg`;
        const filePath = `${currentUser.id}/${fileName}`;

        const { error: uploadError } = await supabase.storage
          .from("garage-covers")
          .upload(filePath, croppedBlob, {
            cacheControl: "3600",
            upsert: true,
            contentType: "image/jpeg",
          });

        if (uploadError) {
          console.error("Error uploading cover image", uploadError);
          setErrorMessage("Failed to upload cover image.");
          setSaving(false);
          return;
        }

        const { data: publicData } = supabase.storage.from("garage-covers").getPublicUrl(filePath);
        coverUrl = `${publicData.publicUrl}?t=${Date.now()}`;
      }

      const res = await fetch("/api/garage/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          owner_id: currentUser.id,
          year: yearNum,
          make: make.trim(),
          model: model.trim(),
          chassis: chassis.trim() || null,
          trim: trim.trim() || null,
          color: color.trim() || null,
          engine: engine.trim() || null,
          power_hp: powerHpNum,
          torque_ftlb: torqueftlbNum,
          weight_lb: weightlbNum,
          summary: summary.trim() || null,
          mods: mods.trim() || null,
          use_type: useType,
          visibility,
          is_primary: setAsPrimary,
          cover_image_url: coverUrl,
        }),
      });

      let data: GarageNewResponse = null;
      const text = await res.text();
      if (text) {
        try {
          data = JSON.parse(text) as GarageNewResponse;
        } catch (e) {
          console.error("Failed to parse JSON response from /api/garage/new", e, text);
        }
      }

      if (!res.ok) {
        const msg = data?.error ?? "Failed to create car. Please try again.";
        setErrorMessage(msg);
        setSaving(false);
        return;
      }

      const newId = data?.id;
      if (!newId) {
        setErrorMessage("Car created but missing id from response.");
        setSaving(false);
        return;
      }

      router.push(`/garage/${newId}`);
    } catch (err) {
      console.error("Unexpected error creating car", err);
      setErrorMessage("Unexpected error while creating car.");
      setSaving(false);
    }
  };

  const isDisabled =
    saving ||
    !currentUser ||
    (!make.trim() && !model.trim()) ||
    (year.trim().length > 0 && Number.isNaN(Number.parseInt(year, 10))) ||
    maintenanceMode;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 text-brand-text">
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Garage • New car</p>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          Add a car to your garage
        </h1>
        <p className="text-[12px] text-brand-textMuted sm:text-sm">
          Share your build, list its modifications, and choose how visible it should be.
        </p>
        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href="/garage/mine"
            className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
          >
            ← Back to garage
          </Link>
        </div>
      </section>

      {maintenanceMode && (
        <section>
          <p className="rounded-md border border-amber-400/70 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
            The site is currently in maintenance mode. Creating new garage cars is temporarily disabled.
          </p>
        </section>
      )}

      {loadState === "error" && !currentUser && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "You must be logged in to create a garage entry."}
          </p>
        </section>
      )}

      {currentUser && (
        <section className="space-y-4 rounded-xl border border-zinc-800/80 bg-black/35 p-4 sm:p-5">
          {errorMessage && (
            <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
              {errorMessage}
            </p>
          )}

          <div className="grid gap-4 md:grid-cols-[3fr,2fr]">
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Year</label>
                  <input
                    type="number"
                    value={year}
                    onChange={(e) => setYear(e.target.value)}
                    placeholder="1995"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Make</label>
                  <input
                    type="text"
                    value={make}
                    onChange={(e) => setMake(e.target.value)}
                    placeholder="Nissan"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Model</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="240SX"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Chassis</label>
                  <input
                    type="text"
                    value={chassis}
                    onChange={(e) => setChassis(e.target.value)}
                    placeholder="S14, S13, S15..."
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Trim</label>
                  <input
                    type="text"
                    value={trim}
                    onChange={(e) => setTrim(e.target.value)}
                    placeholder="SE, Q's, Kouki..."
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Color</label>
                  <input
                    type="text"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="KH3 Super Black"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Engine</label>
                <input
                  type="text"
                  value={engine}
                  onChange={(e) => setEngine(e.target.value)}
                  placeholder="S13 SR20DET..."
                  className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                  disabled={maintenanceMode}
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Power (hp)</label>
                  <input
                    type="number"
                    value={powerHp}
                    onChange={(e) => setPowerHp(e.target.value)}
                    placeholder="300"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
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
                    placeholder="350"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Weight (lb)</label>
                  <input
                    type="number"
                    value={weightlb}
                    onChange={(e) => setWeightlb(e.target.value)}
                    placeholder="1200"
                    className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                    disabled={maintenanceMode}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Summary</label>
                <textarea
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  rows={3}
                  placeholder="Quick overview of the build..."
                  className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                  disabled={maintenanceMode}
                />
              </div>

              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">Mods / setup</label>
                <textarea
                  value={mods}
                  onChange={(e) => setMods(e.target.value)}
                  rows={5}
                  placeholder="Coilovers, arms, brakes..."
                  className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
                  disabled={maintenanceMode}
                />
              </div>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-[11px] font-medium text-brand-textMuted">Cover image</label>

                <label className="inline-flex cursor-pointer items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-black/40 px-3 py-6 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text">
                  <div className="flex flex-col items-center gap-1">
                    <span>Click to upload a cover image</span>
                    <span className="text-[10px] text-zinc-500">JPEG/PNG/WebP • crop + resize before upload</span>
                  </div>
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="no-zoom-input hidden"
                    onChange={handleCoverChange}
                    disabled={maintenanceMode}
                  />
                </label>

                {coverPreviewUrl && coverMeta && (
                  <ImageCropper
                    srcUrl={coverPreviewUrl}
                    meta={coverMeta}
                    aspect={COVER_ASPECT}
                    crop={coverCrop}
                    onCropChange={setCoverCrop}
                    onFrameChange={setCoverFrame}
                    disabled={maintenanceMode || saving}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-medium text-brand-textMuted">Primary use</label>
                <div className="flex flex-wrap gap-1.5 text-[11px]">
                  {(
                    [
                      ["street", "Street"],
                      ["daily", "Daily"],
                      ["track", "Track / Time attack"],
                      ["drift", "Drift"],
                      ["drag", "Drag"],
                      ["show", "Show / demo"],
                    ] as const
                  ).map(([value, label]) => {
                    const active = useType === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        onClick={() => !maintenanceMode && setUseType(value)}
                        className={
                          "rounded-full border px-2 py-0.5 " +
                          (active
                            ? "border-amber-400 bg-amber-500/20 text-amber-300"
                            : "border-zinc-700 bg-black/40 text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text")
                        }
                        disabled={maintenanceMode}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="block text-[11px] font-medium text-brand-textMuted">Visibility</label>
                <div className="flex flex-col gap-1 text-[11px]">
                  {(["public", "unlisted", "private"] as const).map((v) => (
                    <label
                      key={v}
                      className="flex items-start gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 hover:border-amber-400/70"
                    >
                      <input
                        type="radio"
                        name="visibility"
                        value={v}
                        checked={visibility === v}
                        onChange={() => setVisibility(v)}
                        className="no-zoom-input mt-[2px]"
                        disabled={maintenanceMode}
                      />
                      <div>
                        <div className="font-medium text-brand-text">
                          {v === "public" ? "Public" : v === "unlisted" ? "Unlisted" : "Private"}
                        </div>
                        <div className="text-[10px] text-brand-textMuted">
                          {v === "public"
                            ? "Visible to everyone."
                            : v === "unlisted"
                            ? "Only people with the link."
                            : "Only you can see it."}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-[11px] text-brand-text">
                  <input
                    type="checkbox"
                    checked={setAsPrimary}
                    onChange={(e) => setSetAsPrimary(e.target.checked)}
                    disabled={maintenanceMode}
                    className="no-zoom-input"
                  />
                  <span className="font-medium">Set as primary car on my profile</span>
                </label>
                <p className="text-[10px] text-brand-textMuted">
                  This will be highlighted first on your profile and garage.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <p className="text-[11px] text-brand-textMuted">
              You can always edit this car later (specs, image, mods, and visibility).
            </p>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={isDisabled}
              className="inline-flex items-center justify-center rounded-full border border-white bg-white px-4 py-2 text-[12px] font-medium text-black shadow-sm shadow-black/60 transition hover:bg-zinc-200 active:bg-zinc-300 disabled:opacity-60"
            >
              {saving ? "Saving…" : maintenanceMode ? "Disabled in maintenance" : "Create car"}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
