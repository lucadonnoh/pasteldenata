import { createHash } from "node:crypto";
import { Client, Hbar, PrivateKey, TransferTransaction } from "@hashgraph/sdk";
import type { Seller, SellerInventoryItem } from "../domain";
import { parsePrivateKey, type HederaContext } from "./client";
import type { StoredAccount } from "./infra";
import { publishToTopic } from "./log";
import {
  fetchTopicBids,
  standingOffers,
  TESTNET_MIRROR_BASE,
  type AuthorizedSeller,
} from "./mirror";

const POLL_MS = 2500;
const MAX_RUNTIME_MS = 150_000;

interface LiveSellerListing {
  seller: Seller;
  item: SellerInventoryItem;
  account: StoredAccount;
  client: Client;
}

/**
 * Root-hosted mocked seller strategies for one live reverse auction. Each
 * inventory listing publishes from its registered seller account and every
 * message additionally carries the auction topic's submit-key signature.
 */
export class LiveAuctioneer {
  private readonly listings: LiveSellerListing[];
  private readonly authorized: Map<string, AuthorizedSeller>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly startedAt = Date.now();
  private ticking = false;
  /** Mirror lag guard: never re-publish an amount already sent. */
  private readonly lastPublished = new Map<string, number>();

  constructor(
    private readonly ctx: HederaContext,
    private readonly topicId: string,
    private readonly topicSubmitKey: PrivateKey,
    private readonly auctionId: string,
    private readonly mirrorBaseUrl: string,
    listings: Array<{
      seller: Seller;
      item: SellerInventoryItem;
      account: StoredAccount;
    }>,
  ) {
    this.listings = listings.map(({ seller, item, account }) => ({
      seller,
      item,
      account,
      client: Client.forTestnet().setOperator(
        account.accountId,
        parsePrivateKey(account.privateKey),
      ),
    }));
    this.authorized = new Map(
      this.listings.map(({ seller, item, account }) => [
        item.id,
        { sellerId: seller.id, accountId: account.accountId },
      ]),
    );
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
    for (const { client } of this.listings) client.close();
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.startedAt > MAX_RUNTIME_MS) return;
    const bids = await fetchTopicBids(
      this.mirrorBaseUrl,
      this.topicId,
      this.auctionId,
      this.authorized,
    );
    const standing = standingOffers(bids);
    const lowest = [...standing.values()].reduce(
      (min, bid) =>
        min === undefined || bid.amountCents < min
          ? bid.amountCents
          : min,
      undefined as number | undefined,
    );

    await Promise.all(
      this.listings.map((listing) =>
        this.maybeBid(listing, standing, lowest),
      ),
    );
  }

  private async maybeBid(
    listing: LiveSellerListing,
    standing: Map<string, { amountCents: number }>,
    lowest: number | undefined,
  ): Promise<void> {
    const amount = nextBid(listing.seller, listing.item, standing, lowest);
    if (amount === undefined) return;
    const previous = this.lastPublished.get(listing.item.id);
    if (previous !== undefined && amount >= previous) return;
    this.lastPublished.set(listing.item.id, amount);
    await publishToTopic(
      listing.client,
      this.topicId,
      this.topicSubmitKey,
      {
        type: "BID",
        auctionId: this.auctionId,
        listingId: listing.item.id,
        sellerId: listing.seller.id,
        sellerName: listing.seller.name,
        offering: listing.item.offering,
        amountCents: amount,
        quality: listing.item.quality,
        tags: listing.item.tags,
      },
    );
  }
}

/**
 * Mock reverse-auction strategy for one inventory item. Its public opening
 * price is the market estimate and its private floor is the seller floor.
 */
export function nextBid(
  seller: Seller,
  item: SellerInventoryItem,
  standing: Map<string, { amountCents: number }>,
  lowest: number | undefined,
): number | undefined {
  const mine = standing.get(item.id)?.amountCents;
  if (mine === undefined) return item.estimatedMarketPriceCents;
  if (lowest !== undefined && mine <= lowest) return undefined;

  const jitter =
    Number.parseInt(
      createHash("sha256")
        .update(`${seller.privateSalt}|${item.id}|step`)
        .digest("hex")
        .slice(0, 4),
      16,
    ) % 20;
  const step =
    Math.max(25, Math.round(item.estimatedMarketPriceCents * 0.03)) + jitter;
  const target = Math.max(
    item.floorPriceCents,
    Math.min(mine - step, (lowest ?? mine) - step),
  );
  if (target >= mine) return undefined;
  return target;
}

async function mirrorHbarBalance(accountId: string): Promise<number> {
  try {
    const response = await fetch(
      `${TESTNET_MIRROR_BASE}/api/v1/accounts/${accountId}`,
    );
    if (!response.ok) return 0;
    const data = (await response.json()) as {
      balance?: { balance?: number };
    };
    return (data.balance?.balance ?? 0) / 1e8;
  } catch {
    return 0;
  }
}

/** Sellers pay their own bid fees; only low-balance accounts are topped up. */
export async function fundSellerFees(
  ctx: HederaContext,
  accounts: StoredAccount[],
): Promise<void> {
  const deduped = [
    ...new Map(accounts.map((account) => [account.accountId, account])).values(),
  ];
  const balances = await Promise.all(
    deduped.map((account) => mirrorHbarBalance(account.accountId)),
  );
  const unique = deduped.filter(
    (_, index) => (balances[index] ?? 0) < 0.5,
  );
  if (unique.length === 0) return;
  // Hedera caps a transfer at 10 account entries (sellers plus the
  // operator), so plans with 4+ categories must fund in batches.
  const BATCH = 8;
  for (let start = 0; start < unique.length; start += BATCH) {
    const batch = unique.slice(start, start + BATCH);
    const transfer = new TransferTransaction();
    for (const account of batch) {
      transfer.addHbarTransfer(account.accountId, new Hbar(1));
      transfer.addHbarTransfer(ctx.operatorId, new Hbar(-1));
    }
    await (await transfer.execute(ctx.client)).getReceipt(ctx.client);
  }
}
