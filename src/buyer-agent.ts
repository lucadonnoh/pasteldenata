import type {
  AuctionParticipantKind,
  BuyerSubagentTrace,
  PlanAllocation,
  PublicListing,
  SpendMandate,
} from "./domain";
import { sha256Hex } from "./hash";

const VALUATION_GRANULARITY_CENTS = 50;

export interface EnglishAuctionBidder {
  id: string;
  kind: AuctionParticipantKind;
  debugMaxBidCents: number;
  willBid(askingPriceCents: number): boolean;
}

export interface RankedListing {
  listing: PublicListing;
  score: number;
  buyerMaxBidCents: number;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[-_]/g, " ");
}

function requirementMatches(
  listing: PublicListing,
  allocation: PlanAllocation,
): number {
  const requirements = allocation.requirements.map(normalize);
  const searchable = [
    listing.offering,
    ...listing.tags,
    ...Object.values(listing.attributes).flatMap((value) =>
      Array.isArray(value) ? value : [String(value)],
    ),
  ].map(normalize);

  return requirements.filter((requirement) =>
    searchable.some(
      (value) =>
        value.includes(requirement) || requirement.includes(value),
    ),
  ).length;
}

function roundDownToBidIncrement(value: number): number {
  return (
    Math.floor(value / VALUATION_GRANULARITY_CENTS) *
    VALUATION_GRANULARITY_CENTS
  );
}

export class AllocationBuyerSubagent {
  readonly id: string;
  readonly trace: BuyerSubagentTrace;

  constructor(
    private readonly allocation: PlanAllocation,
    readonly mandate: SpendMandate,
  ) {
    if (allocation.category !== mandate.category) {
      throw new Error("Buyer subagent allocation does not match its mandate.");
    }

    this.id = `buyer_${allocation.category}_${sha256Hex(mandate.id).slice(0, 12)}`;
    this.trace = {
      id: this.id,
      category: allocation.category,
      mandateId: mandate.id,
      requirements: [...allocation.requirements],
      priority: allocation.priority,
      strategy: "fit-adjusted-private-valuation",
    };
  }

  rankListings(listings: PublicListing[]): RankedListing[] {
    return listings
      .filter((listing) => listing.category === this.allocation.category)
      .map((listing) => {
        const matches = requirementMatches(listing, this.allocation);
        const affordability =
          22 *
          (1 -
            listing.estimatedMarketPriceCents /
              this.mandate.maxAmountCents);
        const score = listing.quality + matches * 8 + affordability;
        const qualityPremium = Math.max(0, listing.quality - 80) / 250;
        const fitPremium = Math.min(0.12, matches * 0.04);
        const listingValue = Math.round(
          listing.estimatedMarketPriceCents *
            (1 + qualityPremium + fitPremium),
        );
        const protectedMandate = Math.floor(
          this.mandate.maxAmountCents * 0.96,
        );
        const buyerMaxBidCents = Math.max(
          0,
          roundDownToBidIncrement(
            Math.min(protectedMandate, listingValue),
          ),
        );

        return { listing, score, buyerMaxBidCents };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.listing.estimatedMarketPriceCents -
            right.listing.estimatedMarketPriceCents,
      );
  }

  bidderFor(candidate: RankedListing): EnglishAuctionBidder {
    return {
      id: this.id,
      kind: "allocation-buyer-subagent",
      debugMaxBidCents: candidate.buyerMaxBidCents,
      willBid: (askingPriceCents) =>
        Number.isInteger(askingPriceCents) &&
        askingPriceCents > 0 &&
        askingPriceCents <= candidate.buyerMaxBidCents &&
        askingPriceCents <= this.mandate.maxAmountCents,
    };
  }
}
