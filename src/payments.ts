import { createHash } from "node:crypto";
import type {
  AuctionResult,
  PaymentReceipt,
  PrivatePlan,
} from "./domain";

function receiptId(value: string): string {
  return `mockpay_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

/**
 * A mock settlement controller. The policy checks here are intentionally
 * independent from the model and auction agents.
 */
export function settleMockPayments(
  plan: PrivatePlan,
  auctions: AuctionResult[],
): PaymentReceipt[] {
  const seenMandates = new Set<string>();
  let total = 0;

  const receipts = auctions.map((auction) => {
    if (auction.mandate.planId !== plan.planId) {
      throw new Error("A mandate belongs to a different plan.");
    }
    if (seenMandates.has(auction.mandate.id)) {
      throw new Error("A mandate cannot be spent twice.");
    }
    seenMandates.add(auction.mandate.id);
    if (auction.category !== auction.mandate.category) {
      throw new Error("The winner does not match the mandate category.");
    }
    if (auction.winner.amountCents > auction.mandate.maxAmountCents) {
      throw new Error("A winner exceeded its category mandate.");
    }

    total += auction.winner.amountCents;
    if (total > plan.totalBudgetCents) {
      throw new Error("Atomic settlement would exceed the global budget.");
    }

    return {
      id: receiptId(
        `${plan.planId}|${auction.mandate.id}|${auction.winner.sellerId}`,
      ),
      planId: plan.planId,
      mandateId: auction.mandate.id,
      sellerId: auction.winner.sellerId,
      sellerName: auction.winner.sellerName,
      category: auction.category,
      amountCents: auction.winner.amountCents,
      currency: plan.currency,
      status: "simulated-settled" as const,
    };
  });

  return receipts;
}
