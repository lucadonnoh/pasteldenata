import assert from "node:assert/strict";
import test from "node:test";

import { latestBidActivity } from "../src/hedera/marketFocus";

test("live focus follows the newest authenticated bid across topics", () => {
  const activity = [
    {
      itemId: "flowers",
      category: "flowers",
      event: {
        type: "BID",
        sequenceNumber: 2,
        consensusTimestamp: "1785000000.100000000",
      },
    },
    {
      itemId: "cinema",
      category: "cinema",
      event: {
        type: "BID",
        sequenceNumber: 9,
        consensusTimestamp: "1785000002.200000000",
      },
    },
    {
      itemId: "flowers",
      category: "flowers",
      event: {
        type: "CLOSED",
        sequenceNumber: 3,
        consensusTimestamp: "1785000003.300000000",
      },
    },
  ] as const;

  assert.equal(
    latestBidActivity(activity, new Set(["flowers", "cinema"]))
      ?.itemId,
    "cinema",
  );
});

test("live focus ignores bids outside the planned categories", () => {
  const activity = [
    {
      itemId: "unplanned",
      category: "experience",
      event: {
        type: "BID",
        sequenceNumber: 20,
        consensusTimestamp: "1785000004.000000000",
      },
    },
    {
      itemId: "planned",
      category: "flowers",
      event: {
        type: "BID",
        sequenceNumber: 3,
        consensusTimestamp: "1785000001.000000000",
      },
    },
  ] as const;

  assert.equal(
    latestBidActivity(activity, new Set(["flowers"]))?.itemId,
    "planned",
  );
});
