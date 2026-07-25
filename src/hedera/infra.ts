import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  AccountCreateTransaction,
  Hbar,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
} from "@hashgraph/sdk";
import type { Seller } from "../domain";
import { runtimeDataDirectory } from "../server/runtime-data";
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
   * reusing them saves account-creation fees.
   */
  marketBuyers?: StoredAccount[];
  /**
   * Pre-warmed testnet bidding accounts. Serial job execution makes reuse
   * safe; each run still gives every account a fresh mandate and HCS topics.
   */
  marketAgents?: StoredAccount[];
}

const MARKET_BUYER_POOL = 4;
export const MARKET_AGENT_POOL = 8;
/** Contains generated testnet private keys; kept out of git. */
function infraPath(): string {
  return resolve(runtimeDataDirectory(), "hedera-infra.json");
}

function persistInfra(infra: HederaInfra): void {
  const INFRA_PATH = infraPath();
  mkdirSync(runtimeDataDirectory(), { recursive: true, mode: 0o700 });
  const temporaryPath = `${INFRA_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(infra, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, INFRA_PATH);
  chmodSync(INFRA_PATH, 0o600);
}

export interface InfraProvisioningHooks {
  createStoredAccount: (ctx: HederaContext) => Promise<StoredAccount>;
  persist: (infra: HederaInfra) => void;
}

/**
 * Lazily add only the requested sellers. Every successful account creation is
 * checkpointed before the next network mutation, so a faucet or node failure
 * can be resumed without losing funded testnet accounts.
 */
export async function upgradeInfra(
  ctx: HederaContext,
  infra: HederaInfra,
  sellers: Seller[],
  hooks: InfraProvisioningHooks = {
    createStoredAccount: createAccount,
    persist: persistInfra,
  },
): Promise<void> {
  for (const seller of sellers) {
    if (!infra.sellers[seller.id]) {
      infra.sellers[seller.id] =
        await hooks.createStoredAccount(ctx);
      hooks.persist(infra);
    }
  }
  const pool = (infra.marketBuyers ??= []);
  while (pool.length < MARKET_BUYER_POOL) {
    pool.push(await hooks.createStoredAccount(ctx));
    hooks.persist(infra);
  }
  const agents = (infra.marketAgents ??= []);
  while (agents.length < MARKET_AGENT_POOL) {
    agents.push(await hooks.createStoredAccount(ctx));
    hooks.persist(infra);
  }
}

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
  const INFRA_PATH = infraPath();
  if (existsSync(INFRA_PATH)) {
    chmodSync(INFRA_PATH, 0o600);
    const infra = JSON.parse(readFileSync(INFRA_PATH, "utf8")) as HederaInfra;
    await upgradeInfra(ctx, infra, sellers);
    return infra;
  }

  const [paymentTokenId, claimTokenId, buyer] = await Promise.all([
    createPaymentToken(ctx),
    createClaimToken(ctx),
    createAccount(ctx),
  ]);
  const infra: HederaInfra = {
    network: "testnet",
    paymentTokenId,
    claimTokenId,
    buyer,
    sellers: {},
  };
  // Checkpoint core token/account identifiers before provisioning any seller.
  persistInfra(infra);
  await upgradeInfra(ctx, infra, sellers);
  return infra;
}
