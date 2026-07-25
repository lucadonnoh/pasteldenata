import { randomUUID } from "node:crypto";
import { MOCK_SELLERS } from "../catalog";
import type { AuctionResult, PrivatePlan } from "../domain";
import { connectHedera } from "../hedera/client";
import { ensureInfra } from "../hedera/infra";
import { runMarket, type MarketBuyer } from "../hedera/market";
import { settleWithSwarm } from "../hedera/swarm";
import type { SettlementResult } from "../orchestrator";
import { MockPrivatePlanner } from "../planner";

export type SettlementMode = "live" | "market";

export interface JobListing {
  itemId: string;
  topicId: string;
  category: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  floorCents: number;
  sold: boolean;
}

export interface SettlementJob {
  id: string;
  status: "running" | "done" | "failed";
  mode: SettlementMode;
  /** Real leaf wallets, streamed as they are created and funded. */
  agents: Array<{ category: string; accountId: string; buyerName: string }>;
  /** Live mode: one auction topic per category. */
  auctions: Array<{ category: string; auctionId: string; topicId: string }>;
  /** Market mode: scarce listings, floor = the seller's price. */
  listings: JobListing[];
  /** Rival buyer personas competing against the user (market mode). */
  rivals: string[];
  settledCategories: string[];
  /** Market mode: categories where the user's agent was outbid everywhere. */
  lostCategories: string[];
  result?: SettlementResult;
  error?: string;
  createdAt: number;
}

export const USER_BUYER_NAME = "You";

const RIVAL_PERSONAS = [
  { name: "Bruno", intent: "Organize me a date tomorrow in Lisbon. My budget is $180." },
  { name: "Chiara", intent: "Organize me a date tomorrow in Lisbon. My budget is $165." },
  { name: "Emma", intent: "Organize me a date tomorrow in Lisbon. My budget is $150." },
];

// Survives dev-server module reloads between the POST and the polling GETs.
const store = globalThis as unknown as {
  __pastelSettlementJobs?: Map<string, SettlementJob>;
};
const jobs: Map<string, SettlementJob> = (store.__pastelSettlementJobs ??=
  new Map());

const JOB_TTL_MS = 60 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

