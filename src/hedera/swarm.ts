import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TokenMintTransaction,
  Transaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { MOCK_SELLERS } from "../catalog";
import type {
  AuctionResult,
  AuctionWin,
  PaymentReceipt,
  PrivatePlan,
  Seller,
} from "../domain";
import type { SettlementResult } from "../orchestrator";
import { validateSettlement } from "../payments";
import { hashscanTopicUrl, hashscanTxUrl, parsePrivateKey } from "./client";
import { createAccount, type StoredAccount } from "./infra";
import type {
  AuthorizedLiveOffer,
  HederaOffer,
  LeafResult,
  LeafToParent,
  ParentToLeaf,
} from "./ipc";
import { fundSellerFees, LiveAuctioneer } from "./liveAuction";
import { AuctionLog } from "./log";
import { TESTNET_MIRROR_BASE } from "./mirror";
import {
  fundBuyer,
  HederaPartialSettlementError,
  resetBuyerBalance,
  sweepLeafBalance,
  tokenBalanceCents,
  type HederaSettlementContext,
  type SettlementFailure,
} from "./settle";
import { persistLeafWallet } from "./walletVault";

const LEAF_AGENT_PATH = fileURLToPath(new URL("./leafAgent.ts", import.meta.url));
const LEAF_TIMEOUT_MS = 240_000;
// Must cover the settlement's maximum fee ceiling, which includes the claim
// NFT auto-association charged to the leaf as payer.
const LEAF_FEE_HBAR = 5;

export interface SwarmOptions {
  /** Live reverse auction over HCS instead of the recorded mock English winner. */
  live?: boolean;
}

interface LeafRuntime {
  auction: AuctionResult;
  wallet: StoredAccount;
  recoveryPath: string;
  fundedCents: number;
}

interface LeafRun {
  result: LeafResult;
  runtime: LeafRuntime;
  warnings: string[];
}

interface SwarmShared {
  live: boolean;
  /** Unallocated budget the root may grant to priced-out leaves. */
  contingencyRemainingCents: number;
  /** Contingency granted per auction id, for post-settlement validation. */
  grantsCents: Map<string, number>;
  runtimes: Map<string, LeafRuntime>;
}

function offerFromWinner(winner: AuctionWin): HederaOffer {
  return {
    listingId: winner.listingId,
    sellerId: winner.sellerId,
    sellerName: winner.sellerName,
    offering: winner.offering,
    amountCents: winner.amountCents,
    quality: winner.quality,
    tags: [...winner.tags],
    attributes: structuredClone(winner.attributes),
  };
}

/**
 * One trusted, isolated buyer leaf per mandate. The root waits for all leaves
 * to terminate, reconciles their actual NATA balances, sweeps every remainder,
 * and throws a structured partial-settlement error containing any receipts
 * that became irreversible before a sibling failed.
 */
