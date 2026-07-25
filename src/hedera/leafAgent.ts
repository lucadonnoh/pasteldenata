import {
  Client,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { pickWinner, verifyRevealedBid } from "../auction.js";
import type { Bid } from "../domain.js";
import { parsePrivateKey } from "./client.js";
import type { LeafInit, LeafToParent, LiveStats, ParentToLeaf } from "./ipc.js";
import { publishToTopic } from "./log.js";
import { fetchTopicBids, standingOffers, type LiveBid } from "./mirror.js";

/**
 * An isolated buyer agent. It runs in its own process, holds only its own
 * wallet key and one scoped mandate, and pays with its own funds through its
 * own Hedera client. It never sees the buyer's intent, the global budget, or
 * any sibling agent. It cannot overspend: its wallet holds exactly the
 * mandate cap (plus any contingency the root explicitly grants on-chain).
 */

const POLL_MS = 2500;
const MIN_AUCTION_MS = 15_000;
const QUIET_CLOSE_MS = 8_000;
const TOP_UP_AFTER_QUIET_MS = 10_000;
const HARD_CLOSE_MS = 120_000;

const inbox: ParentToLeaf[] = [];
let waiter: ((message: ParentToLeaf) => void) | undefined;

process.on("message", (message) => {
  const typed = message as ParentToLeaf;
  if (waiter) {
    const resolve = waiter;
    waiter = undefined;
    resolve(typed);
  } else {
    inbox.push(typed);
  }
});

function nextMessage(): Promise<ParentToLeaf> {
  return new Promise((resolve) => {
    const queued = inbox.shift();
    if (queued) resolve(queued);
    else waiter = resolve;
  });
}

async function expectMessage<T extends ParentToLeaf["type"]>(
  type: T,
): Promise<Extract<ParentToLeaf, { type: T }>> {
  const message = await nextMessage();
  if (message.type !== type) {
    throw new Error(`Expected ${type} from the marketplace, got ${message.type}.`);
  }
  return message as Extract<ParentToLeaf, { type: T }>;
}

function send(message: LeafToParent): void {
  if (!process.send) throw new Error("Leaf agents must be forked with IPC.");
  process.send(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asBid(auctionId: string, live: LiveBid): Bid {
  return {
    auctionId,
    sellerId: live.sellerId,
    sellerName: live.sellerName,
    offering: live.offering,
    amountCents: live.amountCents,
    quality: live.quality,
    tags: live.tags,
    salt: "",
  };
}

/** Sealed one-shot RFQ: quotes arrive over IPC, commitments verified here. */
async function sealedWinner(init: LeafInit): Promise<{ winner: Bid }> {
  send({ type: "RFQ" });
  const { commitments, reveals } = await expectMessage("BIDS");
  const commitmentBySeller = new Map(
    commitments.map((item) => [item.sellerId, item.commitment]),
  );
  const validBids = reveals.filter((bid) => {
    const commitment = commitmentBySeller.get(bid.sellerId);
    return commitment !== undefined && verifyRevealedBid(bid, commitment);
  });
  if (validBids.length !== reveals.length) {
    throw new Error("A sealed bid failed commitment verification.");
  }
  const selected = pickWinner(validBids, {
    requirements: init.mandate.requirements,
    maxBudgetCents: init.mandate.maxAmountCents,
  });
  if (!selected) {
    throw new Error(`No ${init.mandate.category} bid fits the mandate cap.`);
  }
  return { winner: selected.bid };
}

/**
 * Live reverse auction: sellers undercut each other on the public HCS topic;
 * this agent watches via Mirror Node and closes once bidding goes quiet. If
 * every standing offer exceeds the cap, it asks the root once for
 * contingency budget — which arrives as a real on-chain transfer.
 */
async function liveWinner(
  init: LeafInit,
  tag: string,
): Promise<{ winner: Bid; capCents: number; stats: LiveStats }> {
  const mirrorBaseUrl = init.live?.mirrorBaseUrl;
  if (!mirrorBaseUrl) throw new Error("Live mode requires a mirror base URL.");
  let capCents = init.mandate.maxAmountCents;
  let grantedCents = 0;
  let requestedTopUp = false;
  const startedAt = Date.now();
  let seenBids = 0;
  let lastNewBidAt = Date.now();
  let history: LiveBid[] = [];

  for (;;) {
    await sleep(POLL_MS);
    history = await fetchTopicBids(
      mirrorBaseUrl,
      init.auctionTopicId,
      init.mandate.auctionId,
    );
    if (history.length > seenBids) {
      seenBids = history.length;
      lastNewBidAt = Date.now();
    }
    const standing = [...standingOffers(history).values()];
    const affordable = standing.filter((bid) => bid.amountCents <= capCents);
    const elapsed = Date.now() - startedAt;
    const quiet = Date.now() - lastNewBidAt;

    const shouldClose =
      affordable.length > 0 &&
      ((elapsed > MIN_AUCTION_MS && quiet > QUIET_CLOSE_MS) ||
        elapsed > HARD_CLOSE_MS);
    if (shouldClose) {
      const selected = pickWinner(
        affordable.map((bid) => asBid(init.mandate.auctionId, bid)),
        {
          requirements: init.mandate.requirements,
          maxBudgetCents: capCents,
        },
      );
      if (!selected) break;
      // Price discovery shown from the winner's own trajectory: its opening
      // (list-price) bid down to what it actually charges.
      const winnerEntry = history.find(
        (bid) => bid.sellerId === selected.bid.sellerId,
      );
      return {
        winner: selected.bid,
        capCents,
        stats: {
          bids: history.length,
          openingCents: winnerEntry
            ? winnerEntry.amountCents
            : selected.bid.amountCents,
          closingCents: selected.bid.amountCents,
          grantedCents,
        },
      };
    }

    if (
      affordable.length === 0 &&
      standing.length > 0 &&
      !requestedTopUp &&
      quiet > TOP_UP_AFTER_QUIET_MS
    ) {
      const best = Math.min(...standing.map((bid) => bid.amountCents));
      const needed = best - capCents;
      console.log(
        `${tag} priced out (best offer $${(best / 100).toFixed(2)} vs cap $${(capCents / 100).toFixed(2)}) — requesting contingency`,
      );
      send({ type: "BUDGET_REQUEST", neededCents: needed });
      const grant = await expectMessage("BUDGET_GRANTED");
      requestedTopUp = true;
      if (grant.grantedCents > 0) {
        capCents += grant.grantedCents;
        grantedCents += grant.grantedCents;
        lastNewBidAt = Date.now();
        console.log(
          `${tag} granted $${(grant.grantedCents / 100).toFixed(2)} contingency on-chain · new cap $${(capCents / 100).toFixed(2)}`,
        );
      }
    }

    if (elapsed > HARD_CLOSE_MS) break;
  }
  throw new Error(
    `No ${init.mandate.category} offer fits the mandate before close.`,
  );
}

async function run(init: LeafInit): Promise<void> {
  const { mandate, wallet } = init;
  const tag = `[${mandate.category}-agent ${wallet.accountId}]`;
  const key = parsePrivateKey(wallet.privateKey);
  const client = Client.forTestnet().setOperator(wallet.accountId, key);

  try {
    console.log(
      `${tag} online · cap $${(mandate.maxAmountCents / 100).toFixed(2)} · goal: ${mandate.requirements.join(", ")}${init.live ? " · watching live auction" : ""}`,
    );

    let winner: Bid;
    let capCents = mandate.maxAmountCents;
    let stats: LiveStats | undefined;
    if (init.live) {
      const outcome = await liveWinner(init, tag);
      winner = outcome.winner;
      capCents = outcome.capCents;
      stats = outcome.stats;
    } else {
      winner = (await sealedWinner(init)).winner;
    }
    console.log(
      `${tag} chose ${winner.sellerName} at $${(winner.amountCents / 100).toFixed(2)}`,
    );

    // The seller readies the claim NFT, then both parties sign one atomic
    // swap: my NATA out, the claim NFT in. This agent is the fee payer and
    // signs with its own key; the seller counter-signs.
    send({ type: "PREPARE", sellerId: winner.sellerId });
    const prepared = await expectMessage("PREPARED");

    const swap = new TransferTransaction()
      .addTokenTransfer(
        init.paymentTokenId,
        wallet.accountId,
        -winner.amountCents,
      )
      .addTokenTransfer(
        init.paymentTokenId,
        prepared.sellerAccountId,
        winner.amountCents,
      )
      .addNftTransfer(
        init.claimTokenId,
        prepared.claimNftSerial,
        prepared.sellerAccountId,
        wallet.accountId,
      )
      .freezeWith(client);
    await swap.sign(key);
    send({
      type: "SIGN_REQUEST",
      sellerId: winner.sellerId,
      txBytesB64: Buffer.from(swap.toBytes()).toString("base64"),
    });
    const signed = await expectMessage("SIGNED");

    const settlement = Transaction.fromBytes(
      Buffer.from(signed.txBytesB64, "base64"),
    );
    const response = await settlement.execute(client);
    await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    console.log(`${tag} settled atomically · ${transactionId}`);

    await publishToTopic(client, init.auctionTopicId, {
      type: "SETTLED",
      auctionId: mandate.auctionId,
      sellerId: winner.sellerId,
      amountCents: winner.amountCents,
      claimNftSerial: prepared.claimNftSerial,
      transactionId,
    });

    // Return the unspent remainder to the marketplace clearing account. The
    // claim NFT stays in this wallet; consolidating it would publicly link
    // the purchases.
    const leftover = capCents - winner.amountCents;
    if (leftover > 0) {
      await (
        await new TransferTransaction()
          .addTokenTransfer(init.paymentTokenId, wallet.accountId, -leftover)
          .addTokenTransfer(init.paymentTokenId, init.clearingAccountId, leftover)
          .execute(client)
      ).getReceipt(client);
    }

    send({
      type: "DONE",
      result: {
        sellerId: winner.sellerId,
        sellerName: winner.sellerName,
        amountCents: winner.amountCents,
        transactionId,
        leafAccountId: wallet.accountId,
        claimNftSerial: prepared.claimNftSerial,
        auctionTopicId: init.auctionTopicId,
        ...(stats ? { liveStats: stats } : {}),
      },
    });
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const init = await expectMessage("MANDATE");
  await run(init);
  process.disconnect();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  try {
    send({ type: "ERROR", message });
  } catch {
    console.error(message);
  }
  process.exitCode = 1;
  process.disconnect();
});
