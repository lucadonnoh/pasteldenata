import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Client,
  Hbar,
  PrivateKey,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { Seller } from "../src/domain";
import {
  parsePrivateKey,
  type HederaContext,
} from "../src/hedera/client";
import {
  type HederaInfra,
  upgradeInfra,
} from "../src/hedera/infra";
import {
  ascendingRanking,
  fetchItemState,
  fetchTopicBids,
} from "../src/hedera/mirror";
import {
  fetchAllMirrorTopicMessages,
  marketBidsFromEvents,
  marketSettlementFromEvents,
  parseMarketLedgerEvents,
} from "../src/hedera/marketEvidence";
import {
  assertProtectedMarketAuthorizationConfigured,
  marketItemId,
} from "../src/hedera/market";
import {
  assertExactAtomicSwap,
  assertVerifiedMarketClaim,
  marketCloseDelayMs,
  verifiedMarketClaimState,
} from "../src/hedera/marketPolicy";
import {
  persistLeafWallet,
  readLeafWallet,
} from "../src/hedera/walletVault";
import { MockPrivatePlanner } from "../src/planner";
import { assertLocalDemoRequest } from "../src/server/local-demo-request";
import { parseSettlementRequest } from "../src/server/settlement-request";

function mirrorMessage(
  payload: Record<string, unknown>,
  payer: string,
  sequence: number,
): {
  message: string;
  payer_account_id: string;
  sequence_number: number;
  consensus_timestamp: string;
} {
  return {
    message: Buffer.from(JSON.stringify(payload)).toString("base64"),
    payer_account_id: payer,
    sequence_number: sequence,
    consensus_timestamp: `${1_700_000_000 + sequence}.000000000`,
  };
}

test("bare operator keys default to ECDSA without DER misclassification", () => {
  const ecdsa = PrivateKey.generateECDSA();
  const parsedEcdsa = parsePrivateKey(ecdsa.toStringRaw());
  assert.equal(
    parsedEcdsa.publicKey.toStringRaw(),
    ecdsa.publicKey.toStringRaw(),
  );

  const ed25519 = PrivateKey.generateED25519();
  const parsedEd25519 = parsePrivateKey(
    ed25519.toStringRaw(),
    "ED25519",
  );
  assert.equal(
    parsedEd25519.publicKey.toStringRaw(),
    ed25519.publicKey.toStringRaw(),
  );
});

test("Hedera seller provisioning checkpoints progress and resumes", async () => {
  const sellers = [
    { id: "seller-a" },
    { id: "seller-b" },
  ] as Seller[];
  const infra: HederaInfra = {
    network: "testnet",
    paymentTokenId: "0.0.1",
    claimTokenId: "0.0.2",
    buyer: { accountId: "0.0.3", privateKey: "buyer-key" },
    sellers: {},
    marketBuyers: [
      { accountId: "0.0.10", privateKey: "pool-1" },
      { accountId: "0.0.11", privateKey: "pool-2" },
      { accountId: "0.0.12", privateKey: "pool-3" },
      { accountId: "0.0.13", privateKey: "pool-4" },
    ],
  };
  const checkpoints: HederaInfra[] = [];
  let attempts = 0;

  await assert.rejects(
    upgradeInfra({} as HederaContext, infra, sellers, {
      createStoredAccount: async () => {
        attempts += 1;
        if (attempts === 2) throw new Error("testnet unavailable");
        return {
          accountId: `0.0.${100 + attempts}`,
          privateKey: `key-${attempts}`,
        };
      },
      persist: (value) => checkpoints.push(structuredClone(value)),
    }),
    /testnet unavailable/,
  );

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0]?.sellers["seller-a"]?.accountId, "0.0.101");
  assert.equal(Object.hasOwn(infra.sellers, "seller-b"), false);

  const resumedCreations: string[] = [];
  await upgradeInfra({} as HederaContext, infra, sellers, {
    createStoredAccount: async () => {
      resumedCreations.push("created");
      return { accountId: "0.0.200", privateKey: "resumed-key" };
    },
    persist: (value) => checkpoints.push(structuredClone(value)),
  });

  assert.equal(resumedCreations.length, 1);
  assert.equal(infra.sellers["seller-a"]?.accountId, "0.0.101");
  assert.equal(infra.sellers["seller-b"]?.accountId, "0.0.200");
});

