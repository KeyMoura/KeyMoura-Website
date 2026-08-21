export type CostMaterial = { quantity: number; unitCostCents: number; wastePercent: number };
export type CostProfileInput = {
  materials: CostMaterial[];
  cncMinutes: number; manualLaborMinutes: number; finishingMinutes: number;
  machineHourlyRateCents: number; laborHourlyRateCents: number;
  additionalCostsCents: number[]; sellingPriceCents: number;
};

const finiteNonNegative = (value: number, label: string) => {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number.`);
  return value;
};

/** Canonical costing formula shared by API routes and reports. All outputs are integer cents. */
export function calculateProductCost(input: CostProfileInput) {
  const materialCostCents = Math.round(input.materials.reduce((sum, row) => {
    const quantity = finiteNonNegative(row.quantity, "Material quantity");
    const unitCost = finiteNonNegative(row.unitCostCents, "Material unit cost");
    const waste = finiteNonNegative(row.wastePercent, "Waste percentage");
    if (waste > 1000) throw new Error("Waste percentage cannot exceed 1000%.");
    return sum + quantity * unitCost * (1 + waste / 100);
  }, 0));
  const productionCostCents = Math.round(
    finiteNonNegative(input.cncMinutes, "CNC minutes") * finiteNonNegative(input.machineHourlyRateCents, "Machine rate") / 60 +
    (finiteNonNegative(input.manualLaborMinutes, "Labor minutes") + finiteNonNegative(input.finishingMinutes, "Finishing minutes")) *
      finiteNonNegative(input.laborHourlyRateCents, "Labor rate") / 60
  );
  const additionalCostCents = Math.round(input.additionalCostsCents.reduce((sum, value) => sum + finiteNonNegative(value, "Additional cost"), 0));
  const totalCostCents = materialCostCents + productionCostCents + additionalCostCents;
  const sellingPriceCents = Math.round(finiteNonNegative(input.sellingPriceCents, "Selling price"));
  const grossProfitCents = sellingPriceCents - totalCostCents;
  return { materialCostCents, productionCostCents, additionalCostCents, totalCostCents, sellingPriceCents, grossProfitCents,
    grossMarginPercent: sellingPriceCents > 0 ? Math.round((grossProfitCents / sellingPriceCents) * 1000) / 10 : null };
}

