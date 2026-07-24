import "dotenv/config";
import { formatUsd, neuronToOg } from "./money.js";
import { organizePrivatePurchase } from "./orchestrator.js";
import {
  MockPrivatePlanner,
  ZeroGPrivatePlanner,
  type PrivatePlanner,
} from "./planner.js";

const argv = process.argv.slice(2);
const useMock = argv.includes("--mock");
const intent =
  argv.filter((arg) => arg !== "--mock").join(" ").trim() ||
  "Organize me a date tomorrow in Lisbon. My budget is $200.";

function createPlanner(): PrivatePlanner {
  if (useMock) return new MockPrivatePlanner();

  const key = process.env.ZEROG_KEY;
  if (!key) {
    throw new Error(
      "ZEROG_KEY is missing. Add it to .env or run npm run demo:mock.",
    );
  }

  return new ZeroGPrivatePlanner(
    key,
    process.env.ZEROG_BASE_URL,
    process.env.ZEROG_MODEL,
  );
}

function line(label: string, value: string) {
  console.log(`${label.padEnd(18)} ${value}`);
}

async function main() {
  console.log("\nPASTEL DE NATA — PRIVATE AGENTIC PAYMENTS\n");
  console.log(
    "The original intent is sent only to the private planner and is not printed or exposed to sellers.\n",
  );

  const result = await organizePrivatePurchase(createPlanner(), intent);

  console.log("PRIVATE PLAN");
  line("Plan", result.plan.occasionTitle);
  line("When", result.plan.scheduledFor);
  line("Where", result.plan.location);
  line("Hard cap", formatUsd(result.plan.totalBudgetCents));
  line("Planner", result.attestation.mode);
  line("TEE verified", String(result.attestation.teeVerified));
  if (result.attestation.provider) {
    line("Provider", result.attestation.provider);
  }
  const costOg = neuronToOg(result.attestation.costNeuron);
  if (costOg) line("Inference cost", `${costOg} testnet 0G`);

  console.log("\nSCOPED MANDATES");
  for (const allocation of result.plan.allocations) {
    line(
      allocation.category,
      `${formatUsd(allocation.maxBudgetCents)} · ${allocation.requirements.join(", ")}`,
    );
  }
  line("Contingency", formatUsd(result.plan.unallocatedBudgetCents));

  console.log("\nSEALED-BID AUCTIONS");
  for (const auction of result.auctions) {
    console.log(
      `\n${auction.category.toUpperCase()} · ${auction.bids.length} mock sellers · ${auction.commitments.length} commitments`,
    );
    for (const bid of auction.bids) {
      const marker = bid.sellerId === auction.winner.sellerId ? "✓" : " ";
      console.log(
        ` ${marker} ${bid.sellerName.padEnd(23)} ${formatUsd(bid.amountCents).padStart(8)}  ${bid.offering}`,
      );
    }
  }

  console.log("\nSIMULATED SETTLEMENT");
  for (const receipt of result.receipts) {
    line(
      receipt.category,
      `${formatUsd(receipt.amountCents)} → ${receipt.sellerName} · ${receipt.id}`,
    );
  }
  line("Total spent", formatUsd(result.totalSpentCents));
  line(
    "Unused",
    formatUsd(result.plan.totalBudgetCents - result.totalSpentCents),
  );
  line("Status", "all policy checks passed; no real payment sent");
  console.log();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDemo failed: ${message}\n`);
  process.exitCode = 1;
});
