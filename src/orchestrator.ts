import type {
  AuctionResult,
  DemoResult,
  HederaSummary,
  PaymentReceipt,
  PrivatePlan,
} from "./domain.js";
import { runAuctions } from "./auction.js";
import { settleMockPayments } from "./payments.js";
import type { PrivatePlanner } from "./planner.js";

export interface SettlementResult {
  receipts: PaymentReceipt[];
  hedera?: HederaSummary;
}

export type Settler = (
  plan: PrivatePlan,
  auctions: AuctionResult[],
) => Promise<SettlementResult>;

const mockSettler: Settler = async (plan, auctions) => ({
  receipts: settleMockPayments(plan, auctions),
});

export async function organizePrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
  settler: Settler = mockSettler,
): Promise<DemoResult> {
  const { plan, attestation } = await planner.plan(intent, now);
  const auctions = await runAuctions(plan);
  const { receipts, hedera } = await settler(plan, auctions);
  const totalSpentCents = receipts.reduce(
    (sum, receipt) => sum + receipt.amountCents,
    0,
  );

  return {
    plan,
    attestation,
    auctions,
    receipts,
    totalSpentCents,
    ...(hedera ? { hedera } : {}),
  };
}
