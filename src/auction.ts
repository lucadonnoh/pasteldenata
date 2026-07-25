import { AllocationBuyerSubagent } from "./buyer-agent";
import type {
  AuctionResult,
  PlanAllocation,
  PrivatePlan,
  SellerAuctionView,
  SpendMandate,
} from "./domain";
import { sha256Hex } from "./hash";
import {
  createMockSellerAuctionHouses,
  type MockSellerAuctionHouse,
} from "./sellers";
import { sellersForLocation } from "./catalog";

function createMandate(
  plan: PrivatePlan,
  allocation: PlanAllocation,
): SpendMandate {
  return {
    id: `mandate_${sha256Hex(`${plan.planId}|${allocation.category}`).slice(0, 16)}`,
    planId: plan.planId,
    category: allocation.category,
    maxAmountCents: allocation.maxBudgetCents,
    currency: "USD",
    expiresAt: `${plan.scheduledFor}T23:59:59Z`,
  };
}

export async function runCategoryAuction(
  plan: PrivatePlan,
  allocation: PlanAllocation,
  sellers: MockSellerAuctionHouse[] = createMockSellerAuctionHouses(
    sellersForLocation(plan.location),
  ),
  onSellerView?: (view: SellerAuctionView) => void,
): Promise<AuctionResult> {
  const auctionId = `auction_${sha256Hex(
    `${plan.planId}|${allocation.category}`,
  ).slice(0, 16)}`;
  const mandate = createMandate(plan, allocation);
  const buyerSubagent = new AllocationBuyerSubagent(allocation, mandate);
  const categorySellers = sellers.filter(
    (seller) => seller.category === allocation.category,
  );
  const candidates = buyerSubagent.rankListings(
    categorySellers.flatMap((seller) => seller.listAvailableInventory()),
  );

  if (candidates.length === 0) {
    throw new Error(`No seller inventory for ${allocation.category}.`);
  }

  const listingAuctions = [];
  for (const [index, candidate] of candidates.entries()) {
    const seller = categorySellers.find(
      (entry) => entry.id === candidate.listing.sellerId,
    );
    if (
      !seller ||
      !seller.hasAvailableListing(candidate.listing.id)
    ) {
      continue;
    }

    const view: SellerAuctionView = {
      auctionId: `${auctionId}_${index + 1}`,
      listingId: candidate.listing.id,
      category: allocation.category,
      location: plan.location,
      scheduledFor: plan.scheduledFor,
      requirements: [...allocation.requirements],
    };
    onSellerView?.(structuredClone(view));

    const listingAuction = seller.openEnglishAuction(
      view,
      buyerSubagent.bidderFor(candidate),
      candidate.score,
    );
    listingAuctions.push(listingAuction);

    if (
      listingAuction.status === "won" &&
      listingAuction.clearingPriceCents !== null
    ) {
      if (
        listingAuction.clearingPriceCents >
        mandate.maxAmountCents
      ) {
        throw new Error("Auction clearing price exceeded its mandate.");
      }

      return {
        auctionId,
        category: allocation.category,
        buyerSubagent: buyerSubagent.trace,
        mandate,
        listingAuctions,
        winner: {
          auctionId: listingAuction.auctionId,
          listingId: listingAuction.listing.id,
          sellerId: listingAuction.listing.sellerId,
          sellerName: listingAuction.listing.sellerName,
          offering: listingAuction.listing.offering,
          amountCents: listingAuction.clearingPriceCents,
          quality: listingAuction.listing.quality,
          tags: listingAuction.listing.tags,
          attributes: listingAuction.listing.attributes,
        },
        score: candidate.score,
      };
    }
  }

  throw new Error(
    `The ${allocation.category} buyer subagent did not win any affordable inventory.`,
  );
}

export async function runAuctions(
  plan: PrivatePlan,
  sellers = createMockSellerAuctionHouses(
    sellersForLocation(plan.location),
  ),
  onSellerView?: (view: SellerAuctionView) => void,
): Promise<AuctionResult[]> {
  return Promise.all(
    plan.allocations.map((allocation) =>
      runCategoryAuction(plan, allocation, sellers, onSellerView),
    ),
  );
}
