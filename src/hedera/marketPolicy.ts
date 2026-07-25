import {
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import {
  ascendingLeader,
  ascendingRanking,
  type ItemState,
} from "./mirror";

export const MARKET_MIN_AUCTION_MS = 30_000;
export const MARKET_QUIET_CLOSE_MS = 14_000;
export const MARKET_HARD_CLOSE_MS = 180_000;
export const MARKET_CLAIM_WINDOW_MS = 30_000;

export interface MarketWinnerExpectation {
  buyerAccountId: string;
  amountCents: number;
}

export interface AtomicSwapExpectation extends MarketWinnerExpectation {
  sellerAccountId: string;
  paymentTokenId: string;
  claimTokenId: string;
  claimNftSerial: number;
}

export interface MarketClaimState {
  ranking: ReturnType<typeof ascendingRanking>;
  currentWinner?: ReturnType<typeof ascendingLeader>;
  deadlineMs: number;
  forfeitedBidders: ReadonlySet<string>;
}

function policyError(message: string): Error {
  return new Error(`Seller policy rejected settlement: ${message}`);
}

/**
 * Determine when an independently replayed auction may close. The seller
 * never trusts the child agent's claim that it won: the authenticated HCS
 * payer, amount, minimum auction duration, and quiet window must all agree.
 */
export function marketCloseDelayMs(
  state: ItemState,
  expected: MarketWinnerExpectation,
  nowMs: number,
): number {
  if (state.settlement) {
    throw policyError("the item is already settled");
  }
  if (state.closure) {
    throw policyError("the auction is already closed");
  }
  const ranking = ascendingRanking(state.bids);
  const leader = ranking[0];
  const requester = ranking.find(
    (bid) => bid.bidder === expected.buyerAccountId,
  );
  if (!requester || requester.amountCents !== expected.amountCents) {
    throw policyError("the requester has no matching authenticated bid");
  }
  const latestBid = state.bids.at(-1);
  if (!latestBid) {
    throw policyError("the auction has no authenticated bids");
  }
  if (!state.opening) {
    throw policyError("the auction has no authenticated listing");
  }
  const closeNotBeforeMs =
    state.opening.consensusTimestampMs + MARKET_MIN_AUCTION_MS;
  const hardCloseAtMs =
    state.opening.consensusTimestampMs + MARKET_HARD_CLOSE_MS;
  if (nowMs >= hardCloseAtMs) return 0;
  if (requester !== leader) {
    throw policyError("the requester is not the current highest bidder");
  }

  const readyAt = Math.max(
    closeNotBeforeMs,
    latestBid.consensusTimestampMs + MARKET_QUIET_CLOSE_MS,
  );
  return Math.max(0, readyAt - nowMs);
}

/**
 * A CLOSED message is authoritative only when Mirror Node attributes it to
 * clearing. fetchItemState enforces that payer binding and ignores later bids,
 * so the winner is derived exclusively from bids ordered before that marker.
 */
export function verifiedMarketClaimState(
  state: ItemState,
): MarketClaimState {
  if (state.settlement) {
    throw policyError("the item is already settled");
  }
  if (!state.closure) {
    throw policyError("no authenticated auction closure exists");
  }
  const ranking = ascendingRanking(state.bids);
  if (ranking.length === 0) {
    throw policyError("the closed auction has no authenticated bids");
  }
  const forfeitedBidders = new Set<string>();
  let deadlineMs =
    state.closure.consensusTimestampMs + MARKET_CLAIM_WINDOW_MS;

  for (const forfeiture of state.forfeitures) {
    const currentWinner = ranking.find(
      (bid) => !forfeitedBidders.has(bid.bidder),
    );
    if (!currentWinner) {
      throw policyError("a forfeiture exists after every bidder was exhausted");
    }
    if (
      forfeiture.bidder !== currentWinner.bidder ||
      forfeiture.amountCents !== currentWinner.amountCents
    ) {
      throw policyError("a forfeiture does not match the current winner");
    }
    if (forfeiture.consensusTimestampMs < deadlineMs) {
      throw policyError("a winner was forfeited before its claim deadline");
    }
    forfeitedBidders.add(currentWinner.bidder);
    deadlineMs =
      forfeiture.consensusTimestampMs + MARKET_CLAIM_WINDOW_MS;
  }

  return {
    ranking,
    currentWinner: ranking.find(
      (bid) => !forfeitedBidders.has(bid.bidder),
    ),
    deadlineMs,
    forfeitedBidders,
  };
}

/**
 * Verify that the buyer is the current, non-forfeited winner and is still
 * inside its deterministic HCS claim window.
 */
export function assertVerifiedMarketClaim(
  state: ItemState,
  expected: MarketWinnerExpectation,
  nowMs: number,
): void {
  const claim = verifiedMarketClaimState(state);
  const leader = claim.currentWinner;
  if (!leader) {
    throw policyError("every ranked bidder has forfeited");
  }
  if (
    leader.bidder !== expected.buyerAccountId ||
    leader.amountCents !== expected.amountCents
  ) {
    throw policyError(
      "the prepared buyer or price does not match the current claim",
    );
  }
  if (nowMs >= claim.deadlineMs) {
    throw policyError("the current winner's claim window has expired");
  }
}

function amountFor(
  transfer: TransferTransaction,
  tokenId: string,
  accountId: string,
): string | undefined {
  return transfer.tokenTransfers
    .get(tokenId)
    ?.get(accountId)
    ?.toString();
}

/**
 * Verify the exact frozen transaction before exposing the seller signature.
 * Hedera enforces whatever was signed; this check binds those bytes to the
 * independently replayed auction result and the one prepared claim NFT.
 */
export function assertExactAtomicSwap(
  transaction: Transaction,
  expected: AtomicSwapExpectation,
): asserts transaction is TransferTransaction {
  if (!(transaction instanceof TransferTransaction)) {
    throw policyError("the payload is not a token transfer");
  }
  if (!transaction.isFrozen()) {
    throw policyError("the transfer is not frozen");
  }
  if (
    transaction.transactionId?.accountId?.toString() !==
    expected.buyerAccountId
  ) {
    throw policyError("the buyer is not the transaction fee payer");
  }
  if (transaction.hbarTransfers.size !== 0) {
    throw policyError("unexpected HBAR transfers are present");
  }

  const tokenTransfers = transaction.tokenTransfers;
  const paymentTransfers = tokenTransfers.get(expected.paymentTokenId);
  if (tokenTransfers.size !== 1 || !paymentTransfers) {
    throw policyError("unexpected fungible token transfers are present");
  }
  if (
    paymentTransfers.size !== 2 ||
    amountFor(
      transaction,
      expected.paymentTokenId,
      expected.buyerAccountId,
    ) !== String(-expected.amountCents) ||
    amountFor(
      transaction,
      expected.paymentTokenId,
      expected.sellerAccountId,
    ) !== String(expected.amountCents)
  ) {
    throw policyError("the NATA payment does not match the winning bid");
  }

  const nftTransfers = transaction.nftTransfers;
  const claims = nftTransfers.get(expected.claimTokenId);
  const claim = claims?.[0];
  if (
    nftTransfers.size !== 1 ||
    claims?.length !== 1 ||
    !claim ||
    claim.sender.toString() !== expected.sellerAccountId ||
    claim.recipient.toString() !== expected.buyerAccountId ||
    claim.serial.toString() !== String(expected.claimNftSerial) ||
    claim.isApproved
  ) {
    throw policyError("the claim NFT transfer does not match the prepared sale");
  }
}