export function startSettlementJob(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  mode: SettlementMode,
): SettlementJob {
  prune();
  const job: SettlementJob = {
    id: randomUUID(),
    status: "running",
    mode,
    agents: [],
    auctions: [],
    listings: [],
    rivals: mode === "market" ? RIVAL_PERSONAS.map((p) => p.name) : [],
    settledCategories: [],
    lostCategories: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  void execute(job, plan, auctions);
  return job;
}

const LEAF_FLOAT_HBAR = 2;
const RUN_MARGIN_HBAR = 6;

/**
 * Refuse to start a run the operator cannot afford: a mid-run failure kills
 * agents before they can return their fee float, stranding it in dead
 * wallets forever. Failing here costs nothing.
 */
async function assertOperatorRunway(leafCount: number): Promise<void> {
  const response = await fetch(
    "https://testnet.mirrornode.hedera.com/api/v1/accounts/" +
      process.env.HEDERA_OPERATOR_ID,
  );
  if (!response.ok) return; // Mirror down; let the run try.
  const data = (await response.json()) as { balance?: { balance?: number } };
  const hbar = (data.balance?.balance ?? 0) / 1e8;
  const needed = leafCount * LEAF_FLOAT_HBAR + RUN_MARGIN_HBAR;
  if (hbar < needed) {
    throw new Error(
      `Operator has ${hbar.toFixed(1)} HBAR but this run needs ~${needed}. ` +
        "Refill at portal.hedera.com/faucet (100 HBAR daily) before running.",
    );
  }
}

async function execute(
  job: SettlementJob,
  plan: PrivatePlan,
  auctions: AuctionResult[],
): Promise<void> {
  const ctx = connectHedera();
  try {
    const infra = await ensureInfra(ctx, MOCK_SELLERS);

    if (job.mode === "live") {
      await assertOperatorRunway(auctions.length);
      const result = await settleWithSwarm(plan, auctions, { ...ctx, infra }, {
        live: true,
        onEvent: (event) => {
          switch (event.type) {
            case "WALLET_CREATED":
              job.agents.push({
                category: event.category,
                accountId: event.accountId,
                buyerName: USER_BUYER_NAME,
              });
              break;
            case "AUCTION_OPEN":
              job.auctions.push({
                category: event.category,
                auctionId: event.auctionId,
                topicId: event.topicId,
              });
              break;
            case "CATEGORY_SETTLED":
              job.settledCategories.push(event.category);
              break;
          }
        },
      });
      job.result = result;
      job.status = "done";
      return;
    }

    // Market mode: the user's private plan competes against rival buyers'
    // mandates in ascending auctions where the seller's price is the floor.
    const planner = new MockPrivatePlanner();
    const rivals: MarketBuyer[] = await Promise.all(
      RIVAL_PERSONAS.map(async (persona) => ({
        name: persona.name,
        plan: (await planner.plan(persona.intent, new Date())).plan,
      })),
    );
    const buyers: MarketBuyer[] = [
      { name: USER_BUYER_NAME, plan },
      ...rivals,
    ];
    await assertOperatorRunway(
      buyers.reduce((sum, buyer) => sum + buyer.plan.allocations.length, 0),
    );

    const market = await runMarket(buyers, { ...ctx, infra }, {
      onEvent: (event) => {
        switch (event.type) {
          case "LISTING_OPEN":
            job.listings.push({
              itemId: event.itemId,
              topicId: event.topicId,
              category: event.category,
              sellerId: event.sellerId,
              sellerName: event.sellerName,
              offering: event.offering,
              floorCents: event.floorCents,
              sold: false,
            });
            break;
          case "AGENT_FUNDED":
            job.agents.push({
              category: event.category,
              accountId: event.accountId,
              buyerName: event.buyerName,
            });
            break;
          case "ITEM_SOLD": {
            const listing = job.listings.find(
              (item) => item.itemId === event.itemId,
            );
            if (listing) listing.sold = true;
            break;
          }
          case "BUYER_DONE":
            if (event.buyerName !== USER_BUYER_NAME) break;
            if (event.lost) job.lostCategories.push(event.category);
            else job.settledCategories.push(event.category);
            break;
        }
      },
    });

    const user = market.buyers[0];
    if (!user) throw new Error("Market run returned no user outcomes.");
    job.result = {
      receipts: user.outcomes
        .filter((outcome) => outcome.result.lost !== true)
        .map((outcome) => ({
          id: outcome.result.transactionId,
          planId: plan.planId,
          mandateId: `mandate_${outcome.category}`,
          sellerId: outcome.result.sellerId,
          sellerName: outcome.result.sellerName,
          category: outcome.category,
          amountCents: outcome.result.amountCents,
          currency: plan.currency,
          status: "hedera-settled",
          transactionId: outcome.result.transactionId,
          ...(outcome.hashscanUrl ? { hashscanUrl: outcome.hashscanUrl } : {}),
          escrowAccountId: outcome.result.leafAccountId,
          claimNftSerial: outcome.result.claimNftSerial,
          auctionTopicUrl: outcome.topicUrl,
          ...(outcome.result.grantedCents
            ? { liveGrantedCents: outcome.result.grantedCents }
            : {}),
        })),
      hedera: {
        network: "testnet",
        paymentTokenId: infra.paymentTokenId,
        claimTokenId: infra.claimTokenId,
        buyerAccountId: user.walletAccountId,
        clearingAccountId: ctx.operatorId.toString(),
      },
    };
    job.status = "done";
  } catch (error) {
    job.error = error instanceof Error ? error.message : "Settlement failed.";
    job.status = "failed";
  } finally {
    ctx.client.close();
  }
}

export function getSettlementJob(id: string): SettlementJob | undefined {
  return jobs.get(id);
}
