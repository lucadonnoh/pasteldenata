import assert from "node:assert/strict";
import test from "node:test";

import { wasPreventedFromBidding } from "../src/hedera/marketOutcome";

const listings = [
  { itemId: "cinema-a", category: "cinema" },
  { itemId: "cinema-b", category: "cinema" },
];

test("reports admission failure when World policy blocked every listing", () => {
  assert.equal(
    wasPreventedFromBidding({
      buyerName: "You",
      category: "cinema",
      listings,
      bidsByItem: {},
      blocks: listings.map((listing) => ({
        buyerName: "You",
        category: "cinema",
        itemId: listing.itemId,
      })),
    }),
    true,
  );
});

test("does not call an auction loss an admission failure", () => {
  assert.equal(
    wasPreventedFromBidding({
      buyerName: "You",
      category: "cinema",
      listings,
      bidsByItem: {
        "cinema-a": [{ yours: true }],
      },
      blocks: listings.map((listing) => ({
        buyerName: "You",
        category: "cinema",
        itemId: listing.itemId,
      })),
    }),
    false,
  );
});

test("does not claim total admission failure when an open listing remained", () => {
  assert.equal(
    wasPreventedFromBidding({
      buyerName: "You",
      category: "cinema",
      listings,
      bidsByItem: {},
      blocks: [
        {
          buyerName: "You",
          category: "cinema",
          itemId: "cinema-a",
        },
      ],
    }),
    false,
  );
});
