import assert from "node:assert/strict";
import test from "node:test";

import { organizePrivatePurchase } from "../src/orchestrator";
import {
  createMockAgentSearches,
  createMockAuctionReplays,
} from "../src/mock-agent-search";
import { MockPrivatePlanner } from "../src/planner";

const NOW = new Date("2026-07-24T12:00:00Z");
const INTENT =
  "Organize me a date tomorrow in Lisbon. My budget is $200.";

test("one isolated mock buyer identity is created for every allocation", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );
  const searches = createMockAgentSearches(result);

  assert.equal(searches.length, result.plan.allocations.length);
  assert.equal(
    new Set(searches.map((search) => search.agentId)).size,
    searches.length,
  );

  for (const search of searches) {
    assert.match(search.agentId, /^buyer_[a-z]+_[a-f0-9]{12}$/);
    assert.equal(search.agentId, search.auction.buyerSubagent.id);
    assert.equal(search.auction.category, search.allocation.category);
    assert.ok(search.auction.listingAuctions.length > 0);
    assert.ok(
      search.auction.winner.amountCents <=
        search.allocation.maxBudgetCents,
    );
  }
});

test("mock buyer identities are stable for the same private plan", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );

  assert.deepEqual(
    createMockAgentSearches(result).map((search) => search.agentId),
    createMockAgentSearches(result).map((search) => search.agentId),
  );
});

test("the UI replay is a lossless view of executed English-auction traces", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );
  const planBeforeReplay = structuredClone(result.plan);
  const searches = createMockAgentSearches(result);
  const replays = createMockAuctionReplays(searches);
  const executedListingAuctions = result.auctions.flatMap(
    (auction) => auction.listingAuctions,
  );

  assert.equal(replays.length, executedListingAuctions.length);
  assert.deepEqual(
    replays.map((replay) => replay.listingAuction),
    executedListingAuctions,
  );
  assert.deepEqual(result.plan, planBeforeReplay);

  for (const replay of replays) {
    assert.equal(
      replay.search.agentId,
      replay.listingAuction.buyerSubagentId,
    );
    assert.doesNotMatch(replay.search.agentId, /^0x/i);
  }
});
