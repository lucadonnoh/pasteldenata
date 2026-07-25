import { randomUUID } from "node:crypto";
import { sellersForLocation } from "../catalog";
import type {
  Category,
  MarketProgress,
  PrivatePlan,
  SettlementResult,
} from "../domain";
import { connectHedera } from "../hedera/client";
import { ensureInfra, type HederaInfra } from "../hedera/infra";
import {
  marketMandateId,
  runMarket,
  selectLiveMarketSellers,
  type MarketBuyer,
} from "../hedera/market";
import { HederaPartialSettlementError } from "../hedera/settle";
import { MockPrivatePlanner } from "../planner";
import { marketAgentRunwayHbar } from "./market-runway";
import { SerialJobQueue } from "./serial-job-queue";
import {
  createHumanResolver,
  createDemoAwareHumanResolver,
  MockAgentBook,
  WorldGateway,
  type AuctionPass,
  type HumanResolver,
} from "./world-gateway";

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
  /** True only after the browser proves control of its AgentBook address. */
  userIdentityProved: boolean;
  /** Canonical AgentBook result for the user's selected hosted identity. */
  userHumanStatus: "pending" | "verified" | "unverified";
  /** Auction-scoped credentials issued specifically to the user's agents. */
  userPassesIssued: number;
  /** Explicit demo personas; these never replace the real user's identity. */
  mockBuyers: Array<{
    name: string;
    humanBacked: boolean;
    humanLabel?: string;
  }>;
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
  status: "queued" | "running" | "done" | "failed";
  /** Number of active or queued runs ahead of this one. */
  queuePosition?: number;
  /** Browser-registered identity agent backing the user, when provided. */
  identityAgent?: string;
  /** Clearing payer used to authenticate HCS lifecycle messages. */
  clearingAccountId?: string;
  /** Real leaf wallets, streamed as they are created and funded. */
  agents: JobAgent[];
  /** Scarce listings, where the seller's price is the auction floor. */
  listings: JobListing[];
  /** Demo rival buyers competing against the user. */
  rivals: string[];
  /** Shared-market and final audit progress shown by the live UI. */
  progress: MarketProgress;
  settledCategories: string[];
  /** Categories where the user's agent was outbid everywhere. */
  lostCategories: string[];
  world?: JobWorld;
  result?: SettlementResult;
  error?: string;
  createdAt: number;
}

export const USER_BUYER_NAME = "You";

const RIVAL_PERSONAS = [
  {
    name: "Bruno",
    intent: "Organize me a date tomorrow in Lisbon. My budget is $180.",
    category: "dinner" as Category,
    identityAgent: "0x000000000000000000000000000000000000b001",
    mockHumanSeed: "bruno",
  },
  {
    name: "Chiara",
    intent: "Organize me a date tomorrow in Lisbon. My budget is $165.",
    category: "cinema" as Category,
    identityAgent: "0x000000000000000000000000000000000000c001",
  },
  {
    name: "Emma",
    intent: "Organize me a date tomorrow in Lisbon. My budget is $150.",
    category: "flowers" as Category,
    identityAgent: "0x000000000000000000000000000000000000e001",
    mockHumanSeed: "emma",
  },
];

// Survives dev-server module reloads between the POST and the polling GETs.
const store = globalThis as unknown as {
  __pastelSettlementJobs?: Map<string, SettlementJob>;
  __pastelSettlementQueue?: SerialJobQueue;
};
const jobs: Map<string, SettlementJob> = (store.__pastelSettlementJobs ??=
  new Map());
const settlementQueue = (store.__pastelSettlementQueue ??=
  new SerialJobQueue());

const JOB_TTL_MS = 60 * 60 * 1000;

function prune(): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (
      (job.status === "done" || job.status === "failed") &&
      job.createdAt < cutoff
    ) {
      jobs.delete(id);
    }
  }
}

export interface SettlementJobOptions {
  /** Demo switch: every human-backed rival shares one underlying human. */
  scalperMode?: boolean;
  /** Browser-registered identity agent (AgentBook, World Chain). */
  identityAgent?: string;
}

async function createMarketBuyers(
  plan: PrivatePlan,
): Promise<MarketBuyer[]> {
  const planner = new MockPrivatePlanner();
  const rivals = await Promise.all(
    RIVAL_PERSONAS.map(async (persona) => {
      const planned = (await planner.plan(persona.intent, new Date())).plan;
      const allocation = planned.allocations.find(
        (candidate) => candidate.category === persona.category,
      );
      if (!allocation) {
        throw new Error(
          `${persona.name}'s demo plan has no ${persona.category} allocation.`,
        );
      }
      return {
        name: persona.name,
        plan: {
          ...planned,
          location: plan.location,
          totalBudgetCents: allocation.maxBudgetCents,
          allocations: [{ ...allocation }],
          unallocatedBudgetCents: 0,
        },
      };
    }),
  );
  return [{ name: USER_BUYER_NAME, plan }, ...rivals];
}

