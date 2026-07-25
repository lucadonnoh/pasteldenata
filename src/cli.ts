import "dotenv/config";
import { sellersForLocation } from "./catalog";
import { connectHedera, type HederaContext } from "./hedera/client";
import { ensureInfra } from "./hedera/infra";
import { runMarket, type MarketBuyer } from "./hedera/market";
import {
  HederaPartialSettlementError,
  settleOnHedera,
} from "./hedera/settle";
import { settleWithSwarm } from "./hedera/swarm";
import { formatUsd, neuronToOg } from "./money";
import { organizePrivatePurchase, type Settler } from "./orchestrator";
import {
  MockPrivatePlanner,
  ZeroGPrivatePlanner,
  type PrivatePlanner,
} from "./planner";
import {
  MockAgentBook,
  WorldGateway,
  type AuctionPass,
} from "./server/world-gateway";

const argv = process.argv.slice(2);
const useMock = argv.includes("--mock");
const useSimpleHedera = argv.includes("--hedera-simple");
const useLive = argv.includes("--hedera-live");
const useMarket = argv.includes("--market");
const useHedera =
  argv.includes("--hedera") || useSimpleHedera || useLive || useMarket;
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

function line(label: string, value: string): void {
  console.log(`${label.padEnd(18)} ${value}`);
}

const MARKET_PERSONAS = [
  {
    name: "Ana",
    mockHumanSeed: "ana",
    intent:
      "Plan a romantic anniversary evening tomorrow in Lisbon with dinner and a film. My budget is $200.",
  },
  {
    name: "Bruno",
    mockHumanSeed: "bruno",
    intent:
      "Organize a fun first date tomorrow evening in Lisbon. My budget is $180.",
  },
  {
    name: "Chiara",
    intent:
      "Organize a special dinner and cinema night for two tomorrow in Lisbon. My budget is $170.",
  },
  {
    name: "Dario",
    mockHumanSeed: "dario",
    intent:
      "Plan a cozy evening for two tomorrow in Lisbon. My budget is $160.",
  },
  {
    name: "Emma",
    intent:
      "Organize a memorable date night tomorrow in Lisbon. My budget is $150.",
  },
];

async function marketMain(): Promise<void> {
  console.log("\nPASTEL DE NATA — OPEN MARKET\n");
  console.log(
    "Five private mandates, one authenticated public market. Each intent goes only to its own private planner.\n",
  );

  const ctx = connectHedera();
  try {
    const buyers: MarketBuyer[] = await Promise.all(
      MARKET_PERSONAS.map(async (persona) => {
        const { plan } = await createPlanner().plan(persona.intent, new Date());
        console.log(
          `${persona.name.padEnd(8)} plan ready · ${plan.allocations
            .map((allocation) => allocation.category)
            .join(", ")} · hard cap ${formatUsd(plan.totalBudgetCents)}`,
        );
        return { name: persona.name, plan };
      }),
    );
    const marketCities = new Set(
      buyers.map(
        (buyer) => sellersForLocation(buyer.plan.location)[0]?.city,
      ),
    );
    if (marketCities.size !== 1) {
      throw new Error(
        "A shared market run requires every buyer plan to use the same city.",
      );
    }
    const infra = await ensureInfra(
      ctx,
      sellersForLocation(buyers[0]?.plan.location ?? "Lisbon"),
    );
    console.log();

    // Explicit demo identities: Ana, Bruno, and Dario are mock World-backed;
    // Chiara and Emma are deliberately unverified and fail protected policy.
    const demoBook = new MockAgentBook();
    const demoIdentityByBuyer = new Map<string, string>();
    MARKET_PERSONAS.forEach((persona, index) => {
      const address = `0x${String(index + 1).padStart(40, "0")}`;
      demoIdentityByBuyer.set(persona.name, address);
      if ("mockHumanSeed" in persona) {
        demoBook.registerAgent(address, persona.mockHumanSeed);
      }
      console.log(
        `${persona.name.padEnd(8)} World · ${
          "mockHumanSeed" in persona ? "mock human-backed" : "unverified"
        }`,
      );
    });
    const gateway = new WorldGateway(demoBook);
    const passByAuctionAndWallet = new Map<string, AuctionPass>();
    const market = await runMarket(buyers, { ...ctx, infra }, {
      authorizationIssuerPublicKey: gateway.issuerPublicKey,
      authorizePurchase: async ({ itemId, buyerName, leafWallet }) => {
        const key = `${itemId}|${leafWallet}`;
        const existing = passByAuctionAndWallet.get(key);
        if (existing) return { ok: true, pass: existing };
        const identityAgent = demoIdentityByBuyer.get(buyerName);
        if (!identityAgent) {
          return { ok: false, reason: "No demo World identity." };
        }
        const enrollment = await gateway.enroll({
          auctionId: itemId,
          identityAgent,
          leafWallet,
        });
        if (!enrollment.ok || !enrollment.pass) {
          return {
            ok: false,
            reason: enrollment.reason ?? "Demo World enrollment was refused.",
          };
        }
        passByAuctionAndWallet.set(key, enrollment.pass);
        return { ok: true, pass: enrollment.pass };
      },
    });
    for (const buyer of market.buyers) {
      const spent = buyer.outcomes.reduce(
        (sum, outcome) => sum + outcome.result.amountCents,
        0,
      );
      console.log(
        `\n${buyer.name.toUpperCase()} · budget ${formatUsd(
          buyer.plan.totalBudgetCents,
        )} · spent ${formatUsd(spent)}`,
      );
      for (const outcome of buyer.outcomes) {
        if (outcome.result.lost) {
          line(
            outcome.category,
            `lost — outbid beyond mandate (cap ${formatUsd(outcome.capCents)})`,
          );
          continue;
        }
        line(
          outcome.category,
          `${formatUsd(outcome.result.amountCents)} → ${
            outcome.result.sellerName
          } · ${outcome.result.offering} · claim NFT #${
            outcome.result.claimNftSerial
          }`,
        );
        line("Wallet recovery", outcome.walletRecoveryPath);
        if (outcome.hashscanUrl) line("", outcome.hashscanUrl);
      }
    }

    console.log("\nCONTENTION · authenticated public bid wars");
    for (const item of market.contention) {
      if (item.bids === 0) continue;
      line(
        item.sellerName,
        `${item.offering} · floor ${formatUsd(item.floorCents)} · ${
          item.bids
        } bids · ${item.bidders} agents · ${
          item.soldForCents
            ? `sold ${formatUsd(item.soldForCents)}`
            : "unsold"
        }`,
      );
      line("", item.topicUrl);
    }
    console.log();
  } finally {
    ctx.client.close();
  }
}

