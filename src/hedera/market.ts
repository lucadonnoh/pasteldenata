import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  AccountBalanceQuery,
  TokenMintTransaction,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { sellersForLocation } from "../catalog";
import type {
  HumanPolicy,
  Category,
  MarketProgressPhase,
  PaymentReceipt,
  PlanAllocation,
  PrivatePlan,
  Seller,
  SellerInventoryItem,
} from "../domain";
import {
  verifyAuctionPass,
  type AuctionPass,
} from "../server/world-gateway";
import { hashscanTopicUrl, hashscanTxUrl, parsePrivateKey } from "./client";
import { createAccount, type StoredAccount } from "./infra";
import type {
  ContestedListing,
  LeafResult,
  LeafToParent,
  ParentToLeaf,
} from "./ipc";
import { leafAgentPath } from "./leafPath";
import { AuctionLog } from "./log";
import { fetchItemState, TESTNET_MIRROR_BASE } from "./mirror";
import {
  assertExactAtomicSwap,
  assertVerifiedMarketClaim,
  marketCloseDelayMs,
  verifiedMarketClaimState,
  type MarketWinnerExpectation,
} from "./marketPolicy";
import {
  HederaPartialSettlementError,
  sweepLeafBalance,
  tokenBalanceCents,
  type HederaSettlementContext,
  type SettlementFailure,
} from "./settle";
import { mintClaimTo } from "./claim";
import { persistLeafWallet } from "./walletVault";

const LEAF_AGENT_PATH = leafAgentPath();
const LEAF_TIMEOUT_MS = 600_000;
const LEAF_FEE_HBAR = 5;
const SELLER_POLICY_POLL_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface MarketBuyer {
  name: string;
  plan: PrivatePlan;
}

export type MarketEvent =
  | {
      type: "MARKET_PHASE";
      phase: Exclude<
        MarketProgressPhase,
        "preparing-market" | "complete"
      >;
    }
  | { type: "WALLET_RECONCILED" }
  | { type: "BUYER_REFUNDED" }
  | { type: "HCS_TOPIC_VERIFIED" }
  | {
      type: "LISTING_OPEN";
      itemId: string;
      topicId: string;
      category: string;
      sellerId: string;
      sellerName: string;
      offering: string;
      floorCents: number;
      humanPolicy: HumanPolicy;
    }
  | {
      type: "AGENT_FUNDED";
      buyerName: string;
      category: string;
      accountId: string;
      initialCapCents: number;
    }
  | {
      type: "BUDGET_GRANTED";
      buyerName: string;
      category: string;
      accountId: string;
      grantedCents: number;
      effectiveCapCents: number;
      transactionId: string;
    }
  | { type: "ITEM_SOLD"; itemId: string; category: string }
  | {
      type: "PURCHASE_BLOCKED";
      itemId: string;
      category: string;
      buyerName: string;
      leafWallet: string;
      reason: string;
    }
  | { type: "BUYER_DONE"; buyerName: string; category: string; lost: boolean };

export interface PurchaseAuthorization {
  ok: boolean;
  pass?: AuctionPass;
  reason?: string;
}

export interface MarketOptions {
  onEvent?: (event: MarketEvent) => void;
  /**
   * Seller-side access control for protected listings (World AgentKit):
   * consulted before a buyer may settle a one-per-human item. Protected
   * markets fail before creating topics unless both this hook and the
   * issuer key are configured.
   */
  authorizePurchase?: (input: {
    itemId: string;
    listingId: string;
    sellerId: string;
    humanPolicy: HumanPolicy;
    buyerName: string;
    buyerIndex: number;
    leafWallet: string;
  }) => Promise<PurchaseAuthorization>;
  /** Ed25519 gateway key published in LISTED and used by every seller. */
  authorizationIssuerPublicKey?: string;
}

export interface MarketOutcome {
  category: Category;
  capCents: number;
  result: LeafResult;
  walletRecoveryPath: string;
  hashscanUrl?: string;
  topicUrl: string;
}

export interface MarketContention {
  sellerName: string;
  offering: string;
  category: Category;
  floorCents: number;
  bids: number;
  bidders: number;
  soldForCents?: number;
  topicUrl: string;
}

export interface MarketResult {
  buyers: Array<{
    name: string;
    plan: PrivatePlan;
    walletAccountId: string;
    outcomes: MarketOutcome[];
  }>;
  contention: MarketContention[];
}

interface MarketListing extends ContestedListing {
  category: Category;
  seller: Seller;
  item: SellerInventoryItem;
  log: AuctionLog;
}

interface MarketRuntime {
  buyerIndex: number;
  buyer: MarketBuyer;
  allocation: PlanAllocation;
  wallet: StoredAccount;
  recoveryPath: string;
  fundedCents: number;
}

interface MarketLeafRun {
  outcome: MarketOutcome;
  runtime: MarketRuntime;
  warnings: string[];
}

