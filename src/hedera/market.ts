import { fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Transaction, TokenMintTransaction, TransferTransaction } from "@hashgraph/sdk";
import { MOCK_SELLERS } from "../catalog.js";
import type { Category, PrivatePlan, Seller } from "../domain.js";
import { hashscanTopicUrl, hashscanTxUrl, parsePrivateKey } from "./client.js";
import { createAccount, type StoredAccount } from "./infra.js";
import type {
  ContestedListing,
  LeafResult,
  LeafToParent,
  ParentToLeaf,
} from "./ipc.js";
import { AuctionLog } from "./log.js";
import { fetchItemState, TESTNET_MIRROR_BASE } from "./mirror.js";
import { mintClaimTo } from "./swarm.js";
import type { HederaSettlementContext } from "./settle.js";

const LEAF_AGENT_PATH = fileURLToPath(new URL("./leafAgent.ts", import.meta.url));
const LEAF_TIMEOUT_MS = 360_000;
const LEAF_FEE_HBAR = 5;

export interface MarketBuyer {
  name: string;
  plan: PrivatePlan;
}

export interface MarketOutcome {
  category: Category;
  capCents: number;
  result: LeafResult;
  hashscanUrl?: string;
  topicUrl: string;
}

export interface MarketContention {
  sellerName: string;
  category: Category;
  floorCents: number;
  bids: number;
  bidders: number;
  soldForCents?: number;
  topicUrl: string;
}

export interface MarketResult {
  buyers: Array<{ name: string; plan: PrivatePlan; outcomes: MarketOutcome[] }>;
  contention: MarketContention[];
}

interface MarketListing extends ContestedListing {
  category: Category;
  seller: Seller;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Multi-buyer open market. Every seller lists one scarce item at its price —
 * the auction floor. Each buyer's private plan spawns isolated leaf agents
 * that bid ascending on the same public listings; competition between
 * strangers' agents is what pushes prices above floor. Every buyer's budget
 * is enforced by its own wallet balances; every bid war is replayable on the
 * listing's HCS topic.
 */
export async function runMarket(
  buyers: MarketBuyer[],
  ctx: HederaSettlementContext,
): Promise<MarketResult> {
  const runSalt = hash(buyers.map((buyer) => buyer.plan.planId).join("|")).slice(0, 12);
  const categories = new Set<Category>();
  for (const buyer of buyers) {
    for (const allocation of buyer.plan.allocations) {
      categories.add(allocation.category);
    }
  }

  // Listing phase: one topic per scarce item, floor = the seller's price.
  const listings: MarketListing[] = [];
  await Promise.all(
    MOCK_SELLERS.filter((seller) => categories.has(seller.category)).map(
      async (seller) => {
        const log = await AuctionLog.create(ctx.client);
        const itemId = `item_${hash(`${runSalt}|${seller.id}`).slice(0, 16)}`;
        await log.publish({
          type: "LISTED",
          itemId,
          sellerId: seller.id,
          sellerName: seller.name,
          offering: seller.offering,
          category: seller.category,
          floorCents: seller.listPriceCents,
          quantity: 1,
        });
        listings.push({
          itemId,
          topicId: log.topicId,
          sellerId: seller.id,
          sellerName: seller.name,
          offering: seller.offering,
          floorCents: seller.listPriceCents,
          quality: seller.quality,
          tags: seller.tags,
          category: seller.category,
          seller,
        });
      },
    ),
  );

  // Funding phase: every buyer gets a real wallet holding exactly its hard
  // cap, then pays the clearing account its caps plus contingency.
  const totalBudget = buyers.reduce(
    (sum, buyer) => sum + buyer.plan.totalBudgetCents,
    0,
  );
  await (
    await new TokenMintTransaction()
      .setTokenId(ctx.infra.paymentTokenId)
      .setAmount(totalBudget)
      .execute(ctx.client)
  ).getReceipt(ctx.client);

  const buyerWallets: StoredAccount[] = await Promise.all(
    buyers.map(() => createAccount(ctx)),
  );
  const distribute = new TransferTransaction();
  buyers.forEach((buyer, index) => {
    const wallet = buyerWallets[index];
    if (!wallet) throw new Error("Missing buyer wallet.");
    distribute.addTokenTransfer(
      ctx.infra.paymentTokenId,
      wallet.accountId,
      buyer.plan.totalBudgetCents,
    );
  });
  distribute.addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -totalBudget);
  await (await distribute.execute(ctx.client)).getReceipt(ctx.client);