async function withMirrorMessages<T>(
  messages: ReturnType<typeof mirrorMessage>[],
  action: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ messages, links: { next: null } }),
      { status: 200 },
    );
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("reverse-auction bids require valid cents and the registered seller payer", async () => {
  const valid = {
    type: "BID",
    auctionId: "auction-1",
    listingId: "seat-e6-e7",
    sellerId: "cinemateca",
    sellerName: "Cinemateca",
    offering: "Row E",
    amountCents: 2200,
    quality: 90,
    tags: ["central"],
  };
  const bids = await withMirrorMessages(
    [
      mirrorMessage(valid, "0.0.100", 1),
      mirrorMessage({ ...valid, amountCents: -100 }, "0.0.100", 2),
      mirrorMessage(valid, "0.0.attacker", 3),
      mirrorMessage({ ...valid, sellerId: "spoofed" }, "0.0.100", 4),
    ],
    () =>
      fetchTopicBids(
        "https://mirror.invalid",
        "0.0.9",
        "auction-1",
        new Map([
          [
            "seat-e6-e7",
            { sellerId: "cinemateca", accountId: "0.0.100" },
          ],
        ]),
      ),
  );

  assert.equal(bids.length, 1);
  assert.equal(bids[0]?.amountCents, 2200);
  assert.equal(bids[0]?.payerAccountId, "0.0.100");
});

test("market messages bind bidder identity to payer and settlement to clearing", async () => {
  const state = await withMirrorMessages(
    [
      mirrorMessage(
        { type: "LISTED", itemId: "item-1", floorCents: 2000 },
        "0.0.clearing",
        0,
      ),
      mirrorMessage(
        { type: "BID", itemId: "item-1", bidder: "0.0.201", amountCents: 2500 },
        "0.0.201",
        1,
      ),
      mirrorMessage(
        { type: "BID", itemId: "item-1", bidder: "0.0.201", amountCents: 9999 },
        "0.0.attacker",
        2,
      ),
      mirrorMessage(
        {
          type: "SETTLED",
          itemId: "item-1",
          bidder: "0.0.201",
          amountCents: 2500,
          transactionId: "0.0.201@1.2",
        },
        "0.0.attacker",
        3,
      ),
      mirrorMessage(
        { type: "CLOSED", itemId: "item-1" },
        "0.0.attacker",
        4,
      ),
      mirrorMessage(
        { type: "CLOSED", itemId: "item-1" },
        "0.0.clearing",
        5,
      ),
      mirrorMessage(
        {
          type: "FORFEITED",
          itemId: "item-1",
          bidder: "0.0.201",
          amountCents: 2500,
        },
        "0.0.attacker",
        6,
      ),
      mirrorMessage(
        {
          type: "FORFEITED",
          itemId: "item-1",
          bidder: "0.0.201",
          amountCents: 2500,
        },
        "0.0.clearing",
        7,
      ),
      mirrorMessage(
        { type: "BID", itemId: "item-1", bidder: "0.0.202", amountCents: 9999 },
        "0.0.202",
        8,
      ),
      mirrorMessage(
        {
          type: "SETTLED",
          itemId: "item-1",
          bidder: "0.0.201",
          amountCents: 2500,
          transactionId: "0.0.201@1.2",
        },
        "0.0.clearing",
        9,
      ),
    ],
    () =>
      fetchItemState(
        "https://mirror.invalid",
        "0.0.9",
        "item-1",
        "0.0.clearing",
      ),
  );

  assert.deepEqual(state.bids, [
    {
      bidder: "0.0.201",
      amountCents: 2500,
      sequenceNumber: 1,
      consensusTimestampMs: 1_700_000_001_000,
    },
  ]);
  assert.deepEqual(state.opening, {
    sequenceNumber: 0,
    consensusTimestampMs: 1_700_000_000_000,
  });
  assert.deepEqual(state.closure, {
    sequenceNumber: 5,
    consensusTimestampMs: 1_700_000_005_000,
  });
  assert.deepEqual(state.forfeitures, [
    {
      bidder: "0.0.201",
      amountCents: 2500,
      sequenceNumber: 7,
      consensusTimestampMs: 1_700_000_007_000,
    },
  ]);
  assert.deepEqual(state.settlement, {
    bidder: "0.0.201",
    amountCents: 2500,
    transactionId: "0.0.201@1.2",
  });
});