/**
 * Refuse to launch a run whose agent wallets cannot be funded. The homepage
 * uses a conservative worst-case estimate; this second check uses the exact
 * verified plan and therefore must agree before any job or ledger mutation is
 * created.
 */
async function assertOperatorRunway(leafCount: number): Promise<void> {
  const operatorId = process.env.HEDERA_OPERATOR_ID?.trim();
  if (!operatorId) {
    throw new Error("HEDERA_OPERATOR_ID is missing.");
  }
  const needed = marketAgentRunwayHbar(leafCount);
  let response: Response;
  try {
    response = await fetch(
      `https://testnet.mirrornode.hedera.com/api/v1/accounts/${operatorId}`,
      { signal: AbortSignal.timeout(10_000) },
    );
  } catch {
    throw new Error(
      "Could not confirm the Hedera operator balance from Mirror Node.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `Could not confirm the Hedera operator balance (HTTP ${response.status}).`,
    );
  }
  const data = (await response.json()) as { balance?: { balance?: number } };
  const tinybars = data.balance?.balance;
  if (typeof tinybars !== "number" || !Number.isFinite(tinybars)) {
    throw new Error("Mirror Node returned no Hedera operator balance.");
  }
  const hbar = tinybars / 1e8;
  if (hbar < needed) {
    throw new Error(
      `Operator has ${hbar.toFixed(1)} HBAR but this market needs ~${needed}. ` +
        "Refill the Hedera testnet account before running.",
    );
  }
}

