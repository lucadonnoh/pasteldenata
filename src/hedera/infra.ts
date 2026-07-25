import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
} from "@hashgraph/sdk";
import type { Seller } from "../domain";
import type { HederaContext } from "./client";

export interface StoredAccount {
  accountId: string;
  privateKey: string;
}

export interface HederaInfra {
  network: "testnet";
  /** HTS fungible token, 2 decimals: 1 unit = 1 USD cent. */
  paymentTokenId: string;
  /** HTS NFT collection for purchased claims (tickets, reservations). */
  claimTokenId: string;
  buyer: StoredAccount;
  sellers: Record<string, StoredAccount>;
  /**
   * Persistent market-mode buyer wallets (index 0 = the user). These are
   * the buyers' funding accounts, not the anonymous bidding agents, so
   * reusing them saves account-creation fees without touching the privacy
   * story: leaf agent wallets stay fresh every run.
   */
  marketBuyers?: StoredAccount[];
}

const MARKET_BUYER_POOL = 4;

/** Lazily add newer infra pieces to an existing hedera-infra.json. */
async function upgradeInfra(
  ctx: HederaContext,
  infra: HederaInfra,
  sellers: Seller[],
): Promise<boolean> {
  let dirty = false;
  for (const seller of sellers) {
    if (!infra.sellers[seller.id]) {
      infra.sellers[seller.id] = await createAccount(ctx);
      dirty = true;
    }
  }
  const pool = (infra.marketBuyers ??= []);
  while (pool.length < MARKET_BUYER_POOL) {
    pool.push(await createAccount(ctx));
    dirty = true;
  }
  return dirty;
}

/** Contains generated testnet private keys; kept out of git. */
const INFRA_PATH = "hedera-infra.json";

export async function createAccount(
  ctx: HederaContext,
  initialHbar = 0,
): Promise<StoredAccount> {
  const key = PrivateKey.generateED25519();
  const response = await new AccountCreateTransaction()
    .setKeyWithoutAlias(key.publicKey)
    .setMaxAutomaticTokenAssociations(-1)
    .setInitialBalance(new Hbar(initialHbar))
    .execute(ctx.client);
  const receipt = await response.getReceipt(ctx.client);
  if (!receipt.accountId) {
    throw new Error("Hedera did not return an account id.");
  }
  return {
    accountId: receipt.accountId.toString(),
    privateKey: key.toStringDer(),
  };
}

async function createPaymentToken(ctx: HederaContext): Promise<string> {
  const response = await new TokenCreateTransaction()
    .setTokenName("Pastel de Nata USD")
    .setTokenSymbol("NATA")
    .setTokenType(TokenType.FungibleCommon)
    .setDecimals(2)
    .setInitialSupply(0)
    .setTreasuryAccountId(ctx.operatorId)
    .setSupplyKey(ctx.operatorKey.publicKey)
    .execute(ctx.client);
  const receipt = await response.getReceipt(ctx.client);
  if (!receipt.tokenId) {
    throw new Error("Hedera did not return the payment token id.");
  }
  return receipt.tokenId.toString();
}

async function createClaimToken(ctx: HederaContext): Promise<string> {
  const response = await new TokenCreateTransaction()
    .setTokenName("Pastel de Nata Claims")
    .setTokenSymbol("NATAC")
    .setTokenType(TokenType.NonFungibleUnique)
    .setTreasuryAccountId(ctx.operatorId)
    .setSupplyKey(ctx.operatorKey.publicKey)
    .execute(ctx.client);
  const receipt = await response.getReceipt(ctx.client);
  if (!receipt.tokenId) {
    throw new Error("Hedera did not return the claim token id.");
  }
  return receipt.tokenId.toString();
}

export async function ensureInfra(
  ctx: HederaContext,
  sellers: Seller[],
): Promise<HederaInfra> {
  if (existsSync(INFRA_PATH)) {
    chmodSync(INFRA_PATH, 0o600);
    const infra = JSON.parse(readFileSync(INFRA_PATH, "utf8")) as HederaInfra;
    if (await upgradeInfra(ctx, infra, sellers)) {
      writeFileSync(INFRA_PATH, `${JSON.stringify(infra, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      chmodSync(INFRA_PATH, 0o600);
    }
    return infra;
  }

  const [paymentTokenId, claimTokenId, buyer] = await Promise.all([
    createPaymentToken(ctx),
    createClaimToken(ctx),
    createAccount(ctx),
  ]);
  const sellerAccounts = await Promise.all(
    sellers.map(async (seller) => [seller.id, await createAccount(ctx)] as const),
  );

  const infra: HederaInfra = {
    network: "testnet",
    paymentTokenId,
    claimTokenId,
    buyer,
    sellers: Object.fromEntries(sellerAccounts),
  };
  await upgradeInfra(ctx, infra, sellers);
  writeFileSync(INFRA_PATH, `${JSON.stringify(infra, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(INFRA_PATH, 0o600);
  return infra;
}