test("browser market evidence follows every Mirror page", async () => {
  const first = mirrorMessage(
    { type: "LISTED", itemId: "item-1" },
    "0.0.clearing",
    1,
  );
  const second = mirrorMessage(
    {
      type: "BID",
      itemId: "item-1",
      bidder: "0.0.201",
      amountCents: 2500,
    },
    "0.0.201",
    101,
  );
  const requested: string[] = [];

  const messages = await fetchAllMirrorTopicMessages(
    "https://mirror.invalid",
    "0.0.9",
    async (url) => {
      requested.push(url);
      return new Response(
        JSON.stringify(
          requested.length === 1
            ? {
                messages: [first],
                links: {
                  next:
                    "/api/v1/topics/0.0.9/messages?limit=100&order=asc&sequenceNumber=gt:100",
                },
              }
            : { messages: [second], links: { next: null } },
        ),
        { status: 200 },
      );
    },
  );

  assert.equal(requested.length, 2);
  assert.match(requested[1] ?? "", /^https:\/\/mirror\.invalid\//);
  assert.deepEqual(
    messages.map((message) => message.sequence_number),
    [1, 101],
  );
});

test("browser market evidence uses the authenticated settled bidder", () => {
  const messages = [
    mirrorMessage(
      { type: "LISTED", itemId: "item-1", floorCents: 2000 },
      "0.0.clearing",
      1,
    ),
    mirrorMessage(
      {
        type: "BID",
        itemId: "item-1",
        bidder: "0.0.202",
        amountCents: 2600,
      },
      "0.0.202",
      2,
    ),
    mirrorMessage(
      {
        type: "BID",
        itemId: "item-1",
        bidder: "0.0.201",
        amountCents: 2500,
      },
      "0.0.201",
      3,
    ),
    mirrorMessage(
      { type: "CLOSED", itemId: "item-1" },
      "0.0.attacker",
      4,
    ),
    mirrorMessage(
      { type: "CLOSED", itemId: "item-1" },
      "0.0.clearing",
      5,
    ),
    mirrorMessage(
      {
        type: "BID",
        itemId: "item-1",
        bidder: "0.0.attacker",
        amountCents: 9999,
      },
      "0.0.attacker",
      6,
    ),
    mirrorMessage(
      {
        type: "FORFEITED",
        itemId: "item-1",
        bidder: "0.0.202",
        amountCents: 2600,
      },
      "0.0.clearing",
      7,
    ),
    mirrorMessage(
      {
        type: "SETTLED",
        itemId: "item-1",
        bidder: "0.0.202",
        amountCents: 2600,
        transactionId: "0.0.202@1.1",
      },
      "0.0.attacker",
      8,
    ),
    mirrorMessage(
      {
        type: "SETTLED",
        itemId: "item-1",
        bidder: "0.0.201",
        amountCents: 2500,
        claimNftSerial: 12,
        transactionId: "0.0.201@1.2",
      },
      "0.0.clearing",
      9,
    ),
  ];

  const events = parseMarketLedgerEvents(
    messages,
    "item-1",
    "0.0.clearing",
    new Set(["0.0.201"]),
  );

  assert.deepEqual(
    events.map((event) => event.type),
    ["LISTED", "BID", "BID", "CLOSED", "FORFEITED", "SETTLED"],
  );
  assert.deepEqual(
    marketBidsFromEvents(events).map((bid) => [
      bid.bidder,
      bid.amountCents,
    ]),
    [
      ["0.0.202", 2600],
      ["0.0.201", 2500],
    ],
  );
  assert.deepEqual(marketSettlementFromEvents(events), {
    type: "SETTLED",
    sequenceNumber: 9,
    payerAccountId: "0.0.clearing",
    bidder: "0.0.201",
    amountCents: 2500,
    transactionId: "0.0.201@1.2",
    claimNftSerial: 12,
    yours: true,
  });
});

test("browser evidence accepts only clearing-authenticated World credentials pinned by LISTED", () => {
  const messages = [
    mirrorMessage(
      {
        type: "LISTED",
        itemId: "item-world",
        humanPolicy: "one-per-human",
        authorizationIssuerPublicKey: "issuer-key",
      },
      "0.0.clearing",
      1,
    ),
    mirrorMessage(
      {
        type: "AUTHORIZED",
        itemId: "item-world",
        bidder: "0.0.201",
        nullifier: "forged-payer",
        quota: 1,
        expiresAt: 1_800_000_000_000,
        issuerPublicKey: "issuer-key",
        signature: "signature",
      },
      "0.0.attacker",
      2,
    ),
    mirrorMessage(
      {
        type: "AUTHORIZED",
        itemId: "item-world",
        bidder: "0.0.201",
        nullifier: "wrong-issuer",
        quota: 1,
        expiresAt: 1_800_000_000_000,
        issuerPublicKey: "attacker-key",
        signature: "signature",
      },
      "0.0.clearing",
      3,
    ),
    mirrorMessage(
      {
        type: "AUTHORIZED",
        itemId: "item-world",
        bidder: "0.0.201",
        nullifier: "auction-nullifier",
        quota: 1,
        expiresAt: 1_800_000_000_000,
        issuerPublicKey: "issuer-key",
        signature: "signature",
      },
      "0.0.clearing",
      4,
    ),
  ];

  assert.deepEqual(
    parseMarketLedgerEvents(
      messages,
      "item-world",
      "0.0.clearing",
      new Set(["0.0.201"]),
    ),
    [
      {
        type: "LISTED",
        sequenceNumber: 1,
        payerAccountId: "0.0.clearing",
        humanPolicy: "one-per-human",
        authorizationIssuerPublicKey: "issuer-key",
      },
      {
        type: "AUTHORIZED",
        sequenceNumber: 4,
        payerAccountId: "0.0.clearing",
        bidder: "0.0.201",
        nullifier: "auction-nullifier",
        quota: 1,
        expiresAt: 1_800_000_000_000,
        issuerPublicKey: "issuer-key",
        signature: "signature",
        yours: true,
      },
    ],
  );
});

test("seller policy independently derives the winner before signing", () => {
  const open = {
    opening: {
      sequenceNumber: 1,
      consensusTimestampMs: 990_000,
    },
    bids: [
      {
        bidder: "0.0.202",
        amountCents: 2550,
        sequenceNumber: 1,
        consensusTimestampMs: 1_005_000,
      },
      {
        bidder: "0.0.201",
        amountCents: 2500,
        sequenceNumber: 2,
        consensusTimestampMs: 1_010_000,
      },
      {
        bidder: "0.0.202",
        amountCents: 2600,
        sequenceNumber: 3,
        consensusTimestampMs: 1_012_000,
      },
    ],
    forfeitures: [],
  };

  assert.equal(
    marketCloseDelayMs(
      open,
      { buyerAccountId: "0.0.202", amountCents: 2600 },
      1_020_000,
    ),
    6_000,
  );
  assert.throws(
    () =>
      marketCloseDelayMs(
        open,
        { buyerAccountId: "0.0.201", amountCents: 2500 },
        1_030_000,
      ),
    /not the current highest bidder/,
  );

  assert.equal(
    marketCloseDelayMs(
      open,
      { buyerAccountId: "0.0.201", amountCents: 2500 },
      1_170_000,
    ),
    0,
  );

  const closed = {
    ...open,
    closure: {
      sequenceNumber: 4,
      consensusTimestampMs: 1_030_000,
    },
  };
  assert.doesNotThrow(() =>
    assertVerifiedMarketClaim(
      closed,
      {
        buyerAccountId: "0.0.202",
        amountCents: 2600,
      },
      1_040_000,
    ),
  );
  assert.throws(
    () =>
      assertVerifiedMarketClaim(
        closed,
        {
          buyerAccountId: "0.0.201",
          amountCents: 2500,
        },
        1_040_000,
      ),
    /does not match the current claim/,
  );

  const earlyForfeiture = {
    ...closed,
    forfeitures: [
      {
        bidder: "0.0.202",
        amountCents: 2600,
        sequenceNumber: 5,
        consensusTimestampMs: 1_059_999,
      },
    ],
  };
  assert.throws(
    () => verifiedMarketClaimState(earlyForfeiture),
    /before its claim deadline/,
  );

  const promoted = {
    ...closed,
    forfeitures: [
      {
        bidder: "0.0.202",
        amountCents: 2600,
        sequenceNumber: 5,
        consensusTimestampMs: 1_060_000,
      },
    ],
  };
  assert.equal(
    verifiedMarketClaimState(promoted).currentWinner?.bidder,
    "0.0.201",
  );
  assert.doesNotThrow(() =>
    assertVerifiedMarketClaim(
      promoted,
      {
        buyerAccountId: "0.0.201",
        amountCents: 2500,
      },
      1_070_000,
    ),
  );
  assert.throws(
    () =>
      assertVerifiedMarketClaim(
        promoted,
        {
          buyerAccountId: "0.0.201",
          amountCents: 2500,
        },
        1_090_000,
      ),
    /claim window has expired/,
  );

  assert.deepEqual(
    ascendingRanking(open.bids).map((bid) => [
      bid.bidder,
      bid.amountCents,
    ]),
    [
      ["0.0.202", 2600],
      ["0.0.201", 2500],
    ],
  );
});

test("seller signs only the exact auction-bound NATA for claim swap", async () => {
  const buyerId = "0.0.201";
  const sellerId = "0.0.301";
  const paymentTokenId = "0.0.401";
  const claimTokenId = "0.0.402";
  const buyerKey = PrivateKey.generateED25519();
  const client = Client.forTestnet().setOperator(buyerId, buyerKey);
  const expected = {
    buyerAccountId: buyerId,
    sellerAccountId: sellerId,
    amountCents: 2600,
    paymentTokenId,
    claimTokenId,
    claimNftSerial: 7,
  };

  const exact = new TransferTransaction()
    .addTokenTransfer(paymentTokenId, buyerId, -2600)
    .addTokenTransfer(paymentTokenId, sellerId, 2600)
    .addNftTransfer(claimTokenId, 7, sellerId, buyerId)
    .freezeWith(client);
  await exact.sign(buyerKey);
  const decoded = Transaction.fromBytes(exact.toBytes());
  assert.doesNotThrow(() => assertExactAtomicSwap(decoded, expected));

  const wrongPrice = new TransferTransaction()
    .addTokenTransfer(paymentTokenId, buyerId, -2500)
    .addTokenTransfer(paymentTokenId, sellerId, 2500)
    .addNftTransfer(claimTokenId, 7, sellerId, buyerId)
    .freezeWith(client);
  assert.throws(
    () => assertExactAtomicSwap(wrongPrice, expected),
    /payment does not match/,
  );

  const hiddenHbarLeg = new TransferTransaction()
    .addTokenTransfer(paymentTokenId, buyerId, -2600)
    .addTokenTransfer(paymentTokenId, sellerId, 2600)
    .addNftTransfer(claimTokenId, 7, sellerId, buyerId)
    .addHbarTransfer(buyerId, Hbar.fromTinybars(-1))
    .addHbarTransfer(sellerId, Hbar.fromTinybars(1))
    .freezeWith(client);
  assert.throws(
    () => assertExactAtomicSwap(hiddenHbarLeg, expected),
    /unexpected HBAR/,
  );

  const wrongClaim = new TransferTransaction()
    .addTokenTransfer(paymentTokenId, buyerId, -2600)
    .addTokenTransfer(paymentTokenId, sellerId, 2600)
    .addNftTransfer(claimTokenId, 8, sellerId, buyerId)
    .freezeWith(client);
  assert.throws(
    () => assertExactAtomicSwap(wrongClaim, expected),
    /claim NFT transfer does not match/,
  );

  client.close();
});

test("leaf wallet recovery records are local and owner-only", () => {
  const directory = mkdtempSync(join(tmpdir(), "pasteldenata-wallet-"));
  const path = persistLeafWallet(
    { accountId: "0.0.123", privateKey: "test-private-key" },
    {
      planId: "plan-1",
      mandateId: "mandate-1",
      category: "cinema",
    },
    directory,
  );
  const record = readLeafWallet(path);

  assert.equal(record.accountId, "0.0.123");
  assert.equal(record.privateKey, "test-private-key");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(directory, ".pasteldenata", "hedera-wallets")).mode & 0o777, 0o700);
});

