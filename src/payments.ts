import type {
  AuctionResult,
  PaymentReceipt,
  PrivatePlan,
} from "./domain";
import { sha256Hex } from "./hash";

function receiptId(value: string): string {
  return `mockpay_${sha256Hex(value).slice(0, 20)}`;
}

/**
 * Policy checks that are intentionally independent from the model and auction
 * agents. Both the mock settlement and the Hedera settlement run these before
 * moving any value; on Hedera the budget cap is additionally enforced by the
 * ledger itself.
 */
export function validateSettlement(
  plan: PrivatePlan,
  auctions: AuctionResult[],
): void {
  const seenMandates = new Set<string>();
  let total = 0;

  for (const auction of auctions) {
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
    if (
      !Number.isSafeInteger(auction.winner.amountCents) ||
      auction.winner.amountCents <= 0
    ) {
      throw new Error("A winner amount must be a positive integer number of cents.");
    }
    if (auction.winner.amountCents > auction.mandate.maxAmountCents) {
      throw new Error("A winner exceeded its category mandate.");
    }

    total += auction.winner.amountCents;
    if (total > plan.totalBudgetCents) {
      throw new Error("Atomic settlement would exceed the global budget.");
    }
  }
}

export function settleMockPayments(
  plan: PrivatePlan,
  auctions: AuctionResult[],
): PaymentReceipt[] {
  validateSettlement(plan, auctions);

  const receipts = auctions.map((auction) => {
    return {
      id: receiptId(
        `${plan.planId}|${auction.mandate.id}|${auction.winner.sellerId}`,
      ),
      planId: plan.planId,
      mandateId: auction.mandate.id,
      sellerId: auction.winner.sellerId,
      sellerName: auction.winner.sellerName,
      listingId: auction.winner.listingId,
      offering: auction.winner.offering,
      category: auction.category,
      amountCents: auction.winner.amountCents,
      currency: plan.currency,
      status: "simulated-settled" as const,
    };
  });

  return receipts;
}
