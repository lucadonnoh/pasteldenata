import { randomUUID } from "node:crypto";
import { sellersForLocation } from "../catalog";
import type { AuctionResult, PrivatePlan } from "../domain";
import { connectHedera } from "../hedera/client";
import { ensureInfra, type HederaInfra } from "../hedera/infra";
import { runMarket, type MarketBuyer } from "../hedera/market";
import { HederaPartialSettlementError } from "../hedera/settle";
import { settleWithSwarm } from "../hedera/swarm";
import type { SettlementResult } from "../orchestrator";
import { MockPrivatePlanner } from "../planner";
import {
  createHumanResolver,
  MockAgentBook,
  WorldGateway,
  type AuctionPass,
  type HumanResolver,
} from "./world-gateway";

export type SettlementMode = "live" | "market";

export interface JobAgent {
  category: string;
  accountId: string;
  buyerName: string;
  initialCapCents: number;
  grantedCents: number;
  effectiveCapCents: number;
  grantTransactions: Array<{
    amountCents: number;
    transactionId: string;
  }>;
}

export interface JobListing {
  itemId: string;
  topicId: string;
  category: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  floorCents: number;
  sold: boolean;
  humanPolicy?: "open" | "one-per-human";
}

export interface JobWorld {
  enabled: boolean;
  scalperMode: boolean;
  passesIssued: number;
  sybilRejections: number;
  notHumanBacked: number;
  blocked: Array<{
    buyerName: string;
    category: string;
    itemId: string;
    reason: string;
  }>;
}

export interface SettlementJob {
  id: string;
  status: "running" | "done" | "failed";
  mode: SettlementMode;
  /** Clearing payer used to authenticate HCS lifecycle messages. */
  clearingAccountId?: string;
  /** Real leaf wallets, streamed as they are created and funded. */
  agents: JobAgent[];
  /** Live mode: one auction topic per category. */
  auctions: Array<{
    category: string;
    auctionId: string;
    topicId: string;
    authorizedListings: Array<{
      listingId: string;
      sellerId: string;
      accountId: string;
    }>;
  }>;
  /** Market mode: scarce listings, floor = the seller's price. */
  listings: JobListing[];
  /** Rival buyer personas competing against the user (market mode). */
  rivals: string[];
  settledCategories: string[];
  /** Market mode: categories where the user's agent was outbid everywhere. */
  lostCategories: string[];
  world?: JobWorld;
  result?: SettlementResult;
  error?: string;
  createdAt: number;
}

export const USER_BUYER_NAME = "You";

export class SettlementJobBusyError extends Error {
  readonly status = 409;
}

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

export interface SettlementJobOptions {
  /** Demo switch: all rival buyers share one underlying human. */
  scalperMode?: boolean;
}

export function startSettlementJob(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  mode: SettlementMode,
  options: SettlementJobOptions = {},
): SettlementJob {
  prune();
  const active = [...jobs.values()].find((job) => job.status === "running");
  if (active) {
    throw new SettlementJobBusyError(
      `Settlement job ${active.id} is still running. Wait for it to finish before starting another.`,
    );
  }
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
    ...(mode === "market"
      ? {
          world: {
            enabled: true,
            scalperMode: options.scalperMode === true,
            passesIssued: 0,
            sybilRejections: 0,
            notHumanBacked: 0,
            blocked: [],
          },
        }
      : {}),
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  void execute(job, plan, auctions);
  return job;
}

const ACCOUNT_CREATION_HBAR = 1.5;
const LIVE_LEAF_FLOAT_HBAR = 2;
const MARKET_LEAF_FLOAT_HBAR = 5;
const RUN_MARGIN_HBAR = 6;

/**
 * Refuse to start a run the operator cannot afford: a mid-run failure kills
 * agents before they can return their fee float, stranding it in dead
 * wallets forever. Failing here costs nothing.
 */