test("market item ids are namespaced per run", () => {
  const first = marketItemId("run-a", "cinema", "seat-e6-e7");
  const retry = marketItemId("run-b", "cinema", "seat-e6-e7");

  assert.notEqual(first, retry);
  assert.equal(first, marketItemId("run-a", "cinema", "seat-e6-e7"));
});

test("protected markets fail closed without a credential verifier", () => {
  assert.throws(
    () => assertProtectedMarketAuthorizationConfigured(true, {}),
    /require a World authorization hook and issuer public key/,
  );
  assert.throws(
    () =>
      assertProtectedMarketAuthorizationConfigured(true, {
        authorizePurchase: async () => ({ ok: true }),
      }),
    /require a World authorization hook and issuer public key/,
  );
  assert.doesNotThrow(() =>
    assertProtectedMarketAuthorizationConfigured(true, {
      authorizationIssuerPublicKey: "test-key",
      authorizePurchase: async () => ({ ok: false }),
    }),
  );
  assert.doesNotThrow(() =>
    assertProtectedMarketAuthorizationConfigured(false, {}),
  );
});

test("settlement API accepts only a complete plan, never a mock auction trace", async () => {
  const purchase = await new MockPrivatePlanner().plan(
    "Organize me a date tomorrow in Lisbon. My budget is $200.",
    new Date("2026-07-25T10:00:00Z"),
  );
  const parsed = parseSettlementRequest({
    plan: purchase.plan,
    hostedWorldIdentity: {
      mode: "visitor",
      sessionId: "dd67b9cb-c9bc-49fa-a7fe-fe2bfd6ecc9a",
    },
  });
  assert.deepEqual(parsed.plan, purchase.plan);
  assert.deepEqual(parsed.hostedWorldIdentity, {
    mode: "visitor",
    sessionId: "dd67b9cb-c9bc-49fa-a7fe-fe2bfd6ecc9a",
  });
  assert.throws(
    () =>
      parseSettlementRequest({
        plan: purchase.plan,
        hostedWorldIdentity: {
          mode: "visitor",
          sessionId: "shared",
        },
      }),
    /Invalid uuid/,
  );
  assert.throws(
    () =>
      parseSettlementRequest({
        plan: purchase.plan,
        auctions: [],
        mode: "market",
      }),
    /Unrecognized key/,
  );

  const tampered = structuredClone(purchase.plan);
  const firstAllocation = tampered.allocations[0];
  assert.ok(firstAllocation);
  firstAllocation.maxBudgetCents += 1;
  assert.throws(
    () =>
      parseSettlementRequest({
        plan: tampered,
      }),
    /allocations and contingency must equal the total budget/,
  );
});

