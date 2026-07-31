"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MarkdownContent } from "@/components/MarkdownContent";
import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { supabaseBrowser } from "@/lib/supabaseClient";

type Draft = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  created_at: string;
  updated_at: string;
  category: string;
  chassis: string;
  tags: string[] | null;
};

type StatusState = "idle" | "submitting" | "saving" | "success" | "error";
type LoadState = "idle" | "loading" | "loaded" | "error";

const CATEGORY_OPTIONS = [
  { value: "chassis-suspension", label: "Chassis & Suspension" },
  { value: "engine-drivetrain", label: "Engine & Drivetrain" },
  { value: "wiring-electronics", label: "Wiring & Electronics" },
  { value: "body-aero", label: "Body & Aero" },
  { value: "maintenance-general", label: "Maintenance & General" },
];

const CHASSIS_OPTIONS = [
  { value: "s13", label: "S13" },
  { value: "s14", label: "S14" },
  { value: "s15", label: "S15" },
  { value: "general", label: "General / Any" },
];

type Snapshot = {
  title: string;
  slug: string;
  content: string;
  category: string;
  chassis: string;
  tagsInput: string;
};

function normalizeTag(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "-");
}

function levenshtein(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const m = s.length;
  const n = t.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

function normalizedSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / maxLen;
}

function toCleanMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---- PDF.js client-side extraction (no server route) ----
type PdfTextItem = { str?: string; transform?: number[] };
type PdfTextContent = { items: PdfTextItem[] };

async function extractPdfTextInBrowser(file: File): Promise<string> {
  const ab = await file.arrayBuffer();

  const pdfjs = (await import("pdfjs-dist/build/pdf.mjs")) as {
    GlobalWorkerOptions?: { workerSrc: string };
    getDocument?: (src: { data: Uint8Array }) => {
      promise: Promise<{
        numPages: number;
        getPage: (n: number) => Promise<{
          getTextContent: () => Promise<PdfTextContent>;
        }>;
      }>;
    };
  };

  if (!pdfjs || typeof pdfjs.getDocument !== "function") {
    throw new Error("PDF.js failed to load (missing getDocument).");
  }

  if (!pdfjs.GlobalWorkerOptions) {
    throw new Error("PDF.js failed to load (missing GlobalWorkerOptions).");
  }

  // Worker copied to /public/pdf.worker.mjs by your postinstall script
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";

  const doc = await pdfjs.getDocument({ data: new Uint8Array(ab) }).promise;

  const lines: string[] = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    let lastY: number | null = null;
    let line = "";

    for (const it of content.items) {
      const s = (it.str ?? "").trimEnd();
      if (!s) continue;

      const y =
        Array.isArray(it.transform) && typeof it.transform[5] === "number"
          ? it.transform[5]
          : null;

      if (y !== null && lastY !== null && Math.abs(y - lastY) > 2) {
        if (line.trim()) lines.push(line.trimEnd());
        line = "";
      }

      line += (line && !line.endsWith(" ") ? " " : "") + s;
      lastY = y ?? lastY;
    }

    if (line.trim()) lines.push(line.trimEnd());
    if (pageNum !== doc.numPages) lines.push("");
  }

  const raw = lines
    .join("\n")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // ✅ Convert single newlines into Markdown hard breaks so Preview keeps them.
  // Keeps paragraph breaks (blank lines) intact.
  const withHardBreaks = raw.replace(/([^\n])\n(?!\n)/g, "$1  \n");

  return withHardBreaks;
}

