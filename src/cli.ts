import "dotenv/config";
import { MOCK_SELLERS } from "./catalog.js";
import { connectHedera, type HederaContext } from "./hedera/client.js";
import { ensureInfra } from "./hedera/infra.js";
import { settleOnHedera } from "./hedera/settle.js";
import { settleWithSwarm } from "./hedera/swarm.js";
import { formatUsd, neuronToOg } from "./money.js";
import { organizePrivatePurchase, type Settler } from "./orchestrator.js";
import {
  MockPrivatePlanner,
  ZeroGPrivatePlanner,
  type PrivatePlanner,
} from "./planner.js";

const argv = process.argv.slice(2);
const useMock = argv.includes("--mock");
const useSimpleHedera = argv.includes("--hedera-simple");
const useHedera = argv.includes("--hedera") || useSimpleHedera;
const intent =
  argv
    .filter((arg) => !arg.startsWith("--"))
    .join(" ")
    .trim() || "Organize me a date tomorrow in Lisbon. My budget is $200.";

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

  let hederaCtx: HederaContext | undefined;
  try {
    let settler: Settler | undefined;
    if (useHedera) {
      hederaCtx = connectHedera();
      const ctx = hederaCtx;
      const infra = await ensureInfra(ctx, MOCK_SELLERS);
      console.log(
        `Hedera testnet ready · NATA ${infra.paymentTokenId} · claims ${infra.claimTokenId}\n`,
      );
      const settle = useSimpleHedera ? settleOnHedera : settleWithSwarm;
      settler = (plan, auctions) => settle(plan, auctions, { ...ctx, infra });
    }

    const result = await organizePrivatePurchase(
      createPlanner(),
      intent,
      new Date(),
      settler,
    );

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

    console.log(
      result.hedera ? "\nHEDERA SETTLEMENT" : "\nSIMULATED SETTLEMENT",
    );
    for (const receipt of result.receipts) {
      line(
        receipt.category,
        `${formatUsd(receipt.amountCents)} → ${receipt.sellerName}${
          receipt.claimNftSerial === undefined
            ? ` · ${receipt.id}`
            : ` · claim NFT #${receipt.claimNftSerial}`
        }`,
      );
      if (receipt.escrowAccountId && receipt.auctionTopicUrl) {
        line("", `agent wallet ${receipt.escrowAccountId}`);
      }
      if (receipt.hashscanUrl) {
        line("", receipt.hashscanUrl);
      }
      if (receipt.auctionTopicUrl) {
        line("", receipt.auctionTopicUrl);
      }
    }
    line("Total spent", formatUsd(result.totalSpentCents));
    line(
      "Unused",
      formatUsd(result.plan.totalBudgetCents - result.totalSpentCents),
    );
    if (result.hedera) {
      line("Status", "all policy checks passed; settled with atomic HTS transfers");
      if (result.hedera.topicUrl) {
        line("Auction log", result.hedera.topicUrl);
      }
      if (result.hedera.clearingAccountId) {
        line("Clearing", result.hedera.clearingAccountId);
      }
      line("NATA token", result.hedera.paymentTokenId);
      line("Claim NFTs", result.hedera.claimTokenId);
      line("Buyer wallet", result.hedera.buyerAccountId);
    } else {
      line("Status", "all policy checks passed; no real payment sent");
    }
    console.log();
  } finally {
    hederaCtx?.client.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nDemo failed: ${message}\n`);
  process.exitCode = 1;
});
