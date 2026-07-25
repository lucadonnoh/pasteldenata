import {
  AccountBalanceQuery,
  Client,
  Hbar,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { parsePrivateKey } from "./client";
import type {
  ContestedListing,
  HederaOffer,
  LeafInit,
  LeafResult,
  LeafToParent,
  LiveStats,
  ParentToLeaf,
} from "./ipc";
import { publishToTopic } from "./log";
import {
  ascendingLeader,
  ascendingRanking,
  fetchItemState,
  fetchTopicBids,
  standingOffers,
  type LiveBid,
} from "./mirror";
import {
  assertExactAtomicSwap,
  MARKET_HARD_CLOSE_MS,
  MARKET_MIN_AUCTION_MS,
  MARKET_QUIET_CLOSE_MS,
} from "./marketPolicy";

/**
 * An isolated buyer agent. It runs in its own process, holds only its own
 * wallet key and one scoped mandate, and pays with its own funds through its
 * own Hedera client. It never sees the buyer's intent, the global budget, or
 * any sibling agent. It cannot overspend: its wallet holds exactly the
 * mandate cap (plus any contingency the root explicitly grants on-chain).
 */

const POLL_MS = 750;
const MIN_AUCTION_MS = 4_000;
const QUIET_CLOSE_MS = 2_000;
const TOP_UP_AFTER_QUIET_MS = 5_000;
const HARD_CLOSE_MS = 25_000;
// Contested (multi-buyer) auctions wait longer so rivals get to counter-bid
// before a leader can close — otherwise the first floor bid snipes the item.

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

async function returnFeeFloat(
  client: Client,
  accountId: string,
  clearingAccountId: string,
): Promise<void> {
  try {
    const balance = await new AccountBalanceQuery()
      .setAccountId(accountId)
      .execute(client);
    const tinybars = balance.hbars.toTinybars().toNumber();
    const send = tinybars - 5_000_000; // keep 0.05 hbar for this transfer's fee
    if (send <= 0) return;
    const sweep = new TransferTransaction()
      .addHbarTransfer(accountId, Hbar.fromTinybars(-send))
      .addHbarTransfer(clearingAccountId, Hbar.fromTinybars(send))
      .setMaxTransactionFee(Hbar.fromTinybars(4_000_000));
    await (await sweep.execute(client)).getReceipt(client);
  } catch {
    // The root still retains the persisted testnet key for recovery.
  }
}

function asOffer(live: LiveBid): HederaOffer {
  return {
    listingId: live.listingId,
    sellerId: live.sellerId,
    sellerName: live.sellerName,
    offering: live.offering,
    amountCents: live.amountCents,
    quality: live.quality,
    tags: live.tags,
    attributes: {},
  };
}

function offerScore(
  offer: HederaOffer,
  requirements: string[],
  maxBudgetCents: number,
): number {
  const normalized = requirements.map((item) => item.toLowerCase());
  const tagMatches = offer.tags.filter((tag) =>
    normalized.some(
      (requirement) =>
        requirement.includes(tag.toLowerCase()) ||
        tag.toLowerCase().includes(requirement),
    ),
  ).length;
  return (
    offer.quality +
    tagMatches * 6 +
    25 * (1 - offer.amountCents / maxBudgetCents)
  );
}

function pickOffer(
  offers: HederaOffer[],
  init: LeafInit,
  maxBudgetCents = init.mandate.maxAmountCents,
): HederaOffer | undefined {
  return offers
    .filter(
      (offer) =>
        Number.isSafeInteger(offer.amountCents) &&
        offer.amountCents > 0 &&
        offer.amountCents <= maxBudgetCents,
    )
    .sort(
      (left, right) =>
        offerScore(right, init.mandate.requirements, maxBudgetCents) -
          offerScore(left, init.mandate.requirements, maxBudgetCents) ||
        left.amountCents - right.amountCents ||
        left.listingId.localeCompare(right.listingId),
    )[0];
}

/** The current mock English-auction winner arrives as a scoped public offer. */
async function sealedWinner(init: LeafInit): Promise<{ winner: HederaOffer }> {
  send({ type: "RFQ" });
  const { offers } = await expectMessage("OFFERS");
  const selected = pickOffer(offers, init);
  if (!selected) {
    throw new Error(`No ${init.mandate.category} offer fits the mandate cap.`);
  }
  return { winner: selected };
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
): Promise<{ winner: HederaOffer; capCents: number; stats: LiveStats }> {
  const live = init.live;
  if (!live) throw new Error("Live mode requires a mirror configuration.");
  const mirrorBaseUrl = live.mirrorBaseUrl;
  const authorized = new Map(
    live.authorizedOffers.map(({ offer, sellerAccountId }) => [
      offer.listingId,
      { sellerId: offer.sellerId, accountId: sellerAccountId },
    ]),
  );
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
      authorized,
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
      const selected = pickOffer(
        affordable.map(asOffer),
        init,
        capCents,
      );
      if (!selected) break;
      // Price discovery shown from the winner's own trajectory: its opening
      // (list-price) bid down to what it actually charges.
      const winnerEntry = history.find(
        (bid) => bid.listingId === selected.listingId,
      );
      return {
        winner: selected,
        capCents,
        stats: {
          bids: history.length,
          openingCents: winnerEntry
            ? winnerEntry.amountCents
            : selected.amountCents,
          closingCents: selected.amountCents,
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
    Math.max(100, Math.round(floorCents * 0.05));

  const report = async (outcome: {
    listing?: ContestedListing;
    amountCents?: number;
    transactionId?: string;
    claimNftSerial?: number;
  }): Promise<void> => {
    const spent = outcome.amountCents ?? 0;
    await returnFeeFloat(client, me, init.clearingAccountId);
    send({
      type: "DONE",
      result: {
        listingId: outcome.listing?.listingId ?? "",
        offering: outcome.listing?.offering ?? "",
        sellerId: outcome.listing?.sellerId ?? "",
        sellerName: outcome.listing?.sellerName ?? "",
        amountCents: spent,
        transactionId: outcome.transactionId ?? "",
        leafAccountId: me,
        claimNftSerial: outcome.claimNftSerial ?? 0,
        auctionTopicId: outcome.listing?.topicId ?? "",
        ...(outcome.listing
          ? { marketItemId: outcome.listing.itemId }
          : {}),
        ...(outcome.listing ? {} : { lost: true }),
        grantedCents,
      },
    });
  };

  const trySettle = async (
    listing: ContestedListing,
    amountCents: number,
  ): Promise<boolean> => {
    send({
      type: "PREPARE",
      sellerId: listing.sellerId,
      listingId: listing.listingId,
      amountCents,
    });
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
    const completed = await expectMessage("SETTLED");
    const settlement = Transaction.fromBytes(
      Buffer.from(completed.txBytesB64, "base64"),
    );
    assertExactAtomicSwap(settlement, {
      buyerAccountId: me,
      sellerAccountId: reply.sellerAccountId,
      amountCents,
      paymentTokenId: init.paymentTokenId,
      claimTokenId: init.claimTokenId,
      claimNftSerial: reply.claimNftSerial,
    });
    if (
      settlement.transactionId?.toString() !== completed.transactionId
    ) {
      throw new Error(
        "Marketplace returned a transaction id that does not match the signed swap.",
      );
    }
    const transactionId = completed.transactionId;
    console.log(
      `${tag} WON ${listing.sellerName} at ${usd(amountCents)} · ${transactionId}`,
    );
    const result: LeafResult = {
      listingId: listing.listingId,
      offering: listing.offering,
      sellerId: listing.sellerId,
      sellerName: listing.sellerName,
      amountCents,
      transactionId,
      leafAccountId: me,
      claimNftSerial: reply.claimNftSerial,
      auctionTopicId: listing.topicId,
      marketItemId: listing.itemId,
      grantedCents,
    };
    send({ type: "SETTLEMENT_CONFIRMED", result });
    await expectMessage("SETTLEMENT_RECORDED");
    await report({
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
      return report({});
    }

    let states: Array<{
      listing: ContestedListing;
      state: Awaited<ReturnType<typeof fetchItemState>>;
    }>;
    try {
      states = await Promise.all(
        open.map(async (listing) => ({
          listing,
          state: await fetchItemState(
            mirrorBaseUrl,
            listing.topicId,
            listing.itemId,
            init.clearingAccountId,
          ),
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
      if (state.closure) {
        const ownBid = ascendingRanking(state.bids).find(
          (bid) => bid.bidder === me,
        );
        if (ownBid) {
          const won = await trySettle(listing, ownBid.amountCents);
          if (won) return;
        }
        closed.add(listing.itemId);
        continue;
      }
      if (state.settlement) {
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
        (elapsed > MARKET_MIN_AUCTION_MS &&
          quiet > MARKET_QUIET_CLOSE_MS) ||
        elapsed > MARKET_HARD_CLOSE_MS
      ) {
        const won = await trySettle(leading.listing, leading.amountCents);
        if (won) return;
        closed.add(leading.listing.itemId);
      }
      continue; // Hold while leading: the cap backs exactly one bid.
    }
    if (waitingForMirror) continue;
    if (elapsed > MARKET_HARD_CLOSE_MS) {
      const fallback = states
        .filter(
          ({ listing, state }) =>
            !closed.has(listing.itemId) && !state.settlement,
        )
        .map(({ listing, state }) => ({
          listing,
          ownBid: ascendingRanking(state.bids).find(
            (bid) => bid.bidder === me,
          ),
        }))
        .find((candidate) => candidate.ownBid !== undefined);
      if (fallback?.ownBid) {
        const won = await trySettle(
          fallback.listing,
          fallback.ownBid.amountCents,
        );
        if (won) return;
        closed.add(fallback.listing.itemId);
        continue;
      }
      console.log(`${tag} lost: auction closed without an eligible bid`);
      return report({});
    }

    const candidates = states
      .filter(
        ({ listing, state }) =>
          !closed.has(listing.itemId) && !state.settlement,
      )
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
      const hasRankedFallback = states.some(
        ({ listing, state }) =>
          !closed.has(listing.itemId) &&
          !state.settlement &&
          state.bids.some((bid) => bid.bidder === me),
      );
      if (hasRankedFallback) {
        // Being unable to raise does not erase this account's last valid bid.
        // Stay online so a non-settling higher bidder can time out and this
        // agent can claim its fixed fallback position.
        continue;
      }
      console.log(`${tag} lost: outbid beyond the mandate everywhere`);
      return report({});
    }

    const best = pickOffer(
      affordable.map(({ listing, priceCents }) => ({
        listingId: listing.listingId,
        sellerId: listing.sellerId,
        sellerName: listing.sellerName,
        offering: listing.offering,
        amountCents: priceCents,
        quality: listing.quality,
        tags: listing.tags,
        attributes: listing.attributes,
      })),
      init,
      capCents,
    );
    if (!best) {
      return report({});
    }
    const target = affordable.find(
      (item) => item.listing.listingId === best.listingId,
    );
    if (!target) continue;
    console.log(
      `${tag} bidding ${usd(target.priceCents)} on ${target.listing.sellerName}`,
    );
    await publishToTopic(
      client,
      target.listing.topicId,
      target.listing.topicSubmitKey,
      {
        type: "BID",
        itemId: target.listing.itemId,
        bidder: me,
        amountCents: target.priceCents,
      },
    );
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

    let winner: HederaOffer;
    let stats: LiveStats | undefined;
    if (init.live) {
      const outcome = await liveWinner(init, tag);
      winner = outcome.winner;
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
    send({
      type: "PREPARE",
      sellerId: winner.sellerId,
      listingId: winner.listingId,
      amountCents: winner.amountCents,
    });
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
    assertExactAtomicSwap(settlement, {
      buyerAccountId: wallet.accountId,
      sellerAccountId: prepared.sellerAccountId,
      amountCents: winner.amountCents,
      paymentTokenId: init.paymentTokenId,
      claimTokenId: init.claimTokenId,
      claimNftSerial: prepared.claimNftSerial,
    });
    const response = await settlement.execute(client);
    await response.getReceipt(client);
    const transactionId = response.transactionId.toString();
    console.log(`${tag} settled atomically · ${transactionId}`);

    const result: LeafResult = {
      listingId: winner.listingId,
      offering: winner.offering,
      sellerId: winner.sellerId,
      sellerName: winner.sellerName,
      amountCents: winner.amountCents,
      transactionId,
      leafAccountId: wallet.accountId,
      claimNftSerial: prepared.claimNftSerial,
      auctionTopicId: init.auctionTopicId,
      ...(stats ? { liveStats: stats } : {}),
    };
    send({ type: "SETTLEMENT_CONFIRMED", result });
    await expectMessage("SETTLEMENT_RECORDED");
    await returnFeeFloat(
      client,
      wallet.accountId,
      init.clearingAccountId,
    );
    send({ type: "DONE", result });
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
