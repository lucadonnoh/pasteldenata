import assert from "node:assert/strict";
import test from "node:test";
import { runAuctions } from "../src/auction";
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