  const spendable = buyers.map((buyer) => {
    const caps = buyer.plan.allocations.reduce(
      (sum, allocation) => sum + allocation.maxBudgetCents,
      0,
    );
    return caps + buyer.plan.unallocatedBudgetCents;
  });
  await Promise.all(
    buyers.map(async (buyer, index) => {
      const wallet = buyerWallets[index];
      const amount = spendable[index];
      if (!wallet || amount === undefined) throw new Error("Funding misaligned.");
      const toClearing = new TransferTransaction()
        .addTokenTransfer(ctx.infra.paymentTokenId, wallet.accountId, -amount)
        .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, amount)
        .freezeWith(ctx.client);
      await toClearing.sign(parsePrivateKey(wallet.privateKey));
      await (await toClearing.execute(ctx.client)).getReceipt(ctx.client);
    }),
  );

  // Shared market state: an item can be sold exactly once, and each buyer
  // has its own contingency pool.
  const sold = new Set<string>();
  const contingency = buyers.map((buyer) => buyer.plan.unallocatedBudgetCents);

  const outcomes = await Promise.all(
    buyers.map(async (buyer, index) => {
      const perBuyer = await Promise.all(
        buyer.plan.allocations.map((allocation) =>
          runMarketLeaf(
            buyer,
            index,
            allocation.category,
            allocation.maxBudgetCents,
            allocation.requirements,
            listings.filter((listing) => listing.category === allocation.category),
            ctx,
            { sold, contingency },
          ),
        ),
      );
      return perBuyer;
    }),
  );

  // Refunds: whatever each buyer's agents did not spend flows back from
  // clearing to that buyer's wallet.
  await Promise.all(
    buyers.map(async (buyer, index) => {
      const wallet = buyerWallets[index];
      const amount = spendable[index];
      const spent = (outcomes[index] ?? []).reduce(
        (sum, outcome) => sum + outcome.result.amountCents,
        0,
      );
      if (!wallet || amount === undefined) return;
      const refund = amount - spent;
      if (refund <= 0) return;
      await (
        await new TransferTransaction()
          .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -refund)
          .addTokenTransfer(ctx.infra.paymentTokenId, wallet.accountId, refund)
          .execute(ctx.client)
      ).getReceipt(ctx.client);
    }),
  );

  // Contention report straight from the public topics.
  const contention: MarketContention[] = await Promise.all(
    listings.map(async (listing) => {
      const state = await fetchItemState(
        TESTNET_MIRROR_BASE,
        listing.topicId,
        listing.itemId,
      );
      const bidders = new Set(state.bids.map((bid) => bid.bidder)).size;
      const top = state.bids.reduce(
        (max, bid) => Math.max(max, bid.amountCents),
        0,
      );
      return {
        sellerName: listing.sellerName,
        category: listing.category,
        floorCents: listing.floorCents,
        bids: state.bids.length,
        bidders,
        ...(state.settled ? { soldForCents: top } : {}),
        topicUrl: hashscanTopicUrl(listing.topicId),
      };
    }),
  );

  return {
    buyers: buyers.map((buyer, index) => ({
      name: buyer.name,
      plan: buyer.plan,
      outcomes: outcomes[index] ?? [],
    })),
    contention,
  };
}

interface SharedMarketState {
  sold: Set<string>;
  contingency: number[];
}

