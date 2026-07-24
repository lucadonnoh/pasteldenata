import {
  AccountBalanceQuery,
  PrivateKey,
  TokenMintTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import type {
  AuctionResult,
  PaymentReceipt,
  PrivatePlan,
} from "../domain.js";
import type { SettlementResult } from "../orchestrator.js";
import { validateSettlement } from "../payments.js";
import { hashscanTxUrl, parsePrivateKey, type HederaContext } from "./client.js";
import { createAccount, type HederaInfra, type StoredAccount } from "./infra.js";
import { AuctionLog } from "./log.js";

export interface HederaSettlementContext extends HederaContext {
  infra: HederaInfra;
}

/**
 * Real budget enforcement: the buyer account is funded with exactly the plan's
 * hard cap in NATA, each mandate escrow receives exactly its category cap, and
 * settlement is one atomic transfer per auction (escrow pays the seller, the
 * unspent remainder returns to the buyer, and the claim NFT arrives in the
 * same transaction). Even a malicious planner output cannot overspend, because
 * the ledger rejects any transfer beyond those balances.
 */
export async function settleOnHedera(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  ctx: HederaSettlementContext,
): Promise<SettlementResult> {
  validateSettlement(plan, auctions);

  const buyerKey = parsePrivateKey(ctx.infra.buyer.privateKey);
  const log = await AuctionLog.create(ctx.client);
  await log.publish({
    type: "PLAN_OPENED",
    planId: plan.planId,
    auctions: auctions.map((auction) => ({
      auctionId: auction.auctionId,
      category: auction.category,
      commitments: auction.commitments,
    })),
  });

  await resetBuyerBalance(ctx, buyerKey);
  await fundBuyer(ctx, plan.totalBudgetCents);

  const receipts = await Promise.all(
    auctions.map((auction) => settleAuction(plan, auction, ctx, buyerKey, log)),
  );

  return {
    receipts,
    hedera: {
      network: ctx.network,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      buyerAccountId: ctx.infra.buyer.accountId,
      topicId: log.topicId,
      topicUrl: log.url,
    },
  };
}

/** Sweep leftovers from earlier runs so the buyer holds exactly the hard cap. */
export async function resetBuyerBalance(
  ctx: HederaSettlementContext,
  buyerKey: PrivateKey,
): Promise<void> {
  const balance = await new AccountBalanceQuery()
    .setAccountId(ctx.infra.buyer.accountId)
    .execute(ctx.client);
  const leftover = balance.tokens?.get(ctx.infra.paymentTokenId);
  if (!leftover || leftover.isZero()) return;

  const sweep = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      ctx.infra.buyer.accountId,
      leftover.negate(),
    )
    .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, leftover)
    .freezeWith(ctx.client);
  await sweep.sign(buyerKey);
  await (await sweep.execute(ctx.client)).getReceipt(ctx.client);
}

export async function fundBuyer(
  ctx: HederaSettlementContext,
  totalBudgetCents: number,
): Promise<void> {
  await (
    await new TokenMintTransaction()
      .setTokenId(ctx.infra.paymentTokenId)
      .setAmount(totalBudgetCents)
      .execute(ctx.client)
  ).getReceipt(ctx.client);

  await (
    await new TransferTransaction()
      .addTokenTransfer(
        ctx.infra.paymentTokenId,
        ctx.operatorId,
        -totalBudgetCents,
      )
      .addTokenTransfer(
        ctx.infra.paymentTokenId,
        ctx.infra.buyer.accountId,
        totalBudgetCents,
      )
      .execute(ctx.client)
  ).getReceipt(ctx.client);
}

async function createEscrowAccount(
  ctx: HederaSettlementContext,
): Promise<{ account: StoredAccount; key: PrivateKey }> {
  const account = await createAccount(ctx);
  return { account, key: parsePrivateKey(account.privateKey) };
}

async function settleAuction(
  plan: PrivatePlan,
  auction: AuctionResult,
  ctx: HederaSettlementContext,
  buyerKey: PrivateKey,
  log: AuctionLog,
): Promise<PaymentReceipt> {
  const sellerAccount = ctx.infra.sellers[auction.winner.sellerId];
  if (!sellerAccount) {
    throw new Error(
      `No Hedera account for seller ${auction.winner.sellerId}. Delete hedera-infra.json and rerun.`,
    );
  }

  const capCents = auction.mandate.maxAmountCents;
  const amountCents = auction.winner.amountCents;
  const refundCents = capCents - amountCents;

  // The scoped mandate becomes a real ledger boundary: this account holds
  // exactly the category cap, so this auction can never touch the rest of the
  // budget.
  const escrow = await createEscrowAccount(ctx);
  const funding = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      ctx.infra.buyer.accountId,
      -capCents,
    )
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      escrow.account.accountId,
      capCents,
    )
    .freezeWith(ctx.client);
  await funding.sign(buyerKey);
  await (await funding.execute(ctx.client)).getReceipt(ctx.client);

  const mintReceipt = await (
    await new TokenMintTransaction()
      .setTokenId(ctx.infra.claimTokenId)
      .setMetadata([Buffer.from(`${auction.category}|${auction.winner.sellerId}`)])
      .execute(ctx.client)
  ).getReceipt(ctx.client);
  const serial = mintReceipt.serials[0];
  if (serial === undefined) {
    throw new Error("Hedera did not return the claim NFT serial.");
  }

  // One atomic transaction: seller is paid, the unspent remainder returns to
  // the buyer, and the claim NFT is delivered. All legs succeed or none do.
  const settlement = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      escrow.account.accountId,
      -capCents,
    )
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      sellerAccount.accountId,
      amountCents,
    )
    .addNftTransfer(
      ctx.infra.claimTokenId,
      serial,
      ctx.operatorId,
      ctx.infra.buyer.accountId,
    );
  if (refundCents > 0) {
    settlement.addTokenTransfer(
      ctx.infra.paymentTokenId,
      ctx.infra.buyer.accountId,
      refundCents,
    );
  }
  settlement.freezeWith(ctx.client);
  await settlement.sign(escrow.key);
  const response = await settlement.execute(ctx.client);
  await response.getReceipt(ctx.client);
  const transactionId = response.transactionId.toString();

  await log.publish({
    type: "SETTLED",
    auctionId: auction.auctionId,
    category: auction.category,
    sellerId: auction.winner.sellerId,
    amountCents,
    escrowAccountId: escrow.account.accountId,
    claimNftSerial: serial.toNumber(),
    transactionId,
  });

  return {
    id: transactionId,
    planId: plan.planId,
    mandateId: auction.mandate.id,
    sellerId: auction.winner.sellerId,
    sellerName: auction.winner.sellerName,
    category: auction.category,
    amountCents,
    currency: plan.currency,
    status: "hedera-settled",
    transactionId,
    hashscanUrl: hashscanTxUrl(transactionId),
    escrowAccountId: escrow.account.accountId,
    claimNftSerial: serial.toNumber(),
  };
}
