import assert from "node:assert/strict";
import test from "node:test";
import { runAuctions } from "../src/auction";
import type { EnglishAuctionBidder } from "../src/buyer-agent";
import { MOCK_SELLERS, publicCatalogForPlanner } from "../src/catalog";
import type { AuctionResult, SellerAuctionView } from "../src/domain";
import {
  organizePrivatePurchase,
  organizeVerifiedPrivatePurchase,
} from "../src/orchestrator";
import { settleMockPayments } from "../src/payments";
import {
  MockPrivatePlanner,
  requireVerifiedPrivateTee,
} from "../src/planner";
import { createMockSellerAuctionHouses } from "../src/sellers";

const NOW = new Date("2026-07-24T12:00:00Z");
const INTENT =
  "Organize me a date tomorrow in Lisbon. My budget is $200.";

function strongBuyer(id = "test-buyer"): EnglishAuctionBidder {
  return {
    id,
    kind: "allocation-buyer-subagent",
    debugMaxBidCents: 10_000,
    willBid: (askingPriceCents) => askingPriceCents <= 10_000,
  };
}

test("each allocation becomes exactly one scoped buyer subagent", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );

  assert.equal(result.auctions.length, result.plan.allocations.length);
  for (const allocation of result.plan.allocations) {
    const auction = result.auctions.find(
      (candidate) => candidate.category === allocation.category,
    );
    assert.ok(auction);
    assert.equal(auction.buyerSubagent.category, allocation.category);
    assert.equal(
      auction.buyerSubagent.mandateId,
      auction.mandate.id,
    );
    assert.deepEqual(
      auction.buyerSubagent.requirements,
      allocation.requirements,
    );
    assert.equal(
      auction.buyerSubagent.strategy,
      "fit-adjusted-private-valuation",
    );
  }
});

test("the complete purchase stays below every scoped and global cap", async () => {
  const result = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    INTENT,
    NOW,
  );

  assert.ok(result.totalSpentCents <= result.plan.totalBudgetCents);
  assert.equal(result.receipts.length, result.plan.allocations.length);
  assert.ok(
    result.auctions.every(
      (auction) =>
        auction.winner.amountCents <= auction.mandate.maxAmountCents,
    ),
  );
});

test("mock auction houses never receive the prompt or any budget", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const observedViews: SellerAuctionView[] = [];

  await runAuctions(plan, undefined, (view) => observedViews.push(view));

  assert.ok(observedViews.length >= plan.allocations.length);
  for (const view of observedViews) {
    const serialized = JSON.stringify(view).toLowerCase();
    assert.equal(serialized.includes("budget"), false);
    assert.equal(serialized.includes("200"), false);
    assert.equal(serialized.includes(INTENT.toLowerCase()), false);
    assert.deepEqual(Object.keys(view).sort(), [
      "auctionId",
      "category",
      "listingId",
      "location",
      "requirements",
      "scheduledFor",
    ]);
  }
});

test("every listing auction is openly ascending", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);

  for (const auction of auctions) {
    for (const listingAuction of auction.listingAuctions) {
      const { steps } = listingAuction;
      if (listingAuction.status === "floor-not-met") {
        assert.equal(steps.length, 0);
        continue;
      }

      assert.ok(steps.length > 0);
      assert.equal(
        steps[0]?.askingPriceCents,
        listingAuction.debugSellerFloorPriceCents,
      );
      assert.equal(
        steps.at(-1)?.askingPriceCents,
        listingAuction.clearingPriceCents,
      );

      for (let index = 1; index < steps.length; index += 1) {
        const previous = steps[index - 1];
        const current = steps[index];
        assert.ok(previous);
        assert.ok(current);
        assert.equal(
          current.askingPriceCents - previous.askingPriceCents,
          listingAuction.minimumIncrementCents,
        );
        assert.ok(
          current.activeBidderIds.every((bidderId) =>
            previous.activeBidderIds.includes(bidderId),
          ),
        );
      }
    }
  }
});

test("buyer subagents drop before an asking price exceeds their valuation", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);

  for (const auction of auctions) {
    for (const listingAuction of auction.listingAuctions) {
      for (const step of listingAuction.steps) {
        if (
          step.activeBidderIds.includes(
            listingAuction.buyerSubagentId,
          )
        ) {
          assert.ok(
            step.askingPriceCents <= listingAuction.buyerMaxBidCents,
          );
          assert.ok(
            step.askingPriceCents <= auction.mandate.maxAmountCents,
          );
        }
      }
    }
  }
});