async function runMarketLeaf(
  buyer: MarketBuyer,
  buyerIndex: number,
  category: Category,
  capCents: number,
  requirements: string[],
  listings: MarketListing[],
  ctx: HederaSettlementContext,
  shared: SharedMarketState,
): Promise<MarketOutcome> {
  // Fresh leaf wallet funded with exactly this mandate's cap.
  const wallet = await createAccount(ctx, LEAF_FEE_HBAR);
  await (
    await new TransferTransaction()
      .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -capCents)
      .addTokenTransfer(ctx.infra.paymentTokenId, wallet.accountId, capCents)
      .execute(ctx.client)
  ).getReceipt(ctx.client);

  const result = await new Promise<LeafResult>((resolve, reject) => {
    const child: ChildProcess = fork(LEAF_AGENT_PATH, [], {
      execArgv: ["--import", "tsx"],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() =>
        reject(new Error(`${buyer.name}'s ${category} agent timed out.`)),
      );
    }, LEAF_TIMEOUT_MS);
    const sendToLeaf = (message: ParentToLeaf) => child.send(message);

    child.on("message", (raw) => {
      const message = raw as LeafToParent;
      handleLeafMessage(message).catch((error: unknown) => {
        child.kill();
        finish(() => reject(error));
      });
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        finish(() =>
          reject(
            new Error(`${buyer.name}'s ${category} agent exited with ${code}.`),
          ),
        );
      }
    });

    async function handleLeafMessage(message: LeafToParent): Promise<void> {
      switch (message.type) {
        case "BUDGET_REQUEST": {
          const available = shared.contingency[buyerIndex] ?? 0;
          const granted = Math.min(Math.max(message.neededCents, 0), available);
          shared.contingency[buyerIndex] = available - granted;
          if (granted > 0) {
            await (
              await new TransferTransaction()
                .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -granted)
                .addTokenTransfer(ctx.infra.paymentTokenId, wallet.accountId, granted)
                .execute(ctx.client)
            ).getReceipt(ctx.client);
          }
          sendToLeaf({ type: "BUDGET_GRANTED", grantedCents: granted });
          break;
        }
        case "PREPARE": {
          const listing = listings.find(
            (item) => item.sellerId === message.sellerId,
          );
          if (!listing) throw new Error(`Unknown seller ${message.sellerId}.`);
          // First PREPARE wins the item; a racing agent gets rejected and
          // retargets. This guard is why one table cannot be sold twice.
          if (shared.sold.has(listing.itemId)) {
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }
          shared.sold.add(listing.itemId);
          const serial = await mintClaimTo(ctx, listing.seller, category);
          const account = ctx.infra.sellers[listing.sellerId];
          if (!account) throw new Error(`No account for ${listing.sellerId}.`);
          sendToLeaf({
            type: "PREPARED",
            sellerAccountId: account.accountId,
            claimNftSerial: serial,
          });
          break;
        }
        case "SIGN_REQUEST": {
          const account = ctx.infra.sellers[message.sellerId];
          if (!account) throw new Error(`No account for ${message.sellerId}.`);
          const swap = Transaction.fromBytes(
            Buffer.from(message.txBytesB64, "base64"),
          );
          await swap.sign(parsePrivateKey(account.privateKey));
          sendToLeaf({
            type: "SIGNED",
            txBytesB64: Buffer.from(swap.toBytes()).toString("base64"),
          });
          break;
        }
        case "DONE":
          finish(() => resolve(message.result));
          break;
        case "ERROR":
          child.kill();
          finish(() =>
            reject(
              new Error(
                `${buyer.name}'s ${category} agent failed: ${message.message}`,
              ),
            ),
          );
          break;
        default:
          break;
      }
    }

    sendToLeaf({
      type: "MANDATE",
      mandate: {
        auctionId: `mandate_${hash(`${buyer.plan.planId}|${category}`).slice(0, 16)}`,
        category,
        maxAmountCents: capCents,
        requirements,
      },
      wallet,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      auctionTopicId: listings[0]?.topicId ?? "",
      clearingAccountId: ctx.operatorId.toString(),
      buyerLabel: buyer.name,
      contested: {
        mirrorBaseUrl: TESTNET_MIRROR_BASE,
        listings: listings.map(({ category: _c, seller: _s, ...listing }) => listing),
      },
    });
  });

  return {
    category,
    capCents,
    result,
    ...(result.transactionId
      ? { hashscanUrl: hashscanTxUrl(result.transactionId) }
      : {}),
    topicUrl: hashscanTopicUrl(result.auctionTopicId || listings[0]?.topicId || ""),
  };
}
