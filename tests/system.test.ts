import assert from "node:assert/strict";
import test from "node:test";
import { runAuctions } from "../src/auction.js";
import type { AuctionResult, SellerAuctionView } from "../src/domain.js";
import { organizePrivatePurchase } from "../src/orchestrator.js";
import { nextBid } from "../src/hedera/liveAuction.js";
import { settleMockPayments, validateSettlement } from "../src/payments.js";
import { MOCK_SELLERS } from "../src/catalog.js";
import { MockPrivatePlanner } from "../src/planner.js";

const NOW = new Date("2026-07-24T12:00:00Z");
const INTENT =
  "Organize me a date tomorrow in Lisbon. My budget is $200.";

test("the complete purchase stays below the user's hard cap", async () => {
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

test("mock sellers never receive the full prompt or any budget", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const observedViews: SellerAuctionView[] = [];

  await runAuctions(plan, undefined, (view) => observedViews.push(view));

  assert.equal(observedViews.length, plan.allocations.length);
  for (const view of observedViews) {
    const serialized = JSON.stringify(view).toLowerCase();
    assert.equal(serialized.includes("budget"), false);
    assert.equal(serialized.includes("200"), false);
    assert.equal(serialized.includes(INTENT.toLowerCase()), false);
    assert.deepEqual(Object.keys(view).sort(), [
      "auctionId",
      "category",
      "location",
      "requirements",
      "scheduledFor",
    ]);
  }
});

test("sealed bid reveals match their commitments", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);

  for (const auction of auctions) {
    assert.equal(auction.commitments.length, auction.bids.length);
    assert.ok(auction.commitments.every((value) => /^[a-f0-9]{64}$/.test(value)));
  }
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

test("live bidding enters at list, concedes under pressure, floors at reserve", () => {
  const seller = MOCK_SELLERS.find((item) => item.id === "prado");
  assert.ok(seller);

  // No own bid yet: enter at list price.
  assert.equal(nextBid(seller, new Map(), undefined), seller.listPriceCents);

  // Rival leads: undercut below the leader, never below reserve.
  const pressured = new Map([
    [seller.id, { amountCents: seller.listPriceCents }],
    ["taberna-lx", { amountCents: 10000 }],
  ]);
  const undercut = nextBid(seller, pressured, 10000);
  assert.ok(undercut !== undefined && undercut < 10000);
  assert.ok(undercut >= seller.reservePriceCents);

  // Leader below my reserve: still concede toward my own reserve.
  const outpriced = new Map([
    [seller.id, { amountCents: seller.listPriceCents }],
    ["taberna-lx", { amountCents: seller.reservePriceCents - 100 }],
  ]);
  const concession = nextBid(seller, outpriced, seller.reservePriceCents - 100);
  assert.ok(concession !== undefined && concession < seller.listPriceCents);
  assert.ok(concession >= seller.reservePriceCents);

  // Already at reserve and outpriced: hold, never breach the reserve.
  const atReserve = new Map([
    [seller.id, { amountCents: seller.reservePriceCents }],
    ["taberna-lx", { amountCents: seller.reservePriceCents - 100 }],
  ]);
  assert.equal(
    nextBid(seller, atReserve, seller.reservePriceCents - 100),
    undefined,
  );

  // Already leading on price: hold.
  const leading = new Map([[seller.id, { amountCents: 9500 }]]);
  assert.equal(nextBid(seller, leading, 9500), undefined);
});

test("payment policy rejects a global budget overspend", async () => {
  const { plan } = await new MockPrivatePlanner().plan(INTENT, NOW);
  const auctions = await runAuctions(plan);
  const tampered = structuredClone(plan);
  tampered.totalBudgetCents = 1;

  assert.throws(
    () => validateSettlement(tampered, auctions),
    /exceed the global budget/,
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