async function assertOperatorRunway(
  leafCount: number,
  feeFloatHbar: number,
): Promise<void> {
  try {
    const response = await fetch(
      "https://testnet.mirrornode.hedera.com/api/v1/accounts/" +
        process.env.HEDERA_OPERATOR_ID,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return;
    const data = (await response.json()) as { balance?: { balance?: number } };
    const hbar = (data.balance?.balance ?? 0) / 1e8;
    const needed = Math.ceil(
      leafCount * (ACCOUNT_CREATION_HBAR + feeFloatHbar) + RUN_MARGIN_HBAR,
    );
    if (hbar < needed) {
      throw new Error(
        `Operator has ${hbar.toFixed(1)} HBAR but this run needs ~${needed}. ` +
          "Refill at portal.hedera.com/faucet (100 HBAR daily) before running.",
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Operator has ")
    ) {
      throw error;
    }
    // Mirror availability must not become a new dependency for settlement.
  }
}

async function execute(
  job: SettlementJob,
  plan: PrivatePlan,
  auctions: AuctionResult[],
): Promise<void> {
  let ctx: ReturnType<typeof connectHedera> | undefined;
  let infra: HederaInfra | undefined;
  try {
    ctx = connectHedera();
    job.clearingAccountId = ctx.operatorId.toString();
    const roster = sellersForLocation(plan.location);
    infra = await ensureInfra(ctx, roster);

    if (job.mode === "live") {
      await assertOperatorRunway(auctions.length, LIVE_LEAF_FLOAT_HBAR);
      const result = await settleWithSwarm(plan, auctions, { ...ctx, infra }, {
        live: true,
        onEvent: (event) => {
          switch (event.type) {
            case "WALLET_CREATED": {
              const allocation = plan.allocations.find(
                (item) => item.category === event.category,
              );
              job.agents.push({
                category: event.category,
                accountId: event.accountId,
                buyerName: USER_BUYER_NAME,
                initialCapCents: allocation?.maxBudgetCents ?? 0,
                grantedCents: 0,
                effectiveCapCents: allocation?.maxBudgetCents ?? 0,
                grantTransactions: [],
              });
              break;
            }
            case "AUCTION_OPEN":
              job.auctions.push({
                category: event.category,
                auctionId: event.auctionId,
                topicId: event.topicId,
                authorizedListings: event.authorizedListings,
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
        plan: {
          ...(await planner.plan(persona.intent, new Date())).plan,
          location: plan.location,
        },
      })),
    );
    const buyers: MarketBuyer[] = [
      { name: USER_BUYER_NAME, plan },
      ...rivals,
    ];
    await assertOperatorRunway(
      buyers.reduce((sum, buyer) => sum + buyer.plan.allocations.length, 0),
      MARKET_LEAF_FLOAT_HBAR,
    );

    // World AgentKit: one-per-human listings require an auction-scoped pass.
    // The user's identity agent resolves through the configured resolver
    // (real AgentBook with WORLD_AGENTBOOK=real); rival personas are
    // simulated humans on a mock book. In scalper mode all rivals share ONE
    // underlying human, so the gateway collapses them to a single
    // allocation per protected item — the live sybil demo.
    const scalperMode = job.world?.scalperMode === true;
    const rivalBook = new MockAgentBook();
    const identityByBuyer = new Map<string, string>();
    const userIdentity =
      process.env.WORLD_IDENTITY_AGENT ?? "0xYouIdentityAgent";
    identityByBuyer.set(USER_BUYER_NAME, userIdentity);
    rivalBook.registerAgent(userIdentity, "you");
    for (const rival of rivals) {
      const address = `0x${rival.name}IdentityAgent`;
      identityByBuyer.set(rival.name, address);
      rivalBook.registerAgent(address, scalperMode ? "scalper" : rival.name);
    }
    const baseResolver: HumanResolver = await createHumanResolver();
    const resolver: HumanResolver = {
      // Rivals and (in dev) the user live on the mock book; anything else
      // falls through to the configured resolver (the real AgentBook when
      // WORLD_AGENTBOOK=real).
      lookupHuman: async (address) =>
        (await rivalBook.lookupHuman(address)) ??
        (await baseResolver.lookupHuman(address)),
    };
    const gateway = new WorldGateway(resolver);
    const passes = new Map<string, AuctionPass>();
    const refusals = new Map<string, string>();
    const enrollments: Promise<void>[] = [];

    const syncWorldStats = () => {
      if (!job.world) return;
      job.world.passesIssued = gateway.stats.passesIssued;
      job.world.sybilRejections = gateway.stats.sybilRejections;
      job.world.notHumanBacked = gateway.stats.notHumanBacked;
    };

    const enrollAgent = async (
      buyerName: string,
      category: string,
      leafWallet: string,
    ): Promise<void> => {
      const identityAgent = identityByBuyer.get(buyerName);
      if (!identityAgent) return;
      const protectedItems = job.listings.filter(
        (listing) =>
          listing.category === category &&
          listing.humanPolicy === "one-per-human",
      );
      for (const listing of protectedItems) {
        const enrollment = await gateway.enroll({
          auctionId: listing.itemId,
          identityAgent,
          leafWallet,
        });
        if (enrollment.ok && enrollment.pass) {
          passes.set(`${listing.itemId}|${leafWallet}`, enrollment.pass);
        } else {
          refusals.set(
            `${listing.itemId}|${leafWallet}`,
            enrollment.reason ?? "enrollment refused",
          );
        }
      }
      syncWorldStats();
    };

    const market = await runMarket(buyers, { ...ctx, infra }, {
      authorizePurchase: async ({ itemId, buyerName, leafWallet }) => {
        await Promise.all(enrollments);
        const pass = passes.get(`${itemId}|${leafWallet}`);
        if (pass && gateway.verifyPass(pass, itemId, leafWallet)) {
          return { ok: true };
        }
        return {
          ok: false,
          reason:
            refusals.get(`${itemId}|${leafWallet}`) ??
            `${buyerName}'s agent holds no auction pass for this item.`,
        };
      },
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
              humanPolicy: event.humanPolicy,
            });
            break;
          case "AGENT_FUNDED":
            enrollments.push(
              enrollAgent(event.buyerName, event.category, event.accountId),
            );
            job.agents.push({
              category: event.category,
              accountId: event.accountId,
              buyerName: event.buyerName,
              initialCapCents: event.initialCapCents,
              grantedCents: 0,
              effectiveCapCents: event.initialCapCents,
              grantTransactions: [],
            });
            break;
          case "BUDGET_GRANTED": {
            const agent = job.agents.find(
              (item) => item.accountId === event.accountId,
            );
            if (agent) {
              agent.grantedCents += event.grantedCents;
              agent.effectiveCapCents = event.effectiveCapCents;
              agent.grantTransactions.push({
                amountCents: event.grantedCents,
                transactionId: event.transactionId,
              });
            }
            break;
          }
          case "ITEM_SOLD": {
            const listing = job.listings.find(
              (item) => item.itemId === event.itemId,
            );
            if (listing) listing.sold = true;
            break;
          }
          case "PURCHASE_BLOCKED":
            job.world?.blocked.push({
              buyerName: event.buyerName,
              category: event.category,
              itemId: event.itemId,
              reason: event.reason,
            });
            break;
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
    const mandates = new Map(
      auctions.map((auction) => [auction.category, auction.mandate.id]),
    );
    job.result = {
      receipts: user.outcomes
        .filter((outcome) => outcome.result.lost !== true)
        .map((outcome) => ({
          id: outcome.result.transactionId,
          planId: plan.planId,
          mandateId:
            mandates.get(outcome.category) ??
            `mandate_${outcome.category}`,
          sellerId: outcome.result.sellerId,
          sellerName: outcome.result.sellerName,
          listingId: outcome.result.listingId,
          offering: outcome.result.offering,
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
    if (error instanceof HederaPartialSettlementError && infra && ctx) {
      const receipts = error.receipts.filter(
        (receipt) => receipt.planId === plan.planId,
      );
      job.result = {
        receipts,
        hedera: {
          network: "testnet",
          paymentTokenId: infra.paymentTokenId,
          claimTokenId: infra.claimTokenId,
          buyerAccountId:
            job.mode === "market"
              ? (infra.marketBuyers?.[0]?.accountId ?? infra.buyer.accountId)
              : infra.buyer.accountId,
          clearingAccountId: ctx.operatorId.toString(),
        },
      };
    }
    job.error = error instanceof Error ? error.message : "Settlement failed.";
    job.status = "failed";
  } finally {
    ctx?.client.close();
  }
}

export function getSettlementJob(id: string): SettlementJob | undefined {
  return jobs.get(id);
}
