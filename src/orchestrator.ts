import type { DemoResult } from "./domain.js";
import { runAuctions } from "./auction.js";
import { settleMockPayments } from "./payments.js";
import type { PrivatePlanner } from "./planner.js";

export async function organizePrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
): Promise<DemoResult> {
  const { plan, attestation } = await planner.plan(intent, now);
  const auctions = await runAuctions(plan);
  const receipts = settleMockPayments(plan, auctions);
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
  };
}
