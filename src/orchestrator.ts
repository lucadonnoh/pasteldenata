import type { DemoResult } from "./domain";
import { runAuctions } from "./auction";
import { normalizePlanForMockMarket } from "./market-plan";
import { settleMockPayments } from "./payments";
import {
  requireVerifiedPrivateTee,
  type PlannerResult,
  type PrivatePlanner,
} from "./planner";

async function runPurchase({
  plan,
  attestation,
}: PlannerResult): Promise<DemoResult> {
  const marketPlan = normalizePlanForMockMarket(plan);
  const auctions = await runAuctions(marketPlan);
  const receipts = settleMockPayments(marketPlan, auctions);
  const totalSpentCents = receipts.reduce(
    (sum, receipt) => sum + receipt.amountCents,
    0,
  );

  return {
    plan: marketPlan,
    attestation,
    auctions,
    receipts,
    totalSpentCents,
  };
}

export async function organizePrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
): Promise<DemoResult> {
  return runPurchase(await planner.plan(intent, now));
}

export async function organizeVerifiedPrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
): Promise<DemoResult> {
  const planned = await planner.plan(intent, now);
  requireVerifiedPrivateTee(planned.attestation);
  return runPurchase(planned);
}
