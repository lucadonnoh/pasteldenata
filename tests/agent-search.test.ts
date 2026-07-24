import assert from "node:assert/strict";
import test from "node:test";

import { organizePrivatePurchase } from "../src/orchestrator";
import {
  createMockAgentSearches,
  mockSellerAgentWallet,
} from "../src/mock-agent-search";
import { MockPrivatePlanner } from "../src/planner";

const NOW = new Date("2026-07-24T12:00:00Z");
const INTENT =
  "Organize me a date tomorrow in Lisbon. My budget is $200.";

test("one isolated mock wallet is created for every allocation", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );
  const searches = createMockAgentSearches(result);

  assert.equal(searches.length, result.plan.allocations.length);
  assert.equal(
    new Set(searches.map((search) => search.wallet)).size,
    searches.length,
  );

  for (const search of searches) {
    assert.match(search.wallet, /^0x[a-f0-9]{40}$/);
    assert.equal(search.auction.category, search.allocation.category);
    assert.ok(
      search.auction.winner.amountCents <=
        search.allocation.maxBudgetCents,
    );
  }
});

test("mock agent wallets are stable for the same private plan", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );

  assert.deepEqual(
    createMockAgentSearches(result).map((search) => search.wallet),
    createMockAgentSearches(result).map((search) => search.wallet),
  );
});

test("each mocked seller agent has a stable bidding wallet", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );
  const sellerIds = result.auctions.flatMap((auction) =>
    auction.bids.map((bid) => bid.sellerId),
  );
  const wallets = sellerIds.map(mockSellerAgentWallet);

  assert.equal(new Set(wallets).size, sellerIds.length);
  assert.ok(wallets.every((wallet) => /^0x[a-f0-9]{40}$/.test(wallet)));
  assert.deepEqual(wallets, sellerIds.map(mockSellerAgentWallet));
});
