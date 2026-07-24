import type {
  AuctionResult,
  Category,
  DemoResult,
  PlanAllocation,
} from "./domain";
import { sha256Hex } from "./hash";

export interface MockAgentSearch {
  id: string;
  wallet: `0x${string}`;
  allocation: PlanAllocation;
  auction: AuctionResult;
  matchedTags: string[];
}

export interface MockBuyerBid {
  id: string;
  wallet: `0x${string}`;
  kind: "user" | "market";
  amountCents: number;
}

export interface MockBuyerCompetition {
  search: MockAgentSearch;
  bids: MockBuyerBid[];
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function walletFor(
  planId: string,
  category: Category,
  index: number,
): `0x${string}` {
  const hash = sha256Hex(`pastel-agent:${planId}:${category}:${index}`);
  return `0x${hash.slice(0, 40)}`;
}

function marketBuyerWallet(
  searchWallet: `0x${string}`,
  index: number,
): `0x${string}` {
  const hash = sha256Hex(
    `pastel-market-buyer:${searchWallet}:${index}`,
  );
  return `0x${hash.slice(0, 40)}`;
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
      wallet: walletFor(
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

export function createMockBuyerCompetition(
  search: MockAgentSearch,
): MockBuyerCompetition {
  const finalAmount = search.auction.winner.amountCents;
  const bidderSequence = [
    marketBuyerWallet(search.wallet, 0),
    marketBuyerWallet(search.wallet, 1),
    search.wallet,
    marketBuyerWallet(search.wallet, 0),
    marketBuyerWallet(search.wallet, 1),
    search.wallet,
  ];
  const ratios = [0.62, 0.7, 0.78, 0.86, 0.93, 1];
  let previousAmount = 0;

  const bids = bidderSequence.map((wallet, index) => {
    const proposedAmount =
      index === ratios.length - 1
        ? finalAmount
        : Math.round((finalAmount * ratios[index]!) / 100) * 100;
    const remainingBids = ratios.length - index - 1;
    const highestSafeAmount = finalAmount - remainingBids * 100;
    const amountCents =
      index === ratios.length - 1
        ? finalAmount
        : Math.min(
            highestSafeAmount,
            Math.max(previousAmount + 100, proposedAmount),
          );

    previousAmount = amountCents;

    return {
      id: `${search.id}_buyer_bid_${index + 1}`,
      wallet,
      kind: wallet === search.wallet ? "user" : "market",
      amountCents,
    } satisfies MockBuyerBid;
  });

  return { search, bids };
}
