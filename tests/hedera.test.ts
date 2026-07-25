import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AuctionResult, PrivatePlan } from "../src/domain";
import {
  fetchItemState,
  fetchTopicBids,
} from "../src/hedera/mirror";
import { marketItemId } from "../src/hedera/market";
import {
  persistLeafWallet,
  readLeafWallet,
} from "../src/hedera/walletVault";
import { organizePrivatePurchase } from "../src/orchestrator";
import { validateSettlement } from "../src/payments";
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
} {
  return {
    message: Buffer.from(JSON.stringify(payload)).toString("base64"),
    payer_account_id: payer,
    sequence_number: sequence,
  };
}

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
        {
          type: "SETTLED",
          itemId: "item-1",
          bidder: "0.0.201",
          amountCents: 2500,
          transactionId: "0.0.201@1.2",
        },
        "0.0.clearing",
        4,
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
    { bidder: "0.0.201", amountCents: 2500, sequenceNumber: 1 },
  ]);
  assert.deepEqual(state.settlement, {
    bidder: "0.0.201",
    amountCents: 2500,
    transactionId: "0.0.201@1.2",
  });
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

test("settlement policy rejects zero and negative winner amounts", () => {
  const plan = {
    planId: "plan-1",
    totalBudgetCents: 10_000,
  } as PrivatePlan;
  const auction = {
    category: "cinema",
    mandate: {
      id: "mandate-1",
      planId: "plan-1",
      category: "cinema",
      maxAmountCents: 5000,
    },
    winner: { amountCents: -100 },
  } as AuctionResult;

  assert.throws(
    () => validateSettlement(plan, [auction]),
    /positive integer/,
  );
  auction.winner.amountCents = 0;
  assert.throws(
    () => validateSettlement(plan, [auction]),
    /positive integer/,
  );
});

test("market item ids are namespaced per run", () => {
  const first = marketItemId("run-a", "cinema", "seat-e6-e7");
  const retry = marketItemId("run-b", "cinema", "seat-e6-e7");

  assert.notEqual(first, retry);
  assert.equal(first, marketItemId("run-a", "cinema", "seat-e6-e7"));
});

test("settlement API validates the complete plan and auction relationship", async () => {
  const purchase = await organizePrivatePurchase(
    new MockPrivatePlanner(),
    "Organize me a date tomorrow in Lisbon. My budget is $200.",
    new Date("2026-07-25T10:00:00Z"),
  );
  const parsed = parseSettlementRequest({
    plan: purchase.plan,
    auctions: purchase.auctions,
    mode: "market",
  });
  assert.equal(parsed.auctions.length, parsed.plan.allocations.length);

  const tampered = structuredClone(purchase);
  const firstAuction = tampered.auctions[0];
  assert.ok(firstAuction);
  firstAuction.mandate.maxAmountCents += 1;
  assert.throws(
    () =>
      parseSettlementRequest({
        plan: tampered.plan,
        auctions: tampered.auctions,
        mode: "market",
      }),
    /does not match its scoped allocation/,
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
