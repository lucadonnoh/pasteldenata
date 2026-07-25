import { createHash } from "node:crypto";
import { Client, Hbar, TransferTransaction } from "@hashgraph/sdk";
import type { Seller } from "../domain.js";
import { parsePrivateKey, type HederaContext } from "./client.js";
import type { StoredAccount } from "./infra.js";
import { publishToTopic } from "./log.js";
import { fetchTopicBids, standingOffers } from "./mirror.js";

const POLL_MS = 2500;
const MAX_RUNTIME_MS = 150_000;

interface LiveSeller {
  seller: Seller;
  client: Client;
}

/**
 * Root-hosted seller agents for one live reverse auction. Each seller starts
 * at its list price and undercuts the current leader on the auction's HCS
 * topic — from its own Hedera account, never below its private reserve. The
 * buying leaf watches the same public topic and closes when bidding goes
 * quiet. Price discovery is real and replayable; only the seller's reserve
 * and the buyer's scoring stay private.
 */
export class LiveAuctioneer {
  private readonly sellers: LiveSeller[];
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly startedAt = Date.now();
  private ticking = false;
  /** Mirror lag guard: never re-publish an amount already sent. */
  private readonly lastPublished = new Map<string, number>();

  constructor(
    private readonly ctx: HederaContext,
    private readonly topicId: string,
    private readonly auctionId: string,
    private readonly mirrorBaseUrl: string,
    sellers: Array<{ seller: Seller; account: StoredAccount }>,
  ) {
    this.sellers = sellers.map(({ seller, account }) => ({
      seller,
      client: Client.forTestnet().setOperator(
        account.accountId,
        parsePrivateKey(account.privateKey),
      ),
    }));
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch(() => {
          // Mirror lag or a transient node error; the next tick retries.
        })
        .finally(() => {
          this.ticking = false;
        });
    }, POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const { client } of this.sellers) client.close();
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.startedAt > MAX_RUNTIME_MS) return;
    const bids = await fetchTopicBids(this.mirrorBaseUrl, this.topicId, this.auctionId);
    const standing = standingOffers(bids);
    const lowest = [...standing.values()].reduce(
      (min, bid) => (min === undefined || bid.amountCents < min ? bid.amountCents : min),
      undefined as number | undefined,
    );

    await Promise.all(
      this.sellers.map(({ seller, client }) =>
        this.maybeBid(seller, client, standing, lowest),
      ),
    );
  }

  private async maybeBid(
    seller: Seller,
    client: Client,
    standing: Map<string, { amountCents: number }>,
    lowest: number | undefined,
  ): Promise<void> {
    const amount = nextBid(seller, standing, lowest);
    if (amount === undefined) return;
    const previous = this.lastPublished.get(seller.id);
    if (previous !== undefined && amount >= previous) return;
    this.lastPublished.set(seller.id, amount);
    await publishToTopic(client, this.topicId, {
      type: "BID",
      auctionId: this.auctionId,
      sellerId: seller.id,
      sellerName: seller.name,
      offering: seller.offering,
      amountCents: amount,
      quality: seller.quality,
      tags: seller.tags,
    });
  }
}

/**
 * Open descending-price strategy: enter at list price, then concede while
 * not leading — undercut the leader when the reserve allows it, otherwise
 * keep lowering your own offer stepwise toward the reserve (competitive
 * pressure is real even when you cannot be the cheapest). Never bid below
 * the private reserve. Returns undefined to hold.
 */
export function nextBid(
  seller: Seller,
  standing: Map<string, { amountCents: number }>,
  lowest: number | undefined,
): number | undefined {
  const mine = standing.get(seller.id)?.amountCents;
  if (mine === undefined) return seller.listPriceCents;
  if (lowest !== undefined && mine <= lowest) return undefined;

  const jitter =
    Number.parseInt(
      createHash("sha256").update(`${seller.privateSalt}|step`).digest("hex").slice(0, 4),
      16,
    ) % 20;
  const step = Math.max(25, Math.round(seller.listPriceCents * 0.03)) + jitter;
  const target = Math.max(
    seller.reservePriceCents,
    Math.min(mine - step, (lowest ?? mine) - step),
  );
  if (target >= mine) return undefined;
  return target;
}

/** Sellers pay for their own bid messages; top them up with fee HBAR. */
export async function fundSellerFees(
  ctx: HederaContext,
  accounts: StoredAccount[],
): Promise<void> {
  const transfer = new TransferTransaction();
  for (const account of accounts) {
    transfer.addHbarTransfer(account.accountId, new Hbar(1));
    transfer.addHbarTransfer(ctx.operatorId, new Hbar(-1));
  }
  await (await transfer.execute(ctx.client)).getReceipt(ctx.client);
}
