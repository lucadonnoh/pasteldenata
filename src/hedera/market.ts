import { fork, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  AccountBalanceQuery,
  TokenMintTransaction,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { MOCK_SELLERS } from "../catalog";
import type {
  Category,
  PaymentReceipt,
  PlanAllocation,
  PrivatePlan,
  Seller,
  SellerInventoryItem,
} from "../domain";
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
  HederaPartialSettlementError,
  sweepLeafBalance,
  tokenBalanceCents,
  type HederaSettlementContext,
  type SettlementFailure,
} from "./settle";
import { mintClaimTo } from "./swarm";
import { persistLeafWallet } from "./walletVault";

const LEAF_AGENT_PATH = leafAgentPath();
const LEAF_TIMEOUT_MS = 360_000;
const LEAF_FEE_HBAR = 5;

export interface MarketBuyer {
  name: string;
  plan: PrivatePlan;
}

export type MarketEvent =
  | {
      type: "LISTING_OPEN";
      itemId: string;
      topicId: string;
      category: string;
      sellerId: string;
      sellerName: string;
      offering: string;
      floorCents: number;
    }
  | {
      type: "AGENT_FUNDED";
      buyerName: string;
      category: string;
      accountId: string;
    }
  | { type: "ITEM_SOLD"; itemId: string; category: string }
  | { type: "BUYER_DONE"; buyerName: string; category: string; lost: boolean };

export interface MarketOptions {
  onEvent?: (event: MarketEvent) => void;
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
  contingency: number[];
  runtimes: MarketRuntime[];
  onEvent: (event: MarketEvent) => void;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

  const listings = (
    await Promise.all(
      MOCK_SELLERS.filter((seller) => categories.has(seller.category)).flatMap(
        (seller) =>
          seller.inventory.map(async (item): Promise<MarketListing> => {
            const account = ctx.infra.sellers[seller.id];
            if (!account) {
              throw new Error(`No Hedera account for seller ${seller.id}.`);
            }
            const log = await AuctionLog.create(ctx.client);
            const itemId = `item_${hash(
              `${runSalt}|${seller.id}|${item.id}`,
            ).slice(0, 16)}`;
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
            });
            return {
              itemId,
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
    contingency: buyers.map((buyer) => buyer.plan.unallocatedBudgetCents),
    runtimes: [],
    onEvent,
  };
  const tasks = buyers.flatMap((buyer, buyerIndex) =>
    buyer.plan.allocations.map((allocation) => ({
      buyer,
      buyerIndex,
      allocation,
    })),
  );
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

  await Promise.all(
    buyers.map(async (_buyer, index) => {
      const wallet = buyerWallets[index];
      const amount = spendable[index];
      if (!wallet || amount === undefined) return;
      const funded = shared.runtimes
        .filter((runtime) => runtime.buyerIndex === index)
        .reduce((sum, runtime) => sum + runtime.fundedCents, 0);
      const refund =
        amount - funded + (sweptRemainders[index] ?? 0);
      if (refund <= 0) return;
      try {
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
      }
    }),
  );

  const contentionResults = await Promise.allSettled(
    listings.map(async (listing): Promise<MarketContention> => {
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
    mandateId: `market_${run.runtime.allocation.category}`,
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
  const mandateId = `mandate_${hash(
    `${buyer.plan.planId}|${allocation.category}`,
  ).slice(0, 16)}`;
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
  });

  return new Promise<MarketLeafRun>((resolve, reject) => {
    const child: ChildProcess = fork(LEAF_AGENT_PATH, [], {
      execArgv: ["--import", "tsx"],
    });
    let reserved: MarketListing | undefined;
    let sellerSigned = false;
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
      // Before seller signature the reservation is safely reusable. After a
      // signed swap leaves the root, an agent crash creates an uncertain
      // submission window, so keeping the item locked is safer than allowing
      // a second settlement in the same run.
      if (!confirmed && reserved && !sellerSigned) {
        shared.sold.delete(reserved.itemId);
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
          try {
            if (granted > 0) {
              await (
                await new TransferTransaction()
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
                  .execute(ctx.client)
              ).getReceipt(ctx.client);
              runtime.fundedCents += granted;
            }
          } catch (error) {
            shared.contingency[buyerIndex] =
              (shared.contingency[buyerIndex] ?? 0) + granted;
            throw error;
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
          shared.sold.add(listing.itemId);
          reserved = listing;
          const serial = await mintClaimTo(
            ctx,
            listing.seller,
            listing.listingId,
          );
          sendToLeaf({
            type: "PREPARED",
            sellerAccountId: listing.sellerAccountId,
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
          sellerSigned = true;
          sendToLeaf({
            type: "SIGNED",
            txBytesB64: Buffer.from(swap.toBytes()).toString("base64"),
          });
          break;
        }

        case "SETTLEMENT_CONFIRMED":
          assertMarketResult(message.result, runtime, reserved);
          confirmed = message.result;
          if (!reserved) {
            throw new Error("Market settlement has no reserved listing.");
          }
          await reserved.log.publish({
            type: "SETTLED",
            itemId: reserved.itemId,
            listingId: reserved.listingId,
            sellerId: reserved.sellerId,
            bidder: message.result.leafAccountId,
            amountCents: message.result.amountCents,
            claimNftSerial: message.result.claimNftSerial,
            transactionId: message.result.transactionId,
          });
          shared.onEvent({
            type: "ITEM_SOLD",
            itemId: reserved.itemId,
            category: allocation.category,
          });
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