interface SharedMarketState {
  sold: Set<string>;
  reservations: Map<
    string,
    {
      buyerAccountId: string;
      amountCents: number;
      expiresAtMs: number;
      sellerSigned: boolean;
      authorizationPass?: AuctionPass;
    }
  >;
  itemActions: Map<string, Promise<void>>;
  pendingCloses: Set<string>;
  authorizePurchase: MarketOptions["authorizePurchase"];
  pendingForfeitures: Map<string, string>;
  contingency: number[];
  runtimes: MarketRuntime[];
  onEvent: (event: MarketEvent) => void;
}

async function withItemAction<T>(
  shared: SharedMarketState,
  itemId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = shared.itemActions.get(itemId) ?? Promise.resolve();
  let release = (): void => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  shared.itemActions.set(itemId, current);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (shared.itemActions.get(itemId) === current) {
      shared.itemActions.delete(itemId);
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function marketMandateId(
  planId: string,
  category: Category,
): string {
  return `mandate_${hash(`${planId}|${category}`).slice(0, 16)}`;
}

export function marketItemId(
  runSalt: string,
  sellerId: string,
  listingId: string,
): string {
  return `item_${hash(`${runSalt}|${sellerId}|${listingId}`).slice(0, 16)}`;
}

export function assertProtectedMarketAuthorizationConfigured(
  hasProtectedListings: boolean,
  options: MarketOptions,
): void {
  if (
    hasProtectedListings &&
    (!options.authorizePurchase || !options.authorizationIssuerPublicKey)
  ) {
    throw new Error(
      "Protected market listings require a World authorization hook and issuer public key.",
    );
  }
}

/**
 * Multi-buyer open market with one authenticated topic per scarce inventory
 * item. All leaves are awaited and ledger-reconciled before any error returns.
 */
export async function runMarket(
  buyers: MarketBuyer[],
  ctx: HederaSettlementContext,
  options: MarketOptions = {},
): Promise<MarketResult> {
  const onEvent = options.onEvent ?? (() => {});
  // Topics are public and retain their full history. A fresh nonce ensures a
  // retry of the same deterministic plan cannot inherit an earlier SETTLED
  // message under the same item ID.
  const runSalt = randomUUID();
  const categories = new Set<Category>();
  for (const buyer of buyers) {
    for (const allocation of buyer.plan.allocations) {
      categories.add(allocation.category);
    }
  }
  const roster = sellersForLocation(
    buyers[0]?.plan.location ?? "Lisbon",
  );
  const activeSellers = roster.filter((seller) =>
    categories.has(seller.category),
  );
  assertProtectedMarketAuthorizationConfigured(
    activeSellers.some(
      (seller) => (seller.humanPolicy ?? "open") !== "open",
    ),
    options,
  );

  const listings = (
    await Promise.all(
      activeSellers.flatMap(
        (seller) =>
          seller.inventory.map(async (item): Promise<MarketListing> => {
            const account = ctx.infra.sellers[seller.id];
            if (!account) {
              throw new Error(`No Hedera account for seller ${seller.id}.`);
            }
            const log = await AuctionLog.create(ctx.client);
            const itemId = marketItemId(runSalt, seller.id, item.id);
            await log.publish({
              type: "LISTED",
              itemId,
              listingId: item.id,
              sellerId: seller.id,
              sellerName: seller.name,
              offering: item.offering,
              category: seller.category,
              floorCents: item.floorPriceCents,
              quantity: 1,
              humanPolicy: seller.humanPolicy ?? "open",
              ...((seller.humanPolicy ?? "open") !== "open"
                ? {
                    authorizationIssuerPublicKey:
                      options.authorizationIssuerPublicKey,
                  }
                : {}),
            });
            onEvent({
              type: "LISTING_OPEN",
              itemId,
              topicId: log.topicId,
              category: seller.category,
              sellerId: seller.id,
              sellerName: seller.name,
              offering: item.offering,
              floorCents: item.floorPriceCents,
              humanPolicy: seller.humanPolicy ?? "open",
            });
            return {
              itemId,
              humanPolicy: seller.humanPolicy ?? "open",
              ...((seller.humanPolicy ?? "open") !== "open"
                ? {
                    authorizationIssuerPublicKey:
                      options.authorizationIssuerPublicKey,
                  }
                : {}),
              listingId: item.id,
              topicId: log.topicId,
              topicSubmitKey: log.submitKeyDer,
              sellerId: seller.id,
              sellerAccountId: account.accountId,
              sellerName: seller.name,
              offering: item.offering,
              floorCents: item.floorPriceCents,
              quality: item.quality,
              tags: [...item.tags],
              attributes: structuredClone(item.attributes),
              category: seller.category,
              seller,
              item,
              log,
            };
          }),
      ),
    )
  ).sort((left, right) => left.itemId.localeCompare(right.itemId));

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

  // Buyer funding wallets come from a persistent pool: they are the buyers'
  // banks, not the anonymous bidding agents, so reuse is safe and saves
  // account-creation fees. Sweep leftovers from earlier runs first so every
  // buyer starts holding exactly its budget.
  const pool = ctx.infra.marketBuyers ?? [];
  const buyerWallets: StoredAccount[] = await Promise.all(
    buyers.map(async (_, index) => pool[index] ?? (await createAccount(ctx))),
  );
  await Promise.all(
    buyerWallets.map(async (wallet) => {
      const balance = await new AccountBalanceQuery()
        .setAccountId(wallet.accountId)
        .execute(ctx.client);
      const leftover = balance.tokens?.get(ctx.infra.paymentTokenId);
      if (!leftover || leftover.isZero()) return;
      const sweep = new TransferTransaction()
        .addTokenTransfer(
          ctx.infra.paymentTokenId,
          wallet.accountId,
          leftover.negate(),
        )
        .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, leftover)
        .freezeWith(ctx.client);
      await sweep.sign(parsePrivateKey(wallet.privateKey));
      await (await sweep.execute(ctx.client)).getReceipt(ctx.client);
    }),
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
  distribute.addTokenTransfer(
    ctx.infra.paymentTokenId,
    ctx.operatorId,
    -totalBudget,
  );
  await (await distribute.execute(ctx.client)).getReceipt(ctx.client);

  const spendable = buyers.map((buyer) => {
    const caps = buyer.plan.allocations.reduce(
      (sum, allocation) => sum + allocation.maxBudgetCents,
      0,
    );
    return caps + buyer.plan.unallocatedBudgetCents;
  });
  await Promise.all(
    buyers.map(async (_buyer, index) => {
      const wallet = buyerWallets[index];
      const amount = spendable[index];
      if (!wallet || amount === undefined) {
        throw new Error("Funding misaligned.");
      }
      const toClearing = new TransferTransaction()
        .addTokenTransfer(
          ctx.infra.paymentTokenId,
          wallet.accountId,
          -amount,
        )
        .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, amount)
        .freezeWith(ctx.client);
      await toClearing.sign(parsePrivateKey(wallet.privateKey));
      await (await toClearing.execute(ctx.client)).getReceipt(ctx.client);
    }),
  );

  const shared: SharedMarketState = {
    sold: new Set(),
    reservations: new Map(),
    itemActions: new Map(),
    pendingCloses: new Set(),
    pendingForfeitures: new Map(),
    contingency: buyers.map((buyer) => buyer.plan.unallocatedBudgetCents),
    runtimes: [],
    onEvent,
    authorizePurchase: options.authorizePurchase,
  };
  const tasks = buyers.flatMap((buyer, buyerIndex) =>
    buyer.plan.allocations.map((allocation) => ({
      buyer,
      buyerIndex,
      allocation,
    })),
  );
  onEvent({ type: "MARKET_PHASE", phase: "running-auctions" });
  const settled = await Promise.allSettled(
    tasks.map(({ buyer, buyerIndex, allocation }) =>
      runMarketLeaf(
        buyer,
        buyerIndex,
        allocation,
        listings.filter(
          (listing) => listing.category === allocation.category,
        ),
        ctx,
        shared,
      ),
    ),
  );

  const failures: SettlementFailure[] = [];
  const runs: MarketLeafRun[] = [];
  settled.forEach((outcome, index) => {
    const task = tasks[index];
    if (!task) return;
    if (outcome.status === "fulfilled") {
      runs.push(outcome.value);
      failures.push(
        ...outcome.value.warnings.map((message) => ({
          category: task.allocation.category,
          message,
          leafAccountId: outcome.value.runtime.wallet.accountId,
        })),
      );
    } else {
      const leafAccountId = shared.runtimes.find(
        (runtime) =>
          runtime.buyerIndex === task.buyerIndex &&
          runtime.allocation.category === task.allocation.category,
      )?.wallet.accountId;
      failures.push({
        category: task.allocation.category,
        message:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        ...(leafAccountId ? { leafAccountId } : {}),
      });
    }
  });

  onEvent({ type: "MARKET_PHASE", phase: "reconciling-wallets" });
  const observedSpent = buyers.map(() => 0);
  const sweptRemainders = buyers.map(() => 0);
  for (const runtime of shared.runtimes) {
    try {
      const remaining = await tokenBalanceCents(ctx, runtime.wallet.accountId);
      const spent = runtime.fundedCents - remaining;
      observedSpent[runtime.buyerIndex] =
        (observedSpent[runtime.buyerIndex] ?? 0) + spent;
      sweptRemainders[runtime.buyerIndex] =
        (sweptRemainders[runtime.buyerIndex] ?? 0) +
        (await sweepLeafBalance(ctx, runtime.wallet));

      const run = runs.find((candidate) => candidate.runtime === runtime);
      if (!run || run.outcome.result.amountCents !== spent) {
        failures.push({
          category: runtime.allocation.category,
          message: run
            ? `Ledger spend ${spent} does not match confirmed receipt ${run.outcome.result.amountCents}.`
            : `Leaf ended without a receipt after spending ${spent}.`,
          leafAccountId: runtime.wallet.accountId,
          observedSpentCents: spent,
        });
      }
    } catch (error) {
      failures.push({
        category: runtime.allocation.category,
        message: `Could not reconcile or sweep the leaf wallet: ${
          error instanceof Error ? error.message : String(error)
        }`,
        leafAccountId: runtime.wallet.accountId,
      });
    }
    onEvent({ type: "WALLET_RECONCILED" });
  }
  buyers.forEach((buyer, index) => {
    const spent = observedSpent[index] ?? 0;
    if (
      !Number.isSafeInteger(spent) ||
      spent < 0 ||
      spent > buyer.plan.totalBudgetCents
    ) {
      failures.push({
        category: `buyer-${index + 1}`,
        message: `Reconciled spend ${spent} violates ${buyer.name}'s hard budget.`,
        observedSpentCents: spent,
      });
    }
  });

  onEvent({ type: "MARKET_PHASE", phase: "refunding-buyers" });
  await Promise.all(
    buyers.map(async (_buyer, index) => {
      let refund = 0;
      try {
        const wallet = buyerWallets[index];
        const amount = spendable[index];
        if (!wallet || amount === undefined) return;
        const funded = shared.runtimes
          .filter((runtime) => runtime.buyerIndex === index)
          .reduce((sum, runtime) => sum + runtime.fundedCents, 0);
        refund = amount - funded + (sweptRemainders[index] ?? 0);
        if (refund <= 0) return;
        await (
          await new TransferTransaction()
            .addTokenTransfer(
              ctx.infra.paymentTokenId,
              ctx.operatorId,
              -refund,
            )
            .addTokenTransfer(
              ctx.infra.paymentTokenId,
              wallet.accountId,
              refund,
            )
            .execute(ctx.client)
        ).getReceipt(ctx.client);
      } catch (error) {
        failures.push({
          category: `buyer-${index + 1}`,
          message: `Could not refund ${refund} cents after reconciliation: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      } finally {
        onEvent({ type: "BUYER_REFUNDED" });
      }
    }),
  );

  onEvent({ type: "MARKET_PHASE", phase: "verifying-hcs" });
  const contentionResults = await Promise.allSettled(
    listings.map(async (listing): Promise<MarketContention> => {
      try {
        const state = await fetchItemState(
          TESTNET_MIRROR_BASE,
          listing.topicId,
          listing.itemId,
          ctx.operatorId.toString(),
        );
        return {
          sellerName: listing.sellerName,
          offering: listing.offering,
          category: listing.category,
          floorCents: listing.floorCents,
          bids: state.bids.length,
          bidders: new Set(state.bids.map((bid) => bid.bidder)).size,
          ...(state.settlement
            ? { soldForCents: state.settlement.amountCents }
            : {}),
          topicUrl: hashscanTopicUrl(listing.topicId),
        };
      } finally {
        onEvent({ type: "HCS_TOPIC_VERIFIED" });
      }
    }),
  );
  const contention: MarketContention[] = [];
  contentionResults.forEach((outcome, index) => {
    if (outcome.status === "fulfilled") {
      contention.push(outcome.value);
      return;
    }
    const listing = listings[index];
    failures.push({
      category: listing?.category ?? "market",
      message: `Could not replay ${
        listing?.listingId ?? "an auction"
      } from Mirror Node: ${
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason)
      }`,
    });
  });

  if (failures.length > 0) {
    const receipts = runs
      .filter((run) => !run.outcome.result.lost)
      .map(marketReceipt);
    throw new HederaPartialSettlementError(
      `Hedera market partially failed after reconciliation: ${receipts.length} confirmed settlement(s), ${failures.length} failure(s).`,
      receipts,
      failures,
    );
  }

  return {
    buyers: buyers.map((buyer, index) => ({
      name: buyer.name,
      plan: buyer.plan,
      walletAccountId: buyerWallets[index]?.accountId ?? "",
      outcomes: runs
        .filter((run) => run.runtime.buyerIndex === index)
        .map((run) => run.outcome),
    })),
    contention,
  };
}

function marketReceipt(run: MarketLeafRun): PaymentReceipt {
  const { result } = run.outcome;
  return {
    id: result.transactionId,
    planId: run.runtime.buyer.plan.planId,
    mandateId: `mandate_${hash(
      `${run.runtime.buyer.plan.planId}|${run.runtime.allocation.category}`,
    ).slice(0, 16)}`,
    sellerId: result.sellerId,
    sellerName: result.sellerName,
    listingId: result.listingId,
    offering: result.offering,
    category: run.runtime.allocation.category,
    amountCents: result.amountCents,
    currency: "USD",
    status: "hedera-settled",
    transactionId: result.transactionId,
    ...(run.outcome.hashscanUrl
      ? { hashscanUrl: run.outcome.hashscanUrl }
      : {}),
    escrowAccountId: result.leafAccountId,
    claimNftSerial: result.claimNftSerial,
    leafWalletRecoveryPath: run.runtime.recoveryPath,
    auctionTopicUrl: run.outcome.topicUrl,
  };
}

async function runMarketLeaf(
  buyer: MarketBuyer,
  buyerIndex: number,
  allocation: PlanAllocation,
  listings: MarketListing[],
  ctx: HederaSettlementContext,
  shared: SharedMarketState,
): Promise<MarketLeafRun> {
  const mandateId = marketMandateId(
    buyer.plan.planId,
    allocation.category,
  );
  const wallet = await createAccount(ctx, LEAF_FEE_HBAR);
  const recoveryPath = persistLeafWallet(wallet, {
    planId: buyer.plan.planId,
    mandateId,
    category: allocation.category,
  });
  const runtime: MarketRuntime = {
    buyerIndex,
    buyer,
    allocation,
    wallet,
    recoveryPath,
    fundedCents: 0,
  };
  shared.runtimes.push(runtime);

  const initialFunding = allocation.maxBudgetCents;
  try {
    await (
      await new TransferTransaction()
        .addTokenTransfer(
          ctx.infra.paymentTokenId,
          ctx.operatorId,
          -initialFunding,
        )
        .addTokenTransfer(
          ctx.infra.paymentTokenId,
          wallet.accountId,
          initialFunding,
        )
        .execute(ctx.client)
    ).getReceipt(ctx.client);
    runtime.fundedCents = initialFunding;
  } catch (error) {
    runtime.fundedCents = await tokenBalanceCents(ctx, wallet.accountId);
    throw error;
  }
  shared.onEvent({
    type: "AGENT_FUNDED",
    buyerName: buyer.name,
    category: allocation.category,
    accountId: wallet.accountId,
    initialCapCents: allocation.maxBudgetCents,
  });

  return new Promise<MarketLeafRun>((resolve, reject) => {
    const child: ChildProcess = fork(LEAF_AGENT_PATH, [], {
      execArgv: ["--import", "tsx"],
    });
    let reserved: MarketListing | undefined;
    let prepared:
      | {
          amountCents: number;
          claimNftSerial: number;
        }
      | undefined;
    let sellerSigned = false;
    let submittedTransactionId: string | undefined;
    let confirmed: LeafResult | undefined;
    let done: LeafResult | undefined;
    let pendingError: Error | undefined;
    const warnings: string[] = [];
    let finished = false;

    const timer = setTimeout(() => {
      pendingError = new Error(
        `${buyer.name}'s ${allocation.category} agent timed out.`,
      );
      child.kill();
    }, LEAF_TIMEOUT_MS);
    const sendToLeaf = (message: ParentToLeaf) => child.send(message);

    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const result = done ?? confirmed;
      if (!confirmed && reserved && !sellerSigned) {
        const reservation = shared.reservations.get(reserved.itemId);
        if (reservation?.buyerAccountId === wallet.accountId) {
          shared.reservations.delete(reserved.itemId);
        }
      }
      if (result) {
        if (!done && pendingError) warnings.push(pendingError.message);
        resolve({
          runtime,
          warnings,
          outcome: {
            category: allocation.category,
            capCents: allocation.maxBudgetCents,
            result,
            walletRecoveryPath: recoveryPath,
            ...(result.transactionId
              ? { hashscanUrl: hashscanTxUrl(result.transactionId) }
              : {}),
            topicUrl: result.auctionTopicId
              ? hashscanTopicUrl(result.auctionTopicId)
              : "",
          },
        });
      } else {
        reject(
          pendingError ??
            new Error(
              `${buyer.name}'s ${allocation.category} agent exited without a result.`,
            ),
        );
      }
    };

    const terminate = (error: unknown): void => {
      pendingError =
        error instanceof Error ? error : new Error(String(error));
      child.kill();
    };

    child.on("message", (raw) => {
      handleLeafMessage(raw as LeafToParent).catch(terminate);
    });
    child.on("error", terminate);
    child.on("exit", (code) => {
      if (code !== 0 && !pendingError) {
        pendingError = new Error(
          `${buyer.name}'s ${allocation.category} agent exited with ${code}.`,
        );
      }
      finish();
    });

    async function closeAndVerifyAuction(
      listing: MarketListing,
      expected: MarketWinnerExpectation,
    ): Promise<boolean> {
      for (;;) {
        const state = await fetchItemState(
          TESTNET_MIRROR_BASE,
          listing.topicId,
          listing.itemId,
          ctx.operatorId.toString(),
        );
        if (state.settlement || shared.sold.has(listing.itemId)) return false;
        if (state.closure) {
          shared.pendingCloses.delete(listing.itemId);
          const pendingForfeiture =
            shared.pendingForfeitures.get(listing.itemId);
          if (
            pendingForfeiture &&
            state.forfeitures.some(
              (forfeiture) => forfeiture.bidder === pendingForfeiture,
            )
          ) {
            shared.pendingForfeitures.delete(listing.itemId);
          }

          let claim: ReturnType<typeof verifiedMarketClaimState>;
          try {
            claim = verifiedMarketClaimState(state);
          } catch {
            return false;
          }
          const requester = claim.ranking.find(
            (bid) => bid.bidder === expected.buyerAccountId,
          );
          if (
            !requester ||
            requester.amountCents !== expected.amountCents ||
            claim.forfeitedBidders.has(requester.bidder)
          ) {
            return false;
          }
          const nowMs = Date.now();
          if (
            claim.currentWinner?.bidder === requester.bidder &&
            claim.currentWinner.amountCents === requester.amountCents &&
            nowMs < claim.deadlineMs
          ) {
            return true;
          }
          if (nowMs < claim.deadlineMs) {
            await sleep(
              Math.min(
                claim.deadlineMs - nowMs,
                SELLER_POLICY_POLL_MS,
              ),
            );
            continue;
          }

          await withItemAction(shared, listing.itemId, async () => {
            const fresh = await fetchItemState(
              TESTNET_MIRROR_BASE,
              listing.topicId,
              listing.itemId,
              ctx.operatorId.toString(),
            );
            if (fresh.settlement || !fresh.closure) return;
            const current = verifiedMarketClaimState(fresh);
            const winner = current.currentWinner;
            const actionNowMs = Date.now();
            if (!winner || actionNowMs < current.deadlineMs) return;

            const reservation = shared.reservations.get(listing.itemId);
            if (
              reservation?.buyerAccountId === winner.bidder &&
              reservation.expiresAtMs > actionNowMs
            ) {
              return;
            }
            if (reservation && reservation.expiresAtMs <= actionNowMs) {
              shared.reservations.delete(listing.itemId);
            }
            if (shared.pendingForfeitures.has(listing.itemId)) return;

            shared.pendingForfeitures.set(
              listing.itemId,
              winner.bidder,
            );
            try {
              await listing.log.publish({
                type: "FORFEITED",
                itemId: listing.itemId,
                bidder: winner.bidder,
                amountCents: winner.amountCents,
                reason: "claim-window-expired",
              });
            } catch (error) {
              shared.pendingForfeitures.delete(listing.itemId);
              throw error;
            }
          });
          await sleep(SELLER_POLICY_POLL_MS);
          continue;
        }

        let delayMs: number;
        try {
          delayMs = marketCloseDelayMs(state, expected, Date.now());
        } catch {
          return false;
        }
        if (delayMs > 0) {
          await sleep(Math.min(delayMs, SELLER_POLICY_POLL_MS));
          continue;
        }

        await withItemAction(shared, listing.itemId, async () => {
          const fresh = await fetchItemState(
            TESTNET_MIRROR_BASE,
            listing.topicId,
            listing.itemId,
            ctx.operatorId.toString(),
          );
          if (
            fresh.closure ||
            fresh.settlement ||
            shared.pendingCloses.has(listing.itemId)
          ) {
            return;
          }
          const freshDelay = marketCloseDelayMs(
            fresh,
            expected,
            Date.now(),
          );
          if (freshDelay > 0) return;

          shared.pendingCloses.add(listing.itemId);
          try {
            await listing.log.publish({
              type: "CLOSED",
              itemId: listing.itemId,
            });
          } catch (error) {
            shared.pendingCloses.delete(listing.itemId);
            throw error;
          }
        });
        await sleep(SELLER_POLICY_POLL_MS);
      }
    }

    async function handleLeafMessage(message: LeafToParent): Promise<void> {
      switch (message.type) {
        case "BUDGET_REQUEST": {
          const available = shared.contingency[buyerIndex] ?? 0;
          if (
            !Number.isSafeInteger(message.neededCents) ||
            message.neededCents <= 0
          ) {
            sendToLeaf({ type: "BUDGET_GRANTED", grantedCents: 0 });
            break;
          }
          const granted = Math.min(message.neededCents, available);
          shared.contingency[buyerIndex] = available - granted;
          let transactionId: string | undefined;
          try {
            if (granted > 0) {
              const response = await new TransferTransaction()
                .addTokenTransfer(
                  ctx.infra.paymentTokenId,
                  ctx.operatorId,
                  -granted,
                )
                .addTokenTransfer(
                  ctx.infra.paymentTokenId,
                  wallet.accountId,
                  granted,
                )
                .execute(ctx.client);
              await response.getReceipt(ctx.client);
              transactionId = response.transactionId.toString();
              runtime.fundedCents += granted;
            }
          } catch (error) {
            shared.contingency[buyerIndex] =
              (shared.contingency[buyerIndex] ?? 0) + granted;
            throw error;
          }
          if (granted > 0 && transactionId) {
            shared.onEvent({
              type: "BUDGET_GRANTED",
              buyerName: buyer.name,
              category: allocation.category,
              accountId: wallet.accountId,
              grantedCents: granted,
              effectiveCapCents: runtime.fundedCents,
              transactionId,
            });
          }
          sendToLeaf({ type: "BUDGET_GRANTED", grantedCents: granted });
          break;
        }

        case "PREPARE": {
          const listing = listings.find(
            (item) =>
              item.sellerId === message.sellerId &&
              item.listingId === message.listingId,
          );
          if (
            !listing ||
            !Number.isSafeInteger(message.amountCents) ||
            message.amountCents < listing.floorCents ||
            message.amountCents > runtime.fundedCents
          ) {
            throw new Error("Leaf requested an invalid market settlement.");
          }
          if (shared.sold.has(listing.itemId)) {
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }
          const policy = listing.humanPolicy ?? "open";
          let authorizationPass: AuctionPass | undefined;
          if (policy !== "open") {
            if (
              !shared.authorizePurchase ||
              !listing.authorizationIssuerPublicKey
            ) {
              shared.onEvent({
                type: "PURCHASE_BLOCKED",
                itemId: listing.itemId,
                category: allocation.category,
                buyerName: buyer.name,
                leafWallet: wallet.accountId,
                reason: "Protected listing has no World authorization verifier.",
              });
              sendToLeaf({ type: "PREPARE_REJECTED" });
              break;
            }
            const authorization = await shared.authorizePurchase({
              itemId: listing.itemId,
              listingId: listing.listingId,
              sellerId: listing.sellerId,
              humanPolicy: policy,
              buyerName: buyer.name,
              buyerIndex: runtime.buyerIndex,
              leafWallet: wallet.accountId,
            });
            if (
              !authorization.ok ||
              !authorization.pass ||
              !verifyAuctionPass(
                authorization.pass,
                listing.authorizationIssuerPublicKey,
                listing.itemId,
                wallet.accountId,
              )
            ) {
              shared.onEvent({
                type: "PURCHASE_BLOCKED",
                itemId: listing.itemId,
                category: allocation.category,
                buyerName: buyer.name,
                leafWallet: wallet.accountId,
                reason:
                  authorization.reason ??
                  "World authorization credential is missing or invalid.",
              });
              sendToLeaf({ type: "PREPARE_REJECTED" });
              break;
            }
            authorizationPass = authorization.pass;
          }
          const closed = await closeAndVerifyAuction(listing, {
            buyerAccountId: wallet.accountId,
            amountCents: message.amountCents,
          });
          if (!closed) {
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }
          if (shared.sold.has(listing.itemId)) {
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }
          if (authorizationPass) {
            if (
              !listing.authorizationIssuerPublicKey ||
              !verifyAuctionPass(
                authorizationPass,
                listing.authorizationIssuerPublicKey,
                listing.itemId,
                wallet.accountId,
              )
            ) {
              sendToLeaf({ type: "PREPARE_REJECTED" });
              break;
            }
            await listing.log.publish({
              type: "AUTHORIZED",
              itemId: listing.itemId,
              bidder: wallet.accountId,
              nullifier: authorizationPass.nullifier,
              quota: authorizationPass.quota,
              expiresAt: authorizationPass.expiresAt,
              issuerPublicKey: authorizationPass.issuerPublicKey,
              signature: authorizationPass.signature,
            });
          }

          const expiresAtMs = await withItemAction(
            shared,
            listing.itemId,
            async (): Promise<number | undefined> => {
              if (shared.sold.has(listing.itemId)) return undefined;
              const state = await fetchItemState(
                TESTNET_MIRROR_BASE,
                listing.topicId,
                listing.itemId,
                ctx.operatorId.toString(),
              );
              const nowMs = Date.now();
              assertVerifiedMarketClaim(
                state,
                {
                  buyerAccountId: wallet.accountId,
                  amountCents: message.amountCents,
                },
                nowMs,
              );
              const claim = verifiedMarketClaimState(state);
              const existing = shared.reservations.get(listing.itemId);
              if (existing && existing.expiresAtMs > nowMs) {
                return undefined;
              }
              if (existing) shared.reservations.delete(listing.itemId);
              shared.reservations.set(listing.itemId, {
                buyerAccountId: wallet.accountId,
                amountCents: message.amountCents,
                expiresAtMs: claim.deadlineMs,
                sellerSigned: false,
                ...(authorizationPass ? { authorizationPass } : {}),
              });
              return claim.deadlineMs;
            },
          );
          if (!expiresAtMs) {
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }

          reserved = listing;
          const serial = await mintClaimTo(
            ctx,
            listing.seller,
            listing.listingId,
          );
          if (Date.now() >= expiresAtMs) {
            const reservation = shared.reservations.get(listing.itemId);
            if (reservation?.buyerAccountId === wallet.accountId) {
              shared.reservations.delete(listing.itemId);
            }
            reserved = undefined;
            sendToLeaf({ type: "PREPARE_REJECTED" });
            break;
          }
          prepared = {
            amountCents: message.amountCents,
            claimNftSerial: serial,
          };
          sendToLeaf({
            type: "PREPARED",
            sellerAccountId: listing.sellerAccountId,
            claimNftSerial: serial,
          });
          break;
        }

        case "SIGN_REQUEST": {
          if (
            !reserved ||
            !prepared ||
            sellerSigned ||
            message.sellerId !== reserved.sellerId
          ) {
            throw new Error("Seller received an unauthorized signing request.");
          }
          const reservation = shared.reservations.get(reserved.itemId);
          if (
            !reservation ||
            reservation.buyerAccountId !== wallet.accountId ||
            reservation.amountCents !== prepared.amountCents ||
            reservation.sellerSigned ||
            Date.now() >= reservation.expiresAtMs
          ) {
            throw new Error("The winner's settlement reservation expired.");
          }
          if ((reserved.humanPolicy ?? "open") !== "open") {
            if (
              !reservation.authorizationPass ||
              !reserved.authorizationIssuerPublicKey ||
              !verifyAuctionPass(
                reservation.authorizationPass,
                reserved.authorizationIssuerPublicKey,
                reserved.itemId,
                wallet.accountId,
              )
            ) {
              throw new Error(
                "Seller rejected an invalid or expired World authorization credential.",
              );
            }
          }
          const state = await fetchItemState(
            TESTNET_MIRROR_BASE,
            reserved.topicId,
            reserved.itemId,
            ctx.operatorId.toString(),
          );
          assertVerifiedMarketClaim(
            state,
            {
              buyerAccountId: wallet.accountId,
              amountCents: prepared.amountCents,
            },
            Date.now(),
          );
          const swap = Transaction.fromBytes(
            Buffer.from(message.txBytesB64, "base64"),
          );
          assertExactAtomicSwap(swap, {
            buyerAccountId: wallet.accountId,
            sellerAccountId: reserved.sellerAccountId,
            amountCents: prepared.amountCents,
            paymentTokenId: ctx.infra.paymentTokenId,
            claimTokenId: ctx.infra.claimTokenId,
            claimNftSerial: prepared.claimNftSerial,
          });
          const account = ctx.infra.sellers[reserved.sellerId];
          if (!account) {
            throw new Error(`No account for ${reserved.sellerId}.`);
          }
          await swap.sign(parsePrivateKey(account.privateKey));
          sellerSigned = true;
          reservation.sellerSigned = true;
          const response = await swap.execute(ctx.client);
          await response.getReceipt(ctx.client);
          submittedTransactionId = response.transactionId.toString();
          shared.sold.add(reserved.itemId);
          shared.reservations.delete(reserved.itemId);
          await reserved.log.publish({
            type: "SETTLED",
            itemId: reserved.itemId,
            listingId: reserved.listingId,
            sellerId: reserved.sellerId,
            bidder: wallet.accountId,
            amountCents: prepared.amountCents,
            claimNftSerial: prepared.claimNftSerial,
            transactionId: submittedTransactionId,
          });
          shared.onEvent({
            type: "ITEM_SOLD",
            itemId: reserved.itemId,
            category: allocation.category,
          });
          sendToLeaf({
            type: "SETTLED",
            txBytesB64: Buffer.from(swap.toBytes()).toString("base64"),
            transactionId: submittedTransactionId,
          });
          break;
        }

        case "SETTLEMENT_CONFIRMED":
          assertMarketResult(message.result, runtime, reserved);
          if (
            !submittedTransactionId ||
            message.result.transactionId !== submittedTransactionId
          ) {
            throw new Error(
              "Leaf reported a transaction other than the submitted atomic swap.",
            );
          }
          confirmed = message.result;
          sendToLeaf({ type: "SETTLEMENT_RECORDED" });
          break;

        case "DONE":
          if (!message.result.lost) {
            assertMarketResult(message.result, runtime, reserved);
          } else if (
            message.result.amountCents !== 0 ||
            message.result.leafAccountId !== wallet.accountId
          ) {
            throw new Error("Leaf returned an invalid loss result.");
          }
          done = message.result;
          shared.onEvent({
            type: "BUYER_DONE",
            buyerName: buyer.name,
            category: allocation.category,
            lost: message.result.lost === true,
          });
          break;

        case "ERROR":
          terminate(
            new Error(
              `${buyer.name}'s ${allocation.category} agent failed: ${message.message}`,
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
        auctionId: mandateId,
        mandateId,
        planId: buyer.plan.planId,
        category: allocation.category,
        maxAmountCents: allocation.maxBudgetCents,
        requirements: [...allocation.requirements],
      },
      wallet,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      auctionTopicId: listings[0]?.topicId ?? "",
      topicSubmitKey: listings[0]?.topicSubmitKey ?? "",
      clearingAccountId: ctx.operatorId.toString(),
      buyerLabel: buyer.name,
      contested: {
        mirrorBaseUrl: TESTNET_MIRROR_BASE,
        listings: listings.map(
          ({
            itemId,
            listingId,
            topicId,
            topicSubmitKey,
            sellerId,
            sellerAccountId,
            sellerName,
            offering,
            floorCents,
            quality,
            tags,
            attributes,
          }) => ({
            itemId,
            listingId,
            topicId,
            topicSubmitKey,
            sellerId,
            sellerAccountId,
            sellerName,
            offering,
            floorCents,
            quality,
            tags,
            attributes,
          }),
        ),
      },
    });
  });
}

function assertMarketResult(
  result: LeafResult,
  runtime: MarketRuntime,
  reserved: MarketListing | undefined,
): void {
  if (
    !reserved ||
    result.leafAccountId !== runtime.wallet.accountId ||
    result.listingId !== reserved.listingId ||
    result.sellerId !== reserved.sellerId ||
    result.marketItemId !== reserved.itemId ||
    !Number.isSafeInteger(result.amountCents) ||
    result.amountCents < reserved.floorCents ||
    result.amountCents > runtime.fundedCents ||
    !result.transactionId
  ) {
    throw new Error("Leaf returned an invalid market settlement receipt.");
  }
}
