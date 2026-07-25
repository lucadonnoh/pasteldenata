import { randomUUID } from "node:crypto";
import { MOCK_SELLERS } from "../catalog";
import type { AuctionResult, PrivatePlan } from "../domain";
import { connectHedera } from "../hedera/client";
import { ensureInfra } from "../hedera/infra";
import { settleWithSwarm } from "../hedera/swarm";
import type { SettlementResult } from "../orchestrator";

export interface SettlementJob {
  id: string;
  status: "running" | "done" | "failed";
  live: boolean;
  /** Real leaf wallets, streamed as the swarm creates them. */
  agents: Array<{ category: string; accountId: string }>;
  /** Real HCS auction topics; the browser watches these via Mirror Node. */
  auctions: Array<{ category: string; auctionId: string; topicId: string }>;
  settledCategories: string[];
  result?: SettlementResult;
  error?: string;
  createdAt: number;
}

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
  live: boolean,
): SettlementJob {
  prune();
  const job: SettlementJob = {
    id: randomUUID(),
    status: "running",
    live,
    agents: [],
    auctions: [],
    settledCategories: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  void execute(job, plan, auctions, live);
  return job;
}

async function execute(
  job: SettlementJob,
  plan: PrivatePlan,
  auctions: AuctionResult[],
  live: boolean,
): Promise<void> {
  const ctx = connectHedera();
  try {
    const infra = await ensureInfra(ctx, MOCK_SELLERS);
    const result = await settleWithSwarm(plan, auctions, { ...ctx, infra }, {
      live,
      onEvent: (event) => {
        switch (event.type) {
          case "WALLET_CREATED":
            job.agents.push({
              category: event.category,
              accountId: event.accountId,
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
