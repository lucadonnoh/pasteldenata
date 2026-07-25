import { MOCK_SELLERS } from "./catalog";
import type { Category, PlanAllocation, PrivatePlan } from "./domain";

interface WorkingAllocation {
  allocation: PlanAllocation;
  floorCents: number;
  originalIndex: number;
}

export function minimumCatalogListPriceCents(
  category: Category,
): number {
  const prices = MOCK_SELLERS.filter(
    (seller) => seller.category === category,
  ).flatMap((seller) =>
    seller.inventory.map((item) => item.estimatedMarketPriceCents),
  );

  if (prices.length === 0) {
    throw new Error(`No public catalog offers for ${category}.`);
  }

  return Math.min(...prices);
}

function floorTotal(allocations: WorkingAllocation[]): number {
  return allocations.reduce(
    (total, item) => total + item.floorCents,
    0,
  );
}

/**
 * Keeps the model's category choices and priorities while guaranteeing that
 * every mock auction has at least one publicly priced offer inside its
 * mandate. No private seller floor is exposed to the planner.
 */
export function normalizePlanForMockMarket(
  plan: PrivatePlan,
): PrivatePlan {
  let working: WorkingAllocation[] = plan.allocations.map(
    (allocation, originalIndex) => ({
      allocation: {
        ...allocation,
        requirements: [...allocation.requirements],
      },
      floorCents: minimumCatalogListPriceCents(allocation.category),
      originalIndex,
    }),
  );

  while (
    working.length > 1 &&
    floorTotal(working) > plan.totalBudgetCents
  ) {
    const removable = [...working].sort(
      (left, right) =>
        left.allocation.priority - right.allocation.priority ||
        right.floorCents - left.floorCents ||
        right.originalIndex - left.originalIndex,
    )[0];

    if (!removable) break;
    working = working.filter((item) => item !== removable);
  }

  const requiredMinimum = floorTotal(working);
  if (requiredMinimum > plan.totalBudgetCents) {
    throw new Error(
      "The budget is below the cheapest available market offer.",
    );
  }

  const normalized = working.map((item) => ({
    ...item,
    allocation: {
      ...item.allocation,
      maxBudgetCents: Math.max(
        item.allocation.maxBudgetCents,
        item.floorCents,
      ),
    },
  }));
  let excess =
    normalized.reduce(
      (total, item) => total + item.allocation.maxBudgetCents,
      0,
    ) - plan.totalBudgetCents;

  for (const item of [...normalized].sort(
    (left, right) =>
      left.allocation.priority - right.allocation.priority ||
      right.allocation.maxBudgetCents -
        left.allocation.maxBudgetCents,
  )) {
    if (excess <= 0) break;

    const reducible =
      item.allocation.maxBudgetCents - item.floorCents;
    const reduction = Math.min(reducible, excess);
    item.allocation.maxBudgetCents -= reduction;
    excess -= reduction;
  }

  if (excess > 0) {
    throw new Error(
      "The market could not fit the plan inside its hard budget.",
    );
  }

  const allocations = normalized
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((item) => item.allocation);
  const allocatedBudgetCents = allocations.reduce(
    (total, allocation) => total + allocation.maxBudgetCents,
    0,
  );

  return {
    ...plan,
    allocations,
    unallocatedBudgetCents:
      plan.totalBudgetCents - allocatedBudgetCents,
  };
}