test("the planner catalog omits seller-private auction inputs", () => {
  const serialized = JSON.stringify(publicCatalogForPlanner());

  assert.equal(serialized.includes("floorPriceCents"), false);
  assert.equal(serialized.includes("marketHeat"), false);
  assert.equal(serialized.includes("privateSalt"), false);
});

test("central cinema seats have higher floors and market estimates", () => {
  const cinemaIdeal = MOCK_SELLERS.find(
    (seller) => seller.id === "cinema-ideal",
  );
  assert.ok(cinemaIdeal);
  const central = cinemaIdeal.inventory.find(
    (item) => item.id === "ideal-d7-d8",
  );
  const side = cinemaIdeal.inventory.find(
    (item) => item.id === "ideal-b1-b2",
  );
  assert.ok(central);
  assert.ok(side);

  assert.ok(central.floorPriceCents > side.floorPriceCents);
  assert.ok(
    central.estimatedMarketPriceCents > side.estimatedMarketPriceCents,
  );
  assert.ok(central.marketHeat > side.marketHeat);
});

test("central seats clear above side seats under the same strong buyer", () => {
  const cinemaIdeal = createMockSellerAuctionHouses().find(
    (seller) => seller.id === "cinema-ideal",
  );
  assert.ok(cinemaIdeal);
  const baseView = {
    category: "cinema" as const,
    location: "Lisbon",
    scheduledFor: "2026-07-25",
    requirements: ["two seats", "evening"],
  };

  const central = cinemaIdeal.openEnglishAuction(
    {
      ...baseView,
      auctionId: "test-central",
      listingId: "ideal-d7-d8",
    },
    strongBuyer(),
  );
  const side = cinemaIdeal.openEnglishAuction(
    {
      ...baseView,
      auctionId: "test-side",
      listingId: "ideal-b1-b2",
    },
    strongBuyer(),
  );

  assert.equal(central.status, "won");
  assert.equal(side.status, "won");
  assert.ok(central.clearingPriceCents);
  assert.ok(side.clearingPriceCents);
  assert.ok(central.clearingPriceCents > side.clearingPriceCents);
});

test("a mock auction house cannot sell the same seat bundle twice", () => {
  const cinemaIdeal = createMockSellerAuctionHouses().find(
    (seller) => seller.id === "cinema-ideal",
  );
  assert.ok(cinemaIdeal);
  const view: SellerAuctionView = {
    auctionId: "first-sale",
    listingId: "ideal-d7-d8",
    category: "cinema",
    location: "Lisbon",
    scheduledFor: "2026-07-25",
    requirements: ["two seats"],
  };

  const first = cinemaIdeal.openEnglishAuction(view, strongBuyer());
  assert.equal(first.status, "won");
  assert.throws(
    () =>
      cinemaIdeal.openEnglishAuction(
        { ...view, auctionId: "replayed-sale" },
        strongBuyer(),
      ),
    /no longer available/,
  );
});

test("payment policy rejects a category mandate overspend", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);
  const tampered = structuredClone(auctions) as AuctionResult[];
  const first = tampered[0];
  assert.ok(first);
  first.winner.amountCents = first.mandate.maxAmountCents + 1;

  assert.throws(
    () => settleMockPayments(plan, tampered),
    /exceeded its category mandate/,
  );
});

test("payment policy rejects a replayed mandate", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);
  const first = auctions[0];
  assert.ok(first);

  assert.throws(
    () => settleMockPayments(plan, [first, first]),
    /cannot be spent twice/,
  );
});

test("the browser flow accepts only an attested 0G private TEE", () => {
  assert.throws(
    () =>
      requireVerifiedPrivateTee({
        mode: "local-mock",
        teeVerified: false,
        model: "deterministic-test-planner",
      }),
    /verified private TEE/,
  );
  assert.throws(
    () =>
      requireVerifiedPrivateTee({
        mode: "0g-private-tee",
        teeVerified: false,
        model: "0gm-1.0-35b-a3b",
      }),
    /verified private TEE/,
  );
  assert.doesNotThrow(() =>
    requireVerifiedPrivateTee({
      mode: "0g-private-tee",
      teeVerified: true,
      model: "0gm-1.0-35b-a3b",
    }),
  );
});

test("the verified browser orchestrator rejects the mock before auctions", async () => {
  await assert.rejects(
    organizeVerifiedPrivatePurchase(new MockPrivatePlanner(), INTENT, NOW),
    /verified private TEE/,
  );
});
