import { routeServiceClient } from "@/lib/api/routeAuth";

export async function hardBlockIfProfane(text: string): Promise<{ ok: true } | { error: string }> {
  const t = (text ?? "").trim();
  if (!t) return { ok: true };

  const { data, error } = await routeServiceClient.rpc("contains_profanity", {
    input_text: t,
  });

  if (error) {
    // eslint-disable-next-line no-console
    console.error("contains_profanity rpc error", error);
    // Fail closed: if we can't verify, block the submission.
    return { error: "Content could not be validated. Please try again." };
  }

  if (data === true) {
    return { error: "Your submission contains profanity. Please remove it and try again." };
  }

  return { ok: true };
}