function InfoSubmitInner() {
  const supabase = supabaseBrowser();
  const router = useRouter();
  const searchParams = useSearchParams();
  const editInfoPageId = (searchParams.get("edit") || "").trim();

  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [authError, setAuthError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<string>("maintenance-general");
  const [chassis, setChassis] = useState<string>("general");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [tagSuggestions, setTagSuggestions] = useState<string[]>([]);

  const [status, setStatus] = useState<StatusState>("idle");
  const [message, setMessage] = useState("");

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const [loadingDrafts, setLoadingDrafts] = useState(true);
  const [deletingDraftId, setDeletingDraftId] = useState<string | null>(null);

  const [userId, setUserId] = useState<string | null>(null);
  const [viewerVerified, setViewerVerified] = useState(false);
  const [notVerified, setNotVerified] = useState(false);

  const [resubmitInfoPageId, setResubmitInfoPageId] = useState<string | null>(null);

  // Hover preview
  const [hoveredDraft, setHoveredDraft] = useState<Draft | null>(null);

  // Autosave (only starts after the user manually saves a draft)
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<string | null>(null);

  const savingDraftRef = useRef(false);
  const [lastSavedSnapshot, setLastSavedSnapshot] = useState<Snapshot | null>(
    null
  );

  const [similarPages, setSimilarPages] = useState<
    { id: string; title: string; slug: string; sim?: number }[]
  >([]);
  const [checkingSimilar, setCheckingSimilar] = useState(false);

  // Maintenance / read-only mode
  const [maintenanceMode, setMaintenanceMode] = useState(false);

  // PDF import state
  const [pdfImporting, setPdfImporting] = useState(false);

  // Load user + drafts + maintenance once (and HIDE the form when not logged in)
  useEffect(() => {
    const load = async () => {
      setLoadState("loading");
      setAuthError(null);

      try {
        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        // Load maintenance flag via existing RPC
        try {
          const { data: flagsData, error: flagsError } = await supabase.rpc(
            "get_site_lockdown_flags"
          );

          if (!flagsError && flagsData && flagsData.length > 0) {
            const row = flagsData[0] as { maintenance_mode: boolean };
            setMaintenanceMode(!!row.maintenance_mode);
          }
        } catch (e) {
          console.error("Failed to load maintenance flag", e);
        }

        if (userError || !user) {
          // Auth-required page: redirect to login instead of showing a dead-end screen
          router.replace(`/login?next=${encodeURIComponent("/info/submit")}`);
          return;
        }

        setUserId(user.id);
        // Permission gate (replaces old verified-only gate)
        setNotVerified(false);
        setViewerVerified(false);
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData?.session?.access_token;
        let canSubmit = false;
        if (token) {
          const res = await fetch("/api/me/access", {
            headers: { Authorization: `Bearer ${token}` },
          }).catch(() => null);
          const json = await res?.json().catch(() => null);
          const perms = Array.isArray(json?.permissions) ? json.permissions : [];
          canSubmit = perms.includes("info.submit");
        }

        if (!canSubmit) {
          setNotVerified(true);
          setDrafts([]);
          setLoadingDrafts(false);
          setLoadState("loaded");
          return;
        }

        const { data, error } = await supabase
          .from("info_page_drafts")
          .select(
            "id, title, slug, content_markdown, created_at, updated_at, category, chassis, tags"
          )
          .eq("created_by", user.id)
          .order("updated_at", { ascending: false });

        if (error) {
          console.error("Error loading drafts:", error);
          setDrafts([]);
        } else {
          const rows = (data || []) as Draft[];
          setDrafts(rows);
        }

        setLoadingDrafts(false);
        setLoadState("loaded");
      } catch (err) {
        console.error("Unexpected error loading user / drafts / flags:", err);
        setUserId(null);
        setDrafts([]);
        setLoadingDrafts(false);
        setLoadState("error");
        setAuthError("Unexpected error while checking your login.");
      }
    };

    void load();
  }, [supabase]);

  // Tag suggestions (dedupe from live data)
  useEffect(() => {
    const loadTagSuggestions = async () => {
      try {
        const supabase = supabaseBrowser();
        const tagSet = new Set<string>();

        const { data: infoRows, error: infoError } = await supabase
          .from("info_pages")
          .select("tags")
          .not("tags", "is", null)
          .limit(500);

        if (!infoError && infoRows) {
          for (const row of infoRows as { tags: string[] | null }[]) {
            (row.tags ?? []).forEach((t) => tagSet.add(t));
          }
        }

        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (user) {
          const { data: draftRows, error: draftError } = await supabase
            .from("info_page_drafts")
            .select("tags")
            .not("tags", "is", null)
            .limit(500);

          if (!draftError && draftRows) {
            for (const row of draftRows as { tags: string[] | null }[]) {
              (row.tags ?? []).forEach((t) => tagSet.add(t));
            }
          }
        }

        setTagSuggestions(Array.from(tagSet).sort());
      } catch (e) {
        console.error("Error loading tag suggestions", e);
      }
    };

    void loadTagSuggestions();
  }, []);

  const resetForm = () => {
    setTitle("");
    setSlug("");
    setContent("");
    setCategory("maintenance-general");
    setChassis("general");
    setTags([]);
    setTagInput("");
    setCurrentDraftId(null);
    setLastSavedSnapshot(null);
    setResubmitInfoPageId(null);
  };

  // If arriving from /info/mine with ?edit=<id>, load the rejected submission for editing/resubmission.
  useEffect(() => {
    const run = async () => {
      if (!editInfoPageId) return;
      if (!userId) return;
      if (maintenanceMode) return;

      try {
        const supabase = supabaseBrowser();
        const { data, error } = await supabase
          .from("info_pages")
          .select("id,title,slug,content_markdown,category,chassis,tags,created_by,status")
          .eq("id", editInfoPageId)
          .maybeSingle<{
            id: string;
            title: string;
            slug: string;
            content_markdown: string;
            category: string | null;
            chassis: string | null;
            tags: string[] | null;
            created_by: string;
            status: string;
          }>();

        if (error || !data) {
          console.error("Failed to load rejected submission for edit", error);
          return;
        }

        if (data.created_by !== userId) return;
        if (String(data.status) !== "rejected") return;

        setResubmitInfoPageId(data.id);
        setTitle(data.title ?? "");
        setSlug(data.slug ?? "");
        setContent(data.content_markdown ?? "");
        setCategory(data.category ?? "maintenance-general");
        setChassis(data.chassis ?? "general");
        setTags(data.tags ?? []);
        setTagInput("");
        setCurrentDraftId(null);
        setStatus("idle");
        setMessage("Editing your rejected submission. Update it and submit again for review.");
      } catch (e) {
        console.error("Unexpected error loading rejected submission", e);
      }
    };

    void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editInfoPageId, userId, maintenanceMode]);

  const ensureDraftSlug = () => {
    const raw = slug.trim();
    if (raw) return raw;

    const fromTitle = title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    if (fromTitle) return fromTitle;

    return `draft-${Date.now()}`;
  };

  // --- helper: save draft (manual or autosave) ---
  const saveDraft = async (silent: boolean) => {
    try {
      if (savingDraftRef.current) return;
      savingDraftRef.current = true;

      if (maintenanceMode) {
        if (!silent) {
          setStatus("error");
          setMessage(
            "Submissions are temporarily read-only while the site is in maintenance mode."
          );
        }
        return;
      }

      if (!userId) {
        if (!silent) {
          setStatus("error");
          setMessage("You must be logged in to save a draft.");
        }
        return;
      }

      const normalizedTitle = title || "(Untitled)";
      const draftSlug = ensureDraftSlug();
      const normalizedContent = content;
      const normalizedCategory = category || "maintenance-general";
      const normalizedChassis = chassis || "general";

      const snapshot: Snapshot = {
        title: normalizedTitle,
        slug: draftSlug,
        content: normalizedContent,
        category: normalizedCategory,
        chassis: normalizedChassis,
        tagsInput: "",
      };

      if (silent && lastSavedSnapshot) {
        const same =
          lastSavedSnapshot.title === snapshot.title &&
          lastSavedSnapshot.slug === snapshot.slug &&
          lastSavedSnapshot.content === snapshot.content &&
          lastSavedSnapshot.category === snapshot.category &&
          lastSavedSnapshot.chassis === snapshot.chassis;

        if (same) {
          setLastAutoSavedAt(new Date().toLocaleTimeString());
          return;
        }
      }

      if (!title.trim() && !content.trim()) {
        if (!silent) {
          setStatus("error");
          setMessage("Add a title or some content before saving a draft.");
        }
        return;
      }

      if (!silent) {
        setStatus("saving");
        setMessage("");
      }

      if (!currentDraftId) {
        const { data, error } = await supabase
          .from("info_page_drafts")
          .insert({
            title: normalizedTitle,
            slug: draftSlug,
            content_markdown: normalizedContent,
            category: normalizedCategory,
            chassis: normalizedChassis,
            tags,
            created_by: userId,
          })
          .select(
            "id, title, slug, content_markdown, created_at, updated_at, category, chassis, tags"
          )
          .single<Draft>();

        if (error) {
          console.error("Error saving draft:", error);
          if (!silent) {
            setStatus("error");
            setMessage(error.message || "Failed to save draft.");
          }
          return;
        }

        setCurrentDraftId(data.id);
        setDrafts((prev) => [data, ...prev]);
        setLastSavedSnapshot(snapshot);

        // Once the user manually saves a draft, enable autosave for subsequent edits.
        if (!silent) setAutoSaveEnabled(true);

        if (!silent) {
          setStatus("idle");
          setMessage("Draft saved.");
        } else {
          setLastAutoSavedAt(new Date().toLocaleTimeString());
        }
        return;
      }

      const { data, error } = await supabase
        .from("info_page_drafts")
        .update({
          title: normalizedTitle,
          slug: draftSlug,
          content_markdown: normalizedContent,
          category: normalizedCategory,
          chassis: normalizedChassis,
          tags,
          updated_at: new Date().toISOString(),
        })
        .eq("id", currentDraftId)
        .select(
          "id, title, slug, content_markdown, created_at, updated_at, category, chassis, tags"
        )
        .single<Draft>();

      if (error) {
        console.error("Error updating draft:", error);
        if (!silent) {
          setStatus("error");
          setMessage(error.message || "Failed to update draft.");
        }
        return;
      }

      setDrafts((prev) => prev.map((d) => (d.id === data.id ? data : d)));
      setLastSavedSnapshot(snapshot);

      if (!silent) setAutoSaveEnabled(true);

      if (!silent) {
        setStatus("idle");
        setMessage("Draft updated.");
      } else {
        setLastAutoSavedAt(new Date().toLocaleTimeString());
      }
    } catch (err) {
      console.error("Unexpected error saving draft:", err);
      if (!silent) {
        setStatus("error");
        setMessage("Unexpected error saving draft.");
      }
    } finally {
      savingDraftRef.current = false;
    }
  };

  const handleSaveDraft = async () => {
    setStatus("saving");
    setMessage("");
    await saveDraft(false);
  };

  useEffect(() => {
    const raw = title.trim();

    if (!raw || raw.length < 4) {
      setSimilarPages([]);
      setCheckingSimilar(false);
      return;
    }

    const run = async () => {
      setCheckingSimilar(true);

      try {
        const supabase = supabaseBrowser();

        const { data, error } = await supabase
          .from("info_pages")
          .select("id, title, slug")
          .eq("status", "approved")
          .limit(200);

        if (error || !data) {
          console.error("Error checking similar titles", error);
          setSimilarPages([]);
          return;
        }

        const rows = data as { id: string; title: string; slug: string }[];

        const scored = rows
          .map((row) => ({
            ...row,
            sim: normalizedSimilarity(raw, row.title ?? ""),
          }))
          .filter((r) => (r.sim ?? 0) >= 0.4)
          .sort((a, b) => (b.sim ?? 0) - (a.sim ?? 0))
          .slice(0, 3);

        setSimilarPages(scored);
      } catch (e) {
        console.error("Unexpected error checking similar titles", e);
        setSimilarPages([]);
      } finally {
        setCheckingSimilar(false);
      }
    };

    const timeout = setTimeout(run, 500);
    return () => clearTimeout(timeout);
  }, [title]);

  // Autosave effect (silent)
  useEffect(() => {
    if (!autoSaveEnabled) return;
    if (!userId) return;
    // Only autosave once the user has created a draft via the manual "Save draft" button.
    if (!currentDraftId) return;
    if (!title && !slug && !content) return;
    if (maintenanceMode) return;

    const timeout = setTimeout(() => {
      if (status === "submitting" || status === "saving") return;
      void saveDraft(true);
    }, 7000);

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    title,
    slug,
    content,
    category,
    chassis,
    autoSaveEnabled,
    userId,
    currentDraftId,
    maintenanceMode,
    status,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus("submitting");
    setMessage("");

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session) {
        setStatus("error");
        setMessage("You must be logged in to submit an info page.");
        return;
      }

      const accessToken = session.access_token;

      const res = await fetch("/api/info/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          title,
          slug,
          content,
          category,
          chassis,
          tags,
          draftId: currentDraftId,
        infoPageId: resubmitInfoPageId,
        }),
      });

      const data = (await res.json()) as { ok?: boolean; error?: string };

      if (!res.ok || !data.ok) {
        setStatus("error");
        setMessage(
          data?.error || "Failed to submit. Check your input or try again."
        );
        return;
      }

      if (currentDraftId) {
        setDrafts((prev) => prev.filter((d) => d.id !== currentDraftId));
      }

      setStatus("success");
      setMessage(
        "Submitted for review. An admin will review this before it goes public."
      );
      resetForm();
    } catch (err) {
      console.error("Unexpected error submitting:", err);
      setStatus("error");
      setMessage("Unexpected error submitting.");
    }
  };

  const handleSelectDraft = (draft: Draft) => {
    setCurrentDraftId(draft.id);
    setTitle(draft.title === "(Untitled)" ? "" : draft.title);
    setSlug(draft.slug);
    setContent(draft.content_markdown);
    setCategory(draft.category || "maintenance-general");
    setChassis(draft.chassis || "general");
    setTags(draft.tags ?? []);
    setTagInput("");
    setStatus("idle");
    setMessage(
      `Editing draft from ${new Date(draft.updated_at).toLocaleString()}.`
    );
  };

  const handleDeleteDraft = async (draftId: string) => {
    try {
      setStatus("idle");
      setMessage("");
      setDeletingDraftId(draftId);

      const { error } = await supabase
        .from("info_page_drafts")
        .delete()
        .eq("id", draftId);

      if (error) {
        console.error("Error deleting draft:", error);
        setStatus("error");
        setMessage(error.message || "Failed to delete draft.");
        return;
      }

      setDrafts((prev) => prev.filter((d) => d.id !== draftId));

      if (currentDraftId === draftId) {
        resetForm();
        setMessage("Draft deleted.");
      }
    } catch (err) {
      console.error("Unexpected error deleting draft:", err);
      setStatus("error");
      setMessage("Unexpected error deleting draft.");
    } finally {
      setDeletingDraftId(null);
    }
  };

  async function handleImportPdf(file: File) {
    try {
      if (maintenanceMode) return;

      setPdfImporting(true);
      setStatus("idle");
      setMessage("");

      const extracted = await extractPdfTextInBrowser(file);

      if (!extracted) {
        setStatus("error");
        setMessage("No text found. (If it’s scanned, OCR is required.)");
        return;
      }

      const header = `\n\n---\n\n## Imported from PDF: ${file.name}\n\n`;
      setContent((prev) => (prev.trim() ? prev + header + extracted : extracted));

      setStatus("idle");
      setMessage("PDF imported into the editor.");
    } catch (err: unknown) {
      console.error("PDF import error:", err);
      const details = err instanceof Error ? err.message : "Unknown error";
      setStatus("error");
      setMessage(`PDF import failed: ${details}`);
    } finally {
      setPdfImporting(false);
    }
  }

  const submissionDisabled = maintenanceMode || status === "submitting";
  const draftDisabled =
    maintenanceMode || status === "submitting" || status === "saving";

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 text-brand-text">
      <h1 className="mb-2 text-2xl font-semibold">Submit an Information Page</h1>

      {maintenanceMode && (
        <div className="mb-4 rounded-md border border-amber-400/70 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
          The site is currently in maintenance mode. New submissions and draft
          saves are disabled.
        </div>
      )}

      <p className="mb-6 text-sm text-brand-textMuted">
        This is for official-style guides and reference pages. Submissions are
        marked as <span className="font-semibold">pending</span> until an admin
        reviews and approves them.
      </p>

      <div className="mt-2 text-[11px] text-brand-textMuted">
        <Link
          href="/info"
          className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
        >
          ← Back to all info
        </Link>
      </div>

      {/* Not logged in (should normally redirect) */}
      {loadState === "error" && !userId && (
        <div className="mt-4 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
          {authError ?? "You must be logged in to submit an info page."}
        </div>
      )}

      {notVerified && (
        <div className="mt-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-100">
          You do not have permission to submit new information pages.
        </div>
      )}

      {/* Logged in + verified */}
      {userId && !notVerified && (
        <div className="mt-4 grid gap-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          {/* main form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-brand-text">Title</label>
              <input
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-brand-bgStart p-2 text-sm text-brand-text outline-none focus:border-brand-primary"
                placeholder="Example: S14 Rear Subframe Bushing Replacement"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
                disabled={maintenanceMode}
              />

              {(checkingSimilar || similarPages.length > 0) && (
                <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-medium text-amber-200">
                      Possible existing pages with a similar title:
                    </p>
                    {checkingSimilar && (
                      <span className="text-[10px] text-amber-200/70">
                        Checking…
                      </span>
                    )}
                  </div>

                  {similarPages.length > 0 && (
                    <ul className="mt-1 space-y-1">
                      {similarPages.map((page) => (
                        <li key={page.id} className="text-[11px]">
                          <a
                            href={`/info/${page.slug}`}
                            target="_blank"
                            className="text-amber-200 underline underline-offset-2 hover:text-amber-100"
                            rel="noreferrer"
                          >
                            {page.title}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}

                  {similarPages.length === 0 && !checkingSimilar && (
                    <p className="mt-1 text-[11px] text-amber-200/80">
                      No close matches found.
                    </p>
                  )}
                </div>
              )}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                  Slug
                </label>
                <input
                  className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-sm text-brand-text outline-none focus:border-brand-primary/70"
                  placeholder="s14-rear-subframe-bushing-replacement"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  pattern="[a-z0-9\\-]+"
                  title="Lowercase letters, numbers, and dashes only"
                  required
                  disabled={maintenanceMode}
                />
                <p className="mt-1 text-xs text-brand-textMuted">
                  Lowercase letters, numbers, and dashes only (used in the URL).
                </p>
              </div>

              <div className="grid gap-3 md:grid-cols-2 mt-1 md:mt-0">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                    Category
                  </label>
                  <MenuSelect
                    ariaLabel="Category"
                    value={category as string}
                    onChange={(next) => setCategory(next)}
                    disabled={maintenanceMode}
                    className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text outline-none transition hover:border-brand-primary/70"
                    options={CATEGORY_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                    Chassis
                  </label>
                  <MenuSelect
                    ariaLabel="Chassis"
                    value={chassis as string}
                    onChange={(next) => setChassis(next)}
                    disabled={maintenanceMode}
                    className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text outline-none transition hover:border-brand-primary/70"
                    options={CHASSIS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                  />
                </div>
              </div>
            </div>

            {/* Tags */}
            <div>
              <label className="mb-1 block text-[11px] font-medium text-brand-textMuted">
                Tags
              </label>
              <p className="mb-1 text-[11px] text-brand-textMuted">
                Press Enter or comma to add. Backspace deletes last tag.
              </p>

              <div className="flex flex-wrap gap-1 rounded-md border border-zinc-700 bg-brand-bgStart p-2 text-xs">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-200"
                  >
                    <span>{tag}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setTags((prev) => prev.filter((t) => t !== tag))
                      }
                      className="text-[10px] text-amber-300 hover:text-amber-200"
                      disabled={maintenanceMode}
                    >
                      ×
                    </button>
                  </span>
                ))}

                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (maintenanceMode) return;

                    if (e.key === "Enter" || e.key === ",") {
                      e.preventDefault();
                      const normalized = normalizeTag(tagInput);
                      if (normalized && !tags.includes(normalized)) {
                        setTags((prev) => [...prev, normalized]);
                      }
                      setTagInput("");
                      return;
                    }

                    if (
                      e.key === "Backspace" &&
                      tagInput.trim() === "" &&
                      tags.length > 0
                    ) {
                      e.preventDefault();
                      setTags((prev) => prev.slice(0, -1));
                    }
                  }}
                  placeholder={tags.length === 0 ? "Add tag…" : ""}
                  className="flex-1 no-zoom-input bg-transparent text-[11px] text-brand-text outline-none placeholder:text-brand-textMuted"
                  disabled={maintenanceMode}
                />
              </div>

              {tagInput.trim() && tagSuggestions.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {tagSuggestions
                    .filter((t) =>
                      t.toLowerCase().includes(tagInput.toLowerCase())
                    )
                    .slice(0, 8)
                    .map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => {
                          if (maintenanceMode) return;
                          if (!tags.includes(t)) setTags((prev) => [...prev, t]);
                          setTagInput("");
                        }}
                        className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[11px] text-brand-textMuted hover:border-amber-400/80 hover:text-amber-200 disabled:opacity-60"
                        disabled={maintenanceMode}
                      >
                        {t}
                      </button>
                    ))}
                </div>
              )}
            </div>

            {/* PDF import */}
            <div className="rounded-md border border-zinc-700 bg-black/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[12px] font-medium text-brand-text">
                    Import PDF → Markdown
                  </p>
                  <p className="text-[11px] text-brand-textMuted">
                    Extracts text in your browser and inserts it into the editor.
                  </p>
                </div>

                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-3 py-2 text-[11px] text-brand-text hover:border-brand-primary/60 hover:bg-brand-bgStart/80 disabled:opacity-60">
                  <input
                    type="file"
                    accept="application/pdf"
                    className="no-zoom-input hidden"
                    disabled={maintenanceMode || pdfImporting}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.currentTarget.value = "";
                      if (!f) return;
                      void handleImportPdf(f);
                    }}
                  />
                  {pdfImporting ? "Importing…" : "Choose PDF"}
                </label>
              </div>
            </div>

            <MarkdownEditor
              id="info-content"
              label="Content (Markdown)"
              value={content}
              onChange={setContent}
              helperText="Use markdown for headings, links, images, and formatting."
              rows={12}
            />

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleSaveDraft}
                disabled={draftDisabled}
                className="rounded-md border border-zinc-700 bg-black/40 px-4 py-2 text-xs font-medium text-brand-text hover:border-brand-primary/60 hover:bg-brand-bgStart/80 disabled:opacity-60"
              >
                {status === "saving"
                  ? "Saving draft..."
                  : maintenanceMode
                  ? "Drafts disabled"
                  : "Save draft"}
              </button>

              <button
                type="submit"
                disabled={submissionDisabled}
                className="ui-btn ui-btn-primary px-4 py-2 text-xs disabled:opacity-60"
              >
                {status === "submitting"
                  ? "Submitting..."
                  : maintenanceMode
                  ? "Submissions disabled"
                  : "Submit for review"}
              </button>

              <div className="ml-auto flex flex-col items-end gap-1">
                <label className="flex items-center gap-2 text-[11px] text-brand-textMuted">
                  <input
                    type="checkbox"
                    checked={autoSaveEnabled}
                    onChange={(e) => setAutoSaveEnabled(e.target.checked)}
                    className="no-zoom-input"
                    disabled={maintenanceMode}
                  />
                  <span>Autosave draft every few seconds</span>
                </label>
                {lastAutoSavedAt && (
                  <p className="text-[10px] text-brand-textMuted">
                    Last autosave: {lastAutoSavedAt}
                  </p>
                )}
              </div>
            </div>

            {message && (
              <p
                className={`mt-2 text-sm ${
                  status === "error" ? "text-red-400" : "text-brand-textMuted"
                }`}
              >
                {message}
              </p>
            )}
          </form>

          {/* drafts sidebar */}
          <aside className="relative rounded-lg border border-zinc-700 bg-brand-bgStart/80 p-3">
            <h2 className="mb-2 text-sm font-semibold">Your drafts</h2>

            {hoveredDraft && (
              <div className="pointer-events-none absolute left-full top-0 z-20 ml-3 w-72 rounded-md border border-zinc-700 bg-black/90 p-3 shadow-lg">
                <p className="mb-1 text-[11px] text-brand-textMuted">
                  Preview (rendered)
                </p>
                <div className="max-h-56 overflow-auto text-[11px] text-brand-text">
                  <div className="space-y-1 [&_a]:text-brand-primary [&_a]:underline [&_strong]:font-semibold [&_em]:italic [&_code]:rounded [&_code]:bg-black/40 [&_code]:px-1 [&_code]:py-0.5">
                    <MarkdownContent
                      markdown={hoveredDraft.content_markdown}
                      makeUserHref={(u) => `/user/@${u}`}
                    />
                  </div>
                </div>
              </div>
            )}

            {loadingDrafts && (
              <p className="text-xs text-brand-textMuted">Loading drafts…</p>
            )}

            {!loadingDrafts && drafts.length === 0 && (
              <p className="text-xs text-brand-textMuted">
                You don&apos;t have any drafts yet. Start writing and click
                &quot;Save draft&quot;.
              </p>
            )}

            {drafts.length > 0 && (
              <div className="mt-2 space-y-2">
                {drafts.map((draft) => (
                  <div
                    key={draft.id}
                    onClick={() => handleSelectDraft(draft)}
                    onMouseEnter={() => setHoveredDraft(draft)}
                    onMouseLeave={() =>
                      setHoveredDraft((prev) =>
                        prev && prev.id === draft.id ? null : prev
                      )
                    }
                    className={`group cursor-pointer rounded-md border px-2 py-2 text-xs transition ${
                      currentDraftId === draft.id
                        ? "border-brand-primary/70 bg-black/40"
                        : "border-zinc-700 bg-black/30 hover:border-brand-primary/60 hover:bg-black/40"
                    }`}
                  >
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium text-brand-text group-hover:text-brand-primary">
                        {draft.title || "(Untitled)"}
                      </span>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDeleteDraft(draft.id);
                        }}
                        disabled={deletingDraftId === draft.id}
                        className="text-[11px] text-red-400 hover:text-red-300 disabled:opacity-50"
                      >
                        {deletingDraftId === draft.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>

                    <p className="text-[10px] text-brand-textMuted">
                      Updated:{" "}
                      {new Date(draft.updated_at).toLocaleDateString()}{" "}
                      {new Date(draft.updated_at).toLocaleTimeString()}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

export default function InfoSubmitPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-6xl px-4 py-10">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-6 text-sm text-brand-textMuted">
            Loading…
          </div>
        </div>
      }
    >
      <InfoSubmitInner />
    </Suspense>
  );
}