export async function settleWithSwarm(
  plan: PrivatePlan,
  auctions: AuctionResult[],
  ctx: HederaSettlementContext,
  options: SwarmOptions = {},
): Promise<SettlementResult> {
  validateSettlement(plan, auctions);
  const live = options.live === true;

  const buyerKey = parsePrivateKey(ctx.infra.buyer.privateKey);
  await resetBuyerBalance(ctx, buyerKey);
  await fundBuyer(ctx, plan.totalBudgetCents);

  const totalCaps = auctions.reduce(
    (sum, auction) => sum + auction.mandate.maxAmountCents,
    0,
  );
  const clearingFloat = live
    ? totalCaps + plan.unallocatedBudgetCents
    : totalCaps;

  // Fund mocked seller message fees before the buyer moves any NATA into
  // clearing, so a setup failure cannot strand the buyer's payment.
  if (live) {
    const accounts = MOCK_SELLERS.filter((seller) =>
      auctions.some((auction) => auction.category === seller.category),
    ).map((seller) => {
      const account = ctx.infra.sellers[seller.id];
      if (!account) throw new Error(`No Hedera account for seller ${seller.id}.`);
      return account;
    });
    await fundSellerFees(ctx, accounts);
  }

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
    runtimes: new Map(),
  };

  const settled = await Promise.allSettled(
    auctions.map((auction) => runLeaf(plan, auction, ctx, shared)),
  );

  const failures: SettlementFailure[] = [];
  const runs = new Map<string, LeafRun>();
  settled.forEach((outcome, index) => {
    const auction = auctions[index];
    if (!auction) return;
    if (outcome.status === "fulfilled") {
      runs.set(auction.auctionId, outcome.value);
      for (const warning of outcome.value.warnings) {
        failures.push({
          category: auction.category,
          message: warning,
          leafAccountId: outcome.value.runtime.wallet.accountId,
        });
      }
    } else {
      const leafAccountId = shared.runtimes.get(
        auction.auctionId,
      )?.wallet.accountId;
      failures.push({
        category: auction.category,
        message:
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        ...(leafAccountId ? { leafAccountId } : {}),
      });
    }
  });

  let observedTotalSpent = 0;
  let sweptRemainders = 0;
  for (const runtime of shared.runtimes.values()) {
    try {
      const remaining = await tokenBalanceCents(ctx, runtime.wallet.accountId);
      const observedSpent = runtime.fundedCents - remaining;
      observedTotalSpent += observedSpent;
      sweptRemainders += await sweepLeafBalance(ctx, runtime.wallet);

      const run = runs.get(runtime.auction.auctionId);
      if (!run || run.result.amountCents !== observedSpent) {
        failures.push({
          category: runtime.auction.category,
          message: run
            ? `Ledger spend ${observedSpent} does not match confirmed receipt ${run.result.amountCents}.`
            : `Leaf ended without a receipt after spending ${observedSpent}.`,
          leafAccountId: runtime.wallet.accountId,
          observedSpentCents: observedSpent,
        });
      }
    } catch (error) {
      failures.push({
        category: runtime.auction.category,
        message: `Could not reconcile or sweep the leaf wallet: ${
          error instanceof Error ? error.message : String(error)
        }`,
        leafAccountId: runtime.wallet.accountId,
      });
    }
  }

  if (
    !Number.isSafeInteger(observedTotalSpent) ||
    observedTotalSpent < 0 ||
    observedTotalSpent > plan.totalBudgetCents
  ) {
    failures.push({
      category: "bundle",
      message: `Reconciled spend ${observedTotalSpent} violates the hard budget.`,
      observedSpentCents: observedTotalSpent,
    });
  }

  const totalFunded = [...shared.runtimes.values()].reduce(
    (sum, runtime) => sum + runtime.fundedCents,
    0,
  );
  const refund = clearingFloat - totalFunded + sweptRemainders;
  if (refund > 0) {
    try {
      await (
        await new TransferTransaction()
          .addTokenTransfer(ctx.infra.paymentTokenId, ctx.operatorId, -refund)
          .addTokenTransfer(
            ctx.infra.paymentTokenId,
            ctx.infra.buyer.accountId,
            refund,
          )
          .execute(ctx.client)
      ).getReceipt(ctx.client);
    } catch (error) {
      failures.push({
        category: "bundle",
        message: `Could not refund ${refund} cents after reconciliation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  const receipts = auctions.flatMap((auction) => {
    const run = runs.get(auction.auctionId);
    return run ? [receiptFor(plan, auction, run)] : [];
  });

  if (failures.length > 0) {
    throw new HederaPartialSettlementError(
      `Hedera bundle partially failed after reconciliation: ${receipts.length} confirmed settlement(s), ${failures.length} failure(s).`,
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
      clearingAccountId: ctx.operatorId.toString(),
    },
  };
}

function receiptFor(
  plan: PrivatePlan,
  auction: AuctionResult,
  run: LeafRun,
): PaymentReceipt {
  const { result } = run;
  return {
    id: result.transactionId,
    planId: plan.planId,
    mandateId: auction.mandate.id,
    sellerId: result.sellerId,
    sellerName: result.sellerName,
    listingId: result.listingId,
    offering: result.offering,
    category: auction.category,
    amountCents: result.amountCents,
    currency: plan.currency,
    status: "hedera-settled",
    transactionId: result.transactionId,
    hashscanUrl: hashscanTxUrl(result.transactionId),
    escrowAccountId: result.leafAccountId,
    claimNftSerial: result.claimNftSerial,
    leafWalletRecoveryPath: run.runtime.recoveryPath,
    auctionTopicUrl: hashscanTopicUrl(result.auctionTopicId),
    ...(result.liveStats
      ? {
          liveBids: result.liveStats.bids,
          liveOpeningCents: result.liveStats.openingCents,
          liveGrantedCents: result.liveStats.grantedCents,
        }
      : {}),
  };
}

async function runLeaf(
  plan: PrivatePlan,
  auction: AuctionResult,
  ctx: HederaSettlementContext,
  shared: SwarmShared,
): Promise<LeafRun> {
  const requirements = mandateRequirements(plan, auction);
  const log = await AuctionLog.create(ctx.client);
  await log.publish({
    type: "AUCTION_CREATED",
    auctionId: auction.auctionId,
    category: auction.category,
    location: plan.location,
    scheduledFor: plan.scheduledFor,
    requirements,
    mechanism: shared.live ? "live-reverse-english" : "recorded-english-winner",
  });

  const wallet = await createAccount(ctx, LEAF_FEE_HBAR);
  const recoveryPath = persistLeafWallet(wallet, {
    planId: plan.planId,
    mandateId: auction.mandate.id,
    category: auction.category,
  });
  const runtime: LeafRuntime = {
    auction,
    wallet,
    recoveryPath,
    fundedCents: 0,
  };
  shared.runtimes.set(auction.auctionId, runtime);

  const initialFunding = auction.mandate.maxAmountCents;
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
    // If receipt retrieval failed after consensus, the ledger balance tells
    // reconciliation exactly how much reached the leaf.
    runtime.fundedCents = await tokenBalanceCents(ctx, wallet.accountId);
    throw error;
  }

  const liveListings = MOCK_SELLERS.filter(
    (seller) => seller.category === auction.category,
  ).flatMap((seller) => {
    const account = ctx.infra.sellers[seller.id];
    if (!account) throw new Error(`No Hedera account for seller ${seller.id}.`);
    return seller.inventory.map((item) => ({ seller, item, account }));
  });
  const authorizedOffers: AuthorizedLiveOffer[] = liveListings.map(
    ({ seller, item, account }) => ({
      offer: {
        listingId: item.id,
        sellerId: seller.id,
        sellerName: seller.name,
        offering: item.offering,
        quality: item.quality,
        tags: [...item.tags],
        attributes: structuredClone(item.attributes),
      },
      sellerAccountId: account.accountId,
    }),
  );

  const auctioneer = shared.live
    ? new LiveAuctioneer(
        ctx,
        log.topicId,
        log.submitKey,
        auction.auctionId,
        TESTNET_MIRROR_BASE,
        liveListings,
      )
    : undefined;
  auctioneer?.start();

  return new Promise<LeafRun>((resolve, reject) => {
    const child: ChildProcess = fork(LEAF_AGENT_PATH, [], {
      execArgv: ["--import", "tsx"],
    });
    let doneResult: LeafResult | undefined;
    let confirmedResult: LeafResult | undefined;
    let pendingError: Error | undefined;
    const warnings: string[] = [];
    let finished = false;

    const timer = setTimeout(() => {
      pendingError = new Error(`The ${auction.category} agent timed out.`);
      child.kill();
    }, LEAF_TIMEOUT_MS);
    const sendToLeaf = (message: ParentToLeaf) => child.send(message);

    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      auctioneer?.stop();
      if (doneResult) {
        resolve({ result: doneResult, runtime, warnings });
      } else if (confirmedResult) {
        if (pendingError) warnings.push(pendingError.message);
        resolve({ result: confirmedResult, runtime, warnings });
      } else {
        reject(
          pendingError ??
            new Error(`The ${auction.category} agent exited without a result.`),
        );
      }
    };

    const terminate = (error: unknown): void => {
      pendingError =
        error instanceof Error ? error : new Error(String(error));
      child.kill();
    };

    child.on("message", (raw) => {
      const message = raw as LeafToParent;
      handleLeafMessage(message).catch(terminate);
    });
    child.on("error", terminate);
    child.on("exit", (code) => {
      if (code !== 0 && !pendingError) {
        pendingError = new Error(
          `The ${auction.category} agent exited with ${code}.`,
        );
      }
      finish();
    });

    async function handleLeafMessage(message: LeafToParent): Promise<void> {
      switch (message.type) {
        case "RFQ":
          sendToLeaf({
            type: "OFFERS",
            offers: [offerFromWinner(auction.winner)],
          });
          break;

        case "BUDGET_REQUEST": {
          if (
            !Number.isSafeInteger(message.neededCents) ||
            message.neededCents <= 0
          ) {
            sendToLeaf({ type: "BUDGET_GRANTED", grantedCents: 0 });
            break;
          }
          const granted = Math.min(
            message.neededCents,
            shared.contingencyRemainingCents,
          );
          shared.contingencyRemainingCents -= granted;
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
              shared.grantsCents.set(
                auction.auctionId,
                (shared.grantsCents.get(auction.auctionId) ?? 0) + granted,
              );
            }
          } catch (error) {
            shared.contingencyRemainingCents += granted;
            throw error;
          }
          sendToLeaf({ type: "BUDGET_GRANTED", grantedCents: granted });
          break;
        }

        case "PREPARE": {
          if (
            !Number.isSafeInteger(message.amountCents) ||
            message.amountCents <= 0 ||
            message.amountCents > runtime.fundedCents
          ) {
            throw new Error("Leaf requested an invalid settlement amount.");
          }
          if (shared.live) {
            if (
              !liveListings.some(
                ({ seller, item }) =>
                  seller.id === message.sellerId &&
                  item.id === message.listingId,
              )
            ) {
              throw new Error(
                `The ${auction.category} agent chose an ineligible listing.`,
              );
            }
          } else if (
            message.sellerId !== auction.winner.sellerId ||
            message.listingId !== auction.winner.listingId ||
            message.amountCents !== auction.winner.amountCents
          ) {
            throw new Error(
              `The ${auction.category} agent changed the recorded auction outcome.`,
            );
          }
          const seller = requireSeller(message.sellerId);
          const serial = await mintClaimTo(
            ctx,
            seller,
            message.listingId,
          );
          sendToLeaf({
            type: "PREPARED",
            sellerAccountId: sellerAccount(message.sellerId).accountId,
            claimNftSerial: serial,
          });
          break;
        }

        case "SIGN_REQUEST": {
          // Leaf agents are explicitly trusted. The seller counter-signs the
          // atomic swap assembled by that trusted agent.
          const seller = sellerAccount(message.sellerId);
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

        case "SETTLEMENT_CONFIRMED":
          assertLeafResult(message.result, runtime);
          confirmedResult = message.result;
          await log.publish({
            type: "SETTLED",
            auctionId: auction.auctionId,
            listingId: message.result.listingId,
            sellerId: message.result.sellerId,
            bidder: message.result.leafAccountId,
            amountCents: message.result.amountCents,
            claimNftSerial: message.result.claimNftSerial,
            transactionId: message.result.transactionId,
          });
          sendToLeaf({ type: "SETTLEMENT_RECORDED" });
          break;

        case "DONE":
          assertLeafResult(message.result, runtime);
          doneResult = message.result;
          break;

        case "ERROR":
          terminate(
            new Error(
              `The ${auction.category} agent failed: ${message.message}`,
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

    function sellerAccount(sellerId: string): StoredAccount {
      const account = ctx.infra.sellers[sellerId];
      if (!account) {
        throw new Error(
          `No Hedera account for seller ${sellerId}. Delete hedera-infra.json and rerun.`,
        );
      }
      return account;
    }

    sendToLeaf({
      type: "MANDATE",
      mandate: {
        auctionId: auction.auctionId,
        mandateId: auction.mandate.id,
        planId: plan.planId,
        category: auction.category,
        maxAmountCents: auction.mandate.maxAmountCents,
        requirements,
      },
      wallet,
      paymentTokenId: ctx.infra.paymentTokenId,
      claimTokenId: ctx.infra.claimTokenId,
      auctionTopicId: log.topicId,
      topicSubmitKey: log.submitKeyDer,
      clearingAccountId: ctx.operatorId.toString(),
      ...(shared.live
        ? {
            live: {
              mirrorBaseUrl: TESTNET_MIRROR_BASE,
              authorizedOffers,
            },
          }
        : {}),
    });
  });
}

function assertLeafResult(result: LeafResult, runtime: LeafRuntime): void {
  if (
    result.leafAccountId !== runtime.wallet.accountId ||
    !Number.isSafeInteger(result.amountCents) ||
    result.amountCents <= 0 ||
    result.amountCents > runtime.fundedCents ||
    !result.transactionId
  ) {
    throw new Error("Leaf returned an invalid settlement receipt.");
  }
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
