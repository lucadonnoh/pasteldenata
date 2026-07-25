import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  Transaction,
  TokenMintTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { sellerSubmitSealedBid } from "../auction.js";
import { MOCK_SELLERS } from "../catalog.js";
import type {
  AuctionResult,
  PaymentReceipt,
  PrivatePlan,
  Seller,
} from "../domain.js";
import type { SettlementResult } from "../orchestrator.js";
import { validateSettlement } from "../payments.js";
import { hashscanTopicUrl, hashscanTxUrl, parsePrivateKey } from "./client.js";
import { createAccount } from "./infra.js";
import type { LeafResult, LeafToParent, ParentToLeaf } from "./ipc.js";
import { fundSellerFees, LiveAuctioneer } from "./liveAuction.js";
import { AuctionLog } from "./log.js";
import { TESTNET_MIRROR_BASE } from "./mirror.js";
import { fundBuyer, resetBuyerBalance, type HederaSettlementContext } from "./settle.js";

const LEAF_AGENT_PATH = fileURLToPath(new URL("./leafAgent.ts", import.meta.url));
const LEAF_TIMEOUT_MS = 240_000;
// Must cover the settlement's maximum fee ceiling, which includes the claim
// NFT auto-association charged to the leaf as payer.
const LEAF_FEE_HBAR = 5;

export interface SwarmOptions {
  /** Live reverse auction over HCS instead of the sealed one-shot RFQ. */
  live?: boolean;
}

interface SwarmShared {
  live: boolean;
  /** Unallocated budget the root may grant to priced-out leaves. */
  contingencyRemainingCents: number;
  /** Contingency granted per auction id, for post-settlement validation. */
  grantsCents: Map<string, number>;
}

/**
 * Swarm settlement: one forked leaf agent per mandate, each with a fresh
 * wallet holding exactly its category cap. Leaves are funded by the
 * marketplace clearing account (the operator), not by the buyer wallet
 * directly, so sellers cannot link the agents to the buyer or to each other
 * at the application layer. Each auction gets its own HCS topic; nothing
 * on-chain groups the purchases. The clearing account is a declared trust
 * point, like the 0G TEE.
 *
 * In live mode, sellers publicly undercut each other on each auction's topic
 * and the leaf closes when bidding goes quiet; the root can top up a
 * priced-out leaf from the plan's contingency with a real on-chain transfer.
 */
export async function settleWithSwarm(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  ctx: HederaSettlementContext,
  options: SwarmOptions = {},
): Promise<SettlementResult> {
  const live = options.live === true;
  if (!live) {
    // Live winners legitimately differ from the root's sealed baseline, so
    // this pre-check only applies to sealed mode; live mode is validated
    // after settlement against caps plus explicit grants.
    validateSettlement(plan, auctions);
  }

  const buyerKey = parsePrivateKey(ctx.infra.buyer.privateKey);
  await resetBuyerBalance(ctx, buyerKey);
  await fundBuyer(ctx, plan.totalBudgetCents);

  // The buyer makes one payment to the clearing account: the sum of the caps
  // (sealed mode) or the caps plus the contingency pool (live mode, so the
  // root can grant top-ups). From here on, only unlinkable leaf wallets
  // appear in auctions.
  const totalCaps = auctions.reduce(
    (sum, auction) => sum + auction.mandate.maxAmountCents,
    0,
  );
  const clearingFloat = live
    ? totalCaps + plan.unallocatedBudgetCents
    : totalCaps;
  const toClearing = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      ctx.infra.buyer.accountId,
      -clearingFloat,
    )
    .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, clearingFloat)
    .freezeWith(ctx.client);
  await toClearing.sign(buyerKey);
  await (await toClearing.execute(ctx.client)).getReceipt(ctx.client);

  const shared: SwarmShared = {
    live,
    contingencyRemainingCents: live ? plan.unallocatedBudgetCents : 0,
    grantsCents: new Map(),
  };

  if (live) {
    const eligibleAccounts = auctions
      .flatMap((auction) =>
        MOCK_SELLERS.filter((seller) => seller.category === auction.category),
      )
      .map((seller) => {
        const account = ctx.infra.sellers[seller.id];
        if (!account) throw new Error(`No Hedera account for seller ${seller.id}.`);
        return account;
      });
    await fundSellerFees(ctx, eligibleAccounts);
  }

  const results = await Promise.all(
    auctions.map((auction) => runLeaf(plan, auction, ctx, shared)),
  );

  // Post-settlement policy: every leaf stayed within its cap plus whatever
  // the root explicitly granted, and the total stayed under the hard budget.
  // The ledger already enforced this physically; this is the audit in code.
  const totalSpent = results.reduce((sum, item) => sum + item.amountCents, 0);
  results.forEach((result, index) => {
    const auction = auctions[index];
    if (!auction) throw new Error("Leaf results misaligned with auctions.");
    const allowed =
      auction.mandate.maxAmountCents +
      (shared.grantsCents.get(auction.auctionId) ?? 0);
    if (result.amountCents > allowed) {
      throw new Error(`The ${auction.category} agent exceeded its mandate.`);
    }
  });
  if (totalSpent > plan.totalBudgetCents) {
    throw new Error("Settlement exceeded the global budget.");
  }

  // Leftovers arrived at the clearing account from the leaves; refund the
  // buyer in one aggregate transfer.
  const leftovers = clearingFloat - totalSpent;
  if (leftovers > 0) {
    await (
      await new TransferTransaction()
        .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -leftovers)
        .addTokenTransfer(
          ctx.infra.paymentTokenId,
          ctx.infra.buyer.accountId,
          leftovers,
        )
        .execute(ctx.client)
    ).getReceipt(ctx.client);
  }

  const receipts: PaymentReceipt[] = results.map((result, index) => {
    const auction = auctions[index];
    if (!auction) throw new Error("Leaf results misaligned with auctions.");
    return {
      id: result.transactionId,
      planId: plan.planId,
      mandateId: auction.mandate.id,
      sellerId: result.sellerId,
      sellerName: result.sellerName,
      category: auction.category,
      amountCents: result.amountCents,
      currency: plan.currency,
      status: "hedera-settled",
      transactionId: result.transactionId,
      hashscanUrl: hashscanTxUrl(result.transactionId),
      escrowAccountId: result.leafAccountId,
      claimNftSerial: result.claimNftSerial,
      auctionTopicUrl: hashscanTopicUrl(result.auctionTopicId),
      ...(result.liveStats
        ? {
            liveBids: result.liveStats.bids,
            liveOpeningCents: result.liveStats.openingCents,
            liveGrantedCents: result.liveStats.grantedCents,
          }
        : {}),
    };
  });

  return {
    receipts,
    hedera: {
      network: ctx.network,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      buyerAccountId: ctx.infra.buyer.accountId,
      clearingAccountId: ctx.operatorId.toString(),
    },
  };
}

