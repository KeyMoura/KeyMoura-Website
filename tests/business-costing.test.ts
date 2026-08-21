import assert from "node:assert/strict";
import test from "node:test";
import { calculateProductCost } from "../src/lib/business/costing.ts";

test("product costing includes waste, production, and additional costs", () => {
  const result = calculateProductCost({ materials: [{ quantity: 2, unitCostCents: 1000, wastePercent: 10 }], cncMinutes: 30,
    manualLaborMinutes: 30, finishingMinutes: 30, machineHourlyRateCents: 4000, laborHourlyRateCents: 3000,
    additionalCostsCents: [100, 200], sellingPriceCents: 8999 });
  assert.deepEqual(result, { materialCostCents: 2200, productionCostCents: 5000, additionalCostCents: 300,
    totalCostCents: 7500, sellingPriceCents: 8999, grossProfitCents: 1499, grossMarginPercent: 16.7 });
});

test("product costing rejects untrusted negative values", () => assert.throws(() => calculateProductCost({ materials: [], cncMinutes: -1,
  manualLaborMinutes: 0, finishingMinutes: 0, machineHourlyRateCents: 0, laborHourlyRateCents: 0, additionalCostsCents: [], sellingPriceCents: 0 })));
