import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { runAuctions } from "../src/auction";
import type { EnglishAuctionBidder } from "../src/buyer-agent";
import {
  MOCK_SELLERS,
  publicCatalogForPlanner,
  sellersForLocation,
} from "../src/catalog";
import type {
  AuctionResult,
  IndependentTeeVerification,
  SellerAuctionView,
} from "../src/domain";
import {
  organizePrivatePurchase,
  organizeVerifiedPrivatePurchase,
} from "../src/orchestrator";
import { settleMockPayments } from "../src/payments";
import {
  MockPrivatePlanner,
  requireVerifiedPrivateTee,
  resolveProofChatId,
  ZeroGPrivatePlanner,
} from "../src/planner";
import { createMockSellerAuctionHouses } from "../src/sellers";
import {
  type IndependentTeeVerificationInput,
  verifyEip191Signature,
} from "../src/tee-verifier";
import type {
  ZeroGPrivateCompletion,
  ZeroGPrivateCompletionClient,
} from "../src/zerog-private";

const NOW = new Date("2026-07-24T12:00:00Z");
const INTENT =
  "Organize me a date tomorrow in Lisbon. My budget is $200.";
const TEST_PROVIDER = "0x0000000000000000000000000000000000000001";
const TEST_SIGNER = "0x0000000000000000000000000000000000000002";

function independentVerification(
  overrides: Partial<IndependentTeeVerification> = {},
): IndependentTeeVerification {
  return {
    verified: true,
    method: "onchain-signer-eip191",
    chainId: 16661,
    rpcUrl: "https://evmrpc.0g.ai",
    serviceContract: "0x0000000000000000000000000000000000000003",
    provider: TEST_PROVIDER,
    chatId: "chat-header-id",
    serviceUrl: "https://provider.example",
    serviceModel: "0gm-test",
    verifiability: "TeeML",
    signingAddress: TEST_SIGNER,
    recoveredAddress: TEST_SIGNER,
    signatureEndpoint:
      "https://provider.example/v1/proxy/signature/chat-header-id?model=0gm-test",
    signedPayload: `${"aa".repeat(32)}:${"bb".repeat(32)}`,
    signature: `0x${"11".repeat(65)}`,
    messageHash: `0x${"22".repeat(32)}`,
    signatureVerified: true,
    signedRequestHash: "aa".repeat(32),
    signedResponseHash: "bb".repeat(32),
    ...overrides,
  };
}

function modelPlanResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "chatcmpl-chat-header-id",
    model: "0gm-1.0-35b-a3b",
    x_0g_trace: {
      request_id: "request-1",
      provider: TEST_PROVIDER,
      billing: {
        input_cost: "10",
        output_cost: "20",
        total_cost: "30",
      },
      tee_verified: true,
    },
    choices: [
      {
        message: {
          content: JSON.stringify({
            occasionTitle: "Private date",
            location: "Lisbon",
            scheduledFor: "2026-07-25",
            allocations: [
              {
                category: "dinner",
                maxBudgetCents: 10_000,
                requirements: ["table for two"],
                priority: 5,
              },
            ],
          }),
        },
      },
    ],
    ...overrides,
  };
}

function mockPrivateClient(
  response: Record<string, unknown> = modelPlanResponse(),
): ZeroGPrivateCompletionClient {
  return {
    complete: async (): Promise<ZeroGPrivateCompletion> => ({
      response,
      responseText: JSON.stringify(response),
      chatId: "chat-header-id",
    }),
  };
}

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

test("mock seller rosters follow the plan location", async () => {
  const milan = sellersForLocation("Milan, Italy");
  assert.ok(milan.length > 0);
  assert.ok(milan.every((seller) => seller.city === "milan"));
  assert.ok(milan.some((seller) => seller.id === "san-siro"));
  assert.ok(
    sellersForLocation("Lisbon").every(
      (seller) => seller.city === "lisbon",
    ),
  );

  const base = await new MockPrivatePlanner().plan(INTENT, NOW);
  const plan = {
    ...base.plan,
    location: "Milan",
    allocations: base.plan.allocations.filter(
      (allocation) => allocation.category === "dinner",
    ),
  };
  plan.unallocatedBudgetCents =
    plan.totalBudgetCents -
    plan.allocations.reduce(
      (sum, allocation) => sum + allocation.maxBudgetCents,
      0,
    );
  const [auction] = await runAuctions(plan);
  assert.ok(auction);
  assert.ok(
    milan.some((seller) => seller.id === auction.winner.sellerId),
  );
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
    /Router and independent TEE signature verification/,
  );
  assert.throws(
    () =>
      requireVerifiedPrivateTee({
        mode: "0g-private-tee",
        teeVerified: true,
        model: "0gm-1.0-35b-a3b",
      }),
    /Router and independent TEE signature verification/,
  );
  assert.doesNotThrow(() =>
    requireVerifiedPrivateTee({
      mode: "0g-private-tee",
      teeVerified: true,
      model: "0gm-1.0-35b-a3b",
      routerTrace: {
        request_id: "request-1",
        provider: TEST_PROVIDER,
        tee_verified: true,
      },
      independentVerification: independentVerification(),
    }),
  );
});

