import {
  AccountBalanceQuery,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { PaymentReceipt } from "../domain";
import { parsePrivateKey, type HederaContext } from "./client";
import type { HederaInfra, StoredAccount } from "./infra";

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
