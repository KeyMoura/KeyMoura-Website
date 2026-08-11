import type { ProductOptionGroup } from "@/lib/commerceTypes";

export type ChoicePresentation = "dropdown" | "buttons" | "swatches";

/** Keeps the existing input_type/display_style columns as the single source of truth. */
export function choicePresentation(group: Pick<ProductOptionGroup, "input_type" | "display_style">): ChoicePresentation {
  if (group.display_style === "swatches") return "swatches";
  return group.input_type === "select" ? "dropdown" : "buttons";
}

export function presentationPatch(presentation: ChoicePresentation): Pick<ProductOptionGroup, "input_type" | "display_style"> {
  if (presentation === "dropdown") return { input_type: "select", display_style: "buttons" };
  if (presentation === "swatches") return { input_type: "radio", display_style: "swatches" };
  return { input_type: "radio", display_style: "buttons" };
}
