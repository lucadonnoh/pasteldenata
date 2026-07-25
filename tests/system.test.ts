import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import {
  MOCK_SELLERS,
  publicCatalogForPlanner,
  sellersForLocation,
} from "../src/catalog";
import type { IndependentTeeVerification } from "../src/domain";
import {
  enforcePlan,
  requireVerifiedPrivateTee,
  VerifiedUnknownCityError,
  ZeroGPrivatePlanner,
} from "../src/planner";
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

function modelPlanResponseForLocation(
  location: string,
  scheduledFor: string,
): Record<string, unknown> {
  return modelPlanResponse({
    choices: [
      {
        message: {
          content: JSON.stringify({
            occasionTitle: `Private date in ${location}`,
            location,
            scheduledFor,
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
  });
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

test("the planner catalog omits seller-private auction inputs", () => {
  const serialized = JSON.stringify(publicCatalogForPlanner());

  assert.equal(serialized.includes("floorPriceCents"), false);
  assert.equal(serialized.includes("marketHeat"), false);
  assert.equal(serialized.includes("privateSalt"), false);
});

test("seller rosters follow the plan location", () => {
  const milan = sellersForLocation("Milan, Italy");
  assert.ok(milan.length > 0);
  assert.ok(milan.every((seller) => seller.city === "milan"));
  assert.ok(milan.some((seller) => seller.id === "san-siro"));
  assert.ok(
    sellersForLocation("Lisbon").every(
      (seller) => seller.city === "lisbon",
    ),
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

test("a small planner overshoot is repaired without underfunding a category", () => {
  const plan = enforcePlan(
    {
      occasionTitle: "Tokyo evening",
      location: "Tokyo",
      scheduledFor: "2026-07-26",
      allocations: [
        {
          category: "dinner",
          maxBudgetCents: 13_000,
          requirements: ["fancy"],
          priority: 5,
        },
        {
          category: "experience",
          maxBudgetCents: 6_500,
          requirements: ["baseball"],
          priority: 4,
        },
        {
          category: "transport",
          maxBudgetCents: 1_200,
          requirements: ["port"],
          priority: 3,
        },
      ],
    },
    20_000,
    "2026-07-26",
    "tokyo test intent",
  );

  assert.equal(
    plan.allocations.reduce(
      (sum, allocation) => sum + allocation.maxBudgetCents,
      0,
    ) + plan.unallocatedBudgetCents,
    20_000,
  );
  for (const allocation of plan.allocations) {
    const floor = Math.min(
      ...sellersForLocation(plan.location)
        .filter((seller) => seller.category === allocation.category)
        .flatMap((seller) =>
          seller.inventory.map((item) => item.floorPriceCents),
        ),
    );
    assert.ok(allocation.maxBudgetCents >= floor);
  }
});

test("a pathological planner overshoot is rejected", () => {
  assert.throws(
    () =>
      enforcePlan(
        {
          occasionTitle: "Bad plan",
          location: "Lisbon",
          scheduledFor: "2026-07-26",
          allocations: [
            {
              category: "dinner",
              maxBudgetCents: 50_000,
              requirements: ["dinner"],
              priority: 5,
            },
          ],
        },
        20_000,
        "2026-07-26",
        "bad test intent",
      ),
    /exceeded the hard budget/,
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

test("the 0G planner enforces tomorrow in the selected market", async () => {
  const result = await new ZeroGPrivatePlanner(
    "sk-test-key",
    "https://router-api.0g.ai/v1",
    "0gm-1.0-35b-a3b",
    {
      verify: async () => independentVerification(),
    },
    mockPrivateClient(
      modelPlanResponseForLocation("Tokyo", "2026-07-27"),
    ),
  ).plan(
    "Organize me a date tomorrow in Tokyo. My budget is $200.",
    new Date("2026-07-25T22:30:00Z"),
  );

  assert.equal(result.plan.location, "Tokyo");
  assert.equal(result.plan.scheduledFor, "2026-07-27");
});

test("an unsupported market retains its verified 0G receipt", async () => {
  await assert.rejects(
    new ZeroGPrivatePlanner(
      "sk-test-key",
      "https://router-api.0g.ai/v1",
      "0gm-1.0-35b-a3b",
      {
        verify: async () => independentVerification(),
      },
      mockPrivateClient(
        modelPlanResponseForLocation("Barcelona", "2026-07-25"),
      ),
    ).plan(
      "Organize me a date tomorrow in Barcelona. My budget is $200.",
      NOW,
    ),
    (error: unknown) => {
      assert.ok(error instanceof VerifiedUnknownCityError);
      assert.equal(error.location, "Barcelona");
      assert.equal(error.attestation.teeVerified, true);
      assert.equal(
        error.attestation.independentVerification?.signatureVerified,
        true,
      );
      assert.equal(error.attestation.routerTrace?.request_id, "request-1");
      assert.equal(error.attestation.costNeuron, "30");
      return true;
    },
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