async function main(): Promise<void> {
  if (useMarket) {
    await marketMain();
    return;
  }

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
      settler = async (plan, auctions) => {
        const infra = await ensureInfra(
          ctx,
          sellersForLocation(plan.location),
        );
        console.log(
          `Hedera testnet ready · NATA ${infra.paymentTokenId} · claims ${infra.claimTokenId}\n`,
        );
        return useSimpleHedera
          ? settleOnHedera(plan, auctions, { ...ctx, infra })
          : settleWithSwarm(
              plan,
              auctions,
              { ...ctx, infra },
              { live: useLive },
            );
      };
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
    if (costOg) line("Inference cost", `${costOg} 0G`);

    console.log("\nSCOPED MANDATES");
    for (const allocation of result.plan.allocations) {
      line(
        allocation.category,
        `${formatUsd(
          allocation.maxBudgetCents,
        )} · ${allocation.requirements.join(", ")}`,
      );
    }
    line("Contingency", formatUsd(result.plan.unallocatedBudgetCents));

    console.log("\nALLOCATION BUYER SUBAGENTS · ENGLISH AUCTIONS");
    for (const auction of result.auctions) {
      console.log(
        `\n${auction.category.toUpperCase()} · ${
          auction.buyerSubagent.id
        } · mandate ${formatUsd(
          auction.mandate.maxAmountCents,
        )} · ${auction.listingAuctions.length} listing auction${
          auction.listingAuctions.length === 1 ? "" : "s"
        }`,
      );
      for (const listingAuction of auction.listingAuctions) {
        const marker = listingAuction.status === "won" ? "✓" : "×";
        console.log(
          ` ${marker} ${listingAuction.listing.sellerName} · ${listingAuction.listing.offering}`,
        );
        console.log(
          `   floor ${formatUsd(
            listingAuction.debugSellerFloorPriceCents,
          )} · ${listingAuction.steps.length} ascending steps · ${
            listingAuction.clearingPriceCents === null
              ? listingAuction.status
              : `cleared ${formatUsd(
                  listingAuction.clearingPriceCents,
                )} (${listingAuction.status})`
          }`,
        );
      }
    }

    console.log(
      result.hedera ? "\nHEDERA SETTLEMENT" : "\nSIMULATED SETTLEMENT",
    );
    for (const receipt of result.receipts) {
      line(
        receipt.category,
        `${formatUsd(receipt.amountCents)} → ${receipt.sellerName} · ${
          receipt.offering
        }${
          receipt.claimNftSerial === undefined
            ? ` · ${receipt.id}`
            : ` · claim NFT #${receipt.claimNftSerial}`
        }`,
      );
      if (receipt.leafWalletRecoveryPath) {
        line("Wallet recovery", receipt.leafWalletRecoveryPath);
      }
      if (
        receipt.liveBids !== undefined &&
        receipt.liveOpeningCents !== undefined
      ) {
        line(
          "",
          `${receipt.liveBids} authenticated on-chain bids · ${formatUsd(
            receipt.liveOpeningCents,
          )} → ${formatUsd(receipt.amountCents)}`,
        );
      }
      if (receipt.hashscanUrl) line("", receipt.hashscanUrl);
      if (receipt.auctionTopicUrl) line("", receipt.auctionTopicUrl);
    }
    line("Total spent", formatUsd(result.totalSpentCents));
    line(
      "Unused",
      formatUsd(result.plan.totalBudgetCents - result.totalSpentCents),
    );
    line(
      "Status",
      result.hedera
        ? "policy checks passed; reconciled atomic HTS settlements"
        : "all policy checks passed; no real payment sent",
    );
    console.log();
  } finally {
    hederaCtx?.client.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof HederaPartialSettlementError) {
    console.error(`\n${error.message}`);
    for (const receipt of error.receipts) {
      console.error(
        `CONFIRMED ${receipt.category}: ${receipt.transactionId} (${formatUsd(
          receipt.amountCents,
        )})`,
      );
    }
    for (const failure of error.failures) {
      console.error(`FAILED ${failure.category}: ${failure.message}`);
    }
    console.error();
  } else {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nDemo failed: ${message}\n`);
  }
  process.exitCode = 1;
});