async function runLeaf(
  plan: PrivatePlan,
  auction: AuctionResult,
  ctx: HederaSettlementContext,
  shared: SwarmShared,
): Promise<LeafResult> {
  const requirements = mandateRequirements(plan, auction);
  // Listing side: the auction gets its own topic; the announcement carries
  // only the public RFQ data sellers already see.
  const log = await AuctionLog.create(ctx.client);
  await log.publish({
    type: "AUCTION_CREATED",
    auctionId: auction.auctionId,
    category: auction.category,
    location: plan.location,
    scheduledFor: plan.scheduledFor,
    requirements,
    mechanism: shared.live ? "live-reverse-english" : "sealed-rfq",
  });

  // Fresh leaf wallet, funded by the clearing account with exactly the cap
  // plus a little HBAR so the agent pays its own transaction fees.
  const wallet = await createAccount(ctx, LEAF_FEE_HBAR);
  await (
    await new TransferTransaction()
      .addTokenTransfer(
        ctx.infra.paymentTokenId,
        ctx.operatorId,
        -auction.mandate.maxAmountCents,
      )
      .addTokenTransfer(
        ctx.infra.paymentTokenId,
        wallet.accountId,
        auction.mandate.maxAmountCents,
      )
      .execute(ctx.client)
  ).getReceipt(ctx.client);

  const eligibleSellers = MOCK_SELLERS.filter(
    (seller) => seller.category === auction.category,
  );

  const auctioneer = shared.live
    ? new LiveAuctioneer(
        ctx,
        log.topicId,
        auction.auctionId,
        TESTNET_MIRROR_BASE,
        eligibleSellers.map((seller) => {
          const account = ctx.infra.sellers[seller.id];
          if (!account) throw new Error(`No Hedera account for seller ${seller.id}.`);
          return { seller, account };
        }),
      )
    : undefined;
  auctioneer?.start();

  return new Promise<LeafResult>((resolve, reject) => {
    const child: ChildProcess = fork(LEAF_AGENT_PATH, [], {
      execArgv: ["--import", "tsx"],
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      auctioneer?.stop();
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`The ${auction.category} agent timed out.`)));
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
          reject(new Error(`The ${auction.category} agent exited with ${code}.`)),
        );
      }
    });

    async function handleLeafMessage(message: LeafToParent): Promise<void> {
      switch (message.type) {
        case "RFQ": {
          // Sealed mode: marketplace collects sealed bids from the
          // category's sellers and relays commitments plus reveals. The leaf
          // re-verifies every commitment itself.
          const sealed = eligibleSellers.map((seller) =>
            sellerSubmitSealedBid(seller, {
              auctionId: auction.auctionId,
              category: auction.category,
              location: plan.location,
              scheduledFor: plan.scheduledFor,
              requirements,
            }),
          );
          sendToLeaf({
            type: "BIDS",
            commitments: sealed.map((item) => ({
              sellerId: item.sellerId,
              commitment: item.commitment,
            })),
            reveals: sealed.map((item) => item.reveal()),
          });
          break;
        }
        case "BUDGET_REQUEST": {
          // Live mode: a priced-out leaf asks for contingency. Decide
          // synchronously against the shared pool, then move real NATA
          // before confirming, so the grant exists on-chain when the leaf
          // raises its cap.
          const granted = Math.min(
            Math.max(message.neededCents, 0),
            shared.contingencyRemainingCents,
          );
          shared.contingencyRemainingCents -= granted;
          if (granted > 0) {
            shared.grantsCents.set(
              auction.auctionId,
              (shared.grantsCents.get(auction.auctionId) ?? 0) + granted,
            );
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
          if (shared.live) {
            // Live winners emerge from public bidding; the root only checks
            // the seller is a legitimate participant of this auction.
            if (!eligibleSellers.some((seller) => seller.id === message.sellerId)) {
              throw new Error(
                `The ${auction.category} agent chose ineligible seller ${message.sellerId}.`,
              );
            }
          } else if (message.sellerId !== auction.winner.sellerId) {
            // Sealed mode is deterministic: the root privately verifies the
            // leaf reached the outcome the auction predicts.
            throw new Error(
              `The ${auction.category} agent chose ${message.sellerId}, expected ${auction.winner.sellerId}.`,
            );
          }
          const seller = requireSeller(message.sellerId);
          const serial = await mintClaimTo(ctx, seller, auction);
          sendToLeaf({
            type: "PREPARED",
            sellerAccountId: sellerAccountId(message.sellerId),
            claimNftSerial: serial,
          });
          break;
        }
        case "SIGN_REQUEST": {
          // Seller agent counter-signs the leaf's atomic swap.
          const seller = requireSellerAccount(message.sellerId);
          const swap = Transaction.fromBytes(
            Buffer.from(message.txBytesB64, "base64"),
          );
          await swap.sign(parsePrivateKey(seller.privateKey));
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
              new Error(`The ${auction.category} agent failed: ${message.message}`),
            ),
          );
          break;
      }
    }

    function requireSeller(sellerId: string): Seller {
      const seller = MOCK_SELLERS.find((item) => item.id === sellerId);
      if (!seller) throw new Error(`Unknown seller ${sellerId}.`);
      return seller;
    }
    function requireSellerAccount(sellerId: string) {
      const account = ctx.infra.sellers[sellerId];
      if (!account) {
        throw new Error(
          `No Hedera account for seller ${sellerId}. Delete hedera-infra.json and rerun.`,
        );
      }
      return account;
    }
    function sellerAccountId(sellerId: string): string {
      return requireSellerAccount(sellerId).accountId;
    }

    sendToLeaf({
      type: "MANDATE",
      mandate: {
        auctionId: auction.auctionId,
        category: auction.category,
        maxAmountCents: auction.mandate.maxAmountCents,
        requirements,
      },
      wallet,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      auctionTopicId: log.topicId,
      clearingAccountId: ctx.operatorId.toString(),
      ...(shared.live ? { live: { mirrorBaseUrl: TESTNET_MIRROR_BASE } } : {}),
    });
  });
}

