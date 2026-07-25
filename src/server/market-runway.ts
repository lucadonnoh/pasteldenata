import { CATEGORIES } from "../domain";

export const ACCOUNT_CREATION_HBAR = 1.5;
export const MARKET_LEAF_FLOAT_HBAR = 5;
export const RUN_MARGIN_HBAR = 6;

// Four deterministic rival buyers run five scoped agents: four verified
// contenders plus one deliberately unverified protected-market fixture.
// The extra verified cinema bidder creates real counter-bids in judge runs.
export const DEMO_RIVAL_ALLOCATIONS = 5;
export const MAX_USER_ALLOCATIONS = CATEGORIES.length;
export const MAX_MARKET_LEAF_COUNT =
  DEMO_RIVAL_ALLOCATIONS + MAX_USER_ALLOCATIONS;

// A destination has at most thirteen mocked sellers. On a first run each may
// need a one-HBAR fee top-up; token/account provisioning gets a separate
// bounded margin. These costs are conservative and mostly reusable.
export const MAX_SELLER_TOPUPS_HBAR = 13;
export const FIRST_RUN_PROVISIONING_MARGIN_HBAR = 10;

export function marketAgentRunwayHbar(leafCount: number): number {
  if (!Number.isSafeInteger(leafCount) || leafCount < 1) {
    throw new Error("Market leaf count must be a positive safe integer.");
  }
  return Math.ceil(
    leafCount * (ACCOUNT_CREATION_HBAR + MARKET_LEAF_FLOAT_HBAR) +
      RUN_MARGIN_HBAR,
  );
}

export const HOMEPAGE_REQUIRED_HBAR =
  marketAgentRunwayHbar(MAX_MARKET_LEAF_COUNT) +
  MAX_SELLER_TOPUPS_HBAR +
  FIRST_RUN_PROVISIONING_MARGIN_HBAR;
