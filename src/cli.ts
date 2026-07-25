import "dotenv/config";
import { sellersForLocation } from "./catalog";
import { connectHedera } from "./hedera/client";
import { ensureInfra } from "./hedera/infra";
import { runMarket, type MarketBuyer } from "./hedera/market";
import { HederaPartialSettlementError } from "./hedera/settle";
import { formatUsd } from "./money";
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

const useMockPlanner = process.argv.slice(2).includes("--mock");

function createPlanner(): PrivatePlanner {
  if (useMockPlanner) return new MockPrivatePlanner();

  const key = process.env.ZEROG_KEY;
  if (!key) {
    throw new Error(
      "ZEROG_KEY is missing. Add it to .env or run npm run demo:market:mock.",
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

async function main(): Promise<void> {
  console.log("\nPASTEL DE NATA — HEDERA OPEN MARKET\n");
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

    // Explicit demo identities: three rivals are mock World-backed and two
    // deliberately remain unverified so protected seller policy is visible.
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