test("proof lookup derives ZG-Res-Key from the OpenAI response ID", () => {
  assert.equal(
    resolveProofChatId(
      new Response(null),
      "chatcmpl-5606b697-425d-4fd4-ab7d-85cb0e79a8f9",
    ),
    "5606b697-425d-4fd4-ab7d-85cb0e79a8f9",
  );
  assert.equal(
    resolveProofChatId(
      new Response(null, {
        headers: { "ZG-Res-Key": "header-proof-key" },
      }),
      "chatcmpl-body-proof-key",
    ),
    "header-proof-key",
  );
});

test("the verified browser orchestrator rejects the mock before auctions", async () => {
  await assert.rejects(
    organizeVerifiedPrivatePurchase(new MockPrivatePlanner(), INTENT, NOW),
    /Router and independent TEE signature verification/,
  );
});

test("the 0G planner rejects a generic top-level TEE claim", async () => {
  const response = modelPlanResponse({
    x_0g_trace: undefined,
    tee_verified: true,
  });
  await assert.rejects(
    new ZeroGPrivatePlanner(
      "sk-test-key",
      "https://router-api.0g.ai/v1",
      "0gm-1.0-35b-a3b",
      {
        verify: async () => independentVerification(),
      },
      mockPrivateClient(response),
    ).plan(INTENT, NOW),
    /without x_0g_trace\.tee_verified = true/,
  );
});

test("the 0G planner retains the exact verified Router trace", async () => {
  const verificationInputs: IndependentTeeVerificationInput[] = [];
  const verifier = {
    verify: async (input: IndependentTeeVerificationInput) => {
      verificationInputs.push(input);
      return independentVerification({
        provider: input.provider,
        chatId: input.chatId,
      });
    },
  };
  const result = await new ZeroGPrivatePlanner(
    "sk-test-key",
    "https://router-api.0g.ai/v1",
    "0gm-1.0-35b-a3b",
    verifier,
    mockPrivateClient(),
  ).plan(INTENT, NOW);
  assert.deepEqual(result.attestation.routerTrace, {
    request_id: "request-1",
    provider: TEST_PROVIDER,
    billing: {
      input_cost: "10",
      output_cost: "20",
      total_cost: "30",
    },
    tee_verified: true,
  });
  assert.equal(result.attestation.chatId, "chat-header-id");
  assert.equal(verificationInputs.length, 1);
  assert.equal(verificationInputs[0]?.provider, TEST_PROVIDER);
  assert.equal(verificationInputs[0]?.chatId, "chat-header-id");
  assert.equal(
    result.attestation.independentVerification?.verified,
    true,
  );
});

test("the 0G planner rejects a response when independent verification fails", async () => {
  const verifier = {
    verify: async () => {
      throw new Error(
        "Independent TEE verification failed: bad signature.",
      );
    },
  };

  await assert.rejects(
    new ZeroGPrivatePlanner(
      "sk-test-key",
      "https://router-api.0g.ai/v1",
      "0gm-1.0-35b-a3b",
      verifier,
      mockPrivateClient(),
    ).plan(INTENT, NOW),
    /Independent TEE verification failed: bad signature/,
  );
});

test("independent verification validates the EIP-191 proof signer", async () => {
  const wallet = Wallet.createRandom();
  const signedPayload = `${"aa".repeat(32)}:${"bb".repeat(32)}`;
  const signature = await wallet.signMessage(signedPayload);

  assert.deepEqual(
    verifyEip191Signature({
      signedText: signedPayload,
      signature,
      signingAddress: wallet.address,
    }).recoveredAddress,
    wallet.address,
  );
  assert.throws(
    () =>
      verifyEip191Signature({
        signedText: signedPayload,
        signature,
        signingAddress: Wallet.createRandom().address,
      }),
    /does not recover/,
  );
});
