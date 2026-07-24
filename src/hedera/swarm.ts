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
import { AuctionLog } from "./log.js";
import { fundBuyer, resetBuyerBalance, type HederaSettlementContext } from "./settle.js";

const LEAF_AGENT_PATH = fileURLToPath(new URL("./leafAgent.ts", import.meta.url));
const LEAF_TIMEOUT_MS = 240_000;
// Must cover the settlement's maximum fee ceiling, which includes the claim
// NFT auto-association charged to the leaf as payer.
const LEAF_FEE_HBAR = 5;

/**
 * Swarm settlement: one forked leaf agent per mandate, each with a fresh
 * wallet holding exactly its category cap. Leaves are funded by the
 * marketplace clearing account (the operator), not by the buyer wallet
 * directly, so sellers cannot link the agents to the buyer or to each other
 * at the application layer. Each auction gets its own HCS topic; nothing
 * on-chain groups the three purchases. The clearing account is a declared
 * trust point, like the 0G TEE.
 */
export async function settleWithSwarm(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  ctx: HederaSettlementContext,
): Promise<SettlementResult> {
  validateSettlement(plan, auctions);

  const buyerKey = parsePrivateKey(ctx.infra.buyer.privateKey);
  await resetBuyerBalance(ctx, buyerKey);
  await fundBuyer(ctx, plan.totalBudgetCents);

  // The buyer makes one payment to the clearing account for the sum of the
  // caps. From here on, only unlinkable leaf wallets appear in auctions.
  const totalCaps = auctions.reduce(
    (sum, auction) => sum + auction.mandate.maxAmountCents,
    0,
  );
  const toClearing = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      ctx.infra.buyer.accountId,
      -totalCaps,
    )
    .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, totalCaps)
    .freezeWith(ctx.client);
  await toClearing.sign(buyerKey);
  await (await toClearing.execute(ctx.client)).getReceipt(ctx.client);

  const results = await Promise.all(
    auctions.map((auction) => runLeaf(plan, auction, ctx)),
  );

  // Leftovers arrived at the clearing account from the leaves; refund the
  // buyer in one aggregate transfer.
  const totalSpent = results.reduce((sum, item) => sum + item.amountCents, 0);
  const leftovers = totalCaps - totalSpent;
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
): Promise<LeafResult> {
  // Listing side: the auction gets its own topic; the announcement carries
  // only the public RFQ data sellers already see.
  const requirements = mandateRequirements(plan, auction);
  const log = await AuctionLog.create(ctx.client);
  await log.publish({
    type: "AUCTION_CREATED",
    auctionId: auction.auctionId,
    category: auction.category,
    location: plan.location,
    scheduledFor: plan.scheduledFor,
    requirements,
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

  return new Promise<LeafResult>((resolve, reject) => {
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
          // Marketplace collects sealed bids from the category's sellers and
          // relays commitments plus reveals. The leaf re-verifies every
          // commitment itself.
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
        case "PREPARE": {
          // The root privately verifies the leaf reached the outcome the
          // deterministic auction predicts; the ledger enforces the cap.
          if (message.sellerId !== auction.winner.sellerId) {
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