export async function startSettlementJob(
  plan: PrivatePlan,
  options: SettlementJobOptions = {},
): Promise<SettlementJob> {
  prune();
  const buyers = await createMarketBuyers(plan);
  const totalAgents = buyers.reduce(
    (sum, buyer) => sum + buyer.plan.allocations.length,
    0,
  );
  await assertOperatorRunway(
    totalAgents,
  );
  const marketCategories = new Set(
    buyers.flatMap((buyer) =>
      buyer.plan.allocations.map((allocation) => allocation.category),
    ),
  );
  const totalTopics = selectLiveMarketSellers(
    sellersForLocation(plan.location),
    marketCategories,
  )
    .reduce((sum, seller) => sum + Number(seller.inventory.length > 0), 0);
  const job: SettlementJob = {
    id: randomUUID(),
    status: "queued",
    ...(options.identityAgent ? { identityAgent: options.identityAgent } : {}),
    agents: [],
    listings: [],
    rivals: RIVAL_PERSONAS.map((persona) => persona.name),
    progress: {
      phase: "queued",
      resolvedAgents: 0,
      totalAgents,
      reconciledWallets: 0,
      totalWallets: totalAgents,
      refundedBuyers: 0,
      totalBuyers: buyers.length,
      verifiedTopics: 0,
      totalTopics,
    },
    settledCategories: [],
    lostCategories: [],
    world: {
      enabled: true,
      scalperMode: options.scalperMode === true,
      userIdentityProved: Boolean(options.identityAgent),
      userHumanStatus: options.identityAgent ? "pending" : "unverified",
      userPassesIssued: 0,
      mockBuyers: [],
      passesIssued: 0,
      sybilRejections: 0,
      notHumanBacked: 0,
      blocked: [],
    },
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  settlementQueue.enqueue({
    onStart: () => {
      job.status = "running";
      job.progress.phase = "preparing-market";
      delete job.queuePosition;
    },
    onPosition: (position) => {
      job.queuePosition = position;
    },
    run: () => execute(job, plan, buyers),
    onError: (error) => {
      job.error =
        error instanceof Error
          ? error.message
          : "The queued settlement could not start.";
      job.status = "failed";
    },
  });
  return job;
}

async function execute(
  job: SettlementJob,
  plan: PrivatePlan,
  buyers: MarketBuyer[],
): Promise<void> {
  let ctx: ReturnType<typeof connectHedera> | undefined;
  let infra: HederaInfra | undefined;
  try {
    ctx = connectHedera();
    job.clearingAccountId = ctx.operatorId.toString();
    const roster = sellersForLocation(plan.location);
    infra = await ensureInfra(ctx, roster);

    // The verified private plan now enters the Hedera market directly. There
    // is no browser-created auction winner or simulated receipt to reconcile.

    // World AgentKit: one-per-human listings require an auction-scoped pass.
    // The user's proved identity agent resolves through the canonical
    // AgentBook (unless explicit offline mock mode is configured); rivals are
    // explicit identities on a mock book, including a negative fixture. In
    // scalper mode the human-backed rivals share ONE underlying human, so the
    // gateway collapses them to a single allocation per protected item while
    // the unverified fixture remains unverified.
    const scalperMode = job.world?.scalperMode === true;
    const rivalBook = new MockAgentBook();
    const identityByBuyer = new Map<string, string>();
    if (job.identityAgent) {
      identityByBuyer.set(USER_BUYER_NAME, job.identityAgent);
    }
    const mockIdentityAddresses = new Set<string>();
    for (const persona of RIVAL_PERSONAS) {
      identityByBuyer.set(persona.name, persona.identityAgent);
      mockIdentityAddresses.add(persona.identityAgent.toLowerCase());
      const humanSeed =
        "mockHumanSeed" in persona ? persona.mockHumanSeed : undefined;
      if (humanSeed) {
        rivalBook.registerAgent(
          persona.identityAgent,
          scalperMode ? "scalper" : humanSeed,
        );
      }
      job.world?.mockBuyers.push({
        name: persona.name,
        humanBacked: Boolean(humanSeed),
        ...(humanSeed
          ? { humanLabel: scalperMode ? "shared-scalper" : humanSeed }
          : {}),
      });
    }
    const baseResolver: HumanResolver = await createHumanResolver();
    // Every rival is an explicit demo identity. An unverified mock remains a
    // negative result; only the browser-proved user reaches the real book.
    const resolver = createDemoAwareHumanResolver(
      baseResolver,
      rivalBook,
      mockIdentityAddresses,
    );
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
      const protectedItems = job.listings.filter(
        (listing) =>
          listing.category === category &&
          listing.humanPolicy === "one-per-human",
      );
      if (!identityAgent) {
        if (buyerName === USER_BUYER_NAME && job.world) {
          job.world.userHumanStatus = "unverified";
        }
        for (const listing of protectedItems) {
          gateway.noteMissingIdentity();
          refusals.set(
            `${listing.itemId}|${leafWallet}`,
            `${buyerName}'s agent has no proved World identity.`,
          );
        }
        syncWorldStats();
        return;
      }
      for (const listing of protectedItems) {
        const enrollment = await gateway.enroll({
          auctionId: listing.itemId,
          identityAgent,
          leafWallet,
        });
        if (enrollment.ok && enrollment.pass) {
          passes.set(`${listing.itemId}|${leafWallet}`, enrollment.pass);
          if (buyerName === USER_BUYER_NAME && job.world) {
            job.world.userHumanStatus = "verified";
            job.world.userPassesIssued += 1;
          }
        } else {
          if (buyerName === USER_BUYER_NAME && job.world) {
            job.world.userHumanStatus = "unverified";
          }
          refusals.set(
            `${listing.itemId}|${leafWallet}`,
            enrollment.reason ?? "enrollment refused",
          );
        }
      }
      syncWorldStats();
    };

    const resolvedAgentKeys = new Set<string>();
    const market = await runMarket(buyers, { ...ctx, infra }, {
      authorizePurchase: async ({ itemId, buyerName, leafWallet }) => {
        await Promise.all(enrollments);
        const pass = passes.get(`${itemId}|${leafWallet}`);
        if (pass && gateway.verifyPass(pass, itemId, leafWallet)) {
          return { ok: true, pass };
        }
        return {
          ok: false,
          reason:
            refusals.get(`${itemId}|${leafWallet}`) ??
            `${buyerName}'s agent holds no auction pass for this item.`,
        };
      },
      authorizationIssuerPublicKey: gateway.issuerPublicKey,
      onEvent: (event) => {
        switch (event.type) {
          case "MARKET_PHASE":
            job.progress.phase = event.phase;
            break;
          case "WALLET_RECONCILED":
            job.progress.reconciledWallets = Math.min(
              job.progress.totalWallets,
              job.progress.reconciledWallets + 1,
            );
            break;
          case "BUYER_REFUNDED":
            job.progress.refundedBuyers = Math.min(
              job.progress.totalBuyers,
              job.progress.refundedBuyers + 1,
            );
            break;
          case "HCS_TOPIC_VERIFIED":
            job.progress.verifiedTopics = Math.min(
              job.progress.totalTopics,
              job.progress.verifiedTopics + 1,
            );
            break;
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
          case "BUYER_DONE": {
            const agentKey = `${event.buyerName}|${event.category}`;
            if (!resolvedAgentKeys.has(agentKey)) {
              resolvedAgentKeys.add(agentKey);
              job.progress.resolvedAgents = resolvedAgentKeys.size;
            }
            if (event.buyerName !== USER_BUYER_NAME) break;
            const target = event.lost
              ? job.lostCategories
              : job.settledCategories;
            if (!target.includes(event.category)) target.push(event.category);
            break;
          }
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
          mandateId: marketMandateId(plan.planId, outcome.category),
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
    job.progress.phase = "complete";
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
            infra.marketBuyers?.[0]?.accountId ?? infra.buyer.accountId,
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
