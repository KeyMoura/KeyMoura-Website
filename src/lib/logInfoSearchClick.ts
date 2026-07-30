import { supabaseBrowser } from "@/lib/supabaseClient";

export type InfoSearchClickSource =
  | "info-index"
  | "info-category"
  | "command-palette";

export async function logInfoSearchClick(params: {
  source: InfoSearchClickSource;
  clickedPageId: string;
  clickedPageSlug: string;
  rawQuery?: string;
  tokens?: string[];
  position?: number;
  resultsCount?: number;
  meta?: Record<string, unknown>;
}) {
  try {
    const supabase = supabaseBrowser();

    const { error } = await supabase
      .from("info_search_click_events")
      .insert({
        source: params.source,
        raw_query: params.rawQuery ?? null,
        tokens: params.tokens ?? null,
        clicked_page_id: params.clickedPageId,
        clicked_page_slug: params.clickedPageSlug,
        position: params.position ?? null,
        results_count: params.resultsCount ?? null,
        meta: params.meta ?? null,
      });

    if (error) {
      console.error("Failed to log info search click event", error);
    }
  } catch (err) {
    console.error(
      "Unexpected error logging info search click event",
      err
    );
  }
}
