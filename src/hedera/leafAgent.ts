import {
  Client,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { pickWinner, verifyRevealedBid } from "../auction.js";
import type { Bid } from "../domain.js";
import { parsePrivateKey } from "./client.js";
import type {
  ContestedListing,
  LeafInit,
  LeafToParent,
  LiveStats,
  ParentToLeaf,
} from "./ipc.js";
import { publishToTopic } from "./log.js";
import {
  ascendingLeader,
  fetchItemState,
  fetchTopicBids,
  standingOffers,
  type LiveBid,
} from "./mirror.js";

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
// Contested (multi-buyer) auctions wait longer so rivals get to counter-bid
// before a leader can close — otherwise the first floor bid snipes the item.
const CONTESTED_MIN_MS = 30_000;
const CONTESTED_QUIET_MS = 14_000;
const CONTESTED_HARD_MS = 180_000;

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

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Market mode: ascending auctions over scarce listings shared with other
 * buyers' agents. The seller's price is the floor; competition only ever
 * pushes prices up. The agent targets its best-scored affordable listing,
 * raises when outbid, asks the root once for contingency when priced out
 * everywhere, retargets when its item sells to someone else, and settles
 * atomically once it leads a quiet auction. It never bids on two listings
 * at once — its wallet covers exactly one cap.
 */
async function contestedRun(
  init: LeafInit,
  tag: string,
  client: Client,
  key: ReturnType<typeof parsePrivateKey>,
): Promise<void> {
  const contested = init.contested;
  if (!contested) throw new Error("Market mode requires listings.");
  const { mirrorBaseUrl, listings } = contested;
  const me = init.wallet.accountId;
  let capCents = init.mandate.maxAmountCents;
  let grantedCents = 0;
  let requestedTopUp = false;
  const startedAt = Date.now();
  const closed = new Set<string>();
  const seenBidCount = new Map<string, number>();
  const lastNewBidAt = new Map<string, number>();
  /** My published bids not yet visible on the mirror, per item. */
  const pending = new Map<string, number>();

  const increment = (floorCents: number) =>
    Math.max(25, Math.round(floorCents * 0.02));

  const sweepAndReport = async (outcome: {
    listing?: ContestedListing;
    amountCents?: number;
    transactionId?: string;
    claimNftSerial?: number;
  }): Promise<void> => {
    const spent = outcome.amountCents ?? 0;
    const leftover = capCents - spent;
    if (leftover > 0) {
      await (
        await new TransferTransaction()
          .addTokenTransfer(init.paymentTokenId, me, -leftover)
          .addTokenTransfer(init.paymentTokenId, init.clearingAccountId, leftover)
          .execute(client)
      ).getReceipt(client);
    }
    send({
      type: "DONE",
      result: {
        sellerId: outcome.listing?.sellerId ?? "",
        sellerName: outcome.listing?.sellerName ?? "",
        amountCents: spent,
        transactionId: outcome.transactionId ?? "",
        leafAccountId: me,
        claimNftSerial: outcome.claimNftSerial ?? 0,
        auctionTopicId: outcome.listing?.topicId ?? "",
        ...(outcome.listing ? {} : { lost: true }),
        grantedCents,
      },
    });
  };

  const trySettle = async (
    listing: ContestedListing,
    amountCents: number,
  ): Promise<boolean> => {
    send({ type: "PREPARE", sellerId: listing.sellerId });
    const reply = await nextMessage();
    if (reply.type === "PREPARE_REJECTED") return false;
    if (reply.type !== "PREPARED") {
      throw new Error(`Expected PREPARED, got ${reply.type}.`);
    }
    const swap = new TransferTransaction()
      .addTokenTransfer(init.paymentTokenId, me, -amountCents)
      .addTokenTransfer(init.paymentTokenId, reply.sellerAccountId, amountCents)
      .addNftTransfer(init.claimTokenId, reply.claimNftSerial, reply.sellerAccountId, me)
      .freezeWith(client);
    await swap.sign(key);
    send({
      type: "SIGN_REQUEST",
      sellerId: listing.sellerId,
      txBytesB64: Buffer.from(swap.toBytes()).toString("base64"),
    });
    const signed = await expectMessage("SIGNED");
    const settlement = Transaction.fromBytes(
      Buffer.from(signed.txBytesB64, "base64"),
    );
    const response = await settlement.execute(client);
    await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    console.log(
      `${tag} WON ${listing.sellerName} at ${usd(amountCents)} · ${transactionId}`,
    );
    await publishToTopic(client, listing.topicId, {
      type: "SETTLED",
      itemId: listing.itemId,
      sellerId: listing.sellerId,
      bidder: me,
      amountCents,
      claimNftSerial: reply.claimNftSerial,
      transactionId,
    });
    await sweepAndReport({
      listing,
      amountCents,
      transactionId,
      claimNftSerial: reply.claimNftSerial,
    });
    return true;
  };

  for (;;) {
    await sleep(POLL_MS);
    const now = Date.now();
    const elapsed = now - startedAt;
    const open = listings.filter((listing) => !closed.has(listing.itemId));
    if (open.length === 0) {
      console.log(`${tag} lost: every affordable listing sold to someone else`);
      return sweepAndReport({});
    }

    let states: Array<{
      listing: ContestedListing;
      state: Awaited<ReturnType<typeof fetchItemState>>;
    }>;
    try {
      states = await Promise.all(
        open.map(async (listing) => ({
          listing,
          state: await fetchItemState(mirrorBaseUrl, listing.topicId, listing.itemId),
        })),
      );
    } catch {
      continue; // Mirror hiccup or rate limit; retry next poll.
    }

    let leading:
      | { listing: ContestedListing; amountCents: number }
      | undefined;
    let waitingForMirror = false;
    for (const { listing, state } of states) {
      if (state.settled) {
        closed.add(listing.itemId);
        continue;
      }
      if ((seenBidCount.get(listing.itemId) ?? 0) !== state.bids.length) {
        seenBidCount.set(listing.itemId, state.bids.length);
        lastNewBidAt.set(listing.itemId, now);
      }
      const leader = ascendingLeader(state.bids);
      const mine = pending.get(listing.itemId);
      if (mine !== undefined) {
        const visible = state.bids.some(
          (bid) => bid.bidder === me && bid.amountCents >= mine,
        );
        if (visible) pending.delete(listing.itemId);
        else {
          waitingForMirror = true;
          continue;
        }
      }
      if (leader && leader.bidder === me) {
        leading = { listing, amountCents: leader.amountCents };
      }
    }

    if (leading) {
      const quiet =
        now - (lastNewBidAt.get(leading.listing.itemId) ?? startedAt);
      if (
        (elapsed > CONTESTED_MIN_MS && quiet > CONTESTED_QUIET_MS) ||
        elapsed > CONTESTED_HARD_MS
      ) {
        const won = await trySettle(leading.listing, leading.amountCents);
        if (won) return;
        closed.add(leading.listing.itemId);
      }
      continue; // Hold while leading: the cap backs exactly one bid.
    }
    if (waitingForMirror) continue;
    if (elapsed > CONTESTED_HARD_MS) {
      console.log(`${tag} lost: auction closed while outbid`);
      return sweepAndReport({});
    }

    const candidates = states
      .filter(({ listing, state }) => !closed.has(listing.itemId) && !state.settled)
      .map(({ listing, state }) => {
        const leader = ascendingLeader(state.bids);
        const priceCents = leader
          ? leader.amountCents + increment(listing.floorCents)
          : listing.floorCents;
        return { listing, priceCents };
      });
    const affordable = candidates.filter((item) => item.priceCents <= capCents);

    if (affordable.length === 0) {
      const cheapest = Math.min(...candidates.map((item) => item.priceCents));
      if (!requestedTopUp && Number.isFinite(cheapest)) {
        requestedTopUp = true;
        console.log(
          `${tag} priced out (cheapest next bid ${usd(cheapest)} vs cap ${usd(capCents)}) — requesting contingency`,
        );
        send({ type: "BUDGET_REQUEST", neededCents: cheapest - capCents });
        const grant = await expectMessage("BUDGET_GRANTED");
        if (grant.grantedCents > 0) {
          capCents += grant.grantedCents;
          grantedCents += grant.grantedCents;
          console.log(
            `${tag} granted ${usd(grant.grantedCents)} contingency on-chain · new cap ${usd(capCents)}`,
          );
          continue;
        }
      }
      console.log(`${tag} lost: outbid beyond the mandate everywhere`);
      return sweepAndReport({});
    }

    const best = pickWinner(
      affordable.map(({ listing, priceCents }) =>
        asBid(listing.itemId, {
          sellerId: listing.sellerId,
          sellerName: listing.sellerName,
          offering: listing.offering,
          amountCents: priceCents,
          quality: listing.quality,
          tags: listing.tags,
          sequenceNumber: 0,
        }),
      ),
      { requirements: init.mandate.requirements, maxBudgetCents: capCents },
    );
    if (!best) {
      return sweepAndReport({});
    }
    const target = affordable.find(
      (item) => item.listing.itemId === best.bid.auctionId,
    );
    if (!target) continue;
    console.log(
      `${tag} bidding ${usd(target.priceCents)} on ${target.listing.sellerName}`,
    );
    await publishToTopic(client, target.listing.topicId, {
      type: "BID",
      itemId: target.listing.itemId,
      bidder: me,
      amountCents: target.priceCents,
    });
    pending.set(target.listing.itemId, target.priceCents);
    lastNewBidAt.set(target.listing.itemId, Date.now());
  }
}

async function run(init: LeafInit): Promise<void> {
  const { mandate, wallet } = init;
  const label = init.buyerLabel ? `${init.buyerLabel}·` : "";
  const tag = `[${label}${mandate.category}-agent ${wallet.accountId}]`;
  const key = parsePrivateKey(wallet.privateKey);
  const client = Client.forTestnet().setOperator(wallet.accountId, key);

  try {
    console.log(
      `${tag} online · cap $${(mandate.maxAmountCents / 100).toFixed(2)} · goal: ${mandate.requirements.join(", ")}${init.live ? " · watching live auction" : ""}${init.contested ? " · entering the open market" : ""}`,
    );

    if (init.contested) {
      await contestedRun(init, tag, client, key);
      return;
    }

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
