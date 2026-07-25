"use client";

import { useEffect, useRef, useState } from "react";

import type { SettlementResult } from "@/src/domain";
import {
  fetchAllMirrorTopicMessages,
  marketBidsFromEvents,
  parseMarketLedgerEvents,
  type MarketBid,
  type MarketLedgerEvent,
} from "@/src/hedera/marketEvidence";
import { usePurchaseSession } from "@/components/purchase-session";

export type { MarketBid, MarketLedgerEvent };

export interface LiveAgentView {
  category: string;
  accountId: string;
  buyerName: string;
  initialCapCents?: number;
  grantedCents?: number;
  effectiveCapCents?: number;
  grantTransactions?: Array<{
    amountCents: number;
    transactionId: string;
  }>;
}

export interface MarketListingView {
  itemId: string;
  humanPolicy?: "open" | "one-per-human";
  topicId: string;
  category: string;
  sellerId: string;
  sellerName: string;
  offering: string;
  floorCents: number;
  sold: boolean;
}

export interface LiveAuctionView {
  /** Local coordinator account that authenticates lifecycle HCS messages. */
  clearingAccountId?: string;
  /** Real leaf wallets, as the coordinators create them. */
  agents: LiveAgentView[];
  /** Scarce listings and the ascending bids on each. */
  listings: MarketListingView[];
  bidsByItem: Record<string, MarketBid[]>;
  ledgerEventsByItem: Record<string, MarketLedgerEvent[]>;
  rivals: string[];
  settledCategories: string[];
  lostCategories: string[];
  active: boolean;
  done: boolean;
  failed: boolean;
  failure?: string;
}

const MIRROR_BASE = "https://testnet.mirrornode.hedera.com";
const JOB_POLL_MS = 2000;
const MIRROR_POLL_MS = 2500;
const JOB_TIMEOUT_MS = 8 * 60 * 1000;
const MAX_STATUS_FAILURES = 5;
const USER_BUYER_NAME = "You";

interface JobSnapshot {
  status: "running" | "done" | "failed";
  clearingAccountId?: string;
  agents?: LiveAuctionView["agents"];
  listings?: MarketListingView[];
  rivals?: string[];
  settledCategories?: string[];
  lostCategories?: string[];
  result?: SettlementResult;
  error?: string;
}

/**
 * Drives a running settlement job: polls the job for real agent wallets,
 * topics, and listings, streams the payer-authenticated auction lifecycle
 * from Mirror Node (the browser reads the public ledger directly), and merges
 * the receipts into the session when the coordinator finishes.
 */
