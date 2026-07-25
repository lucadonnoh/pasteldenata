import type {
  AuctionResult,
  DemoResult,
  HederaSummary,
  PaymentReceipt,
  PrivatePlan,
} from "./domain";
import { runAuctions } from "./auction";
import { settleMockPayments } from "./payments";
import {
  requireVerifiedPrivateTee,
  type PlannerResult,
  type PrivatePlanner,
} from "./planner";

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

async function runPurchase(
  { plan, attestation }: PlannerResult,
  settler: Settler = mockSettler,
): Promise<DemoResult> {
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

export async function organizePrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
  settler?: Settler,
): Promise<DemoResult> {
  return runPurchase(await planner.plan(intent, now), settler);
}

export async function organizeVerifiedPrivatePurchase(
  planner: PrivatePlanner,
  intent: string,
  now = new Date(),
  settler?: Settler,
): Promise<DemoResult> {
  const planned = await planner.plan(intent, now);
  requireVerifiedPrivateTee(planned.attestation);
  return runPurchase(planned, settler);
}
