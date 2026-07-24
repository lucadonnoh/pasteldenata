import { createHash } from "node:crypto";
import { MOCK_SELLERS } from "./catalog.js";
import type {
  AuctionResult,
  Bid,
  BidCommitment,
  PlanAllocation,
  PrivatePlan,
  Seller,
  SellerAuctionView,
  SpendMandate,
} from "./domain.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalBid(bid: Bid): string {
  return JSON.stringify({
    auctionId: bid.auctionId,
    sellerId: bid.sellerId,
    offering: bid.offering,
    amountCents: bid.amountCents,
    quality: bid.quality,
    tags: [...bid.tags].sort(),
    salt: bid.salt,
  });
}

function deterministicDiscount(seller: Seller, auctionId: string): number {
  const sample = Number.parseInt(
    hash(`${seller.privateSalt}|${auctionId}`).slice(0, 8),
    16,
  );
  return 3 + (sample % 14);
}

export function sellerSubmitSealedBid(
  seller: Seller,
  view: SellerAuctionView,
): BidCommitment {
  if (seller.category !== view.category) {
    throw new Error("Seller received an auction for the wrong category.");
  }

  const discountPercent = deterministicDiscount(seller, view.auctionId);
  const discounted = Math.round(
    seller.listPriceCents * (1 - discountPercent / 100),
  );
  const amountCents = Math.max(seller.reservePriceCents, discounted);
  const bid: Bid = {
    auctionId: view.auctionId,
    sellerId: seller.id,
    sellerName: seller.name,
    offering: seller.offering,
    amountCents,
    quality: seller.quality,
    tags: seller.tags,
    salt: hash(`${seller.privateSalt}|${view.auctionId}|reveal`).slice(0, 24),
  };

  return {
    sellerId: seller.id,
    commitment: hash(canonicalBid(bid)),
    reveal: () => structuredClone(bid),
  };
}

function createMandate(
  plan: PrivatePlan,
  allocation: PlanAllocation,
): SpendMandate {
  return {
    id: `mandate_${hash(`${plan.planId}|${allocation.category}`).slice(0, 16)}`,
    planId: plan.planId,
    category: allocation.category,
    maxAmountCents: allocation.maxBudgetCents,
    currency: "USD",
    expiresAt: `${plan.scheduledFor}T23:59:59Z`,
  };
}

export interface ScoringConstraints {
  requirements: string[];
  maxBudgetCents: number;
}

export function scoreBid(bid: Bid, constraints: ScoringConstraints): number {
  const requirements = constraints.requirements.map((item) =>
    item.toLowerCase(),
  );
  const tagMatches = bid.tags.filter((tag) =>
    requirements.some(
      (requirement) =>
        requirement.includes(tag.toLowerCase()) ||
        tag.toLowerCase().includes(requirement),
    ),
  ).length;
  const priceValue =
    25 * (1 - bid.amountCents / constraints.maxBudgetCents);
  return bid.quality + tagMatches * 6 + priceValue;
}

export function verifyRevealedBid(bid: Bid, commitment: string): boolean {
  return hash(canonicalBid(bid)) === commitment;
}

export function pickWinner(
  bids: Bid[],
  constraints: ScoringConstraints,
): { bid: Bid; score: number } | undefined {
  return bids
    .filter((bid) => bid.amountCents <= constraints.maxBudgetCents)
    .map((bid) => ({ bid, score: scoreBid(bid, constraints) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bid.amountCents - right.bid.amountCents,
    )[0];
}

export async function runCategoryAuction(
  plan: PrivatePlan,
  allocation: PlanAllocation,
  sellers = MOCK_SELLERS,
  onSellerView?: (view: SellerAuctionView) => void,
): Promise<AuctionResult> {
  const auctionId = `auction_${hash(`${plan.planId}|${allocation.category}`).slice(0, 16)}`;
  const mandate = createMandate(plan, allocation);
  const sellerView: SellerAuctionView = {
    auctionId,
    category: allocation.category,
    location: plan.location,
    scheduledFor: plan.scheduledFor,
    requirements: [...allocation.requirements],
  };
  onSellerView?.(structuredClone(sellerView));

  const eligibleSellers = sellers.filter(
    (seller) => seller.category === allocation.category,
  );
  if (eligibleSellers.length === 0) {
    throw new Error(`No sellers for ${allocation.category}.`);
  }

  // All commitments are collected before any bid is revealed.
  const commitments = await Promise.all(
    eligibleSellers.map(async (seller) =>
      sellerSubmitSealedBid(seller, sellerView),
    ),
  );
  const bids = commitments.map((sealed) => {
    const bid = sealed.reveal();
    if (hash(canonicalBid(bid)) !== sealed.commitment) {
      throw new Error(`Invalid bid reveal from ${sealed.sellerId}.`);
    }
    return bid;
  });

  const selected = pickWinner(bids, {
    requirements: allocation.requirements,
    maxBudgetCents: mandate.maxAmountCents,
  });
  if (!selected) {
    throw new Error(
      `No ${allocation.category} bid fits its scoped mandate.`,
    );
  }

  return {
    auctionId,
    category: allocation.category,
    mandate,
    commitments: commitments.map((item) => item.commitment),
    bids,
    winner: selected.bid,
    score: selected.score,
  };
}

export async function runAuctions(
  plan: PrivatePlan,
  sellers = MOCK_SELLERS,
  onSellerView?: (view: SellerAuctionView) => void,
): Promise<AuctionResult[]> {
  return Promise.all(
    plan.allocations.map((allocation) =>
      runCategoryAuction(plan, allocation, sellers, onSellerView),
    ),
  );
}
