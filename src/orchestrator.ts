import type { DemoResult } from "./domain";
import { runAuctions } from "./auction";
import { settleMockPayments } from "./payments";
import type { PrivatePlanner } from "./planner";

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
