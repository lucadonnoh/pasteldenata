import type {
  AuctionResult,
  DemoResult,
  ListingEnglishAuction,
  PlanAllocation,
} from "./domain";

export interface MockAgentSearch {
  id: string;
  agentId: string;
  allocation: PlanAllocation;
  auction: AuctionResult;
  matchedTags: string[];
}

export interface MockAuctionReplay {
  id: string;
  attemptNumber: number;
  search: MockAgentSearch;
  listingAuction: ListingEnglishAuction;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createMockAgentSearches(
  result: DemoResult,
): MockAgentSearch[] {
  return result.plan.allocations.map((allocation, index) => {
    const auction = result.auctions.find(
      (candidate) => candidate.category === allocation.category,
    );

    if (!auction) {
      throw new Error(
        `Missing mock market result for ${allocation.category}.`,
      );
    }

    const normalizedRequirements = allocation.requirements.map(normalize);
    const matchedTags = auction.winner.tags.filter((tag) => {
      const normalizedTag = normalize(tag);
      return normalizedRequirements.some(
        (requirement) =>
          requirement.includes(normalizedTag) ||
          normalizedTag.includes(requirement),
      );
    });

    return {
      id: `agent_${allocation.category}_${index + 1}`,
      agentId: auction.buyerSubagent.id,
      allocation,
      auction,
      matchedTags,
    };
  });
}

export function createMockAuctionReplays(
  searches: MockAgentSearch[],
): MockAuctionReplay[] {
  return searches.flatMap((search) =>
    search.auction.listingAuctions.map((listingAuction, index) => ({
      id: listingAuction.auctionId,
      attemptNumber: index + 1,
      search,
      listingAuction,
    })),
  );
}
