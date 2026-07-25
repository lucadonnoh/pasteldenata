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
} from "../domain";
import type { SettlementResult } from "../orchestrator";
import { validateSettlement } from "../payments";
import { hashscanTxUrl, parsePrivateKey, type HederaContext } from "./client";
import { createAccount, type HederaInfra, type StoredAccount } from "./infra";
import { AuctionLog } from "./log";

export interface HederaSettlementContext extends HederaContext {
  infra: HederaInfra;
}

export interface SettlementFailure {
  category: string;
  message: string;
  leafAccountId?: string;
  observedSpentCents?: number;
}

/**
 * A failed bundle may still contain irreversible successful transfers.
 * Callers receive every confirmed receipt plus the reconciled failure list
 * instead of losing that information behind a generic Promise.all rejection.
 */
export class HederaPartialSettlementError extends Error {
  constructor(
    message: string,
    readonly receipts: PaymentReceipt[],
    readonly failures: SettlementFailure[],
  ) {
    super(message);
    this.name = "HederaPartialSettlementError";
  }
}

export async function tokenBalanceCents(
  ctx: HederaSettlementContext,
  accountId: string,
): Promise<number> {
  const balance = await new AccountBalanceQuery()
    .setAccountId(accountId)
    .execute(ctx.client);
  const amount = balance.tokens?.get(ctx.infra.paymentTokenId);
  return amount?.toNumber() ?? 0;
}

/**
 * Stop relying on a child process to return its remainder. The root retains
 * the leaf key, waits for every child to terminate, and then sweeps the exact
 * ledger balance back to clearing before refunding the buyer.
 */
export async function sweepLeafBalance(
  ctx: HederaSettlementContext,
  wallet: StoredAccount,
): Promise<number> {
  const balance = await tokenBalanceCents(ctx, wallet.accountId);
  if (balance <= 0) return 0;
  const sweep = new TransferTransaction()
    .addTokenTransfer(
      ctx.infra.paymentTokenId,
      wallet.accountId,
      -balance,
    )
    .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, balance)
    .freezeWith(ctx.client);
  await sweep.sign(parsePrivateKey(wallet.privateKey));
  await (await sweep.execute(ctx.client)).getReceipt(ctx.client);
  return balance;
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
      listingId: auction.winner.listingId,
      sellerId: auction.winner.sellerId,
    })),
  });

  await resetBuyerBalance(ctx, buyerKey);
  await fundBuyer(ctx, plan.totalBudgetCents);

  const settled = await Promise.allSettled(
    auctions.map((auction) => settleAuction(plan, auction, ctx, buyerKey, log)),
  );
  const receipts: PaymentReceipt[] = [];
  const failures: SettlementFailure[] = [];
  settled.forEach((outcome, index) => {
    const auction = auctions[index];
    if (!auction) return;
    if (outcome.status === "fulfilled") {
      receipts.push(outcome.value.receipt);
      failures.push(
        ...outcome.value.warnings.map((message) => ({
          category: auction.category,
          message,
        })),
      );
    } else {
      failures.push({
        category: auction.category,
        message:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
      });
    }
  });
  if (failures.length > 0) {
    throw new HederaPartialSettlementError(
      `Hedera settlement partially failed: ${receipts.length} confirmed settlement(s), ${failures.length} failure(s).`,
      receipts,
      failures,
    );
  }

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
): Promise<{ receipt: PaymentReceipt; warnings: string[] }> {
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

  let confirmed: PaymentReceipt | undefined;
  try {
    const mintReceipt = await (
      await new TokenMintTransaction()
        .setTokenId(ctx.infra.claimTokenId)
        .setMetadata([
          Buffer.from(
            `${auction.winner.listingId}|${auction.winner.sellerId}`,
          ),
        ])
        .execute(ctx.client)
    ).getReceipt(ctx.client);
    const serial = mintReceipt.serials[0];
    if (serial === undefined) {
      throw new Error("Hedera did not return the claim NFT serial.");
    }

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

    confirmed = {
      id: transactionId,
      planId: plan.planId,
      mandateId: auction.mandate.id,
      sellerId: auction.winner.sellerId,
      sellerName: auction.winner.sellerName,
      listingId: auction.winner.listingId,
      offering: auction.winner.offering,
      category: auction.category,
      amountCents,
      currency: plan.currency,
      status: "hedera-settled",
      transactionId,
      hashscanUrl: hashscanTxUrl(transactionId),
      escrowAccountId: escrow.account.accountId,
      claimNftSerial: serial.toNumber(),
    };

    try {
      await log.publish({
        type: "SETTLED",
        auctionId: auction.auctionId,
        category: auction.category,
        listingId: auction.winner.listingId,
        sellerId: auction.winner.sellerId,
        amountCents,
        escrowAccountId: escrow.account.accountId,
        claimNftSerial: serial.toNumber(),
        transactionId,
      });
      return { receipt: confirmed, warnings: [] };
    } catch (error) {
      return {
        receipt: confirmed,
        warnings: [
          `Settlement ${transactionId} succeeded but its HCS audit message failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  } catch (error) {
    if (!confirmed) {
      const remaining = await tokenBalanceCents(
        ctx,
        escrow.account.accountId,
      );
      if (remaining > 0) {
        const recovery = new TransferTransaction()
          .addTokenTransfer(
            ctx.infra.paymentTokenId,
            escrow.account.accountId,
            -remaining,
          )
          .addTokenTransfer(
            ctx.infra.paymentTokenId,
            ctx.infra.buyer.accountId,
            remaining,
          )
          .freezeWith(ctx.client);
        await recovery.sign(escrow.key);
        await (await recovery.execute(ctx.client)).getReceipt(ctx.client);
      }
    }
    throw error;
  }
}
