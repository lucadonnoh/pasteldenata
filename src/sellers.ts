import type { EnglishAuctionBidder } from "./buyer-agent";
import { MOCK_SELLERS, toPublicListing } from "./catalog";
import type {
  EnglishAuctionStep,
  ListingEnglishAuction,
  PublicListing,
  Seller,
  SellerAuctionView,
  SellerInventoryItem,
} from "./domain";
import { sha256Hex } from "./hash";

export const MINIMUM_INCREMENT_CENTS = 50;

function deterministicJitter(seed: string): number {
  const sample = Number.parseInt(sha256Hex(seed).slice(0, 8), 16);
  return ((sample % 61) - 30) / 1000;
}

function roundToIncrement(value: number): number {
  return (
    Math.round(value / MINIMUM_INCREMENT_CENTS) *
    MINIMUM_INCREMENT_CENTS
  );
}

function mockRivalBidders(
  seller: Seller,
  item: SellerInventoryItem,
  view: SellerAuctionView,
): EnglishAuctionBidder[] {
  const count = 2 + Math.round(item.marketHeat * 3);

  return Array.from({ length: count }, (_, index) => {
    const id = `mock-rival-${index + 1}`;
    const jitter = deterministicJitter(
      `${seller.privateSalt}|${item.id}|${view.auctionId}|${id}`,
    );
    const marketFraction =
      0.62 + item.marketHeat * 0.28 + index * 0.035 + jitter;
    const debugMaxBidCents = Math.max(
      100,
      roundToIncrement(item.estimatedMarketPriceCents * marketFraction),
    );

    return {
      id,
      kind: "mock-rival",
      debugMaxBidCents,
      willBid: (askingPriceCents) =>
        askingPriceCents <= debugMaxBidCents,
    };
  });
}

function tieBreak(auctionId: string, left: string, right: string): number {
  return sha256Hex(`${auctionId}|${left}`).localeCompare(
    sha256Hex(`${auctionId}|${right}`),
  );
}

function priceSequence(floor: number, clearingPrice: number): number[] {
  const prices: number[] = [];
  for (
    let price = floor;
    price <= clearingPrice;
    price += MINIMUM_INCREMENT_CENTS
  ) {
    prices.push(price);
  }
  if (prices.at(-1) !== clearingPrice) prices.push(clearingPrice);
  return prices;
}

function buildSteps(
  auctionId: string,
  participants: EnglishAuctionBidder[],
  floorPriceCents: number,
  clearingPriceCents: number,
  winnerId: string,
): EnglishAuctionStep[] {
  let previouslyActive = participants.map((participant) => participant.id);

  return priceSequence(floorPriceCents, clearingPriceCents).map(
    (askingPriceCents, index) => {
      const active = participants
        .filter((participant) => participant.willBid(askingPriceCents))
        .sort((left, right) => tieBreak(auctionId, left.id, right.id));
      const activeBidderIds = active.map((participant) => participant.id);
      const droppedBidderIds = previouslyActive.filter(
        (bidderId) => !activeBidderIds.includes(bidderId),
      );
      const leadingBidderId =
        askingPriceCents === clearingPriceCents
          ? winnerId
          : (active[index % Math.max(1, active.length)]?.id ?? null);
      previouslyActive = activeBidderIds;

      return {
        sequence: index + 1,
        askingPriceCents,
        activeBidderIds,
        droppedBidderIds,
        leadingBidderId,
      };
    },
  );
}

export class MockSellerAuctionHouse {
  private readonly soldListingIds = new Set<string>();

  constructor(private readonly seller: Seller) {}

  get id(): string {
    return this.seller.id;
  }

  get category(): Seller["category"] {
    return this.seller.category;
  }

  listAvailableInventory(): PublicListing[] {
    return this.seller.inventory
      .filter((item) => !this.soldListingIds.has(item.id))
      .map((item) => toPublicListing(this.seller, item));
  }

  hasAvailableListing(listingId: string): boolean {
    return (
      !this.soldListingIds.has(listingId) &&
      this.seller.inventory.some((item) => item.id === listingId)
    );
  }

  openEnglishAuction(
    view: SellerAuctionView,
    buyerSubagent: EnglishAuctionBidder,
    listingScore = 0,
  ): ListingEnglishAuction {
    const item = this.seller.inventory.find(
      (candidate) => candidate.id === view.listingId,
    );
    if (!item) {
      throw new Error(
        `${this.seller.name} does not own listing ${view.listingId}.`,
      );
    }
    if (this.soldListingIds.has(item.id)) {
      throw new Error(`Listing ${item.id} is no longer available.`);
    }
    if (view.category !== this.seller.category) {
      throw new Error("Seller received an auction for the wrong category.");
    }
    if (buyerSubagent.kind !== "allocation-buyer-subagent") {
      throw new Error("The primary bidder must be a buyer subagent.");
    }

    const participants = [
      buyerSubagent,
      ...mockRivalBidders(this.seller, item, view),
    ];
    const eligible = participants
      .filter((participant) =>
        participant.willBid(item.floorPriceCents),
      )
      .sort(
        (left, right) =>
          right.debugMaxBidCents - left.debugMaxBidCents ||
          tieBreak(view.auctionId, left.id, right.id),
      );
    const winner = eligible[0];

    if (!winner) {
      return {
        auctionId: view.auctionId,
        listing: toPublicListing(this.seller, item),
        listingScore,
        status: "floor-not-met",
        buyerSubagentId: buyerSubagent.id,
        buyerMaxBidCents: buyerSubagent.debugMaxBidCents,
        debugSellerFloorPriceCents: item.floorPriceCents,
        minimumIncrementCents: MINIMUM_INCREMENT_CENTS,
        participants: participants.map((participant) => ({
          bidderId: participant.id,
          bidderKind: participant.kind,
          debugMaxBidCents: participant.debugMaxBidCents,
        })),
        steps: [],
        winningBidderId: null,
        clearingPriceCents: null,
      };
    }

    const runnerUp = eligible[1];
    const clearingPriceCents = Math.max(
      item.floorPriceCents,
      Math.min(
        winner.debugMaxBidCents,
        runnerUp
          ? runnerUp.debugMaxBidCents + MINIMUM_INCREMENT_CENTS
          : item.floorPriceCents,
      ),
    );
    this.soldListingIds.add(item.id);

    return {
      auctionId: view.auctionId,
      listing: toPublicListing(this.seller, item),
      listingScore,
      status: winner.id === buyerSubagent.id ? "won" : "lost",
      buyerSubagentId: buyerSubagent.id,
      buyerMaxBidCents: buyerSubagent.debugMaxBidCents,
      debugSellerFloorPriceCents: item.floorPriceCents,
      minimumIncrementCents: MINIMUM_INCREMENT_CENTS,
      participants: participants.map((participant) => ({
        bidderId: participant.id,
        bidderKind: participant.kind,
        debugMaxBidCents: participant.debugMaxBidCents,
      })),
      steps: buildSteps(
        view.auctionId,
        participants,
        item.floorPriceCents,
        clearingPriceCents,
        winner.id,
      ),
      winningBidderId: winner.id,
      clearingPriceCents,
    };
  }
}

export function createMockSellerAuctionHouses(
  sellers: Seller[] = MOCK_SELLERS,
): MockSellerAuctionHouse[] {
  return sellers.map(
    (seller) => new MockSellerAuctionHouse(structuredClone(seller)),
  );
}