function mandateRequirements(
  plan: PrivatePlan,
  auction: AuctionResult,
): string[] {
  const allocation = plan.allocations.find(
    (item) => item.category === auction.category,
  );
  if (!allocation) {
    throw new Error(`No allocation for ${auction.category}.`);
  }
  return [...allocation.requirements];
}

async function mintClaimTo(
  ctx: HederaSettlementContext,
  seller: Seller,
  auction: AuctionResult,
): Promise<number> {
  const mintReceipt = await (
    await new TokenMintTransaction()
      .setTokenId(ctx.infra.claimTokenId)
      .setMetadata([Buffer.from(`${auction.category}|${seller.id}`)])
      .execute(ctx.client)
  ).getReceipt(ctx.client);
  const serial = mintReceipt.serials[0];
  if (serial === undefined) {
    throw new Error("Hedera did not return the claim NFT serial.");
  }

  const sellerAccount = ctx.infra.sellers[seller.id];
  if (!sellerAccount) {
    throw new Error(`No Hedera account for seller ${seller.id}.`);
  }
  await (
    await new TransferTransaction()
      .addNftTransfer(
        ctx.infra.claimTokenId,
        serial,
        ctx.operatorId,
        sellerAccount.accountId,
      )
      .execute(ctx.client)
  ).getReceipt(ctx.client);
  return serial.toNumber();
}