test("local settlement request guard rejects remote and cross-origin callers", () => {
  assert.doesNotThrow(() =>
    assertLocalDemoRequest(
      new Request("http://localhost:3000/api/hedera/jobs", {
        method: "POST",
        headers: {
          Origin: "http://localhost:3000",
          "X-Pastel-Local-Demo": "1",
        },
      }),
      { mutating: true },
    ),
  );
  assert.throws(
    () =>
      assertLocalDemoRequest(
        new Request("https://demo.example/api/hedera/jobs", {
          method: "POST",
          headers: { "X-Pastel-Local-Demo": "1" },
        }),
        { mutating: true },
      ),
    /local-only/,
  );
  assert.throws(
    () =>
      assertLocalDemoRequest(
        new Request("http://localhost:3000/api/hedera/jobs", {
          method: "POST",
          headers: {
            Origin: "https://attacker.example",
            "X-Pastel-Local-Demo": "1",
          },
        }),
        { mutating: true },
      ),
    /Cross-origin/,
  );
});

test("request guard accepts the public origin supplied by a trusted proxy", () => {
  const previous = process.env.HEDERA_ALLOW_REMOTE;
  process.env.HEDERA_ALLOW_REMOTE = "true";
  try {
    assert.doesNotThrow(() =>
      assertLocalDemoRequest(
        new Request("http://internal:8080/api/hedera/jobs", {
          method: "POST",
          headers: {
            Origin: "https://judge-demo.up.railway.app",
            "X-Forwarded-Host": "judge-demo.up.railway.app",
            "X-Forwarded-Proto": "https",
            "X-Pastel-Local-Demo": "1",
          },
        }),
        { mutating: true },
      ),
    );
  } finally {
    if (previous === undefined) {
      delete process.env.HEDERA_ALLOW_REMOTE;
    } else {
      process.env.HEDERA_ALLOW_REMOTE = previous;
    }
  }
});