export function useSettlementJob(): LiveAuctionView | undefined {
  const {
    result,
    setResult,
    settlement,
    settlementError,
    setSettlement,
    setSettlementError,
    jobId,
  } = usePurchaseSession();
  const resultRef = useRef(result);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  const [clearingAccountId, setClearingAccountId] = useState<
    string | undefined
  >();
  const [agents, setAgents] = useState<LiveAuctionView["agents"]>([]);
  const [listings, setListings] = useState<MarketListingView[]>([]);
  const [rivals, setRivals] = useState<string[]>([]);
  const [settledCategories, setSettledCategories] = useState<string[]>([]);
  const [lostCategories, setLostCategories] = useState<string[]>([]);
  const [bidsByItem, setBidsByItem] = useState<Record<string, MarketBid[]>>(
    {},
  );
  const [ledgerEventsByItem, setLedgerEventsByItem] = useState<
    Record<string, MarketLedgerEvent[]>
  >({});

  useEffect(() => {
    if (!jobId || settlement !== "pending") return;
    let cancelled = false;
    let finished = false;
    let statusFailures = 0;
    const startedAt = Date.now();

    const failJob = (message: string) => {
      if (cancelled || finished) return;
      finished = true;
      setSettlementError(message);
      setSettlement("failed");
    };

    const applyResult = (jobResult: SettlementResult) => {
      const purchase = resultRef.current;
      if (!purchase) return;
      const receipts = jobResult.receipts;
      const totalSpentCents = receipts.reduce(
        (sum, receipt) => sum + receipt.amountCents,
        0,
      );
      setResult({
        ...purchase,
        receipts,
        totalSpentCents,
        ...(jobResult.hedera ? { hedera: jobResult.hedera } : {}),
      });
    };

    const tick = async () => {
      if (cancelled || finished) return;
      if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
        failJob(
          "Hedera settlement exceeded eight minutes. The local coordinator may still be reconciling; inspect the terminal before retrying.",
        );
        return;
      }
      try {
        const response = await fetch(`/api/hedera/jobs/${jobId}`, {
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          if (response.status === 404) {
            failJob(
              body.error ??
                "The local settlement job was lost after a server restart.",
            );
            return;
          }
          throw new Error(
            body.error ?? `Job status returned HTTP ${response.status}.`,
          );
        }
        statusFailures = 0;
        const job = (await response.json()) as JobSnapshot;
        if (cancelled) return;
        if (job.clearingAccountId) {
          setClearingAccountId(job.clearingAccountId);
        }
        setAgents(job.agents ?? []);
        setListings(job.listings ?? []);
        setRivals(job.rivals ?? []);
        setSettledCategories(job.settledCategories ?? []);
        setLostCategories(job.lostCategories ?? []);

        if (job.status === "done" && job.result) {
          finished = true;
          applyResult(job.result);
          setSettlement("settled");
        } else if (job.status === "failed") {
          if (job.result) applyResult(job.result);
          failJob(job.error ?? "Settlement failed.");
        } else if (job.status === "done") {
          failJob("Settlement finished without a result.");
        }
      } catch (error) {
        statusFailures += 1;
        if (statusFailures >= MAX_STATUS_FAILURES) {
          failJob(
            error instanceof Error
              ? `Could not read the local settlement job: ${error.message}`
              : "Could not read the local settlement job.",
          );
        }
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), JOB_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, settlement, setResult, setSettlement, setSettlementError]);

  const yourAgentIds = agents
    .filter((agent) => agent.buyerName === USER_BUYER_NAME)
    .map((agent) => agent.accountId)
    .join(",");
  const topicsKey = listings
    .map((listing) => `${listing.itemId}:${listing.topicId}`)
    .join(",");

  useEffect(() => {
    if (!topicsKey || settlement !== "pending") return;
    let cancelled = false;
    let reading = false;
    const mine = new Set(yourAgentIds.split(",").filter(Boolean));

    const tick = async () => {
      if (reading) return;
      reading = true;
      try {
        if (!clearingAccountId) return;
        const nextBids: Record<string, MarketBid[]> = {};
        const nextEvents: Record<string, MarketLedgerEvent[]> = {};
        await Promise.all(
          listings.map(async ({ itemId, topicId }) => {
            try {
              const messages = await fetchAllMirrorTopicMessages(
                MIRROR_BASE,
                topicId,
              );
              const events = parseMarketLedgerEvents(
                messages,
                itemId,
                clearingAccountId,
                mine,
              );
              nextEvents[itemId] = events;
              nextBids[itemId] = marketBidsFromEvents(events);
            } catch {
              // Mirror hiccup; keep the previous view for this item.
            }
          }),
        );
        if (!cancelled && Object.keys(nextEvents).length > 0) {
          setLedgerEventsByItem((previous) => ({
            ...previous,
            ...nextEvents,
          }));
          setBidsByItem((previous) => ({ ...previous, ...nextBids }));
        }
      } finally {
        reading = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), MIRROR_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    topicsKey,
    yourAgentIds,
    clearingAccountId,
    settlement,
  ]);

  if (!jobId || settlement === "idle") {
    return undefined;
  }
  return {
    ...(clearingAccountId ? { clearingAccountId } : {}),
    agents,
    listings,
    bidsByItem,
    ledgerEventsByItem,
    rivals,
    settledCategories,
    lostCategories,
    active: settlement === "pending",
    done: settlement === "settled",
    failed: settlement === "failed",
    ...(settlementError ? { failure: settlementError } : {}),
  };
}
