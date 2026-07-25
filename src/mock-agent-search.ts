import type {
  AuctionResult,
  Category,
  DemoResult,
  PlanAllocation,
} from "./domain";
import { sha256Hex } from "./hash";

export interface MockAgentSearch {
  id: string;
  agentId: string;
  allocation: PlanAllocation;
  auction: AuctionResult;
  matchedTags: string[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function agentIdFor(
  planId: string,
  category: Category,
  index: number,
): string {
  const hash = sha256Hex(`pastel-agent:${planId}:${category}:${index}`);
  return `buyer_${category}_${hash.slice(0, 12)}`;
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
      agentId: agentIdFor(
        result.plan.planId,
        allocation.category,
        index,
      ),
      allocation,
      auction,
      matchedTags,
    };
  });
}
