import {
  TokenMintTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import type { Seller } from "../domain";
import type { HederaSettlementContext } from "./settle";

/**
 * Create a claim NFT for a listing and place it in the seller account so the
 * later settlement transaction can exchange payment and claim atomically.
 */
export async function mintClaimTo(
  ctx: HederaSettlementContext,
  seller: Seller,
  listingId: string,
): Promise<number> {
  const mintReceipt = await (
    await new TokenMintTransaction()
      .setTokenId(ctx.infra.claimTokenId)
      .setMetadata([Buffer.from(`${listingId}|${seller.id}`)])
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
