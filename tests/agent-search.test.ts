import assert from "node:assert/strict";
import test from "node:test";

import { organizePrivatePurchase } from "../src/orchestrator";
import {
  createMockBuyerCompetition,
  createMockAgentSearches,
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

test("buyer agents raise the price while the seller offer stays fixed", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );
  const searches = createMockAgentSearches(result);

  for (const search of searches) {
    const competition = createMockBuyerCompetition(search);
    const buyerWallets = competition.bids.map((bid) => bid.wallet);
    const amounts = competition.bids.map((bid) => bid.amountCents);
    const finalBid = competition.bids.at(-1);

    assert.equal(competition.bids.length, 6);
    assert.equal(new Set(buyerWallets).size, 3);
    assert.ok(
      buyerWallets.every((wallet) => /^0x[a-f0-9]{40}$/.test(wallet)),
    );
    assert.ok(
      amounts.every(
        (amount, index) =>
          index === 0 || amount > amounts[index - 1]!,
      ),
    );
    assert.equal(finalBid?.kind, "user");
    assert.equal(finalBid?.wallet, search.wallet);
    assert.equal(finalBid?.amountCents, search.auction.winner.amountCents);
    assert.ok(
      (finalBid?.amountCents ?? Number.POSITIVE_INFINITY) <=
        search.allocation.maxBudgetCents,
    );
  }
});
